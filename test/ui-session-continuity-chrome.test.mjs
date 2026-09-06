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
import { sourceBrowser } from './source-browser-helper.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const chromePath = path.resolve(process.env.SECOND_MIND_TEST_CHROME || '/usr/bin/google-chrome');
const streamedMathAnswer = String.raw`公式：

[M_{\text{train}} = 16P]

其中 \(P\) 是参数量。`;

const conversations = [
  {
    id: 'qa-new-7f3a19c8',
    kind: 'qa',
    title: '甲州投控集团董事长是谁',
    taskMode: 'normal',
    model: 'qwen',
    effort: 'xhigh',
    webSearch: false,
    updatedAt: '2026-09-02T08:00:00.000Z',
    messages: [
      { role: 'user', text: '甲州投控集团董事长是谁' },
      { role: 'assistant', text: '新会话的可核验回答' },
    ],
  },
  {
    id: 'qa-old-28bd63e1',
    kind: 'qa',
    title: '旧会话标题',
    taskMode: 'normal',
    model: 'qwen',
    effort: 'xhigh',
    webSearch: false,
    updatedAt: '2026-09-01T08:00:00.000Z',
    messages: [
      { role: 'user', text: '旧会话问题' },
      { role: 'assistant', text: '旧会话的可核验回答' },
    ],
  },
];

