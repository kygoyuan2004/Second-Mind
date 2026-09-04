import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KnowledgeBaseRegistry } from '../src/knowledge-base-registry.mjs';
import { createApp } from '../src/server.mjs';
import { temporaryProject } from './helpers.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_PASSWORD = 'correct horse battery staple';

function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function publicConversation(value) {
  return {
    id: value.id,
    kind: value.kind,
    title: value.title,
    messages: structuredClone(value.messages),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function createContextFactory() {
  const currentContexts = new Map();
  let taskSequence = 0;

  const factory = async (entry) => {
    const noteNames = (await fsp.readdir(entry.rootPath)).filter((name) => name.endsWith('.md'));
    const notes = await Promise.all(noteNames.map(async (name) => ({
      path: name,
      title: path.basename(name, '.md'),
      content: await fsp.readFile(path.join(entry.rootPath, name), 'utf8'),
    })));
    const now = '2026-09-05T00:00:00.000Z';
    const conversations = new Map([[`conversation-${entry.knowledgeBaseId}`, {
      id: `conversation-${entry.knowledgeBaseId}`,
      userId: 'admin',
      kind: 'qa',
      title: `${entry.name} conversation`,
      messages: [{ role: 'assistant', content: `Only ${entry.knowledgeBaseId}` }],
      createdAt: now,
      updatedAt: now,
    }]]);
    const drafts = new Map([[`draft-${entry.knowledgeBaseId}`, {
      id: `draft-${entry.knowledgeBaseId}`,
      kind: 'scratch',
      title: `${entry.name} draft`,
      targetPath: `Inbox/${entry.knowledgeBaseId}.md`,
      content: `# ${entry.name}`,
      attachments: [],
      createdAt: now,
      expiresAt: '2099-01-01T00:00:00.000Z',
    }]]);
    const tasks = new Map();
    const index = {
      status: () => ({
        available: true,
        lexicalAvailable: true,
        semanticAvailable: false,
        files: notes.length,
        chunks: notes.length,
        embeddedChunks: 0,
        generation: entry.revision,
        embedding: { provider: 'disabled', model: null, dimensions: null },
      }),
      async search(query, options = {}) {
        const needle = String(query || '').trim().toLocaleLowerCase();
        return {
          route: options.route || 'keyword',
          results: notes.filter((note) => (
            !needle || `${note.title}\n${note.content}`.toLocaleLowerCase().includes(needle)
          )).map((note, position) => ({
            path: note.path,
            title: note.title,
            score: 1 - position / 10,
            content: note.content,
            vector: [1, 2, 3],
            tokens: 12,
          })),
        };
      },
    };
    const store = {
      ready: Promise.resolve(),
      async getDraft(userId, id) {
        const draft = drafts.get(String(id));
        if (!draft || userId !== 'admin') {
          throw apiError(404, 'DRAFT_NOT_FOUND', 'Draft was not found.');
        }
        return structuredClone(draft);
      },
      async deleteDraft(userId, id) {
        await this.getDraft(userId, id);
        drafts.delete(String(id));
        return { ok: true, warnings: [] };
      },
      async saveDraft(userId, id, changes = {}) {
        const draft = await this.getDraft(userId, id);
        draft.content = String(changes.content ?? draft.content);
        drafts.set(String(id), draft);
        return { ok: true, path: draft.targetPath, warnings: [] };
      },
    };
    const conversationStore = { ready: Promise.resolve() };
    const manager = {
      ready: Promise.resolve(),
      tasks,
      async publicStatus(userId) {
        const active = [...tasks.values()].find((taskValue) => (
          taskValue.userId === userId && !['completed', 'failed', 'cancelled'].includes(taskValue.status)
        ));
        return {
          appName: 'Second Mind Test',
          vaultLabel: entry.name,
          rootLabel: entry.name,
          llm: { provider: 'fake', model: 'fixture-model', configured: true },
          retrieval: index.status(),
          activeTask: active ? this.publicTask(active) : null,
          taskModes: [{ id: 'normal', label: 'Normal' }],
        };
      },
      listConversations(userId) {
        return [...conversations.values()]
          .filter((value) => value.userId === userId)
          .map(publicConversation);
      },
      getConversation(userId, id) {
        const value = conversations.get(String(id));
        if (!value || value.userId !== userId) {
          throw apiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation was not found.');
        }
        return publicConversation(value);
      },
      async deleteConversation(userId, id) {
        this.getConversation(userId, id);
        conversations.delete(String(id));
        return { ok: true };
      },
      async clearConversations(userId) {
        for (const [id, value] of conversations) {
          if (value.userId === userId) conversations.delete(id);
        }
        return { ok: true };
      },
      async createTask(userId, body = {}) {
        const referenced = String(body.conversationId || body.forkFromConversationId || '');
        if (referenced) this.getConversation(userId, referenced);
        taskSequence += 1;
        const conversationId = referenced || `conversation-${entry.knowledgeBaseId}-${taskSequence}`;
        if (!referenced) {
          conversations.set(conversationId, {
            id: conversationId,
            userId,
            kind: body.kind || 'qa',
            title: String(body.prompt || 'New conversation'),
            messages: [{ role: 'user', content: String(body.prompt || '') }],
            createdAt: now,
            updatedAt: now,
          });
        }
        const taskValue = {
          id: `task-${entry.knowledgeBaseId}-${taskSequence}`,
          userId,
          conversationId,
          kind: body.kind || 'qa',
          status: 'running',
          knowledgeBaseId: entry.knowledgeBaseId,
          knowledgeBaseRevision: entry.revision,
          createdAt: now,
          updatedAt: now,
        };
        tasks.set(taskValue.id, taskValue);
        return {
          taskId: taskValue.id,
          conversationId,
          status: taskValue.status,
        };
      },
      getTask(userId, id) {
        const taskValue = tasks.get(String(id));
        if (!taskValue || taskValue.userId !== userId) {
          throw apiError(404, 'TASK_NOT_FOUND', 'Task was not found.');
        }
        return taskValue;
      },
      publicTask(taskValue) {
        return {
          id: taskValue.id,
          conversationId: taskValue.conversationId,
          kind: taskValue.kind,
          status: taskValue.status,
          knowledgeBaseId: taskValue.knowledgeBaseId,
          knowledgeBaseRevision: taskValue.knowledgeBaseRevision,
          createdAt: taskValue.createdAt,
          updatedAt: taskValue.updatedAt,
        };
      },
      cancel(userId, id) {
        const taskValue = this.getTask(userId, id);
        taskValue.status = 'cancelled';
        return { ok: true, status: 'cancelled' };
      },
      async close() {
        for (const taskValue of tasks.values()) taskValue.status = 'cancelled';
      },
    };
    const context = {
      knowledgeBaseId: entry.knowledgeBaseId,
      knowledgeBaseRevision: entry.revision,
      name: entry.name,
      index,
      store,
      conversations: conversationStore,
      manager,
      close: () => manager.close(),
    };
    currentContexts.set(entry.knowledgeBaseId, context);
    return context;
  };

  factory.currentContexts = currentContexts;
  return factory;
}

function appConfig(project, alphaPath) {
  return {
    ...project.config,
    projectRoot,
    appName: 'Second Mind Test',
    vaultLabel: 'Example Alpha',
    vaultPath: alphaPath,
    publicDir: path.join(projectRoot, 'public'),
    host: '127.0.0.1',
    port: 0,
    timezone: 'UTC',
    trustProxy: false,
    auth: {
      username: 'admin',
      password: ADMIN_PASSWORD,
      sessionSecret: 'TEST_ONLY_NOT_A_REAL_SESSION_SECRET',
      sessionTtlSeconds: 3600,
      secureCookie: false,
    },
    llm: {
      provider: 'openai-compatible',
      apiBase: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'fixture-model',
      timeoutMs: 1_000,
      maxOutputTokens: 100,
      temperature: 0,
      allowInsecureHttp: false,
    },
    embedding: {
      provider: 'disabled',
      apiBase: '',
      endpoint: '',
      apiKey: '',
      model: '',
      dimensions: 3,
      batchSize: 2,
      timeoutMs: 1_000,
      allowInsecureHttp: false,
    },
    retrieval: { topK: 8, maxContextChars: 10_000, watch: false, reconcileIntervalMs: 60_000 },
    sync: { provider: 'filesystem', displayName: 'Test filesystem' },
  };
}

function registryEntries() {
  return [
    {
      knowledgeBaseId: 'alpha',
      name: 'Example Alpha',
      mountId: 'vaults',
      relativePath: 'alpha',
      enabled: true,
      default: true,
    },
    {
      knowledgeBaseId: 'beta',
      name: 'Example Beta',
      mountId: 'vaults',
      relativePath: 'beta',
      enabled: true,
      default: false,
    },
  ];
}

async function fixture() {
  const project = await temporaryProject('second-mind-multikb-http-');
  const mounts = path.join(project.root, 'vaults');
  const alpha = path.join(mounts, 'alpha');
  const beta = path.join(mounts, 'beta');
  const state = path.join(project.root, 'private-state');
  await Promise.all([
    fsp.mkdir(path.join(alpha, '.obsidian'), { recursive: true }),
    fsp.mkdir(path.join(beta, '.obsidian'), { recursive: true }),
    fsp.mkdir(state, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(alpha, 'Alpha-only.md'), '# Alpha\n\nsharedterm alpha-secret-marker\n'),
    fsp.writeFile(path.join(beta, 'Beta-only.md'), '# Beta\n\nsharedterm beta-secret-marker\n'),
  ]);
  const registry = new KnowledgeBaseRegistry({
    managedFile: path.join(state, 'knowledge-bases.json'),
    stateDir: state,
    allowedRoots: [{ id: 'vaults', label: 'Configured Vaults', path: mounts }],
    privateStatePaths: [state],
    legacy: {
      knowledgeBaseId: 'default',
      name: 'Legacy test Vault',
      vaultPath: alpha,
      dataDir: project.dataDir,
      indexDir: project.config.indexDir,
      draftDir: project.config.draftDir,
      recoveryDir: project.config.recoveryDir,
      conversationFile: project.config.conversationFile,
      auditFile: project.config.auditFile,
    },
  });
  const initial = await registry.ready;
  await registry.update({
    expectedRevision: initial.revision,
    knowledgeBases: registryEntries(),
  });
  const contextFactory = createContextFactory();
  const app = await createApp(appConfig(project, alpha), {
    knowledgeBaseRegistry: registry,
    knowledgeBaseContextFactory: contextFactory,
  });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  return {
    project,
    registry,
    contextFactory,
    app,
    mounts,
    alpha,
    beta,
    state,
    base: `http://127.0.0.1:${address.port}`,
    async cleanup() {
      await app.knowledgeBaseHub.close();
      await new Promise((resolve) => app.server.close(resolve));
      await project.cleanup();
    },
  };
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

async function login(base) {
  const result = await requestJson(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie');
}

function writeHeaders(cookie) {
  return { cookie, 'content-type': 'application/json', 'x-vaultmind-request': '1' };
}

function editableEntries(snapshot) {
  return snapshot.knowledgeBases.map((entry) => ({
    knowledgeBaseId: entry.knowledgeBaseId,
    name: entry.name,
    mountId: entry.mountId,
    relativePath: entry.relativePath,
    enabled: entry.enabled,
    default: entry.default,
  }));
}

function assertNoAbsolutePaths(value, fixtureValue) {
  const serialized = JSON.stringify(value);
  for (const privatePath of [
    fixtureValue.project.root,
    fixtureValue.mounts,
    fixtureValue.alpha,
    fixtureValue.beta,
    fixtureValue.state,
  ]) {
    assert.equal(serialized.includes(privatePath), false, `response disclosed ${privatePath}`);
  }
  assert.doesNotMatch(serialized, /"(?:rootPath|vaultPath|dataDir|indexDir|draftDir|recoveryDir|conversationFile|auditFile)"\s*:/u);
  assert.doesNotMatch(serialized, /(?:\/home\/|\/tmp\/|[A-Za-z]:[\\/](?:Users|Temp)[\\/])/u);
}

test('authenticated HTTP routing isolates searches and identifiers across two knowledge bases', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());

  const anonymous = await requestJson(value.base, '/api/knowledge/bases');
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.body.error, 'AUTH_REQUIRED');

  const cookie = await login(value.base);
  const readHeaders = { cookie };
  const bases = await requestJson(value.base, '/api/knowledge/bases', { headers: readHeaders });
  assert.equal(bases.response.status, 200);
  assert.equal(bases.body.defaultKnowledgeBaseId, 'alpha');
  assert.deepEqual(bases.body.knowledgeBases.map((entry) => entry.knowledgeBaseId), ['alpha', 'beta']);
  assertNoAbsolutePaths(bases.body, value);

  const defaultStatus = await requestJson(value.base, '/api/knowledge/status', { headers: readHeaders });
  assert.equal(defaultStatus.body.knowledgeBaseId, 'alpha');
  const betaStatus = await requestJson(
    value.base,
    '/api/knowledge/status?knowledgeBaseId=beta',
    { headers: readHeaders },
  );
  assert.equal(betaStatus.response.status, 200);
  assert.equal(betaStatus.body.knowledgeBaseId, 'beta');
  assert.equal(betaStatus.body.knowledgeBaseName, 'Example Beta');
  assertNoAbsolutePaths(betaStatus.body, value);

  const alphaSearch = await requestJson(
    value.base,
    '/api/knowledge/search?knowledgeBaseId=alpha&q=sharedterm&mode=keyword',
    { headers: readHeaders },
  );
  const betaSearch = await requestJson(
    value.base,
    '/api/knowledge/search?knowledgeBaseId=beta&q=sharedterm&mode=keyword',
    { headers: readHeaders },
  );
  assert.equal(alphaSearch.response.status, 200);
  assert.equal(betaSearch.response.status, 200);
  assert.deepEqual(alphaSearch.body.results.map((entry) => entry.path), ['Alpha-only.md']);
  assert.deepEqual(betaSearch.body.results.map((entry) => entry.path), ['Beta-only.md']);
  assert.equal(JSON.stringify(alphaSearch.body).includes('beta-secret-marker'), false);
  assert.equal(JSON.stringify(betaSearch.body).includes('alpha-secret-marker'), false);
  assert.equal('content' in alphaSearch.body.results[0], false);
  assert.equal('vector' in alphaSearch.body.results[0], false);
  assertNoAbsolutePaths(alphaSearch.body, value);
  assertNoAbsolutePaths(betaSearch.body, value);

  const alphaConversation = await requestJson(
    value.base,
    '/api/knowledge/conversations/conversation-alpha?knowledgeBaseId=alpha',
    { headers: readHeaders },
  );
  assert.equal(alphaConversation.response.status, 200);
  assert.equal(alphaConversation.body.knowledgeBaseId, 'alpha');
  const crossedConversation = await requestJson(
    value.base,
    '/api/knowledge/conversations/conversation-alpha?knowledgeBaseId=beta',
    { headers: readHeaders },
  );
  assert.equal(crossedConversation.response.status, 404);
  assert.equal(crossedConversation.body.error, 'CONVERSATION_NOT_FOUND');
  const crossedConversationDelete = await requestJson(
    value.base,
    '/api/knowledge/conversations/conversation-alpha?knowledgeBaseId=beta',
    { method: 'DELETE', headers: writeHeaders(cookie) },
  );
  assert.equal(crossedConversationDelete.response.status, 404);
  assert.equal(crossedConversationDelete.body.error, 'CONVERSATION_NOT_FOUND');

  const alphaDraft = await requestJson(
    value.base,
    '/api/knowledge/drafts/draft-alpha?knowledgeBaseId=alpha',
    { headers: readHeaders },
  );
  assert.equal(alphaDraft.response.status, 200);
  assert.equal(alphaDraft.body.knowledgeBaseId, 'alpha');
  const crossedDraft = await requestJson(
    value.base,
    '/api/knowledge/drafts/draft-alpha?knowledgeBaseId=beta',
    { headers: readHeaders },
  );
  assert.equal(crossedDraft.response.status, 404);
  assert.equal(crossedDraft.body.error, 'DRAFT_NOT_FOUND');
  const crossedDraftSave = await requestJson(
    value.base,
    '/api/knowledge/drafts/draft-alpha/save?knowledgeBaseId=beta',
    {
      method: 'POST',
      headers: writeHeaders(cookie),
      body: JSON.stringify({ content: '# Cross-base write must fail' }),
    },
  );
  assert.equal(crossedDraftSave.response.status, 404);
  assert.equal(crossedDraftSave.body.error, 'DRAFT_NOT_FOUND');
  const crossedDraftDelete = await requestJson(
    value.base,
    '/api/knowledge/drafts/draft-alpha?knowledgeBaseId=beta',
    { method: 'DELETE', headers: writeHeaders(cookie) },
  );
  assert.equal(crossedDraftDelete.response.status, 404);
  assert.equal(crossedDraftDelete.body.error, 'DRAFT_NOT_FOUND');

  const task = await requestJson(value.base, '/api/knowledge/tasks?knowledgeBaseId=alpha', {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({ kind: 'qa', prompt: 'Keep this task active.' }),
  });
  assert.equal(task.response.status, 201);
  assert.equal(task.body.knowledgeBaseId, 'alpha');
  assert.ok(task.body.knowledgeBaseRevision);

  const selectedTask = await requestJson(
    value.base,
    `/api/knowledge/tasks/${task.body.taskId}?knowledgeBaseId=alpha`,
    { headers: readHeaders },
  );
  assert.equal(selectedTask.response.status, 200);
  assert.equal(selectedTask.body.knowledgeBaseId, 'alpha');
  const crossedTask = await requestJson(
    value.base,
    `/api/knowledge/tasks/${task.body.taskId}?knowledgeBaseId=beta`,
    { headers: readHeaders },
  );
  assert.equal(crossedTask.response.status, 404);
  assert.equal(crossedTask.body.error, 'TASK_NOT_FOUND');
  const crossedCancel = await requestJson(
    value.base,
    `/api/knowledge/tasks/${task.body.taskId}/cancel?knowledgeBaseId=beta`,
    { method: 'POST', headers: writeHeaders(cookie) },
  );
  assert.equal(crossedCancel.response.status, 404);
  assert.equal(crossedCancel.body.error, 'TASK_NOT_FOUND');

  const crossedContinuation = await requestJson(value.base, '/api/knowledge/tasks', {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      knowledgeBaseId: 'beta',
      kind: 'qa',
      prompt: 'Continue the Alpha conversation in Beta.',
      conversationId: task.body.conversationId,
    }),
  });
  assert.equal(crossedContinuation.response.status, 404);
  assert.equal(crossedContinuation.body.error, 'CONVERSATION_NOT_FOUND');

  const alphaActive = await requestJson(
    value.base,
    '/api/knowledge/status?knowledgeBaseId=alpha',
    { headers: readHeaders },
  );
  const betaWhileAlphaRuns = await requestJson(
    value.base,
    '/api/knowledge/status?knowledgeBaseId=beta',
    { headers: readHeaders },
  );
  assert.equal(alphaActive.body.activeTask.id, task.body.taskId);
  assert.equal(alphaActive.body.activeTask.knowledgeBaseId, 'alpha');
  assert.equal(betaWhileAlphaRuns.response.status, 200);
  assert.equal(betaWhileAlphaRuns.body.knowledgeBaseId, 'beta');
  assert.equal(betaWhileAlphaRuns.body.activeTask, null);

  const conflict = await requestJson(
    value.base,
    '/api/knowledge/tasks?knowledgeBaseId=alpha',
    {
      method: 'POST',
      headers: writeHeaders(cookie),
      body: JSON.stringify({ knowledgeBaseId: 'beta', kind: 'qa', prompt: 'Conflicting selector.' }),
    },
  );
  assert.equal(conflict.response.status, 400);
  assert.equal(conflict.body.error, 'KNOWLEDGE_BASE_SELECTION_CONFLICT');

  for (const responseBody of [
    crossedConversation.body,
    crossedConversationDelete.body,
    crossedDraft.body,
    crossedDraftSave.body,
    crossedDraftDelete.body,
    crossedTask.body,
    crossedCancel.body,
    crossedContinuation.body,
    conflict.body,
  ]) assertNoAbsolutePaths(responseBody, value);
});

