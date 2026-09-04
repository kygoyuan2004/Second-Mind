import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { temporaryProject } from './helpers.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

class FakeLlm {
  publicStatus() { return { provider: 'fake', model: 'fixture-model', configured: true }; }

  async generate(messages, options = {}) {
    const system = messages.find((message) => message.role === 'system')?.content || '';
    const answer = system.includes('Create a diary entry')
      ? '# 2026-08-30\n\n## Today\n\nCompleted the integration test.\n'
      : 'RRF combines lexical and semantic ranks [[Learning/RAG.md]].';
    for (const part of [answer.slice(0, Math.ceil(answer.length / 2)), answer.slice(Math.ceil(answer.length / 2))]) {
      options.onToken?.(part);
    }
    return answer;
  }
}

class FakeDeepLlm extends FakeLlm {
  constructor() {
    super();
    this.calls = [];
  }

  async generate(messages, options = {}) {
    this.calls.push(messages);
    const system = messages.find((message) => message.role === 'system')?.content || '';
    if (system.includes('bounded search queries')) {
      return JSON.stringify({
        queries: ['RRF lexical ranking', 'semantic retrieval ranking'],
      });
    }
    return super.generate(messages, options);
  }
}

function appConfig(project) {
  return {
    ...project.config,
    projectRoot,
    appName: 'Second Mind Test',
    vaultLabel: 'Fixture Vault',
    publicDir: path.join(projectRoot, 'public'),
    host: '127.0.0.1',
    port: 0,
    timezone: 'UTC',
    trustProxy: false,
    auth: {
      username: 'admin',
      password: 'correct horse battery staple',
      sessionSecret: 'TEST_ONLY_NOT_A_REAL_SESSION_SECRET',
      sessionTtlSeconds: 3600,
      secureCookie: false,
    },
    llm: {
      provider: 'openai-compatible', apiBase: 'http://127.0.0.1:11434/v1', apiKey: '',
      model: 'fixture-model', timeoutMs: 1_000, maxOutputTokens: 100, temperature: 0,
      allowInsecureHttp: false,
    },
    embedding: {
      provider: 'disabled', apiBase: '', endpoint: '', apiKey: '', model: '', dimensions: 3,
      batchSize: 2, timeoutMs: 1_000, allowInsecureHttp: false,
    },
    retrieval: { topK: 8, maxContextChars: 10_000, watch: false, reconcileIntervalMs: 60_000 },
    sync: { provider: 'filesystem', displayName: 'Test filesystem' },
  };
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

function events(text) {
  return text.split(/\n\n+/).map((block) => {
    const type = block.match(/^event:\s*(.+)$/m)?.[1];
    const data = block.match(/^data:\s*(.+)$/m)?.[1];
    return type && data ? { type, data: JSON.parse(data) } : null;
  }).filter(Boolean);
}

test('authenticated API supports grounded Q&A and review-before-write diary flow', async (t) => {
  const project = await temporaryProject('vaultmind-server-');
  let app;
  t.after(async () => {
    if (app) {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  });
  await fsp.mkdir(path.join(project.vaultPath, 'Learning'), { recursive: true });
  await fsp.writeFile(
    path.join(project.vaultPath, 'Learning', 'RAG.md'),
    '# RAG\n\nRRF combines lexical and semantic ranked lists.\n',
  );
  await fsp.mkdir(path.join(project.vaultPath, '.obsidian'), { recursive: true });
  await fsp.writeFile(path.join(project.vaultPath, '.obsidian', 'private.json'), '{"token":"fixture"}');

  app = await createApp(appConfig(project), { llm: new FakeLlm() });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const live = await requestJson(base, '/health/live');
  assert.equal(live.response.status, 200);
  assert.equal(live.response.headers.get('x-content-type-options'), 'nosniff');
  const ready = await requestJson(base, '/health/ready');
  assert.equal(ready.response.status, 200);
  assert.deepEqual(ready.body.retrieval, { ready: true });
  assert.equal(Object.hasOwn(ready.body, 'knowledgeBases'), false);
  assert.equal(JSON.stringify(ready.body).includes('Fixture Vault'), false);

  const anonymous = await requestJson(base, '/api/session');
  assert.equal(anonymous.body.authenticated, false);
  const rejected = await requestJson(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  assert.equal(rejected.response.status, 403);

  const login = await requestJson(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie');
  const authHeaders = { cookie, 'x-vaultmind-request': '1', 'content-type': 'application/json' };

  const search = await requestJson(base, '/api/knowledge/search?q=RRF&mode=keyword', {
    headers: { cookie },
  });
  assert.equal(search.body.results[0].path, 'Learning/RAG.md');
  assert.equal('content' in search.body.results[0], false);
  const hidden = await requestJson(base, '/api/knowledge/file?path=.obsidian%2Fprivate.json', {
    headers: { cookie },
  });
  assert.equal(hidden.response.status, 403);

  const qa = await requestJson(base, '/api/knowledge/tasks', {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ kind: 'qa', prompt: 'How does RRF combine retrieval results?' }),
  });
  assert.equal(qa.response.status, 201);
  const qaStream = await fetch(`${base}/api/knowledge/tasks/${qa.body.taskId}/events`, { headers: { cookie } });
  const qaEvents = events(await qaStream.text());
  assert.ok(qaEvents.some((event) => event.type === 'activity'));
  assert.match(qaEvents.filter((event) => event.type === 'text').map((event) => event.data.text).join(''), /Learning\/RAG\.md/);
  assert.equal(qaEvents.at(-1).type, 'done');
  assert.equal(qaEvents.at(-1).data.status, 'completed');

  const diary = await requestJson(base, '/api/knowledge/tasks', {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ kind: 'diary', date: '2026-08-30', prompt: 'I completed the integration test.' }),
  });
  const diaryStream = await fetch(`${base}/api/knowledge/tasks/${diary.body.taskId}/events`, { headers: { cookie } });
  const diaryEvents = events(await diaryStream.text());
  const draft = diaryEvents.find((event) => event.type === 'draft_ready')?.data;
  assert.ok(draft?.id);
  const target = path.join(project.vaultPath, project.config.paths.diary, '2026-08-30.md');
  assert.equal(await fsp.stat(target).then(() => true, () => false), false);

  const saved = await requestJson(base, `/api/knowledge/drafts/${draft.id}/save`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ content: draft.content }),
  });
  assert.equal(saved.response.status, 200);
  assert.match(await fsp.readFile(target, 'utf8'), /integration test/);

  const logout = await requestJson(base, '/api/logout', {
    method: 'POST', headers: authHeaders, body: '{}',
  });
  assert.equal(logout.response.status, 200);
  const clearedCookie = logout.response.headers.get('set-cookie');
  assert.match(clearedCookie, /vaultmind_session=;/);
  const loggedOutSession = await requestJson(base, '/api/session', {
    headers: { cookie: clearedCookie },
  });
  assert.equal(loggedOutSession.body.authenticated, false);
});