const statusPayload = {
  available: true,
  knowledgeBaseId: 'default',
  knowledgeBaseRevision: 'browser-fixture-1',
  taskContractVersion: 2,
  capabilities: { modelCatalogRevision: true },
  buildRevision: 'knowledge-ui-2.1.7',
  modelCatalogRevision: 'a'.repeat(64),
  appName: 'Second Mind UI Test',
  vaultLabel: '本地测试库',
  timezone: 'Asia/Shanghai',
  sync: { provider: 'mock', connected: true },
  activeTask: null,
  models: [
    {
      id: 'qwen', label: 'Qwen Test', shortLabel: 'Qwen', actualModel: 'qwen-test',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh', available: true,
      effortMapping: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
    },
    {
      id: 'kimi', label: 'Kimi Test', shortLabel: 'Kimi', actualModel: 'kimi-test',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', available: true,
      effortMapping: { low: 'default', medium: 'default', high: 'default', xhigh: 'default', max: 'default' },
    },
  ],
  efforts: [
    { id: 'low', label: 'low' },
    { id: 'medium', label: 'medium' },
    { id: 'high', label: 'high' },
    { id: 'xhigh', label: 'xhigh' },
    { id: 'max', label: 'max' },
  ],
  taskModes: [
    { id: 'normal', label: '普通', description: '单路检索。' },
    { id: 'deep', label: '深度', description: '多路检索。' },
  ],
  webSearch: {
    enabled: true, configured: true, provider: 'bailian-mcp', fallbackConfigured: false,
  },
  attachmentLimits: {
    count: 8, bytesPerAttachment: 5 * 1024 * 1024, totalBytes: 15 * 1024 * 1024,
  },
  speechTranscription: { available: false },
};

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
  if (filename.endsWith('.js') || filename.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filename.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function createMockApplication(options = {}) {
  const state = {
    authenticated: false,
    taskBodies: [],
    taskCounter: 0,
    conversations: structuredClone(conversations),
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/session') {
        json(response, 200, state.authenticated
          ? {
              authenticated: true,
              user: { username: 'browser-test-user' },
              permissions: { useKnowledge: true },
            }
          : { authenticated: false, permissions: {} });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/login') {
        const payload = JSON.parse(await requestBody(request));
        if (payload.username !== 'browser-test-user' || payload.password !== 'local-test-password') {
          json(response, 401, { message: '账号或密码错误。' });
          return;
        }
        state.authenticated = true;
        json(response, 200, { authenticated: true });
        return;
      }
      if (!state.authenticated && url.pathname.startsWith('/api/')) {
        json(response, 401, { message: '未登录。' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/knowledge/bases') {
        if (options.missingBases) {
          json(response, 404, { error: 'NOT_FOUND', message: 'API route not found.' });
          return;
        }
        json(response, 200, {
          revision: 'browser-registry-1',
          defaultKnowledgeBaseId: 'default',
          readyCount: 1,
          enabledCount: 1,
          knowledgeBases: [{
            knowledgeBaseId: 'default',
            name: '本地测试库',
            enabled: true,
            default: true,
            revision: 'browser-fixture-1',
            status: 'ready',
            retrieval: { ready: true, mode: 'keyword', documentCount: 2 },
          }],
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/knowledge/status') {
        json(response, 200, statusPayload);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/knowledge/conversations') {
        json(response, 200, {
          conversations: state.conversations.map(({ messages: _messages, ...item }) => item),
        });
        return;
      }
      const conversationMatch = /^\/api\/knowledge\/conversations\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && conversationMatch) {
        const id = decodeURIComponent(conversationMatch[1]);
        const conversation = state.conversations.find((item) => item.id === id);
        json(response, conversation ? 200 : 404, conversation || { message: '会话不存在。' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/knowledge/tasks') {
        const payload = JSON.parse(await requestBody(request));
        state.taskBodies.push(payload);
        state.taskCounter += 1;
        const taskId = `local-task-${state.taskCounter}`;
        const conversationId = payload.forkFromConversationId
          ? `qa-fork-${state.taskCounter}`
          : payload.conversationId || `qa-created-${state.taskCounter}`;
        if (!state.conversations.some((item) => item.id === conversationId)) {
          state.conversations.unshift({
            id: conversationId,
            kind: 'qa',
            title: payload.prompt,
            taskMode: payload.taskMode,
            model: payload.model,
            effort: payload.effort,
            webSearch: payload.webSearch,
            updatedAt: new Date().toISOString(),
            messages: [
              { role: 'user', text: payload.prompt },
              { role: 'assistant', text: '本地 mock 回答' },
            ],
          });
        }
        json(response, 202, { taskId, conversationId });
        return;
      }
      const eventsMatch = /^\/api\/knowledge\/tasks\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === 'GET' && eventsMatch) {
        const taskBody = state.taskBodies.at(-1) || {};
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        response.write(`event: state\ndata: ${JSON.stringify({ message: '本地 mock 任务' })}\n\n`);
        response.write(`event: session\ndata: ${JSON.stringify({
          taskMode: taskBody.taskMode,
          model: taskBody.model,
          effort: taskBody.effort,
          requestedEffort: taskBody.effort,
          effectiveEffort: taskBody.model === 'kimi' ? 'default' : taskBody.effort,
        })}\n\n`);
        response.write(`id: 3\nevent: activity\ndata: ${JSON.stringify({
          title: '正在检索知识库',
          message: '正在执行可核验的本地检索。',
          toolName: 'vault_search',
          stage: 'start',
        })}\n\n`);
        response.write(`id: 4\nevent: usage\ndata: ${JSON.stringify({
          scope: 'call',
          callId: 'final-generation',
          usage: {
            inputTokens: 120,
            outputTokens: 5,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 10,
            reasoningTokens: null,
            totalTokens: 125,
          },
        })}\n\n`);
        response.write(`event: text\ndata: ${JSON.stringify({ text: '即将由最终核验内容替换' })}\n\n`);
        response.write(`event: text_replace\ndata: ${JSON.stringify({ text: streamedMathAnswer })}\n\n`);
        response.write(`id: 6\nevent: usage\ndata: ${JSON.stringify({
          scope: 'call',
          callId: 'final-generation',
          usage: {
            inputTokens: 120,
            outputTokens: 9,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 10,
            reasoningTokens: null,
            totalTokens: 129,
          },
        })}\n\n`);
        response.write(`event: done\ndata: ${JSON.stringify({ status: 'completed', message: '已完成' })}\n\n`);
        response.end();
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
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
      json(response, 404, { message: '本地 mock 路由不存在。' });
    } catch (error) {
      json(response, 500, { message: error.message });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    state,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

test('new frontend explains a missing legacy backend route and offers reconnection', { timeout: 20_000 }, async (t) => {
  const application = await createMockApplication({ missingBases: true });
  application.state.authenticated = true;
  t.after(() => application.close());
  const browser = await sourceBrowser(t, application.url);
  if (!browser) return;
  await browser.waitFor("document.querySelector('#knowledge-gate-message')?.textContent.includes('重启知识库服务')");
  assert.equal(await browser.evaluate("document.querySelector('#knowledge-app').hidden"), true);
  assert.equal(await browser.evaluate("document.querySelector('#knowledge-gate').textContent.includes('API route not found.')"), false);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#knowledge-gate button')].some(b=>!b.hidden && b.textContent.includes('重新连接'))"), true);
});

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
    // Node 22 exposes WebSocket globally. Ubuntu's Node 20 package exposes the same
    // WHATWG implementation through undici, which keeps this real-browser test runnable.
    return require('undici').WebSocket;
  } catch {
    return null;
  }
}

function boundCdpSetup(promise, description) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 8_000);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function launchChrome(url, profile, WebSocketImpl) {
  const stderr = [];
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    url,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let spawnError = null;
  chrome.once('error', (error) => { spawnError = error; });
  chrome.stderr.on('data', (chunk) => {
    if (stderr.reduce((sum, item) => sum + item.length, 0) < 32 * 1024) stderr.push(chunk);
  });
  try {
    const activePortFile = path.join(profile, 'DevToolsActivePort');
    const port = await waitFor(async () => {
      if (spawnError) throw new Error(`Chrome could not start (${spawnError.code || 'spawn error'}).`);
      if (chrome.exitCode !== null || chrome.signalCode !== null) {
        throw new Error(`Chrome exited ${chrome.exitCode}: ${Buffer.concat(stderr).toString('utf8').slice(-2_000)}`);
      }
      const value = await fsp.readFile(activePortFile, 'utf8').catch(() => '');
      return Number(value.split(/\r?\n/)[0]) || 0;
    }, 'Chrome DevTools port');
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.url.startsWith(url));
    }, 'application page target');
    return {
      chrome,
      cdp: await connectCdp(target.webSocketDebuggerUrl, WebSocketImpl),
    };
  } catch (error) {
    await stopChrome(chrome).catch(() => {});
    throw error;
  }
}

async function stopChrome(chrome) {
  if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null || !chrome.pid) return;
  const exited = once(chrome, 'exit');
  chrome.kill('SIGTERM');
  await Promise.race([exited, delay(1_500)]);
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGKILL');
    await Promise.race([once(chrome, 'exit'), delay(1_500)]);
  }
}

