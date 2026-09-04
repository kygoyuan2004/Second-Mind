import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fsp from 'node:fs/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { EmbeddingClient } from './embedding-client.mjs';
import { IndexRouter, IndexRouterError } from './index-router.mjs';
import { KnowledgeIndex } from './knowledge-index.mjs';
import { runtimeConfigInternals } from './runtime-config-registry.mjs';
import { isPublicAddress } from './safe-web-reader.mjs';

const ACTIVE_PROFILE_VERSION = 1;
const SAFE_SLOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_EMBEDDING_RESPONSE_BYTES = 64 * 1024 * 1024;

export class EmbeddingRuntimeError extends Error {
  constructor(message, code = 'EMBEDDING_RUNTIME_ERROR', status = 500, options = {}) {
    super(message, options);
    this.name = 'EmbeddingRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status = 500, options = {}) {
  throw new EmbeddingRuntimeError(message, code, status, options);
}

function sanitizedEmbedding(value = {}) {
  const provider = String(value.provider || 'disabled').trim().toLowerCase();
  return {
    provider,
    model: provider === 'disabled' ? null : String(value.model || '').trim() || null,
    dimensions: provider === 'disabled' ? null : Math.max(0, Number(value.dimensions) || 0) || null,
  };
}

function normalizePrivateEmbedding(value = {}) {
  const provider = String(value.provider || 'disabled').trim().toLowerCase();
  if (!['disabled', 'dashscope', 'openai-compatible'].includes(provider)) {
    fail('The active embedding provider is invalid.', 'ACTIVE_EMBEDDING_PROFILE_INVALID');
  }
  const profile = {
    provider,
    apiBase: String(value.apiBase || '').trim(),
    endpoint: '',
    apiKey: String(value.apiKey || ''),
    model: String(value.model || '').trim(),
    dimensions: Math.max(0, Number(value.dimensions) || 0),
    batchSize: Math.min(100, Math.max(1, Number(value.batchSize) || 16)),
    timeoutMs: Math.min(300_000, Math.max(1_000, Number(value.timeoutMs) || 30_000)),
    allowInsecureHttp: false,
  };
  if (provider !== 'disabled' && (
    !profile.apiBase || !profile.apiKey || !profile.model || profile.dimensions < 8
  )) {
    fail('The active embedding profile is incomplete.', 'ACTIVE_EMBEDDING_PROFILE_INVALID');
  }
  // Reuse the production client validation for URL shape and provider-specific
  // endpoint derivation without sending a request.
  new EmbeddingClient(profile);
  return profile;
}

function privateEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slotId = String(value.slotId || '').trim();
  const revision = String(value.revision || '').trim();
  if (!SAFE_SLOT.test(slotId) || !SAFE_SLOT.test(revision)) return null;
  return {
    slotId,
    revision,
    generation: String(value.generation || '').slice(0, 160),
    activatedAt: String(value.activatedAt || '').slice(0, 80),
    embedding: normalizePrivateEmbedding(value.embedding),
  };
}

async function readActiveManifest(filename) {
  const loaded = await runtimeConfigInternals.readPrivateJson(
    filename,
    'Active embedding profile',
    { optional: true },
  );
  if (!loaded) return { version: ACTIVE_PROFILE_VERSION, current: null, previous: null };
  const value = loaded.value;
  if (!value || value.version !== ACTIVE_PROFILE_VERSION) {
    fail('The active embedding profile has an unsupported version.', 'ACTIVE_EMBEDDING_PROFILE_INVALID');
  }
  const current = privateEntry(value.current);
  const previous = privateEntry(value.previous);
  if ((value.current && !current) || (value.previous && !previous)) {
    fail('The active embedding profile is invalid.', 'ACTIVE_EMBEDDING_PROFILE_INVALID');
  }
  if (
    current && previous &&
    (current.slotId === previous.slotId || current.revision === previous.revision)
  ) {
    fail('The active embedding profile contains duplicate generations.',
      'ACTIVE_EMBEDDING_PROFILE_INVALID');
  }
  return { version: ACTIVE_PROFILE_VERSION, current, previous };
}

function defaultRevision(embedding) {
  return `base-${crypto.createHash('sha256').update(JSON.stringify({
    provider: embedding.provider,
    apiBase: embedding.apiBase,
    model: embedding.model,
    dimensions: embedding.dimensions,
  })).digest('hex').slice(0, 32)}`;
}

