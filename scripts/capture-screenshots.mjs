import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const defaultOutputDir = path.join(projectRoot, 'docs', 'assets');
const defaultChromePath = '/usr/bin/google-chrome';
const fixedNow = Date.parse('2026-09-05T09:30:00.000Z');
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const strippedPngChunks = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf', 'pHYs']);

export const SCREENSHOT_SPECS = Object.freeze([
  Object.freeze({ name: 'second-mind-qa.png', width: 1440, height: 1050 }),
  Object.freeze({ name: 'second-mind-execution.png', width: 1440, height: 1050 }),
  Object.freeze({ name: 'second-mind-provider-config.png', width: 1440, height: 1050 }),
  Object.freeze({ name: 'second-mind-diary.png', width: 1280, height: 960 }),
  Object.freeze({ name: 'second-mind-plan.png', width: 1280, height: 960 }),
  Object.freeze({ name: 'second-mind-mobile.png', width: 360, height: 800 }),
]);

function usage() {
  return [
    'Usage: node scripts/capture-screenshots.mjs [options]',
    '',
    'Options:',
    `  --output-dir <path>  Destination directory (default: ${path.relative(projectRoot, defaultOutputDir)})`,
    `  --chrome <path>      Google Chrome executable (default: ${defaultChromePath})`,
    '  --help               Show this help',
  ].join('\n');
}

export function parseArguments(argv) {
  const options = { outputDir: defaultOutputDir, chromePath: defaultChromePath, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--output-dir' || argument === '--chrome') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--output-dir') options.outputDir = path.resolve(value);
      else options.chromePath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function pngChunks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 || !buffer.subarray(0, 8).equals(pngSignature)) {
    throw new Error('Chrome did not return a PNG image.');
  }
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error('PNG chunk header is truncated.');
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error('PNG chunk data is truncated.');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, offset, end, dataOffset: offset + 8, length });
    offset = end;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR' || chunks.at(-1)?.type !== 'IEND') {
    throw new Error('PNG is missing its required boundary chunks.');
  }
  return chunks;
}

export function pngDimensions(buffer) {
  const chunks = pngChunks(buffer);
  const header = chunks[0];
  if (header.length !== 13) throw new Error('PNG IHDR has an invalid length.');
  return {
    width: buffer.readUInt32BE(header.dataOffset),
    height: buffer.readUInt32BE(header.dataOffset + 4),
  };
}

export function stripPngMetadata(buffer) {
  const chunks = pngChunks(buffer);
  return Buffer.concat([
    pngSignature,
    ...chunks
      .filter((chunk) => !strippedPngChunks.has(chunk.type))
      .map((chunk) => buffer.subarray(chunk.offset, chunk.end)),
  ]);
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

function modelCatalog() {
  const mapping = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
  return [{
    id: 'demo-model',
    label: 'Demo Reasoning Model',
    shortLabel: 'Demo Model',
    actualModel: 'demo-reasoning-v1',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    available: true,
    effortMapping: mapping,
    automaticEffortMapping: mapping,
  }];
}

function knowledgeStatus(knowledgeBaseId) {
  const research = knowledgeBaseId === 'research';
  return {
    available: true,
    knowledgeBaseId,
    knowledgeBaseRevision: `${knowledgeBaseId}-capture-revision`,
    taskContractVersion: 2,
    capabilities: { modelCatalogRevision: true },
    buildRevision: 'knowledge-ui-2.1.6',
    modelCatalogRevision: (research ? 'c' : 'd').repeat(64),
    appName: 'Second Mind',
    vaultLabel: research ? 'Research Vault' : 'Demo Vault',
    timezone: 'UTC',
    sync: { provider: 'Local demo', displayName: 'Local demo', connected: true },
    activeTask: null,
    models: modelCatalog(),
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, label: id })),
    taskModes: [
      { id: 'normal', label: '普通', description: '单路检索并核验本地来源。' },
      { id: 'deep', label: '深度', description: '分阶段检索、阅读与综合。' },
    ],
    webSearch: { enabled: false, configured: false, provider: 'local-demo' },
    attachmentLimits: {
      count: 8,
      bytesPerAttachment: 5 * 1024 * 1024,
      totalBytes: 15 * 1024 * 1024,
    },
    speechTranscription: { available: false },
  };
}