async function connectCdp(url, WebSocketImpl) {
  const socket = new WebSocketImpl(url);
  try {
    await boundCdpSetup(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }), 'Chrome DevTools connection');
  } catch (error) {
    try { socket.close(); } catch {}
    throw error;
  }
  let nextId = 0;
  const pending = new Map();
  const rejectPending = () => {
    for (const entry of pending.values()) {
      entry.reject(new Error('Chrome DevTools connection closed.'));
    }
    pending.clear();
  };
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('error', rejectPending);
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
    else resolve(message.result || {});
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for Chrome DevTools ${method}.`));
    }, 8_000);
    timer.unref?.();
    const entry = {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    };
    pending.set(id, entry);
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      pending.delete(id);
      entry.reject(error);
    }
  });
  try {
    await boundCdpSetup(
      Promise.all([call('Page.enable'), call('Runtime.enable')]),
      'Chrome DevTools initialization',
    );
  } catch (error) {
    try { socket.close(); } catch {}
    throw error;
  }
  return {
    call,
    close() {
      rejectPending();
      try { socket.close(); } catch {}
    },
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

async function waitForPage(cdp, expression, description) {
  try {
    return await waitFor(() => cdp.evaluate(expression), description);
  } catch (error) {
    const snapshot = await cdp.evaluate(`({
      url: location.href,
      title: document.title,
      gate: document.querySelector('#knowledge-gate-message')?.textContent,
      loginError: document.querySelector('#knowledge-login-error')?.textContent,
      formError: document.querySelector('#knowledge-error')?.textContent,
      continuation: document.querySelector('#knowledge-continuation-status')?.textContent,
      continuationHidden: document.querySelector('#knowledge-continuation-status')?.hidden,
      transcript: document.querySelector('#knowledge-transcript')?.textContent?.slice(0, 500),
    })`).catch(() => null);
    throw new Error(`${error.message}; page snapshot: ${JSON.stringify(snapshot)}`);
  }
}

async function selectValue(cdp, selector, value) {
  return cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function reloadPage(cdp, marker) {
  const token = `vaultmind-reload-${marker}`;
  await cdp.evaluate(`(() => {
    window.__vaultmindTestReloadMarker = ${JSON.stringify(token)};
    return true;
  })()`);
  await cdp.call('Page.reload', { ignoreCache: true });
  await waitForPage(
    cdp,
    `window.__vaultmindTestReloadMarker !== ${JSON.stringify(token)}
      && document.readyState !== 'loading'`,
    `${marker} navigation`,
  );
}

async function submitPrompt(cdp, prompt) {
  return cdp.evaluate(`(() => {
    const prompt = document.querySelector('#knowledge-prompt');
    const form = document.querySelector('#knowledge-form');
    if (!prompt || !form) return false;
    prompt.value = ${JSON.stringify(prompt)};
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
    return true;
  })()`);
}

test('headless Chrome preserves explicit UI conversation continuity and fork semantics', {
  timeout: 60_000,
}, async (t) => {
  const WebSocketImpl = websocketImplementation();
  const chromeAvailable = await fsp.access(chromePath).then(() => true, () => false);
  if (!chromeAvailable || !WebSocketImpl) {
    t.skip('Google Chrome or a WHATWG WebSocket implementation is unavailable.');
    return;
  }

  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultmind-ui-chrome-'));
  const application = await createMockApplication();
  let chrome;
  let cdp;
  t.after(async () => {
    cdp?.close();
    await stopChrome(chrome);
    await application.close();
    // Chromium helpers can finish their profile writes just after the main
    // process exits. Retry transient ENOTEMPTY instead of failing passed UI assertions.
    await fsp.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  ({ chrome, cdp } = await launchChrome(application.url, profile, WebSocketImpl));
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-login-form')?.hidden === false`,
    'login form',
  );
  await cdp.evaluate(`(() => {
    document.querySelector('#knowledge-username').value = 'browser-test-user';
    document.querySelector('#knowledge-password').value = 'local-test-password';
    document.querySelector('#knowledge-login-form').requestSubmit();
    return true;
  })()`);

  const newestTitle = conversations[0].title;
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-continuation-status')?.textContent === ${JSON.stringify(`正在继续：${newestTitle}`)}`,
    'newest QA conversation restore after login',
  );
  assert.equal(await cdp.evaluate(
    `document.querySelector('#knowledge-transcript')?.textContent.includes('新会话的可核验回答')`,
  ), true);
  const initialStorage = await cdp.evaluate('Object.entries(localStorage)');
  assert.deepEqual(initialStorage.sort(), [
    ['second-mind:selected-knowledge-base:v1:browser-test-user', 'default'],
    ['vaultmind:selected-conversation:v2:browser-test-user:default', conversations[0].id],
  ]);
  assert.doesNotMatch(initialStorage[0][1], /甲州|回答|[{}\[\]]/u);
  const initialEffortUi = await cdp.evaluate(`(() => ({
    values: [...document.querySelector('#knowledge-effort').options].map((option) => option.value),
    labels: [...document.querySelector('#knowledge-effort').options].map((option) => option.textContent),
  }))()`);
  assert.deepEqual(initialEffortUi.values, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(initialEffortUi.labels.at(-1), '最大（实际：极高）');

  await cdp.evaluate("document.querySelector('#knowledge-new-conversation').click(); true");
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-continuation-status')?.hidden === true
      && document.querySelector('#knowledge-transcript')?.classList.contains('is-welcome')`,
    'explicit new conversation state',
  );
  assert.equal(await cdp.evaluate(
    `localStorage.getItem('vaultmind:selected-conversation:v2:browser-test-user:default')`,
  ), '__new_conversation__');
  await reloadPage(cdp, 'explicit-new-state');
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-app')?.hidden === false
      && document.querySelector('#knowledge-gate')?.hidden === true
      && document.querySelector('#knowledge-continuation-status')?.hidden === true
      && document.querySelector('#knowledge-transcript')?.classList.contains('is-welcome')
      && [...document.querySelectorAll('.knowledge-conversation-open')]
        .some((item) => item.textContent.includes(${JSON.stringify(conversations[1].title)}))`,
    'explicit new conversation state after refresh',
  );

  const oldTitle = conversations[1].title;
  // The status poll can replace the conversation-list DOM between a separate
  // presence assertion and click. Locate and click within the same retryable
  // browser expression so this test observes the UI behavior, not a redraw race.
  await waitForPage(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('.knowledge-conversation-open')]
        .find((item) => item.textContent.includes(${JSON.stringify(oldTitle)}));
      if (!button) return false;
      button.click();
      return true;
    })()`,
    'old conversation button click',
  );
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-continuation-status')?.textContent === ${JSON.stringify(`正在继续：${oldTitle}`)}`,
    'old conversation selection',
  );
  assert.equal(await cdp.evaluate(
    `localStorage.getItem('vaultmind:selected-conversation:v2:browser-test-user:default')`,
  ), conversations[1].id);
  await reloadPage(cdp, 'selected-conversation');
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-continuation-status')?.textContent === ${JSON.stringify(`正在继续：${oldTitle}`)}
      && document.querySelector('#knowledge-transcript')?.textContent.includes('旧会话的可核验回答')`,
    'old conversation restore after refresh',
  );

  assert.equal(await selectValue(cdp, '#knowledge-effort', 'high'), true);
  await waitForPage(cdp, `document.querySelector('#knowledge-continuation-status')?.dataset.state === 'fork'`, 'effort fork notice');
  assert.equal(await selectValue(cdp, '#knowledge-effort', 'xhigh'), true);
  await waitForPage(cdp, `document.querySelector('#knowledge-continuation-status')?.dataset.state === 'continue'`, 'effort fork cancellation');
  await cdp.evaluate("document.querySelector('#knowledge-web-search').click(); true");
  await waitForPage(cdp, `document.querySelector('#knowledge-continuation-status')?.dataset.state === 'fork'`, 'web-search fork notice');
  await cdp.evaluate("document.querySelector('#knowledge-web-search').click(); true");
  await waitForPage(cdp, `document.querySelector('#knowledge-continuation-status')?.dataset.state === 'continue'`, 'web-search fork cancellation');
  assert.equal(await selectValue(cdp, '#knowledge-model', 'kimi'), true);
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-continuation-status')?.textContent === ${JSON.stringify(`将从“${oldTitle}”派生新会话并保留上下文`)}`,
    'model fork notice',
  );
  const kimiEffortUi = await cdp.evaluate(`(() => ({
    values: [...document.querySelector('#knowledge-effort').options].map((option) => option.value),
    labels: [...document.querySelector('#knowledge-effort').options].map((option) => option.textContent),
    selected: document.querySelector('#knowledge-effort').value,
  }))()`);
  assert.deepEqual(kimiEffortUi.values, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(kimiEffortUi.labels.every((label) => label.endsWith('（模型默认）')));
  assert.equal(kimiEffortUi.selected, 'xhigh', 'switching models preserves the universal requested tier');
  assert.equal(await selectValue(cdp, '#knowledge-effort', 'max'), true);
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-model-description')?.textContent.includes('当前“最大”由模型默认策略处理')`,
    'effective effort mapping description',
  );
  assert.equal(await submitPrompt(cdp, '固定设置派生测试'), true);
  await waitFor(() => application.state.taskBodies.length === 1, 'fork task request');
  assert.equal(application.state.taskBodies[0].forkFromConversationId, conversations[1].id);
  assert.equal(Object.hasOwn(application.state.taskBodies[0], 'conversationId'), false);
  assert.equal(application.state.taskBodies[0].modelCatalogRevision, statusPayload.modelCatalogRevision);
  assert.equal(application.state.taskBodies[0].effort, 'max');
  await waitForPage(cdp, `document.querySelector('#knowledge-send')?.hidden === false`, 'fork task completion');
  const processDashboard = await cdp.evaluate(`(() => ({
    open: document.querySelector('.knowledge-process')?.open,
    phases: [...document.querySelectorAll('.knowledge-process-phase')].map((node) => ({
      phase: node.dataset.phase,
      state: node.dataset.state,
    })),
    groups: document.querySelectorAll('.knowledge-process-group').length,
    tokenBadge: document.querySelector('.knowledge-process-token-badge')?.textContent,
    usageStatus: document.querySelector('.knowledge-process-telemetry-primary:nth-child(2) strong')?.textContent,
    usage: Object.fromEntries([...document.querySelectorAll('[data-usage-value]')]
      .map((node) => [node.dataset.usageValue, node.textContent])),
    privacy: document.querySelector('.knowledge-process-body > p')?.textContent,
  }))()`);
  assert.equal(processDashboard.open, true, 'final telemetry remains visible until the user collapses it');
  assert.deepEqual(processDashboard.phases, [
    { phase: 'prepare', state: 'done' },
    { phase: 'research', state: 'done' },
    { phase: 'answer', state: 'done' },
  ]);
  assert.equal(processDashboard.groups, 3);
  assert.equal(processDashboard.tokenBadge, 'Token：129');
  assert.equal(processDashboard.usageStatus, '最终供应商统计 · 1/1 次调用');
  assert.deepEqual(processDashboard.usage, {
    inputTokens: '120',
    outputTokens: '9',
    cacheReadTokens: '40',
    cacheWriteTokens: '10',
    reasoningTokens: '—',
    totalTokens: '129',
  });
  assert.match(processDashboard.privacy, /不展示模型的隐藏内部推理/);
  assert.equal(await cdp.evaluate(
    `document.querySelector('.knowledge-process')?.textContent.includes('思考强度：最大 → 模型默认')`,
  ), true);
  const renderedMath = await cdp.evaluate(`(() => {
    const answers = [...document.querySelectorAll('.knowledge-message.assistant .knowledge-message-content')];
    const answer = answers.at(-1);
    return {
      display: Boolean(answer?.querySelector('.katex-display')),
      inline: [...(answer?.querySelectorAll('.katex') || [])]
        .some((node) => !node.closest('.katex-display')),
      rawDisplay: answer?.textContent.includes('\\\\['),
      rawInline: answer?.textContent.includes('\\\\('),
      preliminary: answer?.textContent.includes('即将由最终核验内容替换'),
    };
  })()`);
  assert.equal(renderedMath.display, true);
  assert.equal(renderedMath.inline, true);
  assert.equal(renderedMath.rawDisplay, false);
  assert.equal(renderedMath.rawInline, false);
  assert.equal(renderedMath.preliminary, false, 'text_replace must replace rather than append content');
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 375,
    height: 740,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const mobileLayout = await cdp.evaluate(`(() => {
    const process = document.querySelector('.knowledge-process');
    const formula = document.querySelector('.knowledge-message.assistant:last-of-type .katex-display')
      || [...document.querySelectorAll('.knowledge-message.assistant .katex-display')].at(-1);
    const rect = process?.getBoundingClientRect();
    return {
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      processLeft: rect?.left,
      processRight: rect?.right,
      formulaOverflow: formula ? getComputedStyle(formula).overflowX : '',
      formulaMaxWidth: formula ? getComputedStyle(formula).maxWidth : '',
    };
  })()`);
  assert.ok(mobileLayout.pageWidth <= mobileLayout.viewport);
  assert.ok(mobileLayout.processLeft >= 0 && mobileLayout.processRight <= mobileLayout.viewport);
  assert.equal(mobileLayout.formulaOverflow, 'auto');
  assert.equal(mobileLayout.formulaMaxWidth, '100%');
  await cdp.call('Emulation.clearDeviceMetricsOverride');

  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.knowledge-conversation-open')]
      .find((item) => item.textContent.includes(${JSON.stringify(oldTitle)}));
    button?.click();
    return Boolean(button);
  })()`);
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-continuation-status')?.textContent === ${JSON.stringify(`正在继续：${oldTitle}`)}`,
    'parent conversation reopened',
  );
  assert.equal(await selectValue(cdp, '#knowledge-task-mode', 'deep'), true);
  await waitForPage(
    cdp,
    `document.querySelector('#knowledge-task-mode')?.value === 'deep'
      && document.querySelector('#knowledge-continuation-status')?.dataset.state === 'continue'`,
    'Normal to Deep continuous state',
  );
  assert.equal(await submitPrompt(cdp, '正常到深度连续追问'), true);
  await waitFor(() => application.state.taskBodies.length === 2, 'Deep continuation task request');
  assert.equal(application.state.taskBodies[1].taskMode, 'deep');
  assert.equal(application.state.taskBodies[1].conversationId, conversations[1].id);
  assert.equal(Object.hasOwn(application.state.taskBodies[1], 'forkFromConversationId'), false);
  assert.equal(application.state.taskBodies[1].modelCatalogRevision, statusPayload.modelCatalogRevision);
});
