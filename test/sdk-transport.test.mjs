import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sdkCatalog, sdkBinding, openSdkTransport, sdkEnvironment } from '../src/sdk-runtime.mjs';
import { createSdkWebServer } from '../src/sdk-web-search.mjs';
import { resolveModelProvider, normalizeProviderModelId } from '../src/model-provider-registry.mjs';
import { assertPrivateMode } from './platform-fixtures.mjs';

function snapshot(model = 'qwen3.8-max[1M]') {
  return { connections: [{ id: 'bailian', providerId: 'bailian', protocol: 'anthropic-messages',
    authMode: 'x-api-key', apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic', apiKey: 'synthetic-provider-key' }],
    models: [{ id: 'qwen', actualModel: model, connectionId: 'bailian', enabled: true }], webSearch: { enabled: false } };
}

test('SDK catalog preserves exact model identities, native efforts and search binding revisions', () => {
  const a = snapshot();
  const model = sdkCatalog(a)[0];
  assert.equal(model.actualModel, 'qwen3.8-max[1M]');
  assert.deepEqual(model.efforts, ['low', 'medium', 'xhigh']);
  assert.ok(!JSON.stringify(model).includes('synthetic-provider-key'));
  const b = structuredClone(a);
  b.webSearch = { enabled: true, provider: 'tavily-rest', apiKey: 'synthetic-tavily-key' };
  assert.notEqual(sdkBinding(model).revision, sdkBinding(sdkCatalog(b)[0]).revision);
  const deepseek = resolveModelProvider({ providerId: 'deepseek', apiBase: 'https://api.deepseek.com/anthropic', protocol: 'anthropic-messages' });
  assert.equal(normalizeProviderModelId(deepseek, 'deepseek-v4-pro-0813'), 'deepseek-v4-pro-0813');
});

test('transport authenticates locally, forwards context suffix and count tokens, rejects changed models and hides upstream errors', async (t) => {
  const calls = [];
  const transport = await openSdkTransport(sdkBinding(sdkCatalog(snapshot())[0]), {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 3 ? new Response('synthetic-provider-key secret diagnostic', { status: 401 })
        : Response.json({ input_tokens: 3 });
    },
  });
  t.after(() => transport.close());
  const request = (suffix, model, auth = transport.token) => fetch(`${transport.baseUrl}/v1/messages${suffix}`, {
    method: 'POST', headers: { 'x-api-key': auth, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [] }),
  });
  assert.equal((await request('', 'qwen3.8-max', 'wrong')).status, 401);
  assert.equal((await request('', 'other')).status, 400);
  assert.equal((await request('', 'qwen3.8-max')).status, 200);
  assert.equal((await request('/count_tokens', 'qwen3.8-max[1M]')).status, 200);
  assert.equal(calls[1].url, 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages/count_tokens');
  const failure = await request('', 'qwen3.8-max');
  assert.equal(failure.status, 401);
  assert.ok(!(await failure.text()).includes('secret diagnostic'));
  assert.equal(calls[0].init.headers['x-api-key'], 'synthetic-provider-key');
});

test('Tavily worker starts the pinned original MCP with file-only credentials and native tools', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-tavily-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = await sdkEnvironment(root, { baseUrl: 'http://127.0.0.1:1', token: 'temporary-local-token' });
  await assertPrivateMode(root, 0o700);
  assert.equal(env.HOME, root);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'temporary-local-token');
  const config = await createSdkWebServer({ id: 'synthetic-task', sdkEnv: env }, {
    provider: 'tavily-rest', enabled: true, apiKey: 'synthetic-tavily-provider-key',
  });
  t.after(() => config.closeLease());
  await assertPrivateMode(config.env.SECOND_MIND_TAVILY_CREDENTIAL_FILE);
  assert.ok(!JSON.stringify(config).includes('synthetic-tavily-provider-key'));
  const client = new Client({ name: 'sdk-offline-validation', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args,
    env: { ...env, ...config.env }, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.listTools();
  for (const name of ['tavily_search', 'tavily_extract']) assert.ok(result.tools.some((tool) => tool.name === name));
  assert.equal(JSON.parse(config.env.DEFAULT_PARAMETERS).search_depth, 'advanced');
  await client.close();
  await config.closeLease();
  await assert.rejects(fs.access(config.env.SECOND_MIND_TAVILY_CREDENTIAL_FILE));
});

test('desktop Tavily launches native MCP tools through an authenticated memory broker without persisting the provider key', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-tavily-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.SECOND_MIND_DESKTOP;
  process.env.SECOND_MIND_DESKTOP = '1';
  t.after(() => { if (previous === undefined) delete process.env.SECOND_MIND_DESKTOP; else process.env.SECOND_MIND_DESKTOP = previous; });
  const env = await sdkEnvironment(root, { baseUrl: 'http://127.0.0.1:1', token: 'temporary-local-token' });
  await assertPrivateMode(root, 0o700);
  const secret = 'synthetic-desktop-provider-credential';
  const config = await createSdkWebServer({ id: 'desktop-fixture', sdkEnv: env }, { provider: 'tavily-rest', enabled: true, apiKey: secret });
  t.after(() => config.closeLease());
  const raw = await fs.readFile(config.env.SECOND_MIND_TAVILY_CREDENTIAL_FILE, 'utf8');
  const descriptor = JSON.parse(raw);
  assert.equal(raw.includes(secret), false);
  assert.equal(JSON.stringify(config).includes(secret), false);
  const unauthorized = await fetch(descriptor.url);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.has('access-control-allow-origin'), false);
  const authorizedHeaders = { authorization: `Bearer ${descriptor.token}` };
  assert.equal((await fetch(`${descriptor.url}?unexpected=1`, { headers: authorizedHeaders })).status, 400);
  assert.equal((await fetch(descriptor.url, { headers: { ...authorizedHeaders, origin: 'https://untrusted.example' } })).status, 401);
  const client = new Client({ name: 'desktop-tavily-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args,
    env: { ...env, ...config.env }, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  for (const name of ['tavily_search', 'tavily_extract']) assert.ok(listed.tools.some((tool) => tool.name === name));
  for (const filename of await fs.readdir(root)) {
    if ((await fs.stat(path.join(root, filename))).isFile()) assert.equal((await fs.readFile(path.join(root, filename))).includes(Buffer.from(secret)), false);
  }
  await client.close();
  await config.closeLease();
  await assert.rejects(fs.access(config.env.SECOND_MIND_TAVILY_CREDENTIAL_FILE));
  await assert.rejects(fetch(descriptor.url, { headers: authorizedHeaders }));
});