function indexDirectory(baseIndexDir, slotsRoot, entry) {
  // The original deployment index is the durable `base` generation. It is
  // intentionally outside the managed slots root and may become `previous`
  // after the first successful rolling rebuild.
  if (!entry || entry.slotId === 'base') return path.resolve(baseIndexDir);
  const root = path.resolve(slotsRoot);
  const target = path.resolve(root, entry.slotId);
  if (path.dirname(target) !== root) {
    fail('The embedding index slot is invalid.', 'ACTIVE_EMBEDDING_PROFILE_INVALID');
  }
  return target;
}

function transportError(message, code, status = 400, cause) {
  return new EmbeddingRuntimeError(message, code, status, cause ? { cause } : {});
}

function normalizedDnsAnswers(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.map((entry) => {
    const address = String(entry?.address || '');
    return { address, family: isIP(address) };
  }).filter((entry) => entry.family > 0);
}

function signalReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The embedding request was cancelled.', 'AbortError');
}

function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signalReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signalReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function resolvePublicTarget(url, lookup, signal) {
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (!hostname || isIP(hostname)) {
    throw transportError(
      'The embedding provider must use a public DNS hostname.',
      'EMBEDDING_DESTINATION_DENIED',
    );
  }
  let answers;
  try {
    answers = normalizedDnsAnswers(await withAbort(
      lookup(hostname, { all: true, verbatim: true }),
      signal,
    ));
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw signalReason(signal);
    throw transportError(
      'The embedding provider hostname could not be resolved.',
      'EMBEDDING_DNS_FAILED',
      400,
      error,
    );
  }
  if (!answers.length || answers.some((entry) => !isPublicAddress(entry.address))) {
    throw transportError(
      'The embedding provider must resolve only to public network addresses.',
      'EMBEDDING_DESTINATION_DENIED',
    );
  }
  // Prefer IPv4 when both families are returned. This avoids an implicit
  // second DNS lookup or connection race while still pinning exactly one of
  // the addresses that was validated above.
  const selected = answers.find((entry) => entry.family === 4) || answers[0];
  return { hostname, selected };
}

function pinnedLookup(selected) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'object' && options ? options : {};
    if (settings.all === true) {
      done(null, [{ address: selected.address, family: selected.family }]);
    } else {
      done(null, selected.address, selected.family);
    }
  };
}

function responseHeaders(raw = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function boundedTransportHeaders(input, body) {
  const headers = new Headers(input || {});
  // The origin and framing headers are owned by this transport. In particular,
  // an injected Host value could otherwise separate TLS verification from the
  // HTTP authority receiving the credential.
  for (const name of ['host', 'connection', 'transfer-encoding', 'content-length']) {
    headers.delete(name);
  }
  headers.set('content-length', String(body.byteLength));
  return Object.fromEntries(headers.entries());
}

function pinnedRequest(requestFn, target, requestOptions, body, maxResponseBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const signal = requestOptions.signal;
    let request;
    let onAbort = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    try {
      request = requestFn(target, requestOptions, (response) => {
        const status = Number(response.statusCode || 0);
        response.once('error', (error) => finish(reject, transportError(
          'The embedding provider response failed.',
          'EMBEDDING_NETWORK_ERROR',
          502,
          error,
        )));
        if (status >= 300 && status < 400) {
          finish(reject, transportError(
            'The embedding provider attempted an HTTP redirect.',
            'EMBEDDING_REDIRECT_DENIED',
          ));
          response.resume?.();
          response.destroy?.();
          return;
        }
        const declared = Number(response.headers?.['content-length']);
        if (Number.isFinite(declared) && declared > maxResponseBytes) {
          finish(reject, transportError(
            'The embedding provider response exceeded the safety limit.',
            'EMBEDDING_RESPONSE_TOO_LARGE',
          ));
          response.resume?.();
          response.destroy?.();
          return;
        }
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.from(chunk);
          length += buffer.length;
          if (length > maxResponseBytes) {
            finish(reject, transportError(
              'The embedding provider response exceeded the safety limit.',
              'EMBEDDING_RESPONSE_TOO_LARGE',
            ));
            response.destroy?.();
            return;
          }
          chunks.push(buffer);
        });
        response.once('end', () => {
          if (settled) return;
          const safeStatus = status >= 200 && status <= 599 ? status : 502;
          const emptyStatus = [204, 205, 304].includes(safeStatus);
          finish(resolve, new Response(
            emptyStatus ? null : Buffer.concat(chunks, length),
            {
              status: safeStatus,
              statusText: String(response.statusMessage || '').slice(0, 100),
              headers: responseHeaders(response.headers),
            },
          ));
        });
      });
    } catch (error) {
      finish(reject, transportError(
        'The embedding provider request could not be created.',
        'EMBEDDING_NETWORK_ERROR',
        502,
        error,
      ));
      return;
    }
    request.once('error', (error) => finish(reject, transportError(
      'The embedding provider request failed.',
      error?.name === 'AbortError' ? 'EMBEDDING_ABORTED' : 'EMBEDDING_NETWORK_ERROR',
      502,
      error,
    )));
    onAbort = () => {
      const reason = signalReason(signal);
      finish(reject, reason);
      request.destroy(reason);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    request.end(body);
  });
}

