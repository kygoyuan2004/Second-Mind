import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { domainToASCII, fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadDotEnv(file = path.join(PROJECT_ROOT, '.env')) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in process.env) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(process.env.VAULTMIND_ENV_FILE || undefined);

function text(name, fallback = '') {
  const value = process.env[name];
  return value === undefined ? fallback : String(value).trim();
}

function bool(name, fallback = false) {
  const value = text(name);
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false.`);
}

function integer(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = text(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function optionalNumber(name, fallback) {
  const raw = text(name);
  if (!raw) return fallback;
  if (['default', 'provider-default'].includes(raw.toLowerCase())) return null;
  return Number(raw);
}

function oneOf(name, allowed, fallback) {
  const value = text(name, fallback).toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function list(name, fallback = []) {
  const value = text(name);
  return value
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : [...fallback];
}

function normalizeOfficialDomains(value, name = 'WEB_SEARCH_OFFICIAL_DOMAINS') {
  const inputs = Array.isArray(value) ? value : String(value || '').split(',');
  if (inputs.length > 100) throw new Error(`${name} must contain at most 100 domains.`);
  const domains = [];
  const publicSuffixes = new Set([
    'ac.cn', 'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn',
    'ac.uk', 'co.uk', 'gov.uk', 'org.uk',
    'com.au', 'net.au', 'org.au', 'co.jp', 'co.kr',
  ]);
  for (const input of inputs) {
    const raw = String(input || '').trim().replace(/\.$/u, '');
    if (!raw) continue;
    if (
      raw.includes('://') || /[\s/@:*\\\[\]]/u.test(raw) ||
      raw.length > 253
    ) {
      throw new Error(`${name} must contain comma-separated hostnames without schemes, paths, ports, or wildcards.`);
    }
    const domain = domainToASCII(raw).toLocaleLowerCase();
    const labels = domain.split('.');
    if (
      !domain || isIP(domain) || labels.length < 2 || publicSuffixes.has(domain) ||
      labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)) ||
      ['example', 'invalid', 'localhost', 'local', 'onion', 'test'].includes(labels.at(-1))
    ) {
      throw new Error(`${name} contains an invalid or non-public hostname.`);
    }
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains
    .filter((domain) => !domains.some((other) => other !== domain && domain.endsWith(`.${other}`)))
    .sort();
}

function absolute(name, fallback) {
  const value = text(name, fallback);
  return path.resolve(PROJECT_ROOT, value);
}

function decodeMountInfoPath(value) {
  return String(value).replace(/\\([0-7]{3})/gu, (_, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function isReadOnlyContainerSecretMount(filename, mountInfo) {
  const resolved = path.resolve(filename);
  if (path.posix.dirname(resolved) !== '/run/secrets'
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(path.posix.basename(resolved))) {
    return false;
  }
  let document = mountInfo;
  if (document === undefined) {
    try {
      document = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    } catch {
      return false;
    }
  }
  for (const line of String(document).split(/\r?\n/u)) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(' ');
    if (fields.length < 6) continue;
    const mountPoint = decodeMountInfoPath(fields[4]);
    const options = fields[5].split(',');
    if (mountPoint === resolved && options.includes('ro')) return true;
  }
  return false;
}

function secret(name, fallback = '') {
  const direct = process.env[name];
  if (direct !== undefined && String(direct).length) return String(direct).trim();
  const filename = text(`${name}_FILE`);
  if (!filename) return fallback;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile()) throw new Error(`${name}_FILE must point to a regular file.`);
  if ((stat.mode & 0o022) !== 0 && !isReadOnlyContainerSecretMount(filename)) {
    throw new Error(`${name}_FILE must not be writable by group or others.`);
  }
  return fs.readFileSync(filename, 'utf8').trim();
}

function relativeVaultPath(name, fallback) {
  const value = text(name, fallback).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!value || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${name} must be a relative path inside the vault.`);
  }
  return value;
}

function endpoint(value, fallback) {
  return String(value || fallback).replace(/\/+$/, '');
}

function bailianResponsesEndpoint(apiBase, exactEndpoint = '') {
  const exact = endpoint(exactEndpoint, '');
  if (exact) return exact;
  const base = endpoint(apiBase, '');
  if (!base) return '';
  return base.endsWith('/responses') ? base : `${base}/responses`;
}

function validBailianResponsesEndpoint(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value));
    const allowedHost = url.hostname === 'dashscope.aliyuncs.com' ||
      url.hostname.endsWith('.maas.aliyuncs.com');
    return url.protocol === 'https:' && allowedHost && !url.username && !url.password &&
      (!url.port || url.port === '443') && !url.search && !url.hash &&
      url.pathname.endsWith('/responses');
  } catch {
    return false;
  }
}

