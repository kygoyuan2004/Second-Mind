import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { logicalDocumentKey } from '../../src/knowledge-index.mjs';

export const COMPLETENESS_REPORT_SCHEMA_VERSION = 1;
export const COMPLETENESS_QUERY_VECTOR_SCHEMA_VERSION = 1;
export const DEFAULT_COMPLETENESS_K_VALUES = Object.freeze([1, 3, 5, 8, 12, 18, 24, 30]);

const SAFE_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9-]+$/u;

export class CompletenessEvalError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CompletenessEvalError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CompletenessEvalError(code, message);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedQuestion(value) {
  return String(value || '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function safeRelativeMarkdownPath(value) {
  const input = String(value || '')
    .normalize('NFC')
    .replace(/^`|`$/gu, '')
    .replaceAll('\\', '/')
    .trim();
  if (
    !input || input.includes('\0') || path.posix.isAbsolute(input) ||
    !input.toLocaleLowerCase().endsWith('.md')
  ) return '';
  const parts = input.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return '';
  return parts.join('/');
}

function markdownCells(line) {
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const character of String(line || '')) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === '\\') {
      cell += character;
      escaped = true;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells.filter(Boolean);
}

function parseCleanQuestions(text) {
  const questions = new Map();
  for (const line of String(text || '').split(/\r?\n/u)) {
    const match = /^\*\*(\d+)\.\*\*\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const number = Number(match[1]);
    const question = normalizedQuestion(match[2]);
    if (!Number.isSafeInteger(number) || number < 1 || !question || questions.has(number)) {
      fail('INVALID_CLEAN_QUESTION_SET', 'The clean question set is malformed.');
    }
    questions.set(number, question);
  }
  return questions;
}