test('admin knowledge-base API enforces CAS and rejects nested and symlink targets without disclosure', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const cookie = await login(value.base);

  const administrative = await requestJson(value.base, '/api/admin/knowledge-bases', {
    headers: { cookie },
  });
  assert.equal(administrative.response.status, 200);
  assert.deepEqual(administrative.body.allowedMounts, [{ id: 'vaults', label: 'Configured Vaults' }]);
  assert.deepEqual(administrative.body.knowledgeBases.map((entry) => ({
    id: entry.knowledgeBaseId,
    mountId: entry.mountId,
    relativePath: entry.relativePath,
    pathAvailable: entry.pathAvailable,
  })), [
    { id: 'alpha', mountId: 'vaults', relativePath: 'alpha', pathAvailable: true },
    { id: 'beta', mountId: 'vaults', relativePath: 'beta', pathAvailable: true },
  ]);
  assertNoAbsolutePaths(administrative.body, value);

  const entries = editableEntries(administrative.body);
  const wrongPassword = await requestJson(value.base, '/api/admin/knowledge-bases', {
    method: 'PUT',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      adminPassword: 'incorrect administrator password',
      expectedRevision: administrative.body.revision,
      knowledgeBases: entries,
    }),
  });
  assert.equal(wrongPassword.response.status, 401);
  assert.equal(wrongPassword.body.error, 'INVALID_CREDENTIALS');

  const stale = await requestJson(value.base, '/api/admin/knowledge-bases', {
    method: 'PUT',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      adminPassword: ADMIN_PASSWORD,
      expectedRevision: 'stale-client-revision',
      knowledgeBases: entries,
    }),
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error, 'KNOWLEDGE_BASE_REVISION_CONFLICT');
  assertNoAbsolutePaths(stale.body, value);

  const absolute = await requestJson(value.base, '/api/admin/knowledge-bases', {
    method: 'PUT',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      adminPassword: ADMIN_PASSWORD,
      expectedRevision: administrative.body.revision,
      knowledgeBases: entries.map((entry) => (
        entry.knowledgeBaseId === 'beta' ? { ...entry, relativePath: '/untrusted/absolute/path' } : entry
      )),
    }),
  });
  assert.equal(absolute.response.status, 400);
  assert.equal(absolute.body.error, 'KNOWLEDGE_BASE_PATH_OUTSIDE_MOUNT');
  assertNoAbsolutePaths(absolute.body, value);

  await fsp.mkdir(path.join(value.mounts, 'ordinary-directory'));
  const ordinary = await requestJson(value.base, '/api/admin/knowledge-bases', {
    method: 'PUT',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      adminPassword: ADMIN_PASSWORD,
      expectedRevision: administrative.body.revision,
      knowledgeBases: entries.map((entry) => (
        entry.knowledgeBaseId === 'beta'
          ? { ...entry, relativePath: 'ordinary-directory' }
          : entry
      )),
    }),
  });
  assert.equal(ordinary.response.status, 400);
  assert.equal(ordinary.body.error, 'KNOWLEDGE_BASE_LAYOUT_INVALID');
  assertNoAbsolutePaths(ordinary.body, value);

  await fsp.mkdir(path.join(value.alpha, 'nested'));
  const nestedEntries = entries.map((entry) => (
    entry.knowledgeBaseId === 'beta'
      ? { ...entry, relativePath: 'alpha/nested' }
      : entry
  ));
  const nested = await requestJson(value.base, '/api/admin/knowledge-bases', {
    method: 'PUT',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      adminPassword: ADMIN_PASSWORD,
      expectedRevision: administrative.body.revision,
      knowledgeBases: nestedEntries,
    }),
  });
  assert.equal(nested.response.status, 400);
  assert.equal(nested.body.error, 'NESTED_KNOWLEDGE_BASE_PATH');
  assertNoAbsolutePaths(nested.body, value);

  const linked = path.join(value.mounts, 'linked-beta');
  try {
    await fsp.symlink(value.beta, linked, 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.diagnostic('Skipping the symlink HTTP assertion: directory symlinks are not permitted.');
      return;
    }
    throw error;
  }
  const linkedEntries = entries.map((entry) => (
    entry.knowledgeBaseId === 'beta'
      ? { ...entry, relativePath: 'linked-beta' }
      : entry
  ));
  const symlink = await requestJson(value.base, '/api/admin/knowledge-bases', {
    method: 'PUT',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      adminPassword: ADMIN_PASSWORD,
      expectedRevision: administrative.body.revision,
      knowledgeBases: linkedEntries,
    }),
  });
  assert.equal(symlink.response.status, 400);
  assert.equal(symlink.body.error, 'KNOWLEDGE_BASE_PATH_SYMLINK');
  assertNoAbsolutePaths(symlink.body, value);

  await fsp.mkdir(path.join(value.mounts, 'gamma', '.obsidian'), { recursive: true });
  const reboundEntries = entries.map((entry) => (
    entry.knowledgeBaseId === 'beta'
      ? { ...entry, relativePath: 'gamma' }
      : entry
  ));
  const rebound = await requestJson(value.base, '/api/admin/knowledge-bases', {
    method: 'PUT',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      adminPassword: ADMIN_PASSWORD,
      expectedRevision: administrative.body.revision,
      knowledgeBases: reboundEntries,
    }),
  });
  assert.equal(rebound.response.status, 409);
  assert.equal(rebound.body.error, 'KNOWLEDGE_BASE_ID_REBIND_FORBIDDEN');
  assertNoAbsolutePaths(rebound.body, value);

  const renamedEntries = entries.map((entry) => (
    entry.knowledgeBaseId === 'beta' ? { ...entry, name: 'Example Beta Renamed' } : entry
  ));
  const renamed = await requestJson(value.base, '/api/admin/knowledge-bases', {
    method: 'PUT',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      adminPassword: ADMIN_PASSWORD,
      expectedRevision: administrative.body.revision,
      knowledgeBases: renamedEntries,
    }),
  });
  assert.equal(renamed.response.status, 200);
  assert.notEqual(renamed.body.revision, administrative.body.revision);
  assert.equal(
    renamed.body.knowledgeBases.find((entry) => entry.knowledgeBaseId === 'beta').name,
    'Example Beta Renamed',
  );
  assertNoAbsolutePaths(renamed.body, value);
  const refreshedBeta = await requestJson(
    value.base,
    '/api/knowledge/status?knowledgeBaseId=beta',
    { headers: { cookie } },
  );
  assert.equal(refreshedBeta.response.status, 200);
  assert.equal(refreshedBeta.body.knowledgeBaseName, 'Example Beta Renamed');

  const active = await requestJson(value.base, '/api/knowledge/tasks?knowledgeBaseId=alpha', {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({ kind: 'qa', prompt: 'Keep Alpha busy.' }),
  });
  assert.equal(active.response.status, 201);
  const busyEntries = editableEntries(renamed.body).map((entry) => (
    entry.knowledgeBaseId === 'alpha' ? { ...entry, name: 'Busy Alpha' } : entry
  ));
  const busy = await requestJson(value.base, '/api/admin/knowledge-bases', {
    method: 'PUT',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      adminPassword: ADMIN_PASSWORD,
      expectedRevision: renamed.body.revision,
      knowledgeBases: busyEntries,
    }),
  });
  assert.equal(busy.response.status, 409);
  assert.equal(busy.body.error, 'KNOWLEDGE_BASE_BUSY');
  assertNoAbsolutePaths(busy.body, value);
});
