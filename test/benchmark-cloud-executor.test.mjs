import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatModelClient } from '../src/llm-client.mjs';
import {
  BENCHMARK_EFFORT,
  BENCHMARK_MAX_OUTPUT_TOKENS,
  BENCHMARK_MODEL,
  BudgetLedger,
  startAnthropicBenchmarkProxy,
} from '../scripts/lib/benchmark-runtime.mjs';
import { OriginalAgentRunner } from '../scripts/lib/benchmark-systems.mjs';
import {
  BenchmarkCloudExecutorError,
  OFFICIAL_ANTHROPIC_MESSAGES_URL,
  benchmarkCloudExecutorInternals,
  executeCloudBenchmark,
  loadOriginalAgentSdkQuery,
  readBenchmarkCredential,
} from '../scripts/lib/benchmark-cloud-executor.mjs';

const QUESTION_MARKER = 'PRIVATE-FIXTURE-QUESTION-MARKER';
const ANSWER_MARKER = 'PRIVATE-FIXTURE-ANSWER-MARKER';

const CATEGORY_COUNTS = Object.freeze({
  exact_fact: 8,
  paraphrase: 12,
  context_followup: 8,
  cross_document: 8,
  deduplication: 4,
  temporal_conflict: 4,
  unanswerable: 4,
});