/**
 * Build the fetch subset used by EmbeddingClient. Every request performs a new
 * all-address DNS resolution, rejects the whole answer set if any address is
 * non-public, disables connection pooling, and pins TLS/HTTP to one validated
 * address while retaining the original hostname for SNI and certificate checks.
 */
export function createPinnedEmbeddingFetch(options = {}) {
  const lookup = options.lookup || dns.lookup;
  const requestFn = options.request || https.request;
  const maxResponseBytes = Math.min(
    MAX_EMBEDDING_RESPONSE_BYTES,
    Math.max(1_024, Number(options.maxResponseBytes) || MAX_EMBEDDING_RESPONSE_BYTES),
  );
  return async (input, init = {}) => {
    let target;
    try {
      target = new URL(String(input));
    } catch {
      throw transportError('The embedding provider URL is invalid.', 'EMBEDDING_INVALID_ENDPOINT');
    }
    if (
      target.protocol !== 'https:' || target.username || target.password ||
      (target.port && target.port !== '443')
    ) {
      throw transportError(
        'The embedding provider must use credential-free HTTPS on port 443.',
        'EMBEDDING_INVALID_ENDPOINT',
      );
    }
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      throw transportError(
        'The embedding transport only permits POST requests.',
        'EMBEDDING_METHOD_DENIED',
      );
    }
    if (init.signal?.aborted) throw init.signal.reason || new DOMException('Aborted', 'AbortError');
    const { hostname, selected } = await resolvePublicTarget(target, lookup, init.signal);
    if (init.signal?.aborted) throw init.signal.reason || new DOMException('Aborted', 'AbortError');
    const body = Buffer.isBuffer(init.body)
      ? init.body
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : Buffer.from(String(init.body ?? ''), 'utf8');
    return pinnedRequest(requestFn, target, {
      method,
      headers: boundedTransportHeaders(init.headers, body),
      signal: init.signal,
      agent: false,
      family: selected.family,
      lookup: pinnedLookup(selected),
      servername: hostname,
      rejectUnauthorized: true,
    }, body, maxResponseBytes);
  };
}

export async function resolveActiveEmbedding(config, options = {}) {
  const manifest = options.activeProfileFile
    ? await readActiveManifest(path.resolve(options.activeProfileFile))
    : { version: ACTIVE_PROFILE_VERSION, current: null, previous: null };
  const selection = String(options.selection || 'current').trim().toLowerCase();
  if (!['current', 'previous'].includes(selection)) {
    fail('The active embedding profile selection is invalid.',
      'ACTIVE_EMBEDDING_PROFILE_SELECTION_INVALID', 400);
  }
  const selected = selection === 'previous' ? manifest.previous : manifest.current;
  if (selection === 'previous' && !selected) {
    fail('No previous embedding index generation is available.',
      'ACTIVE_EMBEDDING_PREVIOUS_UNAVAILABLE', 409);
  }
  const privateEmbedding = selected
    ? selected.embedding
    : normalizePrivateEmbedding(config.embedding || {});
  const embedding = {
    ...privateEmbedding,
    fetchFn: options.embeddingFetch || createPinnedEmbeddingFetch({
      lookup: options.lookup,
      request: options.request,
    }),
  };
  return {
    manifest,
    embedding,
    selection: selected ? selection : 'base',
    revision: selected?.revision || defaultRevision(privateEmbedding),
    slotId: selected?.slotId || 'base',
    generation: selected?.generation || '',
    indexDir: indexDirectory(
      config.indexDir,
      options.slotsRoot || `${config.indexDir}-slots`,
      selected,
    ),
  };
}

