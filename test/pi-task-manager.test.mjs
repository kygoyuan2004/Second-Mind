import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ConversationStore } from '../src/conversation-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { VaultStore } from '../src/vault-store.mjs';
import { temporaryProject } from './helpers.mjs';

function managerConfig(project) {
  return {
    ...project.config,
    appName: 'Pi TaskManager fixture',
    vaultLabel: 'Fixture Vault',
    timezone: 'UTC',
    modelCatalog: [{
      id: 'pi-fixture',
      label: 'Pi fixture model',
      actualModel: 'pi-fixture-model',
      provider: 'fixture',
      efforts: ['default'],
      defaultEffort: 'default',
      available: true,
      capabilityVerified: true,
    }],
    llm: {
      provider: 'fixture',
      model: 'pi-fixture-model',
      timeoutMs: 2_000,
      maxOutputTokens: 4_096,
      temperature: 0,
    },
    embedding: { provider: 'disabled' },
    retrieval: { topK: 8, maxContextChars: 20_000 },
    deep: { enabled: true, topK: 12 },
    research: { contextualizerEnabled: false },
    sync: { provider: 'filesystem', displayName: 'Fixture' },
  };
}

function indexFixture() {
  const calls = { acquired: 0, released: 0, closed: 0 };
  const snapshot = Object.freeze({
    generation: 'pi-task-manager-fixture',
    status: () => ({ available: true, files: 2, chunks: 2 }),
    search: async () => assert.fail('TaskManager must not run the legacy retrieval pipeline'),
    listDocuments: () => [{ path: 'Notes/Read.md', hash: 'hash-read', size: 80 }],
    readDocument: async () => assert.fail('The injected Pi fixture owns any tool reads'),
    release: () => { calls.released += 1; },
  });
  const index = {
    ready: Promise.resolve(),
    status: () => ({
      available: true,
      generation: snapshot.generation,
      files: 2,
      chunks: 2,
      lexicalAvailable: true,
      semanticAvailable: false,
      embedding: { provider: 'disabled' },
    }),
    acquireSnapshot() {
      calls.acquired += 1;
      return snapshot;
    },
    async search() {
      assert.fail('TaskManager must not run the legacy retrieval pipeline');
    },
    async close() { calls.closed += 1; },
  };
  return { index, snapshot, calls };
}

function piCapableLlm() {
  const calls = { generate: 0, bindings: 0 };
  const llm = {
    piBinding() {
      calls.bindings += 1;
      return { protocol: 'fixture' };
    },
    async generate() {
      calls.generate += 1;
      assert.fail('Legacy llm.generate must not run for a Pi-capable client');
    },
  };
  return { llm, calls };
}

