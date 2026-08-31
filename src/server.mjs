import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager, requireWriteGuard } from './auth.mjs';
import { createConfig, validateRuntimeConfig } from './config.mjs';
import { ConversationStore } from './conversation-store.mjs';
import { EmbeddingClient } from './embedding-client.mjs';
import { KnowledgeIndex } from './knowledge-index.mjs';
import { ChatModelClient } from './llm-client.mjs';
import { isInside, mimeTypeFor } from './path-policy.mjs';
import { TaskManager } from './task-manager.mjs';
import { VaultStore } from './vault-store.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

function httpError(status, message, code = 'REQUEST_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function securityHeaders() {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "frame-src 'self' blob:",
      "style-src 'self'",
      "style-src-attr 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

function json(res, status, value, headers = {}) {
  const payload = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readJson(req, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw httpError(413, 'Request body is too large.', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Request body must be valid JSON.', 'INVALID_JSON'); }
}

function staticMime(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
  })[extension] || 'application/octet-stream';
}

async function serveStatic(req, res, publicDir, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw httpError(400, 'URL is invalid.', 'INVALID_URL'); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw httpError(404, 'Page not found.', 'NOT_FOUND');
  }
  const target = path.resolve(publicDir, relative);
  if (!isInside(publicDir, target)) throw httpError(404, 'Page not found.', 'NOT_FOUND');
  const stat = await fsp.stat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isFile()) throw httpError(404, 'Page not found.', 'NOT_FOUND');
  const [realPublicDir, realTarget] = await Promise.all([
    fsp.realpath(publicDir),
    fsp.realpath(target),
  ]);
  if (!isInside(realPublicDir, realTarget)) throw httpError(404, 'Page not found.', 'NOT_FOUND');
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': staticMime(target),
    'Content-Length': stat.size,
    'Cache-Control': path.extname(relative) === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(realTarget).pipe(res);
}

async function resolveThroughExistingAncestor(targetInput) {
  const target = path.resolve(targetInput);
  let cursor = target;
  while (true) {
    const stat = await fsp.lstat(cursor).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat) {
      const real = await fsp.realpath(cursor);
      return path.resolve(real, path.relative(cursor, target));
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return target;
    cursor = parent;
  }
}

async function assertStateOutsideVault(config) {
  const vault = path.resolve(config.vaultPath);
  const statePaths = [
    config.dataDir, config.indexDir, config.draftDir,
    config.recoveryDir || path.join(config.dataDir, 'recovery'),
    config.conversationFile, config.auditFile,
  ].map((item) => path.resolve(item));
  if (statePaths.some((item) => isInside(vault, item))) {
    throw new Error('DATA_DIR, index, drafts, conversations, and audit files must be outside VAULT_PATH.');
  }
  const realVault = await fsp.realpath(vault);
  const resolvedStatePaths = await Promise.all(statePaths.map(resolveThroughExistingAncestor));
  if (resolvedStatePaths.some((item) => isInside(realVault, item))) {
    throw new Error('Application state resolves inside VAULT_PATH through a symbolic link.');
  }
}

