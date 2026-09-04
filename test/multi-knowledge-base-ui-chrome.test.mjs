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
const chromePath = path.resolve(process.env.SECOND_MIND_TEST_CHROME || '/usr/bin/google-chrome');

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
  if (filename.endsWith('.woff')) return 'font/woff';
  if (filename.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function statusFor(knowledgeBaseId) {
  const alpha = knowledgeBaseId === 'alpha';
  return {
    available: true,
    knowledgeBaseId,
    knowledgeBaseRevision: `${knowledgeBaseId}-browser-revision`,
    taskContractVersion: 2,
    capabilities: { modelCatalogRevision: true },
    buildRevision: 'knowledge-ui-2.1.6',
    modelCatalogRevision: (alpha ? 'a' : 'b').repeat(64),
    appName: 'Two Vault Browser Test',
    vaultLabel: alpha ? 'Alpha Notes' : 'Beta Notes',
    timezone: 'UTC',
    sync: { provider: 'synthetic', connected: true },
    activeTask: null,
    models: [{
      id: 'fixture-model',
      label: 'Fixture Model',
      shortLabel: 'Fixture',
      actualModel: 'fixture-model-no-network',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      available: true,
      effortMapping: {
        low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
      },
    }],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, label: id })),
    taskModes: [{ id: 'normal', label: '普通', description: '本地单路测试。' }],
    webSearch: { enabled: false, configured: false, provider: 'synthetic' },
    attachmentLimits: { count: 8, bytesPerAttachment: 1024, totalBytes: 4096 },
    speechTranscription: { available: false },
  };
}

function fixtureConversation(knowledgeBaseId) {
  const alpha = knowledgeBaseId === 'alpha';
  const upper = knowledgeBaseId.toUpperCase();
  return {
    id: `${knowledgeBaseId}-conversation`,
    kind: 'qa',
    title: `${upper} conversation`,
    taskMode: 'normal',
    model: 'fixture-model',
    effort: 'medium',
    requestedEffort: 'medium',
    webSearch: false,
    updatedAt: alpha ? '2026-09-05T01:00:00.000Z' : '2026-09-05T02:00:00.000Z',
    messages: [
      { role: 'user', text: `${upper} question` },
      {
        role: 'assistant',
        text: `${upper} durable answer 〔来源：${knowledgeBaseId}-note.md〕`,
        draftId: `${knowledgeBaseId}-draft`,
      },
    ],
  };
}

function fixtureDraft(knowledgeBaseId) {
  const upper = knowledgeBaseId.toUpperCase();
  return {
    id: `${knowledgeBaseId}-draft`,
    kind: 'scratch',
    title: `${upper} draft`,
    targetPath: `Inbox/${upper}-draft.md`,
    content: `# ${upper} draft body`,
  };
}

