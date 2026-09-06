import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';

import { PiAgentRuntime, piAgentRuntimeInternals } from '../src/pi-agent-runtime.mjs';
import { createPiModelAdapter } from '../src/pi-model-adapter.mjs';
import { temporaryProject } from './helpers.mjs';

const MODEL_ID = 'runtime-fixture-model';
const NOTE_PATH = 'Notes/Topic.md';
const NOTE_HASH = 'sha256-runtime-fixture';
const NOTE_TEXT = [
  '# Topic',
  'The verified project decision is alpha.',
  'The implementation milestone is beta.',
  'The final status is complete.',
].join('\n');
const READ_ONLY_TOOL_NAMES = Object.freeze([
  'list_vault',
  'search_text',
  'search_knowledge',
  'read_note',
  'resolve_note_reference',
  'list_date_records',
  'get_reading_coverage',
]);
const { validateCompletionLedger } = piAgentRuntimeInternals;

function binding() {
  return {
    protocol: 'openai-chat-completions',
    providerId: 'runtime-test-provider',
    requestProfile: 'default',
    apiBase: 'https://models.example/v1',
    apiKey: 'runtime-test-key',
    authMode: 'bearer',
    actualModel: MODEL_ID,
    maxOutputTokens: 8_192,
    contextWindow: 64_000,
    toolCapabilityVerified: true,
    fetch: async () => {
      throw new Error('The faux provider must not perform network I/O.');
    },
  };
}

function task(overrides = {}) {
  const abortController = overrides.abortController || new AbortController();
  return {
    prompt: 'What did the project decide and finish?',
    llmClient: { piBinding: binding },
    abortController,
    effectiveEffort: 'default',
    effort: 'default',
    taskMode: { id: 'normal' },
    vaultLabel: 'Test Vault',
    webSearch: false,
    webSearchClient: null,
    webReader: null,
    learningReviewRequest: null,
    kind: 'scratch',
    ...overrides,
    abortController,
  };
}

function conversation(messages, piSessionFile = '') {
  return { id: 'conversation-1', messages, piSessionFile };
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part?.text || '').join('');
}

function fixtureSnapshot() {
  const calls = { search: [], read: [] };
  return {
    calls,
    snapshot: {
      generation: 'runtime-generation-1',
      listDocuments() {
        return [{ path: NOTE_PATH, hash: NOTE_HASH, size: Buffer.byteLength(NOTE_TEXT) }];
      },
      async search(query, options) {
        calls.search.push({ query, options });
        return {
          route: options.route,
          diagnostics: { effectiveRoute: options.route },
          results: [{
            path: NOTE_PATH,
            name: 'Topic.md',
            heading: 'Topic',
            lineStart: 2,
            lineEnd: 3,
            content: 'project decision alpha implementation milestone beta',
            score: 0.95,
            matchedTerms: [query],
            relatedPaths: [],
          }],
        };
      },
      async readDocument(relative, options) {
        calls.read.push({ relative, options });
        assert.equal(relative, NOTE_PATH);
        return { path: NOTE_PATH, hash: NOTE_HASH, text: NOTE_TEXT };
      },
      async temporalInventory() {
        assert.fail('Date inventory is not part of this agent path.');
      },
    },
  };
}

function adapterFactoryForRuns(runDefinitions, observations) {
  let run = 0;
  return async (modelBinding, options) => {
    const definition = runDefinitions[run];
    assert(definition, `Unexpected Pi adapter run ${run + 1}`);
    run += 1;
    return createPiModelAdapter(modelBinding, {
      ...options,
      streamFactory(api) {
        const faux = createFauxCore({
          api,
          provider: `runtime-faux-${run}`,
          models: [{
            id: MODEL_ID,
            reasoning: false,
            contextWindow: 64_000,
            maxTokens: 8_192,
          }],
          ...definition.fauxOptions,
        });
        faux.setResponses(definition.responses);
        const capture = (model, context, streamOptions) => {
          observations.push({ run, model, context, streamOptions });
          return faux.streamSimple(model, context, streamOptions);
        };
        return { stream: capture, streamSimple: capture };
      },
    });
  };
}

