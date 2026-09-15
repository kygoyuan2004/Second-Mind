import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutputDir = path.join(projectRoot, 'docs', 'assets');
const defaultChromePath = '/usr/bin/google-chrome';
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
  return 'Usage: node scripts/capture-screenshots.mjs --recipe /private/capture.json [--output-dir docs/assets] [--chrome /path/to/chrome]\nRecipe: {origin, cookieFile, captures: [{name, conversationId?, draftId?, trace?, provider?}]}. Run against an isolated real application with public demo data. Model answers must already exist.';
}
export function parseArguments(argv) {
  const options = { outputDir: defaultOutputDir, chromePath: defaultChromePath, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    const field = { '--output-dir': 'outputDir', '--chrome': 'chromePath', '--recipe': 'recipe' }[arg];
    if (!field) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
    options[field] = path.resolve(value);
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

function boundCdpSetup(promise, description) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10_000);
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
  const runtimeErrors = [];
  const networkRequests = [];
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
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for Chrome DevTools ${method}.`));
    }, 10_000);
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
      Promise.all([call('Network.enable'), call('Page.enable'), call('Runtime.enable')]),
      'Chrome DevTools initialization',
    );
  } catch (error) {
    try { socket.close(); } catch {}
    throw error;
  }
  return {
    call,
    networkRequests,
    runtimeErrors,
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
      return targets.find((item) => item.type === 'page');
    }, 'Chrome page target');
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

function assertSafeVisibleContent(text) {
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
  assertSafeVisibleContent(await cdp.evaluate('document.body.innerText'));
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

// No fixture server or generated UI. Optional recipe prompts run real tasks and may incur provider charges.
export async function captureReleaseScreenshots(options = {}) {
  if (!options.recipe) throw new Error('A private capture recipe is required.');
  const recipe = JSON.parse(await fsp.readFile(options.recipe, 'utf8'));
  const origin = new URL(recipe.origin);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.username || origin.password) {
    throw new Error('Use an isolated loopback application.');
  }
  const cookie = (await fsp.readFile(recipe.cookieFile, 'utf8')).trim();
  if (!/^[^=;\s]+=[^;\s]+$/.test(cookie)) throw new Error('Cookie file must contain one session cookie.');
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'second-mind-real-capture-'));
  let chrome, cdp;
  const results = [];
  try {
    ({chrome, cdp} = await launchChrome(options.chromePath || defaultChromePath, profile, websocketImplementation()));
    const sep = cookie.indexOf('=');
    await cdp.call('Network.setCookie', { name: cookie.slice(0, sep), value: cookie.slice(sep + 1), url: origin.origin, httpOnly: true, sameSite: 'Strict' });
    for (const shot of recipe.captures) {
      const spec = SCREENSHOT_SPECS.find(x => x.name === shot.name);
      if (!spec) throw new Error('Unknown release screenshot name.');
      await setViewport(cdp, spec, spec.width <= 400);
      const kb = encodeURIComponent(recipe.knowledgeBaseId || 'default');
      if (!shot.reusePage) await navigate(cdp, `${origin.origin}/${shot.provider ? 'admin-config.html' : 'knowledge.html'}?knowledgeBaseId=${kb}`,
        shot.provider ? "document.querySelector('#admin-app')?.hidden === false" : "document.querySelector('#knowledge-app')?.hidden === false", 'real application');
      if (shot.conversationId) {
        const response = await fetch(`${origin.origin}/api/knowledge/conversations/${encodeURIComponent(shot.conversationId)}?knowledgeBaseId=${kb}`, {headers: {cookie}});
        if (!response.ok) throw new Error('Cannot read the selected conversation.');
        const conversation = await response.json();
        await cdp.evaluate(`document.querySelector('[data-kind="${conversation.kind}"]').click(); true`);
        const selected = `Array.from(document.querySelectorAll('.knowledge-conversation-open')).find(e => e.querySelector('strong')?.textContent === ${JSON.stringify(conversation.title)})`;
        await waitFor(() => cdp.evaluate(`Boolean(${selected})`), 'conversation');
        await cdp.evaluate(`${selected}.click(); true`);
        await waitFor(() => cdp.evaluate("Boolean(document.querySelector('.knowledge-message.assistant'))"), 'saved answer');
      }
      if (shot.prompt) {
        await cdp.evaluate(`document.querySelector('#knowledge-new-conversation').click(); document.querySelector('[data-kind="${shot.kind || 'qa'}"]').click(); true`);
        await cdp.evaluate(`(() => {
          const fill = (selector, value) => { if (value === undefined) return; const e = document.querySelector(selector); e.value = value; e.dispatchEvent(new Event('change', {bubbles:true})); };
          fill('#knowledge-date', ${JSON.stringify(shot.date)});
          fill('#knowledge-effort', ${JSON.stringify(shot.effort)});
          fill('#knowledge-task-mode', ${JSON.stringify(shot.taskMode)});
          document.querySelector('#knowledge-prompt').value = ${JSON.stringify(shot.prompt)};
          document.querySelector('#knowledge-form').requestSubmit();
        })()`);
        await waitFor(() => cdp.evaluate("document.querySelector('#knowledge-send')?.hidden === true"), 'task start');
        await waitFor(() => cdp.evaluate("document.querySelector('#knowledge-send')?.hidden === false"), 'real SDK task completion', 180_000);
        if (await cdp.evaluate("Boolean(document.querySelector('.knowledge-message.error'))")) throw new Error('SDK task failed; inspect privately.');
      }
      if (shot.draftId) {
        await waitFor(() => cdp.evaluate("Boolean(document.querySelector('.knowledge-open-draft'))"), 'draft action');
        await cdp.evaluate("document.querySelector('.knowledge-open-draft').click(); true");
      }
      if (shot.draftId || (shot.prompt && ['diary', 'plan', 'scratch'].includes(shot.kind))) {
        await waitFor(() => cdp.evaluate("document.querySelector('#knowledge-draft-dialog')?.open === true"), 'draft preview');
        if (shot.draftMarkdownFile) {
          const content = await fsp.readFile(shot.draftMarkdownFile, 'utf8');
          await cdp.evaluate(`document.querySelector('[data-preview=edit]').click(); document.querySelector('#knowledge-draft-content').value=${JSON.stringify(content)}; document.querySelector('#knowledge-draft-content').dispatchEvent(new Event('input', {bubbles:true})); true`);
        }
        await cdp.evaluate("document.querySelector('[data-preview=render]').click(); true");
      }
      if (shot.trace) await cdp.evaluate("document.querySelectorAll('.knowledge-process').forEach(e => e.open = true); true");
      if (shot.provider) await cdp.evaluate("document.querySelectorAll('[data-provider-advanced]').forEach(e => e.open = true); document.querySelector('#providers-heading')?.scrollIntoView(); true");
      if (spec.width <= 400) await cdp.evaluate("if (document.querySelector('#knowledge-sidebar-toggle')?.getAttribute('aria-expanded') === 'true') document.querySelector('#knowledge-sidebar-toggle').click(); true");
      await cdp.evaluate("document.querySelector('#knowledge-transcript')?.scrollTo(0,0); true");
      const png = await captureViewport(cdp, spec);
      const output = path.join(options.outputDir || defaultOutputDir, spec.name);
      await fsp.mkdir(path.dirname(output), {recursive: true});
      await fsp.writeFile(output, png);
      results.push({...spec, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex')});
      if (shot.confirmDraft) {
        await cdp.evaluate("document.querySelector('#knowledge-draft-form').requestSubmit(); true");
        await waitFor(() => cdp.evaluate("document.querySelector('#knowledge-draft-dialog')?.open === false"), 'confirmed draft save');
      }
    }
    if (cdp.runtimeErrors.length) throw new Error('The real application produced browser errors; inspect privately.');
    return results;
  } finally {
    cdp?.close(); await stopChrome(chrome);
    await fsp.rm(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage() + '\n'); return; }
  const results = await captureReleaseScreenshots(options);
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch(() => { process.stderr.write('Capture failed. Check the private recipe and real application state.\n'); process.exitCode = 1; });
}