test('Pi-capable QA routes only through the injected agent and persists verified citations and session', async (t) => {
  const project = await temporaryProject('second-mind-pi-task-qa-');
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = indexFixture();
  const llm = piCapableLlm();
  const piCalls = { supports: [], qa: [], draft: [] };
  const piAgent = {
    supports(client) {
      piCalls.supports.push(client);
      return typeof client?.piBinding === 'function';
    },
    async runQa(input) {
      piCalls.qa.push(input);
      assert.strictEqual(input.indexSnapshot, index.snapshot);
      assert.equal(input.task.llmClient, llm.llm);
      assert.match(input.prompt, /请根据原文回答/u);
      assert.match(input.prompt, /<attachment name="context\.txt">/u);
      assert.match(input.prompt, /附件中的补充上下文/u);
      input.emit('activity', {
        title: 'Fixture Pi tool loop',
        message: 'Model selected and consumed a read result.',
        toolName: 'read_note',
        stage: 'complete',
      });
      return {
        answer: [
          '这条结论已经读取原文 [[Notes/Read.md]]。',
          '路径必须逐字符保真 [[Notes/A  B & C.md]]。',
          '这个引用只出现在模型文本中，未实际读取 [[Notes/Unread.md]]。',
          '外部依据 [web_1]，伪造链接 https://evil.test/not-read。',
          '绕过尝试：[协议相对](//evil.test/relative)、[实体编码](&#104;ttps://evil.test/entity)、[脚本](javascript:alert(1))。',
          '参考式 [伪来源][evil-ref]与 <a href="https://evil.test/html">原始 HTML</a>。',
          '[evil-ref]: https://evil.test/reference',
          '链接目标中的引用 [不应计入]([[Notes/LinkOnly.md]])。',
          '<a href="[[Notes/HtmlOnly.md]]">属性中的引用不应计入</a>。',
          '<!-- [[Notes/CommentOnly.md]] -->',
          '<?pi [[Notes/ProcessingOnly.md]] ?>',
          '<!DOCTYPE note [[Notes/DeclarationOnly.md]]>',
          '<![CDATA[[[Notes/CdataOnly.md]]]]>',
          '<<x>a title="[[Notes/StitchedOnly.md]]">隐藏</a>',
          '### Sources',
          '- [[Notes/AppendixOnly.md]]',
        ].join('\n'),
        sessionFile: 'pi-qa-session.jsonl',
        sources: [{
          kind: 'vault',
          path: 'Notes/Read.md',
          hash: 'hash-read',
          ranges: [[1, 4]],
          complete: true,
        }, {
          kind: 'vault',
          path: 'Notes/A  B & C.md',
          hash: 'hash-exact-path',
          ranges: [[1, 1]],
          complete: true,
        }, {
          kind: 'vault',
          path: 'Notes/CommentOnly.md',
          hash: 'hash-comment-only',
          ranges: [[1, 1]],
          complete: true,
        }, {
          kind: 'vault',
          path: 'Notes/ProcessingOnly.md',
          hash: 'hash-processing-only',
          ranges: [[1, 1]],
          complete: true,
        }, {
          kind: 'vault',
          path: 'Notes/DeclarationOnly.md',
          hash: 'hash-declaration-only',
          ranges: [[1, 1]],
          complete: true,
        }, {
          kind: 'vault',
          path: 'Notes/CdataOnly.md',
          hash: 'hash-cdata-only',
          ranges: [[1, 1]],
          complete: true,
        }, {
          kind: 'vault',
          path: 'Notes/StitchedOnly.md',
          hash: 'hash-stitched-only',
          ranges: [[1, 1]],
          complete: true,
        }, {
          kind: 'vault',
          path: 'Notes/LinkOnly.md',
          hash: 'hash-link-only',
          ranges: [[1, 1]],
          complete: true,
        }, {
          kind: 'vault',
          path: 'Notes/HtmlOnly.md',
          hash: 'hash-html-only',
          ranges: [[1, 1]],
          complete: true,
        }, {
          kind: 'vault',
          path: 'Notes/AppendixOnly.md',
          hash: 'hash-appendix-only',
          ranges: [[1, 1]],
          complete: true,
        }, {
          kind: 'web',
          id: 'web_1',
          title: 'Verified external page',
          url: 'https://example.test/verified',
          publishedAt: '2026-09-06',
        }],
        ledger: {
          searches: [{ tool: 'search_knowledge', paths: ['Notes/Read.md', 'Notes/Unread.md'] }],
          reads: [{
            path: 'Notes/Read.md', hash: 'hash-read', ranges: [[1, 4]], complete: true,
          }],
          uncovered: [
            { path: 'Notes/Unread.md', reason: 'not_read' },
            {
              sourceId: 'web_2',
              url: 'https://evil.test/unread',
              reason: 'web_source_not_read',
            },
          ],
        },
        metrics: { engine: 'pi-agent', toolCalls: 2, modelTurns: 3 },
        visibleTextStreamed: false,
      };
    },
    async runDraft(input) {
      piCalls.draft.push(input);
      assert.fail('QA must not enter Pi draft generation');
    },
  };
  const store = {
    ready: Promise.resolve(),
    cleanupDrafts: async () => {},
  };
  const manager = new TaskManager(managerConfig(project), {
    index: index.index,
    store,
    llm: llm.llm,
    conversations,
    piAgent,
  });
  t.after(async () => {
    await manager.close();
    await project.cleanup();
  });
  await manager.ready;

  const created = await manager.createTask('admin', {
    kind: 'qa',
    prompt: '请根据原文回答，并区分未读取的引用。',
    model: 'pi-fixture',
    attachments: [{
      name: 'context.txt',
      type: 'text/plain',
      data: Buffer.from('附件中的补充上下文', 'utf8').toString('base64'),
    }],
  });
  const task = manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(piCalls.qa.length, 1);
  assert.equal(piCalls.draft.length, 0);
  assert.deepEqual(piCalls.supports, [llm.llm]);
  assert.equal(llm.calls.generate, 0);
  assert.equal(llm.calls.bindings, 0, 'The injected agent owns binding consumption');
  assert.equal(index.calls.acquired, 1);
  assert.equal(index.calls.released, 1);
  assert.deepEqual(task.agentMetrics, { engine: 'pi-agent', toolCalls: 2, modelTurns: 3 });

  const conversation = conversations.get('admin', created.conversationId);
  const answer = conversation.messages.at(-1).content;
  assert.match(answer, /已经读取原文 <code class="knowledge-verified-vault-path">Notes&#47;Read&#46;md<\/code>/u);
  assert.match(answer, /<code class="knowledge-verified-vault-path">Notes&#47;A  B &#38; C&#46;md<\/code>/u);
  assert.match(answer, /未实际读取 \[未核验知识库来源\]/u);
  assert.match(answer, /### 阅读覆盖/u);
  assert(answer.includes('` Notes/Unread.md `：` not_read `'),
    'the server-generated coverage disclosure may name an unread relative path');
  assert(answer.includes('` web_2 `：` web_source_not_read `'));
  assert.doesNotMatch(answer, /\[\[Notes\/Unread\.md\]\]/u);
  assert.match(answer, /https:\/\/example\.test\/verified/u);
  assert.doesNotMatch(answer, /evil\.test/u);
  assert.doesNotMatch(answer, /javascript:|&#104;ttps|evil-ref/u);
  assert.match(answer, /### 联网来源/u);
  assert.equal(conversation.piSessionFile, 'pi-qa-session.jsonl');
  assert.deepEqual(
    conversation.researchContext.citedSources
      .filter((source) => source.kind === 'vault').map((source) => source.path),
    ['Notes/Read.md', 'Notes/A  B & C.md'],
  );
  assert.deepEqual(
    conversation.researchContext.citedSources
      .filter((source) => source.kind === 'web').map((source) => source.url),
    ['https://example.test/verified'],
  );
  assert(task.events.some((event) => (
    event.type === 'activity' && event.data.toolName === 'read_note'
  )));
  assert(task.events.some((event) => (
    event.type === 'activity' && event.data.toolName === 'pi_coverage' &&
    event.data.diagnostics.uncoveredCount === 2
  )));
  assert.deepEqual(
    task.events.find((event) => event.type === 'text')?.data.verifiedExternalUrls,
    ['https://example.test/verified'],
  );

  const restored = new ConversationStore(project.config.conversationFile);
  await restored.ready;
  assert.equal(
    restored.get('admin', created.conversationId).piSessionFile,
    'pi-qa-session.jsonl',
  );
  assert.deepEqual(
    restored.get('admin', created.conversationId).messages.at(-1).verifiedExternalUrls,
    ['https://example.test/verified'],
  );
});

test('Pi-capable draft uses the no-tool agent path, stays preview-only, then confirms through VaultStore', async (t) => {
  const project = await temporaryProject('second-mind-pi-task-draft-');
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = indexFixture();
  const llm = piCapableLlm();
  const store = new VaultStore(project.config);
  const piCalls = { supports: [], qa: [], draft: [] };
  const generatedMarkdown = '# 2026-09-06\n\n## 今日记录\n\n通过 Pi 生成，等待用户确认。\n';
  const piAgent = {
    supports(client) {
      piCalls.supports.push(client);
      return typeof client?.piBinding === 'function';
    },
    async runQa(input) {
      piCalls.qa.push(input);
      assert.fail('Draft must not enter Pi QA tools');
    },
    async runDraft(input) {
      piCalls.draft.push(input);
      assert.equal(input.task.kind, 'diary');
      assert.equal(Object.hasOwn(input, 'indexSnapshot'), false);
      assert.match(input.prompt, /<user_input>[\s\S]*记录今天的重构进展[\s\S]*<\/user_input>/u);
      return {
        answer: generatedMarkdown,
        sessionFile: 'pi-draft-session.jsonl',
        ledger: { searches: [], reads: [], uncovered: [] },
        sources: [],
        metrics: { engine: 'pi-agent', toolCalls: 0, modelTurns: 1 },
      };
    },
  };
  const manager = new TaskManager(managerConfig(project), {
    index: index.index,
    store,
    llm: llm.llm,
    conversations,
    piAgent,
  });
  t.after(async () => {
    await manager.close();
    await project.cleanup();
  });
  await manager.ready;

  const target = path.join(project.vaultPath, project.config.paths.diary, '2026-09-06.md');
  assert.equal(await fsp.stat(target).then(() => true, () => false), false);
  const created = await manager.createTask('admin', {
    kind: 'diary',
    date: '2026-09-06',
    prompt: '记录今天的重构进展',
    model: 'pi-fixture',
  });
  const task = manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'completed');
  assert.equal(piCalls.qa.length, 0);
  assert.equal(piCalls.draft.length, 1);
  assert.deepEqual(piCalls.supports, [llm.llm]);
  assert.equal(llm.calls.generate, 0);
  assert.equal(task.agentMetrics.toolCalls, 0);
  assert.equal(index.calls.acquired, 1);
  assert.equal(index.calls.released, 1);
  assert.equal(await fsp.stat(target).then(() => true, () => false), false,
    'Pi generation may create only an external preview draft');

  const previewEvent = task.events.find((event) => event.type === 'draft_ready');
  assert(previewEvent, 'Existing draft_ready preview event must be emitted');
  assert.equal(previewEvent.data.id, task.draftId);
  assert.equal(previewEvent.data.targetPath, `${project.config.paths.diary}/2026-09-06.md`);
  assert.equal(previewEvent.data.content, generatedMarkdown);
  assert.equal((await store.getDraft('admin', task.draftId)).content, generatedMarkdown);
  assert.equal(
    conversations.get('admin', created.conversationId).piSessionFile,
    'pi-draft-session.jsonl',
  );

  const confirmed = await store.saveDraft('admin', task.draftId, {
    content: previewEvent.data.content,
  });
  assert.equal(confirmed.path, `${project.config.paths.diary}/2026-09-06.md`);
  assert.equal(await fsp.readFile(target, 'utf8'), generatedMarkdown);
});

test('production fails closed when a selected client cannot bind to Pi', async (t) => {
  const project = await temporaryProject('second-mind-pi-required-');
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = indexFixture();
  let legacyCalls = 0;
  const manager = new TaskManager(managerConfig(project), {
    index: index.index,
    store: { ready: Promise.resolve(), cleanupDrafts: async () => {} },
    llm: {
      async generate() {
        legacyCalls += 1;
        return 'legacy output must never be used';
      },
    },
    conversations,
    piAgent: { supports: () => false },
  });
  t.after(async () => {
    await manager.close();
    await project.cleanup();
  });

  const created = await manager.createTask('admin', {
    kind: 'qa', prompt: 'This must use Pi.', model: 'pi-fixture',
  });
  const task = manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'failed');
  assert.equal(legacyCalls, 0);
  assert(task.events.some((event) => (
    event.type === 'task_error' && event.data.code === 'PI_AGENT_REQUIRED'
  )));
  assert.equal(conversations.get('admin', created.conversationId).messages.length, 1,
    'a failed engine admission must not invent an assistant message');
});

test('failed Pi execution publishes its bounded Agent metrics in terminal state', async (t) => {
  const project = await temporaryProject('second-mind-pi-failure-metrics-');
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = indexFixture();
  const llm = piCapableLlm();
  const metrics = Object.freeze({
    engine: 'pi-agent',
    piVersion: '0.85.1',
    modelTurns: 12,
    toolCalls: 17,
    limits: { maxAgentTurns: 12, maxAgentToolCalls: 16 },
    coverage: { complete: false, uncovered: [{ reason: 'tool_budget' }] },
  });
  const manager = new TaskManager(managerConfig(project), {
    index: index.index,
    store: { ready: Promise.resolve(), cleanupDrafts: async () => {} },
    llm: llm.llm,
    conversations,
    piAgent: {
      supports: () => true,
      async runQa({ task: piTask }) {
        piTask.agentMetrics = metrics;
        throw Object.assign(new Error('bounded fixture failure'), { code: 'PI_AGENT_TOOL_LIMIT' });
      },
    },
  });
  t.after(async () => {
    await manager.close();
    await project.cleanup();
  });

  const created = await manager.createTask('admin', {
    kind: 'qa', prompt: 'Exercise failed Pi metrics.', model: 'pi-fixture',
  });
  const task = manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'failed');
  assert.strictEqual(task.agentMetrics, metrics);
  const terminal = task.events.findLast((event) => event.type === 'done');
  assert.equal(terminal.data.status, 'failed');
  assert.deepEqual(terminal.data.agent, metrics);
  assert(task.events.some((event) => (
    event.type === 'task_error' && event.data.code === 'PI_AGENT_TOOL_LIMIT'
  )));
  assert.equal(conversations.get('admin', created.conversationId).messages.length, 1);
});

test('failed product commit discards the finalized Pi checkpoint', async (t) => {
  const project = await temporaryProject('second-mind-pi-transaction-');
  const conversations = new ConversationStore(project.config.conversationFile);
  const index = indexFixture();
  const llm = piCapableLlm();
  const removed = [];
  const finalized = [];
  const piAgent = {
    supports: () => true,
    async runQa() {
      return {
        answer: 'A bounded answer with no Vault claim.',
        sessionFile: 'working-session.jsonl',
        previousSessionFile: '',
        sources: [],
        ledger: { reads: [], searches: [], uncovered: [] },
        metrics: { engine: 'pi-agent' },
      };
    },
    async finalizeSession(input) {
      finalized.push(input);
      removed.push(input.workingSessionFile);
      return 'canonical-session.jsonl';
    },
    async removeSessionFile(filename) { removed.push(filename); },
  };
  const originalCommit = conversations.commitExisting.bind(conversations);
  let rejectResultCommit = false;
  conversations.commitExisting = async (...args) => {
    if (rejectResultCommit) throw new Error('fixture persistence failure');
    return originalCommit(...args);
  };
  const manager = new TaskManager(managerConfig(project), {
    index: index.index,
    store: { ready: Promise.resolve(), cleanupDrafts: async () => {} },
    llm: llm.llm,
    conversations,
    piAgent,
  });
  t.after(async () => {
    await manager.close();
    await project.cleanup();
  });

  rejectResultCommit = true;
  const created = await manager.createTask('admin', {
    kind: 'qa', prompt: 'Exercise transactional persistence.', model: 'pi-fixture',
  });
  const task = manager.getTask('admin', created.taskId);
  await task.runPromise;

  assert.equal(task.status, 'failed');
  assert.equal(finalized.length, 1);
  assert(removed.includes('working-session.jsonl'));
  assert(removed.includes('canonical-session.jsonl'));
  const persisted = conversations.get('admin', created.conversationId);
  assert.equal(persisted.piSessionFile, undefined);
  assert.equal(persisted.messages.length, 1);
});
