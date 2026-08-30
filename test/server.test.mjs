import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
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

function appConfig(project) {
  return {
    ...project.config,
    projectRoot,
    appName: 'VaultMind Test',
    vaultLabel: 'Fixture Vault',
    publicDir: path.join(projectRoot, 'public'),
    host: '127.0.0.1',
    port: 0,
    timezone: 'UTC',
    trustProxy: false,
    auth: {
      username: 'admin',
      password: 'correct horse battery staple',
      sessionSecret: '0123456789abcdef0123456789abcdef',
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
  assert.equal(ready.body.retrieval.documentCount, 1);

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
