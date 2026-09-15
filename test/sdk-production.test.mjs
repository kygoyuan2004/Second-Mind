import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createConfig } from '../src/config.mjs';
import { startApplication } from '../src/bootstrap.mjs';
import { temporaryProject } from './helpers.mjs';

import { messageResponse, waitFor } from './sdk-test-helpers.mjs';

test('real Agent SDK binary uses Read + knowledge MCP, streams citations, and resumes its session with isolated credentials', { timeout: 60_000 }, async (t) => {
  const project = await temporaryProject('second-mind-sdk-');
  t.after(() => project.cleanup());
  await fs.mkdir(path.join(project.vaultPath, '.obsidian'));
  await fs.writeFile(path.join(project.vaultPath, 'Evidence.md'), '# Evidence\n\n公开演示资料：验收标记是 sdkpublicmarker，计划尚未完成。\n');
  const requests = [];
  const credential = 'synthetic-sdk-provider-credential';
  let toolSequence = 0;
  const sdkFetch = async (url, init) => {
    assert.equal(String(url), 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages');
    assert.equal(init.headers['x-api-key'], credential);
    const body = JSON.parse(init.body);
    assert.ok(!init.body.includes(credential));
    requests.push(body);
    if (toolSequence++ === 0) return messageResponse({ type: 'tool_use', id: 'read_fixture', name: 'Read', input: { file_path: 'Evidence.md' } }, 'tool_use');
    if (toolSequence === 2) return messageResponse({ type: 'tool_use', id: 'search_fixture', name: 'mcp__knowledge__KnowledgeSearch', input: { query: 'sdkpublicmarker' } }, 'tool_use');
    return messageResponse({ type: 'text', text: '验收标记是 sdkpublicmarker；计划尚未完成。〔来源：Evidence.md#Evidence〕' }, 'end_turn');
  };
  const config = createConfig({ ...project.config, host: '127.0.0.1', port: 0,
    publicDir: path.resolve('public'), retrieval: { watch: false },
    auth: { username: 'admin', password: 'synthetic admin password', sessionSecret: 'synthetic-session-secret-with-at-least-32-characters' },
    llm: { provider: 'anthropic', protocol: 'anthropic-messages', authMode: 'x-api-key',
      apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic', apiKey: credential, model: 'qwen3.8-max' },
    embedding: { provider: 'disabled' }, webSearch: { enabled: false },
  });
  const app = await startApplication({ config, dependencies: { sdkFetch } });
  t.after(async () => { await app.knowledgeBaseHub.close(); await new Promise((r) => app.server.close(r)); });
  await app.ready;
  const base = `http://127.0.0.1:${app.port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'synthetic admin password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (url, opts = {}) => fetch(`${base}${url}`, { ...opts, headers: {
    cookie, origin: base, 'content-type': 'application/json', 'x-vaultmind-request': '1', ...opts.headers } });
  const status = await (await call('/api/knowledge/status?knowledgeBaseId=default')).json();
  assert.equal(status.executor, 'claude-agent-sdk');
  const create = await call('/api/knowledge/tasks?knowledgeBaseId=default', { method: 'POST', body: JSON.stringify({
    kind: 'qa', model: status.models[0].id, effort: 'xhigh', prompt: '检索“sdkpublicmarker”，读取原文后说明计划状态并引用来源。',
  }) });
  assert.equal(create.status, 201, JSON.stringify(await create.clone().json()));
  const created = await create.json();
  const manager = app.knowledgeBaseHub.resolve('default').manager;
  const finished = await waitFor(() => {
    const task = manager.tasks.get(created.taskId);
    return ['completed', 'failed', 'cancelled', 'timed_out'].includes(task?.status) && task;
  });
  assert.equal(finished.status, 'completed', JSON.stringify(finished.events.filter((e) => ['task_error', 'warning'].includes(e.type))));
  assert.match(finished.assistantText, /〔来源：Evidence.md#Evidence〕/);
  assert.ok(finished.events.some((e) => e.type === 'text'));
  assert.ok(finished.events.some((e) => e.data.toolName === 'Read'));
  assert.ok(finished.events.some((e) => e.data.toolName === 'mcp__knowledge__KnowledgeSearch'));
  const toolResults = requests.flatMap((r) => r.messages).flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'tool_result');
  assert.ok(toolResults.some((b) => b.tool_use_id === 'read_fixture' && JSON.stringify(b.content).includes('计划尚未完成')));
  assert.ok(toolResults.some((b) => b.tool_use_id === 'search_fixture' && !b.is_error));
  assert.equal(requests[0].output_config?.effort, 'xhigh');
  // SDK 0.3.247 applies its own 128000 wire cap to the original 131072 env setting.
  assert.equal(requests[0].max_tokens, 128_000);
  const conversation = manager.conversations.get(created.conversationId);
  assert.ok(conversation.sdkSessionId);
  const sessionId = conversation.sdkSessionId;
  await waitFor(() => !manager.taskRegistry.active?.has?.(finished.userId));
  const next = await call('/api/knowledge/tasks?knowledgeBaseId=default', { method: 'POST', body: JSON.stringify({
    kind: 'qa', model: status.models[0].id, effort: 'xhigh', conversationId: created.conversationId,
    prompt: '继续：再确认上一轮提到的计划状态。',
  }) });
  assert.equal(next.status, 201, JSON.stringify(await next.clone().json()));
  const nextId = (await next.json()).taskId;
  await waitFor(() => manager.tasks.get(nextId)?.status === 'completed');
  assert.equal(conversation.sdkSessionId, sessionId);
  assert.ok(requests.at(-1).messages.some((m) => JSON.stringify(m.content).includes('read_fixture')));
  const files = await fs.readdir(manager.sdkStateDir, { recursive: true });
  for (const relative of files) {
    const file = path.join(manager.sdkStateDir, relative);
    if ((await fs.stat(file)).isFile()) assert.ok(!(await fs.readFile(file)).includes(Buffer.from(credential)), 'Real provider credentials must not enter SDK state.');
  }
});