test('authenticated legacy status never exposes raw index failure diagnostics', async (t) => {
  const project = await temporaryProject('vaultmind-index-status-');
  const privatePath = path.join(project.vaultPath, 'private-provider-state.json');
  const privateUrl = 'https://private-index-provider.invalid/v1';
  const internalFailure = {
    code: 'EACCES',
    message: `Index request to ${privateUrl} failed while reading ${privatePath}`,
  };
  let app;
  t.after(async () => {
    if (app) {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  });

  app = await createApp(appConfig(project), { llm: new FakeLlm() });
  await app.ready;
  app.index.lastError = internalFailure;
  const internalStatus = app.index.status();
  assert.deepEqual(internalStatus.lastError, internalFailure);

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const login = await requestJson(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  assert.equal(login.response.status, 200);

  const status = await requestJson(base, '/api/knowledge/status', {
    headers: { cookie: login.response.headers.get('set-cookie') },
  });
  assert.equal(status.response.status, 200);
  assert.deepEqual(status.body.retrieval.lastError, { code: 'KNOWLEDGE_INDEX_ERROR' });
  assert.equal(Object.hasOwn(status.body.retrieval.lastError, 'message'), false);
  assert.equal(status.body.retrieval.generation, internalStatus.generation);
  assert.equal(status.body.retrieval.embedding.enabled, false);
  const serialized = JSON.stringify(status.body);
  assert.equal(serialized.includes(privatePath), false);
  assert.equal(serialized.includes(privateUrl), false);
  assert.equal(serialized.includes(internalFailure.code), false);
  assert.deepEqual(app.index.status().lastError, internalFailure);
});

test('authenticated HTTP API exposes and executes bounded Deep retrieval', async (t) => {
  const project = await temporaryProject('second-mind-server-deep-');
  const llm = new FakeDeepLlm();
  let app;
  t.after(async () => {
    if (app) {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  });
  await fsp.mkdir(path.join(project.vaultPath, 'Learning'), { recursive: true });
  await fsp.writeFile(
    path.join(project.vaultPath, 'Learning', 'RAG.md'),
    '# RAG\n\nRRF combines lexical and semantic ranked lists.\n',
  );

  app = await createApp(appConfig(project), { llm });
  await app.ready;
  const searches = [];
  const search = app.index.search.bind(app.index);
  app.index.search = async (query, options) => {
    searches.push({ query, options });
    return search(query, options);
  };
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const login = await requestJson(base, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie');
  const authHeaders = { cookie, 'x-vaultmind-request': '1', 'content-type': 'application/json' };

  const status = await requestJson(base, '/api/knowledge/status', { headers: { cookie } });
  assert.equal(status.response.status, 200);
  assert.deepEqual(status.body.taskModes.map((mode) => mode.id), ['normal', 'deep']);

  const deep = await requestJson(base, '/api/knowledge/tasks', {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      kind: 'qa',
      prompt: 'How does RRF combine lexical and semantic retrieval results?',
      taskMode: 'deep',
    }),
  });
  assert.equal(deep.response.status, 201);
  assert.equal(deep.body.taskMode, 'deep');

  const stream = await fetch(`${base}/api/knowledge/tasks/${deep.body.taskId}/events`, {
    headers: { cookie },
  });
  assert.equal(stream.status, 200);
  const deepEvents = events(await stream.text());
  assert.ok(deepEvents.some((event) => (
    event.type === 'session' && event.data.taskMode === 'deep'
  )));
  assert.ok(deepEvents.some((event) => (
    event.type === 'activity'
    && event.data.toolName === 'deep_query_planner'
    && event.data.stage === 'complete'
  )));
  assert.equal(deepEvents.filter((event) => (
    event.type === 'activity'
    && event.data.toolName === 'vault_search'
    && event.data.stage === 'start'
  )).length, 3);
  const fusion = deepEvents.find((event) => (
    event.type === 'activity'
    && event.data.toolName === 'evidence_fusion'
    && event.data.stage === 'complete'
  ));
  assert.equal(fusion?.data.diagnostics.queryCount, 3);
  assert.equal(fusion?.data.diagnostics.strategy, 'multi-query-keyword-rrf');
  assert.equal(searches.length, 3);
  assert.deepEqual(searches.map((item) => item.options.route), ['hybrid', 'hybrid', 'hybrid']);
  assert.equal(llm.calls.length, 2);
  assert.equal(deepEvents.at(-1).type, 'done');
  assert.equal(deepEvents.at(-1).data.status, 'completed');

  const deepWrite = await requestJson(base, '/api/knowledge/tasks', {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ kind: 'diary', prompt: 'Write a diary.', taskMode: 'deep' }),
  });
  assert.equal(deepWrite.response.status, 400);
  assert.equal(deepWrite.body.error, 'DEEP_MODE_NOT_ALLOWED');

  const clientTools = await requestJson(base, '/api/knowledge/tasks', {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({
      kind: 'qa', prompt: 'Use a shell tool.', taskMode: 'deep', tools: ['shell'],
    }),
  });
  assert.equal(clientTools.response.status, 400);
  assert.equal(clientTools.body.error, 'CLIENT_AGENT_OPTIONS_DENIED');
});