function approvedSyntheticDataset() {
  let sequence = 0;
  const items = [];
  for (const [category, count] of Object.entries(CATEGORY_COUNTS)) {
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      items.push({
        id: `Q${String(sequence).padStart(3, '0')}`,
        category,
        query: `${QUESTION_MARKER}: when does Project Aurora launch? Case ${sequence}.`,
        priorMessages: category === 'context_followup'
          ? [
              { role: 'user', content: 'We are discussing the synthetic Project Aurora.' },
              { role: 'assistant', content: 'I will rely on the public fixture.' },
            ]
          : [],
        complexity: ['cross_document', 'temporal_conflict'].includes(category)
          ? 'complex'
          : 'simple',
        review: { status: 'approved' },
      });
    }
  }
  return { reviewStatus: 'approved', executionAllowed: true, items };
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultmind-cloud-executor-'));
  const snapshotRoot = path.join(root, 'snapshot');
  const privateRunRoot = path.join(root, 'private');
  const credentialFile = path.join(root, 'fake-settings.json');
  const fakeCredential = 'fixture-upstream-secret-never-persist';
  await fsp.mkdir(path.join(snapshotRoot, 'notes'), { recursive: true });
  await fsp.writeFile(
    path.join(snapshotRoot, 'notes', 'aurora.md'),
    '# Project Aurora\n\nThe public fixture launch date is 2026-09-05.\n',
  );
  await fsp.writeFile(
    path.join(snapshotRoot, 'notes', 'owner.md'),
    '# Ownership\n\nThe public fixture owner is Mei.\n',
  );
  await fsp.writeFile(
    credentialFile,
    `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: fakeCredential } })}\n`,
    { mode: 0o600 },
  );
  await fsp.chmod(credentialFile, 0o600);
  for (const file of ['aurora.md', 'owner.md']) {
    await fsp.chmod(path.join(snapshotRoot, 'notes', file), 0o400);
  }
  await fsp.chmod(path.join(snapshotRoot, 'notes'), 0o500);
  await fsp.chmod(snapshotRoot, 0o500);
  return {
    root,
    snapshotRoot,
    privateRunRoot,
    credentialFile,
    fakeCredential,
    async cleanup() {
      await fsp.chmod(snapshotRoot, 0o700).catch(() => {});
      await fsp.chmod(path.join(snapshotRoot, 'notes'), 0o700).catch(() => {});
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

function productionGuardOptions() {
  const service = Object.freeze({
    activeState: 'active',
    subState: 'running',
    mainPid: 4242,
    execMainStartTimestamp: 'Mon 2026-08-31 09:00:00 CST',
    restarts: 0,
  });
  return {
    services: [
      { id: 'home', name: 'fixture-home.service', user: true },
      { id: 'agent', name: 'fixture-agent.service', user: false },
    ],
    endpoints: [
      { id: 'home', url: 'http://127.0.0.1:18787/' },
      { id: 'knowledge', url: 'http://127.0.0.1:18787/knowledge.html' },
    ],
    readService: async () => ({ ...service }),
    probeEndpoint: async () => 200,
  };
}

function anthropicSse(answer, requestNumber) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: `fixture-message-${requestNumber}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: BENCHMARK_MODEL,
        stop_reason: null,
        usage: {
          input_tokens: 40 + requestNumber,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: answer },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: 'message_stop' },
  ];
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')}`;
}

function fakeUpstream(fakeCredential, sanitizedRequests) {
  return async (input, init = {}) => {
    assert.equal(String(input), OFFICIAL_ANTHROPIC_MESSAGES_URL);
    assert.equal(String(init.method).toUpperCase(), 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('x-api-key'), fakeCredential);
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, BENCHMARK_MODEL);
    assert.equal(body.output_config.effort, BENCHMARK_EFFORT);
    assert.equal(body.temperature, 0);
    assert.equal(body.stream, true);
    assert.ok(body.max_tokens > 0 && body.max_tokens <= BENCHMARK_MAX_OUTPUT_TOKENS);
    // Keep only non-sensitive protocol facts. The request prompts and headers
    // deliberately never enter the test audit object.
    sanitizedRequests.push({
      url: String(input),
      model: body.model,
      maxTokens: body.max_tokens,
    });
    const publicProbe = JSON.stringify(body.messages || []).includes(
      'Public synthetic connectivity check.',
    );
    const answer = publicProbe
      ? 'OK'
      : `${ANSWER_MARKER}: the public fixture launch date is 2026-09-05.`;
    return new Response(anthropicSse(answer, sanitizedRequests.length), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };
}

function fakeOriginalSdkQuery(request) {
  return (async function* queryFixture() {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'fixture-sdk-session',
      model: BENCHMARK_MODEL,
    };
    const customHeader = String(request.options.env.ANTHROPIC_CUSTOM_HEADERS || '')
      .split(/\r?\n/u)
      .find((line) => line.toLowerCase().startsWith('x-benchmark-anonymous-id:'));
    assert.ok(customHeader);
    const anonymousId = customHeader.slice(customHeader.indexOf(':') + 1).trim();
    const taggedFetch = async (input, init = {}) => {
      const headers = new Headers(init.headers || {});
      headers.set('x-benchmark-anonymous-id', anonymousId);
      return fetch(input, { ...init, headers });
    };
    const client = new ChatModelClient({
      provider: 'anthropic',
      apiBase: request.options.env.ANTHROPIC_BASE_URL,
      apiKey: request.options.env.ANTHROPIC_API_KEY,
      model: BENCHMARK_MODEL,
      temperature: 0,
      maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
      timeoutMs: 10_000,
      allowInsecureHttp: true,
    }, { fetch: taggedFetch });
    const answer = await client.generate(
      [{ role: 'user', content: request.prompt }],
      {
        model: request.options.model,
        effort: request.options.effort,
        temperature: 0,
        maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS,
      },
    );
    yield {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: answer },
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      result: answer,
      num_turns: 1,
      duration_ms: 1,
      total_cost_usd: 0,
      modelUsage: {
        [BENCHMARK_MODEL]: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    };
  })();
}

