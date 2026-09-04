import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionManager, requireWriteGuard } from './auth.mjs';
import { BailianWebSearchClient } from './bailian-web-search-client.mjs';
import { BailianResponsesExtractor } from './bailian-responses-extractor.mjs';
import { createConfig, validateRuntimeConfig } from './config.mjs';
import { ConversationStore } from './conversation-store.mjs';
import { EmbeddingClient } from './embedding-client.mjs';
import {
  EmbeddingRuntime,
  EmbeddingRuntimeError,
  promotePreviousEmbedding,
  resolveActiveEmbedding,
} from './embedding-runtime.mjs';
import { KnowledgeIndex } from './knowledge-index.mjs';
import { KnowledgeBaseHub } from './knowledge-base-hub.mjs';
import { createKnowledgeBaseContext } from './knowledge-base-runtime.mjs';
import { ChatModelClient } from './llm-client.mjs';
import {
  buildRegisteredProviderConfigPatch,
  ProviderValidationStageStore,
  SIMPLIFIED_PROVIDER_SCHEMA_VERSION,
  toSimplifiedProviderConfig,
  ValidationCredentialStore,
} from './provider-config-dto.mjs';
import { RuntimeChatModelRouter } from './runtime-chat-model-router.mjs';
import { isInside, mimeTypeFor } from './path-policy.mjs';
import { markPublicMessage, publicError } from './public-errors.mjs';
import { RuntimeWebExtractFallback, RuntimeWebSearchClient } from './runtime-services.mjs';
import { SafeWebReader } from './safe-web-reader.mjs';
import { TaskManager } from './task-manager.mjs';
import { VaultStore } from './vault-store.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDING_REBUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function httpError(status, message, code = 'REQUEST_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return markPublicMessage(error);
}

const WEB_VALIDATION_CAUSE = /^[A-Z][A-Z0-9_]{0,79}$/u;
const MODEL_VALIDATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function safeWebValidationCause(value, fallback) {
  const candidate = String(value || '').trim();
  return WEB_VALIDATION_CAUSE.test(candidate) ? candidate : fallback;
}

function safeModelValidationResults(input) {
  return input.slice(0, 64).map((entry) => {
    const modelId = String(entry?.modelId || '').trim();
    if (entry?.ok === true) {
      return {
        modelId: MODEL_VALIDATION_ID.test(modelId) ? modelId : 'unknown',
        ok: true,
        code: '',
        message: '',
      };
    }
    const failure = publicError(entry, {
      fallbackCode: 'LLM_VALIDATION_REQUEST_FAILED',
      fallbackMessage: 'Model connection validation failed. Review the provider settings and try again.',
    });
    return {
      modelId: MODEL_VALIDATION_ID.test(modelId) ? modelId : 'unknown',
      ok: false,
      ...failure,
    };
  });
}