/**
 * Durably swaps a previously verified generation into the current position.
 * Call this only after the integration layer has opened the previous slot and
 * confirmed that its expected generation is available. Malformed manifests
 * are rejected by readActiveManifest and are never silently replaced.
 */
export async function promotePreviousEmbedding(options = {}) {
  if (!options.activeProfileFile) {
    fail('activeProfileFile is required.', 'ACTIVE_EMBEDDING_PROFILE_PATH_REQUIRED', 500);
  }
  const filename = path.resolve(options.activeProfileFile);
  const manifest = await readActiveManifest(filename);
  if (!manifest.current || !manifest.previous) {
    fail('No previous embedding index generation is available.',
      'ACTIVE_EMBEDDING_PREVIOUS_UNAVAILABLE', 409);
  }
  const expected = String(options.expectedCurrentRevision || '').trim();
  if (!expected) {
    fail('expectedCurrentRevision is required.',
      'ACTIVE_EMBEDDING_REVISION_REQUIRED', 400);
  }
  if (manifest.current.revision !== expected) {
    fail('The active embedding profile changed before fallback activation.',
      'ACTIVE_EMBEDDING_REVISION_CONFLICT', 409);
  }
  const next = {
    version: ACTIVE_PROFILE_VERSION,
    current: {
      ...manifest.previous,
      activatedAt: new Date().toISOString(),
    },
    previous: manifest.current,
  };
  await runtimeConfigInternals.atomicPrivateJson(filename, next);
  return {
    revision: next.current.revision,
    slotId: next.current.slotId,
    generation: next.current.generation,
    previousRevision: next.previous.revision,
  };
}

async function assertPublicDestination(embedding, lookup = dns.lookup, signal) {
  if (embedding.provider === 'disabled') return;
  const client = new EmbeddingClient(embedding);
  await resolvePublicTarget(new URL(client.endpoint), lookup, signal);
}

export class EmbeddingRuntime {
  constructor(options = {}) {
    this.registry = options.registry;
    this.baseConfig = options.baseConfig;
    this.activeProfileFile = path.resolve(options.activeProfileFile);
    this.slotsRoot = path.resolve(options.slotsRoot);
    this.lookup = options.lookup || dns.lookup;
    this.embeddingFetch = options.embeddingFetch || createPinnedEmbeddingFetch({
      lookup: this.lookup,
      request: options.httpsRequest,
    });
    this.embeddingClientFactory = options.embeddingClientFactory
      || ((config) => new EmbeddingClient(config, { fetchFn: this.embeddingFetch }));
    this.indexFactory = options.indexFactory || ((config, indexOptions) => (
      new KnowledgeIndex(config, indexOptions)
    ));
    this.manifest = options.activeState.manifest.current
      ? options.activeState.selection === 'previous'
        ? {
            version: ACTIVE_PROFILE_VERSION,
            current: options.activeState.manifest.previous,
            previous: options.activeState.manifest.current,
          }
        : options.activeState.manifest
      : {
          version: ACTIVE_PROFILE_VERSION,
          current: {
            slotId: options.activeState.slotId,
            revision: options.activeState.revision,
            generation: options.activeIndex.status?.().generation || '',
            activatedAt: new Date().toISOString(),
            embedding: normalizePrivateEmbedding(options.activeState.embedding),
          },
          previous: null,
        };
    this.profiles = new Map();
    this.garbageCollections = new Set();
    this.router = new IndexRouter({
      activeIndex: options.activeIndex,
      activeRevision: options.activeState.revision,
      activeSlotId: options.activeState.slotId,
      requireSemantic: false,
      createCandidate: (context) => this.createCandidate(context),
      validateCandidate: (candidate, context) => this.validateCandidate(candidate, context),
      commitActive: (pointer) => this.commitActive(pointer),
      discardCandidate: (context) => this.discardCandidate(context),
    });
  }

  get index() {
    return this.router;
  }

  publicStatus() {
    return this.router.status();
  }