async function allFiles(root) {
  const output = [];
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await allFiles(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

test('credential loader requires a 0600 regular file and the fixed JSON selector', async (t) => {
  const project = await fixture();
  t.after(project.cleanup);
  assert.equal(await readBenchmarkCredential(project.credentialFile), project.fakeCredential);

  await fsp.chmod(project.credentialFile, 0o640);
  await assert.rejects(
    () => readBenchmarkCredential(project.credentialFile),
    (error) => error instanceof BenchmarkCloudExecutorError &&
      error.code === 'UNSAFE_CREDENTIAL_MODE',
  );
  await fsp.chmod(project.credentialFile, 0o600);
  await fsp.writeFile(project.credentialFile, '{"env":{}}\n');
  await assert.rejects(
    () => readBenchmarkCredential(project.credentialFile),
    (error) => error instanceof BenchmarkCloudExecutorError &&
      error.code === 'CREDENTIAL_FIELD_MISSING',
  );
});

test('cloud executor rejects every upstream except the exact pinned HTTPS Messages URL', async () => {
  await assert.rejects(
    () => executeCloudBenchmark({
      upstreamUrl: 'https://dashscope.aliyuncs.com/other/v1/messages',
    }),
    (error) => error instanceof BenchmarkCloudExecutorError &&
      error.code === 'UPSTREAM_URL_NOT_PINNED',
  );
  await assert.rejects(
    () => executeCloudBenchmark({ upstreamUrl: 'http://127.0.0.1:9999/v1/messages' }),
    (error) => error instanceof BenchmarkCloudExecutorError &&
      error.code === 'UPSTREAM_URL_NOT_PINNED',
  );
});

test('dataset approval is checked before any path, credential, or provider work', async () => {
  await assert.rejects(
    () => executeCloudBenchmark({
      dataset: {
        reviewStatus: 'pending',
        executionAllowed: false,
        items: [{ id: 'Q001', review: { status: 'pending' } }],
      },
      snapshotRoot: '/must-not-be-opened',
      originalRoot: '/must-not-be-opened',
      privateRunRoot: '/must-not-be-created',
      credentialFile: '/must-not-be-opened',
    }),
    (error) => error?.code === 'DATASET_NOT_APPROVED',
  );
});

test('telemetry cursor rejects a record from any other anonymous task without advancing', async () => {
  const records = [{
    anonymousId: 'B-wrong-task',
    attempt: 1,
    usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
    timing: {},
    errorCode: null,
  }];
  const cursor = benchmarkCloudExecutorInternals.telemetryCursorProvider({
    records: () => structuredClone(records),
  });
  await assert.rejects(
    () => cursor.consume({ anonymousId: 'B-expected-task', system: 'original-agent' }),
    (error) => error instanceof BenchmarkCloudExecutorError &&
      error.code === 'PROXY_TELEMETRY_ID_MISMATCH',
  );
  assert.equal(cursor.cursor, 0);
});

test('persisted benchmark schedule removes complete private question objects', () => {
  const summary = benchmarkCloudExecutorInternals.anonymousBenchmarkSummary({
    status: 'completed',
    schedule: [{
      pairId: 'normal:normal:r1:Q001',
      questionId: 'Q001',
      phase: 'normal_main',
      mode: 'normal',
      round: 1,
      systemOrder: ['agent', 'rag'],
      question: {
        query: QUESTION_MARKER,
        goldAnswer: ANSWER_MARKER,
        evidence: [{ path: 'private/example.md' }],
      },
    }],
  });
  assert.equal(Object.hasOwn(summary.schedule[0], 'question'), false);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(QUESTION_MARKER), false);
  assert.equal(serialized.includes(ANSWER_MARKER), false);
  assert.equal(serialized.includes('private/example.md'), false);
});

test('real Claude Agent SDK applies the per-question anonymous header through loopback',
  { timeout: 60_000 }, async (t) => {
    const project = await fixture();
    t.after(project.cleanup);
    const originalRoot = path.resolve('..', 'web_construction', 'yuan-home');
    const sdkFile = path.join(
      originalRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs',
    );
    if (!await fsp.stat(sdkFile).catch(() => null)) {
      t.skip('The real Claude Agent SDK fixture is unavailable.');
      return;
    }
    const sanitizedRequests = [];
    const ledger = new BudgetLedger();
    const proxy = await startAnthropicBenchmarkProxy({
      upstreamUrl: OFFICIAL_ANTHROPIC_MESSAGES_URL,
      allowedUpstreamOrigins: ['https://dashscope.aliyuncs.com'],
      upstreamApiKey: project.fakeCredential,
      ledger,
      fetch: fakeUpstream(project.fakeCredential, sanitizedRequests),
      maxUpstreamAttempts: 1,
    });
    t.after(() => proxy.close());
    const cursor = benchmarkCloudExecutorInternals.telemetryCursorProvider(proxy);
    const runner = new OriginalAgentRunner({
      originalRoot,
      snapshotRoot: project.snapshotRoot,
      runRoot: path.join(project.root, 'real-sdk-state'),
      liveVaultRoot: null,
      queryFn: await loadOriginalAgentSdkQuery(originalRoot),
      sdkEnv: {
        ANTHROPIC_BASE_URL: proxy.url,
        ANTHROPIC_API_KEY: proxy.clientToken,
      },
      telemetryProvider: (context) => cursor.consume(context),
    });
    const anonymousId = 'REAL-SDK-HEADER-01';
    const result = await runner.runQuestion({
      anonymousId,
      query: 'What is the public synthetic launch date?',
      mode: 'normal',
    });
    assert.equal(result.status, 'completed');
    assert.equal(sanitizedRequests.length, 1);
    assert.ok(result.model.telemetry.records.length > 0);
    assert.ok(result.model.telemetry.records.every((record) => record.anonymousId === anonymousId));
    const stateEntries = await fsp.readdir(path.join(project.root, 'real-sdk-state'));
    assert.ok(stateEntries.every((entry) => entry.startsWith('.original-import-')));
  });

test('fake upstream integration runs public probe then four private paired calibrations',
  { timeout: 60_000 }, async (t) => {
    const project = await fixture();
    t.after(project.cleanup);
    const originalRoot = path.resolve('..', 'web_construction', 'yuan-home');
    const originalModule = await fsp.stat(
      path.join(originalRoot, 'lib', 'knowledge-agent.mjs'),
    ).catch(() => null);
    if (!originalModule?.isFile()) {
      t.skip('The migration source repository is not present beside this checkout.');
      return;
    }
    const sanitizedRequests = [];
    const progressEvents = [];
    const result = await executeCloudBenchmark({
      dataset: approvedSyntheticDataset(),
      snapshotRoot: project.snapshotRoot,
      originalRoot,
      privateRunRoot: project.privateRunRoot,
      credentialFile: project.credentialFile,
      liveVaultRoot: null,
      calibrationOnly: true,
      seed: 'cloud-executor-fixture',
      productionGuardOptions: productionGuardOptions(),
      onProgress: async (event) => {
        progressEvents.push(event);
      },
    }, {
      upstreamFetch: fakeUpstream(project.fakeCredential, sanitizedRequests),
      originalQueryFn: fakeOriginalSdkQuery,
    });

    assert.equal(result.status, 'calibration_completed');
    assert.equal(result.calibrationOnly, true);
    assert.equal(result.benchmark.records.length, 8);
    assert.equal(result.rawFiles.length, 8);
    assert.equal(result.probe.publicSynthetic, true);
    assert.equal(result.probe.telemetry.cursorStart, 0);
    assert.equal(result.probe.telemetry.cursorEnd, 1);
    assert.equal(result.probe.estimatedCostCny > 0, true);
    assert.equal(result.integrity.snapshot.unchanged, true);
    assert.equal(result.integrity.production.unchanged, true);
    assert.equal(result.budget.openReservations, 0);
    assert.equal(result.budget.uncertainCny, 0);
    assert.equal(sanitizedRequests.length, 9);
    assert.equal(progressEvents[0].event, 'preflight-complete');
    assert.equal(progressEvents[1].event, 'public-probe-complete');
    assert.equal(
      progressEvents.filter((event) => event.event === 'question-run-complete').length,
      8,
    );
    assert.equal(
      progressEvents.filter((event) => event.event === 'calibration-decision').length,
      1,
    );
    const calibrationDecision = progressEvents.find(
      (event) => event.event === 'calibration-decision',
    );
    assert.equal(calibrationDecision.forecastStatus, 'ready');
    assert.equal(calibrationDecision.selectedTier, 'full');
    assert.equal(calibrationDecision.projectedTotalCny > 0, true);
    assert.equal(progressEvents.at(-1).event, 'execution-complete');
    const serializedProgress = JSON.stringify(progressEvents);
    assert.equal(serializedProgress.includes(project.fakeCredential), false);
    assert.equal(serializedProgress.includes('Project Aurora launch'), false);
    assert.equal(serializedProgress.includes('2026-09-05'), false);

    const rawPayloads = await Promise.all(result.rawFiles.map(async (relative) => (
      JSON.parse(await fsp.readFile(path.join(project.privateRunRoot, relative), 'utf8'))
    )));
    const telemetryWindows = rawPayloads.map((payload) => payload.rawResult.model.telemetry);
    assert.deepEqual(
      telemetryWindows.map((telemetry) => telemetry.cursorStart),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.deepEqual(
      telemetryWindows.map((telemetry) => telemetry.cursorEnd),
      [2, 3, 4, 5, 6, 7, 8, 9],
    );
    assert.ok(telemetryWindows.every((telemetry) => telemetry.recordCount === 1));
    assert.ok(rawPayloads.every((payload) => payload.rawResult.model.telemetry.records
      .every((record) => record.anonymousId === payload.rawResult.anonymousId)));
    assert.ok(result.benchmark.records.every((record) => record.status === 'success'));

    const files = await allFiles(project.privateRunRoot);
    assert.ok(files.some((file) => file.endsWith('public-probe.json')));
    assert.ok(files.some((file) => file.endsWith('cloud-execution-summary.json')));
    assert.equal(
      await fsp.lstat(path.join(project.privateRunRoot, 'runner-state')).catch(() => null),
      null,
    );
    const markerFiles = [];
    for (const file of files) {
      assert.equal((await fsp.stat(file)).mode & 0o777, 0o600, file);
      const content = await fsp.readFile(file, 'utf8');
      assert.equal(content.includes(project.fakeCredential), false, file);
      assert.equal(
        content.includes('Public synthetic connectivity check.'),
        false,
        file,
      );
      if (content.includes(QUESTION_MARKER) || content.includes(ANSWER_MARKER)) {
        markerFiles.push(path.relative(project.privateRunRoot, file));
      }
    }
    assert.ok(markerFiles.length > 0);
    assert.ok(markerFiles.every((file) => file.startsWith(`raw${path.sep}`)));
  });

test('failed execution persists only sanitized budget and telemetry reconciliation state',
  { timeout: 60_000 }, async (t) => {
    const project = await fixture();
    t.after(project.cleanup);
    const originalRoot = path.resolve('..', 'web_construction', 'yuan-home');
    if (!await fsp.stat(path.join(originalRoot, 'lib', 'knowledge-agent.mjs')).catch(() => null)) {
      t.skip('The migration source repository is not present beside this checkout.');
      return;
    }
    const sanitizedRequests = [];
    let injectedFailure = false;
    await assert.rejects(
      () => executeCloudBenchmark({
        dataset: approvedSyntheticDataset(),
        snapshotRoot: project.snapshotRoot,
        originalRoot,
        privateRunRoot: project.privateRunRoot,
        credentialFile: project.credentialFile,
        liveVaultRoot: null,
        calibrationOnly: true,
        seed: 'cloud-executor-failure-fixture',
        productionGuardOptions: productionGuardOptions(),
        onProgress: async (event) => {
          if (!injectedFailure && event.event === 'question-run-complete') {
            injectedFailure = true;
            throw new Error('synthetic callback failure');
          }
        },
      }, {
        upstreamFetch: fakeUpstream(project.fakeCredential, sanitizedRequests),
        originalQueryFn: fakeOriginalSdkQuery,
      }),
      (error) => error?.code === 'RECORD_CALLBACK_FAILED',
    );

    const failureFile = path.join(project.privateRunRoot, 'cloud-execution-failure.json');
    const failureText = await fsp.readFile(failureFile, 'utf8');
    const failure = JSON.parse(failureText);
    assert.equal((await fsp.stat(failureFile)).mode & 0o777, 0o600);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.budget.committedCny > 0, true);
    assert.equal(failure.budget.openReservations, 0);
    assert.equal(failure.telemetry.recordCount >= 3, true);
    assert.equal(failure.telemetry.unconsumedRecords, 0);
    assert.ok(failure.telemetry.records.every((record) => (
      typeof record.anonymousId === 'string' && !Object.hasOwn(record, 'prompt') &&
      !Object.hasOwn(record, 'answer')
    )));
    for (const forbidden of [
      project.fakeCredential,
      QUESTION_MARKER,
      ANSWER_MARKER,
      'synthetic callback failure',
    ]) {
      assert.equal(failureText.includes(forbidden), false);
    }
    assert.equal(
      await fsp.lstat(path.join(project.privateRunRoot, 'runner-state')).catch(() => null),
      null,
    );
  });