function detailedSections(text) {
  const source = String(text || '').replace(/\r\n?/gu, '\n');
  const headings = [...source.matchAll(/^###\s*题目\s*(\d+)\s*[：:]\s*(.+?)\s*$/gmu)];
  return headings.map((match, index) => ({
    number: Number(match[1]),
    question: normalizedQuestion(match[2]),
    body: source.slice(match.index + match[0].length, headings[index + 1]?.index ?? source.length),
  }));
}

function parseDetailedQuestion(section) {
  const sourceMarker = /\*\*应命中来源（共\s*(\d+)\s*篇）\*\*[：:]?/u.exec(section.body);
  const answerMarker = /\*\*参考答案要点\*\*[：:]?/u.exec(section.body);
  const scoreMarker = /\*\*评分标准\*\*[：:]?/u.exec(section.body);
  if (!sourceMarker || !answerMarker || !scoreMarker || answerMarker.index <= sourceMarker.index) {
    fail('INVALID_GOLD_QUESTION_SET', 'A detailed question is missing a required rubric section.');
  }
  const sourceRegion = section.body.slice(
    sourceMarker.index + sourceMarker[0].length,
    answerMarker.index,
  );
  const paths = [];
  for (const line of sourceRegion.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const relative = markdownCells(line)
      .map(safeRelativeMarkdownPath)
      .find(Boolean);
    if (relative) paths.push(relative);
  }
  const declared = Number(sourceMarker[1]);
  if (!paths.length || paths.length !== declared || new Set(paths).size !== paths.length) {
    fail('GOLD_SOURCE_COUNT_MISMATCH', 'A gold source table does not match its declared size.');
  }
  return {
    number: section.number,
    question: section.question,
    physicalGoldPaths: paths,
    logicalGoldIds: [...new Set(paths.map((relative) => logicalDocumentKey(relative)))],
  };
}

export function parseCompletenessDataset(cleanText, goldText, options = {}) {
  const expectedCount = Number(options.expectedCount ?? 30);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    throw new TypeError('expectedCount must be a positive integer.');
  }
  const clean = parseCleanQuestions(cleanText);
  const sections = detailedSections(goldText);
  if (clean.size !== expectedCount || sections.length !== expectedCount) {
    fail('QUESTION_COUNT_MISMATCH', 'The clean and detailed files must contain the expected question count.');
  }
  const seen = new Set();
  const questions = sections.map(parseDetailedQuestion).sort((left, right) => left.number - right.number);
  for (let index = 0; index < questions.length; index += 1) {
    const item = questions[index];
    if (item.number !== index + 1 || seen.has(item.number)) {
      fail('QUESTION_NUMBER_MISMATCH', 'Question numbers must be unique and contiguous.');
    }
    seen.add(item.number);
    if (clean.get(item.number) !== item.question) {
      fail('QUESTION_TEXT_MISMATCH', 'The clean question and detailed question differ.');
    }
  }
  return questions;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function assertOwnerPrivateFile(filename, code = 'PRIVATE_INPUT_REQUIRED') {
  let stat;
  try {
    stat = await fsp.lstat(filename);
  } catch {
    fail(code, 'A required private input is unavailable.');
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
    (currentUid !== null && stat.uid !== currentUid) || (stat.mode & 0o077) !== 0
  ) fail(code, 'Private inputs must be owner-only regular files.');
  return stat;
}

export async function validateGoldFiles(dataset, vaultRoot) {
  const realRoot = await fsp.realpath(vaultRoot).catch(() => fail(
    'VAULT_UNAVAILABLE',
    'The evaluation Vault is unavailable.',
  ));
  const unique = new Set(dataset.flatMap((item) => item.physicalGoldPaths));
  for (const relative of unique) {
    const target = path.resolve(realRoot, ...relative.split('/'));
    if (!isWithin(realRoot, target)) fail('GOLD_PATH_ESCAPE', 'A gold source escapes the Vault.');
    let realTarget;
    try {
      realTarget = await fsp.realpath(target);
    } catch {
      fail('GOLD_SOURCE_UNAVAILABLE', 'A gold source is unavailable in the evaluation Vault.');
    }
    if (!isWithin(realRoot, realTarget)) fail('GOLD_PATH_ESCAPE', 'A gold source escapes the Vault.');
    const stat = await fsp.stat(realTarget);
    if (!stat.isFile()) fail('GOLD_SOURCE_UNAVAILABLE', 'A gold source is not a regular file.');
  }
  return { uniquePhysicalGoldFiles: unique.size };
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function discount(rank) {
  return 1 / Math.log2(rank + 1);
}

export function logicalRetrievalMetrics(goldLogicalIds, results, kValues = DEFAULT_COMPLETENESS_K_VALUES) {
  const gold = new Set(goldLogicalIds || []);
  const seen = new Set();
  const ranked = [];
  for (const result of Array.isArray(results) ? results : []) {
    const relative = String(result?.path || '');
    if (!relative) continue;
    const logicalId = String(result.logicalKey || result.logicalId || logicalDocumentKey(relative));
    if (seen.has(logicalId)) continue;
    seen.add(logicalId);
    ranked.push(logicalId);
  }
  const normalizedK = [...new Set(kValues.map(Number))]
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => left - right);
  if (!normalizedK.length || !gold.size) throw new TypeError('Metrics require K values and gold sources.');
  const byK = {};
  for (const k of normalizedK) {
    const top = ranked.slice(0, k);
    const hitCount = top.filter((logicalId) => gold.has(logicalId)).length;
    const dcg = top.reduce((sum, logicalId, index) => (
      sum + (gold.has(logicalId) ? discount(index + 1) : 0)
    ), 0);
    const idealCount = Math.min(k, gold.size);
    let idealDcg = 0;
    for (let index = 0; index < idealCount; index += 1) idealDcg += discount(index + 1);
    byK[String(k)] = {
      goldCoverage: round(hitCount / gold.size),
      ndcg: round(idealDcg ? dcg / idealDcg : 0),
    };
  }
  const firstRelevant = ranked.findIndex((logicalId) => gold.has(logicalId));
  return {
    goldLogicalCount: gold.size,
    returnedLogicalCount: Math.min(ranked.length, Math.max(...normalizedK)),
    byK,
    mrr: round(firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1)),
  };
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function aggregateRecords(records, kValues) {
  const measured = records.filter((record) => record.status === 'measured');
  const byK = {};
  for (const k of kValues) {
    const key = String(k);
    byK[key] = {
      goldCoverage: round(average(measured.map((record) => record.byK[key]?.goldCoverage))),
      ndcg: round(average(measured.map((record) => record.byK[key]?.ndcg))),
    };
  }
  const latencies = measured.map((record) => record.latencyMs);
  return {
    measuredQuestions: measured.length,
    byK,
    mrr: round(average(measured.map((record) => record.mrr))),
    latencyMs: {
      mean: round(average(latencies), 3),
      p50: round(quantile(latencies, 0.5), 3),
      p95: round(quantile(latencies, 0.95), 3),
    },
  };
}

export async function evaluateCompleteness(dataset, options = {}) {
  if (typeof options.search !== 'function') throw new TypeError('evaluateCompleteness requires search().');
  const route = String(options.route || 'hybrid');
  if (!['keyword', 'hybrid'].includes(route)) throw new TypeError('route must be keyword or hybrid.');
  const kValues = [...new Set(options.kValues || DEFAULT_COMPLETENESS_K_VALUES)]
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 30)
    .sort((left, right) => left - right);
  if (!kValues.length) throw new TypeError('At least one valid K value is required.');
  const limit = Math.max(...kValues);
  const records = [];
  for (const item of dataset) {
    const startedAt = performance.now();
    const response = await options.search(item.question, { route, limit });
    const elapsed = performance.now() - startedAt;
    if (
      route === 'hybrid' &&
      (response?.route !== 'hybrid' || response?.diagnostics?.embeddingUsed !== true)
    ) {
      fail('QUERY_VECTORS_REQUIRED_OFFLINE', 'Hybrid retrieval did not use a query vector.');
    }
    const metrics = logicalRetrievalMetrics(item.logicalGoldIds, response?.results, kValues);
    records.push({
      questionNumber: item.number,
      status: 'measured',
      ...metrics,
      latencyMs: round(elapsed, 3),
    });
  }
  return {
    records,
    aggregate: aggregateRecords(records, kValues),
    kValues,
  };
}

function validEmbeddingSignature(value) {
  return Boolean(
    value && typeof value === 'object' && typeof value.enabled === 'boolean' &&
    typeof value.provider === 'string' && value.provider &&
    (value.enabled === false || (
      typeof value.model === 'string' && value.model &&
      Number.isSafeInteger(Number(value.dimensions)) && Number(value.dimensions) > 0
    )),
  );
}

async function readJsonFile(filename, code) {
  await assertOwnerPrivateFile(filename, code);
  try {
    return JSON.parse(await fsp.readFile(filename, 'utf8'));
  } catch {
    fail(code, 'A private JSON input is invalid.');
  }
}

export async function readPersistedIndexSignature(indexRoot) {
  const root = await fsp.realpath(indexRoot).catch(() => fail(
    'INDEX_UNAVAILABLE',
    'The persisted index is unavailable.',
  ));
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = await readJsonFile(manifestFile, 'INDEX_MANIFEST_INVALID');
  if (manifest?.version !== 1 || !SAFE_GENERATION.test(String(manifest.current || ''))) {
    fail('INDEX_MANIFEST_INVALID', 'The persisted index manifest is invalid.');
  }
  const generationFile = path.join(root, 'generations', `${manifest.current}.json`);
  const generation = await readJsonFile(generationFile, 'INDEX_GENERATION_INVALID');
  if (
    generation?.version !== 1 || generation?.generation !== manifest.current ||
    !validEmbeddingSignature(generation.embedding)
  ) fail('INDEX_GENERATION_INVALID', 'The persisted index generation is invalid.');
  return {
    root,
    signature: {
      enabled: Boolean(generation.embedding.enabled),
      provider: String(generation.embedding.provider),
      model: generation.embedding.enabled ? String(generation.embedding.model) : null,
      dimensions: generation.embedding.enabled ? Number(generation.embedding.dimensions) : null,
    },
  };
}

export async function loadPrivateQueryVectors(filename, dataset, expectedSignature) {
  const value = await readJsonFile(filename, 'QUERY_VECTOR_FILE_INVALID');
  if (
    value?.schemaVersion !== COMPLETENESS_QUERY_VECTOR_SCHEMA_VERSION ||
    value?.kind !== 'vaultmind-completeness-query-vectors' ||
    !validEmbeddingSignature({ ...value.embedding, enabled: true }) ||
    value.embedding.provider !== expectedSignature.provider ||
    value.embedding.model !== expectedSignature.model ||
    Number(value.embedding.dimensions) !== Number(expectedSignature.dimensions) ||
    !Array.isArray(value.vectors)
  ) fail('QUERY_VECTOR_SIGNATURE_MISMATCH', 'The query-vector cache does not match the index.');
  const byHash = new Map();
  for (const entry of value.vectors) {
    const digest = String(entry?.querySha256 || '').toLowerCase();
    const vector = Array.isArray(entry?.vector) ? entry.vector.map(Number) : null;
    if (
      !SAFE_SHA256.test(digest) || byHash.has(digest) || !vector ||
      vector.length !== expectedSignature.dimensions || vector.some((number) => !Number.isFinite(number))
    ) fail('QUERY_VECTOR_FILE_INVALID', 'The query-vector cache contains an invalid vector.');
    byHash.set(digest, vector);
  }
  for (const item of dataset) {
    if (!byHash.has(sha256(item.question))) {
      fail('QUERY_VECTORS_REQUIRED_OFFLINE', 'The private cache does not cover every evaluation query.');
    }
  }
  return byHash;
}

export function createOfflineEmbeddingClient(signature, queryVectors = new Map()) {
  return {
    enabled: Boolean(signature.enabled),
    provider: signature.provider,
    model: signature.model,
    dimensions: signature.dimensions,
    apiKey: '',
    async embed(texts, options = {}) {
      if (options.textType !== 'query' || !Array.isArray(texts) || texts.length !== 1) {
        fail('OFFLINE_EMBEDDING_FORBIDDEN', 'The offline evaluator cannot embed Vault text.');
      }
      const vector = queryVectors.get(sha256(String(texts[0] || '').trim()));
      if (!vector) fail('QUERY_VECTORS_REQUIRED_OFFLINE', 'No offline query vector is available.');
      return [[...vector]];
    },
  };
}

export function blockedCompletenessReport(options = {}) {
  const dataset = Array.isArray(options.dataset) ? options.dataset : null;
  const questionCount = dataset?.length ?? Number(options.questionCount || 0);
  const reasonCode = String(options.reasonCode || 'OFFLINE_EVALUATION_BLOCKED');
  return {
    schemaVersion: COMPLETENESS_REPORT_SCHEMA_VERSION,
    kind: 'vaultmind-completeness-retrieval-report',
    route: String(options.route || 'hybrid'),
    migration: {
      status: 'blocked',
      reasonCode,
      semanticUsed: false,
    },
    original: {
      status: 'blocked',
      reasonCode: 'ORIGINAL_OFFLINE_ADAPTER_NOT_CONFIGURED',
    },
    comparability: {
      comparable: false,
      reasonCodes: [...new Set([
        reasonCode,
        'ORIGINAL_OFFLINE_ADAPTER_NOT_CONFIGURED',
        'CORPUS_MANIFEST_NOT_PINNED',
      ])],
    },
    records: Array.from({ length: questionCount }, (_, index) => ({
      questionNumber: dataset?.[index]?.number ?? index + 1,
      status: 'blocked',
      goldLogicalCount: dataset?.[index]?.logicalGoldIds?.length ?? null,
      returnedLogicalCount: null,
      byK: null,
      mrr: null,
      latencyMs: null,
    })),
    aggregate: null,
  };
}

export function measuredCompletenessReport(evaluation, options = {}) {
  const route = String(options.route || 'keyword');
  const reasonCodes = ['ORIGINAL_OFFLINE_ADAPTER_NOT_CONFIGURED', 'CORPUS_MANIFEST_NOT_PINNED'];
  if (route !== 'hybrid') reasonCodes.push('MIGRATION_ROUTE_NOT_HYBRID');
  return {
    schemaVersion: COMPLETENESS_REPORT_SCHEMA_VERSION,
    kind: 'vaultmind-completeness-retrieval-report',
    route,
    migration: {
      status: 'measured',
      semanticUsed: route === 'hybrid',
    },
    original: {
      status: 'blocked',
      reasonCode: 'ORIGINAL_OFFLINE_ADAPTER_NOT_CONFIGURED',
    },
    comparability: {
      comparable: false,
      reasonCodes,
    },
    records: evaluation.records,
    aggregate: evaluation.aggregate,
  };
}

export function assertRedactedCompletenessReport(value) {
  const serialized = JSON.stringify(value);
  const forbiddenKeys = [
    'question', 'query', 'answer', 'path', 'source', 'snippet', 'content', 'title',
    'apiKey', 'model', 'provider', 'generation', 'identifier',
  ];
  for (const key of forbiddenKeys) {
    if (new RegExp(`"${key}"\\s*:`, 'iu').test(serialized)) {
      fail('REPORT_PRIVACY_VIOLATION', 'The report contains a forbidden private field.');
    }
  }
  if (/(?:daily_doc|learning_doc|guidance_doc|experience_doc)[\\/]/iu.test(serialized)) {
    fail('REPORT_PRIVACY_VIOLATION', 'The report contains a private path identifier.');
  }
  return true;
}

export async function writePrivateReport(filename, report, projectRoot) {
  assertRedactedCompletenessReport(report);
  const output = path.resolve(filename);
  const privateRoot = path.resolve(projectRoot, '.local');
  if (!isWithin(privateRoot, output) || output === privateRoot) {
    fail('PRIVATE_OUTPUT_REQUIRED', 'Reports must be written below the project .local directory.');
  }
  const directory = path.dirname(output);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700);
  try {
    const current = await fsp.lstat(output);
    const uid = typeof process.getuid === 'function' ? process.getuid() : current.uid;
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== uid) {
      fail('PRIVATE_OUTPUT_REQUIRED', 'An existing report target is unsafe.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await fsp.rename(temporary, output);
    await fsp.chmod(output, 0o600);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return output;
}
