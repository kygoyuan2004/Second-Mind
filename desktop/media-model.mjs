import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnHidden, terminateProcessTree } from '../platform/process-tree.mjs';
import { runtimeEnvironment } from './resources.mjs';

export async function readMediaModelStatus(stateRoot) {
  try {
    const status = JSON.parse(await fs.readFile(path.join(stateRoot, 'models', 'status.json'), 'utf8'));
    const allowed = new Set(['not-downloaded', 'downloading', 'ready', 'error']);
    if (!allowed.has(status.state)) throw new Error('Invalid media status');
    if (status.state === 'downloading' && status.updatedAt && Date.now() / 1000 - status.updatedAt > 120) {
      return { ...status, model: 'small', state: 'error', message: '语音模型下载已中断，请重试。' };
    }
    return { model: 'small', ...status };
  } catch { return { model: 'small', state: 'not-downloaded', downloadedBytes: 0, totalBytes: 486212372 }; }
}

/** Explicit preparation/retry; calling status never downloads a model. */
export function prepareMediaModel({ resources, stateRoot, signal }) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const fail = async () => {
      if (finished) return;
      finished = true;
      const message = signal?.aborted ? '语音模型下载已取消，可稍后重试。' : '语音模型下载失败，请检查网络和运行组件后重试。';
      const statusPath = path.join(stateRoot, 'models', 'status.json');
      const temporary = `${statusPath}.${process.pid}.tmp`;
      try {
        await fs.mkdir(path.dirname(statusPath), { recursive: true, mode: 0o700 });
        await fs.writeFile(temporary, JSON.stringify({ model: 'small', state: 'error', message, updatedAt: Date.now() / 1000 }), { mode: 0o600 });
        await fs.rename(temporary, statusPath);
      } catch { await fs.rm(temporary, { force: true }).catch(() => {}); }
      reject(new Error(message));
    };
    const child = spawnHidden(resources.python, ['-B', '-X', 'utf8', path.join(resources.appRoot, 'src', 'scripts', 'media_model.py')], {
      env: { ...process.env, ...runtimeEnvironment({ resources, stateRoot }) },
      stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32',
    });
    const abort = () => { void terminateProcessTree(child); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on('data', () => {});
    child.once('error', () => { signal?.removeEventListener('abort', abort); void fail(); });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (finished) return;
      if (code === 0) { finished = true; resolve(readMediaModelStatus(stateRoot)); }
      else void fail();
    });
  });
}