test('application state cannot resolve back inside the Vault through a symbolic link', async (t) => {
  const project = await temporaryProject('vaultmind-state-boundary-');
  t.after(project.cleanup);
  await fsp.mkdir(project.dataDir, { recursive: true });
  const hiddenState = path.join(project.vaultPath, '.private-state');
  await fsp.mkdir(hiddenState);
  await fsp.symlink(hiddenState, project.config.indexDir);
  await assert.rejects(
    () => createApp(appConfig(project), { llm: new FakeLlm() }),
    /resolves inside VAULT_PATH/,
  );
});

test('liveness is available while a slow first index build keeps readiness pending', async (t) => {
  const project = await temporaryProject('vaultmind-startup-readiness-');
  let release;
  let indexAvailable = false;
  const pending = new Promise((resolve) => {
    release = () => {
      indexAvailable = true;
      resolve();
    };
  });
  const index = {
    ready: pending,
    status: () => ({
      available: indexAvailable, files: indexAvailable ? 1 : 0,
      semanticAvailable: false,
    }),
    close: async () => {},
  };
  const store = { ready: Promise.resolve() };
  const conversations = { ready: Promise.resolve() };
  const manager = { ready: pending, close: async () => {} };
  const app = await createApp(appConfig(project), {
    index, store, conversations, manager, llm: new FakeLlm(),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    release();
    await app.ready;
    await new Promise((resolve) => app.server.close(resolve));
    await project.cleanup();
  });

  assert.equal((await requestJson(base, '/health/live')).response.status, 200);
  const starting = await requestJson(base, '/health/ready');
  assert.equal(starting.response.status, 503);
  assert.equal(starting.body.status, 'starting');

  release();
  await app.ready;
  const ready = await requestJson(base, '/health/ready');
  assert.equal(ready.response.status, 200);
  assert.equal(ready.body.status, 'ready');
});

test('a post-open file stream failure is contained without logging its private path', async (t) => {
  const project = await temporaryProject('vaultmind-stream-failure-');
  const privatePath = '/srv/private-fixture/secret-note.md';
  const logs = [];
  const originalConsoleError = console.error;
  let app;
  console.error = (...values) => logs.push(values.map(String).join(' '));
  t.after(async () => {
    console.error = originalConsoleError;
    if (app) {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  });

  app = await createApp(appConfig(project), {
    llm: new FakeLlm(),
    createReadStream: () => {
      const stream = new Readable({ read() {} });
      queueMicrotask(() => {
        stream.emit('open', 1);
        queueMicrotask(() => stream.destroy(new Error(`read failed: ${privatePath}`)));
      });
      return stream;
    },
  });
  await app.ready;
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  await fetch(`${base}/`).then((response) => response.arrayBuffer()).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.some((line) => line.includes('FILE_STREAM_FAILED')), true);
  assert.equal(logs.some((line) => line.includes(privatePath)), false);
  assert.equal((await requestJson(base, '/health/live')).response.status, 200);
});
