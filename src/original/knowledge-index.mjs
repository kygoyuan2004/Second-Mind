import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BailianRetrievalClient } from './bailian-retrieval.mjs';

const INDEX_VERSION = 1;
const INDEX_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.canvas', '.base', '.csv', '.yaml', '.yml',
]);
const MIME_TYPES = new Map([
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.canvas', 'application/json; charset=utf-8'],
  ['.base', 'application/json; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.yaml', 'text/plain; charset=utf-8'],
  ['.yml', 'text/plain; charset=utf-8'],
]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TARGET_CHUNK_CHARACTERS = 1_500;
const CHUNK_OVERLAP_CHARACTERS = 180;
const QUERY_VECTOR_CACHE_LIMIT = 500;
const QUERY_VECTOR_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
const RANKING_CACHE_TTL_MS = 24 * 60 * 60_000;
const WATCH_DEBOUNCE_MS = 10_000;
const RECONCILE_INTERVAL_MS = 10 * 60_000;
const RRF_K = 60;
const QUERY_CONTEXT_LIMIT = 500;
const QUERY_INDEFINITE_PATTERN = /(?:它|这个|这些|上面|上述|前者|后者|那个|其中|刚才)/;
const EXHAUSTIVE_PATTERN = /(?:全部|所有|列出|穷举|一个不漏|出现在哪|出现于哪|哪些文件)/i;
const ROUTE_EXACT_PATTERN = new RegExp([
  String.raw`\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?`,
  String.raw`(?:^|\s|[“”"'「」【】])[^\s"'“”「」【】]*[/\\][^\s"'“”「」【】]+`,
  String.raw`\.[a-z0-9]{1,10}(?:\b|$)`,
  String.raw`[“”"'「」【】][^\n“”"'「」【】]+[“”"'「」【】]`,
  String.raw`\x60[^\n\x60]+\x60`,
  String.raw`\b(?:[A-Za-z_$][\w$]*_[\w$]+|[A-Za-z_$]+[A-Z][\w$]*|[A-Za-z_$][\w$]*\([^)]*\)|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\b`,
  String.raw`(?:全部|所有|列出|穷举|出现在哪|出现于哪|哪些文件)`,
].join('|'), 'iu');
const SEARCH_COMMAND_PATTERN = /(?:请|帮我|查找|搜索|检索|列出|穷举|全部|所有|包含|提到|出现在哪(?:些)?|出现于哪(?:些)?|哪些文件|文件中|的文件)/g;
const STOP_TERMS = new Set([
  '请', '帮我', '查找', '搜索', '检索', '列出', '穷举', '全部', '所有',
  '包含', '提到', '出现', '哪些', '文件', '内容', '关于', '什么', '怎么',
  'the', 'and', 'for', 'with', 'from', 'that', 'this',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeText(value) {
  return normalizeDates(String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN'));
}

export function normalizeDates(value) {
  return String(value || '').replace(
    /(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/g,
    (_, year, month, day) => (
      `${year}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`
    ),
  );
}

function shouldSkip(relative, entryName = '') {
  const parts = relative.split('/');
  if (parts.includes('.obsidian')) return true;
  const name = entryName || parts.at(-1) || '';
  return (
    name.startsWith('.') ||
    name.startsWith('~') ||
    name.endsWith('~') ||
    /(?:\.tmp|\.temp|\.swp|\.part|\.crdownload)$/i.test(name)
  );
}

function indexedExtension(relative) {
  return INDEX_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

async function walkFiles(root, relative = '', output = { files: [], directories: [] }) {
  const directory = relative ? path.join(root, relative) : root;
  output.directories.push(directory);
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || shouldSkip(child, entry.name)) continue;
    if (entry.isDirectory()) await walkFiles(root, child, output);
    else if (entry.isFile() && indexedExtension(child)) output.files.push(child);
  }
  return output;
}

function headingText(line) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  return match ? { level: match[1].length, text: match[2].trim().slice(0, 240) } : null;
}

function blockKind(line) {
  if (/^\s*```|^\s*~~~/.test(line)) return 'fence';
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/.test(line)) return 'list';
  if (/^\s*\|.*\|\s*$/.test(line)) return 'table';
  return 'paragraph';
}

function markdownBlocks(content) {
  const lines = String(content || '').split(/\r?\n/);
  const headings = [];
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const start = index;
    const heading = headingText(lines[index]);
    if (heading) {
      headings.splice(heading.level - 1);
      headings[heading.level - 1] = heading.text;
      blocks.push({
        text: lines[index],
        startLine: index + 1,
        endLine: index + 1,
        headings: headings.filter(Boolean),
        kind: 'heading',
      });
      index += 1;
      continue;
    }
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    const kind = blockKind(lines[index]);
    if (kind === 'fence') {
      const marker = lines[index].trim().slice(0, 3);
      index += 1;
      while (index < lines.length) {
        const isEnd = lines[index].trim().startsWith(marker);
        index += 1;
        if (isEnd) break;
      }
    } else if (kind === 'list') {
      index += 1;
      while (index < lines.length) {
        const current = lines[index];
        if (!current.trim()) {
          if (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
            index += 1;
            continue;
          }
          break;
        }
        if (headingText(current) || ['fence', 'table'].includes(blockKind(current))) break;
        if (blockKind(current) !== 'list' && !/^\s+/.test(current)) break;
        index += 1;
      }
    } else if (kind === 'table') {
      index += 1;
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) index += 1;
    } else {
      index += 1;
      while (index < lines.length) {
        if (!lines[index].trim() || headingText(lines[index]) || blockKind(lines[index]) !== 'paragraph') break;
        index += 1;
      }
    }
    blocks.push({
      text: lines.slice(start, index).join('\n'),
      startLine: start + 1,
      endLine: Math.max(start + 1, index),
      headings: headings.filter(Boolean),
      kind,
    });
  }
  return blocks;
}

function splitOversizedBlock(block, targetSize) {
  if (block.text.length <= targetSize || ['fence', 'list', 'table'].includes(block.kind)) return [block];
  const parts = [];
  let cursor = 0;
  while (cursor < block.text.length) {
    let end = Math.min(block.text.length, cursor + targetSize);
    if (end < block.text.length) {
      const boundary = Math.max(
        block.text.lastIndexOf('\n', end),
        block.text.lastIndexOf('。', end),
        block.text.lastIndexOf('. ', end),
      );
      if (boundary > cursor + Math.floor(targetSize * 0.55)) end = boundary + 1;
    }
    const before = block.text.slice(0, cursor);
    const partText = block.text.slice(cursor, end);
    const startLine = block.startLine + (before.match(/\n/g)?.length || 0);
    const endLine = startLine + (partText.match(/\n/g)?.length || 0);
    parts.push({ ...block, text: partText, startLine, endLine });
    cursor = end;
  }
  return parts;
}

export function chunkDocument(relative, content, options = {}) {
  const targetSize = Number(options.targetSize) || TARGET_CHUNK_CHARACTERS;
  const overlapSize = Number(options.overlapSize) || CHUNK_OVERLAP_CHARACTERS;
  const fileHash = sha256(Buffer.from(content));
  const blocks = markdownBlocks(content).flatMap((block) => splitOversizedBlock(block, targetSize));
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let hasNewBlock = false;
  const flush = () => {
    if (!current.length || !hasNewBlock) return;
    const text = current.map((block) => block.text).join('\n\n').trim();
    if (!text) return;
    const first = current[0];
    const last = current.at(-1);
    const headings = [...(first.headings || [])];
    const chunkHash = sha256(Buffer.from(text));
    chunks.push({
      id: sha256(`${relative}\0${first.startLine}\0${last.endLine}\0${chunkHash}`),
      path: relative,
      name: path.basename(relative),
      heading: headings.at(-1) || '',
      headings,
      startLine: first.startLine,
      endLine: last.endLine,
      fileHash,
      chunkHash,
      content: text,
      vector: null,
    });
    const overlap = [];
    let overlapLength = 0;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const block = current[index];
      if (block.kind === 'heading' && overlap.length) continue;
      if (overlapLength + block.text.length > overlapSize) break;
      overlap.unshift(block);
      overlapLength += block.text.length + 2;
    }
    current = overlap;
    currentLength = overlapLength;
    hasNewBlock = false;
  };
  for (const block of blocks) {
    const addition = block.text.length + (current.length ? 2 : 0);
    if (current.length && currentLength + addition > targetSize) flush();
    current.push(block);
    currentLength += addition;
    hasNewBlock = true;
    if (currentLength >= targetSize) flush();
  }
  flush();
  return chunks;
}

function cjkBigrams(value) {
  const output = [];
  for (const match of value.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const text = match[0];
    if (text.length === 2) output.push(text);
    else for (let index = 0; index < text.length - 1; index += 1) output.push(text.slice(index, index + 2));
  }
  return output;
}

export function tokenize(value) {
  const normalized = normalizeText(value);
  const tokens = [];
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const segment of segmenter.segment(normalized)) {
      const token = segment.segment.trim();
      if (segment.isWordLike && token && !STOP_TERMS.has(token)) tokens.push(token);
    }
  } catch {
    tokens.push(...normalized.split(/[^\p{L}\p{N}_$+.-]+/u).filter(Boolean));
  }
  tokens.push(...cjkBigrams(normalized));
  for (const identifier of normalized.match(/[a-z_$][a-z0-9_$.-]*/g) || []) {
    tokens.push(identifier);
    tokens.push(...identifier.split(/[._$-]+/).filter((token) => token.length > 1));
  }
  return tokens.filter((token) => token.length > 1 && !STOP_TERMS.has(token));
}

function termFrequencies(tokens) {
  const frequencies = new Map();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  return frequencies;
}

export function bm25Search(query, chunks, limit = 30) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length || !chunks.length) return [];
  const documents = chunks.map((chunk) => {
    const contentTokens = tokenize(chunk.content);
    return { chunk, contentTokens, frequencies: termFrequencies(contentTokens) };
  });
  const averageLength = documents.reduce((sum, item) => sum + item.contentTokens.length, 0) /
    Math.max(1, documents.length);
  const documentFrequencies = new Map(queryTerms.map((term) => [term, 0]));
  for (const document of documents) {
    for (const term of queryTerms) {
      if (document.frequencies.has(term)) {
        documentFrequencies.set(term, documentFrequencies.get(term) + 1);
      }
    }
  }
  const k1 = 1.5;
  const b = 0.75;
  const results = [];
  for (const document of documents) {
    let score = 0;
    for (const term of queryTerms) {
      const tf = document.frequencies.get(term) || 0;
      const df = documentFrequencies.get(term) || 0;
      if (!tf || !df) continue;
      const idf = Math.log(1 + ((documents.length - df + 0.5) / (df + 0.5)));
      const denominator = tf + k1 * (1 - b + b * (document.contentTokens.length / Math.max(1, averageLength)));
      score += idf * ((tf * (k1 + 1)) / denominator);
      const normalizedPath = normalizeText(document.chunk.path);
      const normalizedHeading = normalizeText(document.chunk.headings?.join(' ') || document.chunk.heading);
      if (normalizedHeading.includes(term)) score += idf * 1.8;
      if (normalizedPath.includes(term)) score += idf * 2.5;
    }
    if (score > 0) results.push({ ...document.chunk, bm25Score: score });
  }
  return results.sort((left, right) => (
    right.bm25Score - left.bm25Score ||
    left.path.localeCompare(right.path, 'zh-CN') ||
    left.startLine - right.startLine
  )).slice(0, limit);
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return -Infinity;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return -Infinity;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return -Infinity;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function vectorSearch(queryVector, chunks, limit) {
  return chunks.map((chunk) => ({
    ...chunk,
    vectorScore: cosineSimilarity(queryVector, chunk.vector),
  })).filter((chunk) => Number.isFinite(chunk.vectorScore)).sort((left, right) => (
    right.vectorScore - left.vectorScore || left.path.localeCompare(right.path, 'zh-CN')
  )).slice(0, limit);
}

export function logicalDocumentKey(relative) {
  const extension = path.extname(relative);
  const stem = path.basename(relative, extension).replace(/(?:_整理版|-整理版|（整理版）)$/u, '');
  const directory = path.dirname(relative);
  return `${directory === '.' ? '' : `${directory}/`}${stem}${extension}`.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function isOrganized(relative) {
  return /(?:_整理版|-整理版|（整理版）)(?=\.[^.]+$)/u.test(relative);
}

function reciprocalRankFusion(bm25, vector) {
  const merged = new Map();
  const add = (items, source) => items.forEach((item, index) => {
    const key = item.id;
    const current = merged.get(key) || { ...item, rrfScore: 0, ranks: {} };
    current.rrfScore += 1 / (RRF_K + index + 1);
    current.ranks[source] = index + 1;
    merged.set(key, current);
  });
  add(bm25, 'bm25');
  add(vector, 'vector');
  return [...merged.values()].sort((left, right) => (
    right.rrfScore - left.rrfScore || left.path.localeCompare(right.path, 'zh-CN')
  ));
}

function associatedPaths(paths) {
  const byLogical = new Map();
  for (const relative of paths) {
    const key = logicalDocumentKey(relative);
    if (!byLogical.has(key)) byLogical.set(key, []);
    byLogical.get(key).push(relative);
  }
  for (const values of byLogical.values()) values.sort((left, right) => (
    Number(isOrganized(right)) - Number(isOrganized(left)) || left.localeCompare(right, 'zh-CN')
  ));
  return byLogical;
}

function dedupeLogicalDocuments(items, allPaths, limit) {
  const associations = associatedPaths(allPaths);
  const selected = new Map();
  for (const item of items) {
    const key = logicalDocumentKey(item.path);
    const existing = selected.get(key);
    if (!existing || (isOrganized(item.path) && !isOrganized(existing.path))) selected.set(key, item);
  }
  return [...selected].map(([key, item]) => ({
    ...item,
    logicalKey: key,
    relatedPaths: (associations.get(key) || [item.path]).filter((relative) => relative !== item.path),
  })).sort((left, right) => (
    (right.rrfScore ?? right.bm25Score ?? 0) - (left.rrfScore ?? left.bm25Score ?? 0)
  )).slice(0, limit);
}

function publicResult(item) {
  return {
    path: item.path,
    name: item.name || path.basename(item.path),
    heading: item.heading || '',
    headings: item.headings || (item.heading ? [item.heading] : []),
    startLine: item.startLine,
    endLine: item.endLine,
    lineNumbers: item.lineNumbers || undefined,
    matches: item.matches || undefined,
    mime: item.mime || MIME_TYPES.get(path.extname(item.path).toLowerCase()) || 'text/plain; charset=utf-8',
    snippet: item.snippet || String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    score: Number(item.rerankScore ?? item.rrfScore ?? item.bm25Score ?? item.score ?? 0),
    logicalKey: item.logicalKey || logicalDocumentKey(item.path),
    relatedPaths: item.relatedPaths || [],
  };
}

export function routeKnowledgeQuery(query) {
  const value = String(query || '').trim();
  return {
    route: ROUTE_EXACT_PATTERN.test(value) ? 'exact' : 'semantic',
    exhaustive: EXHAUSTIVE_PATTERN.test(value),
  };
}

function exactTerms(query) {
  const normalized = normalizeDates(String(query || '').normalize('NFKC'));
  const quoted = [...normalized.matchAll(/[“”"'「」【】`]([^\n“”"'「」【】`]+)[“”"'「」【】`]/g)]
    .map((match) => normalizeText(match[1]).trim()).filter(Boolean);
  const dates = normalized.match(/\d{4}-\d{2}-\d{2}/g) || [];
  const identifiers = normalized.match(/(?:[^\s"'“”`]+[/\\][^\s"'“”`]+|\b[A-Za-z_$][\w$]*(?:[._-][A-Za-z0-9_$-]+)+\b|\.[a-zA-Z0-9]{1,10}\b)/g) || [];
  const strong = [...quoted, ...dates.map(normalizeText), ...identifiers.map(normalizeText)];
  if (strong.length) return [...new Set(strong)];
  const stripped = normalized.replace(SEARCH_COMMAND_PATTERN, ' ');
  return [...new Set(tokenize(stripped))].sort((left, right) => right.length - left.length).slice(0, 12);
}

function lineMatches(content, terms) {
  const matches = [];
  const lines = String(content || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = normalizeText(lines[index]);
    if (!terms.some((term) => normalized.includes(term))) continue;
    matches.push({ line: index + 1, text: lines[index].trim().slice(0, 500) });
  }
  return matches;
}

function contextualQuery(query, context = {}) {
  const current = String(query || '').trim();
  if (current.length >= 30 && !QUERY_INDEFINITE_PATTERN.test(current)) return current.slice(0, QUERY_CONTEXT_LIMIT);
  const previousQuestion = String(context.previousUserQuestion || '').trim();
  const titles = Array.isArray(context.previousAnswerTitles)
    ? context.previousAnswerTitles.map(String).map((value) => value.trim()).filter(Boolean)
    : [];
  return [current, previousQuestion && `Previous question: ${previousQuestion}`, titles.length && `Previous answer titles: ${titles.join(' | ')}`]
    .filter(Boolean).join('\n').slice(0, QUERY_CONTEXT_LIMIT);
}

function generationId() {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

async function atomicJson(file, value, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode, flag: 'wx' });
  await fsp.rename(temporary, file);
  await fsp.chmod(file, mode).catch(() => {});
}

function emptyGeneration(client) {
  return {
    version: INDEX_VERSION,
    generation: 'unbuilt',
    createdAt: null,
    dimensions: client.dimensions,
    embeddingModel: client.embeddingModel,
    files: {},
    chunks: [],
  };
}

function validGeneration(value, client) {
  if (
    !value || value.version !== INDEX_VERSION || !Array.isArray(value.chunks) ||
    !value.files || typeof value.files !== 'object'
  ) return false;
  if (Number(value.dimensions) !== client.dimensions || value.embeddingModel !== client.embeddingModel) return false;
  return value.chunks.every((chunk) => (
    chunk && typeof chunk.path === 'string' && typeof chunk.content === 'string' &&
    (!chunk.vector || (Array.isArray(chunk.vector) && chunk.vector.length === client.dimensions))
  ));
}

function embeddingDiagnostics(client, overrides = {}) {
  const dimensions = Number(client?.dimensions);
  return {
    embeddingUsed: false,
    embeddingModel: client?.embeddingModel || null,
    embeddingDimensions: Number.isFinite(dimensions) ? dimensions : null,
    embeddingApiCalled: false,
    embeddingApiSucceeded: false,
    queryVectorCacheHit: false,
    rankingCacheHit: false,
    ...overrides,
  };
}

export class KnowledgeIndex {
  constructor(options = {}) {
    this.root = path.resolve(options.root || process.env.KNOWLEDGE_ROOT || path.resolve(process.env.VAULT_PATH || 'vault'));
    const defaultIndexRoot = path.resolve(process.env.DATA_DIR || 'data', 'original-index');
    this.indexRoot = path.resolve(
      options.indexRoot ||
        process.env.KNOWLEDGE_INDEX_DIR ||
        defaultIndexRoot,
    );
    this.client = options.client || new BailianRetrievalClient(options.retrievalOptions || options);
    this.watchEnabled = options.watch !== false;
    this.reconcileIntervalMs = Number(options.reconcileIntervalMs) || RECONCILE_INTERVAL_MS;
    this.watchDebounceMs = Number(options.watchDebounceMs) || WATCH_DEBOUNCE_MS;
    this.fetchEmbeddings = options.fetchEmbeddings !== false;
    this.autoBuild = options.autoBuild !== false;
    this.generation = emptyGeneration(this.client);
    this.manifest = { version: 1, current: null, previous: null };
    this.queryVectors = new Map();
    this.rankingCache = new Map();
    this.watchers = [];
    this.watchTimer = null;
    this.reconcileTimer = null;
    this.rebuildPromise = null;
    this.closed = false;
    this.lastError = null;
    this.ready = this.initialize();
  }

  async initialize() {
    await fsp.mkdir(path.join(this.indexRoot, 'generations'), { recursive: true, mode: 0o700 });
    await this.loadCache();
    await this.loadGeneration();
    if (this.watchEnabled) await this.refreshWatchers();
    this.reconcileTimer = setInterval(() => (
      this.rebuild({ verifyHashes: true }).catch(() => {})
    ), this.reconcileIntervalMs);
    this.reconcileTimer.unref();
    if (this.autoBuild) {
      queueMicrotask(() => this.rebuild().catch((error) => { this.lastError = error; }));
    }
    return this;
  }

  async loadCache() {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(this.indexRoot, 'cache.json'), 'utf8'));
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed.queryVectors || {})) {
        if (
          now - Number(entry.at) <= QUERY_VECTOR_CACHE_TTL_MS &&
          Array.isArray(entry.vector) && entry.vector.length === this.client.dimensions
        ) this.queryVectors.set(key, entry);
      }
      for (const [key, entry] of Object.entries(parsed.rankings || {})) {
        if (now - Number(entry.at) <= RANKING_CACHE_TTL_MS && Array.isArray(entry.results)) {
          this.rankingCache.set(key, entry);
        }
      }
    } catch {}
  }

  async saveCache() {
    const trim = (map, limit, ttl) => {
      const now = Date.now();
      const entries = [...map].filter(([, entry]) => now - Number(entry.at) <= ttl)
        .sort((left, right) => Number(right[1].at) - Number(left[1].at)).slice(0, limit);
      map.clear();
      for (const entry of entries) map.set(...entry);
      return Object.fromEntries(entries);
    };
    await atomicJson(path.join(this.indexRoot, 'cache.json'), {
      version: 1,
      queryVectors: trim(this.queryVectors, QUERY_VECTOR_CACHE_LIMIT, QUERY_VECTOR_CACHE_TTL_MS),
      rankings: trim(this.rankingCache, 500, RANKING_CACHE_TTL_MS),
    }).catch(() => {});
  }

  async readGeneration(name) {
    if (!name || !/^[a-zA-Z0-9-]+$/.test(name)) return null;
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(this.indexRoot, 'generations', `${name}.json`), 'utf8'));
      if (validGeneration(parsed, this.client)) return parsed;
      const error = new Error(
        Number(parsed?.dimensions) !== this.client.dimensions
          ? `索引维度不匹配（索引 ${parsed?.dimensions ?? '未知'} 维，当前 ${this.client.dimensions} 维）。`
          : '索引代次损坏或模型配置不匹配。',
      );
      error.code = Number(parsed?.dimensions) !== this.client.dimensions
        ? 'KNOWLEDGE_INDEX_DIMENSION_MISMATCH'
        : 'KNOWLEDGE_INDEX_CORRUPT';
      this.lastError = error;
      return null;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const invalid = new Error('索引代次无法读取，已使用实时词法扫描。');
        invalid.code = 'KNOWLEDGE_INDEX_CORRUPT';
        this.lastError = invalid;
      }
      return null;
    }
  }

  async loadGeneration() {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(this.indexRoot, 'manifest.json'), 'utf8'));
      if (parsed?.version === 1) this.manifest = parsed;
    } catch {}
    const current = await this.readGeneration(this.manifest.current);
    if (current) {
      this.generation = current;
      return;
    }
    const previous = await this.readGeneration(this.manifest.previous);
    if (previous) {
      this.generation = previous;
      this.lastError = new Error('当前索引损坏，已回退上一代。');
    }
  }

  scheduleRebuild(delay = this.watchDebounceMs) {
    if (this.closed) return;
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => this.rebuild().catch((error) => { this.lastError = error; }), delay);
    this.watchTimer.unref?.();
  }

  async refreshWatchers(directoriesInput) {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (!this.watchEnabled || this.closed) return;
    const directories = directoriesInput || (await walkFiles(this.root)).directories;
    for (const directory of directories) {
      try {
        const watcher = fs.watch(directory, { persistent: false }, () => this.scheduleRebuild());
        watcher.on('error', () => this.scheduleRebuild());
        this.watchers.push(watcher);
      } catch {}
    }
  }

  async readFileChunks(relative) {
    if (!indexedExtension(relative) || shouldSkip(relative)) return null;
    const target = path.join(this.root, relative);
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return null;
    const buffer = await fsp.readFile(target).catch(() => null);
    if (!buffer || buffer.includes(0)) return null;
    const content = buffer.toString('utf8');
    return {
      stat,
      hash: sha256(buffer),
      content,
      chunks: chunkDocument(relative, content),
    };
  }

  async embedMissing(chunks, oldChunks = [], signal) {
    const reusable = new Map();
    for (const chunk of oldChunks) {
      if (Array.isArray(chunk.vector) && chunk.vector.length === this.client.dimensions) {
        reusable.set(chunk.chunkHash, chunk.vector);
      }
    }
    const missing = [];
    for (const chunk of chunks) {
      const vector = reusable.get(chunk.chunkHash);
      if (vector) chunk.vector = vector;
      else missing.push(chunk);
    }
    if (!this.fetchEmbeddings || !missing.length) return;
    for (let index = 0; index < missing.length; index += 20) {
      signal?.throwIfAborted();
      const batch = missing.slice(index, index + 20);
      const vectors = await this.client.embed(batch.map((chunk) => chunk.content), { textType: 'document', signal });
      vectors.forEach((vector, offset) => { batch[offset].vector = vector; });
    }
  }

  async persistGeneration(next) {
    const generationsRoot = path.join(this.indexRoot, 'generations');
    const target = path.join(generationsRoot, `${next.generation}.json`);
    await atomicJson(target, next);
    const previous = this.manifest.current || this.manifest.previous || null;
    const oldPrevious = this.manifest.previous;
    const manifest = { version: 1, current: next.generation, previous };
    await atomicJson(path.join(this.indexRoot, 'manifest.json'), manifest);
    this.manifest = manifest;
    this.generation = next;
    if (oldPrevious && oldPrevious !== previous && oldPrevious !== next.generation) {
      await fsp.rm(path.join(generationsRoot, `${oldPrevious}.json`), { force: true }).catch(() => {});
    }
  }

  rebuild(options = {}) {
    if (this.rebuildPromise) return this.rebuildPromise;
    this.rebuildPromise = this.performRebuild(options).finally(() => { this.rebuildPromise = null; });
    return this.rebuildPromise;
  }

  async performRebuild(options = {}) {
    options.signal?.throwIfAborted();
    if (this.closed) return this.generation;
    const old = this.generation;
    const onlyPaths = Array.isArray(options.onlyPaths)
      ? new Set(options.onlyPaths.filter((relative) => typeof relative === 'string' && indexedExtension(relative)))
      : null;
    let generationChanged = Boolean(onlyPaths);
    let files = {};
    let chunks = [];
    let directories;
    if (onlyPaths) {
      files = { ...old.files };
      chunks = old.chunks.filter((chunk) => !onlyPaths.has(chunk.path));
      for (const relative of onlyPaths) {
        delete files[relative];
        const loaded = await this.readFileChunks(relative);
        if (!loaded) continue;
        files[relative] = {
          hash: loaded.hash,
          size: loaded.stat.size,
          mtimeMs: loaded.stat.mtimeMs,
          ctimeMs: loaded.stat.ctimeMs,
          chunks: loaded.chunks.map((chunk) => chunk.id),
        };
        chunks.push(...loaded.chunks);
      }
    } else {
      const walked = await walkFiles(this.root);
      directories = walked.directories;
      for (const relative of walked.files) {
        const target = path.join(this.root, relative);
        const stat = await fsp.lstat(target).catch(() => null);
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) continue;
        const previous = old.files[relative];
        const metadataMatches = previous &&
          previous.size === stat.size &&
          Math.trunc(previous.mtimeMs) === Math.trunc(stat.mtimeMs) &&
          Math.trunc(previous.ctimeMs) === Math.trunc(stat.ctimeMs);
        if (metadataMatches && !options.verifyHashes) {
          files[relative] = previous;
          chunks.push(...old.chunks.filter((chunk) => chunk.path === relative));
          continue;
        }
        const loaded = await this.readFileChunks(relative);
        if (!loaded) continue;
        if (previous && previous.hash === loaded.hash) {
          if (!metadataMatches) generationChanged = true;
          files[relative] = {
            ...previous,
            size: loaded.stat.size,
            mtimeMs: loaded.stat.mtimeMs,
            ctimeMs: loaded.stat.ctimeMs,
          };
          chunks.push(...old.chunks.filter((chunk) => chunk.path === relative));
          continue;
        }
        generationChanged = true;
        files[relative] = {
          hash: loaded.hash,
          size: loaded.stat.size,
          mtimeMs: loaded.stat.mtimeMs,
          ctimeMs: loaded.stat.ctimeMs,
          chunks: loaded.chunks.map((chunk) => chunk.id),
        };
        chunks.push(...loaded.chunks);
      }
      if (Object.keys(old.files).some((relative) => !Object.hasOwn(files, relative))) {
        generationChanged = true;
      }
    }
    if (!generationChanged) {
      this.lastError = null;
      if (!onlyPaths) await this.refreshWatchers(directories);
      return old;
    }
    await this.embedMissing(chunks, old.chunks, options.signal);
    options.signal?.throwIfAborted();
    const next = {
      version: INDEX_VERSION,
      generation: generationId(),
      createdAt: new Date().toISOString(),
      dimensions: this.client.dimensions,
      embeddingModel: this.client.embeddingModel,
      files,
      chunks: chunks.sort((left, right) => (
        left.path.localeCompare(right.path, 'zh-CN') || left.startLine - right.startLine
      )),
    };
    await this.persistGeneration(next);
    this.lastError = null;
    this.rankingCache.clear();
    await this.saveCache();
    if (!onlyPaths) await this.refreshWatchers(directories);
    return next;
  }

  async updatePaths(paths) {
    await this.ready;
    return this.rebuild({ onlyPaths: [...new Set(paths)] });
  }

  async collectLiveChunks(signal) {
    const walked = await walkFiles(this.root);
    const chunks = [];
    const livePaths = [];
    let hasChanges = false;
    const indexedByPath = new Map();
    for (const chunk of this.generation.chunks) {
      if (!indexedByPath.has(chunk.path)) indexedByPath.set(chunk.path, []);
      indexedByPath.get(chunk.path).push(chunk);
    }
    for (const relative of walked.files) {
      signal?.throwIfAborted?.();
      const stat = await fsp.lstat(path.join(this.root, relative)).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) continue;
      livePaths.push(relative);
      const indexed = this.generation.files[relative];
      if (
        indexed && indexed.size === stat.size &&
        Math.trunc(indexed.mtimeMs) === Math.trunc(stat.mtimeMs) &&
        Math.trunc(indexed.ctimeMs) === Math.trunc(stat.ctimeMs)
      ) {
        chunks.push(...(indexedByPath.get(relative) || []));
        continue;
      }
      hasChanges = true;
      const loaded = await this.readFileChunks(relative);
      if (loaded) chunks.push(...loaded.chunks);
    }
    if (Object.keys(this.generation.files).some((relative) => !livePaths.includes(relative))) hasChanges = true;
    return { chunks, paths: livePaths, hasChanges };
  }

  async exactSearch(query, options = {}) {
    const terms = exactTerms(query);
    if (!terms.length) {
      return {
        route: 'exact',
        exhaustive: Boolean(options.exhaustive),
        query: normalizeDates(query),
        results: [],
        diagnostics: embeddingDiagnostics(this.client, {
          liveScan: true,
          rerankerUsed: false,
        }),
      };
    }
    const walked = await walkFiles(this.root);
    const results = [];
    const liveChunks = [];
    for (const relative of walked.files) {
      options.signal?.throwIfAborted?.();
      const loaded = await this.readFileChunks(relative);
      if (!loaded) continue;
      const content = loaded.content;
      liveChunks.push(...loaded.chunks);
      const normalizedPath = normalizeText(relative);
      const normalizedContent = normalizeText(content);
      const pathHits = terms.filter((term) => normalizedPath.includes(term));
      const contentHits = terms.filter((term) => normalizedContent.includes(term));
      if (!pathHits.length && !contentHits.length) continue;
      const matches = lineMatches(content, terms);
      const bestChunk = loaded.chunks[0];
      results.push({
        ...(bestChunk || { path: relative, name: path.basename(relative), content: '' }),
        path: relative,
        name: path.basename(relative),
        matches,
        lineNumbers: matches.map((match) => match.line),
        score: pathHits.length * 20 + contentHits.length * 8 + matches.length,
      });
    }
    const rankedByPath = new Map();
    for (const chunk of bm25Search(normalizeDates(query), liveChunks, liveChunks.length)) {
      if (!rankedByPath.has(chunk.path)) rankedByPath.set(chunk.path, chunk);
    }
    for (const result of results) {
      const ranked = rankedByPath.get(result.path);
      if (!ranked) continue;
      result.heading = ranked.heading;
      result.headings = ranked.headings;
      result.startLine = ranked.startLine;
      result.endLine = ranked.endLine;
      result.content = ranked.content;
      result.score += ranked.bm25Score * 10;
      result.bm25Score = undefined;
    }
    results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, 'zh-CN'));
    const associations = associatedPaths(walked.files);
    const publicResults = results.map((item) => publicResult({
      ...item,
      relatedPaths: (associations.get(logicalDocumentKey(item.path)) || []).filter((relative) => relative !== item.path),
    }));
    return {
      route: 'exact',
      exhaustive: Boolean(options.exhaustive),
      complete: Boolean(options.exhaustive),
      query: normalizeDates(query),
      results: options.exhaustive ? publicResults : publicResults.slice(0, Number(options.limit) || 30),
      diagnostics: embeddingDiagnostics(this.client, {
        terms,
        liveScan: true,
        rerankerUsed: false,
      }),
    };
  }

  async queryVector(query, signal) {
    const key = sha256([
      'knowledge-query-vector-v1',
      this.client.embeddingModel,
      this.client.dimensions,
      'Given a knowledge-base question, retrieve passages that directly answer it. Preserve names, dates, paths, identifiers, and temporal context.',
      query,
    ].join('\0'));
    const cached = this.queryVectors.get(key);
    if (cached && Date.now() - cached.at <= QUERY_VECTOR_CACHE_TTL_MS) {
      cached.at = Date.now();
      return { vector: cached.vector, source: 'query-cache' };
    }
    const [vector] = await this.client.embed([query], { textType: 'query', signal });
    this.queryVectors.set(key, { at: Date.now(), vector });
    await this.saveCache();
    return { vector, source: 'api' };
  }

  async semanticSearch(query, options = {}) {
    const taskMode = options.taskMode === 'deep' ? 'deep' : 'normal';
    const recallLimit = taskMode === 'deep' ? 60 : 30;
    const rrfLimit = taskMode === 'deep' ? 40 : 24;
    const resultLimit = taskMode === 'deep' ? 20 : 12;
    const retrievalQuery = contextualQuery(query, options);
    const live = await this.collectLiveChunks(options.signal);
    const queryHash = sha256(retrievalQuery);
    const rankingKey = `${queryHash}:${this.generation.generation}:${taskMode}`;
    const cached = this.rankingCache.get(rankingKey);
    if (!live.hasChanges && cached && Date.now() - cached.at <= RANKING_CACHE_TTL_MS) {
      return {
        ...cached.value,
        cacheHit: true,
        diagnostics: embeddingDiagnostics(this.client, {
          ...cached.value.diagnostics,
          embeddingApiCalled: false,
          embeddingApiSucceeded: false,
          queryVectorCacheHit: false,
          rankingCacheHit: true,
        }),
      };
    }
    const bm25 = bm25Search(retrievalQuery, live.chunks, recallLimit);
    let vector = [];
    let embeddingError = null;
    let queryVectorSource = null;
    const embeddedChunks = live.chunks.filter((chunk) => (
      Array.isArray(chunk.vector) && chunk.vector.length === this.client.dimensions
    ));
    if (embeddedChunks.length) {
      try {
        const queryVectorResult = await this.queryVector(retrievalQuery, options.signal);
        queryVectorSource = queryVectorResult.source;
        vector = vectorSearch(queryVectorResult.vector, embeddedChunks, recallLimit);
      } catch (error) {
        embeddingError = error;
      }
    }
    const embeddingApiCalled = queryVectorSource === 'api' || Boolean(embeddingError);
    const embeddingApiSucceeded = queryVectorSource === 'api';
    const queryVectorCacheHit = queryVectorSource === 'query-cache';
    if (!vector.length) {
      const fallback = dedupeLogicalDocuments(bm25, live.paths, resultLimit).map(publicResult);
      const value = {
        route: 'semantic',
        query: retrievalQuery,
        results: fallback,
        diagnostics: embeddingDiagnostics(this.client, {
          taskMode,
          generation: this.generation.generation,
          liveOverlay: live.hasChanges,
          embeddingApiCalled,
          embeddingApiSucceeded,
          queryVectorCacheHit,
          rerankerUsed: false,
          fallback: 'bm25',
          warning: embeddingError?.code || (!embeddedChunks.length ? this.lastError?.code : undefined),
        }),
      };
      return value;
    }
    const fused = reciprocalRankFusion(bm25, vector).slice(0, rrfLimit);
    let candidates = dedupeLogicalDocuments(fused, live.paths, rrfLimit);
    const bm25Top = new Set(bm25.slice(0, 12).map((item) => logicalDocumentKey(item.path)));
    const vectorTop = new Set(vector.slice(0, 12).map((item) => logicalDocumentKey(item.path)));
    const common = [...bm25Top].filter((key) => vectorTop.has(key));
    const topThreeBm25 = new Set(bm25.slice(0, 3).map((item) => logicalDocumentKey(item.path)));
    const topThreeConflict = !vector.slice(0, 3).some((item) => topThreeBm25.has(logicalDocumentKey(item.path)));
    const shouldRerank = common.length < 6 || topThreeConflict;
    let rerankerUsed = false;
    let rerankerError = null;
    if (shouldRerank && candidates.length) {
      try {
        const ranked = await this.client.rerank(
          retrievalQuery,
          candidates.map((candidate) => [
            `Path: ${candidate.path}`,
            candidate.headings?.length ? `Heading: ${candidate.headings.join(' > ')}` : '',
            candidate.content,
          ].filter(Boolean).join('\n')),
          { topN: Math.min(resultLimit, candidates.length), signal: options.signal },
        );
        candidates = ranked.map((rank) => ({ ...candidates[rank.index], rerankScore: rank.score }));
        rerankerUsed = true;
      } catch (error) {
        rerankerError = error;
      }
    }
    const results = candidates.slice(0, resultLimit).map(publicResult);
    const value = {
      route: 'semantic',
      query: retrievalQuery,
      results,
      diagnostics: embeddingDiagnostics(this.client, {
        taskMode,
        generation: this.generation.generation,
        liveOverlay: live.hasChanges,
        bm25Count: bm25.length,
        vectorCount: vector.length,
        commonTop12Files: common.length,
        embeddingUsed: true,
        embeddingApiCalled,
        embeddingApiSucceeded,
        queryVectorCacheHit,
        rerankerUsed,
        rerankerRequested: shouldRerank,
        fallback: rerankerError ? 'rrf' : undefined,
        warning: rerankerError?.code || undefined,
      }),
    };
    if (!live.hasChanges) {
      this.rankingCache.set(rankingKey, { at: Date.now(), results, value });
      await this.saveCache();
    }
    return value;
  }

  async search(queryInput, options = {}) {
    await this.ready;
    const query = String(queryInput || '').trim();
    if (!query) {
      return {
        route: 'semantic',
        query: '',
        results: [],
        diagnostics: embeddingDiagnostics(this.client),
      };
    }
    const route = options.route || routeKnowledgeQuery(query).route;
    const exhaustive = options.exhaustive ?? routeKnowledgeQuery(query).exhaustive;
    if (route === 'exact') return this.exactSearch(query, { ...options, exhaustive });
    return this.semanticSearch(query, options);
  }

  status() {
    return {
      available: this.generation.generation !== 'unbuilt',
      generation: this.generation.generation,
      previousGeneration: this.manifest.previous,
      createdAt: this.generation.createdAt,
      files: Object.keys(this.generation.files).length,
      chunks: this.generation.chunks.length,
      embeddedChunks: this.generation.chunks.filter((chunk) => Array.isArray(chunk.vector)).length,
      dimensions: this.client.dimensions,
      embeddingModel: this.client.embeddingModel,
      lastError: this.lastError ? { code: this.lastError.code || 'INDEX_ERROR', message: this.lastError.message } : null,
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.watchTimer);
    clearInterval(this.reconcileTimer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}

export const knowledgeIndexConstants = {
  INDEX_EXTENSIONS,
  TARGET_CHUNK_CHARACTERS,
  CHUNK_OVERLAP_CHARACTERS,
  QUERY_VECTOR_CACHE_LIMIT,
  QUERY_VECTOR_CACHE_TTL_MS,
  RANKING_CACHE_TTL_MS,
  WATCH_DEBOUNCE_MS,
  RECONCILE_INTERVAL_MS,
};
