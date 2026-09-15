import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createConfig } from '../src/config.mjs';
import { startApplication } from '../src/bootstrap.mjs';
import { temporaryProject } from './helpers.mjs';
import { sourceBrowser } from './source-browser-helper.mjs';
import { messageResponse, waitFor } from './sdk-test-helpers.mjs';

test('browser config check/save/reload updates the full SDK app and preserves citation preview and session reload', { timeout: 90_000 }, async (t) => {
  const project = await temporaryProject('sdk-browser-');
  t.after(() => project.cleanup());
  await fs.mkdir(path.join(project.vaultPath, '.obsidian'));
  await fs.writeFile(path.join(project.vaultPath, 'Evidence.md'), '# Evidence\n\n公开验收资料：browsermarker；计划尚未完成。\n');
  const requests = [];
  let taskCall = 0;
  const sdkFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ body, key: init.headers['x-api-key'] });
    if (JSON.stringify(body.messages).includes('Connection check. Reply with OK.')) {
      return messageResponse({ type: 'text', text: 'OK' }, 'end_turn');
    }
    if (taskCall++ === 0) return messageResponse({ type: 'tool_use', id: 'browser_read', name: 'Read', input: { file_path: 'Evidence.md' } }, 'tool_use');
    return messageResponse({ type: 'text', text: '公开资料说明：browsermarker，计划尚未完成。〔来源：Evidence.md#Evidence〕' }, 'end_turn');
  };
  const config = createConfig({ ...project.config, host: '127.0.0.1', port: 0,
    publicDir: path.resolve('public'), retrieval: { watch: false },
    auth: { username: 'admin', password: 'synthetic admin password', sessionSecret: 'synthetic-session-secret-with-at-least-32-characters' },
    llm: { provider: 'anthropic', protocol: 'anthropic-messages', authMode: 'x-api-key',
      apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic', apiKey: 'synthetic-initial-key', model: 'qwen3.8-max[1M]' },
    embedding: { provider: 'disabled' }, webSearch: { enabled: false },
  });
  const app = await startApplication({ config, dependencies: { sdkFetch, runtimeLlmOptions: { fetch: sdkFetch } } });
  t.after(async () => { await app.knowledgeBaseHub.close(); await new Promise((r) => app.server.close(r)); });
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await sourceBrowser(t, `${base}/?knowledgeBaseId=default`);
  if (!browser) return;
  const waitPage = (condition) => waitFor(() => browser.evaluate(condition));
  await waitPage(`document.querySelector('#knowledge-login-form')?.hidden === false`);
  await browser.evaluate(`document.querySelector('#knowledge-username').value='admin'; document.querySelector('#knowledge-password').value='synthetic admin password'; document.querySelector('#knowledge-login-form').requestSubmit();`);
  await waitPage(`document.querySelector('#knowledge-app')?.hidden === false`);
  await browser.call('Page.navigate', { url: `${base}/admin-config.html?knowledgeBaseId=default` });
  await waitPage(`document.querySelector('[data-model-field="actualModel"]')?.value === 'qwen3.8-max[1M]'`);
  assert.equal(await browser.evaluate(`document.querySelector('[data-connection-key]').value`), '');
  await browser.evaluate(`(() => {
    window.confirm=()=>true;
    const fill = (selector, value) => { const e=document.querySelector(selector); e.value=value; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); };
    fill('#branding-app-name','SDK 浏览器验收');
    fill('[data-model-field="displayName"]','公开 Qwen 验收');
    fill('[data-connection-key]','synthetic-replaced-key');
    fill('#admin-password','synthetic admin password');
    document.querySelector('#config-save').click();
  })()`);
  await waitFor(() => app.runtimeConfig.runtimeSnapshot().branding.appName === 'SDK 浏览器验收');
  assert.ok(requests.length > 0, 'Save must validate with the actual SDK request path');
  assert.equal(requests.at(-1).key, 'synthetic-replaced-key');
  assert.equal(requests.at(-1).body.model, 'qwen3.8-max');
  await browser.evaluate(`window.__reloadMarker = true`);
  await browser.call('Page.reload');
  await waitPage(`window.__reloadMarker !== true && document.readyState === 'complete'`);
  await waitPage(`document.querySelector('#branding-app-name')?.value === 'SDK 浏览器验收'`);
  assert.equal(await browser.evaluate(`document.querySelector('[data-model-field="actualModel"]').value`), 'qwen3.8-max[1M]');
  assert.equal(await browser.evaluate(`document.querySelector('[data-connection-key]').value`), '');
  assert.equal(await browser.evaluate(`document.documentElement.innerHTML.includes('synthetic-replaced-key')`), false);
  await browser.call('Page.navigate', { url: `${base}/?knowledgeBaseId=default` });
  await waitPage(`document.querySelector('#knowledge-app')?.hidden === false`);
  assert.equal(await browser.evaluate('document.title'), 'SDK 浏览器验收');
  await browser.evaluate(`document.querySelector('#knowledge-prompt').value='检索并读取 browsermarker 的计划状态。'; document.querySelector('#knowledge-form').requestSubmit();`);
  const manager = app.knowledgeBaseHub.resolve('default').manager;
  await waitFor(() => [...manager.tasks.values()].find((task) => task.status === 'completed'));
  await waitPage(`document.body.innerText.includes('计划尚未完成')`);
  assert.equal(requests.at(-1).key, 'synthetic-replaced-key');
  const count = manager.conversations.size;
  await browser.evaluate(`window.__reloadMarker = true`);
  await browser.call('Page.reload');
  await waitPage(`window.__reloadMarker !== true && document.readyState === 'complete'`);
  await waitPage(`document.querySelector('#knowledge-app')?.hidden === false && document.querySelector('.knowledge-conversation-open')`);
  await browser.evaluate(`document.querySelector('.knowledge-conversation-open').click()`);
  await waitPage(`document.body.innerText.includes('计划尚未完成')`);
  assert.equal(manager.conversations.size, count);
  // The original citation chip opens the real authenticated source route.
  const sourceButton = await browser.evaluate(`Array.from(document.querySelectorAll('button,a')).filter(e => e.dataset.knowledgeSource || e.dataset.source || e.className.includes('source')).map(e => ({tag:e.tagName,cls:e.className,data:e.dataset}));`);
  assert.ok(sourceButton.length > 0);
  await browser.evaluate(`document.querySelector('[data-knowledge-source], [data-source], .knowledge-source-chip')?.click()`);
  await waitPage(`document.querySelector('#knowledge-source-dialog')?.open === true && document.querySelector('#knowledge-source-content').innerText.includes('browsermarker')`);
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
});