function firstQaRun(observations) {
  return {
    responses: [
      (context) => {
        assert.deepEqual(context.tools.map((tool) => tool.name), READ_ONLY_TOOL_NAMES);
        assert.equal(context.tools.some((tool) => /bash|shell|write|edit/iu.test(tool.name)), false);
        return fauxAssistantMessage(fauxToolCall('search_knowledge', {
          query: 'project decision milestone',
          route: 'hybrid',
          limit: 1,
        }), { stopReason: 'toolUse' });
      },
      (context) => {
        const result = [...context.messages].reverse().find((message) => (
          message.role === 'toolResult' && message.toolName === 'search_knowledge'
        ));
        assert(result, 'search result must be returned to the model before it chooses read_note');
        assert.match(textOfContent(result.content), new RegExp(NOTE_PATH.replace('.', '\\.')));
        return fauxAssistantMessage(fauxToolCall('read_note', {
          path: NOTE_PATH,
          startLine: 1,
          maxLines: 2,
        }), { stopReason: 'toolUse' });
      },
      (context) => {
        const result = [...context.messages].reverse().find((message) => (
          message.role === 'toolResult' && message.toolName === 'read_note'
        ));
        assert(result, 'the first original-text page must be returned to the model');
        assert.match(textOfContent(result.content), /nextStartLine/u);
        return fauxAssistantMessage(fauxToolCall('read_note', {
          path: NOTE_PATH,
          startLine: 3,
          maxLines: 2,
        }), { stopReason: 'toolUse' });
      },
      (context) => {
        const reads = context.messages.filter((message) => (
          message.role === 'toolResult' && message.toolName === 'read_note'
        ));
        assert.equal(reads.length, 2);
        assert.match(textOfContent(reads[0].content), /sha256-runtime-fixture/u);
        assert.match(textOfContent(reads[1].content), /final status is complete/u);
        observations.firstFinalContext = {
          messages: structuredClone(context.messages),
          toolNames: context.tools.map((tool) => tool.name),
        };
        return fauxAssistantMessage(
          `The project chose alpha and finished beta. [[${NOTE_PATH}]]`,
        );
      },
    ],
  };
}

function resumedQaRun(observations) {
  return {
    responses: [
      (context) => {
        observations.resumedContext = {
          messages: structuredClone(context.messages),
          toolNames: context.tools.map((tool) => tool.name),
        };
        assert.equal(context.messages.some((message) => message.role === 'toolResult'), false,
          'durable checkpoints retain product turns, not raw tool payloads');
        assert(context.messages.some((message) => (
          message.role === 'assistant' && textOfContent(message.content).includes('finished beta')
        )));
        return fauxAssistantMessage('The prior verified answer remains available.');
      },
    ],
  };
}

