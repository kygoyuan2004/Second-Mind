import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function sourceBrowser(t, url) {
  const binary = process.env.SECOND_MIND_TEST_CHROME || '/usr/bin/google-chrome';
  if (!globalThis.WebSocket || !await fsp.access(binary).then(() => true, () => false)) {
    t.skip('Chrome and Node 22 WebSocket are required for browser tests.');
    return null;
  }
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'source-preview-chrome-'));
  const chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, url], { stdio: 'ignore' });
  let socket;
  const pending = new Map();
  t.after(async () => {
    socket?.close();
    for (const value of pending.values()) value.reject(new Error('Browser closed.'));
    if (chrome.exitCode === null && chrome.signalCode === null) {
      const exited = once(chrome, 'exit');
      chrome.kill('SIGTERM');
      await Promise.race([exited, delay(1500)]);
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGKILL');
        await Promise.race([exited, delay(1500)]);
      }
    }
    await fsp.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    port = await fsp.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').then((s) => Number(s.split('\n')[0]), () => null);
    if (port) break;
    await delay(50);
  }
  if (!port) throw new Error('Chrome did not start.');
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome timeout: ${method}`)); }, 8000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    const snapshot = await evaluate(`({path: document.querySelector('#path')?.textContent, content: document.querySelector('#content')?.innerHTML})`);
    throw new Error(`Page condition not met: ${expression}; ${JSON.stringify(snapshot)}`);
  };
  return { call, evaluate, waitFor };
}
