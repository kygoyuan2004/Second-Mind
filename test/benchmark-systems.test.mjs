import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BENCHMARK_SYSTEM_EFFORT,
  BENCHMARK_SYSTEM_MAX_OUTPUT_TOKENS,
  BENCHMARK_SYSTEM_MODEL,
  BenchmarkSystemError,
  MigratedRagRunner,
  OriginalAgentRunner,
  benchmarkSystemInternals,
  snapshotManifest,
} from '../scripts/lib/benchmark-systems.mjs';

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultmind-system-runner-'));
  const snapshotRoot = path.join(root, 'snapshot');
  const runRoot = path.join(root, 'private-runs');
  await fsp.mkdir(path.join(snapshotRoot, 'notes'), { recursive: true });
  await fsp.writeFile(
    path.join(snapshotRoot, 'notes', 'aurora.md'),
    '# Project Aurora\n\nThe launch date is 2026-09-05. The owner is Mei.\n',
  );
  await fsp.writeFile(
    path.join(snapshotRoot, 'notes', 'garden.md'),
    '# Garden\n\nThe garden irrigation window begins at 06:30.\n',
  );
  await fsp.chmod(path.join(snapshotRoot, 'notes', 'aurora.md'), 0o400);
  await fsp.chmod(path.join(snapshotRoot, 'notes', 'garden.md'), 0o400);
  await fsp.chmod(path.join(snapshotRoot, 'notes'), 0o500);
  await fsp.chmod(snapshotRoot, 0o500);
  return {
    root,
    snapshotRoot,
    runRoot,
    async cleanup() {
      await fsp.chmod(snapshotRoot, 0o700).catch(() => {});
      await fsp.chmod(path.join(snapshotRoot, 'notes'), 0o700).catch(() => {});
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

test('snapshotManifest is deterministic and covers content changes', async (t) => {
  const project = await fixture();
  t.after(project.cleanup);
  const first = await snapshotManifest(project.snapshotRoot);
  const second = await snapshotManifest(project.snapshotRoot);
  assert.deepEqual(second, first);
  assert.equal(first.fileCount, 2);
  assert.equal(first.sha256.length, 64);

  await fsp.chmod(path.join(project.snapshotRoot, 'notes', 'garden.md'), 0o600);
  await fsp.writeFile(path.join(project.snapshotRoot, 'notes', 'garden.md'), '# changed\n');
  await fsp.chmod(path.join(project.snapshotRoot, 'notes', 'garden.md'), 0o400);
  const changed = await snapshotManifest(project.snapshotRoot);
  assert.notEqual(changed.sha256, first.sha256);
});

test('snapshotManifest rejects writable files and external hard links', async (t) => {
  const writable = await fixture();
  t.after(writable.cleanup);
  const writableFile = path.join(writable.snapshotRoot, 'notes', 'aurora.md');
  await fsp.chmod(writableFile, 0o600);
  await assert.rejects(
    () => snapshotManifest(writable.snapshotRoot),
    (error) => error instanceof BenchmarkSystemError && error.code === 'SNAPSHOT_FILE_DENIED',
  );
  await fsp.chmod(writableFile, 0o400);
  await fsp.chmod(path.join(writable.snapshotRoot, 'notes'), 0o700);
  await assert.rejects(
    () => snapshotManifest(writable.snapshotRoot),
    (error) => error instanceof BenchmarkSystemError && error.code === 'SNAPSHOT_WRITABLE',
  );
  await fsp.chmod(path.join(writable.snapshotRoot, 'notes'), 0o500);

  const linked = await fixture();
  t.after(linked.cleanup);
  await fsp.link(
    path.join(linked.snapshotRoot, 'notes', 'aurora.md'),
    path.join(linked.root, 'external-hard-link.md'),
  );
  await assert.rejects(
    () => snapshotManifest(linked.snapshotRoot),
    (error) => error instanceof BenchmarkSystemError && error.code === 'SNAPSHOT_FILE_DENIED',
  );
});

test('runner initialization rejects live Vault overlap without reading live contents', async (t) => {
  const project = await fixture();
  t.after(project.cleanup);
  const llm = { generate: async () => 'offline' };
  const snapshotOverlap = new MigratedRagRunner({
    snapshotRoot: project.snapshotRoot,
    runRoot: project.runRoot,
    liveVaultRoot: project.root,
    llm,
  });
  await assert.rejects(
    () => snapshotOverlap.initialize(),
    (error) => error instanceof BenchmarkSystemError &&
      error.code === 'SNAPSHOT_LIVE_VAULT_OVERLAP',
  );

  const liveVaultRoot = path.join(project.root, 'separate-live-vault');
  await fsp.mkdir(liveVaultRoot);
  const stateOverlap = new MigratedRagRunner({
    snapshotRoot: project.snapshotRoot,
    runRoot: path.join(liveVaultRoot, 'benchmark-state'),
    liveVaultRoot,
    llm,
  });
  await assert.rejects(
    () => stateOverlap.initialize(),
    (error) => error instanceof BenchmarkSystemError && error.code === 'RUN_LIVE_VAULT_OVERLAP',
  );

  const missingLiveVault = new MigratedRagRunner({
    snapshotRoot: project.snapshotRoot,
    runRoot: project.runRoot,
    liveVaultRoot: path.join(project.root, 'missing-live-vault'),
    llm,
  });
  await assert.rejects(
    () => missingLiveVault.initialize(),
    (error) => error instanceof BenchmarkSystemError && error.code === 'LIVE_VAULT_UNAVAILABLE',
  );
});

test('runners reject implicit model networking and overlapping state paths', async (t) => {
  const project = await fixture();
  t.after(project.cleanup);
  assert.throws(
    () => new OriginalAgentRunner({}),
    (error) => error instanceof BenchmarkSystemError && error.code === 'QUERY_FN_REQUIRED',
  );
  assert.throws(
    () => new MigratedRagRunner({}),
    (error) => error instanceof BenchmarkSystemError && error.code === 'LLM_REQUIRED',
  );
  const runner = new MigratedRagRunner({
    snapshotRoot: project.snapshotRoot,
    runRoot: path.join(project.snapshotRoot, 'runs'),
    liveVaultRoot: null,
    llm: { generate: async () => 'offline' },
  });
  await assert.rejects(
    () => runner.initialize(),
    (error) => error instanceof BenchmarkSystemError && error.code === 'UNSAFE_BENCHMARK_PATH',
  );
  assert.throws(
    () => benchmarkSystemInternals.minimalSdkEnvironment(project.runRoot, {
      ANTHROPIC_API_KEY: 'fixture-token',
    }),
    (error) => error instanceof BenchmarkSystemError && error.code === 'INVALID_SDK_ENV',
  );
  assert.throws(
    () => benchmarkSystemInternals.minimalSdkEnvironment(project.runRoot, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999/not-the-proxy',
      ANTHROPIC_API_KEY: 'fixture-token',
    }),
    (error) => error instanceof BenchmarkSystemError && error.code === 'INVALID_SDK_ENV',
  );
  assert.throws(
    () => benchmarkSystemInternals.minimalSdkEnvironment(project.runRoot, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
      ANTHROPIC_API_KEY: 'fixture-token',
      ANTHROPIC_CUSTOM_HEADERS:
        'x-benchmark-anonymous-id: safe\r\nx-leaked-header: forbidden',
    }),
    (error) => error instanceof BenchmarkSystemError && error.code === 'INVALID_SDK_ENV',
  );
});