export async function createApp(configInput, dependencies = {}) {
  const config = configInput || createConfig();
  await assertStateOutsideVault(config);
  const embedding = dependencies.embedding || new EmbeddingClient(config.embedding);
  const index = dependencies.index || new KnowledgeIndex(config, { client: embedding });
  const store = dependencies.store || new VaultStore(config, { policy: index.policy, index });
  const llm = dependencies.llm || new ChatModelClient(config.llm);
  const conversations = dependencies.conversations || new ConversationStore(config.conversationFile);
  const manager = dependencies.manager || new TaskManager(config, { index, store, llm, conversations });
  const sessions = dependencies.sessions || new SessionManager(config.auth);
  const initialization = { ready: false, error: null };
  const ready = (async () => {
    await manager.ready;
    await assertStateOutsideVault(config);
    initialization.ready = true;
    return true;
  })();
  ready.catch((error) => {
    initialization.error = error;
    console.error('[second-mind] INITIALIZATION_FAILED', error.code || error.name);
  });
  await assertStateOutsideVault(config);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (pathname === '/health/live' && req.method === 'GET') {
        return json(res, 200, { status: 'ok' });
      }
      if (pathname === '/health/ready' && req.method === 'GET') {
        const status = index.status();
        const isReady = initialization.ready && Boolean(status.available);
        return json(res, isReady ? 200 : 503, {
          status: initialization.error ? 'failed' : isReady ? 'ready' : 'starting',
          retrieval: {
            ready: isReady,
            mode: status.semanticAvailable ? 'hybrid' : 'keyword',
            documentCount: status.files,
          },
          ...(initialization.error ? { error: 'INITIALIZATION_FAILED' } : {}),
        });
      }

      if (pathname.startsWith('/api/')) requireWriteGuard(req);

      if (pathname === '/api/login' && req.method === 'POST') {
        const body = await readJson(req, 64 * 1024);
        const user = sessions.authenticate(body.username, body.password, req, config.trustProxy);
        return json(res, 200, { ok: true, user: { username: user.username, role: user.role } }, {
          'Set-Cookie': sessions.cookie(user),
        });
      }
      if (pathname === '/api/logout' && req.method === 'POST') {
        return json(res, 200, { ok: true }, { 'Set-Cookie': sessions.clearCookie() });
      }
      if (pathname === '/api/session' && req.method === 'GET') {
        const user = sessions.user(req);
        return json(res, 200, {
          authenticated: Boolean(user),
          authRequired: true,
          user: user ? { username: user.username, role: user.role } : null,
          permissions: user ? { useKnowledge: true } : null,
        });
      }

      const user = pathname.startsWith('/api/') ? sessions.require(req) : null;
      const userId = user?.id;

      if (pathname.startsWith('/api/knowledge/') && !initialization.ready) {
        if (initialization.error) {
          throw httpError(503, 'Knowledge service initialization failed. Check server logs.', 'INITIALIZATION_FAILED');
        }
        throw httpError(503, 'Knowledge service is still initializing.', 'INITIALIZATION_PENDING');
      }

      if (pathname === '/api/knowledge/status' && req.method === 'GET') {
        return json(res, 200, await manager.publicStatus(userId));
      }
      if (pathname === '/api/knowledge/search' && req.method === 'GET') {
        const mode = url.searchParams.get('mode') || 'keyword';
        if (!['keyword', 'semantic', 'hybrid'].includes(mode)) {
          throw httpError(400, 'Search mode is invalid.', 'INVALID_SEARCH_MODE');
        }
        const result = await index.search(url.searchParams.get('q') || '', {
          route: mode,
          limit: url.searchParams.get('limit') || 30,
        });
        if (mode === 'semantic' && result.route !== 'semantic') {
          throw httpError(503, 'Semantic search is unavailable. Configure and build an embedding index.', 'SEMANTIC_SEARCH_UNAVAILABLE');
        }
        return json(res, 200, {
          ...result,
          results: result.results.map(({ content, vector, tokens, ...item }) => item),
        });
      }
      if (pathname === '/api/knowledge/file' && ['GET', 'HEAD'].includes(req.method)) {
        const file = await store.existingFile(url.searchParams.get('path') || '');
        res.writeHead(200, {
          ...securityHeaders(),
          'Content-Type': file.mime || mimeTypeFor(file.relative),
          'Content-Length': file.stat.size,
          'Cache-Control': 'no-store',
          'Content-Disposition': file.mime === 'application/octet-stream' ? 'attachment' : 'inline',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file.target).pipe(res);
      }
      if (pathname === '/api/knowledge/conversations' && req.method === 'GET') {
        return json(res, 200, { conversations: manager.listConversations(userId) });
      }
      if (pathname === '/api/knowledge/conversations' && req.method === 'DELETE') {
        return json(res, 200, await manager.clearConversations(userId, url.searchParams.get('kind')));
      }
      const conversationMatch = /^\/api\/knowledge\/conversations\/([^/]+)$/.exec(pathname);
      if (conversationMatch && req.method === 'GET') {
        return json(res, 200, manager.getConversation(userId, decodeURIComponent(conversationMatch[1])));
      }
      if (conversationMatch && req.method === 'DELETE') {
        return json(res, 200, await manager.deleteConversation(userId, decodeURIComponent(conversationMatch[1])));
      }
      if (pathname === '/api/knowledge/tasks' && req.method === 'POST') {
        return json(res, 201, await manager.createTask(userId, await readJson(req, config.limits.jsonBodyBytes)));
      }
      const taskMatch = /^\/api\/knowledge\/tasks\/([^/]+)(?:\/(events|cancel))?$/.exec(pathname);
      if (taskMatch) {
        const [, taskId, action] = taskMatch;
        if (!action && req.method === 'GET') return json(res, 200, manager.publicTask(manager.getTask(userId, taskId)));
        if (action === 'events' && req.method === 'GET') return manager.subscribe(userId, taskId, req, res);
        if (action === 'cancel' && req.method === 'POST') return json(res, 200, manager.cancel(userId, taskId));
      }
      const draftMatch = /^\/api\/knowledge\/drafts\/([^/]+)(?:\/(save))?$/.exec(pathname);
      if (draftMatch) {
        const [, draftId, action] = draftMatch;
        if (!action && req.method === 'GET') return json(res, 200, await store.getDraft(userId, draftId));
        if (!action && req.method === 'DELETE') return json(res, 200, await store.deleteDraft(userId, draftId));
        if (action === 'save' && req.method === 'POST') {
          return json(res, 200, await store.saveDraft(userId, draftId, await readJson(req, MAX_SAFE_DRAFT_BODY)));
        }
      }
      if (pathname === '/api/knowledge/transcribe' && req.method === 'POST') {
        throw httpError(503, 'Server-side speech transcription is not enabled in this release.', 'TRANSCRIPTION_UNAVAILABLE');
      }
      if (pathname.startsWith('/api/')) throw httpError(404, 'API route not found.', 'NOT_FOUND');
      if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      return await serveStatic(req, res, config.publicDir, pathname);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = Number(error.status) || 500;
      if (status >= 500) console.error('[second-mind]', error.code || error.name, error.message);
      return json(res, status, {
        error: error.code || 'SERVER_ERROR',
        message: status >= 500 && !error.status ? 'The server could not complete this request.' : error.message,
      });
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  return { server, config, manager, index, store, conversations, ready, initialization };
}

const MAX_SAFE_DRAFT_BODY = 600 * 1024;

export async function startServer(options = {}) {
  const config = validateRuntimeConfig(options.config || createConfig());
  const app = await createApp(config, options.dependencies);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, config.host, resolve);
  });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(`${config.appName} listening on http://${config.host}:${port}`);
  console.log(`Vault: ${config.vaultLabel} (${config.sync.displayName})`);
  return { ...app, host: config.host, port };
}

const launchedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (launchedDirectly) {
  startServer().then((app) => {
    const close = async () => {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    };
    process.once('SIGINT', () => close().finally(() => process.exit(0)));
    process.once('SIGTERM', () => close().finally(() => process.exit(0)));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export const serverInternals = { readJson, serveStatic, securityHeaders, assertStateOutsideVault };
