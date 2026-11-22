import { EventEmitter } from 'node:events';
import { fork, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { resolveDesktopResources, runtimeEnvironment } from './resources.mjs';

export function backendEnvironment(parent, { resources, stateRoot }) {
  const result = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'TEMP', 'TMP', 'TMPDIR']) {
    if (parent[name]) result[name] = parent[name];
  }
  Object.assign(result, runtimeEnvironment({ resources, stateRoot }), {
    HOME: stateRoot, USERPROFILE: stateRoot,
    DATA_DIR: path.join(stateRoot, 'data'),
    VAULTMIND_ENV_FILE: path.join(stateRoot, '.desktop-no-env'),
    SECOND_MIND_PLATFORM_HELPER: resources.platformHelper || '',
    SECOND_MIND_DESKTOP: '1',
    NODE_ENV: 'production', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
  });
  return result;
}

const failure = (code, message) => Object.assign(new Error(message), { code });
function sendToChild(child, message) {
  if (!child?.connected) return;
  try { child.send(message, () => {}); } catch { /* Exit/close owns process failure reporting. */ }
}

export class BackendController extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.resources = resolveDesktopResources({
      appRoot: options.appRoot, resourcesPath: options.resourcesPath, packaged: options.packaged,
    });
    this.snapshot = { state: 'stopped', busy: false };
    this.child = null; this.guard = null; this.connection = null;
    this.pending = new Map(); this.starting = null; this.stopping = null;
    this.vaults = [];
  }
  status() { return { ...this.snapshot }; }
  setState(state, extra = {}) {
    this.snapshot = { state, busy: false, ...extra };
    this.emit('state', this.status());
  }
  async start(vaults) {
    if (this.starting) return this.starting;
    if (this.snapshot.state === 'ready') return this.connection;
    if (this.stopping) await this.stopping;
    if (this.child) await this.stop();
    if (!Array.isArray(vaults) || !vaults.length) throw failure('VAULT_REQUIRED', '请先选择本机知识库。');
    this.vaults = structuredClone(vaults);
    this.starting = this.startProcess().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startProcess() {
    this.setState('starting');
    const token = crypto.randomBytes(32).toString('hex');
    const child = fork(path.join(this.resources.appRoot, 'desktop', 'backend-entry.mjs'), [], {
      execPath: this.resources.node, cwd: this.resources.appRoot,
      env: backendEnvironment(process.env, { resources: this.resources, stateRoot: this.options.stateRoot }),
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    // Raw backend/SDK output can contain note text or provider diagnostics.
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => fail(failure('BACKEND_START_TIMEOUT', '本机服务启动超时，可重试或检查知识库。')), 180_000);
      const fail = (error) => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(error); }
        if (this.child === child && !this.stopping) this.setState('failed', { error: { code: error.code || 'BACKEND_FAILED', message: error.message } });
        if (child.connected) sendToChild(child, { type: 'stop' });
      };
      child.once('error', () => fail(failure('BACKEND_EXECUTABLE_MISSING', '本机运行组件无法启动，请重新安装软件。')));
      child.once('close', () => {
        if (this.child !== child) return;
        this.child = null;
        this.connection = null;
        this.guard?.stdin?.end(); this.guard = null;
        if (!settled) fail(failure('BACKEND_START_FAILED', '本机服务未能启动，请检查运行组件和目录权限。'));
        else if (!this.stopping && this.snapshot.state !== 'failed') this.setState('failed', {
          error: { code: 'BACKEND_EXITED', message: '本机服务已停止，点击重试可恢复。' },
        });
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(failure('BACKEND_EXITED', '本机服务已停止。')); }
        this.pending.clear();
      });
      child.on('message', (message) => {
        if (this.child !== child) return;
        if (message?.type === 'codec') { void this.handleCodec(child, message); return; }
        if (message?.type === 'waiting') {
          void this.attachGuard(child).then(() => {
            if (!child.connected || settled) return;
            sendToChild(child, { type: 'start', token, vaults: this.vaults,
              stateRoot: this.options.stateRoot, appRoot: this.resources.appRoot,
              resources: this.resources,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' });
          }).catch(fail);
        } else if (message?.type === 'ready') {
          if (settled) return;
          const url = new URL(message.origin);
          if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || !url.port) {
            fail(failure('BACKEND_ORIGIN_INVALID', '本机服务地址不正确。')); return;
          }
          settled = true; clearTimeout(timeout);
          this.connection = { origin: url.origin, token, cookie: message.cookie };
          this.setState('ready', { origin: url.origin }); resolve(this.connection);
        } else if (message?.type === 'activity' && this.snapshot.state === 'ready') {
          if (this.snapshot.busy !== Boolean(message.busy)) this.setState('ready', { origin: this.connection.origin, busy: Boolean(message.busy) });
        } else if (message?.type === 'failed') {
          fail(failure(message.code, message.message));
        } else if (message?.type === 'idle') {
          const request = this.pending.get(message.id);
          if (request) { this.pending.delete(message.id); clearTimeout(request.timer); request.resolve(!message.busy); }
        } else if (message?.type === 'media-result') {
          const request = this.pending.get(message.id);
          if (request) {
            this.pending.delete(message.id); clearTimeout(request.timer);
            if (message.error) request.reject(failure('MEDIA_UNAVAILABLE', message.error));
            else request.resolve(message.status);
          }
        }
      });
    });
  }
  async handleCodec(child, message) {
    const allowed = ['encrypt', 'decrypt'].includes(message.operation);
    try {
      if (!allowed || typeof message.data !== 'string' || message.data.length > 32 * 1024 * 1024) throw new Error('Invalid codec request');
      const result = await this.options.codec[message.operation](Buffer.from(message.data, 'base64'));
      if (child.connected) sendToChild(child, { type: 'codec-result', id: message.id, data: Buffer.from(result).toString('base64') });
    } catch {
      if (child.connected) sendToChild(child, { type: 'codec-result', id: message.id, error: true });
    }
  }
  async attachGuard(child) {
    if (process.platform !== 'win32') return;
    this.guard = spawn(this.resources.platformHelper, ['watch', String(process.pid), String(child.pid)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const guard = this.guard;
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(failure('PROCESS_GUARD_TIMEOUT', '后台进程保护未能就绪。')), 10_000);
      guard.once('error', () => { clearTimeout(timer); reject(failure('PROCESS_GUARD_UNAVAILABLE', '后台进程保护组件不可用。')); });
      guard.once('exit', () => { clearTimeout(timer); reject(failure('PROCESS_GUARD_EXITED', '后台进程保护组件已退出。')); });
      guard.stderr.on('data', () => {});
      guard.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.includes('READY')) { clearTimeout(timer); resolve(); }
      });
    });
  }
  async isIdle(freeze = false) {
    if (!this.child || this.snapshot.state !== 'ready') return this.snapshot.state === 'stopped';
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('BACKEND_BUSY_UNKNOWN', '暂时无法确认后台任务状态，请稍后重试。')); }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      sendToChild(this.child, { type: 'check-idle', id, freeze });
    });
  }
  async restart(vaults = this.vaults) {
    if (this.child && !(await this.isIdle(true))) throw failure('BACKEND_BUSY', '后台任务仍在执行，请完成后再更改知识库或重启。');
    await this.stop(); return this.start(vaults);
  }
  mediaStatus() { return this.mediaRequest('media-status'); }
  prepareMedia() { return this.mediaRequest('media-prepare'); }
  mediaRequest(type) {
    if (!this.child?.connected || this.snapshot.state !== 'ready') return Promise.reject(failure('BACKEND_NOT_READY', '请先启动本机知识库。'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('MEDIA_STATUS_TIMEOUT', '语音组件状态查询超时，请重试。')); }, 5_000);
      this.pending.set(id, { resolve, reject, timer }); sendToChild(this.child, { type, id });
    });
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopProcess().finally(() => { this.stopping = null; });
    return this.stopping;
  }
  async stopProcess() {
    const child = this.child;
    if (!child) { this.setState('stopped'); return; }
    this.setState('stopping');
    const exit = child.exitCode !== null || child.signalCode || !child.pid
      ? Promise.resolve()
      : new Promise((resolve) => child.once('close', resolve));
    if (child.connected) sendToChild(child, { type: 'stop' });
    const timer = setTimeout(() => { this.guard?.stdin?.end(); child.kill('SIGKILL'); }, 16_000);
    let deadline;
    try {
      await Promise.race([exit, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(failure('BACKEND_STOP_TIMEOUT', '后台未能及时退出，请退出软件后重新打开。')), 20_000);
      })]);
    } finally {
      clearTimeout(timer); clearTimeout(deadline);
      this.guard?.stdin?.end(); this.guard = null;
      if (this.child === child && (child.exitCode !== null || child.signalCode || !child.pid)) this.child = null;
    }
    this.setState('stopped');
  }
}