test('MigratedRagRunner executes real normal/deep retrieval with an offline LLM', async (t) => {
  const project = await fixture();
  t.after(project.cleanup);
  const calls = [];
  const llm = {
    async generate(messages, options) {
      calls.push({ messages: structuredClone(messages), options: { ...options } });
      const system = String(messages[0]?.content || '');
      if (/search quer/i.test(system) || /retrieval quer/i.test(system)) {
        return JSON.stringify(['Aurora launch date', 'Aurora owner']);
      }
      options.onToken?.('The launch date is 2026-09-05.');
      return 'The launch date is 2026-09-05.';
    },
  };
  const runner = new MigratedRagRunner({
    snapshotRoot: project.snapshotRoot,
    runRoot: project.runRoot,
    liveVaultRoot: null,
    llm,
    topK: 12,
  });
  assert.equal(runner.deepTopK, 12);
  assert.equal(runner.maxContextChars, 24_000);
  const normal = await runner.runQuestion({
    anonymousId: 'Q01',
    query: 'When does Project Aurora launch?',
    mode: 'normal',
    priorMessages: [
      { role: 'user', content: 'We were discussing Project Aurora.' },
      { role: 'assistant', content: 'I will use only the supplied notes.' },
    ],
  });
  assert.equal(normal.status, 'completed');
  assert.equal(normal.system, 'migrated-rag');
  assert.equal(normal.contextMessages, 2);
  assert.match(normal.answer, /2026-09-05/);
  assert.equal(normal.configuration.model, BENCHMARK_SYSTEM_MODEL);
  assert.equal(normal.configuration.effort, BENCHMARK_SYSTEM_EFFORT);
  assert.equal(normal.configuration.maxOutputTokens, BENCHMARK_SYSTEM_MAX_OUTPUT_TOKENS);
  assert.equal(normal.integrity.unchanged, true);
  assert.equal(normal.integrity.before.sha256, normal.integrity.after.sha256);
  assert.ok(normal.retrieval.results.some((result) => result.path === 'notes/aurora.md'));
  assert.equal(normal.model.calls.length, 1);
  assert.equal(normal.model.calls[0].temperature, 0);
  assert.ok(normal.timing.indexBuildMs >= 0);
  assert.ok(normal.timing.ttftMs >= 0);
  assert.ok(normal.timing.generationMs >= 0);
  assert.ok(normal.timing.streamCompletionMs >= 0);
  assert.ok(calls[0].messages.some((message) => message.content.includes('We were discussing')));
  assert.equal(calls[0].options.model, BENCHMARK_SYSTEM_MODEL);
  assert.equal(calls[0].options.effort, BENCHMARK_SYSTEM_EFFORT);
  assert.deepEqual(await fsp.readdir(project.runRoot), []);

  const deep = await runner.runQuestion({
    anonymousId: 'Q02',
    query: 'Cross-check Aurora launch timing and owner.',
    mode: 'deep',
  });
  assert.equal(deep.status, 'completed');
  assert.equal(deep.mode, 'deep');
  assert.ok(deep.model.calls.length >= 2);
  assert.ok(deep.retrieval.searches.length >= 1);
  assert.ok(deep.retrieval.results.some((result) => result.path === 'notes/aurora.md'));
  assert.deepEqual(await fsp.readdir(project.runRoot), []);
});