test('real Pi AgentSession searches, paginates reads, and resumes only a canonical checkpoint', async (t) => {
  const temporary = await temporaryProject('pi-agent-runtime-');
  t.after(temporary.cleanup);
  const fixture = fixtureSnapshot();
  const observations = [];
  const events = [];
  const runtime = new PiAgentRuntime({
    ...temporary.config,
    llm: { timeoutMs: 5_000 },
  }, {
    store: {
      async resolveSource() {
        assert.fail('Reference resolution is not part of this agent path.');
      },
    },
    createModelAdapter: adapterFactoryForRuns([
      firstQaRun(observations),
      resumedQaRun(observations),
    ], observations),
  });
  const firstPrompt = 'What did the project decide and finish?';
  const firstTask = task({ prompt: firstPrompt });
  const first = await runtime.runQa({
    task: firstTask,
    conversation: conversation([{ role: 'user', content: firstPrompt }]),
    indexSnapshot: fixture.snapshot,
    emit: (type, data) => events.push({ type, data }),
  });

  assert.equal(first.answer, `The project chose alpha and finished beta. [[${NOTE_PATH}]]`);
  assert.match(first.sessionFile, /^[A-Za-z0-9][A-Za-z0-9._-]+\.jsonl$/u);
  assert.deepEqual(fixture.calls.search.map((call) => [call.query, call.options.route]), [
    ['project decision milestone', 'hybrid'],
  ]);
  assert.deepEqual(fixture.calls.read.map((call) => call.relative), [NOTE_PATH, NOTE_PATH]);
  assert(fixture.calls.read.every((call) => call.options.signal instanceof AbortSignal));
  assert.equal(first.ledger.generation, 'runtime-generation-1');
  assert.deepEqual(first.ledger.searches.map((entry) => entry.tool), ['search_knowledge']);
  assert.deepEqual(first.ledger.reads, [{
    path: NOTE_PATH,
    hash: NOTE_HASH,
    totalLines: 4,
    intervals: [[1, 4]],
    ranges: [[1, 4]],
    complete: true,
    uncovered: [],
  }]);
  assert.equal(first.ledger.complete, true);
  assert.deepEqual(first.ledger.uncovered, []);
  assert.deepEqual(first.sources, [{
    kind: 'vault', path: NOTE_PATH, hash: NOTE_HASH, ranges: [[1, 4]], complete: true,
  }]);
  assert.equal(first.metrics.engine, 'pi-agent');
  assert.equal(first.metrics.modelTurns, 4);
  assert.equal(first.metrics.toolCalls, 3);
  assert(first.metrics.firstEffectiveProgressMs !== null);
  assert(first.metrics.tokenUsage.totalTokens > 0);
  assert.equal(first.visibleTextStreamed, false);
  assert.equal(events.some((event) => event.type === 'text'), false,
    'unverified agent Markdown must remain buffered until TaskManager finalizes it');

  const sessionDir = path.join(temporary.dataDir, 'pi-sessions');
  const sessionPath = path.join(sessionDir, first.sessionFile);
  const [directoryStat, fileStat, persisted] = await Promise.all([
    fsp.stat(sessionDir),
    fsp.stat(sessionPath),
    fsp.readFile(sessionPath, 'utf8'),
  ]);
  if (process.platform !== 'win32') {
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
  }
  const jsonl = persisted.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(jsonl[0].type, 'session');
  assert.equal(jsonl[0].cwd, temporary.vaultPath);
  assert(jsonl.some((entry) => entry.type === 'message' && entry.message.role === 'toolResult'));
  assert(events.some((event) => (
    event.type === 'activity'
    && event.data.toolName === 'pi_agent_session'
    && event.data.diagnostics.resumed === false
  )));

  const canonicalConversation = conversation([
    { role: 'user', content: firstPrompt },
    { role: 'assistant', content: first.answer },
  ]);
  const canonicalFile = await runtime.finalizeSession({
    task: firstTask,
    conversation: canonicalConversation,
    workingSessionFile: first.sessionFile,
    checkpoint: first.sessionCheckpoint,
  });
  assert.notEqual(canonicalFile, first.sessionFile);
  assert.equal(await fsp.stat(sessionPath).then(() => true, () => false), false,
    'the raw tool transcript is removed after canonicalization');
  const canonicalPath = path.join(sessionDir, canonicalFile);
  const canonicalEntries = (await fsp.readFile(canonicalPath, 'utf8')).trim()
    .split('\n').map((line) => JSON.parse(line));
  assert.equal(canonicalEntries.some((entry) => (
    entry.type === 'message' && entry.message.role === 'toolResult'
  )), false);
  assert.equal(canonicalEntries.at(-1).customType, 'second_mind_canonical');

  const secondPrompt = 'Can you still see the verified prior result?';
  const secondEvents = [];
  const second = await runtime.runQa({
    task: task({ prompt: secondPrompt }),
    conversation: conversation([
      { role: 'user', content: firstPrompt },
      { role: 'assistant', content: first.answer },
      { role: 'user', content: secondPrompt },
    ], canonicalFile),
    indexSnapshot: fixture.snapshot,
    emit: (type, data) => secondEvents.push({ type, data }),
  });
  assert.notEqual(second.sessionFile, canonicalFile,
    'a resumed request writes to a disposable branch');
  assert.equal(second.answer, 'The prior verified answer remains available.');
  assert(secondEvents.some((event) => (
    event.type === 'activity'
    && event.data.toolName === 'pi_agent_session'
    && event.data.diagnostics.resumed === true
  )));
  assert(observations.resumedContext.messages.some((message) => (
    message.role === 'user' && textOfContent(message.content).includes(firstPrompt)
  )));
  assert(observations.resumedContext.messages.some((message) => (
    message.role === 'user' && textOfContent(message.content).includes(secondPrompt)
  )));
  if (process.platform !== 'win32') assert.equal((await fsp.stat(canonicalPath)).mode & 0o777, 0o600);
  const pruned = await runtime.pruneSessions(new Set([canonicalFile]));
  assert.equal(pruned.removed, 1);
  assert.equal(await fsp.stat(canonicalPath).then(() => true, () => false), true);
  assert.equal(await fsp.stat(path.join(sessionDir, second.sessionFile)).then(() => true, () => false), false);
});