const conversations = Object.freeze({
  research: Object.freeze({
    id: 'research-release-review',
    kind: 'qa',
    title: 'Release evidence checklist',
    taskMode: 'deep',
    model: 'demo-model',
    effort: 'high',
    requestedEffort: 'high',
    webSearch: false,
    updatedAt: '2026-09-05T09:00:00.000Z',
    messages: [
      { role: 'user', text: 'What should we verify before publishing a release?' },
      {
        role: 'assistant',
        text: [
          '## Release readiness',
          '',
          'The local review identifies three required checks:',
          '',
          '1. Run the focused tests against the release candidate.',
          '2. Confirm documentation links and screenshots match the current interface.',
          '3. Record the build revision and preserve a rollback point.',
          '',
          '**Decision:** publish only after all three checks have evidence.',
          '',
          '〔来源：Guides/Release review.md#Checklist〕',
        ].join('\n'),
      },
    ],
  }),
  demo: Object.freeze({
    id: 'demo-welcome',
    kind: 'qa',
    title: 'Demo workspace overview',
    taskMode: 'normal',
    model: 'demo-model',
    effort: 'medium',
    requestedEffort: 'medium',
    webSearch: false,
    updatedAt: '2026-09-04T16:00:00.000Z',
    messages: [
      { role: 'user', text: 'What is stored in this demonstration workspace?' },
      {
        role: 'assistant',
        text: 'Only synthetic notes used to demonstrate the interface. 〔来源：Welcome.md〕',
      },
    ],
  }),
});

function providerConfiguration() {
  const mapping = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
  return {
    schemaVersion: 1,
    revision: 'demo-provider-capture-revision',
    stale: false,
    defaultModelId: 'demo-model',
    branding: { appName: 'Second Mind', vaultLabel: 'Research Vault' },
    providerOptions: [{
      id: 'custom',
      label: 'Custom compatible service',
      defaultApiBase: '',
      defaultProtocol: 'openai-chat-completions',
      protocols: ['openai-chat-completions'],
      docsUrl: '',
    }],
    providers: [{
      id: 'demo-provider',
      providerId: 'custom',
      label: 'Local Demo Gateway',
      protocol: 'openai-chat-completions',
      apiBase: 'offline-demo-endpoint',
      authMode: 'none',
      endpointPreview: 'offline-demo-endpoint/chat/completions',
      docsUrl: '',
      apiKeyConfigured: false,
      models: [{
        ...modelCatalog()[0],
        displayName: 'Demo Reasoning Model',
        reasoningMapping: { mode: 'auto' },
        effortMapping: mapping,
        automaticEffortMapping: mapping,
      }],
    }],
    webSearch: {
      enabled: false,
      provider: 'bailian-mcp',
      configured: false,
      providers: [
        { id: 'bailian-mcp', label: 'Search disabled', apiKeyConfigured: false, extractFallbackEnabled: false },
        { id: 'tavily-rest', label: 'Search disabled', apiKeyConfigured: false, extractFallbackEnabled: false },
      ],
    },
    embedding: {
      provider: 'disabled', apiBase: '', model: '', dimensions: 1_024,
      enabled: false, configured: false, apiKeyConfigured: false,
    },
    index: {
      state: 'ready',
      active: {
        revision: 'demo-index-capture-revision',
        available: true,
        files: 24,
        embedding: { provider: 'disabled', model: null, dimensions: null },
      },
      pending: null,
    },
    rebuild: { status: 'idle' },
    capabilities: { validationReceipts: true, branding: true },
  };
}

