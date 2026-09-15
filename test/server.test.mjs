import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import { sdkApplication, messageResponse, waitFor } from './sdk-test-helpers.mjs';
import { startServer } from '../src/server.mjs';

const body = (value) => ({ method: 'POST', body: JSON.stringify(value) });

test('SDK HTTP routes authenticate, stream, create a dated draft and write only on explicit save', async (t) => {
  const fixture = await sdkApplication(t, { fetch: async () => messageResponse({ type: 'text', text: '# 2026-09-15 日记\n\n## 今日事项\n\n完成公开演示验收。' }, 'end_turn') });
  const { call, base, project, manager } = fixture;
  assert.equal((await fetch(`${base}/api/knowledge/status`)).status, 401);
  assert.equal((await call('/api/knowledge/tasks', { ...body({ kind: 'qa', prompt: 'test' }), headers: { 'x-vaultmind-request': '' } })).status, 403);
  const response = await call('/api/knowledge/tasks', body({ kind: 'diary', date: '2026-09-15', prompt: '今天完成了公开演示验收。', model: 'configured', effort: 'low' }));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const created = await response.json();
  const eventsResponse = await call(`/api/knowledge/tasks/${created.taskId}/events`);
  const reader = eventsResponse.body.getReader();
  let events = '';
  while (!events.includes('event: done')) {
    const { value, done } = await reader.read();
    if (done) break;
    events += new TextDecoder().decode(value);
  }
  await reader.cancel();
  assert.match(events, /event: draft_ready/);
  assert.match(events, /event: done/);
  const task = manager.tasks.get(created.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(await fs.access(path.join(project.vaultPath, 'daily_doc')).then(() => true, () => false), false);
  const draft = await (await call(`/api/knowledge/drafts/${task.draftId}`)).json();
  assert.equal(draft.targetPath, 'daily_doc/日记/2026-09-15.md');
  const saved = await call(`/api/knowledge/drafts/${draft.id}/save`, body({ content: '# 手动编辑\n\n这是确认后的日记。' }));
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  assert.match(await fs.readFile(path.join(project.vaultPath, draft.targetPath), 'utf8'), /确认后的日记/);
  const denied = await call('/api/knowledge/tasks', body({ kind: 'qa', prompt: 'test', tools: ['Bash'] }));
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error, 'CLIENT_AGENT_OPTIONS_DENIED');
});

test('SDK cancellation aborts the provider and preserves an explicit terminal event', async (t) => {
  let entered = false, aborted = false;
  const { manager, call } = await sdkApplication(t, { fetch: async (_url, init) => {
    entered = true;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      aborted = true; reject(init.signal.reason || new Error('aborted'));
    }, { once: true }));
  } });
  const created = await (await call('/api/knowledge/tasks', body({ kind: 'qa', prompt: '取消验收', model: 'configured', effort: 'low' }))).json();
  await waitFor(() => entered);
  const cancelled = await call(`/api/knowledge/tasks/${created.taskId}/cancel`, body({}));
  assert.equal(cancelled.status, 200);
  await waitFor(() => aborted && manager.running.size === 0);
  const task = manager.tasks.get(created.taskId);
  assert.equal(task.status, 'cancelled');
  assert.ok(task.events.some((event) => event.type === 'done' && event.data.status === 'cancelled'));
});

test('provider auth failure is explicit and never exposes upstream diagnostics', async (t) => {
  const { manager, call } = await sdkApplication(t, { fetch: async () => new Response('synthetic-sdk-provider-key /private/account/secret', { status: 401 }) });
  const created = await (await call('/api/knowledge/tasks', body({ kind: 'qa', prompt: '鉴权失败验收', model: 'configured', effort: 'low' }))).json();
  await waitFor(() => manager.tasks.get(created.taskId)?.status === 'failed');
  const task = manager.tasks.get(created.taskId);
  assert.ok(task.events.some((event) => event.type === 'task_error' && event.data.code === 'SDK_AUTH_FAILED'));
  assert.doesNotMatch(JSON.stringify(task.events), /synthetic-sdk-provider-key|\/private\/account/);
});

test('an opened file stream error stays contained and never returns its private path', async (t) => {
  const { call } = await sdkApplication(t, { dependencies: { createReadStream: () => {
    const stream = new Readable({ read() { this.destroy(new Error('/private/file-stream-error')); } });
    queueMicrotask(() => stream.emit('open', 1));
    return stream;
  } } });
  const result = await call('/api/knowledge/file?path=Evidence.md').then((response) => response.text()).catch(() => 'stream closed');
  assert.doesNotMatch(result, /private\/file-stream-error/);
});

test('liveness binds before a delayed application context, while all private routes remain unavailable', async (t) => {
  // A supplied manager allows the test to control readiness without a model call.
  const fixture = await sdkApplication(t);
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  let release;
  const ready = new Promise((r) => { release = r; });
  const starting = startServer({ config: { ...fixture.config, port }, dependencies: {
    runtimeConfig: fixture.app.runtimeConfig,
    knowledgeBaseRegistry: fixture.app.knowledgeBaseRegistry,
    knowledgeBaseContextFactory: async () => { await ready; return fixture.app.knowledgeBaseHub.resolve('default'); },
  } });
  t.after(() => release());
  const base = `http://127.0.0.1:${port}`;
  const live = await waitFor(() => fetch(`${base}/health/live`).catch(() => null));
  assert.equal(live.status, 200);
  assert.equal((await fetch(`${base}/health/ready`)).status, 503);
  assert.equal((await fetch(`${base}/api/knowledge/status`)).status, 503);
  release();
  const app = await starting;
  t.after(() => new Promise((r) => app.server.close(r)));
  assert.equal((await fetch(`${base}/health/ready`)).status, 200);
});