  async detectDimensions(candidateEmbedding, options = {}) {
    const embedding = normalizePrivateEmbedding({
      ...this.baseConfig.embedding,
      ...candidateEmbedding,
      // A provisional value is needed only to construct the hardened client;
      // the probe request deliberately omits a requested dimension.
      dimensions: Math.max(8, Number(candidateEmbedding?.dimensions) || 8),
      endpoint: '',
      allowInsecureHttp: false,
    });
    if (embedding.provider === 'disabled') return null;
    await assertPublicDestination(embedding, this.lookup, options.signal);
    const client = this.embeddingClientFactory(embedding);
    if (typeof client.detectDimensions !== 'function') {
      fail(
        'The configured embedding client cannot detect vector dimensions.',
        'EMBEDDING_DIMENSION_DETECTION_UNAVAILABLE',
        503,
      );
    }
    const dimensions = Number(await client.detectDimensions({ signal: options.signal }));
    if (!Number.isSafeInteger(dimensions) || dimensions < 8 || dimensions > 32_768) {
      fail(
        'The embedding provider returned an unsupported vector dimension.',
        'EMBEDDING_DIMENSION_DETECTION_FAILED',
        400,
      );
    }
    return dimensions;
  }

  async startRebuild(expectedRevision) {
    const publicConfig = await this.registry.refresh();
    if (publicConfig.stale) {
      fail('Runtime configuration is stale; repair it before rebuilding.', 'RUNTIME_CONFIG_STALE', 409);
    }
    if (!expectedRevision) {
      fail('expectedRevision is required.', 'RUNTIME_CONFIG_REVISION_REQUIRED', 400);
    }
    if (String(expectedRevision) !== publicConfig.revision) {
      fail('Runtime configuration changed; reload before rebuilding.', 'RUNTIME_CONFIG_REVISION_CONFLICT', 409);
    }
    const desired = this.registry.runtimeSnapshot().embedding;
    const embedding = normalizePrivateEmbedding({
      ...this.baseConfig.embedding,
      ...desired,
      endpoint: '',
      allowInsecureHttp: false,
    });
    if (embedding.provider !== 'disabled') await assertPublicDestination(embedding, this.lookup);
    const revision = crypto.randomUUID();
    this.profiles.set(revision, {
      embedding,
      configurationRevision: String(expectedRevision),
    });
    try {
      return this.router.startRebuild({ embedding }, { revision });
    } catch (error) {
      this.profiles.delete(revision);
      throw error;
    }
  }