function sendEvent(response, type, payload, id = '') {
  response.write(`${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function taskDraft(task) {
  if (task.kind === 'diary') {
    return {
      id: `draft-${task.id}`,
      kind: 'diary',
      title: 'Daily reflection',
      targetPath: 'Daily/2026-09-05.md',
      content: [
        '# Daily reflection — 2026-09-05',
        '',
        '## Progress',
        '',
        '- Reviewed the release evidence and local test results.',
        '- Updated the demonstration screenshots.',
        '',
        '## Reflection',
        '',
        'The next step is a final accessibility review before publishing.',
      ].join('\n'),
      warnings: [],
    };
  }
  return {
    id: `draft-${task.id}`,
    kind: 'plan',
    title: 'Release plan',
    targetPath: 'Plans/Release checklist.md',
    content: [
      '# Release checklist',
      '',
      '- [x] Run local unit and browser tests',
      '- [x] Capture the current desktop interface',
      '- [ ] Review the 360 px responsive layout',
      '- [ ] Publish after final approval',
      '',
      '> Draft preview — nothing has been written to the vault yet.',
    ].join('\n'),
    warnings: [],
  };
}

function streamTask(response, task) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  response.flushHeaders?.();
  sendEvent(response, 'state', { message: 'Preparing the local demonstration task.' }, '1');
  sendEvent(response, 'session', {
    taskMode: task.taskMode,
    model: 'Demo Reasoning Model',
    effort: task.effort,
    requestedEffort: task.effort,
    effectiveEffort: task.effort,
  }, '2');
  if (task.kind === 'qa') {
    sendEvent(response, 'thinking', {
      message: 'Breaking the question into evidence checks.',
      estimatedTokens: 96,
    }, '3');
    sendEvent(response, 'activity', {
      title: 'Searching Research Vault',
      message: 'Matched the local release review and verification notes.',
      toolName: 'vault_search',
      stage: 'complete',
    }, '4');
    sendEvent(response, 'activity', {
      title: 'Reading the strongest source',
      message: 'Checking the cited release checklist before composing the answer.',
      toolName: 'vault_read',
      stage: 'complete',
    }, '5');
    sendEvent(response, 'usage', {
      scope: 'call',
      callId: 'demo-final-generation',
      usage: {
        inputTokens: 420,
        outputTokens: 92,
        cacheReadInputTokens: 160,
        cacheCreationInputTokens: 0,
        reasoningTokens: 36,
        totalTokens: 512,
      },
    }, '6');
    sendEvent(response, 'text_replace', {
      text: [
        '## Verified release path',
        '',
        'The recent local evidence supports a short sequence: **test, review, record, publish**.',
        '',
        '- Focused browser tests cover the current UI states.',
        '- Documentation screenshots come from the same release assets.',
        '- The build revision provides a reproducible rollback point.',
        '',
        '〔来源：Guides/Release review.md#Verification sequence〕',
      ].join('\n'),
    }, '7');
  } else {
    sendEvent(response, 'activity', {
      title: task.kind === 'diary' ? 'Preparing daily note' : 'Preparing plan',
      message: 'Building a reviewable Markdown draft from the local prompt.',
      toolName: 'draft_prepare',
      stage: 'complete',
    }, '3');
    sendEvent(response, 'draft_ready', taskDraft(task), '4');
  }
  sendEvent(response, 'done', {
    status: 'completed',
    message: task.kind === 'qa' ? 'Local verification complete.' : 'Draft ready for review.',
  }, '8');
  response.end();
}

async function createCaptureServer() {
  const tasks = new Map();
  const requests = [];
  let taskSequence = 0;
  let adminAccess = false;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      requests.push({ method: request.method, pathname: url.pathname, search: url.search });
      if (request.method === 'GET' && url.pathname === '/api/session') {
        json(response, 200, {
          authenticated: true,
          user: { username: 'demo-admin', role: 'admin' },
          permissions: {
            useKnowledge: true,
            manageRuntimeConfig: adminAccess,
            manageKnowledgeBases: false,
          },
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/knowledge/bases') {
        json(response, 200, {
          revision: 'capture-registry-revision',
          defaultKnowledgeBaseId: 'research',
          readyCount: 2,
          enabledCount: 2,
          knowledgeBases: [
            {
              knowledgeBaseId: 'research', name: 'Research Vault', enabled: true, default: true,
              revision: 'research-capture-revision', status: 'ready',
              retrieval: { ready: true, mode: 'keyword', documentCount: 24 },
            },
            {
              knowledgeBaseId: 'demo', name: 'Demo Vault', enabled: true, default: false,
              revision: 'demo-capture-revision', status: 'ready',
              retrieval: { ready: true, mode: 'keyword', documentCount: 8 },
            },
          ],
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/provider-config') {
        if (url.searchParams.get('knowledgeBaseId') !== 'research') {
          json(response, 400, { message: 'The capture requires an explicit Research Vault selection.' });
          return;
        }
        json(response, 200, providerConfiguration());
        return;
      }
      if (url.pathname.startsWith('/api/knowledge/')) {
        const knowledgeBaseId = url.searchParams.get('knowledgeBaseId') || '';
        if (!['research', 'demo'].includes(knowledgeBaseId)) {
          json(response, 400, { message: 'The capture requires an explicit knowledgeBaseId.' });
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/knowledge/status') {
          json(response, 200, knowledgeStatus(knowledgeBaseId));
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/knowledge/conversations') {
          const { messages: _messages, ...summary } = conversations[knowledgeBaseId];
          json(response, 200, { conversations: [summary] });
          return;
        }
        const conversationMatch = /^\/api\/knowledge\/conversations\/([^/]+)$/u.exec(url.pathname);
        if (request.method === 'GET' && conversationMatch) {
          const conversation = conversations[knowledgeBaseId];
          const requestedId = decodeURIComponent(conversationMatch[1]);
          json(response, requestedId === conversation.id ? 200 : 404,
            requestedId === conversation.id ? conversation : { message: 'Conversation not found.' });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/api/knowledge/tasks') {
          const body = JSON.parse(await requestBody(request));
          taskSequence += 1;
          const task = {
            id: `capture-task-${taskSequence}`,
            kind: body.kind,
            taskMode: body.taskMode,
            effort: body.effort,
            knowledgeBaseId,
          };
          tasks.set(task.id, task);
          json(response, 202, {
            taskId: task.id,
            conversationId: `capture-conversation-${taskSequence}`,
          });
          return;
        }
        const eventsMatch = /^\/api\/knowledge\/tasks\/([^/]+)\/events$/u.exec(url.pathname);
        if (request.method === 'GET' && eventsMatch) {
          const task = tasks.get(decodeURIComponent(eventsMatch[1]));
          if (!task || task.knowledgeBaseId !== knowledgeBaseId) {
            json(response, 404, { message: 'Task not found.' });
            return;
          }
          streamTask(response, task);
          return;
        }
        if (request.method === 'GET' && url.pathname === '/api/knowledge/file') {
          const relativePath = url.searchParams.get('path') || '';
          const body = `# Synthetic source\n\nPreview for ${relativePath}.`;
          response.writeHead(200, {
            'content-type': 'text/markdown; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
          });
          response.end(body);
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
      json(response, 404, { message: 'Synthetic capture route not found.' });
    } catch (error) {
      if (!response.headersSent) json(response, 500, { message: error.message });
      else response.destroy(error);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    origin: `http://127.0.0.1:${server.address().port}`,
    setAdminAccess(value) {
      adminAccess = value === true;
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

async function waitFor(check, description, timeoutMs = 10_000) {
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
  const runtimeErrors = [];
  const networkRequests = [];
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string'
        ? event.data
        : Buffer.from(event.data).toString('utf8'));
    } catch {
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params?.exceptionDetails?.exception?.description
        || message.params?.exceptionDetails?.text || 'Unknown browser exception');
    }
    if (message.method === 'Network.requestWillBeSent' && message.params?.request?.url) {
      networkRequests.push(message.params.request.url);
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
    else resolve(message.result || {});
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await Promise.all([call('Network.enable'), call('Page.enable'), call('Runtime.enable')]);
  return {
    call,
    networkRequests,
    runtimeErrors,
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

async function launchChrome(chromePath, profile, WebSocketImpl) {
  const stderr = [];
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', (chunk) => {
    if (stderr.reduce((sum, item) => sum + item.length, 0) < 32 * 1024) stderr.push(chunk);
  });
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  const port = await waitFor(async () => {
    if (chrome.exitCode !== null) {
      throw new Error(`Chrome exited ${chrome.exitCode}: ${Buffer.concat(stderr).toString('utf8').slice(-2_000)}`);
    }
    const value = await fsp.readFile(activePortFile, 'utf8').catch(() => '');
    return Number(value.split(/\r?\n/u)[0]) || 0;
  }, 'Chrome DevTools port');
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type === 'page');
  }, 'Chrome page target');
  return { chrome, cdp: await connectCdp(target.webSocketDebuggerUrl, WebSocketImpl) };
}

