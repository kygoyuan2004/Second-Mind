import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const BENCHMARK_SCHEMA_VERSION = 1;
export const PLAN_CATEGORY_COUNTS = Object.freeze({
  exact_fact: 8,
  paraphrase: 12,
  context_followup: 8,
  cross_document: 8,
  deduplication: 4,
  temporal_conflict: 4,
  unanswerable: 4,
});
export const DEFAULT_K_VALUES = Object.freeze([1, 3, 5, 8, 12]);
export const DEFAULT_PRICING = Object.freeze({
  inputPerMillion: 12,
  outputPerMillion: 36,
  cacheReadPerMillion: 1.5,
  cacheCreationPerMillion: 15,
});
export const DEFAULT_BUDGET = Object.freeze({ hardLimitCny: 100, startLimitCny: 90 });
const ANONYMOUS_REPORT_CAVEATS = Object.freeze([
  'Accuracy@k is auxiliary because true negatives dominate large document collections.',
  'Answer metrics require approved human or deterministic adjudication counts.',
  'Prices are estimates; the provider invoice is authoritative.',
]);
export const FAIR_MODEL_CONFIGURATION = Object.freeze({
  model: 'qwen3.8-max',
  temperature: 0,
  maxOutputTokens: 3_000,
  anthropic: Object.freeze({
    temperature: 0,
    max_tokens: 3_000,
    output_config: Object.freeze({ effort: 'medium' }),
  }),
  openaiChat: Object.freeze({
    temperature: 0,
    max_tokens: 3_000,
    reasoning_effort: 'medium',
  }),
  webSearch: false,
  freshSessionPerQuestion: true,
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALLOWED_SNAPSHOT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.canvas', '.base', '.csv', '.yaml', '.yml',
]);
const SECRET_PATTERNS = Object.freeze([
  { name: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'github-token', regex: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: 'openai-style-token', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'bearer-token', regex: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}\b/i },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'url-credentials', regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/i },
  {
    name: 'secret-assignment',
    regex: /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]/i,
  },
  {
    name: 'opaque-key-assignment',
    regex: /\b(?:key|credential|authorization|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/i,
  },
  {
    name: 'prefixed-secret-assignment',
    regex: /\b[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|secret|password|private[_-]?key)\s*[:=]\s*[^\s]{8,}/i,
  },
]);
const SNAPSHOT_EXCLUSION_PATTERNS = Object.freeze([
  ...SECRET_PATTERNS,
  { name: 'ipv4-address', regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
]);

export const SNAPSHOT_FILTER_POLICY = Object.freeze({
  id: 'vaultmind-readonly-text-v1',
  allowedExtensions: Object.freeze([...ALLOWED_SNAPSHOT_EXTENSIONS].sort()),
  maximumBytes: 2 * 1024 * 1024,
  hiddenComponentsExcluded: true,
  temporaryNamesExcluded: true,
  nulBytesExcluded: true,
  sensitivePatternNames: Object.freeze(SNAPSHOT_EXCLUSION_PATTERNS.map((entry) => entry.name)),
});

export class BenchmarkValidationError extends Error {
  constructor(message, code = 'BENCHMARK_VALIDATION_ERROR', details = []) {
    super(message);
    this.name = 'BenchmarkValidationError';
    this.code = code;
    this.details = [...details];
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function finiteNonnegative(value, label, errors) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    errors.push(`${label} must be a finite non-negative number.`);
    return 0;
  }
  return number;
}

function positiveInteger(value, label, errors, options = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (options.allowZero ? 0 : 1)) {
    errors.push(`${label} must be ${options.allowZero ? 'a non-negative' : 'a positive'} integer.`);
    return 0;
  }
  return number;
}

function safeRelativePath(value, label, errors) {
  const input = String(value || '').normalize('NFC');
  if (
    !input || input.includes('\0') || input.includes('\\') || path.isAbsolute(input) ||
    input.startsWith('/') || input.endsWith('/')
  ) {
    errors.push(`${label} must be a normalized relative path.`);
    return '';
  }
  const parts = input.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    errors.push(`${label} contains a hidden or unsafe path component.`);
    return '';
  }
  return parts.join('/');
}

function normalizeEvidence(value, label, errors, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return [];
  }
  return value.map((entry, index) => {
    const prefix = `${label}[${index}]`;
    const relative = options.path || safeRelativePath(entry?.path, `${prefix}.path`, errors);
    const startLine = positiveInteger(entry?.startLine, `${prefix}.startLine`, errors);
    const endLine = positiveInteger(entry?.endLine, `${prefix}.endLine`, errors);
    const textSha256 = String(entry?.textSha256 || '').toLowerCase();
    if (!SHA256_PATTERN.test(textSha256)) {
      errors.push(`${prefix}.textSha256 must be a lowercase SHA-256 digest.`);
    }
    if (startLine && endLine && endLine < startLine) {
      errors.push(`${prefix}.endLine must not be before startLine.`);
    }
    return { path: relative, startLine, endLine, textSha256 };
  });
}

function equalAliases(left, right) {
  if (left === undefined || right === undefined) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeFacts(item, prefix, errors) {
  if (!equalAliases(item.goldFacts, item.atomicFacts)) {
    errors.push(`${prefix}.goldFacts and atomicFacts disagree.`);
  }
  const value = item.goldFacts ?? item.atomicFacts;
  if (!Array.isArray(value)) {
    errors.push(`${prefix}.goldFacts must be an array.`);
    return [];
  }
  const identifiers = new Set();
  return value.map((fact, index) => {
    const label = `${prefix}.goldFacts[${index}]`;
    const id = String(fact?.id || '').trim();
    const text = String(fact?.text || '').trim();
    if (!ID_PATTERN.test(id) || identifiers.has(id)) {
      errors.push(`${label}.id must be unique and contain only safe identifier characters.`);
    }
    if (!text || text.length > 4_000) errors.push(`${label}.text must contain 1-4000 characters.`);
    identifiers.add(id);
    return {
      id,
      text,
      evidence: normalizeEvidence(fact?.evidence, `${label}.evidence`, errors),
    };
  });
}

function normalizeRelevant(item, prefix, errors) {
  if (!equalAliases(item.relevant, item.relevance)) {
    errors.push(`${prefix}.relevant and relevance disagree.`);
  }
  const value = item.relevant ?? item.relevance;
  if (!Array.isArray(value)) {
    errors.push(`${prefix}.relevant must be an array.`);
    return [];
  }
  const paths = new Set();
  return value.map((entry, index) => {
    const label = `${prefix}.relevant[${index}]`;
    const relative = safeRelativePath(entry?.path, `${label}.path`, errors);
    const grade = Number(entry?.grade);
    if (![1, 2, 3].includes(grade)) errors.push(`${label}.grade must be 1, 2, or 3.`);
    if (relative && paths.has(relative)) errors.push(`${label}.path is duplicated.`);
    paths.add(relative);
    return {
      path: relative,
      logicalId: entry?.logicalId ? String(entry.logicalId).trim() : null,
      grade,
      evidence: normalizeEvidence(entry?.evidence, `${label}.evidence`, errors, { path: relative }),
    };
  });
}

function normalizeAliases(value, errors) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('documentAliases must be an object mapping a physical path to a logical id.');
    return {};
  }
  const output = {};
  for (const [input, logicalId] of Object.entries(value)) {
    const relative = safeRelativePath(input, `documentAliases[${JSON.stringify(input)}]`, errors);
    const normalizedId = String(logicalId || '').trim();
    if (!normalizedId || normalizedId.length > 500) {
      errors.push(`documentAliases[${JSON.stringify(input)}] needs a non-empty logical id.`);
    }
    if (relative) output[relative] = normalizedId;
  }
  return output;
}

function normalizePriorMessages(value, prefix, category, errors) {
  const messages = value === undefined ? [] : value;
  if (!Array.isArray(messages)) {
    errors.push(`${prefix}.priorMessages must be an array.`);
    return [];
  }
  if (messages.length > 6) errors.push(`${prefix}.priorMessages may contain at most 6 messages.`);
  const normalized = messages.map((message, index) => {
    const expectedRole = index % 2 === 0 ? 'user' : 'assistant';
    const role = String(message?.role || '').trim();
    const content = String(message?.content || '').trim();
    if (role !== expectedRole) {
      errors.push(`${prefix}.priorMessages[${index}].role must be ${expectedRole}.`);
    }
    if (!content || content.length > 8_000) {
      errors.push(`${prefix}.priorMessages[${index}].content must contain 1-8000 characters.`);
    }
    return { role, content };
  });
  if (category === 'context_followup') {
    if (normalized.length < 2 || normalized.length % 2 !== 0) {
      errors.push(`${prefix}.context_followup requires complete user/assistant priorMessages.`);
    }
  } else if (normalized.length) {
    errors.push(`${prefix}.priorMessages are only allowed for context_followup questions.`);
  }
  return normalized;
}