test('Web-enabled Pi turns do not load prior private conversation history or stream raw Markdown', async (t) => {
  const temporary = await temporaryProject('pi-agent-web-history-isolation-');
  t.after(temporary.cleanup);
  const fixture = fixtureSnapshot();
  const observations = [];
  const webContexts = [];
  const events = [];
  const currentPrompt = 'Find the current public release status.';
  const privateHistory = 'PRIVATE_VAULT_EXCERPT_SHOULD_NOT_REACH_WEB_AGENT';
  const runtime = new PiAgentRuntime({
    ...temporary.config,
    llm: { timeoutMs: 5_000 },
  }, {
    store: {},
    createModelAdapter: adapterFactoryForRuns([{
      responses: [(context) => {
        webContexts.push({
          messages: structuredClone(context.messages),
          tools: context.tools.map((tool) => ({ name: tool.name })),
        });
        return fauxAssistantMessage('[unsafe](//evil.test/transient) No lookup was needed.');
      }],
    }], observations),
  });
  const result = await runtime.runQa({
    task: task({
      prompt: currentPrompt,
      webSearch: true,
      webSearchClient: {
        async searchMany() {
          assert.fail('The fixture response does not call Web Search.');
        },
      },
    }),
    conversation: conversation([
      { role: 'user', content: 'Summarize my private note.' },
      { role: 'assistant', content: privateHistory },
      { role: 'user', content: currentPrompt },
    ]),
    indexSnapshot: fixture.snapshot,
    emit: (type, data) => events.push({ type, data }),
  });

  assert.equal(result.visibleTextStreamed, false);
  assert(webContexts[0].tools.some((tool) => tool.name === 'web_search'));
  assert.equal(webContexts[0].messages.some((message) => (
    textOfContent(message.content).includes(privateHistory)
  )), false);
  assert.deepEqual(
    webContexts[0].messages.filter((message) => message.role === 'user')
      .map((message) => textOfContent(message.content)),
    [currentPrompt],
  );
  assert.equal(events.some((event) => event.type === 'text'), false);
  assert(events.some((event) => (
    event.type === 'activity' && event.data.toolName === 'pi_agent_session' &&
    event.data.diagnostics.historyIsolated === true && event.data.diagnostics.resumed === false
  )));
});

test('drafts use the Pi session layer without exposing any tool', async (t) => {
  const temporary = await temporaryProject('pi-agent-draft-');
  t.after(temporary.cleanup);
  const contexts = [];
  const runtime = new PiAgentRuntime({
    ...temporary.config,
    llm: { timeoutMs: 5_000 },
  }, {
    store: {},
    createModelAdapter: adapterFactoryForRuns([{
      responses: [(context) => {
        contexts.push({
          systemPrompt: context.systemPrompt,
          tools: context.tools.map((tool) => tool.name),
          messages: structuredClone(context.messages),
        });
        return fauxAssistantMessage('# Plan\n\n- [ ] Ship the verified change');
      }],
    }], []),
  });
  const prompt = '<user_input>Ship the verified change</user_input>';
  const result = await runtime.runDraft({
    task: task({ kind: 'plan', prompt: 'raw request' }),
    conversation: conversation([{ role: 'user', content: 'raw request' }]),
    emit: () => {},
    prompt,
  });

  assert.equal(result.answer, '# Plan\n\n- [ ] Ship the verified change');
  assert.deepEqual(contexts[0].tools, []);
  assert.match(contexts[0].systemPrompt, /Markdown only/u);
  assert.equal(contexts[0].systemPrompt.includes('Search snippets'), false);
  assert.deepEqual(result.ledger, { searches: [], reads: [], uncovered: [] });
  assert.equal(result.metrics.toolCalls, 0);
  const sessionPath = path.join(temporary.dataDir, 'pi-sessions', result.sessionFile);
  assert.equal((await fsp.stat(sessionPath)).isFile(), true);
});