async function stopChrome(chrome) {
  if (!chrome || chrome.exitCode !== null) return;
  const exited = once(chrome, 'exit');
  chrome.kill('SIGTERM');
  await Promise.race([exited, delay(1_500)]);
  if (chrome.exitCode === null) {
    chrome.kill('SIGKILL');
    await Promise.race([once(chrome, 'exit'), delay(1_500)]);
  }
}

const deterministicPageSetup = `(() => {
  const NativeDate = Date;
  const fixedNow = ${fixedNow};
  class CaptureDate extends NativeDate {
    constructor(...values) { super(...(values.length ? values : [fixedNow])); }
    static now() { return fixedNow; }
  }
  window.Date = CaptureDate;
  const install = () => {
    if (document.querySelector('#release-capture-style')) return;
    const style = document.createElement('style');
    style.id = 'release-capture-style';
    style.textContent = \`
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
      .knowledge-dialog::backdrop {
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
      }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
    \`;
    (document.head || document.documentElement).append(style);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})()`;

async function setViewport(cdp, spec, mobile = false) {
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: spec.width,
    height: spec.height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: spec.width,
    screenHeight: spec.height,
  });
  await cdp.call('Emulation.setTouchEmulationEnabled', mobile
    ? { enabled: true, maxTouchPoints: 1 }
    : { enabled: false });
}