function validBailianApiKey(value) {
  const key = String(value || '').trim();
  return key.length >= 8 && key.length <= 16_384 &&
    !/[\s\u0000-\u001f\u007f]/u.test(key);
}

export function createConfig(overrides = {}) {
  const dataDir = absolute('DATA_DIR', './data');
  const llmProvider = oneOf('LLM_PROVIDER', ['openai-compatible', 'anthropic'], 'openai-compatible');
  const embeddingProvider = oneOf(
    'EMBEDDING_PROVIDER',
    ['disabled', 'openai-compatible', 'dashscope'],
    'disabled',
  );
  const syncProvider = oneOf(
    'SYNC_PROVIDER',
    ['filesystem', 'obsidian-headless', 'external'],
    'filesystem',
  );
  const config = {
    projectRoot: PROJECT_ROOT,
    appName: text('APP_NAME', 'Second Mind'),
    vaultLabel: text('VAULT_LABEL', 'My Obsidian Vault'),
    host: text('HOST', '127.0.0.1'),
    port: integer('PORT', 8787, { min: 1, max: 65_535 }),
    timezone: text('TIMEZONE', 'UTC'),
    trustProxy: bool('TRUST_PROXY', false),
    vaultPath: absolute('VAULT_PATH', './vault'),
    dataDir,
    publicDir: absolute('PUBLIC_DIR', './public'),
    indexDir: absolute('INDEX_DIR', path.join(dataDir, 'index')),
    draftDir: absolute('DRAFT_DIR', path.join(dataDir, 'drafts')),
    recoveryDir: absolute('RECOVERY_DIR', path.join(dataDir, 'recovery')),
    conversationFile: absolute('CONVERSATION_FILE', path.join(dataDir, 'conversations.json')),
    auditFile: absolute('AUDIT_FILE', path.join(dataDir, 'audit.jsonl')),
    autoCreateVaultPaths: bool('VAULT_AUTO_CREATE_PATHS', true),
    paths: {
      diary: relativeVaultPath('DIARY_DIR', 'Second-Mind/Diary'),
      plan: relativeVaultPath('PLAN_DIR', 'Second-Mind/Plans'),
      scratch: relativeVaultPath('SCRATCH_DIR', 'Second-Mind/Inbox'),
    },
    templates: {
      diary: text('DIARY_TEMPLATE', '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''),
      plan: text('PLAN_TEMPLATE', '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''),
    },
    excludedPaths: list('VAULT_EXCLUDED_PATHS', [
      '.obsidian', '.trash', '.git', '.sync', '.livesync', 'node_modules',
    ]),
    auth: {
      username: text('ADMIN_USERNAME', 'admin'),
      password: secret('ADMIN_PASSWORD'),
      sessionSecret: secret('SESSION_SECRET'),
      sessionTtlSeconds: integer('SESSION_TTL_SECONDS', 43_200, { min: 300, max: 2_592_000 }),
      secureCookie: bool('SECURE_COOKIE', false),
    },
    llm: {
      provider: llmProvider,
      apiBase: endpoint(
        text('LLM_API_BASE'),
        llmProvider === 'anthropic' ? 'https://api.anthropic.com' : 'http://127.0.0.1:11434/v1',
      ),
      apiKey: secret('LLM_API_KEY'),
      model: text('LLM_MODEL', llmProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'qwen3:8b'),
      timeoutMs: integer('LLM_TIMEOUT_MS', 120_000, { min: 1_000, max: 900_000 }),
      maxOutputTokens: integer('LLM_MAX_OUTPUT_TOKENS', 3_000, { min: 128, max: 131_072 }),
      temperature: optionalNumber('LLM_TEMPERATURE', 0.2),
      allowInsecureHttp: bool('ALLOW_INSECURE_PROVIDER_HTTP', false),
    },
    embedding: {
      provider: embeddingProvider,
      apiBase: endpoint(text('EMBEDDING_API_BASE'), text('LLM_API_BASE', 'http://127.0.0.1:11434/v1')),
      endpoint: text('EMBEDDING_ENDPOINT'),
      apiKey: secret('EMBEDDING_API_KEY'),
      model: text('EMBEDDING_MODEL', 'nomic-embed-text'),
      dimensions: integer('EMBEDDING_DIMENSIONS', 768, { min: 8, max: 32_768 }),
      batchSize: integer('EMBEDDING_BATCH_SIZE', 16, { min: 1, max: 100 }),
      timeoutMs: integer('EMBEDDING_TIMEOUT_MS', 30_000, { min: 1_000, max: 300_000 }),
      allowInsecureHttp: bool('ALLOW_INSECURE_PROVIDER_HTTP', false),
    },
    webSearch: {
      provider: 'bailian-mcp',
      enabled: bool('WEB_SEARCH_ENABLED', false),
      endpoint: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp',
      apiKey: secret('WEB_SEARCH_API_KEY'),
      timeoutMs: integer('WEB_SEARCH_TIMEOUT_MS', 60_000, { min: 1_000, max: 300_000 }),
      resultCount: integer('WEB_SEARCH_RESULT_COUNT', 15, { min: 1, max: 20 }),
      deepResultCount: integer('WEB_SEARCH_DEEP_RESULT_COUNT', 6, { min: 1, max: 20 }),
      maxResultsPerDomain: integer('WEB_SEARCH_MAX_RESULTS_PER_DOMAIN', 2, { min: 1, max: 10 }),
      modelSourceLimit: integer('WEB_SEARCH_MODEL_SOURCE_LIMIT', 10, { min: 1, max: 10 }),
      maxContextChars: integer('WEB_SEARCH_MAX_CONTEXT_CHARS', 30_000, { min: 2_000, max: 100_000 }),
      officialDomains: normalizeOfficialDomains(text('WEB_SEARCH_OFFICIAL_DOMAINS')),
    },
    research: {
      contextualizerEnabled: bool('QA_CONTEXTUALIZER_ENABLED', false),
      loopEnabled: bool('QA_RESEARCH_LOOP_ENABLED', false),
      contextualizerTimeoutMs: integer('QA_CONTEXTUALIZER_TIMEOUT_MS', 45_000, {
        min: 5_000,
        max: 120_000,
      }),
      evidenceTimeoutMs: integer('QA_EVIDENCE_TIMEOUT_MS', 60_000, {
        min: 5_000,
        max: 180_000,
      }),
    },
    webReader: {
      provider: 'server-safe-reader',
      enabled: bool('WEB_READER_ENABLED', false),
      pdfEnabled: bool('PDF_ENABLED', false),
      pageTimeoutMs: integer('WEB_READER_PAGE_TIMEOUT_MS', 15_000, { min: 1_000, max: 15_000 }),
      batchTimeoutMs: integer('WEB_READER_BATCH_TIMEOUT_MS', 40_000, { min: 1_000, max: 40_000 }),
      htmlMaxBytes: integer('WEB_READER_HTML_MAX_BYTES', 2 * 1024 * 1024, {
        min: 1_024,
        max: 2 * 1024 * 1024,
      }),
      pdfMaxBytes: integer('WEB_READER_PDF_MAX_BYTES', 8 * 1024 * 1024, {
        min: 1_024,
        max: 8 * 1024 * 1024,
      }),
      pageMaxChars: integer('WEB_READER_PAGE_MAX_CHARS', 16_000, { min: 100, max: 16_000 }),
      totalMaxChars: integer('WEB_READER_TOTAL_MAX_CHARS', 40_000, { min: 100, max: 40_000 }),
      concurrency: integer('WEB_READER_CONCURRENCY', 2, { min: 1, max: 2 }),
      maxPagesPerBatch: integer('WEB_READER_MAX_PAGES_PER_BATCH', 3, { min: 1, max: 3 }),
      normalMaxPages: integer('WEB_READER_NORMAL_MAX_PAGES', 2, { min: 1, max: 2 }),
      deepMaxPagesPerRound: integer('WEB_READER_DEEP_MAX_PAGES_PER_ROUND', 3, {
        min: 1,
        max: 3,
      }),
      maxRedirects: integer('WEB_READER_MAX_REDIRECTS', 3, { min: 0, max: 3 }),
    },
    responsesFallback: {
      provider: 'bailian-responses',
      enabled: bool('BAILIAN_RESPONSES_FALLBACK_ENABLED', false),
      apiBase: endpoint(text('BAILIAN_RESPONSES_FALLBACK_API_BASE'), ''),
      // The exact endpoint is retained only for compatibility with early 8788 deployments.
      endpoint: text('BAILIAN_RESPONSES_FALLBACK_ENDPOINT'),
      apiKey: secret('BAILIAN_RESPONSES_FALLBACK_API_KEY'),
      model: text('BAILIAN_RESPONSES_FALLBACK_MODEL', 'qwen3.8-max'),
      timeoutMs: integer('BAILIAN_RESPONSES_FALLBACK_TIMEOUT_MS', 120_000, {
        min: 1_000,
        max: 300_000,
      }),
      maxResponseBytes: integer(
        'BAILIAN_RESPONSES_FALLBACK_MAX_RESPONSE_BYTES',
        2 * 1024 * 1024,
        { min: 1_024, max: 2 * 1024 * 1024 },
      ),
    },
    retrieval: {
      topK: integer('RAG_TOP_K', 8, { min: 1, max: 30 }),
      maxContextChars: integer('RAG_MAX_CONTEXT_CHARS', 30_000, { min: 2_000, max: 200_000 }),
      watch: bool('INDEX_WATCH', true),
      reconcileIntervalMs: integer('INDEX_RECONCILE_SECONDS', 300, { min: 10, max: 86_400 }) * 1_000,
    },
    deep: {
      enabled: bool('DEEP_TASKS_ENABLED', true),
      topK: integer('RAG_DEEP_TOP_K', 16, { min: 1, max: 30 }),
    },
    limits: {
      jsonBodyBytes: integer('MAX_JSON_BODY_BYTES', 24 * 1024 * 1024, { min: 65_536 }),
      attachmentCount: integer('MAX_ATTACHMENT_COUNT', 8, { min: 0, max: 32 }),
      attachmentBytes: integer('MAX_ATTACHMENT_BYTES', 5 * 1024 * 1024, { min: 1_024 }),
      attachmentTotalBytes: integer('MAX_ATTACHMENT_TOTAL_BYTES', 15 * 1024 * 1024, { min: 1_024 }),
      recoveryRetentionDays: integer('RECOVERY_RETENTION_DAYS', 30, { min: 1, max: 3_650 }),
    },
    sync: {
      provider: syncProvider,
      displayName: text(
        'SYNC_DISPLAY_NAME',
        syncProvider === 'obsidian-headless' ? 'Obsidian Headless Sync' : 'Filesystem',
      ),
    },
  };

  const merged = {
    ...config,
    ...overrides,
    auth: { ...config.auth, ...(overrides.auth || {}) },
    llm: { ...config.llm, ...(overrides.llm || {}) },
    embedding: { ...config.embedding, ...(overrides.embedding || {}) },
    webSearch: { ...config.webSearch, ...(overrides.webSearch || {}) },
    research: { ...config.research, ...(overrides.research || {}) },
    webReader: { ...config.webReader, ...(overrides.webReader || {}) },
    responsesFallback: { ...config.responsesFallback, ...(overrides.responsesFallback || {}) },
    retrieval: { ...config.retrieval, ...(overrides.retrieval || {}) },
    deep: { ...config.deep, ...(overrides.deep || {}) },
    limits: { ...config.limits, ...(overrides.limits || {}) },
    sync: { ...config.sync, ...(overrides.sync || {}) },
    paths: { ...config.paths, ...(overrides.paths || {}) },
    templates: { ...config.templates, ...(overrides.templates || {}) },
  };
  merged.responsesFallback.endpoint = bailianResponsesEndpoint(
    merged.responsesFallback.apiBase,
    merged.responsesFallback.endpoint,
  );
  merged.webSearch.officialDomains = normalizeOfficialDomains(
    merged.webSearch.officialDomains,
  );
  if (merged.llm.temperature !== null && (
    !Number.isFinite(merged.llm.temperature) || merged.llm.temperature < 0 || merged.llm.temperature > 2
  )) {
    throw new Error('LLM_TEMPERATURE must be a number between 0 and 2.');
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: merged.timezone }).format(new Date());
  } catch {
    throw new Error('TIMEZONE must be a valid IANA time zone.');
  }
  return merged;
}