export function validateDataset(value, options = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BenchmarkValidationError('Benchmark dataset must be a JSON object.');
  }
  if (value.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    errors.push(`schemaVersion must equal ${BENCHMARK_SCHEMA_VERSION}.`);
  }
  const reviewStatus = String(value.reviewStatus || value.review?.status || '').trim();
  if (!['pending', 'draft', 'approved'].includes(reviewStatus)) {
    errors.push('reviewStatus must be pending, draft, or approved.');
  }
  const executionAllowed = value.executionAllowed;
  if (typeof executionAllowed !== 'boolean') {
    errors.push('executionAllowed must be boolean.');
  }
  if (['pending', 'draft'].includes(reviewStatus) && executionAllowed !== false) {
    errors.push('pending or draft datasets must have executionAllowed=false.');
  }
  const snapshot = value.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    errors.push('snapshot must be an object.');
  }
  const manifestSha256 = String(snapshot?.manifestSha256 || snapshot?.sha256 || '').toLowerCase();
  if (!SHA256_PATTERN.test(manifestSha256)) {
    errors.push('snapshot.manifestSha256 must be a lowercase SHA-256 digest.');
  }
  const fileCount = positiveInteger(snapshot?.fileCount, 'snapshot.fileCount', errors);
  const logicalDocumentCount = snapshot?.logicalDocumentCount === undefined
    ? fileCount
    : positiveInteger(snapshot.logicalDocumentCount, 'snapshot.logicalDocumentCount', errors);
  if (logicalDocumentCount > fileCount) {
    errors.push('snapshot.logicalDocumentCount cannot exceed snapshot.fileCount.');
  }
  const documentAliases = normalizeAliases(value.documentAliases, errors);
  if (!Array.isArray(value.items) || !value.items.length) errors.push('items must be a non-empty array.');
  const identifiers = new Set();
  const categories = new Map();
  const items = (Array.isArray(value.items) ? value.items : []).map((item, index) => {
    const prefix = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${prefix} must be an object.`);
      return null;
    }
    const id = String(item.id || '').trim();
    if (!ID_PATTERN.test(id) || identifiers.has(id)) {
      errors.push(`${prefix}.id must be unique and contain only safe identifier characters.`);
    }
    identifiers.add(id);
    const category = String(item.category || '').trim();
    if (!Object.hasOwn(PLAN_CATEGORY_COUNTS, category)) {
      errors.push(`${prefix}.category is not a supported benchmark category.`);
    }
    categories.set(category, (categories.get(category) || 0) + 1);
    const query = String(item.query || '').trim();
    if (!query || query.length > 4_000) errors.push(`${prefix}.query must contain 1-4000 characters.`);
    const priorMessages = normalizePriorMessages(item.priorMessages, prefix, category, errors);
    if (typeof item.answerable !== 'boolean') errors.push(`${prefix}.answerable must be boolean.`);
    if (!equalAliases(item.goldAnswer, item.referenceAnswer)) {
      errors.push(`${prefix}.goldAnswer and referenceAnswer disagree.`);
    }
    const goldAnswer = String(item.goldAnswer ?? item.referenceAnswer ?? '').trim();
    if (item.answerable && (!goldAnswer || goldAnswer.length > 12_000)) {
      errors.push(`${prefix}.goldAnswer must contain 1-12000 characters for answerable questions.`);
    }
    const goldFacts = normalizeFacts(item, prefix, errors);
    const relevant = normalizeRelevant(item, prefix, errors);
    if (item.answerable && (!goldFacts.length || !relevant.length)) {
      errors.push(`${prefix} needs goldFacts and relevant documents when answerable=true.`);
    }
    if (!item.answerable && (goldFacts.length || relevant.length)) {
      errors.push(`${prefix} must not contain goldFacts or relevant documents when answerable=false.`);
    }
    if ((category === 'unanswerable') !== (item.answerable === false)) {
      errors.push(`${prefix}.category=unanswerable must exactly match answerable=false.`);
    }
    if (item.answerable && goldFacts.some((fact) => !fact.evidence.length)) {
      errors.push(`${prefix} requires at least one evidence range for every gold fact.`);
    }
    if (item.answerable && relevant.some((entry) => !entry.evidence.length)) {
      errors.push(`${prefix} requires at least one evidence range for every relevant document.`);
    }
    const review = String(item.review?.status || item.reviewStatus || '').trim();
    if (!['pending', 'approved', 'rejected'].includes(review)) {
      errors.push(`${prefix}.review.status must be pending, approved, or rejected.`);
    }
    const relevantPaths = new Set(relevant.map((entry) => entry.path));
    for (const fact of goldFacts) {
      for (const evidence of fact.evidence) {
        if (evidence.path && !relevantPaths.has(evidence.path)) {
          errors.push(`${prefix}.goldFacts evidence path is absent from relevant documents.`);
        }
      }
    }
    return {
      id,
      category,
      query,
      priorMessages,
      answerable: item.answerable,
      goldAnswer,
      goldFacts,
      relevant,
      review,
    };
  }).filter(Boolean);

  const enforcePlan = options.enforcePlan !== false;
  if (enforcePlan) {
    for (const [category, expected] of Object.entries(PLAN_CATEGORY_COUNTS)) {
      const actual = categories.get(category) || 0;
      if (actual !== expected) errors.push(`category ${category} needs ${expected} items; found ${actual}.`);
    }
  }
  if (options.expectedItems !== undefined && items.length !== Number(options.expectedItems)) {
    errors.push(`items must contain exactly ${Number(options.expectedItems)} entries.`);
  }
  if (options.requireApproved) {
    if (reviewStatus !== 'approved') errors.push('The dataset-level reviewStatus is not approved.');
    if (executionAllowed !== true) errors.push('The approved dataset does not allow execution.');
    const pending = items.filter((item) => item.review !== 'approved').map((item) => item.id);
    if (pending.length) errors.push(`${pending.length} item(s) do not have review.status=approved.`);
  }
  if (options.snapshotPaths) {
    const available = new Set(options.snapshotPaths);
    for (const item of items) {
      for (const relevant of item.relevant) {
        if (relevant.path && !available.has(relevant.path)) {
          errors.push(`Item ${item.id} references a path absent from the verified snapshot manifest.`);
        }
      }
    }
    for (const relative of Object.keys(documentAliases)) {
      if (!available.has(relative)) errors.push(`documentAliases references an absent snapshot path.`);
    }
  }
  if (errors.length) {
    throw new BenchmarkValidationError(
      `Benchmark dataset validation failed with ${errors.length} error(s).`,
      'INVALID_BENCHMARK_DATASET',
      errors,
    );
  }
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    reviewStatus,
    executionAllowed,
    snapshot: {
      manifestSha256,
      fileCount,
      logicalDocumentCount,
    },
    documentAliases,
    items,
  };
}

function parseManifestLine(line, index, errors) {
  const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line);
  if (!match) {
    errors.push(`Snapshot manifest line ${index + 1} is not in "sha256  ./relative/path" format.`);
    return null;
  }
  const relative = safeRelativePath(match[2], `snapshot manifest line ${index + 1}`, errors);
  return relative ? { sha256: match[1], path: relative } : null;
}

function sourceRelativePath(value, label, errors) {
  const input = String(value || '').normalize('NFC');
  if (!input || input.includes('\0') || input.includes('\\') || path.isAbsolute(input)) {
    errors.push(`${label} must be a normalized relative path.`);
    return '';
  }
  const parts = input.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    errors.push(`${label} contains an unsafe path component.`);
    return '';
  }
  return parts.join('/');
}

function parseSourceManifestLine(line, index, errors) {
  const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line);
  if (!match) {
    errors.push(`Source manifest line ${index + 1} has an invalid format.`);
    return null;
  }
  const relative = sourceRelativePath(match[2], `source manifest line ${index + 1}`, errors);
  return relative ? { sha256: match[1], path: relative } : null;
}

async function allRegularFiles(root, relative = '') {
  const directory = relative ? path.join(root, relative) : root;
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new BenchmarkValidationError('Manifest root contains a symbolic link.', 'UNSAFE_MANIFEST_ROOT');
    }
    if (entry.isDirectory()) files.push(...await allRegularFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new BenchmarkValidationError('Manifest root contains a non-regular entry.');
  }
  return files;
}

export async function verifySourceManifest(options) {
  const root = path.resolve(String(options?.sourceRoot || ''));
  const manifestFile = path.resolve(String(options?.manifestFile || ''));
  const expectedManifestSha256 = String(options?.expectedManifestSha256 || '').toLowerCase();
  if (!SHA256_PATTERN.test(expectedManifestSha256)) {
    throw new BenchmarkValidationError('A pinned source manifest SHA-256 is required.');
  }
  const rootStat = await fsp.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new BenchmarkValidationError('Source root is not a regular directory.', 'UNSAFE_SOURCE_ROOT');
  }
  const raw = await fsp.readFile(manifestFile);
  if (sha256(raw) !== expectedManifestSha256) {
    throw new BenchmarkValidationError('Source manifest digest changed.', 'SOURCE_MANIFEST_MISMATCH');
  }
  const errors = [];
  const entries = raw.toString('utf8').split(/\r?\n/).filter(Boolean)
    .map((line, index) => parseSourceManifestLine(line, index, errors)).filter(Boolean);
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) errors.push(`Source manifest contains a duplicate relative path.`);
    seen.add(entry.path);
    const filename = path.join(root, entry.path);
    const stat = await fsp.lstat(filename).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      errors.push(`Source manifest entry is absent or not a regular file.`);
      continue;
    }
    if (sha256(await fsp.readFile(filename)) !== entry.sha256) {
      errors.push(`Source file hash differs from its pinned manifest.`);
    }
  }
  if (options.strictFileSet !== false) {
    const actual = await allRegularFiles(root);
    if (actual.length !== entries.length || actual.some((relative) => !seen.has(relative))) {
      errors.push('Source root file set differs from its pinned manifest.');
    }
  }
  if (options.expectedFileCount !== undefined && entries.length !== Number(options.expectedFileCount)) {
    errors.push(`Source manifest file count differs from ${Number(options.expectedFileCount)}.`);
  }
  if (errors.length) {
    throw new BenchmarkValidationError(
      `Source manifest verification failed with ${errors.length} error(s).`,
      'SOURCE_VERIFICATION_FAILED',
      errors,
    );
  }
  const realRoot = await fsp.realpath(root);
  return {
    manifestRoot: root,
    realRoot,
    rootStat: {
      dev: Number(rootStat.dev),
      ino: Number(rootStat.ino),
      size: Number(rootStat.size),
      mtimeMs: Number(rootStat.mtimeMs),
      ctimeMs: Number(rootStat.ctimeMs),
    },
    manifestSha256: expectedManifestSha256,
    fileCount: entries.length,
    entries,
  };
}

function temporarySnapshotName(name) {
  return name.startsWith('~') || name.endsWith('~') ||
    /(?:\.tmp|\.temp|\.swp|\.part|\.crdownload)$/i.test(name);
}

export async function verifySnapshotProvenance(source, snapshot) {
  if (!source?.realRoot || !Array.isArray(source.entries) || !Array.isArray(snapshot?.entries)) {
    throw new BenchmarkValidationError(
      'Verified source and snapshot objects are required for provenance verification.',
      'INVALID_PROVENANCE_ARGUMENTS',
    );
  }
  const excluded = {
    hiddenPath: 0,
    temporaryName: 0,
    unsupportedExtension: 0,
    oversized: 0,
    nulBytes: 0,
    sensitiveOrAddress: 0,
  };
  const expected = new Map();
  for (const entry of source.entries) {
    const parts = entry.path.split('/');
    const name = parts.at(-1) || '';
    if (parts.some((part) => part.startsWith('.'))) {
      excluded.hiddenPath += 1;
      continue;
    }
    if (temporarySnapshotName(name)) {
      excluded.temporaryName += 1;
      continue;
    }
    if (!ALLOWED_SNAPSHOT_EXTENSIONS.has(path.extname(name).toLowerCase())) {
      excluded.unsupportedExtension += 1;
      continue;
    }
    const filename = path.join(source.realRoot, entry.path);
    const stat = await fsp.lstat(filename);
    if (stat.size > SNAPSHOT_FILTER_POLICY.maximumBytes) {
      excluded.oversized += 1;
      continue;
    }
    const buffer = await fsp.readFile(filename);
    if (buffer.includes(0)) {
      excluded.nulBytes += 1;
      continue;
    }
    const content = buffer.toString('utf8');
    let sensitive = false;
    for (const pattern of SNAPSHOT_EXCLUSION_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(content)) {
        sensitive = true;
        break;
      }
    }
    if (sensitive) {
      excluded.sensitiveOrAddress += 1;
      continue;
    }
    expected.set(entry.path, entry.sha256);
  }
  const actual = new Map(snapshot.entries.map((entry) => [entry.path, entry.sha256]));
  let missing = 0;
  let unexpected = 0;
  let mismatched = 0;
  for (const [relative, digest] of expected) {
    if (!actual.has(relative)) missing += 1;
    else if (actual.get(relative) !== digest) mismatched += 1;
  }
  for (const relative of actual.keys()) if (!expected.has(relative)) unexpected += 1;
  if (missing || unexpected || mismatched) {
    throw new BenchmarkValidationError(
      'Read-only snapshot does not reproduce the pinned filtering policy.',
      'SNAPSHOT_PROVENANCE_MISMATCH',
      [
        `missing=${missing}`,
        `unexpected=${unexpected}`,
        `hashMismatch=${mismatched}`,
        `expectedIncluded=${expected.size}`,
        `exclusions=${JSON.stringify(excluded)}`,
      ],
    );
  }
  return {
    policy: SNAPSHOT_FILTER_POLICY,
    policySha256: sha256(JSON.stringify(SNAPSHOT_FILTER_POLICY)),
    sourceFiles: source.entries.length,
    includedFiles: expected.size,
    exclusionReasonCounts: excluded,
    membershipAndHashesVerified: true,
  };
}

async function snapshotFiles(root, relative = '', options = {}) {
  const directory = relative ? path.join(root, relative) : root;
  const directoryStat = await fsp.lstat(directory);
  const realDirectory = await fsp.realpath(directory);
  const boundary = path.relative(options.realRoot || root, realDirectory);
  if (
    directoryStat.isSymbolicLink() || !directoryStat.isDirectory() ||
    boundary.startsWith('..') || path.isAbsolute(boundary)
  ) throw new BenchmarkValidationError('Snapshot directory escapes its fixed root.', 'UNSAFE_SNAPSHOT');
  if (options.requireReadOnly !== false && (directoryStat.mode & 0o222) !== 0) {
    throw new BenchmarkValidationError('Snapshot contains a writable directory.', 'SNAPSHOT_NOT_READ_ONLY');
  }
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name.startsWith('.')) {
      throw new BenchmarkValidationError(
        'Snapshot contains a hidden path.',
        'UNSAFE_SNAPSHOT',
        [child],
      );
    }
    if (entry.isSymbolicLink()) {
      throw new BenchmarkValidationError(
        'Snapshot contains a symbolic link.',
        'UNSAFE_SNAPSHOT',
        [child],
      );
    }
    if (entry.isDirectory()) files.push(...await snapshotFiles(root, child, options));
    else if (entry.isFile()) files.push(child);
    else throw new BenchmarkValidationError('Snapshot contains a non-regular entry.', 'UNSAFE_SNAPSHOT');
  }
  return files;
}

export async function verifySnapshot(options) {
  const root = path.resolve(String(options?.snapshotRoot || ''));
  const manifestFile = path.resolve(String(options?.manifestFile || ''));
  const expectedManifestSha256 = String(options?.expectedManifestSha256 || '').toLowerCase();
  if (!root || !manifestFile || !SHA256_PATTERN.test(expectedManifestSha256)) {
    throw new BenchmarkValidationError(
      'snapshotRoot, manifestFile, and expectedManifestSha256 are required.',
      'INVALID_SNAPSHOT_ARGUMENTS',
    );
  }
  const rootStat = await fsp.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new BenchmarkValidationError('Snapshot root is not a regular directory.', 'UNSAFE_SNAPSHOT');
  }
  if ((rootStat.mode & 0o222) !== 0 && options.requireReadOnly !== false) {
    throw new BenchmarkValidationError('Snapshot root must be read-only.', 'SNAPSHOT_NOT_READ_ONLY');
  }
  const manifestStat = await fsp.lstat(manifestFile).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o077) !== 0) {
    throw new BenchmarkValidationError(
      'Snapshot manifest must be a private regular file with mode 0600.',
      'UNSAFE_SNAPSHOT_MANIFEST',
    );
  }
  const realRoot = await fsp.realpath(root);
  const rawManifest = await fsp.readFile(manifestFile);
  const actualManifestSha256 = sha256(rawManifest);
  if (actualManifestSha256 !== expectedManifestSha256) {
    throw new BenchmarkValidationError(
      'Snapshot manifest SHA-256 does not match the approved dataset.',
      'SNAPSHOT_MANIFEST_MISMATCH',
    );
  }
  const errors = [];
  const manifestEntries = rawManifest.toString('utf8').split(/\r?\n/).filter(Boolean)
    .map((line, index) => parseManifestLine(line, index, errors)).filter(Boolean);
  const seen = new Set();
  for (const entry of manifestEntries) {
    if (seen.has(entry.path)) errors.push(`Snapshot manifest contains a duplicate path: ${entry.path}`);
    seen.add(entry.path);
  }
  const actualPaths = await snapshotFiles(root, '', {
    realRoot,
    requireReadOnly: options.requireReadOnly,
  });
  const actualSet = new Set(actualPaths);
  for (const relative of actualPaths) {
    if (!ALLOWED_SNAPSHOT_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
      errors.push(`Snapshot contains a non-text extension: ${relative}`);
    }
    if (!seen.has(relative)) errors.push(`Snapshot contains a file absent from its manifest: ${relative}`);
  }
  for (const entry of manifestEntries) {
    if (!actualSet.has(entry.path)) {
      errors.push(`Snapshot manifest refers to a missing file: ${entry.path}`);
      continue;
    }
    const filename = path.join(root, entry.path);
    const stat = await fsp.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.push(`Snapshot entry is not a regular file: ${entry.path}`);
      continue;
    }
    if (stat.nlink !== 1) errors.push(`Snapshot file has multiple hard links: ${entry.path}`);
    if ((stat.mode & 0o222) !== 0 && options.requireReadOnly !== false) {
      errors.push(`Snapshot file is writable: ${entry.path}`);
    }
    const buffer = await fsp.readFile(filename);
    if (buffer.includes(0)) errors.push(`Snapshot file contains NUL bytes: ${entry.path}`);
    if (sha256(buffer) !== entry.sha256) errors.push(`Snapshot file hash changed: ${entry.path}`);
  }
  if (errors.length) {
    throw new BenchmarkValidationError(
      `Snapshot verification failed with ${errors.length} error(s).`,
      'SNAPSHOT_VERIFICATION_FAILED',
      errors,
    );
  }
  return {
    root,
    manifestFile,
    manifestSha256: actualManifestSha256,
    fileCount: manifestEntries.length,
    paths: manifestEntries.map((entry) => entry.path),
    entries: manifestEntries,
  };
}

export async function scanSnapshotSecrets(snapshot) {
  const findings = [];
  for (const entry of snapshot.entries || []) {
    const content = await fsp.readFile(path.join(snapshot.root, entry.path), 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(content)) findings.push({ path: entry.path, type: pattern.name });
    }
  }
  return findings;
}

export function scanDatasetSecrets(dataset) {
  const findings = [];
  for (const item of dataset.items || []) {
    const fields = [
      ['query', item.query],
      ['goldAnswer', item.goldAnswer],
      ...(item.priorMessages || []).map((message, index) => [
        `priorMessages.${index}.${message.role}`,
        message.content,
      ]),
      ...(item.goldFacts || []).map((fact) => [`goldFacts.${fact.id}`, fact.text]),
    ];
    for (const [field, text] of fields) {
      for (const pattern of SECRET_PATTERNS) {
        pattern.regex.lastIndex = 0;
        if (pattern.regex.test(String(text || ''))) {
          findings.push({ questionId: item.id, field, type: pattern.name });
        }
      }
    }
  }
  return findings;
}

export function evidenceText(lines, startLine, endLine) {
  if (
    !Array.isArray(lines) || !Number.isInteger(startLine) || !Number.isInteger(endLine) ||
    startLine < 1 || endLine < startLine || endLine > lines.length
  ) return null;
  return lines.slice(startLine - 1, endLine).join('\n');
}

export async function verifyDatasetEvidence(dataset, snapshot) {
  const cache = new Map();
  const errors = [];
  let evidenceRanges = 0;
  const linesFor = async (relative) => {
    if (cache.has(relative)) return cache.get(relative);
    const text = await fsp.readFile(path.join(snapshot.root, relative), 'utf8');
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    cache.set(relative, lines);
    return lines;
  };
  for (const item of dataset.items) {
    const groups = [
      ...item.relevant.map((entry) => entry.evidence),
      ...item.goldFacts.map((fact) => fact.evidence),
    ];
    for (const evidence of groups.flat()) {
      evidenceRanges += 1;
      const lines = await linesFor(evidence.path);
      const selected = evidenceText(lines, evidence.startLine, evidence.endLine);
      if (selected === null) {
        errors.push(`Item ${item.id} has an out-of-range evidence interval.`);
      } else if (sha256(Buffer.from(selected, 'utf8')) !== evidence.textSha256) {
        errors.push(`Item ${item.id} has an evidence text SHA-256 mismatch.`);
      }
    }
  }
  if (errors.length) {
    throw new BenchmarkValidationError(
      `Evidence verification failed with ${errors.length} error(s).`,
      'EVIDENCE_VERIFICATION_FAILED',
      errors,
    );
  }
  return { filesRead: cache.size, evidenceRanges, newlineNormalization: 'CRLF/CR to LF; no trailing LF added' };
}

function stripVariantSuffix(name) {
  let output = name;
  const suffix = /(?:[\s_-]*(?:[（(](?:整理版|原文)[）)]|整理版|原文))$/iu;
  while (suffix.test(output)) output = output.replace(suffix, '');
  return output || name;
}

export function logicalDocumentKey(relativeInput, aliases = {}) {
  const relative = String(relativeInput || '').normalize('NFC').replaceAll('\\', '/');
  if (Object.hasOwn(aliases, relative)) return String(aliases[relative]);
  const extension = path.posix.extname(relative);
  const directory = path.posix.dirname(relative);
  const basename = path.posix.basename(relative, extension);
  const normalized = `${directory === '.' ? '' : `${directory}/`}${stripVariantSuffix(basename)}${extension}`;
  return normalized.toLocaleLowerCase('zh-CN');
}

export function deduplicateResults(results, aliases = {}) {
  if (!Array.isArray(results)) return { results: [], duplicateSlots: 0, physicalCount: 0 };
  const seen = new Set();
  const output = [];
  let duplicateSlots = 0;
  for (const result of results) {
    const relative = String(result?.path || '');
    if (!relative) continue;
    const logicalId = result.logicalId || logicalDocumentKey(relative, aliases);
    if (seen.has(logicalId)) {
      duplicateSlots += 1;
      continue;
    }
    seen.add(logicalId);
    output.push({ ...result, logicalId });
  }
  return { results: output, duplicateSlots, physicalCount: results.length };
}

function overlap(leftStart, leftEnd, rightStart, rightEnd) {
  if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) return false;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

export function retrievalMetrics(item, returnedResults, options = {}) {
  const aliases = options.documentAliases || {};
  const kValues = [...new Set(options.kValues || DEFAULT_K_VALUES)].sort((a, b) => a - b);
  const universeSize = Math.max(1, Number(options.universeSize) || 1);
  const physical = (Array.isArray(returnedResults) ? returnedResults : [])
    .filter((entry) => entry?.path)
    .map((entry) => ({
      ...entry,
      logicalId: entry.logicalId || logicalDocumentKey(entry.path, aliases),
    }));
  const relevantGrades = new Map();
  const evidenceSegments = [];
  for (const relevant of item.relevant || []) {
    const logicalId = relevant.logicalId || logicalDocumentKey(relevant.path, aliases);
    relevantGrades.set(logicalId, Math.max(relevantGrades.get(logicalId) || 0, relevant.grade || 1));
    for (const evidence of relevant.evidence || []) {
      evidenceSegments.push({ ...evidence, logicalId });
    }
  }
  const maximumK = Math.max(...kValues);
  const top = physical.slice(0, maximumK);
  const byK = {};
  for (const k of kValues) {
    const topAtK = physical.slice(0, k);
    const retrievedLogical = new Set(topAtK.map((entry) => entry.logicalId));
    const truePositive = [...retrievedLogical]
      .filter((logicalId) => relevantGrades.has(logicalId)).length;
    const falsePositive = [...retrievedLogical]
      .filter((logicalId) => !relevantGrades.has(logicalId)).length;
    const falseNegative = Math.max(0, relevantGrades.size - truePositive);
    const trueNegative = Math.max(0, universeSize - truePositive - falsePositive - falseNegative);
    const precision = truePositive / k;
    const recall = relevantGrades.size ? truePositive / relevantGrades.size : null;
    const f1 = recall === null || precision + recall === 0
      ? (recall === null ? null : 0)
      : (2 * precision * recall) / (precision + recall);
    byK[k] = {
      truePositive,
      falsePositive,
      falseNegative,
      trueNegative,
      accuracy: (truePositive + trueNegative) / universeSize,
      precision,
      recall,
      f1,
    };
  }
  const seenRelevant = new Set();
  const firstRelevantIndex = top.findIndex((entry) => relevantGrades.has(entry.logicalId));
  let relevantSeen = 0;
  let precisionSum = 0;
  for (let index = 0; index < top.length; index += 1) {
    const logicalId = top[index].logicalId;
    if (!relevantGrades.has(logicalId) || seenRelevant.has(logicalId)) continue;
    seenRelevant.add(logicalId);
    relevantSeen += 1;
    precisionSum += relevantSeen / (index + 1);
  }
  const averagePrecision = relevantGrades.size ? precisionSum / relevantGrades.size : null;
  const gained = new Set();
  const gains = top.map((entry) => {
    if (gained.has(entry.logicalId)) return 0;
    gained.add(entry.logicalId);
    return relevantGrades.get(entry.logicalId) || 0;
  });
  const dcg = gains.reduce((sum, grade, index) => (
    sum + ((2 ** grade - 1) / Math.log2(index + 2))
  ), 0);
  const idealGains = [...relevantGrades.values()].sort((left, right) => right - left).slice(0, maximumK);
  const idealDcg = idealGains.reduce((sum, grade, index) => (
    sum + ((2 ** grade - 1) / Math.log2(index + 2))
  ), 0);
  let coveredEvidence = 0;
  for (const evidence of evidenceSegments) {
    if (top.some((result) => (
      result.logicalId === evidence.logicalId &&
      overlap(Number(result.lineStart), Number(result.lineEnd), evidence.startLine, evidence.endLine)
    ))) coveredEvidence += 1;
  }
  const lineHit = evidenceSegments.length ? coveredEvidence > 0 : null;
  const topDeduplicated = deduplicateResults(top, aliases);
  return {
    byK,
    reciprocalRank: relevantGrades.size && firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
    averagePrecision,
    ndcg: idealDcg ? dcg / idealDcg : null,
    exactLineHit: lineHit,
    evidenceSegmentRecall: evidenceSegments.length ? coveredEvidence / evidenceSegments.length : null,
    duplicateLogicalOccupancyRate: topDeduplicated.physicalCount
      ? topDeduplicated.duplicateSlots / topDeduplicated.physicalCount
      : 0,
    falseRetrievalForUnanswerable: relevantGrades.size === 0 ? top.length > 0 : null,
    returnedLogicalDocuments: deduplicateResults(physical, aliases).results.length,
  };
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export function quantile(values, probability) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * Math.max(0, Math.min(1, probability));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function latencySummary(values) {
  const finite = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  return {
    count: finite.length,
    mean: round(mean(finite), 3),
    p50: round(quantile(finite, 0.5), 3),
    p95: round(quantile(finite, 0.95), 3),
    min: finite.length ? round(Math.min(...finite), 3) : null,
    max: finite.length ? round(Math.max(...finite), 3) : null,
  };
}

export function normalizeUsage(value = {}) {
  const usage = value?.usage && typeof value.usage === 'object' ? value.usage : value;
  const cacheRead = Number(
    usage.cacheReadInputTokens ?? usage.cacheReadTokens ?? usage.cache_read_input_tokens ??
    usage.prompt_tokens_details?.cached_tokens ?? 0,
  );
  const cacheCreation = Number(
    usage.cacheCreationInputTokens ?? usage.cacheCreationTokens ??
    usage.cache_creation_input_tokens ?? 0,
  );
  const output = Number(
    usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0,
  );
  let standardInput;
  if (usage.standardInputTokens !== undefined) {
    standardInput = Number(usage.standardInputTokens);
  } else if (usage.input_tokens !== undefined) {
    standardInput = Number(usage.input_tokens);
  } else if (usage.inputTokens !== undefined) {
    // Runtime camelCase usage reports non-cached input separately from cache
    // reads/creation, so it must not be reduced by either cache counter.
    standardInput = Number(usage.inputTokens);
  } else {
    // OpenAI-compatible prompt_tokens is a total prompt count. Its cached
    // portion is reported inside prompt_tokens_details and must be removed
    // to avoid charging those tokens at both standard and cache-read rates.
    const prompt = Number(usage.prompt_tokens ?? 0);
    standardInput = usage.inputIncludesCache === false ? prompt : Math.max(0, prompt - cacheRead);
  }
  const values = { standardInput, cacheRead, cacheCreation, output };
  if (Object.values(values).some((number) => !Number.isFinite(number) || number < 0)) {
    throw new BenchmarkValidationError('Usage counters must be finite non-negative numbers.', 'INVALID_USAGE');
  }
  return {
    standardInputTokens: Math.trunc(standardInput),
    cacheReadInputTokens: Math.trunc(cacheRead),
    cacheCreationInputTokens: Math.trunc(cacheCreation),
    outputTokens: Math.trunc(output),
  };
}

export function accumulateUsage(calls = []) {
  const total = {
    requests: 0,
    standardInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
  };
  for (const call of calls || []) {
    const normalized = normalizeUsage(call);
    total.requests += 1;
    for (const key of Object.keys(normalized)) total[key] += normalized[key];
  }
  total.totalInputTokens = total.standardInputTokens + total.cacheReadInputTokens +
    total.cacheCreationInputTokens;
  total.totalTokens = total.totalInputTokens + total.outputTokens;
  return total;
}

export function estimateCostCny(usageInput, pricing = DEFAULT_PRICING) {
  const usage = usageInput?.requests === undefined
    ? accumulateUsage([usageInput])
    : usageInput;
  const value = (
    usage.standardInputTokens * Number(pricing.inputPerMillion) +
    usage.outputTokens * Number(pricing.outputPerMillion) +
    usage.cacheReadInputTokens * Number(pricing.cacheReadPerMillion ?? pricing.inputPerMillion) +
    usage.cacheCreationInputTokens * Number(
      pricing.cacheCreationPerMillion ?? pricing.inputPerMillion,
    )
  ) / 1_000_000;
  if (!Number.isFinite(value) || value < 0) {
    throw new BenchmarkValidationError('Pricing values must be finite non-negative numbers.', 'INVALID_PRICING');
  }
  return value;
}

export function assertFairModelConfiguration(value) {
  const errors = [];
  if (!value || typeof value !== 'object') {
    throw new BenchmarkValidationError(
      'Offline results must declare the model configuration used to collect them.',
      'MISSING_MODEL_CONFIGURATION',
    );
  }
  if (value.model !== FAIR_MODEL_CONFIGURATION.model) errors.push('model must be qwen3.8-max.');
  if (Number(value.temperature) !== 0) errors.push('temperature must be 0.');
  if (Number(value.maxOutputTokens) !== 3_000) errors.push('maxOutputTokens must be 3000.');
  if (Number(value.anthropic?.temperature) !== 0) errors.push('Anthropic temperature must be 0.');
  if (Number(value.anthropic?.max_tokens) !== 3_000) {
    errors.push('Anthropic max_tokens must be 3000.');
  }
  if (value.anthropic?.output_config?.effort !== 'medium') {
    errors.push('Anthropic output_config.effort must be medium.');
  }
  if (Number(value.openaiChat?.temperature) !== 0) errors.push('OpenAI temperature must be 0.');
  if (Number(value.openaiChat?.max_tokens) !== 3_000) {
    errors.push('OpenAI max_tokens must be 3000.');
  }
  if (value.openaiChat?.reasoning_effort !== 'medium') {
    errors.push('OpenAI reasoning_effort must be medium.');
  }
  if (value.webSearch !== false) errors.push('Web Search must be disabled.');
  if (value.freshSessionPerQuestion !== true) errors.push('Every question must use a fresh session.');
  if (errors.length) {
    throw new BenchmarkValidationError(
      'Offline results violate the locked fair-model configuration.',
      'UNFAIR_MODEL_CONFIGURATION',
      errors,
    );
  }
  return FAIR_MODEL_CONFIGURATION;
}

export class BudgetGate {
  constructor(options = {}) {
    this.hardLimitCny = Number(options.hardLimitCny ?? DEFAULT_BUDGET.hardLimitCny);
    this.startLimitCny = Number(options.startLimitCny ?? DEFAULT_BUDGET.startLimitCny);
    this.actualCny = Number(options.actualCny || 0);
    this.reservedCny = 0;
    if (
      !Number.isFinite(this.hardLimitCny) || !Number.isFinite(this.startLimitCny) ||
      this.hardLimitCny <= 0 || this.startLimitCny <= 0 ||
      this.startLimitCny > this.hardLimitCny
    ) throw new BenchmarkValidationError('Budget limits are invalid.', 'INVALID_BUDGET');
  }

  canStart(estimatedCny = 0) {
    const estimate = Number(estimatedCny);
    return Number.isFinite(estimate) && estimate >= 0 &&
      this.actualCny + this.reservedCny < this.startLimitCny &&
      this.actualCny + this.reservedCny + estimate <= this.startLimitCny;
  }

  reserve(estimatedCny = 0) {
    const estimate = Number(estimatedCny);
    if (!this.canStart(estimate)) {
      throw new BenchmarkValidationError(
        'Budget start limit reached; refusing to start another request.',
        'BUDGET_START_LIMIT_REACHED',
      );
    }
    this.reservedCny += estimate;
    return Object.freeze({ estimate });
  }

  settle(reservation, actualCny) {
    const reserved = Number(reservation?.estimate || 0);
    const actual = Number(actualCny);
    if (!Number.isFinite(actual) || actual < 0 || reserved > this.reservedCny + 1e-9) {
      throw new BenchmarkValidationError('Budget settlement is invalid.', 'INVALID_BUDGET_SETTLEMENT');
    }
    this.reservedCny = Math.max(0, this.reservedCny - reserved);
    this.actualCny += actual;
    if (this.actualCny > this.hardLimitCny) {
      throw new BenchmarkValidationError('Hard budget limit exceeded.', 'BUDGET_HARD_LIMIT_EXCEEDED');
    }
    return this.status();
  }

  status() {
    return {
      hardLimitCny: this.hardLimitCny,
      startLimitCny: this.startLimitCny,
      actualCny: round(this.actualCny),
      reservedCny: round(this.reservedCny),
      remainingHardLimitCny: round(Math.max(0, this.hardLimitCny - this.actualCny)),
      mayStartZeroCostRequest: this.canStart(0),
    };
  }
}

function metricAverage(records, selector) {
  return mean(records.map(selector).filter(Number.isFinite));
}

export function aggregateRetrieval(records, dataset, options = {}) {
  const itemById = new Map(dataset.items.map((item) => [item.id, item]));
  const questionIdWidth = Math.max(3, String(dataset.items.length).length);
  const anonymousQuestionIds = new Map(dataset.items.map((item, index) => [
    item.id,
    `Question-${String(index + 1).padStart(questionIdWidth, '0')}`,
  ]));
  const scored = [];
  for (const record of records) {
    const item = itemById.get(record.questionId);
    if (!item) throw new BenchmarkValidationError('Result refers to an unknown question id.');
    scored.push({
      questionId: record.questionId,
      metrics: retrievalMetrics(item, record.retrieval?.results || [], {
        documentAliases: dataset.documentAliases,
        universeSize: dataset.snapshot.logicalDocumentCount,
        kValues: options.kValues,
      }),
    });
  }
  const kValues = [...new Set(options.kValues || DEFAULT_K_VALUES)].sort((a, b) => a - b);
  const byK = {};
  for (const k of kValues) {
    byK[k] = {};
    for (const name of ['accuracy', 'precision', 'recall', 'f1']) {
      byK[k][name] = round(metricAverage(scored, (entry) => entry.metrics.byK[k][name]));
    }
  }
  return {
    questions: scored.length,
    answerableQuestions: scored.filter((entry) => (
      itemById.get(entry.questionId).answerable
    )).length,
    byK,
    meanReciprocalRank: round(metricAverage(scored.filter((entry) => (
      itemById.get(entry.questionId).answerable
    )), (entry) => entry.metrics.reciprocalRank)),
    meanAveragePrecision: round(metricAverage(scored, (entry) => entry.metrics.averagePrecision)),
    meanNdcg: round(metricAverage(scored, (entry) => entry.metrics.ndcg)),
    exactLineHitRate: round(metricAverage(scored, (entry) => (
      entry.metrics.exactLineHit === null ? null : Number(entry.metrics.exactLineHit)
    ))),
    evidenceSegmentRecall: round(metricAverage(scored, (entry) => entry.metrics.evidenceSegmentRecall)),
    duplicateLogicalOccupancyRate: round(metricAverage(
      scored,
      (entry) => entry.metrics.duplicateLogicalOccupancyRate,
    )),
    unanswerableFalseRetrievalRate: round(metricAverage(scored, (entry) => (
      entry.metrics.falseRetrievalForUnanswerable === null
        ? null
        : Number(entry.metrics.falseRetrievalForUnanswerable)
    ))),
    perQuestion: scored.map((entry) => ({
      questionId: anonymousQuestionIds.get(entry.questionId),
      metrics: entry.metrics,
    })),
  };
}

function answerEvaluation(record, item) {
  const value = record.answerEvaluation || {};
  const errors = [];
  const count = (key) => finiteNonnegative(value[key] ?? 0, `answerEvaluation.${key}`, errors);
  const predictedFacts = count('predictedFactCount');
  const supportedFacts = count('supportedFactCount');
  const goldFacts = count('goldFactCount');
  const matchedGoldFacts = count('matchedGoldFactCount');
  const citations = count('citationCount');
  const validCitations = count('validCitationCount');
  const goldEvidence = count('goldEvidenceCount');
  const citedGoldEvidence = count('citedGoldEvidenceCount');
  const hallucinatedFacts = count('hallucinatedFactCount');
  const contradictions = count('contradictionCount');
  if (
    supportedFacts > predictedFacts || matchedGoldFacts > goldFacts || validCitations > citations ||
    citedGoldEvidence > goldEvidence || hallucinatedFacts > predictedFacts ||
    contradictions > predictedFacts
  ) errors.push('answerEvaluation contains an impossible numerator/denominator pair.');
  if (typeof value.questionCorrect !== 'boolean') errors.push('answerEvaluation.questionCorrect is required.');
  if (typeof value.refused !== 'boolean') errors.push('answerEvaluation.refused is required.');
  if (errors.length) {
    throw new BenchmarkValidationError('Answer evaluation is invalid.', 'INVALID_ANSWER_EVALUATION', errors);
  }
  return {
    questionCorrect: value.questionCorrect,
    predictedFacts,
    supportedFacts,
    goldFacts,
    matchedGoldFacts,
    citations,
    validCitations,
    goldEvidence,
    citedGoldEvidence,
    hallucinatedFacts,
    contradictions,
    correctRefusal: item.answerable ? null : value.refused,
  };
}

export function aggregateAnswers(records, dataset) {
  const itemById = new Map(dataset.items.map((item) => [item.id, item]));
  const values = records.map((record) => {
    const item = itemById.get(record.questionId);
    if (!item) throw new BenchmarkValidationError('Result refers to an unknown question id.');
    return answerEvaluation(record, item);
  });
  const sum = (key) => values.reduce((total, value) => total + Number(value[key] || 0), 0);
  const predictedFacts = sum('predictedFacts');
  const goldFacts = sum('goldFacts');
  const factPrecision = predictedFacts ? sum('supportedFacts') / predictedFacts : null;
  const factRecall = goldFacts ? sum('matchedGoldFacts') / goldFacts : null;
  const factF1 = factPrecision === null || factRecall === null || factPrecision + factRecall === 0
    ? (factPrecision === null || factRecall === null ? null : 0)
    : 2 * factPrecision * factRecall / (factPrecision + factRecall);
  const citations = sum('citations');
  const goldEvidence = sum('goldEvidence');
  return {
    evaluatedQuestions: values.length,
    questionAccuracy: round(metricAverage(values, (value) => Number(value.questionCorrect))),
    factPrecision: round(factPrecision),
    factRecall: round(factRecall),
    factF1: round(factF1),
    answerCompleteness: round(factRecall),
    citationPrecision: round(citations ? sum('validCitations') / citations : null),
    citationRecall: round(goldEvidence ? sum('citedGoldEvidence') / goldEvidence : null),
    invalidCitationRate: round(citations ? (citations - sum('validCitations')) / citations : null),
    hallucinationRate: round(predictedFacts ? sum('hallucinatedFacts') / predictedFacts : null),
    contradictionRate: round(predictedFacts ? sum('contradictions') / predictedFacts : null),
    unanswerableCorrectRefusalRate: round(metricAverage(values, (value) => (
      value.correctRefusal === null ? null : Number(value.correctRefusal)
    ))),
  };
}

function sanitizeSystemId(value) {
  const input = String(value || '');
  if (!ID_PATTERN.test(input)) throw new BenchmarkValidationError('System id is invalid.');
  return input;
}

function taskMode(record) {
  const value = String(record?.taskMode || record?.mode || 'normal').trim().toLowerCase();
  if (!['normal', 'deep'].includes(value)) {
    throw new BenchmarkValidationError('Every result record must use taskMode=normal or deep.');
  }
  return value;
}

function repetition(record) {
  const value = Number(record?.repetition ?? record?.runNumber ?? 1);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new BenchmarkValidationError('Result repetition must be an integer from 1 to 100.');
  }
  return value;
}

function numericCount(record, key, arrayKey = '') {
  if (Array.isArray(record?.[arrayKey || key])) return record[arrayKey || key].length;
  const value = Number(record?.[key] || 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function factF1ForRecord(record) {
  const value = record?.answerEvaluation;
  if (!value) return null;
  const predicted = Number(value.predictedFactCount || 0);
  const gold = Number(value.goldFactCount || 0);
  const precision = predicted ? Number(value.supportedFactCount || 0) / predicted : null;
  const recall = gold ? Number(value.matchedGoldFactCount || 0) / gold : null;
  if (precision === null || recall === null) return null;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function recordCost(record, pricing) {
  return estimateCostCny(accumulateUsage(record?.calls || []), pricing);
}

const ANONYMOUS_ERROR_BUCKETS = Object.freeze([
  'TASK_TIMEOUT',
  'BUDGET_ERROR',
  'AUTH_ERROR',
  'RATE_LIMIT_ERROR',
  'USAGE_ERROR',
  'NETWORK_ERROR',
  'RETRIEVAL_ERROR',
  'MODEL_API_ERROR',
  'CANCELLED',
  'OTHER_ERROR',
]);

function anonymousErrorBucket(value) {
  const code = String(value || 'UNKNOWN_ERROR').toUpperCase();
  if (/TIMEOUT/.test(code)) return 'TASK_TIMEOUT';
  if (/BUDGET|QUOTA|COST/.test(code)) return 'BUDGET_ERROR';
  if (/AUTH|CREDENTIAL|PERMISSION|FORBIDDEN|UNAUTHORIZED/.test(code)) return 'AUTH_ERROR';
  if (/RATE|THROTTL/.test(code)) return 'RATE_LIMIT_ERROR';
  if (/USAGE|TOKEN_COUNT/.test(code)) return 'USAGE_ERROR';
  if (/NETWORK|UPSTREAM|CONNECT|SOCKET|DNS|HTTP/.test(code)) return 'NETWORK_ERROR';
  if (/RETRIEV|EMBED|RERANK|INDEX/.test(code)) return 'RETRIEVAL_ERROR';
  if (/MODEL|LLM|API|PROVIDER|RESPONSE/.test(code)) return 'MODEL_API_ERROR';
  if (/ABORT|CANCEL/.test(code)) return 'CANCELLED';
  return 'OTHER_ERROR';
}

function summarizeMode(records, dataset, options = {}) {
  const all = records || [];
  const successful = all.filter((record) => record.status === 'success');
  const quality = successful.filter((record) => repetition(record) === 1);
  const usage = accumulateUsage(all.flatMap((record) => record.calls || []));
  const estimatedCostCny = estimateCostCny(usage, options.pricing || DEFAULT_PRICING);
  const latencyFields = [
    'indexBuildMs', 'retrievalMs', 'timeToFirstTokenMs', 'generationMs', 'totalMs',
  ];
  const latency = Object.fromEntries(latencyFields.map((field) => [
    field,
    latencySummary(successful.map((record) => record.timings?.[field])),
  ]));
  const outputSeconds = successful.reduce(
    (total, record) => total + Number(record.timings?.generationMs || 0) / 1_000,
    0,
  );
  const errorCounts = {};
  for (const record of all.filter((entry) => entry.status !== 'success')) {
    const code = anonymousErrorBucket(record.errorCode);
    errorCounts[code] = (errorCounts[code] || 0) + 1;
  }
  const evaluated = successful.filter((record) => record.answerEvaluation);
  const correctAnswers = evaluated.filter((record) => record.answerEvaluation.questionCorrect).length;
  const correctFacts = evaluated.reduce(
    (sum, record) => sum + Number(record.answerEvaluation.matchedGoldFactCount || 0),
    0,
  );
  const modelCalls = all.reduce(
    (sum, record) => sum + (Array.isArray(record.calls)
      ? record.calls.length
      : numericCount(record, 'modelCallCount')),
    0,
  );
  const retryCount = all.reduce((sum, record) => sum + numericCount(record, 'retryCount'), 0);
  const apiErrorCount = all.reduce((sum, record) => sum + numericCount(record, 'apiErrorCount'), 0);
  const toolCalls = all.reduce((sum, record) => (
    sum + numericCount(record, 'toolCallCount', 'toolCalls')
  ), 0);
  const agentTurns = all.reduce((sum, record) => sum + numericCount(record, 'agentTurns'), 0);
  const embeddingRequests = all.reduce((sum, record) => (
    sum + numericCount(record, 'embeddingRequestCount', 'embeddingCalls')
  ), 0);
  const rerankRequests = all.reduce((sum, record) => (
    sum + numericCount(record, 'rerankRequestCount', 'rerankCalls')
  ), 0);
  return {
    runs: all.length,
    qualityRuns: quality.length,
    repeatedPerformanceRuns: all.filter((record) => repetition(record) > 1).length,
    successfulRuns: successful.length,
    successRate: all.length ? round(successful.length / all.length) : null,
    timeoutRate: all.length ? round(all.filter((record) => (
      record.status === 'timeout' || record.errorCode === 'TASK_TIMEOUT'
    )).length / all.length) : null,
    retryCount,
    retryRate: modelCalls ? round(retryCount / modelCalls) : null,
    apiErrorCount,
    apiErrorRate: modelCalls ? round(apiErrorCount / modelCalls) : null,
    errorCounts,
    retrieval: aggregateRetrieval(quality, dataset, options),
    answers: quality.length && quality.every((record) => record.answerEvaluation)
      ? aggregateAnswers(quality, dataset)
      : null,
    usage,
    estimatedCostCny: round(estimatedCostCny),
    tokensPerCorrectAnswer: correctAnswers ? round(usage.totalTokens / correctAnswers, 3) : null,
    costPerCorrectAnswerCny: correctAnswers ? round(estimatedCostCny / correctAnswers) : null,
    tokensPerCorrectFact: correctFacts ? round(usage.totalTokens / correctFacts, 3) : null,
    costPerCorrectFactCny: correctFacts ? round(estimatedCostCny / correctFacts) : null,
    modelCalls,
    agentTurns,
    toolCalls,
    embeddingRequests,
    rerankRequests,
    outputTokensPerSecond: round(outputSeconds ? usage.outputTokens / outputSeconds : null),
    latency,
  };
}

function firstRunMap(records, mode) {
  const output = new Map();
  for (const record of records) {
    if (taskMode(record) !== mode || repetition(record) !== 1 || record.status !== 'success') continue;
    if (output.has(record.questionId)) {
      throw new BenchmarkValidationError('A system contains duplicate first-run records for one question/mode.');
    }
    output.set(record.questionId, record);
  }
  return output;
}

function pairedInterval(leftMap, rightMap, selector, options = {}) {
  const left = [];
  const right = [];
  for (const [questionId, leftRecord] of leftMap) {
    const rightRecord = rightMap.get(questionId);
    if (!rightRecord) continue;
    const leftValue = selector(leftRecord, questionId);
    const rightValue = selector(rightRecord, questionId);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) continue;
    left.push(leftValue);
    right.push(rightValue);
  }
  if (!left.length) return null;
  return {
    pairedQuestions: left.length,
    ...pairedBootstrap(left, right, {
      iterations: options.bootstrapIterations || 10_000,
      seed: options.bootstrapSeed || 20260831,
    }),
  };
}

function pairComparison(left, right, dataset, options = {}) {
  const itemById = new Map(dataset.items.map((item) => [item.id, item]));
  const modes = {};
  for (const mode of ['normal', 'deep']) {
    const leftMap = firstRunMap(left.records, mode);
    const rightMap = firstRunMap(right.records, mode);
    if (![...leftMap.keys()].some((id) => rightMap.has(id))) continue;
    const retrievalF1At12 = (record, id) => retrievalMetrics(
      itemById.get(id),
      record.retrieval?.results || [],
      {
        documentAliases: dataset.documentAliases,
        universeSize: dataset.snapshot.logicalDocumentCount,
        kValues: [12],
      },
    ).byK[12].f1;
    modes[mode] = {
      questionAccuracy: pairedInterval(leftMap, rightMap, (record) => (
        record.answerEvaluation ? Number(record.answerEvaluation.questionCorrect) : null
      ), options),
      factF1: pairedInterval(leftMap, rightMap, factF1ForRecord, options),
      hallucinationRate: pairedInterval(leftMap, rightMap, (record) => {
        if (!record.answerEvaluation) return null;
        const predicted = Number(record.answerEvaluation.predictedFactCount || 0);
        return predicted ? Number(record.answerEvaluation.hallucinatedFactCount || 0) / predicted : 0;
      }, options),
      retrievalF1At12: pairedInterval(leftMap, rightMap, retrievalF1At12, options),
      estimatedCostCny: pairedInterval(
        leftMap,
        rightMap,
        (record) => recordCost(record, options.pricing || DEFAULT_PRICING),
        options,
      ),
      totalMs: pairedInterval(
        leftMap,
        rightMap,
        (record) => Number(record.timings?.totalMs),
        options,
      ),
    };
  }
  return modes;
}

export function summarizeOfflineResults(value, dataset, options = {}) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.systems) || !value.systems.length) {
    throw new BenchmarkValidationError('Offline results need schemaVersion=1 and systems[].');
  }
  if (String(value.snapshotManifestSha256 || '') !== dataset.snapshot.manifestSha256) {
    throw new BenchmarkValidationError('Offline results snapshot hash differs from dataset.');
  }
  assertFairModelConfiguration(value.configuration);
  const ids = new Set();
  const systems = value.systems.map((system, systemIndex) => {
    const privateId = sanitizeSystemId(system.id);
    if (ids.has(privateId)) throw new BenchmarkValidationError('Offline results contain duplicate system ids.');
    ids.add(privateId);
    if (!Array.isArray(system.records) || !system.records.length) {
      throw new BenchmarkValidationError('Every system needs non-empty records[].');
    }
    for (const record of system.records) {
      taskMode(record);
      repetition(record);
    }
    const recordsByMode = Object.groupBy
      ? Object.groupBy(system.records, taskMode)
      : system.records.reduce((groups, record) => {
        const mode = taskMode(record);
        groups[mode] ||= [];
        groups[mode].push(record);
        return groups;
      }, {});
    const modeSummaries = Object.fromEntries(
      Object.entries(recordsByMode).map(([mode, records]) => [
        mode,
        summarizeMode(records, dataset, options),
      ]),
    );
    const usage = accumulateUsage(system.records.flatMap((record) => record.calls || []));
    const estimatedCostCny = estimateCostCny(usage, options.pricing || DEFAULT_PRICING);
    const successful = system.records.filter((record) => record.status === 'success');
    const summary = {
      anonymousSystem: `System-${String.fromCharCode(65 + systemIndex)}`,
      runs: system.records.length,
      successfulRuns: successful.length,
      successRate: round(successful.length / system.records.length),
      timeoutRate: round(system.records.filter((record) => record.status === 'timeout').length /
        system.records.length),
      retryCount: system.records.reduce((sum, record) => sum + numericCount(record, 'retryCount'), 0),
      usage,
      estimatedCostCny: round(estimatedCostCny),
      modes: modeSummaries,
    };
    return { privateId, summary, records: system.records };
  });
  const comparisons = [];
  for (let leftIndex = 0; leftIndex < systems.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < systems.length; rightIndex += 1) {
      const left = systems[leftIndex];
      const right = systems[rightIndex];
      comparisons.push({
        systems: [left.summary.anonymousSystem, right.summary.anonymousSystem],
        difference: 'first system minus second system',
        pairedBootstrap95: pairComparison(left, right, dataset, options),
      });
    }
  }
  return {
    private: {
      systemMapping: Object.fromEntries(systems.map((entry) => [
        entry.summary.anonymousSystem,
        entry.privateId,
      ])),
    },
    anonymous: {
      schemaVersion: 1,
      generatedAt: options.generatedAt || new Date().toISOString(),
      benchmark: {
        datasetQuestions: dataset.items.length,
        snapshotManifestSha256: dataset.snapshot.manifestSha256,
        kValues: options.kValues || DEFAULT_K_VALUES,
        pricingCnyPerMillionTokens: options.pricing || DEFAULT_PRICING,
        budget: options.budget || DEFAULT_BUDGET,
        modelConfiguration: FAIR_MODEL_CONFIGURATION,
        caveats: ANONYMOUS_REPORT_CAVEATS,
      },
      systems: systems.map((entry) => entry.summary),
      comparisons,
    },
  };
}

const NORMALIZED_FORBIDDEN_REPORT_KEYS = new Set([
  'query', 'prompt', 'question', 'questiontext', 'goldanswer', 'referenceanswer', 'answer',
  'finalanswer', 'goldfacts', 'atomicfacts', 'facts', 'relevant', 'relevance', 'path',
  'filepath', 'filename', 'absolutepath', 'snapshotroot', 'vaultpath', 'content', 'text',
  'snippet', 'chunk', 'excerpt', 'rawoutput', 'rawresponse', 'responsetext', 'modeloutput',
  'completion', 'messages', 'priormessages', 'conversation', 'history', 'systemmapping',
  'systemid', 'toolresult', 'toolresults', 'results', 'citations', 'evidence', 'url', 'uri',
  'link',
]);

const ANONYMOUS_REPORT_ALLOWED_KEYS = new Set(`
  schemaVersion generatedAt benchmark systems comparisons datasetQuestions snapshotManifestSha256
  kValues pricingCnyPerMillionTokens budget modelConfiguration caveats budgetStatus inputPerMillion
  outputPerMillion cacheReadPerMillion cacheCreationPerMillion hardLimitCny startLimitCny actualCny
  reservedCny remainingHardLimitCny mayStartZeroCostRequest model temperature maxOutputTokens
  anthropic max_tokens output_config effort openaiChat reasoning_effort webSearch
  freshSessionPerQuestion anonymousSystem runs successfulRuns successRate timeoutRate retryCount usage
  estimatedCostCny modes normal deep requests standardInputTokens cacheReadInputTokens
  cacheCreationInputTokens outputTokens totalInputTokens totalTokens qualityRuns
  repeatedPerformanceRuns retryRate apiErrorCount apiErrorRate errorCounts retrieval answers
  tokensPerCorrectAnswer costPerCorrectAnswerCny tokensPerCorrectFact costPerCorrectFactCny modelCalls
  agentTurns toolCalls embeddingRequests rerankRequests outputTokensPerSecond latency indexBuildMs
  retrievalMs timeToFirstTokenMs generationMs totalMs count mean p50 p95 min max questions
  answerableQuestions byK meanReciprocalRank meanAveragePrecision meanNdcg exactLineHitRate
  evidenceSegmentRecall duplicateLogicalOccupancyRate unanswerableFalseRetrievalRate perQuestion
  questionId metrics accuracy precision recall f1 truePositive falsePositive falseNegative trueNegative
  reciprocalRank averagePrecision ndcg exactLineHit falseRetrievalForUnanswerable
  returnedLogicalDocuments evaluatedQuestions questionAccuracy factPrecision factRecall factF1
  answerCompleteness citationPrecision citationRecall invalidCitationRate hallucinationRate
  contradictionRate unanswerableCorrectRefusalRate difference pairedBootstrap95 pairedQuestions
  meanDifference lower95 upper95 iterations seed retrievalF1At12
`.trim().split(/\s+/));
for (const key of ANONYMOUS_ERROR_BUCKETS) ANONYMOUS_REPORT_ALLOWED_KEYS.add(key);

const SAFE_ANONYMOUS_REPORT_STRINGS = new Set([
  FAIR_MODEL_CONFIGURATION.model,
  FAIR_MODEL_CONFIGURATION.anthropic.output_config.effort,
  'first system minus second system',
  ...ANONYMOUS_REPORT_CAVEATS,
]);

const PRIVATE_REPORT_STRING_PATTERNS = Object.freeze([
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\r\n]/u,
  /(?:^|[\s"'`(])\/(?:home|mnt|media|root|tmp|var|srv|opt|Users)(?:\/|$)/iu,
  /(?:^|[\s"'`(])[A-Za-z]:[\\/]/u,
  /(?:^|[\s"'`(])\\\\[^\\\s]+\\/u,
  /\b(?:file|obsidian):\/\//iu,
  /!?\[\[[^\]]+\]\]/u,
  /\]\((?:file:|obsidian:|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])[^)]*\)/iu,
  /(?:问题|提问|标准答案|原始输出)\s*[:：]/u,
  /(?:query|gold[_-]?answer|reference[_-]?answer|raw[_-]?output|response[_-]?text)\s*[:=]/iu,
]);

function normalizedReportKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function rejectPrivateReportData() {
  throw new BenchmarkValidationError(
    'Anonymous report contains a field or string outside the aggregate-only schema.',
    'PRIVATE_DATA_IN_REPORT',
  );
}

function assertAnonymousString(value, field) {
  if (
    value.length > 512 ||
    PRIVATE_REPORT_STRING_PATTERNS.some((pattern) => pattern.test(value)) ||
    SECRET_PATTERNS.some(({ regex }) => regex.test(value))
  ) rejectPrivateReportData();
  if (field === 'generatedAt' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
  if (field === 'snapshotManifestSha256' && SHA256_PATTERN.test(value)) return;
  if ((field === 'anonymousSystem' || field === 'systems') && /^System-[A-Z]$/.test(value)) return;
  if (field === 'questionId' && /^Question-\d{3,6}$/.test(value)) return;
  if (field === 'caveats' && ANONYMOUS_REPORT_CAVEATS.includes(value)) return;
  if (SAFE_ANONYMOUS_REPORT_STRINGS.has(value)) return;
  rejectPrivateReportData();
}

export function assertAnonymousReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) rejectPrivateReportData();
  const walk = (entry, field = '') => {
    if (typeof entry === 'string') {
      assertAnonymousString(entry, field);
      return;
    }
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) rejectPrivateReportData();
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) walk(child, field);
      return;
    }
    if (!entry || typeof entry !== 'object') rejectPrivateReportData();
    for (const [key, child] of Object.entries(entry)) {
      const normalized = normalizedReportKey(key);
      if (
        NORMALIZED_FORBIDDEN_REPORT_KEYS.has(normalized) ||
        (!ANONYMOUS_REPORT_ALLOWED_KEYS.has(key) && !/^[1-9]\d{0,3}$/.test(key))
      ) rejectPrivateReportData();
      walk(child, key);
    }
  };
  walk(value);
  return value;
}

export function seededRandom(seed = 20260831) {
  let state = Number(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

export function pairedBootstrap(left, right, options = {}) {
  if (!Array.isArray(left) || left.length !== right?.length || !left.length) {
    throw new BenchmarkValidationError('Paired bootstrap inputs need equal non-zero lengths.');
  }
  const iterations = Math.max(100, Number(options.iterations) || 10_000);
  const random = seededRandom(options.seed);
  const differences = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < left.length; index += 1) {
      const picked = Math.floor(random() * left.length);
      total += Number(left[picked]) - Number(right[picked]);
    }
    differences.push(total / left.length);
  }
  return {
    meanDifference: round(mean(left.map((value, index) => Number(value) - Number(right[index])))),
    lower95: round(quantile(differences, 0.025)),
    upper95: round(quantile(differences, 0.975)),
    iterations,
    seed: Number(options.seed ?? 20260831),
  };
}

export async function writePrivateJson(filename, value) {
  const target = path.resolve(filename);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.dirname(target), 0o700).catch(() => {});
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await fsp.rename(temporary, target);
    await fsp.chmod(target, 0o600);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