async function navigate(cdp, url, readyExpression, description) {
  await cdp.call('Page.navigate', { url });
  await waitFor(async () => (
    await cdp.evaluate(`document.readyState === 'complete' && Boolean(${readyExpression})`)
  ), description);
}

async function settlePage(cdp) {
  await cdp.evaluate(`(async () => {
    await document.fonts?.ready;
    document.activeElement?.blur?.();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
}

function assertSafeVisibleFixture(text) {
  const visible = String(text || '');
  const forbidden = [
    /\/home\//iu,
    /\/Users\//iu,
    /127\.0\.0\.1/iu,
    /localhost/iu,
    /sk-[A-Za-z0-9_-]{8,}/u,
    /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/u,
    /registry-browser-password/iu,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(visible)) throw new Error(`Visible capture text matched forbidden fixture pattern ${pattern}.`);
  }
}

async function captureViewport(cdp, spec) {
  await settlePage(cdp);
  assertSafeVisibleFixture(await cdp.evaluate('document.body.innerText'));
  const passwordValues = await cdp.evaluate(`[
    ...document.querySelectorAll('input[type="password"]')
  ].map((field) => field.value)`);
  if (passwordValues.some(Boolean)) throw new Error(`${spec.name} contains a populated password field.`);
  const result = await cdp.call('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const png = stripPngMetadata(Buffer.from(result.data, 'base64'));
  const dimensions = pngDimensions(png);
  if (dimensions.width !== spec.width || dimensions.height !== spec.height) {
    throw new Error(`${spec.name} is ${dimensions.width}x${dimensions.height}; expected ${spec.width}x${spec.height}.`);
  }
  return png;
}

async function submitTask(cdp, kind, prompt) {
  await cdp.evaluate(`(() => {
    const mode = document.querySelector('[data-kind="${kind}"]');
    if (mode) mode.click();
    const prompt = document.querySelector('#knowledge-prompt');
    prompt.value = ${JSON.stringify(prompt)};
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#knowledge-form').requestSubmit();
    return true;
  })()`);
}

function screenshotSpec(name) {
  const spec = SCREENSHOT_SPECS.find((item) => item.name === name);
  if (!spec) throw new Error(`Unknown screenshot specification: ${name}`);
  return spec;
}

async function captureAll(cdp, application) {
  const { origin } = application;
  const captures = new Map();
  const qa = screenshotSpec('second-mind-qa.png');
  await setViewport(cdp, qa);
  await navigate(cdp, `${origin}/`, `document.querySelector('#knowledge-app')?.hidden === false
    && document.querySelector('#knowledge-base-select')?.value === 'research'
    && document.querySelector('#knowledge-transcript')?.textContent.includes('Release readiness')`,
  'Research Vault answer');
  await cdp.evaluate(`(() => {
    const transcript = document.querySelector('#knowledge-transcript');
    transcript.scrollTop = transcript.scrollHeight;
    window.scrollTo(0, 0);
    return true;
  })()`);
  captures.set(qa.name, await captureViewport(cdp, qa));

  const execution = screenshotSpec('second-mind-execution.png');
  await setViewport(cdp, execution);
  await cdp.evaluate("document.querySelector('#knowledge-new-conversation').click(); true");
  await submitTask(cdp, 'qa', 'Verify the current release path using only local evidence.');
  await waitFor(() => cdp.evaluate(`document.querySelector('#knowledge-send')?.hidden === false
    && document.querySelector('.knowledge-process')
    && document.querySelector('#knowledge-transcript')?.textContent.includes('Verified release path')`),
  'completed execution trace');
  await cdp.evaluate(`(() => {
    const process = document.querySelector('.knowledge-process');
    process.open = true;
    document.querySelector('#knowledge-transcript').scrollTop = 0;
    window.scrollTo(0, 0);
    return true;
  })()`);
  captures.set(execution.name, await captureViewport(cdp, execution));

  const provider = screenshotSpec('second-mind-provider-config.png');
  await setViewport(cdp, provider);
  application.setAdminAccess(true);
  await navigate(cdp, `${origin}/admin-config.html?knowledgeBaseId=research`,
    `document.querySelector('#admin-app')?.hidden === false
      && document.querySelector('[data-connection-card]')
      && document.querySelector('#config-revision')?.textContent === 'demo-provider-capture-revision'`,
    'configured no-key Provider');
  await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-connection-card]');
    card.querySelector('[data-provider-advanced]').open = true;
    const section = document.querySelector('#providers-heading').closest('.config-card');
    window.scrollTo(0, Math.max(0, section.offsetTop - 22));
    return true;
  })()`);
  captures.set(provider.name, await captureViewport(cdp, provider));

  const diary = screenshotSpec('second-mind-diary.png');
  await setViewport(cdp, diary);
  application.setAdminAccess(false);
  await navigate(cdp, `${origin}/`, `document.querySelector('#knowledge-app')?.hidden === false
    && document.querySelector('#knowledge-base-select')?.value === 'research'`, 'knowledge UI for diary');
  await submitTask(cdp, 'diary', 'Summarize today as a reviewable local diary draft.');
  await waitFor(() => cdp.evaluate(`document.querySelector('#knowledge-draft-dialog')?.open
    && document.querySelector('#knowledge-draft-target')?.textContent === 'Daily/2026-09-05.md'
    && document.querySelector('#knowledge-send')?.hidden === false`), 'diary draft');
  await cdp.evaluate("document.querySelector('[data-preview=\"render\"]').click(); true");
  captures.set(diary.name, await captureViewport(cdp, diary));

  const plan = screenshotSpec('second-mind-plan.png');
  await cdp.evaluate("document.querySelector('#knowledge-draft-close').click(); true");
  await setViewport(cdp, plan);
  await submitTask(cdp, 'plan', 'Create a concise release checklist for review before writing.');
  await waitFor(() => cdp.evaluate(`document.querySelector('#knowledge-draft-dialog')?.open
    && document.querySelector('#knowledge-draft-target')?.textContent === 'Plans/Release checklist.md'
    && document.querySelector('#knowledge-send')?.hidden === false`), 'plan draft');
  await cdp.evaluate("document.querySelector('[data-preview=\"render\"]').click(); true");
  captures.set(plan.name, await captureViewport(cdp, plan));

  const mobile = screenshotSpec('second-mind-mobile.png');
  await cdp.evaluate("document.querySelector('#knowledge-draft-close').click(); true");
  await cdp.evaluate(`(() => {
    localStorage.setItem('second-mind:selected-knowledge-base:v1:demo-admin', 'demo');
    localStorage.setItem('vaultmind:selected-conversation:v2:demo-admin:demo', 'demo-welcome');
    return true;
  })()`);
  await setViewport(cdp, mobile, true);
  await navigate(cdp, `${origin}/`, `document.querySelector('#knowledge-app')?.hidden === false
    && document.querySelector('#knowledge-base-select')?.value === 'demo'
    && document.querySelector('#knowledge-transcript')?.textContent.includes('synthetic notes')`,
  '360px Demo Vault answer');
  await cdp.evaluate(`(() => {
    document.querySelector('#knowledge-logout').hidden = true;
    document.querySelector('.knowledge-sidebar')?.classList.remove('mobile-open');
    document.querySelector('#knowledge-sidebar-toggle')?.setAttribute('aria-expanded', 'false');
    const transcript = document.querySelector('#knowledge-transcript');
    transcript.scrollTop = transcript.scrollHeight;
    window.scrollTo(0, 0);
    return true;
  })()`);
  const mobileHeaderFits = await cdp.evaluate(`[
    ...document.querySelectorAll('.knowledge-header a, .knowledge-header button, .knowledge-header select')
  ].filter((element) => element.getClientRects().length).every((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  })`);
  if (!mobileHeaderFits) throw new Error('Visible mobile header controls overflow the 360px viewport.');
  captures.set(mobile.name, await captureViewport(cdp, mobile));
  return captures;
}