  async createCandidate({ config, revision, slotId, signal, reportProgress }) {
    const embedding = normalizePrivateEmbedding(config.embedding);
    const target = indexDirectory(this.baseConfig.indexDir, this.slotsRoot, { slotId });
    let candidate = null;
    try {
      const client = this.embeddingClientFactory(embedding);
      if (embedding.provider !== 'disabled') {
        reportProgress({ phase: 'validating', completed: 0, total: 1 });
        await client.embed(['Second Mind embedding configuration validation.'], { signal });
        reportProgress({ phase: 'validating', completed: 1, total: 1 });
      }
      let embedded = 0;
      const measuredClient = Object.create(client);
      measuredClient.embed = async (texts, options = {}) => {
        const vectors = await client.embed(texts, options);
        embedded += vectors.length;
        reportProgress({ phase: 'building', completed: embedded, total: 0 });
        return vectors;
      };
      await fsp.mkdir(target, { recursive: true, mode: 0o700 });
      const candidateConfig = {
        ...this.baseConfig,
        indexDir: target,
        embedding,
        retrieval: { ...this.baseConfig.retrieval, watch: this.baseConfig.retrieval?.watch !== false },
      };
      candidate = this.indexFactory(candidateConfig, {
        client: measuredClient,
        watch: candidateConfig.retrieval.watch,
        autoBuild: false,
      });
      await candidate.ready;
      await candidate.rebuild({ verifyHashes: true, signal });
      return candidate;
    } catch (error) {
      // A factory/preflight failure occurs before IndexRouter receives the
      // candidate, so the router cannot perform its normal candidate cleanup.
      // Clean both the private profile and independent slot here, preserving
      // the still-active index and the original failure code.
      this.profiles.delete(revision);
      await Promise.resolve(candidate?.close?.()).catch(() => {});
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async validateCandidate(candidate, context) {
    const pendingProfile = this.profiles.get(context.revision);
    if (!pendingProfile) {
      throw new IndexRouterError('Embedding profile was not found.', 'INDEX_PROFILE_NOT_FOUND');
    }
    const profile = pendingProfile.embedding;
    const status = candidate.status();
    if (profile.provider !== 'disabled' && status.chunks > 0) {
      if (!status.semanticAvailable || status.embeddedChunks !== status.chunks || status.lastError) {
        throw new IndexRouterError(
          'Candidate index does not contain a complete semantic generation.',
          'INDEX_CANDIDATE_EMBEDDING_INCOMPLETE',
        );
      }
    }
  }

  async commitActive(pointer) {
    const pendingProfile = this.profiles.get(pointer.revision);
    if (!pendingProfile) {
      throw new IndexRouterError('Embedding profile was not found.', 'INDEX_PROFILE_NOT_FOUND');
    }
    const refreshed = await this.registry.refresh();
    if (refreshed?.stale) {
      throw new IndexRouterError(
        'Runtime configuration became stale before index activation.',
        'RUNTIME_CONFIG_STALE',
        409,
      );
    }
    const embedding = pendingProfile.embedding;
    const desired = normalizePrivateEmbedding({
      ...this.baseConfig.embedding,
      ...this.registry.runtimeSnapshot().embedding,
      endpoint: '',
      allowInsecureHttp: false,
    });
    if (JSON.stringify(desired) !== JSON.stringify(embedding)) {
      throw new IndexRouterError(
        'Embedding configuration changed before index activation.',
        'INDEX_EMBEDDING_CONFIG_CHANGED',
        409,
      );
    }
    const current = {
      slotId: pointer.slotId,
      revision: pointer.revision,
      generation: pointer.generation,
      activatedAt: pointer.activatedAt,
      embedding,
    };
    const previous = this.manifest.current || this.manifest.previous || null;
    const superseded = this.manifest.previous || null;
    const next = { version: ACTIVE_PROFILE_VERSION, current, previous };
    await runtimeConfigInternals.atomicPrivateJson(this.activeProfileFile, next);
    this.manifest = next;
    this.profiles.delete(pointer.revision);
    this.scheduleSupersededDiscard(superseded, next);
  }

  scheduleSupersededDiscard(entry, manifest) {
    if (!entry || entry.slotId === 'base') return;
    // A task may still hold this two-generations-old slot through an
    // IndexRouter snapshot. Wait for retired references to drain rather than
    // deleting files underneath an in-flight search. This work is deliberately
    // detached from the durable commit path.
    const operation = Promise.resolve()
      .then(() => this.router.waitForIdle())
      .then(() => this.discardSuperseded(entry, manifest))
      .catch(() => {})
      .finally(() => this.garbageCollections.delete(operation));
    this.garbageCollections.add(operation);
  }

  async waitForMaintenance() {
    await Promise.all([...this.garbageCollections]);
  }

  async discardSuperseded(entry, manifest) {
    if (!entry || entry.slotId === 'base') return;
    const keep = new Set([
      'base',
      manifest.current?.slotId,
      manifest.previous?.slotId,
    ].filter(Boolean));
    if (keep.has(entry.slotId)) return;
    const target = indexDirectory(this.baseConfig.indexDir, this.slotsRoot, entry);
    try {
      const stat = await fsp.lstat(target);
      // Never traverse or remove an unexpected filesystem object. Candidate
      // slots are created as direct, private directories by this runtime.
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      await fsp.rm(target, { recursive: true, force: true });
    } catch {
      // Manifest activation is already durable. Garbage collection must not
      // turn a successful commit into a split-brain failure.
    }
  }

  async discardCandidate({ slotId, revision }) {
    this.profiles.delete(revision);
    const target = indexDirectory(this.baseConfig.indexDir, this.slotsRoot, { slotId });
    if (path.dirname(target) !== this.slotsRoot) return;
    await fsp.rm(target, { recursive: true, force: true });
  }

  cancel(id) {
    return this.router.cancelRebuild(id);
  }
}

export const embeddingRuntimeInternals = {
  readActiveManifest,
  normalizePrivateEmbedding,
  assertPublicDestination,
  resolvePublicTarget,
  pinnedLookup,
  indexDirectory,
};
