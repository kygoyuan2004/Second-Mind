import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function absolute(name, fallback) {
  const value = text(name, fallback);
  return path.resolve(PROJECT_ROOT, value);
}

function secret(name, fallback = '') {
  const direct = process.env[name];
  if (direct !== undefined && String(direct).length) return String(direct).trim();
  const filename = text(`${name}_FILE`);
  if (!filename) return fallback;
  const stat = fs.statSync(filename);
  if (!stat.isFile()) throw new Error(`${name}_FILE must point to a regular file.`);
  if ((stat.mode & 0o022) !== 0) {
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
      maxOutputTokens: integer('LLM_MAX_OUTPUT_TOKENS', 3_000, { min: 128, max: 65_536 }),
      temperature: Number(text('LLM_TEMPERATURE', '0.2')),
      allowInsecureHttp: bool('ALLOW_INSECURE_PROVIDER_HTTP', false),
    },
    embedding: {
      provider: embeddingProvider,
      apiBase: endpoint(text('EMBEDDING_API_BASE'), text('LLM_API_BASE', 'http://127.0.0.1:11434/v1')),
      endpoint: text('EMBEDDING_ENDPOINT'),
      apiKey: secret('EMBEDDING_API_KEY', secret('LLM_API_KEY')),
      model: text('EMBEDDING_MODEL', 'nomic-embed-text'),
      dimensions: integer('EMBEDDING_DIMENSIONS', 768, { min: 8, max: 32_768 }),
      batchSize: integer('EMBEDDING_BATCH_SIZE', 16, { min: 1, max: 100 }),
      timeoutMs: integer('EMBEDDING_TIMEOUT_MS', 30_000, { min: 1_000, max: 300_000 }),
      allowInsecureHttp: bool('ALLOW_INSECURE_PROVIDER_HTTP', false),
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
    retrieval: { ...config.retrieval, ...(overrides.retrieval || {}) },
    deep: { ...config.deep, ...(overrides.deep || {}) },
    limits: { ...config.limits, ...(overrides.limits || {}) },
    sync: { ...config.sync, ...(overrides.sync || {}) },
    paths: { ...config.paths, ...(overrides.paths || {}) },
    templates: { ...config.templates, ...(overrides.templates || {}) },
  };
  if (!Number.isFinite(merged.llm.temperature) || merged.llm.temperature < 0 || merged.llm.temperature > 2) {
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
  if (!config.llm.model) issues.push('LLM_MODEL is required.');
  if (config.embedding.provider !== 'disabled' && !config.embedding.model) {
    issues.push('EMBEDDING_MODEL is required when embeddings are enabled.');
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
  return {
    appName: config.appName,
    vaultLabel: config.vaultLabel,
    timezone: config.timezone,
    sync: { provider: config.sync.provider, displayName: config.sync.displayName },
    llm: { provider: config.llm.provider, model: config.llm.model, configured: Boolean(config.llm.model) },
    embedding: {
      provider: config.embedding.provider,
      model: config.embedding.provider === 'disabled' ? null : config.embedding.model,
      enabled: config.embedding.provider !== 'disabled',
      dimensions: config.embedding.provider === 'disabled' ? null : config.embedding.dimensions,
    },
  };
}

export const configInternals = { loadDotEnv, secret, relativeVaultPath };