async function writeCaptures(captures, outputDir) {
  await fsp.mkdir(outputDir, { recursive: true });
  const results = [];
  for (const spec of SCREENSHOT_SPECS) {
    const buffer = captures.get(spec.name);
    if (!buffer) throw new Error(`Capture is missing ${spec.name}.`);
    const target = path.join(outputDir, spec.name);
    const temporary = path.join(outputDir, `.${spec.name}.${process.pid}.tmp`);
    await fsp.writeFile(temporary, buffer);
    await fsp.rename(temporary, target);
    results.push({
      ...spec,
      path: target,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    });
  }
  return results;
}

export async function captureReleaseScreenshots(options = {}) {
  const outputDir = path.resolve(options.outputDir || defaultOutputDir);
  const chromePath = path.resolve(options.chromePath || defaultChromePath);
  const WebSocketImpl = websocketImplementation();
  if (!WebSocketImpl) throw new Error('A WHATWG WebSocket implementation is required.');
  const chrome = await fsp.stat(chromePath).catch(() => null);
  if (!chrome?.isFile()) throw new Error(`Google Chrome was not found at ${chromePath}.`);

  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'second-mind-release-capture-'));
  const application = await createCaptureServer();
  let browser;
  let cdp;
  try {
    ({ chrome: browser, cdp } = await launchChrome(chromePath, profile, WebSocketImpl));
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: deterministicPageSetup });
    await cdp.call('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
    const captures = await captureAll(cdp, application);
    if (cdp.runtimeErrors.length) {
      throw new Error(`Browser exceptions occurred:\n${cdp.runtimeErrors.join('\n')}`);
    }
    const remoteRequests = cdp.networkRequests.filter((url) => (
      !url.startsWith(`${application.origin}/`)
      && !/^(?:about|blob|data):/u.test(url)
    ));
    if (remoteRequests.length) {
      throw new Error(`The screenshot run attempted a non-local request:\n${remoteRequests.join('\n')}`);
    }
    const mutations = application.requests.filter((request) => !['GET', 'HEAD'].includes(request.method));
    if (mutations.some((request) => (
      request.method !== 'POST' || request.pathname !== '/api/knowledge/tasks'
    ))) {
      throw new Error('The screenshot run attempted an unexpected state-changing request.');
    }
    return await writeCaptures(captures, outputDir);
  } finally {
    cdp?.close();
    await stopChrome(browser);
    await application.close();
    await fsp.rm(profile, {
      recursive: true, force: true, maxRetries: 3, retryDelay: 50,
    }).catch(() => {});
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const results = await captureReleaseScreenshots(options);
  process.stdout.write(`Captured ${results.length} deterministic local UI screenshots:\n`);
  for (const result of results) {
    process.stdout.write(
      `${path.relative(projectRoot, result.path)} ${result.width}x${result.height} ${result.bytes} bytes sha256:${result.sha256}\n`,
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