function writeEvent(response, type, payload) {
  if (!response || response.destroyed || response.writableEnded) return false;
  return response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function createKnowledgeApplication() {
  const state = {
    baseListRequests: [],
    knowledgeRequests: [],
    taskBodies: [],
    cancelRequests: [],
    alphaStream: null,
    alphaStreamDetached: false,
    deferNextAlphaConversationList: false,
    pendingAlphaConversationLists: [],
    pendingAlphaDraftSaves: [],
    pendingBetaDraftDeletes: [],
  };
  const conversations = {
    alpha: fixtureConversation('alpha'),
    beta: fixtureConversation('beta'),
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/session') {
        json(response, 200, {
          authenticated: true,
          user: { username: 'two-vault-user', role: 'user' },
          permissions: { useKnowledge: true, manageRuntimeConfig: true },
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/knowledge/bases') {
        state.baseListRequests.push({ search: url.search });
        json(response, 200, {
          revision: 'two-vault-browser-registry',
          defaultKnowledgeBaseId: 'alpha',
          readyCount: 2,
          enabledCount: 2,
          knowledgeBases: [
            {
              knowledgeBaseId: 'alpha', name: 'Alpha Notes', enabled: true, default: true,
              revision: 'alpha-browser-revision', status: 'ready',
              retrieval: { ready: true, mode: 'keyword', documentCount: 1 },
            },
            {
              knowledgeBaseId: 'beta', name: 'Beta Notes', enabled: true, default: false,
              revision: 'beta-browser-revision', status: 'ready',
              retrieval: { ready: true, mode: 'keyword', documentCount: 1 },
            },
          ],
        });
        return;
      }
      if (url.pathname.startsWith('/api/knowledge/')) {
        const knowledgeBaseIds = url.searchParams.getAll('knowledgeBaseId');
        const knowledgeBaseId = knowledgeBaseIds[0] || '';
        state.knowledgeRequests.push({
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          knowledgeBaseId,
          knowledgeBaseIdCount: knowledgeBaseIds.length,
          requestMarker: request.headers['x-vaultmind-request'] || '',
        });
        if (knowledgeBaseIds.length !== 1 || !['alpha', 'beta'].includes(knowledgeBaseId)) {
          json(response, 400, {
            error: 'EXPLICIT_KNOWLEDGE_BASE_REQUIRED',
            message: 'The browser fixture requires one explicit knowledgeBaseId.',
          });
          return;
        }
        const conversation = conversations[knowledgeBaseId];
        if (request.method === 'GET' && url.pathname === '/api/knowledge/status') {
          json(response, 200, statusFor(knowledgeBaseId));
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/knowledge/conversations') {
          if (knowledgeBaseId === 'alpha' && state.deferNextAlphaConversationList) {
            state.deferNextAlphaConversationList = false;
            state.pendingAlphaConversationLists.push(response);
            return;
          }
          const { messages: _messages, ...summary } = conversation;
          json(response, 200, { conversations: [summary] });
          return;
        }
        const conversationMatch = /^\/api\/knowledge\/conversations\/([^/]+)$/u.exec(url.pathname);
        if (request.method === 'GET' && conversationMatch) {
          const id = decodeURIComponent(conversationMatch[1]);
          json(response, id === conversation.id ? 200 : 404,
            id === conversation.id ? conversation : { message: 'Conversation not found.' });
          return;
        }
        const draftMatch = /^\/api\/knowledge\/drafts\/([^/]+)$/u.exec(url.pathname);
        if (request.method === 'GET' && draftMatch) {
          const id = decodeURIComponent(draftMatch[1]);
          const draft = fixtureDraft(knowledgeBaseId);
          json(response, id === draft.id ? 200 : 404,
            id === draft.id ? draft : { message: 'Draft not found.' });
          return;
        }
        const draftSaveMatch = /^\/api\/knowledge\/drafts\/([^/]+)\/save$/u.exec(url.pathname);
        if (request.method === 'POST' && draftSaveMatch) {
          const body = JSON.parse(await requestBody(request));
          state.pendingAlphaDraftSaves.push({
            knowledgeBaseId,
            id: decodeURIComponent(draftSaveMatch[1]),
            body,
            response,
          });
          return;
        }
        if (request.method === 'DELETE' && draftMatch) {
          state.pendingBetaDraftDeletes.push({
            knowledgeBaseId,
            id: decodeURIComponent(draftMatch[1]),
            response,
          });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/knowledge/file') {
          const expectedPath = `${knowledgeBaseId}-note.md`;
          if (url.searchParams.get('path') !== expectedPath) {
            json(response, 404, { message: 'Source not found.' });
            return;
          }
          const body = `# ${knowledgeBaseId.toUpperCase()} source body`;
          response.writeHead(200, {
            'content-type': 'text/markdown; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
          });
          response.end(body);
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/knowledge/search') {
          json(response, 200, {
            route: url.searchParams.get('mode'),
            results: [{
              path: `${knowledgeBaseId}-note.md`,
              heading: `${knowledgeBaseId.toUpperCase()} search result`,
              snippet: `${knowledgeBaseId.toUpperCase()} result body`,
              matchedTerms: [knowledgeBaseId],
            }],
          });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/knowledge/tasks') {
          const body = JSON.parse(await requestBody(request));
          state.taskBodies.push({ knowledgeBaseId, body });
          if (knowledgeBaseId === 'alpha') state.deferNextAlphaConversationList = true;
          json(response, 202, {
            taskId: `${knowledgeBaseId}-task`,
            conversationId: `${knowledgeBaseId}-conversation`,
          });
          return;
        }
        const eventsMatch = /^\/api\/knowledge\/tasks\/([^/]+)\/events$/u.exec(url.pathname);
        if (request.method === 'GET' && eventsMatch) {
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          response.flushHeaders?.();
          if (knowledgeBaseId === 'alpha') {
            state.alphaStream = response;
            response.on('close', () => { state.alphaStreamDetached = true; });
            writeEvent(response, 'state', { message: 'ALPHA task remains active on the server' });
          } else {
            writeEvent(response, 'state', { message: 'BETA task started' });
            writeEvent(response, 'text', { text: 'BETA streamed answer' });
            writeEvent(response, 'task_error', {
              code: 'MODEL_FIXTURE_FAILURE',
              message: 'BETA_CONFIG_ERROR',
            });
            writeEvent(response, 'done', {
              status: 'failed',
              code: 'MODEL_FIXTURE_FAILURE',
              message: 'BETA_CONFIG_ERROR',
            });
            response.end();
          }
          return;
        }
        const cancelMatch = /^\/api\/knowledge\/tasks\/([^/]+)\/cancel$/u.exec(url.pathname);
        if (request.method === 'POST' && cancelMatch) {
          state.cancelRequests.push({ knowledgeBaseId, taskId: decodeURIComponent(cancelMatch[1]) });
          json(response, 200, { status: 'cancelled' });
          return;
        }
        json(response, 404, { message: 'Synthetic knowledge route not found.' });
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
      json(response, 404, { message: 'Synthetic route not found.' });
    } catch (error) {
      if (!response.headersSent) json(response, 500, { message: error.message });
      else response.destroy(error);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/`,
    emitStaleAlphaEvents() {
      writeEvent(state.alphaStream, 'text', { text: 'STALE_ALPHA_STREAM_TEXT' });
      writeEvent(state.alphaStream, 'draft_ready', {
        ...fixtureDraft('alpha'),
        content: 'STALE_ALPHA_DRAFT_CONTENT',
      });
      writeEvent(state.alphaStream, 'done', { status: 'completed', message: 'STALE_ALPHA_DONE' });
    },
    failPendingAlphaConversationLists() {
      for (const response of state.pendingAlphaConversationLists.splice(0)) {
        json(response, 500, { message: 'STALE_ALPHA_CONVERSATION_FAILURE' });
      }
    },
    completePendingAlphaDraftSaves() {
      for (const pending of state.pendingAlphaDraftSaves.splice(0)) {
        json(pending.response, 200, {
          path: 'Inbox/STALE_ALPHA_SAVED.md',
          warnings: ['STALE_ALPHA_SAVE_WARNING'],
        });
      }
    },
    completePendingBetaDraftDeletes() {
      for (const pending of state.pendingBetaDraftDeletes.splice(0)) {
        json(pending.response, 200, { warnings: ['STALE_BETA_DELETE_WARNING'] });
      }
    },
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

function boundCdpSetup(promise, description) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 8_000);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
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
      message = JSON.parse(typeof event.data === 'string'
        ? event.data
        : Buffer.from(event.data).toString('utf8'));
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
      return Number(value.split(/\r?\n/u)[0]) || 0;
    }, 'Chrome DevTools port');
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.url.startsWith(url));
    }, 'knowledge application page target');
    return { chrome, cdp: await connectCdp(target.webSocketDebuggerUrl, WebSocketImpl) };
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

async function waitForPage(cdp, expression, description) {
  try {
    return await waitFor(() => cdp.evaluate(expression), description);
  } catch (error) {
    const snapshot = await cdp.evaluate(`({
      url: location.href,
      gate: document.querySelector('#knowledge-gate-message')?.textContent,
      selectedBase: document.querySelector('#knowledge-base-select')?.value,
      stateTitle: document.querySelector('#knowledge-state-title')?.textContent,
      stateMessage: document.querySelector('#knowledge-state-message')?.textContent,
      transcript: document.querySelector('#knowledge-transcript')?.textContent?.slice(0, 800),
      sourceOpen: document.querySelector('#knowledge-source-dialog')?.open,
      draftOpen: document.querySelector('#knowledge-draft-dialog')?.open,
    })`).catch(() => null);
    throw new Error(`${error.message}; page snapshot: ${JSON.stringify(snapshot)}`);
  }
}

async function selectValue(cdp, selector, value) {
  return cdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!field) return false;
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function submitPrompt(cdp, prompt) {
  return cdp.evaluate(`(() => {
    const field = document.querySelector('#knowledge-prompt');
    const form = document.querySelector('#knowledge-form');
    if (!field || !form) return false;
    field.value = ${JSON.stringify(prompt)};
    field.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
    return true;
  })()`);
}

test('headless Chrome isolates live task, conversation, source, and draft state while switching bases', {
  timeout: 60_000,
}, async (t) => {
  const WebSocketImpl = websocketImplementation();
  const chromeAvailable = await fsp.access(chromePath).then(() => true, () => false);
  if (!chromeAvailable || !WebSocketImpl) {
    t.skip('Google Chrome or a WHATWG WebSocket implementation is unavailable.');
    return;
  }

  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'second-mind-multikb-ui-chrome-'));
  const application = await createKnowledgeApplication();
  let chrome;
  let cdp;
  t.after(async () => {
    cdp?.close();
    await stopChrome(chrome);
    await application.close();
    await fsp.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  ({ chrome, cdp } = await launchChrome(application.url, profile, WebSocketImpl));
  await waitForPage(cdp, `document.querySelector('#knowledge-app')?.hidden === false
    && document.querySelector('#knowledge-base-select')?.value === 'alpha'
    && document.querySelector('#knowledge-transcript')?.textContent.includes('ALPHA durable answer')`,
  'Alpha base and conversation');

  assert.deepEqual(await cdp.evaluate(`(() => {
    const select = document.querySelector('#knowledge-base-select');
    return {
      hidden: document.querySelector('#knowledge-base-field').hidden,
      values: [...select.options].map((option) => option.value),
      labels: [...select.options].map((option) => option.textContent),
      selected: select.value,
      adminHidden: document.querySelector('#knowledge-admin-config').hidden,
      adminBase: new URL(document.querySelector('#knowledge-admin-config').href)
        .searchParams.get('knowledgeBaseId'),
    };
  })()`), {
    hidden: false,
    values: ['alpha', 'beta'],
    labels: ['Alpha Notes', 'Beta Notes'],
    selected: 'alpha',
    adminHidden: false,
    adminBase: 'alpha',
  });

  assert.deepEqual(await cdp.evaluate('Object.fromEntries(Object.entries(localStorage))'), {
    'second-mind:selected-knowledge-base:v1:two-vault-user': 'alpha',
    'vaultmind:selected-conversation:v2:two-vault-user:alpha': 'alpha-conversation',
  });

  await cdp.evaluate(`(() => {
    document.querySelector('.knowledge-open-draft').click();
    return true;
  })()`);
  await waitForPage(cdp, `document.querySelector('#knowledge-draft-dialog')?.open
    && document.querySelector('#knowledge-draft-target')?.textContent === 'Inbox/ALPHA-draft.md'
    && document.querySelector('#knowledge-draft-content')?.value.includes('ALPHA draft body')`,
  'Alpha draft');
  await cdp.evaluate(`(() => {
    document.querySelector('.knowledge-message-content a[href*="/api/knowledge/file"]')?.click();
    return true;
  })()`);
  await waitForPage(cdp, `document.querySelector('#knowledge-source-dialog')?.open
    && document.querySelector('#knowledge-source-path')?.textContent === 'alpha-note.md'
    && document.querySelector('#knowledge-source-content')?.textContent.includes('ALPHA source body')`,
  'Alpha source');

  assert.equal(await submitPrompt(cdp, 'Keep the Alpha task running.'), true);
  await waitFor(() => application.state.taskBodies.some((item) => item.knowledgeBaseId === 'alpha'),
    'Alpha task request');
  await waitFor(() => application.state.alphaStream, 'Alpha task event stream');
  await waitFor(() => application.state.pendingAlphaConversationLists.length === 1,
    'deferred Alpha conversation reload');
  await waitForPage(cdp, `document.querySelector('#knowledge-state-message')?.textContent
    .includes('ALPHA task remains active')`, 'live Alpha task');
  await cdp.evaluate("document.querySelector('#knowledge-draft-form').requestSubmit(); true");
  await waitFor(() => application.state.pendingAlphaDraftSaves.length === 1,
    'deferred Alpha draft save');
  assert.equal(await cdp.evaluate("document.querySelector('#knowledge-save-draft').disabled"), true);

  const requestCountBeforeSwitch = application.state.knowledgeRequests.length;
  assert.equal(await selectValue(cdp, '#knowledge-base-select', 'beta'), true);
  application.emitStaleAlphaEvents();

  await waitForPage(cdp, `document.querySelector('#knowledge-base-select')?.value === 'beta'
    && document.querySelector('#knowledge-header-vault-label')?.textContent === 'Beta Notes'
    && document.querySelector('#knowledge-transcript')?.textContent.includes('BETA durable answer')
    && !document.querySelector('#knowledge-transcript')?.textContent.includes('ALPHA durable answer')`,
  'isolated Beta base and conversation');
  await waitFor(() => application.state.alphaStreamDetached, 'Alpha EventSource detachment');
  application.emitStaleAlphaEvents();
  application.failPendingAlphaConversationLists();
  application.completePendingAlphaDraftSaves();
  await delay(100);

  const betaSnapshot = await cdp.evaluate(`({
    sourceOpen: document.querySelector('#knowledge-source-dialog').open,
    draftOpen: document.querySelector('#knowledge-draft-dialog').open,
    selected: document.querySelector('#knowledge-base-select').value,
    transcript: document.querySelector('#knowledge-transcript').textContent,
    status: document.querySelector('#knowledge-state-message').textContent,
    conversations: document.querySelector('#knowledge-conversation-list').textContent,
    saveDraftDisabled: document.querySelector('#knowledge-save-draft').disabled,
    adminBase: new URL(document.querySelector('#knowledge-admin-config').href)
      .searchParams.get('knowledgeBaseId'),
    storage: Object.fromEntries(Object.entries(localStorage)),
  })`);
  assert.equal(betaSnapshot.sourceOpen, false);
  assert.equal(betaSnapshot.draftOpen, false);
  assert.equal(betaSnapshot.selected, 'beta');
  assert.match(betaSnapshot.transcript, /BETA durable answer/u);
  assert.doesNotMatch(betaSnapshot.transcript, /ALPHA durable answer/u);
  assert.doesNotMatch(betaSnapshot.status, /ALPHA/u);
  assert.match(betaSnapshot.conversations, /BETA conversation/u);
  assert.doesNotMatch(betaSnapshot.conversations, /STALE_ALPHA_CONVERSATION_FAILURE/u);
  assert.equal(betaSnapshot.saveDraftDisabled, false);
  assert.equal(betaSnapshot.adminBase, 'beta');
  assert.deepEqual(betaSnapshot.storage, {
    'second-mind:selected-knowledge-base:v1:two-vault-user': 'beta',
    'vaultmind:selected-conversation:v2:two-vault-user:alpha': 'alpha-conversation',
    'vaultmind:selected-conversation:v2:two-vault-user:beta': 'beta-conversation',
  });
  const betaPageText = await cdp.evaluate('document.body.textContent');
  assert.equal(betaPageText.includes('STALE_ALPHA_STREAM_TEXT'), false);
  assert.equal(betaPageText.includes('STALE_ALPHA_DRAFT_CONTENT'), false);
  assert.equal(betaPageText.includes('STALE_ALPHA_DONE'), false);
  assert.equal(betaPageText.includes('STALE_ALPHA_CONVERSATION_FAILURE'), false);
  assert.equal(betaPageText.includes('STALE_ALPHA_SAVED'), false);
  assert.equal(betaPageText.includes('STALE_ALPHA_SAVE_WARNING'), false);
  assert.deepEqual(application.state.cancelRequests, [],
    'switching bases must detach the client without cancelling the Alpha server task');

  const requestsAfterSwitch = application.state.knowledgeRequests.slice(requestCountBeforeSwitch);
  assert.equal(requestsAfterSwitch.some((item) => (
    item.pathname !== '/api/knowledge/bases' && item.knowledgeBaseId === 'alpha'
  )), false, 'new base-scoped requests after switching must target Beta');

  await cdp.evaluate("document.querySelector('.knowledge-open-draft').click(); true");
  await waitForPage(cdp, `document.querySelector('#knowledge-draft-dialog')?.open
    && document.querySelector('#knowledge-draft-target')?.textContent === 'Inbox/BETA-draft.md'
    && document.querySelector('#knowledge-draft-content')?.value.includes('BETA draft body')`,
  'Beta draft');
  await cdp.evaluate(`(() => {
    window.confirm = () => true;
    document.querySelector('#knowledge-discard-draft').click();
    return true;
  })()`);
  await waitFor(() => application.state.pendingBetaDraftDeletes.length === 1,
    'deferred Beta draft deletion');
  assert.equal(await selectValue(cdp, '#knowledge-base-select', 'alpha'), true);
  await waitForPage(cdp, `document.querySelector('#knowledge-base-select')?.value === 'alpha'
    && document.querySelector('#knowledge-transcript')?.textContent.includes('ALPHA durable answer')
    && !document.querySelector('#knowledge-transcript')?.textContent.includes('BETA durable answer')`,
  'Alpha state restored while Beta deletion remains pending');
  application.completePendingBetaDraftDeletes();
  await delay(100);
  assert.equal((await cdp.evaluate('document.body.textContent')).includes('STALE_BETA_DELETE_WARNING'), false);
  assert.equal(await selectValue(cdp, '#knowledge-base-select', 'beta'), true);
  await waitForPage(cdp, `document.querySelector('#knowledge-base-select')?.value === 'beta'
    && document.querySelector('#knowledge-transcript')?.textContent.includes('BETA durable answer')`,
  'Beta state restored after stale delete completion');

  await cdp.evaluate(`(() => {
    const input = document.querySelector('#knowledge-search-input');
    input.value = 'beta';
    document.querySelector('#knowledge-search-form').requestSubmit();
    return true;
  })()`);
  await waitForPage(cdp, `document.querySelector('.knowledge-search-result')?.textContent
    .includes('BETA search result')`, 'Beta search');
  await cdp.evaluate("document.querySelector('.knowledge-search-result').click(); true");
  await waitForPage(cdp, `document.querySelector('#knowledge-source-dialog')?.open
    && document.querySelector('#knowledge-source-path')?.textContent === 'beta-note.md'
    && document.querySelector('#knowledge-source-content')?.textContent.includes('BETA source body')`,
  'Beta source');
  await cdp.evaluate("document.querySelector('#knowledge-source-close').click(); true");

  assert.equal(await submitPrompt(cdp, 'Run a Beta-local task.'), true);
  await waitFor(() => application.state.taskBodies.some((item) => item.knowledgeBaseId === 'beta'),
    'Beta task request');
  await waitForPage(cdp, `document.querySelector('#knowledge-transcript')?.textContent
    .includes('BETA_CONFIG_ERROR') && document.querySelector('#knowledge-send')?.hidden === false
    && document.querySelector('.knowledge-notice-action')`, 'failed Beta stream');
  assert.equal(await cdp.evaluate(`new URL(document.querySelector('.knowledge-notice-action').href)
    .searchParams.get('knowledgeBaseId')`), 'beta');

  const scopedRequests = application.state.knowledgeRequests;
  assert.ok(application.state.baseListRequests.length >= 3);
  assert.ok(application.state.baseListRequests.every((request) => request.search === ''),
    'the base discovery endpoint is the sole intentionally unscoped knowledge API');
  assert.ok(scopedRequests.length >= 12, 'fixture should exercise all state-bearing knowledge APIs');
  for (const request of scopedRequests) {
    assert.equal(request.knowledgeBaseIdCount, 1,
      `${request.method} ${request.pathname} must carry exactly one knowledgeBaseId`);
    assert.ok(['alpha', 'beta'].includes(request.knowledgeBaseId),
      `${request.method} ${request.pathname} must carry a recognized knowledgeBaseId`);
  }
  for (const request of scopedRequests.filter((item) => item.method === 'POST')) {
    assert.equal(request.requestMarker, '1', `${request.pathname} must carry the same-origin mutation marker`);
  }
  assert.ok(scopedRequests.some((item) => item.pathname === '/api/knowledge/status'
    && item.knowledgeBaseId === 'alpha'));
  assert.ok(scopedRequests.some((item) => item.pathname === '/api/knowledge/status'
    && item.knowledgeBaseId === 'beta'));
  assert.ok(scopedRequests.some((item) => item.pathname === '/api/knowledge/drafts/beta-draft'
    && item.knowledgeBaseId === 'beta'));
  assert.ok(scopedRequests.some((item) => item.method === 'POST'
    && item.pathname === '/api/knowledge/drafts/alpha-draft/save'
    && item.knowledgeBaseId === 'alpha'));
  assert.ok(scopedRequests.some((item) => item.method === 'DELETE'
    && item.pathname === '/api/knowledge/drafts/beta-draft'
    && item.knowledgeBaseId === 'beta'));
  assert.ok(scopedRequests.some((item) => item.pathname === '/api/knowledge/file'
    && item.knowledgeBaseId === 'beta'));
  assert.ok(scopedRequests.some((item) => item.pathname === '/api/knowledge/search'
    && item.knowledgeBaseId === 'beta'));
  assert.ok(scopedRequests.some((item) => item.pathname === '/api/knowledge/tasks/alpha-task/events'
    && item.knowledgeBaseId === 'alpha'));
  assert.ok(scopedRequests.some((item) => item.pathname === '/api/knowledge/tasks/beta-task/events'
    && item.knowledgeBaseId === 'beta'));
});

function providerConfigFor(knowledgeBaseId) {
  const upper = knowledgeBaseId.toUpperCase();
  const effortMapping = {
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  };
  return {
    schemaVersion: 1,
    revision: `${knowledgeBaseId}-provider-revision`,
    stale: false,
    defaultModelId: 'fixture-model',
    branding: {
      appName: 'Two Vault Admin Test',
      vaultLabel: `${upper} runtime vault`,
    },
    providerOptions: [{
      id: 'custom',
      label: 'Synthetic compatible service',
      defaultApiBase: '',
      defaultProtocol: 'openai-chat-completions',
      protocols: ['openai-chat-completions'],
      docsUrl: '',
    }],
    providers: [{
      id: 'fixture-provider',
      providerId: 'custom',
      label: 'Synthetic compatible service',
      protocol: 'openai-chat-completions',
      apiBase: 'https://provider.example.invalid/v1',
      authMode: 'none',
      endpointPreview: 'https://provider.example.invalid/v1/chat/completions',
      docsUrl: '',
      apiKeyConfigured: false,
      models: [{
        id: 'fixture-model',
        displayName: `${upper} Fixture Model`,
        actualModel: `${knowledgeBaseId}-fixture-model`,
        enabled: true,
        reasoningMapping: { mode: 'auto' },
        effortMapping,
        automaticEffortMapping: effortMapping,
      }],
    }],
    webSearch: {
      enabled: false,
      provider: 'bailian-mcp',
      configured: false,
      providers: [
        {
          id: 'bailian-mcp', label: 'Bailian fixture', apiKeyConfigured: false,
          extractFallbackEnabled: false,
        },
        {
          id: 'tavily-rest', label: 'Tavily fixture', apiKeyConfigured: false,
          extractFallbackEnabled: false,
        },
      ],
    },
    embedding: {
      provider: 'disabled', apiBase: '', model: '', dimensions: 1_024,
      enabled: false, configured: false, apiKeyConfigured: false,
    },
    index: {
      state: 'ready',
      active: {
        revision: `${knowledgeBaseId}-index-revision`,
        available: true,
        files: knowledgeBaseId === 'alpha' ? 3 : 5,
        embedding: { provider: 'disabled', model: null, dimensions: null },
      },
      pending: null,
    },
    rebuild: { status: 'idle' },
    capabilities: { validationReceipts: true, branding: true },
  };
}

function registrySnapshot(revision = 'registry-browser-revision-1', entries = null) {
  const knowledgeBases = entries || [
    {
      knowledgeBaseId: 'alpha',
      name: 'Alpha Notes',
      mountId: 'vaults',
      relativePath: 'teams/alpha',
      enabled: true,
      default: true,
    },
    {
      knowledgeBaseId: 'beta',
      name: 'Beta Notes',
      mountId: 'vaults',
      relativePath: 'teams/beta',
      enabled: true,
      default: false,
    },
  ];
  return {
    revision,
    stale: false,
    defaultKnowledgeBaseId: knowledgeBases.find((entry) => entry.default)?.knowledgeBaseId || '',
    allowedMounts: [
      { id: 'vaults', label: 'Authorized vault mount' },
      { id: 'archive', label: 'Authorized archive mount' },
    ],
    knowledgeBases: knowledgeBases.map((entry) => ({
      ...entry,
      pathAvailable: true,
      status: entry.enabled ? 'ready' : 'disabled',
      retrieval: {
        ready: entry.enabled,
        mode: entry.enabled ? 'keyword' : 'unavailable',
        documentCount: entry.knowledgeBaseId === 'alpha' ? 3 : 5,
      },
    })),
  };
}

async function createAdminApplication() {
  const state = {
    manageKnowledgeBases: false,
    registry: registrySnapshot(),
    registryGets: [],
    registryPuts: [],
    runtimeRequests: [],
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/session') {
        json(response, 200, {
          authenticated: true,
          user: { username: 'registry-admin', role: 'admin' },
          permissions: {
            useKnowledge: true,
            manageRuntimeConfig: true,
            manageKnowledgeBases: state.manageKnowledgeBases,
          },
        });
        return;
      }
      if (url.pathname === '/api/admin/knowledge-bases') {
        if (request.method === 'GET') {
          state.registryGets.push({ search: url.search });
          if (!state.manageKnowledgeBases) {
            json(response, 403, { error: 'FORBIDDEN', message: 'Registry permission is required.' });
            return;
          }
          json(response, 200, state.registry);
          return;
        }
        if (request.method === 'PUT') {
          const body = JSON.parse(await requestBody(request));
          state.registryPuts.push({
            body,
            search: url.search,
            requestMarker: request.headers['x-vaultmind-request'] || '',
          });
          if (!state.manageKnowledgeBases) {
            json(response, 403, { error: 'FORBIDDEN', message: 'Registry permission is required.' });
            return;
          }
          if (body.expectedRevision !== state.registry.revision) {
            json(response, 409, {
              error: 'KNOWLEDGE_BASE_REVISION_CONFLICT',
              message: 'The synthetic registry revision changed.',
            });
            return;
          }
          if (body.adminPassword !== 'registry-browser-password') {
            json(response, 401, { error: 'REAUTHENTICATION_FAILED', message: 'Wrong password.' });
            return;
          }
          state.registry = registrySnapshot('registry-browser-revision-2', body.knowledgeBases);
          json(response, 200, state.registry);
          return;
        }
      }
      if (
        request.method === 'GET'
        && ['/api/knowledge/status', '/api/admin/provider-config'].includes(url.pathname)
      ) {
        const requestedKnowledgeBaseId = url.searchParams.get('knowledgeBaseId') || '';
        const knowledgeBaseId = requestedKnowledgeBaseId || 'alpha';
        state.runtimeRequests.push({
          pathname: url.pathname,
          search: url.search,
          knowledgeBaseId: requestedKnowledgeBaseId,
        });
        if (!['alpha', 'beta'].includes(knowledgeBaseId)) {
          json(response, 404, { error: 'KNOWLEDGE_BASE_NOT_FOUND', message: 'Unknown base.' });
          return;
        }
        if (url.pathname === '/api/knowledge/status') {
          json(response, 200, {
            available: true,
            knowledgeBaseId,
            appName: 'Two Vault Admin Test',
            vaultLabel: `${knowledgeBaseId.toUpperCase()} runtime vault`,
            rootLabel: `${knowledgeBaseId.toUpperCase()} runtime vault`,
          });
        } else {
          json(response, 200, providerConfigFor(knowledgeBaseId));
        }
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
      json(response, 404, { message: 'Synthetic admin route not found.' });
    } catch (error) {
      if (!response.headersSent) json(response, 500, { message: error.message });
      else response.destroy(error);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/admin-config.html`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

async function waitForAdminPage(cdp, expression, description) {
  try {
    return await waitFor(() => cdp.evaluate(expression), description);
  } catch (error) {
    const snapshot = await cdp.evaluate(`({
      url: location.href,
      gate: document.querySelector('#gate-message')?.textContent,
      message: document.querySelector('#config-message')?.textContent,
      selectedBase: document.querySelector('#admin-knowledge-base-select')?.value,
      revision: document.querySelector('#config-revision')?.textContent,
      registryHidden: document.querySelector('#knowledge-base-config')?.hidden,
      registryCards: document.querySelectorAll('[data-knowledge-base-card]').length,
    })`).catch(() => null);
    throw new Error(`${error.message}; admin page snapshot: ${JSON.stringify(snapshot)}`);
  }
}

test('headless Chrome gates the admin registry and submits only scoped relative-path CAS data', {
  timeout: 60_000,
}, async (t) => {
  const WebSocketImpl = websocketImplementation();
  const chromeAvailable = await fsp.access(chromePath).then(() => true, () => false);
  if (!chromeAvailable || !WebSocketImpl) {
    t.skip('Google Chrome or a WHATWG WebSocket implementation is unavailable.');
    return;
  }

  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'second-mind-admin-multikb-chrome-'));
  const application = await createAdminApplication();
  let chrome;
  let cdp;
  t.after(async () => {
    cdp?.close();
    await stopChrome(chrome);
    await application.close();
    await fsp.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  ({ chrome, cdp } = await launchChrome(application.url, profile, WebSocketImpl));
  await waitForAdminPage(cdp, `document.querySelector('#admin-app')?.hidden === false
    && document.querySelector('#config-revision')?.textContent === 'alpha-provider-revision'`,
  'runtime-only administrator configuration');
  assert.deepEqual(await cdp.evaluate(`({
    registryHidden: document.querySelector('#knowledge-base-config').hidden,
    selectorHidden: document.querySelector('#admin-knowledge-base-field').hidden,
    cards: document.querySelectorAll('[data-knowledge-base-card]').length,
  })`), { registryHidden: true, selectorHidden: true, cards: 0 });
  assert.equal(application.state.registryGets.length, 0,
    'the browser must not request registry data without manageKnowledgeBases');

  application.state.manageKnowledgeBases = true;
  application.state.runtimeRequests.length = 0;
  await cdp.call('Page.navigate', { url: `${application.url}?knowledgeBaseId=beta` });
  await waitForAdminPage(cdp, `document.querySelector('#admin-app')?.hidden === false
    && document.querySelector('#knowledge-base-config')?.hidden === false
    && document.querySelectorAll('[data-knowledge-base-card]').length === 2
    && document.querySelector('#admin-knowledge-base-select')?.value === 'beta'
    && document.querySelector('#config-revision')?.textContent === 'beta-provider-revision'`,
  'permitted Beta registry and runtime configuration');

  const registryView = await cdp.evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-knowledge-base-card]')];
    return {
      selectorValues: [...document.querySelector('#admin-knowledge-base-select').options]
        .map((option) => option.value),
      selector: document.querySelector('#admin-knowledge-base-select').value,
      url: location.search,
      cards: cards.map((card) => ({
        id: card.querySelector('[data-knowledge-base-field="knowledgeBaseId"]').value,
        idReadOnly: card.querySelector('[data-knowledge-base-field="knowledgeBaseId"]').readOnly,
        name: card.querySelector('[data-knowledge-base-field="name"]').value,
        mountId: card.querySelector('[data-knowledge-base-field="mountId"]').value,
        mountOptions: [...card.querySelector('[data-knowledge-base-field="mountId"]').options]
          .map((option) => option.value),
        relativePath: card.querySelector('[data-knowledge-base-field="relativePath"]').value,
      })),
      registryText: document.querySelector('#knowledge-base-config').textContent,
      registryFieldNames: [...new Set([...document.querySelectorAll('[data-knowledge-base-field]')]
        .map((field) => field.dataset.knowledgeBaseField))].sort(),
    };
  })()`);
  assert.deepEqual(registryView.selectorValues, ['alpha', 'beta']);
  assert.equal(registryView.selector, 'beta');
  assert.equal(new URLSearchParams(registryView.url).get('knowledgeBaseId'), 'beta');
  assert.deepEqual(registryView.cards, [
    {
      id: 'alpha', idReadOnly: true, name: 'Alpha Notes', mountId: 'vaults',
      mountOptions: ['vaults', 'archive'], relativePath: 'teams/alpha',
    },
    {
      id: 'beta', idReadOnly: true, name: 'Beta Notes', mountId: 'vaults',
      mountOptions: ['vaults', 'archive'], relativePath: 'teams/beta',
    },
  ]);
  assert.deepEqual(registryView.registryFieldNames,
    ['enabled', 'knowledgeBaseId', 'mountId', 'name', 'relativePath']);
  assert.doesNotMatch(registryView.registryText, /storage[ _-]?secret|absolute[ _-]?path|root[ _-]?path/iu);
  assert.ok(registryView.cards.every((card) => (
    !card.relativePath.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(card.relativePath)
  )));

  const betaRuntimeRequests = application.state.runtimeRequests;
  assert.deepEqual(new Set(betaRuntimeRequests.map((request) => request.pathname)), new Set([
    '/api/knowledge/status',
    '/api/admin/provider-config',
  ]));
  assert.ok(betaRuntimeRequests.every((request) => request.knowledgeBaseId === 'beta'));

  const runtimeCountBeforeSwitch = application.state.runtimeRequests.length;
  assert.equal(await selectValue(cdp, '#admin-knowledge-base-select', 'alpha'), true);
  await waitForAdminPage(cdp, `document.querySelector('#admin-knowledge-base-select')?.value === 'alpha'
    && document.querySelector('#config-revision')?.textContent === 'alpha-provider-revision'
    && new URL(location.href).searchParams.get('knowledgeBaseId') === 'alpha'`,
  'Alpha-scoped runtime configuration');
  const alphaRuntimeRequests = application.state.runtimeRequests.slice(runtimeCountBeforeSwitch);
  assert.deepEqual(new Set(alphaRuntimeRequests.map((request) => request.pathname)), new Set([
    '/api/knowledge/status',
    '/api/admin/provider-config',
  ]));
  assert.ok(alphaRuntimeRequests.every((request) => request.knowledgeBaseId === 'alpha'));

  await cdp.evaluate(`(() => {
    window.confirm = () => true;
    const beta = [...document.querySelectorAll('[data-knowledge-base-card]')]
      .find((card) => card.querySelector('[data-knowledge-base-field="knowledgeBaseId"]').value === 'beta');
    const relativePath = beta.querySelector('[data-knowledge-base-field="relativePath"]');
    relativePath.value = '/synthetic/absolute/path';
    relativePath.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#admin-password').value = 'registry-browser-password';
    document.querySelector('#knowledge-base-save').click();
    return true;
  })()`);
  await waitForAdminPage(cdp, `document.querySelector('#config-message')?.textContent.includes('相对路径')`,
    'absolute-path client rejection');
  assert.equal(application.state.registryPuts.length, 0,
    'an absolute path must never reach the registry endpoint');

  await cdp.evaluate(`(() => {
    const beta = [...document.querySelectorAll('[data-knowledge-base-card]')]
      .find((card) => card.querySelector('[data-knowledge-base-field="knowledgeBaseId"]').value === 'beta');
    const mount = beta.querySelector('[data-knowledge-base-field="mountId"]');
    mount.value = 'archive';
    mount.dispatchEvent(new Event('change', { bubbles: true }));
    const relativePath = beta.querySelector('[data-knowledge-base-field="relativePath"]');
    relativePath.value = ${JSON.stringify('teams\\beta-notes')};
    relativePath.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#admin-password').value = 'registry-browser-password';
    document.querySelector('#knowledge-base-save').click();
    return true;
  })()`);
  await waitFor(() => application.state.registryPuts.length === 1, 'registry CAS PUT');
  await waitForAdminPage(cdp, `document.querySelector('#config-message')?.textContent.includes('原子保存')
    && document.querySelector('#knowledge-base-save')?.disabled === true`,
  'saved registry response');

  const saved = application.state.registryPuts[0];
  assert.equal(saved.search, '', 'the global registry endpoint must not be scoped to one base');
  assert.equal(saved.requestMarker, '1');
  assert.deepEqual(Object.keys(saved.body).sort(),
    ['adminPassword', 'expectedRevision', 'knowledgeBases']);
  assert.equal(saved.body.expectedRevision, 'registry-browser-revision-1');
  assert.equal(saved.body.adminPassword, 'registry-browser-password');
  assert.deepEqual(saved.body.knowledgeBases, [
    {
      knowledgeBaseId: 'alpha',
      name: 'Alpha Notes',
      mountId: 'vaults',
      relativePath: 'teams/alpha',
      enabled: true,
      default: true,
    },
    {
      knowledgeBaseId: 'beta',
      name: 'Beta Notes',
      mountId: 'archive',
      relativePath: 'teams/beta-notes',
      enabled: true,
      default: false,
    },
  ]);
  for (const entry of saved.body.knowledgeBases) {
    assert.deepEqual(Object.keys(entry).sort(),
      ['default', 'enabled', 'knowledgeBaseId', 'mountId', 'name', 'relativePath']);
    assert.doesNotMatch(entry.relativePath, /^(?:\/|[A-Za-z]:[\\/])/u);
    assert.equal(entry.relativePath.split('/').includes('..'), false);
  }
  const registryPayload = JSON.stringify(saved.body.knowledgeBases);
  assert.doesNotMatch(registryPayload,
    /absolutePath|rootPath|vaultPath|dataDir|indexDir|draftDir|storageSecret|apiKey|authorization|token/iu);
  assert.equal(await cdp.evaluate("document.querySelector('#admin-password').value"), '');
  assert.equal(await cdp.evaluate(`(() => {
    const beta = [...document.querySelectorAll('[data-knowledge-base-card]')]
      .find((card) => card.querySelector('[data-knowledge-base-field="knowledgeBaseId"]').value === 'beta');
    return beta.querySelector('[data-knowledge-base-field="relativePath"]').value;
  })()`), 'teams/beta-notes');
});