test('published Pi Kimi requests flatten visible product history instead of replaying empty reasoning', async (t) => {
  const temporary = await temporaryProject('pi-agent-kimi-history-');
  t.after(temporary.cleanup);
  const requests = [];
  const kimiBinding = {
    ...binding(),
    providerId: 'kimi',
    requestProfile: 'kimi-openai',
    actualModel: 'kimi-k3',
    temperature: null,
    requiresCompleteAssistantReplay: true,
    assistantReasoningField: 'reasoning_content',
    fetch: async (url, init) => {
      requests.push({ url, init, payload: JSON.parse(String(init.body)) });
      const text = requests.length === 1 ? 'first visible answer' : 'second visible answer';
      const events = [
        `data: ${JSON.stringify({
          id: `kimi-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'kimi-k3',
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        })}`,
        `data: ${JSON.stringify({
          id: `kimi-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'kimi-k3',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(events, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  };
  const runtime = new PiAgentRuntime({
    ...temporary.config,
    llm: { timeoutMs: 5_000 },
  }, { store: {} });
  const kimiTask = (prompt) => task({
    kind: 'plan',
    prompt,
    effort: 'max',
    effectiveEffort: 'max',
    llmClient: { piBinding: () => kimiBinding },
  });

  const firstPrompt = '<user_input>first request</user_input>';
  const firstTask = kimiTask(firstPrompt);
  const first = await runtime.runDraft({
    task: firstTask,
    conversation: conversation([{ role: 'user', content: firstPrompt }]),
    emit() {},
    prompt: firstPrompt,
  });
  const committed = conversation([
    { role: 'user', content: firstPrompt },
    { role: 'assistant', content: first.answer },
  ]);
  const canonicalFile = await runtime.finalizeSession({
    task: firstTask,
    conversation: committed,
    workingSessionFile: first.sessionFile,
    checkpoint: first.sessionCheckpoint,
  });
  const canonicalEntries = (await fsp.readFile(
    path.join(temporary.dataDir, 'pi-sessions', canonicalFile),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(canonicalEntries.some((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant'
  )), true, 'the canonical product checkpoint remains durable but is never replayed natively');

  const secondPrompt = '<user_input>second request</user_input>';
  const secondEvents = [];
  const second = await runtime.runDraft({
    task: kimiTask(secondPrompt),
    conversation: conversation([
      ...committed.messages,
      { role: 'user', content: secondPrompt },
    ], canonicalFile),
    emit: (type, data) => secondEvents.push({ type, data }),
    prompt: secondPrompt,
  });

  assert.equal(second.answer, 'second visible answer');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://models.example/v1/chat/completions');
  assert.equal(requests[1].payload.messages.some((message) => message.role === 'assistant'), false);
  assert.equal(JSON.stringify(requests[1].payload.messages).includes('reasoning_content'), false);
  assert.match(JSON.stringify(requests[1].payload.messages), /conversation_history/u);
  assert.match(JSON.stringify(requests[1].payload.messages), /first visible answer/u);
  assert.deepEqual(requests.map((request) => request.payload.reasoning_effort), ['max', 'max']);
  assert(secondEvents.some((event) => (
    event.type === 'activity'
    && event.data.toolName === 'pi_agent_session'
    && event.data.diagnostics.resumed === false
    && event.data.diagnostics.historyFlattened === true
  )));
});

test('first QA proves tool capability once and includes probe usage in metrics', async (t) => {
  const temporary = await temporaryProject('pi-agent-capability-');
  t.after(temporary.cleanup);
  let probeCalls = 0;
  const observations = [];
  const unverifiedBinding = { ...binding(), toolCapabilityVerified: false };
  const runtime = new PiAgentRuntime({
    ...temporary.config,
    llm: { timeoutMs: 5_000 },
  }, {
    store: {},
    async probeToolCalling(modelBinding, options) {
      probeCalls += 1;
      assert.strictEqual(modelBinding, unverifiedBinding);
      assert.equal(typeof options.fetch, 'function');
      return {
        ok: true,
        code: 'PI_TOOL_CALL_VERIFIED',
        toolCalls: 1,
        assistantTurns: 2,
        usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23 },
      };
    },
    createModelAdapter: adapterFactoryForRuns([{
      responses: [fauxAssistantMessage('First verified answer.')],
    }, {
      responses: [fauxAssistantMessage('Second verified answer.')],
    }], observations),
  });
  const piTask = (prompt) => task({
    prompt,
    llmClient: { piBinding: () => unverifiedBinding },
  });

  const first = await runtime.runQa({
    task: piTask('first question'),
    conversation: conversation([{ role: 'user', content: 'first question' }]),
    indexSnapshot: fixtureSnapshot().snapshot,
    emit() {},
  });
  assert.equal(probeCalls, 1);
  assert.equal(first.metrics.capabilityProbe.performed, true);
  assert.equal(first.metrics.capabilityProbe.toolCalls, 1);
  assert.equal(first.metrics.modelTurns, 3);
  assert.equal(first.metrics.toolCalls, 1);
  assert(first.metrics.tokenUsage.inputTokens >= 11);
  assert(first.metrics.tokenUsage.totalTokens >= 23);

  const second = await runtime.runQa({
    task: piTask('second question'),
    conversation: conversation([{ role: 'user', content: 'second question' }]),
    indexSnapshot: fixtureSnapshot().snapshot,
    emit() {},
  });
  assert.equal(probeCalls, 1);
  assert.equal(second.metrics.capabilityProbe.performed, false);
  assert.equal(second.metrics.capabilityProbe.cached, true);
  assert.equal(second.metrics.modelTurns, 1);
  assert.equal(second.metrics.toolCalls, 0);
});

test('task cancellation aborts the active real Pi AgentSession and provider stream', async (t) => {
  const temporary = await temporaryProject('pi-agent-cancel-');
  t.after(temporary.cleanup);
  const abortController = new AbortController();
  const cancellation = Object.assign(new Error('cancelled by test'), { code: 'TASK_CANCELLED' });
  let providerSignal;
  let providerObservedAbort = false;
  const runtime = new PiAgentRuntime({
    ...temporary.config,
    llm: { timeoutMs: 5_000 },
  }, {
    store: {},
    createModelAdapter: adapterFactoryForRuns([{
      fauxOptions: { tokensPerSecond: 1_000 },
      responses: [(_context, streamOptions) => {
        providerSignal = streamOptions.signal;
        providerSignal.addEventListener('abort', () => { providerObservedAbort = true; }, { once: true });
        setTimeout(() => abortController.abort(cancellation), 0);
        return fauxAssistantMessage('This deliberately slow response must be cancelled.');
      }],
    }], []),
  });

  await assert.rejects(runtime.runQa({
    task: task({ prompt: 'cancel this', abortController }),
    conversation: conversation([{ role: 'user', content: 'cancel this' }]),
    indexSnapshot: fixtureSnapshot().snapshot,
    emit() {},
  }), (error) => error === cancellation || error?.code === 'TASK_CANCELLED');
  assert(providerSignal instanceof AbortSignal);
  assert.equal(providerSignal.aborted, true);
  assert.equal(providerObservedAbort, true);
  const sessionDir = path.join(temporary.dataDir, 'pi-sessions');
  const files = await fsp.readdir(sessionDir).catch(() => []);
  assert.deepEqual(files.filter((filename) => filename.endsWith('.jsonl')), [],
    'a cancelled task must discard its eager Pi transcript');
});

test('a truncated Pi answer preserves bounded terminal metrics and removes its transcript', async (t) => {
  const temporary = await temporaryProject('pi-agent-truncated-metrics-');
  t.after(temporary.cleanup);
  const piTask = task({ prompt: 'Produce a deliberately truncated answer.' });
  const runtime = new PiAgentRuntime({
    ...temporary.config,
    llm: { timeoutMs: 5_000 },
  }, {
    store: {},
    createModelAdapter: adapterFactoryForRuns([{
      responses: [fauxAssistantMessage('Incomplete output', { stopReason: 'length' })],
    }], []),
  });

  await assert.rejects(runtime.runQa({
    task: piTask,
    conversation: conversation([{ role: 'user', content: piTask.prompt }]),
    indexSnapshot: fixtureSnapshot().snapshot,
    emit() {},
  }), (error) => error?.code === 'PI_AGENT_OUTPUT_TRUNCATED');

  assert.equal(piTask.agentMetrics.engine, 'pi-agent');
  assert.equal(piTask.agentMetrics.piVersion, '0.85.1');
  assert.equal(piTask.agentMetrics.modelTurns, 1);
  assert.equal(piTask.agentMetrics.toolCalls, 0);
  assert.deepEqual(piTask.agentMetrics.limits, {
    maxAgentTurns: 12,
    maxAgentToolCalls: 16,
  });
  assert.deepEqual(piTask.agentMetrics.coverage.reads, []);
  const sessionDir = path.join(temporary.dataDir, 'pi-sessions');
  const files = await fsp.readdir(sessionDir).catch(() => []);
  assert.deepEqual(files.filter((filename) => filename.endsWith('.jsonl')), []);
});

test('a terminal toolUse reason without tool calls can never commit preliminary text', async (t) => {
  const temporary = await temporaryProject('pi-agent-incomplete-tool-use-');
  t.after(temporary.cleanup);
  const piTask = task({ prompt: 'Do not accept a malformed terminal tool request.' });
  const runtime = new PiAgentRuntime({
    ...temporary.config,
    llm: { timeoutMs: 5_000 },
  }, {
    store: {},
    createModelAdapter: adapterFactoryForRuns([{
      responses: [fauxAssistantMessage('PRELIMINARY ONLY', { stopReason: 'toolUse' })],
    }], []),
  });

  await assert.rejects(runtime.runQa({
    task: piTask,
    conversation: conversation([{ role: 'user', content: piTask.prompt }]),
    indexSnapshot: fixtureSnapshot().snapshot,
    emit() {},
  }), (error) => error?.code === 'PI_AGENT_INCOMPLETE_RESPONSE');

  assert.equal(piTask.agentMetrics.modelTurns, 1);
  assert.equal(piTask.agentMetrics.toolCalls, 0);
  const sessionDir = path.join(temporary.dataDir, 'pi-sessions');
  const files = await fsp.readdir(sessionDir).catch(() => []);
  assert.deepEqual(files.filter((filename) => filename.endsWith('.jsonl')), []);
});

test('an exhaustive answer cannot treat one coverage check as proof of an empty Vault', async (t) => {
  const temporary = await temporaryProject('pi-agent-exhaustive-discovery-');
  t.after(temporary.cleanup);
  const piTask = task({ prompt: 'Give a complete inventory of every note.' });
  const runtime = new PiAgentRuntime({
    ...temporary.config,
    llm: { timeoutMs: 5_000 },
  }, {
    store: {},
    createModelAdapter: adapterFactoryForRuns([{
      responses: [
        fauxAssistantMessage(fauxToolCall('get_reading_coverage', {}), { stopReason: 'toolUse' }),
        fauxAssistantMessage('The Vault is empty and completely inventoried.'),
      ],
    }], []),
  });

  await assert.rejects(runtime.runQa({
    task: piTask,
    conversation: conversation([{ role: 'user', content: piTask.prompt }]),
    indexSnapshot: fixtureSnapshot().snapshot,
    emit() {},
  }), (error) => error?.code === 'PI_AGENT_DISCOVERY_REQUIRED');

  assert.equal(piTask.agentMetrics.coverage.coverageChecks, 1);
  assert.equal(piTask.agentMetrics.coverage.listings.length, 0);
});

test('exhaustive and learning-review requests require an explicit coverage check and inventory', () => {
  assert.throws(() => validateCompletionLedger(
    { learningReviewRequest: null },
    '请完整盘点所有内容',
    { coverageChecks: 0, inventories: [], listings: [] },
  ), (error) => error?.code === 'PI_AGENT_COVERAGE_REQUIRED');
  assert.throws(() => validateCompletionLedger(
    { learningReviewRequest: null },
    '请完整盘点所有内容',
    { coverageChecks: 1, inventories: [], listings: [] },
  ), (error) => error?.code === 'PI_AGENT_DISCOVERY_REQUIRED');
  assert.throws(() => validateCompletionLedger(
    { learningReviewRequest: null },
    '请完整盘点所有内容',
    { coverageChecks: 1, inventories: [], listings: [{
      path: '', recursive: true, complete: false, uncoveredOffsets: [[50, 99]],
    }] },
  ), (error) => error?.code === 'PI_AGENT_DISCOVERY_INCOMPLETE');
  assert.doesNotThrow(() => validateCompletionLedger(
    { learningReviewRequest: null },
    '请完整盘点所有内容',
    { coverageChecks: 1, inventories: [], listings: [{
      path: '', recursive: true, complete: true, uncoveredOffsets: [],
    }] },
  ));
  assert.throws(() => validateCompletionLedger(
    { learningReviewRequest: { range: {} } },
    'review',
    { coverageChecks: 1, inventories: [] },
  ), (error) => error?.code === 'PI_AGENT_INVENTORY_REQUIRED');
  assert.doesNotThrow(() => validateCompletionLedger(
    { learningReviewRequest: { range: {} } },
    'review',
    { coverageChecks: 1, inventories: [{ complete: false }] },
  ));

  const exhaustivePrompt = piAgentRuntimeInternals.knowledgeSystemPrompt({});
  assert(exhaustivePrompt.indexOf('first call list_vault') < exhaustivePrompt.indexOf('call get_reading_coverage'));
});
