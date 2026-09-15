export function messageResponse(block, stopReason) {
  const events = [];
  const add = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  add('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant',
    model: 'qwen3.8-max', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 0 } } });
  const initial = block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' };
  add('content_block_start', { index: 0, content_block: initial });
  add('content_block_delta', { index: 0, delta: block.type === 'tool_use'
    ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
    : { type: 'text_delta', text: block.text } });
  add('content_block_stop', { index: 0 });
  add('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 30 } });
  add('message_stop', {});
  return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

export async function waitFor(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('SDK task did not finish within the test deadline.');
}


export async function sdkApplication(t, options = {}) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { temporaryProject } = await import('./helpers.mjs');
  const { createConfig } = await import('../src/config.mjs');
  const { startApplication } = await import('../src/bootstrap.mjs');
  const project = await temporaryProject('sdk-api-');
  t.after(() => project.cleanup());
  await options.prepareProject?.(project);
  await fs.mkdir(path.join(project.vaultPath, '.obsidian'));
  await fs.writeFile(path.join(project.vaultPath, 'Evidence.md'), '# Evidence\n\n公开资料：sdkmarker，计划尚未完成。\n');
  const config = createConfig({ ...project.config, host: '127.0.0.1', port: 0,
    publicDir: path.resolve('public'), retrieval: { watch: false },
    auth: { username: 'admin', password: 'synthetic admin password', sessionSecret: 'synthetic-session-secret-with-at-least-32-characters' },
    llm: { provider: 'anthropic', protocol: 'anthropic-messages', authMode: 'x-api-key',
      apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic', apiKey: 'synthetic-sdk-provider-key', model: 'qwen3.8-max[1M]' },
    embedding: { provider: 'disabled' }, webSearch: { enabled: false },
    ...options.config,
  });
  const sdkFetch = options.fetch || (async () => messageResponse({ type: 'text', text: '公开回答。〔来源：Evidence.md#Evidence〕' }, 'end_turn'));
  const app = await startApplication({ config, ...options.applicationOptions?.(project), dependencies: { sdkFetch, ...options.dependencies } });
  t.after(async () => { await app.knowledgeBaseHub.close(); await new Promise((r) => app.server.close(r)); });
  const base = `http://127.0.0.1:${app.port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-vaultmind-request': '1' },
    body: JSON.stringify({ username: 'admin', password: config.auth.password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: {
    cookie, origin: base, 'content-type': 'application/json', 'x-vaultmind-request': '1', ...options.headers,
  } });
  const manager = app.knowledgeBaseHub.resolve('default').manager;
  return { app, project, config, base, cookie, call, manager };
}