export function validateRuntimeConfig(config) {
  const issues = [];
  if (!config.auth.password || config.auth.password.length < 12) {
    issues.push('ADMIN_PASSWORD (or ADMIN_PASSWORD_FILE) must contain at least 12 characters.');
  }
  if (!config.auth.sessionSecret || config.auth.sessionSecret.length < 32) {
    issues.push('SESSION_SECRET (or SESSION_SECRET_FILE) must contain at least 32 characters.');
  }
  if (!config.llm.model && config.runtimeManagedProviders !== true) {
    issues.push('LLM_MODEL is required.');
  }
  if (config.embedding.provider !== 'disabled' && !config.embedding.model) {
    issues.push('EMBEDDING_MODEL is required when embeddings are enabled.');
  }
  if (config.webSearch?.enabled && !config.webSearch.apiKey && config.runtimeManagedProviders !== true) {
    issues.push('WEB_SEARCH_API_KEY is required when Web Search is enabled.');
  }
  if (config.research?.loopEnabled && !config.research?.contextualizerEnabled) {
    issues.push('QA_RESEARCH_LOOP_ENABLED requires QA_CONTEXTUALIZER_ENABLED.');
  }
  if (config.research?.loopEnabled && config.deep?.enabled === false) {
    issues.push('QA_RESEARCH_LOOP_ENABLED requires DEEP_TASKS_ENABLED.');
  }
  if (config.webReader?.enabled && !config.webSearch?.enabled) {
    issues.push('WEB_READER_ENABLED requires WEB_SEARCH_ENABLED.');
  }
  if (config.webReader?.pdfEnabled && !config.webReader?.enabled) {
    issues.push('PDF_ENABLED requires WEB_READER_ENABLED.');
  }
  if (config.responsesFallback?.enabled) {
    if (!config.webSearch?.enabled) {
      issues.push('BAILIAN_RESPONSES_FALLBACK_ENABLED requires WEB_SEARCH_ENABLED.');
    }
    if (!config.webReader?.enabled) {
      issues.push('BAILIAN_RESPONSES_FALLBACK_ENABLED requires WEB_READER_ENABLED.');
    }
    if (!config.responsesFallback.apiKey && config.runtimeManagedProviders !== true) {
      issues.push(
        'BAILIAN_RESPONSES_FALLBACK_API_KEY is required when the Responses fallback is enabled.',
      );
    }
    if (config.responsesFallback.apiKey && !validBailianApiKey(config.responsesFallback.apiKey)) {
      issues.push(
        'BAILIAN_RESPONSES_FALLBACK_API_KEY must be an opaque 8-16384 character credential without whitespace.',
      );
    }
    if (!validBailianResponsesEndpoint(config.responsesFallback.endpoint)) {
      issues.push(
        'BAILIAN_RESPONSES_FALLBACK_API_BASE (or legacy ENDPOINT) must resolve to an approved HTTPS Responses endpoint.',
      );
    }
    if (config.responsesFallback.model !== 'qwen3.8-max') {
      issues.push('BAILIAN_RESPONSES_FALLBACK_MODEL is pinned to qwen3.8-max.');
    }
  }
  if (config.deep?.topK !== undefined && (
    !Number.isSafeInteger(Number(config.deep.topK)) || Number(config.deep.topK) < 1 || Number(config.deep.topK) > 30
  )) {
    issues.push('RAG_DEEP_TOP_K must be an integer between 1 and 30.');
  }
  if (issues.length) {
    const error = new Error(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    error.code = 'INVALID_CONFIGURATION';
    throw error;
  }
  return config;
}

export function publicConfig(config) {
  const llmConfigured = Boolean(config.llm?.apiBase && config.llm?.model);
  return {
    appName: config.appName,
    vaultLabel: config.vaultLabel,
    timezone: config.timezone,
    sync: { provider: config.sync.provider, displayName: config.sync.displayName },
    llm: {
      provider: config.llm.provider,
      model: config.llm.model || null,
      configured: llmConfigured,
    },
    embedding: {
      provider: config.embedding.provider,
      model: config.embedding.provider === 'disabled' ? null : config.embedding.model,
      enabled: config.embedding.provider !== 'disabled',
      configured: config.embedding.provider !== 'disabled' && Boolean(
        config.embedding.apiBase && config.embedding.model,
      ),
      dimensions: config.embedding.provider === 'disabled' ? null : config.embedding.dimensions,
    },
    webSearch: {
      enabled: config.webSearch?.enabled === true,
      configured: config.webSearch?.enabled === true && Boolean(config.webSearch?.apiKey),
      provider: config.webSearch?.provider || 'bailian-mcp',
      fallbackConfigured: config.webSearch?.enabled === true &&
        config.webReader?.enabled === true &&
        config.responsesFallback?.enabled === true &&
        config.responsesFallback?.model === 'qwen3.8-max' &&
        validBailianApiKey(config.responsesFallback?.apiKey) &&
        validBailianResponsesEndpoint(config.responsesFallback?.endpoint),
    },
  };
}

export const configInternals = {
  loadDotEnv,
  secret,
  relativeVaultPath,
  bailianResponsesEndpoint,
  validBailianResponsesEndpoint,
  validBailianApiKey,
  normalizeOfficialDomains,
  isReadOnlyContainerSecretMount,
};
