// This process has no Electron privileges. Startup material only arrives on IPC.
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

let application;
let started = false;
let closing = false;
let tick;
let mediaOperation;
let mediaAbort;
let runtimeResources;
let runtimeStateRoot;
let sequence = 0;
const pending = new Map();
const send = (message) => { if (process.connected) { try { process.send(message, () => {}); } catch {} } };

function codecRequest(operation, input) {
  return new Promise((resolve, reject) => {
    const id = `codec-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Private storage service timed out.')); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    send({ type: 'codec', id, operation, data: Buffer.from(input).toString('base64') });
  });
}

export function applicationBusy(app) {
  if (!app) return false;
  if (mediaOperation || app.desktopActivity?.active > 0 || app.knowledgeBaseHub?.hasActiveTasks()) return true;
  const contexts = app.knowledgeBaseHub
    ? [...app.knowledgeBaseHub.records.values()].map((r) => r.context).filter(Boolean)
    : [app];
  return contexts.some((context) => {
    const manager = context.manager;
    return Boolean(manager?.running?.size || manager?.inventories?.controllers?.size
      || context.embeddingRuntime?.publicStatus?.().state === 'rebuilding'
      || [...(manager?.tasks?.values?.() || [])].some((task) =>
        !['completed', 'failed', 'cancelled', 'timed_out'].includes(task.status)));
  });
}

async function close() {
  if (closing) return;
  closing = true;
  clearInterval(tick);
  mediaAbort?.abort();
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  try {
    if (application) {
      application.desktopActivity.closing = true;
      if (application.knowledgeBaseHub) await application.knowledgeBaseHub.close();
      else await application.manager?.close();
      application.server.closeAllConnections?.();
      await new Promise((resolve) => application.server.close(resolve));
    }
  } finally {
    send({ type: 'stopped' });
    process.exit(0);
  }
}

async function start(message) {
  if (started) throw new Error('Backend already started.');
  started = true;
  const { stateRoot, appRoot, vaults, token } = message;
  runtimeStateRoot = stateRoot;
  runtimeResources = message.resources;
  if (!Array.isArray(vaults) || !vaults.length || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid desktop startup.');
  const { installPrivateCodec, protectPrivateDirectory } = await import('../platform/private-storage.mjs');
  installPrivateCodec({
    encrypt: (value) => codecRequest('encrypt', value),
    decrypt: (value) => codecRequest('decrypt', value),
    requireEncryption: true,
  });
  const dataDir = path.join(stateRoot, 'data');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await protectPrivateDirectory(dataDir);
  const { createConfig } = await import('../src/config.mjs');
  const { createRuntimeBootstrap } = await import('../src/bootstrap.mjs');
  const { startServer } = await import('../src/server.mjs');
  const { SessionManager } = await import('../src/auth.mjs');
  const config = createConfig({
    projectRoot: appRoot, publicDir: path.join(appRoot, 'public'),
    host: '127.0.0.1', port: 0, appName: 'Second Mind',
    vaultPath: vaults[0].path, vaultLabel: vaults[0].name,
    dataDir, indexDir: path.join(dataDir, 'index'), draftDir: path.join(dataDir, 'drafts'),
    recoveryDir: path.join(dataDir, 'recovery'), conversationFile: path.join(dataDir, 'conversations.json'),
    auditFile: path.join(dataDir, 'audit.jsonl'),
    timezone: message.timezone || 'Asia/Shanghai',
    auth: { username: 'admin', password: crypto.randomBytes(32).toString('hex'),
      sessionSecret: crypto.randomBytes(32).toString('hex'), secureCookie: false, desktopToken: token },
    llm: { provider: 'anthropic', model: '', apiKey: '', apiBase: '' },
    embedding: { provider: 'disabled', apiKey: '' },
    webSearch: { enabled: false, apiKey: '' },
    webReader: { enabled: false, pdfEnabled: false },
    responsesFallback: { enabled: false, apiKey: '' },
    autoCreateVaultPaths: false,
  });
  const { KnowledgeBaseRegistry } = await import('../src/knowledge-base-registry.mjs');
  const allowedRoots = vaults.map((v) => ({ id: v.id, label: v.name, path: v.path }));
  const registry = new KnowledgeBaseRegistry({
    managedFile: path.join(dataDir, 'runtime', 'knowledge-bases.json'),
    stateDir: dataDir, allowedRoots, privateStatePaths: [stateRoot],
    reconcileMounts: true,
    initialKnowledgeBases: vaults.map((v, index) => ({
      knowledgeBaseId: v.id, mountId: v.id, relativePath: '.', name: v.name,
      enabled: true, default: index === 0,
    })),
  });
  await registry.ready;
  const bootstrap = await createRuntimeBootstrap({
    config, autoDiscoverKnowledgeBases: false, allowedRoots,
    knowledgeBaseRegistry: registry,
  });
  application = await startServer({ config: bootstrap.config, dependencies: bootstrap.dependencies });
  await application.ready;
  const health = application.knowledgeBaseHub.publicStatus();
  if (!health.readyCount) throw Object.assign(new Error('没有可用的知识库，请检查目录访问权限。'), { code: 'VAULT_NOT_READY' });
  const sessions = new SessionManager(config.auth);
  const cookie = { name: 'vaultmind_session', value: sessions.token({ id: 'admin' }), path: '/', httpOnly: true, sameSite: 'strict' };
  send({ type: 'ready', origin: `http://127.0.0.1:${application.port}`, cookie });
  tick = setInterval(() => send({ type: 'activity', busy: applicationBusy(application) }), 500);
  tick.unref();
}

  if (process.send) {
  process.on('message', (message) => {
    if (message?.type === 'codec-result') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error('Private storage encryption failed.'));
      else request.resolve(Buffer.from(message.data || '', 'base64'));
      return;
    }
    if (message?.type === 'stop') { void close(); return; }
    if (message?.type === 'check-idle') {
      const busy = applicationBusy(application);
      // Admission barrier closes the gap between the idle check and shutdown.
      if (!busy && message.freeze === true && application) application.desktopActivity.closing = true;
      send({ type: 'idle', id: message.id, busy }); return;
    }
    if (message?.type === 'media-status' || message?.type === 'media-prepare') {
      void (async () => {
        if (!application || !runtimeResources || closing || application.desktopActivity.closing) throw new Error('Backend is not ready.');
        const { readMediaModelStatus, prepareMediaModel } = await import('./media-model.mjs');
        if (message.type === 'media-prepare' && !mediaOperation) {
          mediaAbort = new AbortController();
          mediaOperation = prepareMediaModel({ resources: runtimeResources, stateRoot: runtimeStateRoot, signal: mediaAbort.signal });
          mediaOperation.catch(() => {}).finally(() => { mediaOperation = null; mediaAbort = null; });
        }
        send({ type: 'media-result', id: message.id, status: await readMediaModelStatus(runtimeStateRoot) });
      })().catch(() => send({ type: 'media-result', id: message.id, error: '语音组件暂时不可用，请检查安装后重试。' }));
      return;
    }
    if (message?.type === 'start') void start(message).catch(async (error) => {
      send({ type: 'failed', code: /^[A-Z_]{1,80}$/.test(error?.code || '') ? error.code : 'BACKEND_START_FAILED',
        message: '本机服务启动失败，请检查知识库目录和运行组件。' });
      await close();
    });
  });
  process.once('disconnect', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  send({ type: 'waiting' });
}