test('a runner fails closed when an injected dependency mutates the snapshot', async (t) => {
  const project = await fixture();
  t.after(project.cleanup);
  const target = path.join(project.snapshotRoot, 'notes', 'aurora.md');
  const runner = new MigratedRagRunner({
    snapshotRoot: project.snapshotRoot,
    runRoot: project.runRoot,
    liveVaultRoot: null,
    llm: {
      async generate() {
        await fsp.chmod(target, 0o600);
        await fsp.writeFile(target, '# Project Aurora\n\nmutated fixture\n');
        await fsp.chmod(target, 0o400);
        return 'This result must be rejected.';
      },
    },
  });
  await assert.rejects(
    () => runner.runQuestion({ anonymousId: 'Q-mut', query: 'Aurora date?', mode: 'normal' }),
    (error) => error instanceof BenchmarkSystemError && error.code === 'SNAPSHOT_MUTATED',
  );
  assert.deepEqual(await fsp.readdir(project.runRoot), []);
});

test('OriginalAgentRunner imports the original classes and isolates an offline QA run', async (t) => {
  const project = await fixture();
  t.after(project.cleanup);
  const originalRoot = path.resolve('..', 'web_construction', 'yuan-home');
  const originalStat = await fsp.stat(path.join(originalRoot, 'lib', 'knowledge-agent.mjs')).catch(() => null);
  if (!originalStat?.isFile()) {
    t.skip('The migration source repository is not present beside this checkout.');
    return;
  }
  const requests = [];
  const priorCapabilityCache = process.env.AGENT_MODEL_CAPABILITY_CACHE;
  const productionCacheSentinel = path.join(project.root, 'must-not-be-read.json');
  process.env.AGENT_MODEL_CAPABILITY_CACHE = productionCacheSentinel;
  t.after(() => {
    if (priorCapabilityCache === undefined) delete process.env.AGENT_MODEL_CAPABILITY_CACHE;
    else process.env.AGENT_MODEL_CAPABILITY_CACHE = priorCapabilityCache;
  });
  const fakeQuery = (request) => {
    requests.push(request);
    return (async function* generateFixtureResult() {
      yield {
        type: 'system', subtype: 'init', session_id: 'offline-session',
        model: BENCHMARK_SYSTEM_MODEL,
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Read', input: { file_path: 'notes/aurora.md' } },
        },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Aurora launches on 2026-09-05.' },
        },
      };
      yield {
        type: 'result', subtype: 'success', result: 'Aurora launches on 2026-09-05.',
        num_turns: 2, duration_ms: 12, total_cost_usd: 0,
        modelUsage: {
          [BENCHMARK_SYSTEM_MODEL]: {
            inputTokens: 120,
            outputTokens: 18,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      };
    })();
  };
  const runner = new OriginalAgentRunner({
    originalRoot,
    snapshotRoot: project.snapshotRoot,
    runRoot: project.runRoot,
    liveVaultRoot: null,
    queryFn: fakeQuery,
    sdkEnv: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
      ANTHROPIC_API_KEY: 'offline-placeholder',
    },
  });
  const result = await runner.runQuestion({
    anonymousId: 'Q03',
    query: 'What is the Aurora launch date?',
    mode: 'normal',
    priorMessages: [
      { role: 'user', content: 'Continue our Aurora discussion.' },
      { role: 'assistant', content: 'I will verify the exact date.' },
    ],
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.system, 'original-agent');
  assert.equal(result.contextMessages, 2);
  assert.match(result.answer, /2026-09-05/);
  assert.equal(result.model.turns, 2);
  assert.equal(result.model.usage[BENCHMARK_SYSTEM_MODEL].inputTokens, 120);
  assert.equal(result.retrieval.diagnostics.embeddingModel, 'benchmark-disabled');
  assert.equal(result.retrieval.diagnostics.embeddingApiCalled, false);
  assert.ok(result.timing.indexBuildMs >= 0);
  assert.ok(result.timing.ttftMs >= 0);
  assert.ok(result.timing.generationMs >= 0);
  assert.ok(result.timing.streamCompletionMs >= 0);
  assert.ok(result.retrieval.results.some((entry) => entry.path === 'notes/aurora.md'));
  assert.ok(result.toolEvents.some((event) => event.toolName === 'Read'));
  assert.equal(result.integrity.before.sha256, result.integrity.after.sha256);
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /Continue our Aurora discussion/);
  assert.equal(requests[0].options.model, BENCHMARK_SYSTEM_MODEL);
  assert.equal(requests[0].options.effort, BENCHMARK_SYSTEM_EFFORT);
  assert.deepEqual(requests[0].options.settingSources, []);
  assert.equal(requests[0].options.persistSession, false);
  assert.equal(requests[0].options.resume, undefined);
  assert.equal(requests[0].options.env.ANTHROPIC_API_KEY, 'offline-placeholder');
  assert.equal(
    requests[0].options.env.ANTHROPIC_CUSTOM_HEADERS,
    'x-benchmark-anonymous-id: Q03',
  );
  assert.equal(requests[0].options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '3000');
  assert.equal(Object.hasOwn(requests[0].options.env, 'DASHSCOPE_API_KEY'), false);
  assert.equal(process.env.AGENT_MODEL_CAPABILITY_CACHE, productionCacheSentinel);

  const stateEntries = await fsp.readdir(project.runRoot);
  const stateName = stateEntries.find((entry) => entry.startsWith('Q03-original-agent-'));
  const importName = stateEntries.find((entry) => entry.startsWith('.original-import-'));
  assert.equal(stateName, undefined);
  assert.ok(importName);
  const isolatedCache = path.join(project.runRoot, importName, 'model-capabilities.json');
  assert.deepEqual(JSON.parse(await fsp.readFile(isolatedCache, 'utf8')), { models: {} });
  assert.equal((await fsp.stat(isolatedCache)).mode & 0o777, 0o600);
});