function managedWebValidationError(stageInput, causeInput) {
  const stage = stageInput === 'extract' ? 'extract' : 'search';
  const code = stage === 'extract'
    ? 'WEB_EXTRACT_VALIDATION_FAILED'
    : 'WEB_SEARCH_VALIDATION_FAILED';
  const causeCode = safeWebValidationCause(causeInput, code);
  const error = httpError(
    400,
    stage === 'extract'
      ? `Web extraction validation failed (${causeCode}).`
      : `Web Search validation failed (${causeCode}).`,
    code,
  );
  // Only bounded machine codes cross the admin API boundary. Provider error
  // messages may contain endpoints, account details, or credentials and must
  // never be forwarded to the browser.
  error.validationStage = stage;
  error.causeCode = causeCode;
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

function streamFileResponse(res, target, headers, createReadStream = fs.createReadStream) {
  return new Promise((resolve, reject) => {
    let stream;
    try {
      stream = createReadStream(target);
    } catch {
      reject(httpError(404, 'File is no longer available.', 'FILE_UNAVAILABLE'));
      return;
    }
    let opened = false;
    let settled = false;
    const cleanup = () => {
      stream.off('open', onOpen);
      stream.off('error', onError);
      res.off('finish', onFinish);
      res.off('close', onClose);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onFinish = () => settle(resolve);
    const onClose = () => {
      if (!stream.destroyed) stream.destroy();
      settle(resolve);
    };
    const onError = () => {
      if (!opened && !res.headersSent) {
        if (!stream.destroyed) stream.destroy();
        settle(() => reject(httpError(404, 'File is no longer available.', 'FILE_UNAVAILABLE')));
        return;
      }
      // Stream errors can embed absolute host/Vault paths. Log only a fixed
      // machine code after headers have already crossed the wire.
      console.error('[second-mind] FILE_STREAM_FAILED');
      if (!res.destroyed) res.destroy();
      settle(resolve);
    };
    const onOpen = () => {
      if (settled) return;
      opened = true;
      try {
        res.writeHead(200, headers);
        stream.pipe(res);
      } catch {
        onError();
      }
    };
    stream.once('open', onOpen);
    stream.once('error', onError);
    res.once('finish', onFinish);
    res.once('close', onClose);
  });
}

async function serveStatic(req, res, publicDir, pathname, createReadStream = fs.createReadStream) {
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
  const headers = {
    ...securityHeaders(),
    'Content-Type': staticMime(target),
    'Content-Length': stat.size,
    // The browser UI and the task contract are deployed together. Revalidate
    // every static asset on refresh so a cached client cannot keep submitting
    // an older contract to a newly restarted backend.
    'Cache-Control': 'no-cache, must-revalidate',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }
  return streamFileResponse(res, realTarget, headers, createReadStream);
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

async function assertStateOutsideVault(config, additionalPaths = []) {
  const vault = path.resolve(config.vaultPath);
  const statePaths = [
    config.dataDir, config.indexDir, config.draftDir,
    config.recoveryDir || path.join(config.dataDir, 'recovery'),
    config.conversationFile, config.auditFile,
    ...additionalPaths.filter(Boolean),
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

function runtimeConfigurationUnavailable() {
  throw httpError(
    503,
    'Runtime configuration management is not enabled on this deployment.',
    'RUNTIME_CONFIG_UNAVAILABLE',
  );
}

function requireAdministrator(user) {
  if (user?.role !== 'admin') {
    throw httpError(403, 'Administrator access is required.', 'ADMIN_REQUIRED');
  }
}

function reauthenticateAdministrator(sessions, user, body, req, config) {
  const password = typeof body?.adminPassword === 'string' ? body.adminPassword : '';
  if (!password) {
    throw httpError(
      400,
      'The current administrator password is required.',
      'ADMIN_PASSWORD_REQUIRED',
    );
  }
  const authenticated = sessions.authenticate(
    user.username,
    password,
    req,
    config.trustProxy,
  );
  if (authenticated.id !== user.id || authenticated.role !== 'admin') {
    throw httpError(403, 'Administrator confirmation failed.', 'ADMIN_CONFIRMATION_FAILED');
  }
}

function requireEmbeddingRebuildId(value) {
  if (typeof value !== 'string' || !EMBEDDING_REBUILD_ID.test(value)) {
    throw httpError(
      400,
      'Embedding rebuild ID is invalid.',
      'INVALID_EMBEDDING_REBUILD_ID',
    );
  }
  return value;
}

function sanitizedIndexStatus(index) {
  const status = index?.status?.() || {};
  if (status.active) return status;
  const embedding = status.embedding || {};
  return {
    state: status.available === true ? 'ready' : 'starting',
    active: {
      revision: String(status.generation || 'unbuilt'),
      available: status.available === true,
      generation: String(status.generation || 'unbuilt'),
      files: Math.max(0, Number(status.files) || 0),
      chunks: Math.max(0, Number(status.chunks) || 0),
      embeddedChunks: Math.max(0, Number(status.embeddedChunks) || 0),
      lexicalAvailable: status.lexicalAvailable === true,
      semanticAvailable: status.semanticAvailable === true,
      embedding: {
        provider: String(embedding.provider || 'disabled'),
        model: embedding.model ? String(embedding.model) : null,
        dimensions: Number(embedding.dimensions) || null,
      },
    },
    pending: null,
    lastAttempt: status.lastError
      ? { status: 'failed', errorCode: String(status.lastError.code || 'KNOWLEDGE_INDEX_ERROR') }
      : null,
  };
}

function resolvedIndexIsUsable(index, state) {
  const status = index?.status?.() || {};
  if (status.available !== true || status.lexicalAvailable !== true) return false;
  // `state.generation` records the fully validated generation at activation
  // time. Once that slot is live, file watching and reconciliation may commit
  // newer generations inside the same KnowledgeIndex. The slot/revision and
  // embedding signature are the durable identity; requiring generation
  // equality here would incorrectly roll a healthy, updated index backward.
  const expected = state.embedding || {};
  const actual = status.embedding || {};
  if (
    String(actual.provider || 'disabled') !== String(expected.provider || 'disabled') ||
    (expected.provider !== 'disabled' && (
      String(actual.model || '') !== String(expected.model || '') ||
      Number(actual.dimensions) !== Number(expected.dimensions)
    ))
  ) return false;
  // An active slot may legitimately be degraded after a transient provider
  // failure while indexing a newly changed Vault file. KnowledgeIndex keeps
  // that generation for fresh lexical retrieval and exposes the semantic
  // degradation in status. Candidate activation is still strict; restart must
  // preserve the fresher live slot instead of rolling back user-visible data.
  return true;
}

async function openResolvedIndex(config, state, clientOverride = null) {
  const activeConfig = {
    ...config,
    indexDir: state.indexDir,
    embedding: state.embedding,
  };
  const client = clientOverride || new EmbeddingClient(state.embedding);
  const index = new KnowledgeIndex(activeConfig, {
    client,
    // Committed slots were completely built and validated before their
    // pointer became active. Restarting must never mutate one in place.
    autoBuild: state.selection === 'base',
  });
  try {
    await index.ready;
    return { client, index };
  } catch (error) {
    await Promise.resolve(index.close?.()).catch(() => {});
    throw error;
  }
}

async function runtimeConfigurationResponse(runtimeConfig, index) {
  const snapshot = await runtimeConfig.refresh();
  const indexStatus = sanitizedIndexStatus(index);
  return {
    ...snapshot,
    source: snapshot.source || (
      snapshot.models?.some((model) => model.inherited === false) ? 'managed' : 'settings'
    ),
    index: indexStatus,
    rebuild: indexStatus.pending || indexStatus.lastAttempt || { status: 'idle' },
  };
}

async function providerConfigurationResponse(runtimeConfig, index) {
  const runtime = await runtimeConfigurationResponse(runtimeConfig, index);
  const simplified = toSimplifiedProviderConfig(runtimeConfig.runtimeSnapshot());
  return {
    ...simplified,
    stale: runtime.stale === true,
    ...(runtime.staleCode ? { staleCode: runtime.staleCode } : {}),
    webSearch: runtime.webSearch,
    embedding: runtime.embedding,
    index: runtime.index,
    rebuild: runtime.rebuild,
    capabilities: {
      validationReceipts: true,
      transactionalWebSearch: true,
      branding: true,
      automaticEmbeddingDimensions: true,
    },
  };
}

async function validateManagedRuntimeCandidate(snapshot, services) {
  const enabledModels = Array.isArray(snapshot?.models)
    ? snapshot.models.filter((model) => model.enabled !== false)
    : [];
  const llm = enabledModels.length
    ? await services.llmRouter.validateAllEnabled(snapshot, { concurrency: 2 })
    : { checked: 0 };
  const web = await validateManagedWebCandidate(snapshot, services);
  return { llmModels: llm.checked, ...web };
}

async function validateManagedWebCandidate(snapshot, services) {
  if (snapshot?.webSearch?.enabled !== true) {
    return { webSearch: false, extraction: false };
  }
  let searchLease;
  let extractLease;
  try {
    try {
      searchLease = await services.webSearch.acquireForTask({ runtimeSnapshot: snapshot });
    } catch (error) {
      throw managedWebValidationError('search', error?.code || 'WEB_SEARCH_ACQUIRE_FAILED');
    }
    const status = searchLease.publicStatus?.() || {};
    if (status.enabled !== true || status.configured !== true) {
      throw managedWebValidationError('search', 'WEB_SEARCH_NOT_CONFIGURED');
    }
    let result;
    try {
      result = await searchLease.searchMany(['OpenAI official website'], {
        resultCount: 1,
        maxResultsPerDomain: 1,
      });
    } catch (error) {
      throw managedWebValidationError('search', error?.code || 'WEB_SEARCH_REQUEST_FAILED');
    }
    if ((result?.errors || []).length || !(result?.attempts || []).some((item) => item.status === 'completed')) {
      throw managedWebValidationError(
        'search',
        result?.errors?.[0]?.code || 'WEB_SEARCH_REQUEST_FAILED',
      );
    }
    const extractEnabled = snapshot.webSearch.extractFallbackEnabled === true;
    if (!extractEnabled) {
      return { webSearch: true, extraction: false };
    }
    const source = (result.results || result.evidenceCandidates || [])[0];
    if (!source?.url) {
      throw managedWebValidationError('extract', 'WEB_EXTRACT_SOURCE_MISSING');
    }
    try {
      extractLease = await services.responsesExtractor.acquireForTask({ runtimeSnapshot: snapshot });
    } catch (error) {
      throw managedWebValidationError('extract', error?.code || 'WEB_EXTRACT_ACQUIRE_FAILED');
    }
    const extractStatus = extractLease.publicStatus?.() || {};
    if (extractStatus.enabled !== true || extractStatus.configured !== true) {
      throw managedWebValidationError('extract', 'WEB_EXTRACT_NOT_CONFIGURED');
    }
    let extracted;
    try {
      extracted = await extractLease.extract({
        sources: [{ ...source, id: 'W1' }],
        sourceIds: ['W1'],
        goal: 'Confirm the page title and purpose.',
        anchors: ['OpenAI'],
      });
    } catch (error) {
      throw managedWebValidationError('extract', error?.code || 'WEB_EXTRACT_REQUEST_FAILED');
    }
    if ((extracted?.errors || []).length || !(extracted?.attempts || []).some((item) => item.status === 'completed')) {
      throw managedWebValidationError(
        'extract',
        extracted?.errors?.[0]?.code || 'WEB_EXTRACT_REQUEST_FAILED',
      );
    }
    return { webSearch: true, extraction: true };
  } finally {
    await Promise.resolve(extractLease?.close?.()).catch(() => {});
    await Promise.resolve(searchLease?.close?.()).catch(() => {});
  }
}

export async function createApp(configInput, dependencies = {}) {
  const config = configInput || createConfig();
  const createReadStream = dependencies.createReadStream || fs.createReadStream;
  const runtimeConfig = dependencies.runtimeConfig || null;
  const runtimeOptions = dependencies.embeddingRuntimeOptions || {};
  const knowledgeBaseRegistry = dependencies.knowledgeBaseRegistry || null;
  const privateStatePaths = [
    runtimeConfig?.settingsFile,
    runtimeConfig?.managedFile,
    runtimeConfig?.lastKnownGoodFile,
    knowledgeBaseRegistry?.managedFile,
    knowledgeBaseRegistry?.previousFile,
    runtimeOptions.activeProfileFile,
    runtimeOptions.slotsRoot,
  ];
  if (!knowledgeBaseRegistry) await assertStateOutsideVault(config, privateStatePaths);
  if (runtimeConfig?.ready) await runtimeConfig.ready;
  const llm = dependencies.llm || new ChatModelClient(config.llm);
  const llmRouter = dependencies.llmRouter || (
    runtimeConfig
      ? new RuntimeChatModelRouter({
          registry: runtimeConfig,
          baseConfig: config.llm,
          ...(dependencies.runtimeLlmOptions || {}),
        })
      : null
  );
  const providerValidationCredentials = dependencies.providerValidationCredentials ||
    new ValidationCredentialStore();
  const providerValidationStages = dependencies.providerValidationStages ||
    new ProviderValidationStageStore();
  const webSearch = dependencies.webSearch || (
    runtimeConfig
      ? new RuntimeWebSearchClient(runtimeConfig, config.webSearch)
      : new BailianWebSearchClient(config.webSearch)
  );
  const webReader = dependencies.webReader || new SafeWebReader(config.webReader);
  const responsesExtractor = dependencies.responsesExtractor || (
    runtimeConfig
      ? new RuntimeWebExtractFallback(runtimeConfig, {
          bailianConfig: config.responsesFallback,
          tavilyConfig: {
            enabled: true,
            timeoutMs: config.responsesFallback?.timeoutMs,
            maxResponseBytes: config.responsesFallback?.maxResponseBytes,
            maxOutputChars: config.webReader?.pageMaxChars,
            webSearch: config.webSearch,
          },
        })
      : new BailianResponsesExtractor(config.responsesFallback)
  );
  let embedding = dependencies.embedding || null;
  let index = dependencies.index || null;
  let embeddingRuntime = dependencies.embeddingRuntime || null;
  let store = dependencies.store || null;
  let conversations = dependencies.conversations || null;
  let manager = dependencies.manager || null;
  let knowledgeBaseHub = dependencies.knowledgeBaseHub || null;

  if (knowledgeBaseRegistry) {
    knowledgeBaseHub ||= new KnowledgeBaseHub({
      registry: knowledgeBaseRegistry,
      createContext: dependencies.knowledgeBaseContextFactory || ((entry) => createKnowledgeBaseContext(
        config,
        entry,
        {
          ...dependencies,
          runtimeConfig,
          llm,
          llmRouter,
          webSearch,
          webReader,
          responsesExtractor,
        },
      )),
    });
    await knowledgeBaseHub.ready;
    const hubStatus = knowledgeBaseHub.publicStatus();
    const preferred = hubStatus.knowledgeBases.find((item) => (
      item.knowledgeBaseId === hubStatus.defaultKnowledgeBaseId && item.status === 'ready'
    )) || hubStatus.knowledgeBases.find((item) => item.status === 'ready');
    if (preferred) {
      const context = knowledgeBaseHub.resolve(preferred.knowledgeBaseId);
      ({ embedding, index, embeddingRuntime, store, conversations, manager } = context);
    }
  } else {
    if (!index) {
      if (runtimeConfig && runtimeOptions?.activeProfileFile && runtimeOptions?.slotsRoot) {
        let activeState = await resolveActiveEmbedding(config, runtimeOptions);
        let opened;
        try {
          opened = await openResolvedIndex(config, activeState, embedding);
          if (activeState.selection !== 'base' && !resolvedIndexIsUsable(opened.index, activeState)) {
            throw new EmbeddingRuntimeError(
              'The committed embedding index does not match its active profile.',
              'ACTIVE_EMBEDDING_INDEX_INVALID',
              503,
            );
          }
        } catch (currentError) {
          if (activeState.selection === 'base') throw currentError;
          await Promise.resolve(opened?.index?.close?.()).catch(() => {});
          let previousState;
          let previousOpened;
          try {
            previousState = await resolveActiveEmbedding(config, {
              ...runtimeOptions,
              selection: 'previous',
            });
            previousOpened = await openResolvedIndex(config, previousState);
            if (!resolvedIndexIsUsable(previousOpened.index, previousState)) {
              throw new EmbeddingRuntimeError(
                'The previous embedding index does not match its saved profile.',
                'ACTIVE_EMBEDDING_PREVIOUS_INVALID',
                503,
              );
            }
            await promotePreviousEmbedding({
              activeProfileFile: runtimeOptions.activeProfileFile,
              expectedCurrentRevision: activeState.revision,
            });
            activeState = previousState;
            opened = previousOpened;
          } catch (previousError) {
            await Promise.resolve(previousOpened?.index?.close?.()).catch(() => {});
            throw new EmbeddingRuntimeError(
              'Neither the current nor previous embedding index could be opened safely.',
              'ACTIVE_EMBEDDING_INDEX_UNAVAILABLE',
              503,
              { cause: previousError, currentError },
            );
          }
        }
        embedding = opened.client;
        const activeIndex = opened.index;
        embeddingRuntime = new EmbeddingRuntime({
          registry: runtimeConfig,
          baseConfig: config,
          activeProfileFile: runtimeOptions.activeProfileFile,
          slotsRoot: runtimeOptions.slotsRoot,
          activeState,
          activeIndex,
          lookup: runtimeOptions.lookup,
          embeddingFetch: runtimeOptions.embeddingFetch,
          httpsRequest: runtimeOptions.httpsRequest || runtimeOptions.request,
          embeddingClientFactory: runtimeOptions.embeddingClientFactory,
          indexFactory: runtimeOptions.indexFactory,
        });
        index = embeddingRuntime.index;
      } else {
        embedding ||= new EmbeddingClient(config.embedding);
        index = new KnowledgeIndex(config, { client: embedding });
      }
    }
    store ||= new VaultStore(config, { policy: index.policy, index });
    conversations ||= new ConversationStore(config.conversationFile);
    manager ||= new TaskManager(config, {
      index, store, llm, llmRouter, webSearch, webReader, responsesExtractor, conversations,
      runtimeConfig,
    });
  }
  const sessions = dependencies.sessions || new SessionManager(config.auth);
  const initialization = { ready: false, error: null };
  const ready = (async () => {
    if (knowledgeBaseHub) {
      await knowledgeBaseHub.ready;
      if (knowledgeBaseHub.publicStatus().readyCount < 1) {
        throw httpError(503, 'No enabled knowledge base is ready.', 'NO_READY_KNOWLEDGE_BASE');
      }
    } else {
      await manager.ready;
      await assertStateOutsideVault(config, privateStatePaths);
    }
    initialization.ready = true;
    return true;
  })();
  ready.catch((error) => {
    initialization.error = error;
    console.error('[second-mind] INITIALIZATION_FAILED', error.code || error.name);
  });
  if (!knowledgeBaseHub) await assertStateOutsideVault(config, privateStatePaths);

  const singletonKnowledgeBaseId = String(config.knowledgeBaseId || 'default');
  const singletonKnowledgeBaseRevision = String(config.knowledgeBaseRevision || 'legacy');
  function requestKnowledgeBaseId(url, body = null) {
    const queryId = String(url.searchParams.get('knowledgeBaseId') || '').trim();
    const bodyId = body && Object.hasOwn(body, 'knowledgeBaseId')
      ? String(body.knowledgeBaseId || '').trim()
      : '';
    if (queryId && bodyId && queryId !== bodyId) {
      throw httpError(400, 'Knowledge-base selections conflict.', 'KNOWLEDGE_BASE_SELECTION_CONFLICT');
    }
    return bodyId || queryId;
  }
  function resolveKnowledgeContext(id = '') {
    if (knowledgeBaseHub) return knowledgeBaseHub.resolve(id);
    const requested = String(id || singletonKnowledgeBaseId).trim().toLowerCase();
    if (requested !== singletonKnowledgeBaseId.toLowerCase()) {
      throw httpError(404, 'Knowledge base was not found.', 'KNOWLEDGE_BASE_NOT_FOUND');
    }
    return {
      knowledgeBaseId: singletonKnowledgeBaseId,
      knowledgeBaseRevision: singletonKnowledgeBaseRevision,
      name: config.vaultLabel,
      config,
      embedding,
      index,
      embeddingRuntime,
      store,
      conversations,
      manager,
    };
  }
  function contextIdentity(context) {
    return {
      knowledgeBaseId: context.knowledgeBaseId || singletonKnowledgeBaseId,
      knowledgeBaseRevision: context.knowledgeBaseRevision || singletonKnowledgeBaseRevision,
      knowledgeBaseName: context.name || context.config?.vaultLabel || config.vaultLabel,
    };
  }
  function publicKnowledgeBases() {
    if (knowledgeBaseHub) return knowledgeBaseHub.publicStatus();
    const status = index?.status?.() || {};
    const readyState = initialization.ready && status.available === true;
    return {
      revision: singletonKnowledgeBaseRevision,
      stale: false,
      defaultKnowledgeBaseId: singletonKnowledgeBaseId,
      readyCount: readyState ? 1 : 0,
      enabledCount: 1,
      knowledgeBases: [{
        knowledgeBaseId: singletonKnowledgeBaseId,
        name: config.vaultLabel,
        enabled: true,
        default: true,
        revision: singletonKnowledgeBaseRevision,
        status: readyState ? 'ready' : initialization.error ? 'failed' : 'starting',
        retrieval: {
          ready: readyState,
          mode: status.semanticAvailable ? 'hybrid' : status.lexicalAvailable ? 'keyword' : 'unavailable',
          documentCount: Math.max(0, Number(status.files) || 0),
        },
      }],
    };
  }
  function withContextIdentity(value, context) {
    return { ...value, ...contextIdentity(context) };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (pathname === '/health/live' && req.method === 'GET') {
        return json(res, 200, { status: 'ok' });
      }
      if (pathname === '/health/ready' && req.method === 'GET') {
        const bases = publicKnowledgeBases();
        const readerStatus = webReader.publicStatus?.() || {};
        const isReady = initialization.ready && bases.readyCount > 0;
        return json(res, isReady ? 200 : 503, {
          status: initialization.error ? 'failed' : isReady ? 'ready' : 'starting',
          retrieval: { ready: isReady },
          webReading: {
            enabled: readerStatus.enabled === true,
            pdfAvailable: readerStatus.pdfAvailable === true,
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
          permissions: user ? {
            useKnowledge: true,
            manageRuntimeConfig: Boolean(runtimeConfig),
            manageKnowledgeBases: Boolean(knowledgeBaseRegistry && knowledgeBaseHub),
          } : null,
        });
      }

      const user = pathname.startsWith('/api/') ? sessions.require(req) : null;
      const userId = user?.id;

      if (pathname === '/api/admin/knowledge-bases' && req.method === 'GET') {
        requireAdministrator(user);
        if (!knowledgeBaseRegistry || !knowledgeBaseHub) {
          throw httpError(
            503,
            'Knowledge-base registry management is not enabled on this deployment.',
            'KNOWLEDGE_BASE_REGISTRY_UNAVAILABLE',
          );
        }
        await knowledgeBaseHub.refresh();
        const administrative = knowledgeBaseRegistry.administrativeSnapshot();
        const statusById = new Map(knowledgeBaseHub.publicStatus().knowledgeBases.map((item) => [
          item.knowledgeBaseId,
          { status: item.status, retrieval: item.retrieval, ...(item.errorCode ? { errorCode: item.errorCode } : {}) },
        ]));
        return json(res, 200, {
          ...administrative,
          knowledgeBases: administrative.knowledgeBases.map((item) => ({
            ...item,
            ...(statusById.get(item.knowledgeBaseId) || {}),
          })),
        });
      }
      if (pathname === '/api/admin/knowledge-bases' && req.method === 'PUT') {
        requireAdministrator(user);
        if (!knowledgeBaseRegistry || !knowledgeBaseHub) {
          throw httpError(
            503,
            'Knowledge-base registry management is not enabled on this deployment.',
            'KNOWLEDGE_BASE_REGISTRY_UNAVAILABLE',
          );
        }
        const body = await readJson(req, 128 * 1024);
        reauthenticateAdministrator(sessions, user, body, req, config);
        const allowed = new Set(['adminPassword', 'expectedRevision', 'knowledgeBases']);
        if (Object.keys(body).some((name) => !allowed.has(name))) {
          throw httpError(400, 'Knowledge-base configuration contains an unsupported field.',
            'INVALID_KNOWLEDGE_BASE_CONFIG');
        }
        const submitted = Array.isArray(body.knowledgeBases) ? body.knowledgeBases : [];
        await knowledgeBaseHub.updateRegistry({
          expectedRevision: body.expectedRevision,
          knowledgeBases: submitted,
        }, { expectedRevision: body.expectedRevision });
        const administrative = knowledgeBaseRegistry.administrativeSnapshot();
        const statusById = new Map(knowledgeBaseHub.publicStatus().knowledgeBases.map((item) => [
          item.knowledgeBaseId,
          { status: item.status, retrieval: item.retrieval, ...(item.errorCode ? { errorCode: item.errorCode } : {}) },
        ]));
        return json(res, 200, {
          ...administrative,
          knowledgeBases: administrative.knowledgeBases.map((item) => ({
            ...item,
            ...(statusById.get(item.knowledgeBaseId) || {}),
          })),
        });
      }

      if (pathname === '/api/admin/provider-config' && req.method === 'GET') {
        requireAdministrator(user);
        if (!runtimeConfig) runtimeConfigurationUnavailable();
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        return json(res, 200, await providerConfigurationResponse(runtimeConfig, context.index));
      }
      if (pathname === '/api/admin/provider-config/validate' && req.method === 'POST') {
        requireAdministrator(user);
        if (!runtimeConfig || !llmRouter) runtimeConfigurationUnavailable();
        const body = await readJson(req, 64 * 1024);
        reauthenticateAdministrator(sessions, user, body, req, config);
        const {
          adminPassword: _password,
          validateConnectionId: rawValidateConnectionId,
          validateProviderIndex: rawValidateProviderIndex,
          validationStageId: rawValidationStageId,
          ...submittedInput
        } = body;
        const validationStageId = String(rawValidationStageId || '').trim();
        const validateConnectionId = rawValidateConnectionId === undefined
          ? ''
          : String(rawValidateConnectionId || '').trim();
        const hasProviderIndex = rawValidateProviderIndex !== undefined;
        const validateProviderIndex = hasProviderIndex ? Number(rawValidateProviderIndex) : -1;
        if (validateConnectionId && hasProviderIndex) {
          throw httpError(400, 'Only one provider validation target may be supplied.',
            'INVALID_PROVIDER_VALIDATION_TARGET');
        }
        if (validateConnectionId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(validateConnectionId)) {
          throw httpError(400, 'The provider validation target is invalid.',
            'INVALID_PROVIDER_VALIDATION_TARGET');
        }
        if (hasProviderIndex && (!Number.isSafeInteger(validateProviderIndex) ||
          validateProviderIndex < 0 || validateProviderIndex >= 16)) {
          throw httpError(400, 'The provider validation target is invalid.',
            'INVALID_PROVIDER_VALIDATION_TARGET');
        }
        await runtimeConfig.refresh();
        const current = runtimeConfig.runtimeSnapshot();
        let candidate;
        let staged = null;
        let input = submittedInput;
        if (validationStageId) {
          const allowed = new Set(['schemaVersion', 'expectedRevision']);
          if (Object.keys(submittedInput).some((name) => !allowed.has(name))) {
            throw httpError(400, 'A staged validation cannot include a replacement candidate.',
              'INVALID_PROVIDER_VALIDATION_STAGE');
          }
          if (submittedInput.schemaVersion !== SIMPLIFIED_PROVIDER_SCHEMA_VERSION) {
            throw httpError(409, 'The provider configuration client schema is unsupported.',
              'PROVIDER_CONFIG_CLIENT_UPGRADE_REQUIRED');
          }
          staged = providerValidationStages.resume({
            token: validationStageId,
            adminId: user.id,
            currentRevision: current.revision,
          });
          candidate = {
            patch: staged.candidate,
            candidateDigest: staged.candidateDigest,
            idAssignments: [],
          };
          input = {
            schemaVersion: submittedInput.schemaVersion,
            expectedRevision: submittedInput.expectedRevision,
          };
        } else {
          candidate = buildRegisteredProviderConfigPatch(submittedInput, current);
        }
        const preview = await runtimeConfig.previewUpdate(candidate.patch, {
          expectedRevision: input.expectedRevision,
        });
        let targetConnectionId = validateConnectionId;
        if (hasProviderIndex) {
          targetConnectionId = String(candidate.patch.connections?.[validateProviderIndex]?.id || '');
          if (!targetConnectionId) {
            throw httpError(400, 'The selected provider connection was not found.',
              'PROVIDER_VALIDATION_TARGET_NOT_FOUND');
          }
        }
        const validatedConnectionIds = new Set(staged?.connectionIds || []);
        const enabledModels = preview.models.filter((model) => model.enabled !== false);
        if (targetConnectionId && !preview.connections.some((entry) => entry.id === targetConnectionId)) {
          throw httpError(400, 'The selected provider connection was not found.',
            'PROVIDER_VALIDATION_TARGET_NOT_FOUND');
        }
        const targetModels = targetConnectionId
          ? enabledModels.filter((model) => model.connectionId === targetConnectionId)
          : [];
        if (targetConnectionId && !targetModels.length) {
          throw httpError(400, 'The selected provider has no enabled model.',
            'MODEL_VALIDATION_TARGET_EMPTY');
        }
        const requestedModels = targetConnectionId
          ? (validatedConnectionIds.has(targetConnectionId) ? [] : targetModels)
          : enabledModels.filter((model) => !validatedConnectionIds.has(model.connectionId));
        let validation;
        try {
          validation = requestedModels.length
            ? await llmRouter.validateAllEnabled(preview, {
                concurrency: 2,
                modelIds: requestedModels.map((model) => model.id),
              })
            : { ok: true, checked: 0, results: [] };
        } catch (error) {
          if (Array.isArray(error?.results)) {
            const failure = publicError(error, {
              fallbackCode: 'LLM_VALIDATION_FAILED',
              fallbackMessage: 'Model validation failed. Review the provider settings and try again.',
            });
            return json(res, 422, {
              ok: false,
              error: failure.code,
              message: failure.message,
              results: safeModelValidationResults(error.results),
            });
          }
          throw error;
        }
        // A card-level check never validates WebSearch and cannot itself
        // commit. It stages the exact secret-bearing candidate so a later
        // all-provider check can skip this connection without asking the
        // browser to retain or resend its key.
        if (targetConnectionId) {
          await runtimeConfig.previewUpdate(candidate.patch, {
            expectedRevision: input.expectedRevision,
          });
          const stage = validationStageId
            ? providerValidationStages.add({
                token: validationStageId,
                adminId: user.id,
                currentRevision: current.revision,
                connectionId: targetConnectionId,
              })
            : providerValidationStages.issue({
                adminId: user.id,
                baseRevision: input.expectedRevision,
                candidate: candidate.patch,
                candidateDigest: candidate.candidateDigest,
                connectionId: targetConnectionId,
              });
          return json(res, 200, {
            ok: true,
            scope: {
              kind: 'provider',
              connectionId: targetConnectionId,
              ...(hasProviderIndex ? { providerIndex: validateProviderIndex } : {}),
            },
            validationStageId: stage.token,
            expiresAt: stage.expiresAt,
            results: validation.results.length
              ? validation.results
              : targetModels.map((model) => ({
                  modelId: model.id,
                  ok: true,
                  code: '',
                  message: '',
                  cached: true,
                })),
            webSearch: { skipped: true },
            idAssignments: candidate.idAssignments,
          });
        }
        let webValidation;
        try {
          webValidation = await validateManagedWebCandidate(preview, {
            webSearch,
            responsesExtractor,
          });
        } catch (error) {
          const stage = error?.validationStage === 'extract' ? 'extract' : 'search';
          const code = stage === 'extract'
            ? 'WEB_EXTRACT_VALIDATION_FAILED'
            : 'WEB_SEARCH_VALIDATION_FAILED';
          const causeCode = safeWebValidationCause(error?.causeCode || error?.code, code);
          const provider = ['bailian-mcp', 'tavily-rest'].includes(preview?.webSearch?.provider)
            ? preview.webSearch.provider
            : 'unknown';
          return json(res, 422, {
            ok: false,
            error: code,
            message: stage === 'extract'
              ? `Web Search passed, but the selected extraction fallback failed validation (${causeCode}).`
              : `The selected Web Search provider failed validation (${causeCode}).`,
            results: validation.results,
            webSearch: {
              ok: false,
              provider,
              stage,
              code,
              causeCode,
              searchPassed: stage === 'extract',
            },
          });
        }
        // The connectivity probes may take long enough for another browser tab
        // to commit a newer configuration. Re-run the non-mutating CAS preview
        // before issuing a bearer receipt so a stale candidate can never be
        // committed after it was tested against an older base revision.
        await runtimeConfig.previewUpdate(candidate.patch, {
          expectedRevision: input.expectedRevision,
        });
        const resultByModelId = new Map(validation.results.map((entry) => [entry.modelId, entry]));
        for (const model of enabledModels) {
          if (validatedConnectionIds.has(model.connectionId) && !resultByModelId.has(model.id)) {
            resultByModelId.set(model.id, {
              modelId: model.id,
              ok: true,
              code: '',
              message: '',
              cached: true,
            });
          }
        }
        const combinedResults = enabledModels.map((model) => resultByModelId.get(model.id)).filter(Boolean);
        const receipt = providerValidationCredentials.issue({
          adminId: user.id,
          baseRevision: input.expectedRevision,
          candidate: candidate.patch,
          candidateDigest: candidate.candidateDigest,
        });
        if (validationStageId) providerValidationStages.revoke(validationStageId);
        return json(res, 200, {
          ok: true,
          validationId: receipt.token,
          expiresAt: receipt.expiresAt,
          results: combinedResults,
          webSearch: { ok: true, ...webValidation },
          idAssignments: candidate.idAssignments,
        });
      }
      if (pathname === '/api/admin/provider-config' && req.method === 'PUT') {
        requireAdministrator(user);
        if (!runtimeConfig) runtimeConfigurationUnavailable();
        const body = await readJson(req, 64 * 1024);
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url, body));
        reauthenticateAdministrator(sessions, user, body, req, config);
        const allowed = new Set([
          'schemaVersion', 'expectedRevision', 'validationId', 'branding', 'adminPassword',
          'knowledgeBaseId',
        ]);
        if (Object.keys(body).some((name) => !allowed.has(name))) {
          throw httpError(400, 'Provider configuration contains an unsupported field.',
            'INVALID_PROVIDER_CONFIG');
        }
        if (body.schemaVersion !== SIMPLIFIED_PROVIDER_SCHEMA_VERSION) {
          throw httpError(409, 'The provider configuration client schema is unsupported.',
            'PROVIDER_CONFIG_CLIENT_UPGRADE_REQUIRED');
        }
        const expectedRevision = String(body.expectedRevision || '').trim();
        let patch;
        if (body.validationId) {
          await runtimeConfig.refresh();
          patch = providerValidationCredentials.claim({
            token: body.validationId,
            adminId: user.id,
            currentRevision: runtimeConfig.runtimeSnapshot().revision,
          });
        } else {
          patch = { schemaVersion: 2, expectedRevision };
        }
        if (body.branding !== undefined) patch.branding = body.branding;
        if (!body.validationId && body.branding === undefined) {
          throw httpError(400, 'Validate provider changes before saving.',
            'PROVIDER_VALIDATION_REQUIRED');
        }
        await runtimeConfig.update(patch, { expectedRevision });
        return json(res, 200, await providerConfigurationResponse(runtimeConfig, context.index));
      }

      if (pathname === '/api/admin/runtime-config' && req.method === 'GET') {
        requireAdministrator(user);
        if (!runtimeConfig) runtimeConfigurationUnavailable();
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        return json(res, 200, await runtimeConfigurationResponse(runtimeConfig, context.index));
      }
      if (pathname === '/api/admin/runtime-config' && req.method === 'PUT') {
        requireAdministrator(user);
        if (!runtimeConfig) runtimeConfigurationUnavailable();
        const body = await readJson(req, 64 * 1024);
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url, body));
        reauthenticateAdministrator(sessions, user, body, req, config);
        const { adminPassword: _password, knowledgeBaseId: _knowledgeBaseId, ...patch } = body;
        if (Object.hasOwn(patch, 'embedding') && context.index.status?.().pending) {
          throw httpError(
            409,
            'Embedding configuration cannot change while an index rebuild is running.',
            'INDEX_REBUILD_IN_PROGRESS',
          );
        }
        await runtimeConfig.update(patch, {
          expectedRevision: patch.expectedRevision,
          beforeCommit: (candidate) => validateManagedRuntimeCandidate(candidate, {
            llmRouter,
            webSearch,
            responsesExtractor,
          }),
        });
        return json(res, 200, await runtimeConfigurationResponse(runtimeConfig, context.index));
      }
      if (pathname === '/api/admin/embedding-rebuild' && req.method === 'POST') {
        requireAdministrator(user);
        if (!runtimeConfig) runtimeConfigurationUnavailable();
        const body = await readJson(req, 64 * 1024);
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url, body));
        const selectedIndex = context.index;
        const selectedEmbeddingRuntime = context.embeddingRuntime;
        if (!selectedEmbeddingRuntime) runtimeConfigurationUnavailable();
        reauthenticateAdministrator(sessions, user, body, req, config);
        if (body.action === 'cancel') {
          const allowed = new Set(['action', 'adminPassword', 'rebuildId', 'knowledgeBaseId']);
          if (Object.keys(body).some((name) => !allowed.has(name))) {
            throw httpError(
              400,
              'Embedding cancellation contains an unsupported option.',
              'UNSUPPORTED_REBUILD_OPTION',
            );
          }
          const rebuildId = requireEmbeddingRebuildId(body.rebuildId);
          const runtimeStatus = selectedEmbeddingRuntime.publicStatus?.() || selectedIndex.status?.() || {};
          const pending = runtimeStatus.pending;
          if (!pending || pending.id !== rebuildId) {
            throw httpError(
              404,
              'Embedding rebuild was not found.',
              'INDEX_REBUILD_NOT_FOUND',
            );
          }
          if (['commit_barrier', 'switching'].includes(String(pending.phase || ''))) {
            throw httpError(
              409,
              'Embedding rebuild can no longer be cancelled safely.',
              'INDEX_REBUILD_NOT_CANCELLABLE',
            );
          }
          if (selectedEmbeddingRuntime.cancel(rebuildId) !== true) {
            throw httpError(
              409,
              'Embedding rebuild can no longer be cancelled safely.',
              'INDEX_REBUILD_NOT_CANCELLABLE',
            );
          }
          return json(res, 202, {
            ok: true,
            cancellation: { id: rebuildId, status: 'cancelling' },
            ...(await runtimeConfigurationResponse(runtimeConfig, selectedIndex)),
          });
        }
        if (body.action !== 'validate-and-build') {
          throw httpError(400, 'Embedding rebuild action is invalid.', 'INVALID_REBUILD_ACTION');
        }
        if (selectedIndex.status?.().pending) {
          throw httpError(
            409,
            'Another embedding index rebuild is already running.',
            'INDEX_REBUILD_IN_PROGRESS',
          );
        }
        const expectedRevision = String(body.expectedRevision || '');
        const shouldDetectDimensions = Boolean(body.embedding) &&
          body.embedding?.provider !== 'disabled' &&
          !Object.hasOwn(body.embedding || {}, 'dimensions');
        const updated = await runtimeConfig.update({
          expectedRevision,
          embedding: body.embedding,
        }, {
          expectedRevision,
          beforeCommit: shouldDetectDimensions
            ? async (candidate) => ({
                embeddingDimensions: await selectedEmbeddingRuntime.detectDimensions(candidate.embedding),
              })
            : undefined,
        });
        let rebuild;
        try {
          rebuild = await selectedEmbeddingRuntime.startRebuild(updated.revision);
        } catch (error) {
          // The desired private configuration is durable, but the active
          // index remains untouched. Tell the client to reload that state.
          error.configurationSaved = true;
          throw error;
        }
        const response = await runtimeConfigurationResponse(runtimeConfig, selectedIndex);
        return json(res, 202, { ...response, rebuild });
      }

      if (pathname === '/api/knowledge/bases' && req.method === 'GET') {
        return json(res, 200, publicKnowledgeBases());
      }

      if (pathname.startsWith('/api/knowledge/') && !initialization.ready) {
        if (initialization.error) {
          throw httpError(503, 'Knowledge service initialization failed. Check server logs.', 'INITIALIZATION_FAILED');
        }
        throw httpError(503, 'Knowledge service is still initializing.', 'INITIALIZATION_PENDING');
      }

      if (pathname === '/api/knowledge/status' && req.method === 'GET') {
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        return json(res, 200, {
          ...withContextIdentity(await context.manager.publicStatus(userId), context),
          knowledgeBases: publicKnowledgeBases().knowledgeBases,
        });
      }
      if (pathname === '/api/knowledge/search' && req.method === 'GET') {
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        const mode = url.searchParams.get('mode') || 'keyword';
        if (!['keyword', 'semantic', 'hybrid'].includes(mode)) {
          throw httpError(400, 'Search mode is invalid.', 'INVALID_SEARCH_MODE');
        }
        const result = await context.index.search(url.searchParams.get('q') || '', {
          route: mode,
          limit: url.searchParams.get('limit') || 30,
        });
        if (mode === 'semantic' && result.route !== 'semantic') {
          throw httpError(503, 'Semantic search is unavailable. Configure and build an embedding index.', 'SEMANTIC_SEARCH_UNAVAILABLE');
        }
        return json(res, 200, {
          ...result,
          ...contextIdentity(context),
          results: result.results.map(({ content, vector, tokens, ...item }) => item),
        });
      }
      if (pathname === '/api/knowledge/file' && ['GET', 'HEAD'].includes(req.method)) {
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        const file = await context.store.existingFile(url.searchParams.get('path') || '');
        const headers = {
          ...securityHeaders(),
          'Content-Type': file.mime || mimeTypeFor(file.relative),
          'Content-Length': file.stat.size,
          'Cache-Control': 'no-store',
          'Content-Disposition': file.mime === 'application/octet-stream' ? 'attachment' : 'inline',
        };
        if (req.method === 'HEAD') {
          res.writeHead(200, headers);
          return res.end();
        }
        return streamFileResponse(res, file.target, headers, createReadStream);
      }
      if (pathname === '/api/knowledge/conversations' && req.method === 'GET') {
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        return json(res, 200, {
          ...contextIdentity(context),
          conversations: context.manager.listConversations(userId).map((item) => (
            withContextIdentity(item, context)
          )),
        });
      }
      if (pathname === '/api/knowledge/conversations' && req.method === 'DELETE') {
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        return json(res, 200, withContextIdentity(
          await context.manager.clearConversations(userId, url.searchParams.get('kind')),
          context,
        ));
      }
      const conversationMatch = /^\/api\/knowledge\/conversations\/([^/]+)$/.exec(pathname);
      if (conversationMatch && req.method === 'GET') {
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        return json(res, 200, withContextIdentity(
          context.manager.getConversation(userId, decodeURIComponent(conversationMatch[1])),
          context,
        ));
      }
      if (conversationMatch && req.method === 'DELETE') {
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        return json(res, 200, withContextIdentity(
          await context.manager.deleteConversation(userId, decodeURIComponent(conversationMatch[1])),
          context,
        ));
      }
      if (pathname === '/api/knowledge/tasks' && req.method === 'POST') {
        const body = await readJson(req, config.limits.jsonBodyBytes);
        const requestedKnowledgeBaseId = requestKnowledgeBaseId(url, body);
        const { knowledgeBaseId: _knowledgeBaseId, ...taskBody } = body;
        let context;
        let result;
        if (knowledgeBaseHub) {
          ({ context, result } = await knowledgeBaseHub.createTask(
            requestedKnowledgeBaseId,
            userId,
            taskBody,
          ));
        } else {
          context = resolveKnowledgeContext(requestedKnowledgeBaseId);
          result = await context.manager.createTask(userId, taskBody);
        }
        return json(res, 201, withContextIdentity(result, context));
      }
      const taskMatch = /^\/api\/knowledge\/tasks\/([^/]+)(?:\/(events|cancel))?$/.exec(pathname);
      if (taskMatch) {
        const [, taskId, action] = taskMatch;
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url));
        if (!action && req.method === 'GET') {
          return json(res, 200, withContextIdentity(
            context.manager.publicTask(context.manager.getTask(userId, taskId)),
            context,
          ));
        }
        if (action === 'events' && req.method === 'GET') {
          return context.manager.subscribe(userId, taskId, req, res);
        }
        if (action === 'cancel' && req.method === 'POST') {
          return json(res, 200, withContextIdentity(context.manager.cancel(userId, taskId), context));
        }
      }
      const draftMatch = /^\/api\/knowledge\/drafts\/([^/]+)(?:\/(save))?$/.exec(pathname);
      if (draftMatch) {
        const [, draftId, action] = draftMatch;
        let body = null;
        if (action === 'save' && req.method === 'POST') body = await readJson(req, MAX_SAFE_DRAFT_BODY);
        const context = resolveKnowledgeContext(requestKnowledgeBaseId(url, body));
        if (!action && req.method === 'GET') {
          return json(res, 200, withContextIdentity(await context.store.getDraft(userId, draftId), context));
        }
        if (!action && req.method === 'DELETE') {
          return json(res, 200, withContextIdentity(await context.store.deleteDraft(userId, draftId), context));
        }
        if (action === 'save' && req.method === 'POST') {
          const { knowledgeBaseId: _knowledgeBaseId, ...draftChanges } = body;
          return json(res, 200, withContextIdentity(
            await context.store.saveDraft(userId, draftId, draftChanges),
            context,
          ));
        }
      }
      if (pathname === '/api/knowledge/transcribe' && req.method === 'POST') {
        const body = await readJson(req, config.limits.jsonBodyBytes);
        resolveKnowledgeContext(requestKnowledgeBaseId(url, body));
        throw httpError(503, 'Server-side speech transcription is not enabled in this release.', 'TRANSCRIPTION_UNAVAILABLE');
      }
      if (pathname.startsWith('/api/')) throw httpError(404, 'API route not found.', 'NOT_FOUND');
      if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      return await serveStatic(req, res, config.publicDir, pathname, createReadStream);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const candidateStatus = Number(error?.status);
      const status = Number.isSafeInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
        ? candidateStatus
        : 500;
      const failure = publicError(error, {
        fallbackCode: 'SERVER_ERROR',
        fallbackMessage: 'The server could not complete this request.',
      });
      if (status >= 500) console.error('[second-mind]', failure.code);
      return json(res, status, {
        error: failure.code,
        message: failure.message,
        ...(error.configurationSaved === true ? { configurationSaved: true } : {}),
      });
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  return {
    server,
    config,
    manager,
    index,
    store,
    conversations,
    webReader,
    responsesExtractor,
    runtimeConfig,
    embeddingRuntime,
    providerValidationCredentials,
    providerValidationStages,
    knowledgeBaseRegistry,
    knowledgeBaseHub,
    ready,
    initialization,
  };
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
      if (app.knowledgeBaseHub) await app.knowledgeBaseHub.close();
      else await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    };
    process.once('SIGINT', () => close().finally(() => process.exit(0)));
    process.once('SIGTERM', () => close().finally(() => process.exit(0)));
  }).catch((error) => {
    const failure = publicError(error, {
      fallbackCode: 'STARTUP_FAILED',
      fallbackMessage: 'Second Mind could not start. Check the configuration and filesystem permissions.',
    });
    console.error('[second-mind]', failure.code, failure.message);
    process.exitCode = 1;
  });
}

export const serverInternals = {
  readJson,
  serveStatic,
  streamFileResponse,
  securityHeaders,
  assertStateOutsideVault,
  resolvedIndexIsUsable,
  requireEmbeddingRebuildId,
  safeModelValidationResults,
};
