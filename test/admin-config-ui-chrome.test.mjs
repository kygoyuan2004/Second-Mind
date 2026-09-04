import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const chromePath = '/usr/bin/google-chrome';

const providerOptions = [
  {
    id: 'bailian',
    label: '阿里云百炼',
    defaultApiBase: 'https://dashscope.aliyuncs.com/apps/anthropic',
    defaultProtocol: 'anthropic-messages',
    protocols: ['anthropic-messages', 'openai-chat-completions'],
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官网',
    defaultApiBase: 'https://api.deepseek.com',
    defaultProtocol: 'openai-chat-completions',
    protocols: ['openai-chat-completions'],
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
  },
  {
    id: 'glm',
    label: 'GLM / 智谱官网',
    defaultApiBase: 'https://open.bigmodel.cn/api/paas/v4',
    defaultProtocol: 'openai-chat-completions',
    protocols: ['openai-chat-completions'],
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
  },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot 官网',
    defaultApiBase: 'https://api.moonshot.cn/v1',
    defaultProtocol: 'openai-chat-completions',
    protocols: ['openai-chat-completions'],
    docsUrl: 'https://platform.moonshot.cn/docs/',
  },
  {
    id: 'custom',
    label: '自定义兼容服务',
    defaultApiBase: '',
    defaultProtocol: 'openai-chat-completions',
    protocols: ['anthropic-messages', 'openai-chat-completions'],
    docsUrl: '',
  },
];

function publicConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: overrides.revision || 'provider-revision-0001',
    stale: false,
    defaultModelId: overrides.defaultModelId || 'qwen-main',
    branding: overrides.branding || {
      appName: 'Private Research Desk',
      vaultLabel: 'Private Family Vault',
    },
    providerOptions,
    providers: overrides.providers || [{
      id: 'bailian-primary',
      providerId: 'bailian',
      label: '阿里云百炼',
      protocol: 'anthropic-messages',
      apiBase: 'https://dashscope.aliyuncs.com/apps/anthropic',
      authMode: 'x-api-key',
      endpointPreview: 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages',
      docsUrl: providerOptions[0].docsUrl,
      apiKeyConfigured: true,
      models: [{
        id: 'qwen-main',
        displayName: 'Qwen Main',
        actualModel: 'qwen3.8-max-0902',
        enabled: true,
        reasoningMapping: { mode: 'auto' },
        effortMapping: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
        automaticEffortMapping: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
      }],
    }],
    webSearch: overrides.webSearch || {
      enabled: false,
      provider: 'bailian-mcp',
      configured: false,
      providers: [
        { id: 'bailian-mcp', label: '百炼 WebSearch', apiKeyConfigured: true, extractFallbackEnabled: false },
        { id: 'tavily-rest', label: 'Tavily', apiKeyConfigured: false, extractFallbackEnabled: false },
      ],
    },
    embedding: {
      provider: 'disabled', apiBase: '', model: '', dimensions: 1_024,
      enabled: false, configured: false, apiKeyConfigured: false,
    },
    index: {
      state: 'ready',
      active: {
        revision: 'index-1', available: true, files: 7,
        embedding: { provider: 'disabled', model: null, dimensions: null },
      },
      pending: null,
    },
    rebuild: { status: 'idle' },
    capabilities: {
      validationReceipts: true,
      branding: true,
      automaticEmbeddingDimensions: true,
    },
  };
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function contentType(filename) {
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filename.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function createMockApplication() {
  const state = {
    config: publicConfig(),
    validateBodies: [],
    targetCheckBodies: [],
    fullValidateBodies: [],
    commitBodies: [],
    requestSequence: [],
    runtimeConfigRequests: [],
    pendingCandidate: null,
    validationStage: null,
    validationModelCalls: [],
    webValidationCalls: 0,
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/session') {
        json(response, 200, {
          authenticated: true,
          user: { username: 'admin-ui-test', role: 'admin' },
          permissions: { useKnowledge: true, manageRuntimeConfig: true },
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/knowledge/status') {
        json(response, 200, {
          appName: 'Status Fallback Name',
          vaultLabel: 'Status Fallback Vault',
          rootLabel: 'Status Root',
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/provider-config') {
        json(response, 200, state.config);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/provider-config/validate') {
        const payload = JSON.parse(await requestBody(request));
        state.validateBodies.push(payload);
        const hasProviderIndex = Number.isSafeInteger(payload.validateProviderIndex);
        if (hasProviderIndex) {
          state.targetCheckBodies.push(payload);
          state.requestSequence.push(payload.validationStageId ? 'target-check-staged' : 'target-check-start');
        } else {
          state.fullValidateBodies.push(payload);
          state.requestSequence.push('validate');
        }
        const staged = payload.validationStageId ? state.validationStage : null;
        if (payload.validationStageId && (!staged || staged.token !== payload.validationStageId)) {
          json(response, 409, {
            error: 'PROVIDER_VALIDATION_STAGE_INVALID',
            message: 'validation stage expired',
          });
          return;
        }
        const candidate = staged?.candidate || payload;
        const idAssignments = {
          providers: [],
          models: [],
        };
        const modelEntries = [];
        candidate.providers.forEach((provider, providerIndex) => {
          const connectionId = provider.id || `${provider.providerId}-browser-provider`;
          if (!provider.id) {
            idAssignments.providers.push({ index: providerIndex, id: connectionId });
          }
          provider.models.forEach((model, modelIndex) => {
            const modelId = model.id || `${provider.providerId}-browser-model-${modelIndex + 1}`;
            if (!model.id) idAssignments.models.push({ providerIndex, modelIndex, id: modelId });
            if (model.enabled !== false) modelEntries.push({ providerIndex, connectionId, modelId, model });
          });
        });
        if (hasProviderIndex) {
          const target = modelEntries.filter((entry) => entry.providerIndex === payload.validateProviderIndex);
          for (const entry of target) state.validationModelCalls.push(entry.model.actualModel);
          const results = target.map((entry) => ({
            modelId: entry.modelId,
            ok: true,
            code: 'MODEL_VALIDATION_OK',
            message: `${entry.model.actualModel} accepted`,
          }));
          const token = staged?.token || 's'.repeat(43);
          const checkedIndexes = new Set(staged?.checkedIndexes || []);
          checkedIndexes.add(payload.validateProviderIndex);
          state.validationStage = { token, candidate, checkedIndexes };
          json(response, 200, {
            ok: true,
            scope: {
              kind: 'provider',
              connectionId: target[0]?.connectionId || '',
              providerIndex: payload.validateProviderIndex,
            },
            validationStageId: token,
            expiresAt: '2099-09-03T12:05:00.000Z',
            results,
            webSearch: { skipped: true },
            idAssignments: staged ? { providers: [], models: [] } : idAssignments,
          });
          return;
        }
        const checkedIndexes = staged?.checkedIndexes || new Set();
        const results = modelEntries.map((entry) => {
          const cached = checkedIndexes.has(entry.providerIndex);
          if (!cached) state.validationModelCalls.push(entry.model.actualModel);
          return {
            modelId: entry.modelId,
            ok: true,
            code: 'MODEL_VALIDATION_OK',
            message: cached ? '' : `${entry.model.actualModel} accepted`,
            ...(cached ? { cached: true } : {}),
          };
        });
        state.webValidationCalls += 1;
        state.pendingCandidate = candidate;
        state.validationStage = null;
        json(response, 200, {
          ok: true,
          validationId: 'validation-browser-0001',
          expiresAt: '2026-09-03T12:05:00.000Z',
          results,
          webSearch: { ok: true, webSearch: true, extraction: false },
          idAssignments: staged ? { providers: [], models: [] } : idAssignments,
        });
        return;
      }
      if (request.method === 'PUT' && url.pathname === '/api/admin/provider-config') {
        const payload = JSON.parse(await requestBody(request));
        state.commitBodies.push(payload);
        state.requestSequence.push('commit');
        if (!payload.validationId && payload.branding) {
          state.config = publicConfig({
            revision: 'provider-revision-0003',
            defaultModelId: state.config.defaultModelId,
            branding: payload.branding,
            providers: state.config.providers,
            webSearch: state.config.webSearch,
          });
          json(response, 200, state.config);
          return;
        }
        const candidate = state.pendingCandidate;
        if (!candidate || payload.validationId !== 'validation-browser-0001') {
          json(response, 409, { error: 'VALIDATION_RECEIPT_INVALID', message: 'missing validation receipt' });
          return;
        }
        const configuredBefore = new Map(state.config.providers.map((provider) => [provider.id, provider.apiKeyConfigured]));
        const nextProviders = candidate.providers.map((provider, providerIndex) => {
          const option = providerOptions.find((entry) => entry.id === provider.providerId) || providerOptions.at(-1);
          const id = provider.id || `${provider.providerId}-browser-provider`;
          const protocol = provider.protocol || option.defaultProtocol;
          return {
            id,
            providerId: provider.providerId,
            label: option.label,
            protocol,
            apiBase: provider.apiBase,
            authMode: provider.authMode || (protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'),
            endpointPreview: protocol === 'anthropic-messages'
              ? `${provider.apiBase.replace(/\/+$/u, '')}/v1/messages`
              : `${provider.apiBase.replace(/\/+$/u, '')}/chat/completions`,
            docsUrl: option.docsUrl,
            apiKeyConfigured: provider.apiKeyAction === 'replace' || (
              provider.apiKeyAction === 'keep' && configuredBefore.get(id) === true
            ),
            models: provider.models.map((model, modelIndex) => ({
              id: model.id || `${provider.providerId}-browser-model-${modelIndex + 1}`,
              displayName: model.displayName,
              actualModel: model.actualModel,
              enabled: model.enabled,
              reasoningMapping: model.reasoningMapping || { mode: 'auto' },
              effortMapping: model.reasoningMapping?.mode === 'manual'
                ? { ...model.reasoningMapping.tiers }
                : { low: 'default', medium: 'default', high: 'default', xhigh: 'default', max: 'default' },
              automaticEffortMapping: {
                low: 'default', medium: 'default', high: 'default', xhigh: 'default', max: 'default',
              },
            })),
          };
        });
        let nextDefaultModelId = 'qwen-main';
        candidate.providers.forEach((provider, providerIndex) => {
          provider.models.forEach((model, modelIndex) => {
            if (model.default === true) nextDefaultModelId = nextProviders[providerIndex].models[modelIndex].id;
          });
        });
        state.config = publicConfig({
          revision: 'provider-revision-0002',
          defaultModelId: nextDefaultModelId,
          branding: payload.branding,
          providers: nextProviders,
          webSearch: {
            enabled: candidate.webSearch.enabled,
            provider: candidate.webSearch.provider,
            configured: true,
            providers: state.config.webSearch.providers.map((current) => {
              const patch = candidate.webSearch.providers[current.id];
              return {
                ...current,
                apiKeyConfigured: patch.apiKeyAction === 'replace' || (
                  patch.apiKeyAction === 'keep' && current.apiKeyConfigured
                ),
                extractFallbackEnabled: patch.extractFallbackEnabled,
              };
            }),
          },
        });
        json(response, 200, state.config);
        return;
      }
      if (url.pathname === '/api/admin/runtime-config') {
        state.runtimeConfigRequests.push({ method: request.method, body: await requestBody(request) });
        json(response, 500, { error: 'LEGACY_ROUTE_USED', message: 'provider UI must not use the legacy route' });
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        const relative = url.pathname === '/' ? 'admin-config.html' : decodeURIComponent(url.pathname.slice(1));
        const filename = path.resolve(publicRoot, relative);
        if (filename === publicRoot || !filename.startsWith(`${publicRoot}${path.sep}`)) {
          response.writeHead(404).end();
          return;
        }
        const contents = await fsp.readFile(filename).catch(() => null);
        if (!contents) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          'content-type': contentType(filename),
          'content-length': contents.length,
          'cache-control': 'no-store',
        });
        response.end(contents);
        return;
      }
      json(response, 404, { message: 'mock route not found' });
    } catch (error) {
      json(response, 500, { message: error.message });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/admin-config.html`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function waitFor(check, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function websocketImplementation() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    return require('undici').WebSocket;
  } catch {
    return null;
  }
}

async function connectCdp(url, WebSocketImpl) {
  const socket = new WebSocketImpl(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else entry.resolve(message.result || {});
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await Promise.all([call('Page.enable'), call('Runtime.enable')]);
  return {
    call,
    close: () => socket.close(),
    async evaluate(expression) {
      const result = await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result?.value;
    },
  };
}

async function launchChrome(url, profile, WebSocketImpl) {
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--metrics-recording-only',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, url,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  chrome.stderr.on('data', (chunk) => stderr.push(chunk));
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  const port = await waitFor(async () => {
    if (chrome.exitCode !== null) throw new Error(Buffer.concat(stderr).toString('utf8').slice(-2_000));
    const value = await fsp.readFile(activePortFile, 'utf8').catch(() => '');
    return Number(value.split(/\r?\n/)[0]) || 0;
  }, 'Chrome DevTools port');
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await response.json()).find((item) => item.type === 'page' && item.url.startsWith(url));
  }, 'admin page target');
  return { chrome, cdp: await connectCdp(target.webSocketDebuggerUrl, WebSocketImpl) };
}

async function stopChrome(chrome) {
  if (!chrome || chrome.exitCode !== null) return;
  const exited = once(chrome, 'exit');
  chrome.kill('SIGTERM');
  await Promise.race([exited, delay(1_500)]);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
}

async function waitForPage(cdp, expression, description) {
  try {
    return await waitFor(() => cdp.evaluate(expression), description);
  } catch (error) {
    const snapshot = await cdp.evaluate(`({
      title: document.title,
      gate: document.querySelector('#gate-message')?.textContent,
      message: document.querySelector('#config-message')?.textContent,
      connections: document.querySelectorAll('[data-connection-card]').length,
      models: document.querySelectorAll('[data-model-row]').length,
    })`).catch(() => null);
    throw new Error(`${error.message}; page snapshot: ${JSON.stringify(snapshot)}`);
  }
}

test('headless Chrome validates a simplified Provider candidate then commits only its receipt', {
  timeout: 30_000,
}, async (t) => {
  const WebSocketImpl = websocketImplementation();
  const chromeAvailable = await fsp.access(chromePath).then(() => true, () => false);
  if (!chromeAvailable || !WebSocketImpl) {
    t.skip('Google Chrome or a WHATWG WebSocket implementation is unavailable.');
    return;
  }

  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultmind-admin-ui-chrome-'));
  const application = await createMockApplication();
  let chrome;
  let cdp;
  t.after(async () => {
    cdp?.close();
    await stopChrome(chrome);
    await application.close();
    await fsp.rm(profile, { recursive: true, force: true });
  });

  ({ chrome, cdp } = await launchChrome(application.url, profile, WebSocketImpl));
  await waitForPage(cdp, `document.querySelector('#admin-app')?.hidden === false
    && document.querySelectorAll('[data-connection-card]').length === 1
    && document.querySelectorAll('[data-model-row]').length === 1`, 'initial Provider config');
  assert.equal(await cdp.evaluate(
    `document.querySelector('[data-model-field="actualModel"]')?.value`,
  ), 'qwen3.8-max-0902');
  assert.deepEqual(await cdp.evaluate(`({
    visibleKeyActionSelects: document.querySelectorAll('select[data-connection-key-action], select[data-web-key-action], select#embedding-key-action').length,
    providerKeyVisible: !document.querySelector('[data-connection-key-field]').hidden,
    providerKeyRequired: document.querySelector('[data-connection-key]').required,
    providerKeyPlaceholder: document.querySelector('[data-connection-key]').placeholder,
  })`), {
    visibleKeyActionSelects: 0,
    providerKeyVisible: true,
    providerKeyRequired: false,
    providerKeyPlaceholder: '已配置时留空即可保留',
  });
  assert.deepEqual(await cdp.evaluate(`({
    title: document.title,
    brand: document.querySelector('#admin-brand-name')?.textContent,
    heading: document.querySelector('#admin-page-title')?.textContent,
    vault: document.querySelector('#admin-vault-name')?.textContent,
    source: document.querySelector('#config-source-label')?.textContent,
  })`), {
    title: 'Provider 配置 · Private Research Desk',
    brand: 'Private Research Desk',
    heading: 'Private Research Desk 配置',
    vault: 'Private Family Vault',
    source: 'Provider API',
  });

  assert.deepEqual(await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-model-row]');
    return {
      summary: row.querySelector('[data-model-reasoning-summary]').textContent,
      gridHidden: row.querySelector('[data-model-reasoning-grid]').hidden,
      tiers: Object.fromEntries([...row.querySelectorAll('[data-model-reasoning-tier]')]
        .map((select) => [select.dataset.modelReasoningTier, {
          value: select.value,
          options: [...select.options].map((option) => option.value),
        }])),
      effective: row.querySelector('[data-model-reasoning-effective]').textContent,
    };
  })()`), {
    summary: '自动（推荐）',
    gridHidden: true,
    tiers: Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => [
      effort,
      { value: effort, options: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ])),
    effective: '当前自动映射：低→低，中→中，高→高，极高→极高，最大→极高',
  });

  await cdp.evaluate(`(() => {
    window.confirm = () => true;
    document.querySelector('#admin-password').value = 'admin-browser-password';
    const row = document.querySelector('[data-model-row]');
    const manual = row.querySelector('[data-model-reasoning-manual]');
    manual.checked = true;
    manual.dispatchEvent(new Event('change', { bubbles: true }));
    const mappings = { low: 'default', medium: 'low', high: 'high', xhigh: 'high', max: 'max' };
    for (const [tier, value] of Object.entries(mappings)) {
      const select = row.querySelector('[data-model-reasoning-tier="' + tier + '"]');
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelector('[data-connection-check]').click();
    return true;
  })()`);
  await waitFor(() => application.state.targetCheckBodies.length === 1, 'provider-scoped connection check');
  await waitForPage(cdp, `document.querySelector('[data-model-check-state]')?.textContent === '联网实测通过'
    && document.querySelector('#config-message')?.textContent.includes('未调用 WebSearch')`, 'provider-scoped check result');
  const targetCheck = application.state.targetCheckBodies[0];
  assert.equal(targetCheck.validateProviderIndex, 0);
  assert.equal('validationStageId' in targetCheck, false);
  assert.ok(targetCheck.webSearch, 'the first card check must stage the complete candidate');
  assert.equal(targetCheck.providers.length, 1);
  assert.equal(targetCheck.providers[0].apiKeyAction, 'keep', 'a blank configured Provider key must be preserved');
  assert.equal('apiKey' in targetCheck.providers[0], false);
  assert.deepEqual(targetCheck.providers[0].models[0].reasoningMapping, {
    mode: 'manual',
    tiers: { low: 'default', medium: 'low', high: 'high', xhigh: 'high', max: 'max' },
  });
  assert.equal(application.state.commitBodies.length, 0);
  assert.equal(application.state.webValidationCalls, 0);
  assert.deepEqual(application.state.requestSequence, ['target-check-start']);
  assert.equal(await cdp.evaluate(
    `[...document.querySelectorAll('input[type="password"]')].every((input) => input.value === '')`,
  ), true);

  await cdp.evaluate(`(() => {
    window.confirm = () => true;
    const setInput = (selector, value) => {
      const field = document.querySelector(selector);
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setInput('#branding-app-name', 'Browser Private Desk');
    setInput('#branding-vault-label', 'Browser Private Vault');
    const preset = document.querySelector('#connection-preset');
    preset.value = 'deepseek';
    preset.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#connection-add').click();
    return true;
  })()`);
  await waitForPage(cdp, `document.querySelectorAll('[data-connection-card]').length === 2`, 'new DeepSeek connection');
  const providerPresentation = await cdp.evaluate(`(() => {
    const connection = [...document.querySelectorAll('[data-connection-card]')].at(-1);
    return {
      provider: connection.querySelector('[data-provider-preset]').value,
      apiBase: connection.querySelector('[data-connection-field="apiBase"]').value,
      endpoint: connection.querySelector('[data-provider-endpoint]').textContent,
      docs: connection.querySelector('[data-provider-docs]').href,
      advancedHidden: connection.querySelector('[data-provider-advanced]').hidden,
      keyVisible: !connection.querySelector('[data-connection-key-field]').hidden,
      keyRequired: connection.querySelector('[data-connection-key]').required,
    };
  })()`);
  assert.deepEqual(providerPresentation, {
    provider: 'deepseek',
    apiBase: 'https://api.deepseek.com',
    endpoint: 'https://api.deepseek.com/chat/completions',
    docs: 'https://api-docs.deepseek.com/zh-cn/',
    advancedHidden: true,
    keyVisible: true,
    keyRequired: true,
  });

  await cdp.evaluate(`(() => {
    const connections = [...document.querySelectorAll('[data-connection-card]')];
    const connection = connections.at(-1);
    const deepseekConnectionId = connection.querySelector('[data-connection-field="id"]').value;
    connection.querySelector('[data-connection-key]').value = 'deepseek-browser-secret';
    connection.querySelector('[data-connection-key]').dispatchEvent(new Event('input', { bubbles: true }));

    document.querySelector('#model-add').click();
    const second = [...document.querySelectorAll('[data-model-row]')].at(-1);
    const set = (row, name, value, type = 'input') => {
      const field = row.querySelector('[data-model-field="' + name + '"]');
      field.value = value;
      field.dispatchEvent(new Event(type, { bubbles: true }));
    };
    set(second, 'connectionId', deepseekConnectionId, 'change');
    set(second, 'actualModel', 'deepseek-chat-browser');
    set(second, 'displayName', 'DeepSeek Browser');

    document.querySelector('#model-add').click();
    const third = [...document.querySelectorAll('[data-model-row]')].at(-1);
    set(third, 'connectionId', deepseekConnectionId, 'change');
    set(third, 'actualModel', 'deepseek-reasoner-browser');
    set(third, 'displayName', '');
    third.querySelector('[data-model-default]').click();

    const tavilyRadio = document.querySelector('input[name="web-provider"][value="tavily-rest"]');
    tavilyRadio.checked = true;
    tavilyRadio.dispatchEvent(new Event('change', { bubbles: true }));
    const webEnabled = document.querySelector('#web-enabled');
    webEnabled.checked = true;
    webEnabled.dispatchEvent(new Event('change', { bubbles: true }));
    const tavily = document.querySelector('[data-web-provider-panel="tavily-rest"]');
    const tavilyKey = tavily.querySelector('[data-web-key]');
    tavilyKey.value = 'tavily-browser-secret';
    tavilyKey.dispatchEvent(new Event('input', { bubbles: true }));

    // A fourth model must be rejected client-side; the simplified UI supports at most three.
    document.querySelector('#model-add').click();
    document.querySelector('#admin-password').value = 'admin-browser-password';
    connection.querySelector('[data-connection-check]').click();
    return true;
  })()`);

  await waitFor(() => application.state.targetCheckBodies.length === 2, 'new Provider staged check');
  await waitForPage(cdp, `[...document.querySelectorAll('[data-connection-card]')].at(-1)
    .querySelector('[data-connection-check]').textContent === '本轮已检查'
    && document.querySelector('#config-message')?.textContent.includes('最终保存不会重复检查本卡')`, 'new Provider staged result');
  assert.equal(await cdp.evaluate(`(() => {
    const connection = [...document.querySelectorAll('[data-connection-card]')].at(-1);
    const connectionId = connection.querySelector('[data-connection-field="id"]').value;
    return [...document.querySelectorAll('[data-model-row]')]
      .filter((row) => row.querySelector('[data-model-field="connectionId"]').value === connectionId)
      .every((row) => row.querySelector('[data-model-check-state]').textContent === '联网实测通过');
  })()`), true, 'server-assigned model IDs must map back to the unsaved Provider rows');
  assert.equal(await cdp.evaluate(
    `[...document.querySelectorAll('input[type="password"]')].every((input) => input.value === '')`,
  ), true, 'the staged candidate must survive after browser secret fields are cleared');

  const candidate = application.state.targetCheckBodies[1];
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.expectedRevision, 'provider-revision-0001');
  assert.equal(candidate.adminPassword, 'admin-browser-password');
  assert.equal(candidate.validateProviderIndex, 1);
  assert.equal('validationStageId' in candidate, false);
  assert.equal(candidate.providers.length, 2);
  assert.deepEqual(candidate.providers.map((provider) => provider.providerId), ['bailian', 'deepseek']);
  assert.equal(candidate.providers[1].apiBase, 'https://api.deepseek.com');
  assert.equal(candidate.providers[1].apiKeyAction, 'replace');
  assert.equal(candidate.providers[1].apiKey, 'deepseek-browser-secret');
  assert.equal(candidate.providers[1].models.length, 2);
  assert.deepEqual(candidate.providers[1].models.map((model) => model.actualModel), [
    'deepseek-chat-browser',
    'deepseek-reasoner-browser',
  ]);
  assert.deepEqual(candidate.providers.flatMap((provider) => provider.models).map((model) => model.default), [
    false,
    false,
    true,
  ]);
  assert.equal(candidate.providers.flatMap((provider) => provider.models).length, 3);
  assert.ok(candidate.webSearch);
  assert.equal(candidate.webSearch.enabled, true);
  assert.equal(candidate.webSearch.provider, 'tavily-rest');
  assert.equal(candidate.webSearch.providers['bailian-mcp'].apiKeyAction, 'keep');
  assert.equal(candidate.webSearch.providers['tavily-rest'].apiKeyAction, 'replace');
  assert.equal(candidate.webSearch.providers['tavily-rest'].apiKey, 'tavily-browser-secret');
  assert.equal(candidate.providers[1].id, undefined, 'new Provider internal ID is assigned server-side');
  for (const model of candidate.providers[1].models) {
    assert.equal(model.id, undefined, 'new model internal ID is assigned server-side');
    assert.equal('requestProfile' in model, false);
    assert.equal('efforts' in model, false);
    assert.equal('defaultEffort' in model, false);
    assert.equal('shortLabel' in model, false);
    assert.deepEqual(model.reasoningMapping, { mode: 'auto' });
    assert.equal('effortMapping' in model, false);
    assert.equal('automaticEffortMapping' in model, false);
  }

  assert.equal(application.state.webValidationCalls, 0, 'single-card checks must not call WebSearch');
  const currentStageId = application.state.validationStage.token;
  const modelCallsAfterNewProvider = application.state.validationModelCalls.length;
  await cdp.evaluate(`(() => {
    document.querySelector('#admin-password').value = 'admin-browser-password';
    document.querySelector('[data-connection-card] [data-connection-check]').click();
    return true;
  })()`);
  await waitFor(() => application.state.targetCheckBodies.length === 3, 'second staged Provider check');
  const resumedCheck = application.state.targetCheckBodies[2];
  assert.deepEqual(Object.keys(resumedCheck).sort(), [
    'adminPassword',
    'expectedRevision',
    'schemaVersion',
    'validateProviderIndex',
    'validationStageId',
  ]);
  assert.equal(resumedCheck.validationStageId, currentStageId);
  assert.equal(resumedCheck.validateProviderIndex, 0);
  assert.equal('providers' in resumedCheck, false);
  assert.equal('webSearch' in resumedCheck, false);
  assert.equal(application.state.validationModelCalls.length, modelCallsAfterNewProvider + 1);
  assert.equal(application.state.webValidationCalls, 0);
  await waitForPage(cdp, `[...document.querySelectorAll('[data-connection-check]')]
    .every((button) => button.textContent === '本轮已检查')
    && document.querySelector('#config-save').disabled === false`, 'all staged checks to settle');

  const modelCallsBeforeFinalValidation = application.state.validationModelCalls.length;
  await cdp.evaluate(`(() => {
    document.querySelector('#admin-password').value = 'admin-browser-password';
    document.querySelector('#config-save').click();
    return true;
  })()`);
  await waitFor(() => application.state.fullValidateBodies.length === 1, 'remaining Provider and WebSearch validation');
  await waitFor(() => application.state.commitBodies.length === 1, 'Provider receipt commit');
  const finalValidation = application.state.fullValidateBodies[0];
  assert.deepEqual(Object.keys(finalValidation).sort(), [
    'adminPassword',
    'expectedRevision',
    'schemaVersion',
    'validationStageId',
  ]);
  assert.equal(finalValidation.validationStageId, currentStageId);
  assert.equal(application.state.validationModelCalls.length, modelCallsBeforeFinalValidation,
    'final validation must not repeat an already checked Provider model');
  assert.equal(application.state.webValidationCalls, 1);

  const commit = application.state.commitBodies[0];
  assert.deepEqual(Object.keys(commit).sort(), [
    'adminPassword',
    'branding',
    'expectedRevision',
    'schemaVersion',
    'validationId',
  ]);
  assert.equal(commit.schemaVersion, 1);
  assert.equal(commit.expectedRevision, 'provider-revision-0001');
  assert.equal(commit.validationId, 'validation-browser-0001');
  assert.equal(commit.adminPassword, 'admin-browser-password');
  assert.deepEqual(commit.branding, {
    appName: 'Browser Private Desk',
    vaultLabel: 'Browser Private Vault',
  });
  assert.equal('providers' in commit, false);
  assert.equal('webSearch' in commit, false);
  assert.equal(JSON.stringify(commit).includes('deepseek-browser-secret'), false);
  assert.equal(JSON.stringify(commit).includes('tavily-browser-secret'), false);
  assert.deepEqual(application.state.requestSequence, [
    'target-check-start',
    'target-check-start',
    'target-check-staged',
    'validate',
    'commit',
  ]);
  assert.deepEqual(application.state.runtimeConfigRequests, []);

  await waitForPage(cdp, `document.querySelector('#config-revision')?.textContent === 'provider-revision-0002'
    && document.querySelectorAll('[data-model-row]').length === 3`, 'saved Provider response');
  assert.deepEqual(await cdp.evaluate(`({
    title: document.title,
    brand: document.querySelector('#admin-brand-name')?.textContent,
    heading: document.querySelector('#admin-page-title')?.textContent,
    vault: document.querySelector('#admin-vault-name')?.textContent,
    models: document.querySelectorAll('[data-model-row]').length,
    addDisabled: document.querySelector('#model-add').disabled,
  })`), {
    title: 'Provider 配置 · Browser Private Desk',
    brand: 'Browser Private Desk',
    heading: 'Browser Private Desk 配置',
    vault: 'Browser Private Vault',
    models: 3,
    addDisabled: true,
  });
  assert.equal(await cdp.evaluate(
    `[...document.querySelectorAll('input[type="password"]')].every((input) => input.value === '')`,
  ), true);
  assert.equal(await cdp.evaluate(
    `[...document.querySelectorAll('[data-model-row]')].at(-1).querySelector('[data-model-default]').checked`,
  ), true);
  assert.deepEqual(await cdp.evaluate('Object.entries(localStorage)'), []);

  await cdp.evaluate(`(() => {
    const title = document.querySelector('#branding-app-name');
    title.value = 'Branding Only Desk';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#admin-password').value = 'admin-browser-password';
    document.querySelector('#config-save').click();
    return true;
  })()`);
  await waitFor(() => application.state.commitBodies.length === 2, 'branding-only receipt-free commit');
  await waitForPage(cdp, `document.querySelector('#config-revision')?.textContent === 'provider-revision-0003'`, 'branding-only response');
  assert.equal(application.state.fullValidateBodies.length, 1, 'branding-only save must not call full validation');
  assert.equal(application.state.targetCheckBodies.length, 3, 'branding-only save must not call a target check');
  assert.deepEqual(Object.keys(application.state.commitBodies[1]).sort(), [
    'adminPassword',
    'branding',
    'expectedRevision',
    'schemaVersion',
  ]);
  assert.equal(application.state.commitBodies[1].branding.appName, 'Branding Only Desk');
  assert.deepEqual(application.state.requestSequence, [
    'target-check-start',
    'target-check-start',
    'target-check-staged',
    'validate',
    'commit',
    'commit',
  ]);

  assert.deepEqual(await cdp.evaluate(`(() => {
    window.confirm = () => true;
    const providers = [...document.querySelectorAll('[data-connection-card]')];
    const removedId = providers.at(-1).querySelector('[data-connection-field="id"]').value;
    providers.at(-1).querySelector('[data-connection-delete]').click();
    return {
      providers: document.querySelectorAll('[data-connection-card]').length,
      models: document.querySelectorAll('[data-model-row]').length,
      removedModelReferences: [...document.querySelectorAll('[data-model-field="connectionId"]')]
        .filter((field) => field.value === removedId).length,
    };
  })()`), {
    providers: 1,
    models: 1,
    removedModelReferences: 0,
  }, 'deleting a Provider must also remove its models and private credential binding');
});
