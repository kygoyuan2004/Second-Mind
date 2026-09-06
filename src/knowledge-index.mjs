import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EmbeddingClient } from './embedding-client.mjs';
import { VaultPathPolicy, isIndexable } from './path-policy.mjs';

const INDEX_VERSION = 1;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TARGET_CHUNK_CHARACTERS = 1_500;
const CHUNK_OVERLAP_CHARACTERS = 180;
const WATCH_DEBOUNCE_MS = 750;
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;
const RRF_K = 60;
const QUERY_VECTOR_CACHE_LIMIT = 256;
const TEMPORAL_INVENTORY_MAX_FILES = 500;
const QUERY_RETRIEVAL_INSTRUCTION =
  'Given a knowledge-base question, retrieve passages that directly answer it. Preserve names, dates, paths, identifiers, and temporal context.';
const BM25_DOCUMENT_CACHE = new WeakMap();

const STOP_TERMS = new Set([
  '请', '帮我', '查找', '搜索', '检索', '列出', '全部', '所有', '包含', '提到',
  '文件', '内容', '关于', '什么', '哪些', 'the', 'and', 'for', 'with', 'from',
]);

const QUERY_LOW_INFORMATION_TERMS = new Set([
  ...STOP_TERMS,
  '请问', '告诉我', '请告诉我', '想知道', '我想知道', '一下',
  '是', '谁', '谁是', '是谁', '什么人', '的', '了', '吗', '呢', '吧',
  '如何', '怎么', '为什么', '为何', '哪里', '哪儿', '何时', '什么时候',
  '在', '里', '中', '有', '与', '和', '及', '或',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(
      /(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/g,
      (_, year, month, day) => (
        `${year}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`
      ),
    );
}

function cjkTokens(value) {
  const output = [];
  for (const match of value.matchAll(/[\p{Script=Han}]+/gu)) {
    const text = match[0];
    output.push(...text);
    for (let index = 0; index < text.length - 1; index += 1) {
      output.push(text.slice(index, index + 2));
    }
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
      if (
        segment.isWordLike && token &&
        (token.length > 1 || /[\p{Script=Han}\p{N}]/u.test(token))
      ) tokens.push(token);
    }
  } catch {
    tokens.push(...normalized.split(/[^\p{L}\p{N}_$+.-]+/u).filter(Boolean));
  }
  tokens.push(...cjkTokens(normalized));
  for (const identifier of normalized.match(/[a-z_$][a-z0-9_$.-]*/g) || []) {
    tokens.push(identifier, ...identifier.split(/[._$-]+/).filter((part) => part.length > 1));
  }
  return tokens.filter((token) => token && !STOP_TERMS.has(token));
}

function trimQueryEdges(value) {
  return String(value || '').replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '').trim();
}

function querySurface(value) {
  let output = trimQueryEdges(normalizeText(value));
  const politePrefix = /^(?:(?:请问|请告诉我|告诉我|请帮我|帮我|麻烦你?|我想知道|想知道|能否|可以(?:帮我)?)(?:一下)?[\s\p{P}]*)+/u;
  let previous;
  do {
    previous = output;
    output = trimQueryEdges(output.replace(politePrefix, ''));
  } while (output && output !== previous);
  return output;
}

function compactComparableText(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

function explicitEntityAnchor(value) {
  const surface = querySurface(value);
  const match = /^\s*谁是\s*(.+?)\s*$/u.exec(surface) ||
    /^\s*(.+?)\s*(?:是谁|是什么人)\s*$/u.exec(surface);
  const anchor = trimQueryEdges(match?.[1] || '');
  const compact = compactComparableText(anchor);
  if (
    [...compact].length < 2 || QUERY_LOW_INFORMATION_TERMS.has(anchor) ||
    QUERY_LOW_INFORMATION_TERMS.has(compact)
  ) return '';
  return anchor;
}

function queryCore(value) {
  const anchor = explicitEntityAnchor(value);
  if (anchor) return anchor;
  return trimQueryEdges(querySurface(value)
    .replace(/^(?:谁|什么是|如何|怎么|为什么|为何|哪里|哪儿|何时|什么时候)[\s\p{P}]*/u, '')
    .replace(/(?:是谁|是什么人|是什么|有哪些|有多少|怎么样|怎么回事|吗|呢|吧)[\s\p{P}]*$/u, ''));
}

function segmentedQueryCandidates(value) {
  const candidates = [];
  let hanRun = '';
  const flushHanRun = () => {
    if (!hanRun) return;
    const characters = [...hanRun];
    if (characters.length > 1) candidates.push(hanRun);
    candidates.push(...cjkTokens(hanRun));
    hanRun = '';
  };

  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const segment of segmenter.segment(value)) {
      const token = segment.segment.trim();
      if (!segment.isWordLike || !token) {
        flushHanRun();
        continue;
      }
      if (QUERY_LOW_INFORMATION_TERMS.has(token)) {
        flushHanRun();
        continue;
      }
      if (/^[\p{Script=Han}]+$/u.test(token)) {
        hanRun += token;
        continue;
      }
      flushHanRun();
      candidates.push(...tokenize(token));
    }
    flushHanRun();
  } catch {
    candidates.push(...tokenize(value));
  }

  for (const identifier of value.match(/[a-z_$][a-z0-9_$.-]*/g) || []) {
    candidates.push(identifier, ...identifier.split(/[._$-]+/).filter(Boolean));
  }
  return candidates.filter((term) => term && !QUERY_LOW_INFORMATION_TERMS.has(term));
}

function queryTermsFor(value) {
  const candidates = [...new Set(segmentedQueryCandidates(queryCore(value)))];
  const informative = candidates.filter((term) => (
    (/^[\p{Script=Han}]+$/u.test(term) && [...term].length >= 2) ||
    /[\p{Script=Latin}\p{N}]/u.test(term)
  ));
  if (informative.length) return informative;
  return candidates.filter((term) => (
    /^[\p{Script=Han}]$/u.test(term) || /[\p{L}\p{N}_$+.-]/u.test(term)
  ));
}

function chunkContainsEntity(chunk, anchor) {
  const needle = compactComparableText(anchor);
  return Boolean(needle && compactComparableText(searchableText(chunk)).includes(needle));
}

function headingFor(line) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  return match ? { level: match[1].length, text: match[2].trim().slice(0, 240) } : null;
}

function blockKind(line) {
  if (/^\s*```|^\s*~~~/.test(line)) return 'fence';
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/.test(line)) return 'list';
  if (/^\s*\|.*\|\s*$/.test(line)) return 'table';
  return 'paragraph';
}

function markdownBlocks(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const headings = [];
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const start = index;
    const heading = headingFor(lines[index]);
    if (heading) {
      headings.splice(heading.level - 1);
      headings[heading.level - 1] = heading.text;
      blocks.push({
        text: lines[index],
        lineStart: index + 1,
        lineEnd: index + 1,
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
        const finished = lines[index].trim().startsWith(marker);
        index += 1;
        if (finished) break;
      }
    } else if (kind === 'list') {
      index += 1;
      while (index < lines.length) {
        const current = lines[index];
        if (!current.trim()) break;
        if (headingFor(current) || ['fence', 'table'].includes(blockKind(current))) break;
        if (blockKind(current) !== 'list' && !/^\s+/.test(current)) break;
        index += 1;
      }
    } else if (kind === 'table') {
      index += 1;
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) index += 1;
    } else {
      index += 1;
      while (
        index < lines.length && lines[index].trim() &&
        !headingFor(lines[index]) && blockKind(lines[index]) === 'paragraph'
      ) index += 1;
    }
    blocks.push({
      text: lines.slice(start, index).join('\n'),
      lineStart: start + 1,
      lineEnd: Math.max(start + 1, index),
      headings: headings.filter(Boolean),
      kind,
    });
  }
  return blocks;
}

function splitOversizedBlock(block, targetSize) {
  if (block.text.length <= targetSize || ['fence', 'list', 'table'].includes(block.kind)) {
    return [block];
  }
  const output = [];
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
    const preceding = block.text.slice(0, cursor);
    const text = block.text.slice(cursor, end);
    const lineStart = block.lineStart + (preceding.match(/\n/g)?.length || 0);
    output.push({
      ...block,
      text,
      lineStart,
      lineEnd: lineStart + (text.match(/\n/g)?.length || 0),
    });
    cursor = end;
  }
  return output;
}

export function chunkDocument(relative, markdown, options = {}) {
  const targetSize = Number(options.targetSize) || TARGET_CHUNK_CHARACTERS;
  const overlapSize = Number(options.overlapSize) || CHUNK_OVERLAP_CHARACTERS;
  const fileHash = sha256(Buffer.from(String(markdown || '')));
  const blocks = markdownBlocks(markdown)
    .flatMap((block) => splitOversizedBlock(block, targetSize));
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let hasNewContent = false;

  const flush = () => {
    if (!current.length || !hasNewContent) return;
    const content = current.map((block) => block.text).join('\n\n').trim();
    if (!content) return;
    const first = current[0];
    const last = current.at(-1);
    const chunkHash = sha256(Buffer.from(content));
    chunks.push({
      id: sha256(`${relative}\0${first.lineStart}\0${last.lineEnd}\0${chunkHash}`),
      path: relative,
      name: path.basename(relative),
      heading: first.headings?.at(-1) || '',
      headings: [...(first.headings || [])],
      lineStart: first.lineStart,
      lineEnd: last.lineEnd,
      fileHash,
      chunkHash,
      content,
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
    hasNewContent = false;
  };

  for (const block of blocks) {
    const addition = block.text.length + (current.length ? 2 : 0);
    if (current.length && currentLength + addition > targetSize) flush();
    current.push(block);
    currentLength += addition;
    hasNewContent = true;
    if (currentLength >= targetSize) flush();
  }
  flush();
  return chunks;
}

function termFrequencies(tokens) {
  const frequencies = new Map();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  return frequencies;
}

function searchableText(chunk) {
  return `${chunk.path}\n${chunk.headings?.join(' ') || chunk.heading || ''}\n${chunk.content}`;
}

function bm25Document(chunk) {
  const searchText = searchableText(chunk);
  const cached = BM25_DOCUMENT_CACHE.get(chunk);
  if (cached?.searchText === searchText) return cached;
  const tokens = tokenize(searchText);
  const document = {
    chunk,
    searchText,
    tokens,
    frequencies: termFrequencies(tokens),
    normalizedPath: normalizeText(chunk.path),
    normalizedHeading: normalizeText(chunk.headings?.join(' ') || chunk.heading),
  };
  BM25_DOCUMENT_CACHE.set(chunk, document);
  return document;
}

export function bm25Search(query, chunks, limit = 30) {
  const queryTerms = queryTermsFor(query);
  const entityAnchor = explicitEntityAnchor(query);
  const scopedChunks = entityAnchor
    ? chunks.filter((chunk) => chunkContainsEntity(chunk, entityAnchor))
    : chunks;
  if (!queryTerms.length || !scopedChunks.length) return [];
  const documents = scopedChunks.map(bm25Document);
  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) /
    Math.max(1, documents.length);
  const documentFrequency = new Map(queryTerms.map((term) => [term, 0]));
  for (const document of documents) {
    for (const term of queryTerms) {
      if (document.frequencies.has(term)) {
        documentFrequency.set(term, documentFrequency.get(term) + 1);
      }
    }
  }
  const results = [];
  for (const document of documents) {
    let score = 0;
    const matchedTerms = [];
    const { normalizedPath, normalizedHeading } = document;
    for (const term of queryTerms) {
      const frequency = document.frequencies.get(term) || 0;
      const frequencyInCorpus = documentFrequency.get(term) || 0;
      if (!frequency || !frequencyInCorpus) continue;
      matchedTerms.push(term);
      const inverseFrequency = Math.log(
        1 + ((documents.length - frequencyInCorpus + 0.5) / (frequencyInCorpus + 0.5)),
      );
      const denominator = frequency + 1.5 * (
        1 - 0.75 + 0.75 * (document.tokens.length / Math.max(1, averageLength))
      );
      score += inverseFrequency * ((frequency * 2.5) / denominator);
      if (normalizedHeading.includes(term)) score += inverseFrequency * 1.8;
      if (normalizedPath.includes(term)) score += inverseFrequency * 2.5;
    }
    if (score > 0) results.push({ ...document.chunk, bm25Score: score, matchedTerms });
  }
  return results.sort((left, right) => (
    right.bm25Score - left.bm25Score ||
    left.path.localeCompare(right.path) ||
    left.lineStart - right.lineStart
  )).slice(0, Math.max(1, Number(limit) || 30));
}

export function cosineSimilarity(left, right) {
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
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -Infinity;
}

function vectorSearch(queryVector, chunks, limit) {
  return chunks.map((chunk) => ({
    ...chunk,
    vectorScore: cosineSimilarity(queryVector, chunk.vector),
  })).filter((chunk) => Number.isFinite(chunk.vectorScore)).sort((left, right) => (
    right.vectorScore - left.vectorScore || left.path.localeCompare(right.path)
  )).slice(0, limit);
}

function reciprocalRankFusion(keyword, semantic) {
  const merged = new Map();
  const add = (items, source) => items.forEach((item, index) => {
    const current = merged.get(item.id) || { ...item, rrfScore: 0, ranks: {}, matchedTerms: [] };
    current.rrfScore += 1 / (RRF_K + index + 1);
    current.ranks[source] = index + 1;
    current.matchedTerms = [...new Set([
      ...(current.matchedTerms || []),
      ...(item.matchedTerms || []),
    ])];
    merged.set(item.id, current);
  });
  add(keyword, 'keyword');
  add(semantic, 'semantic');
  return [...merged.values()].sort((left, right) => (
    right.rrfScore - left.rrfScore || left.path.localeCompare(right.path)
  ));
}

function matchedTermsFor(chunk, query) {
  const haystack = normalizeText(searchableText(chunk));
  return queryTermsFor(query).filter((term) => haystack.includes(term));
}

function snippetFor(content, terms, length = 320) {
  const text = String(content || '');
  const normalized = normalizeText(text);
  let match = -1;
  for (const term of terms) {
    const found = normalized.indexOf(term);
    if (found >= 0 && (match < 0 || found < match)) match = found;
  }
  const start = Math.max(0, (match < 0 ? 0 : match) - Math.floor(length / 3));
  const snippet = text.slice(start, start + length).replace(/\s+/g, ' ').trim();
  return `${start ? '…' : ''}${snippet}${start + length < text.length ? '…' : ''}`;
}

export function logicalDocumentKey(relative) {
  const value = String(relative || '');
  const extension = path.extname(value);
  const stem = path.basename(value, extension)
    .replace(/(?:_整理版|-整理版|（整理版）)$/u, '');
  const directory = path.dirname(value);
  return `${directory === '.' ? '' : `${directory}/`}${stem}${extension}`
    .normalize('NFKC')
    .toLocaleLowerCase();
}

function isOrganizedDocument(relative) {
  return /(?:_整理版|-整理版|（整理版）)(?=\.[^.]+$)/u.test(String(relative || ''));
}

function learningLikePath(relative) {
  const segments = String(relative || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .split(/[\\/]+/u)
    .filter(Boolean);
  return segments.some((segment) => (
    /(?:^|[_\s.-])(?:learn(?:ing)?|study|course|paper|research|tutorial|project|reading|book|knowledge)(?:[_\s.-]|$)/iu.test(segment) ||
    /学习|课程|读书|阅读|论文|研究|教程|教材|文献|项目|知识/u.test(segment)
  ));
}

function learningLikeContent(chunks) {
  return (Array.isArray(chunks) ? chunks : []).some((chunk) => (
    /学习|复习|课程|读书|阅读|论文|研究|教程|教材|文献|项目|learn|study|course|paper|research|tutorial/iu.test(
      `${chunk?.heading || ''}\n${chunk?.content || ''}`,
    )
  ));
}

function validFileMtime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function logicalPathAssociations(paths) {
  const output = new Map();
  for (const relative of paths || []) {
    const key = logicalDocumentKey(relative);
    if (!output.has(key)) output.set(key, []);
    output.get(key).push(String(relative));
  }
  for (const values of output.values()) values.sort((left, right) => (
    Number(isOrganizedDocument(right)) - Number(isOrganizedDocument(left)) ||
    left.localeCompare(right)
  ));
  return output;
}

function publicFileResults(items, query, limit, allPaths = []) {
  const associations = logicalPathAssociations(allPaths);
  const selected = new Map();
  for (const [rank, item] of items.entries()) {
    const logicalKey = logicalDocumentKey(item.path);
    const existing = selected.get(logicalKey);
    if (existing) {
      existing.paths.add(item.path);
      existing.matchedTerms.push(...(item.matchedTerms || []));
      existing.bestScore = Math.max(
        existing.bestScore,
        Number(item.rrfScore ?? item.vectorScore ?? item.bm25Score ?? 0),
      );
      if (isOrganizedDocument(item.path) && !isOrganizedDocument(existing.item.path)) {
        existing.item = item;
      }
      continue;
    }
    selected.set(logicalKey, {
      logicalKey,
      item,
      rank,
      paths: new Set([item.path]),
      matchedTerms: [...(item.matchedTerms || [])],
      bestScore: Number(item.rrfScore ?? item.vectorScore ?? item.bm25Score ?? 0),
    });
  }
  return [...selected.values()]
    .sort((left, right) => left.rank - right.rank)
    .slice(0, limit)
    .map((entry) => {
    const item = entry.item;
    const matchedTerms = item.matchedTerms?.length
      ? [...new Set(entry.matchedTerms)]
      : matchedTermsFor(item, query);
    return {
      path: item.path,
      name: item.name || path.basename(item.path),
      heading: item.heading || '',
      lineStart: item.lineStart,
      lineEnd: item.lineEnd,
      snippet: snippetFor(item.content, matchedTerms),
      content: item.content,
      score: entry.bestScore,
      matchedTerms,
      logicalKey: entry.logicalKey,
      relatedPaths: (associations.get(entry.logicalKey) || [...entry.paths])
        .filter((relative) => relative !== item.path),
    };
  });
}

function generationId() {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

async function atomicJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await fsp.rename(temporary, filename);
    await fsp.chmod(filename, 0o600).catch(() => {});
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function embeddingSignature(client, enabled, config = {}) {
  return {
    enabled,
    provider: enabled ? String(client.provider || config.provider || 'custom') : 'disabled',
    model: enabled ? String(client.model || client.embeddingModel || config.model || '') : null,
    dimensions: enabled ? Number(client.dimensions || config.dimensions) : null,
  };
}

function emptyGeneration(signature) {
  return {
    version: INDEX_VERSION,
    generation: 'unbuilt',
    createdAt: null,
    embedding: signature,
    files: {},
    chunks: [],
  };
}

function validGeneration(value, signature) {
  if (
    !value || value.version !== INDEX_VERSION || !value.files ||
    typeof value.files !== 'object' || !Array.isArray(value.chunks)
  ) return false;
  if (signature.enabled) {
    if (
      value.embedding?.provider !== signature.provider ||
      value.embedding?.model !== signature.model ||
      Number(value.embedding?.dimensions) !== signature.dimensions
    ) return false;
  }
  return value.chunks.every((chunk) => (
    chunk && typeof chunk.path === 'string' && typeof chunk.content === 'string' &&
    (!chunk.vector || (
      Array.isArray(chunk.vector) &&
      (!signature.enabled || chunk.vector.length === signature.dimensions) &&
      chunk.vector.every((number) => Number.isFinite(Number(number)))
    ))
  ));
}

function generationUsesAllowedPaths(value, policy) {
  try {
    const chunkIdsByPath = new Map();
    for (const [relative, metadata] of Object.entries(value.files)) {
      const allowed = policy.assertAllowed(relative);
      if (
        allowed.relative !== relative || policy.isExcluded(relative) || !isIndexable(relative) ||
        !metadata || !Array.isArray(metadata.chunks) ||
        metadata.chunks.some((id) => typeof id !== 'string')
      ) return false;
      const ids = new Set(metadata.chunks);
      if (ids.size !== metadata.chunks.length) return false;
      chunkIdsByPath.set(relative, ids);
    }
    const seenIds = new Set();
    for (const chunk of value.chunks) {
      if (
        typeof chunk.id !== 'string' || seenIds.has(chunk.id) ||
        !chunkIdsByPath.get(chunk.path)?.has(chunk.id)
      ) return false;
      seenIds.add(chunk.id);
    }
    for (const ids of chunkIdsByPath.values()) {
      for (const id of ids) if (!seenIds.has(id)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function cloneChunk(chunk) {
  return {
    ...chunk,
    headings: [...(chunk.headings || [])],
    vector: Array.isArray(chunk.vector) ? [...chunk.vector] : null,
  };
}

function safeError(error, secret = '') {
  let message = String(error?.message || 'Index operation failed.');
  if (secret) message = message.split(secret).join('[redacted]');
  return {
    code: String(error?.code || 'KNOWLEDGE_INDEX_ERROR'),
    message: message.slice(0, 500),
  };
}

export class KnowledgeIndex {
  constructor(config, options = {}) {
    if (!config || typeof config !== 'object') throw new TypeError('KnowledgeIndex requires config.');
    this.config = config;
    this.policy = options.policy || new VaultPathPolicy(config.vaultPath, config.excludedPaths || []);
    this.root = this.policy.root;
    this.indexRoot = path.resolve(config.indexDir);
    this.client = options.client || new EmbeddingClient(config.embedding || {});
    this.embeddingEnabled = Boolean(
      this.client.enabled ?? (config.embedding?.provider && config.embedding.provider !== 'disabled'),
    );
    this.signature = embeddingSignature(this.client, this.embeddingEnabled, config.embedding);
    this.watchEnabled = options.watch ?? config.retrieval?.watch !== false;
    this.autoBuild = options.autoBuild !== false;
    this.reconcileIntervalMs = Number(
      options.reconcileIntervalMs ?? config.retrieval?.reconcileIntervalMs ??
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    this.topK = Math.max(1, Math.min(30, Number(config.retrieval?.topK) || 8));
    this.generation = emptyGeneration(this.signature);
    this.manifest = { version: 1, current: null, previous: null };
    this.activeGenerationName = null;
    this.lastError = null;
    this.lastReconciledAt = null;
    this.watchers = [];
    this.watchTimer = null;
    this.reconcileTimer = null;
    this.operationQueue = Promise.resolve();
    this.queryVectors = new Map();
    this.closed = false;
    this.lifecycleController = new AbortController();
    this.storageReady = this.initializeStorage();
    this.ready = this.storageReady.then(() => this.initialize());
  }

  async initializeStorage() {
    if (!this.policy.realRoot) await this.policy.initialize();
    await fsp.mkdir(path.join(this.indexRoot, 'generations'), { recursive: true, mode: 0o700 });
    await this.loadGeneration();
  }

  async initialize() {
    if (this.autoBuild) {
      await this.enqueue(() => this.performRebuild({ signal: this.lifecycleController.signal }));
    }
    await this.refreshWatchers();
    if (!this.closed && Number.isFinite(this.reconcileIntervalMs) && this.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        this.rebuild({ verifyHashes: true, signal: this.lifecycleController.signal }).catch((error) => {
          this.lastError = safeError(error, this.client.apiKey);
        });
      }, this.reconcileIntervalMs);
      this.reconcileTimer.unref?.();
    }
    return this;
  }

  enqueue(operation) {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.catch(() => {});
    return run;
  }

  async readGeneration(name) {
    if (!name || !/^[A-Za-z0-9-]+$/.test(name)) return null;
    const filename = path.join(this.indexRoot, 'generations', `${name}.json`);
    try {
      const parsed = JSON.parse(await fsp.readFile(filename, 'utf8'));
      if (
        parsed?.generation !== name || !validGeneration(parsed, this.signature) ||
        !generationUsesAllowedPaths(parsed, this.policy)
      ) {
        const error = new Error('Index generation is corrupt or incompatible with the embedding configuration.');
        error.code = 'KNOWLEDGE_INDEX_INCOMPATIBLE';
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') this.lastError = safeError(error, this.client.apiKey);
      return null;
    }
  }

  async loadGeneration() {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(this.indexRoot, 'manifest.json'), 'utf8'));
      if (parsed?.version === 1) this.manifest = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') this.lastError = safeError(error, this.client.apiKey);
    }
    const current = await this.readGeneration(this.manifest.current);
    if (current) {
      this.generation = current;
      this.activeGenerationName = current.generation;
      return;
    }
    const previous = await this.readGeneration(this.manifest.previous);
    if (previous) {
      this.generation = previous;
      this.activeGenerationName = previous.generation;
      if (!this.lastError) {
        this.lastError = {
          code: 'KNOWLEDGE_INDEX_FALLBACK',
          message: 'The current index was unavailable; the previous generation was loaded.',
        };
      }
    }
  }

  chunksByPath(generation = this.generation) {
    const output = new Map();
    for (const chunk of generation.chunks) {
      if (!output.has(chunk.path)) output.set(chunk.path, []);
      output.get(chunk.path).push(chunk);
    }
    return output;
  }

  async readVaultFile(relative) {
    if (this.policy.isExcluded(relative) || !isIndexable(relative)) return null;
    let file;
    try {
      file = await this.policy.existingFile(relative, { maxBytes: MAX_TEXT_BYTES });
    } catch (error) {
      if (['VAULT_FILE_NOT_FOUND', 'VAULT_FILE_TOO_LARGE'].includes(error.code)) return null;
      throw error;
    }
    const buffer = await fsp.readFile(file.target);
    if (buffer.includes(0)) return null;
    const content = buffer.toString('utf8');
    return {
      stat: file.stat,
      hash: sha256(buffer),
      chunks: chunkDocument(file.relative, content),
    };
  }

  async embedMissing(chunks, oldChunks, signal) {
    const reusable = new Map();
    if (this.embeddingEnabled) {
      for (const chunk of oldChunks) {
        if (Array.isArray(chunk.vector) && chunk.vector.length === this.signature.dimensions) {
          reusable.set(chunk.chunkHash, chunk.vector);
        }
      }
    }
    const missing = [];
    for (const chunk of chunks) {
      if (Array.isArray(chunk.vector) && chunk.vector.length === this.signature.dimensions) continue;
      const vector = reusable.get(chunk.chunkHash);
      if (vector) chunk.vector = [...vector];
      else {
        chunk.vector = null;
        missing.push(chunk);
      }
    }
    if (!this.embeddingEnabled || !missing.length) {
      return { embedded: 0, missing: missing.length, error: null };
    }
    const batchSize = Math.max(1, Number(this.client.batchSize || this.config.embedding?.batchSize) || 16);
    let embedded = 0;
    try {
      for (let offset = 0; offset < missing.length; offset += batchSize) {
        signal?.throwIfAborted?.();
        const batch = missing.slice(offset, offset + batchSize);
        const vectors = await this.client.embed(batch.map((chunk) => chunk.content), {
          textType: 'document',
          signal,
        });
        if (!Array.isArray(vectors) || vectors.length !== batch.length) {
          const error = new Error('Embedding client returned an unexpected vector count.');
          error.code = 'EMBEDDING_COUNT_MISMATCH';
          throw error;
        }
        vectors.forEach((vector, index) => {
          const normalized = Array.isArray(vector) ? vector.map(Number) : null;
          if (
            !normalized || normalized.length !== this.signature.dimensions ||
            normalized.some((value) => !Number.isFinite(value))
          ) {
            const error = new Error('Embedding client returned an unexpected vector dimension.');
            error.code = 'EMBEDDING_DIMENSION_MISMATCH';
            throw error;
          }
          batch[index].vector = normalized;
          embedded += 1;
        });
      }
      return { embedded, missing: Math.max(0, missing.length - embedded), error: null };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { embedded, missing: Math.max(0, missing.length - embedded), error };
    }
  }

  async persistGeneration(next) {
    const target = path.join(this.indexRoot, 'generations', `${next.generation}.json`);
    await atomicJson(target, next);
    const previous = this.activeGenerationName || this.manifest.previous || null;
    const manifest = { version: 1, current: next.generation, previous };
    await atomicJson(path.join(this.indexRoot, 'manifest.json'), manifest);
    this.generation = next;
    this.activeGenerationName = next.generation;
    this.manifest = manifest;
    this.queryVectors.clear();

    const retained = new Set([manifest.current, manifest.previous].filter(Boolean));
    const entries = await fsp.readdir(path.join(this.indexRoot, 'generations'), { withFileTypes: true });
    await Promise.all(entries.filter((entry) => (
      entry.isFile() && entry.name.endsWith('.json') &&
      !retained.has(entry.name.slice(0, -'.json'.length))
    )).map((entry) => (
      fsp.rm(path.join(this.indexRoot, 'generations', entry.name), { force: true }).catch(() => {})
    )));
  }

  async performRebuild(options = {}) {
    if (this.closed) return this.generation;
    const old = this.generation;
    const oldChunksByPath = this.chunksByPath(old);
    let files = {};
    let chunks = [];
    let changed = old.generation === 'unbuilt';
    const onlyPaths = Array.isArray(options.onlyPaths) ? [] : null;

    if (onlyPaths) {
      files = { ...old.files };
      chunks = old.chunks.map(cloneChunk);
      for (const raw of [...new Set(options.onlyPaths)]) {
        if (this.policy.isExcluded(raw)) continue;
        const { relative } = this.policy.assertAllowed(raw);
        if (!isIndexable(relative)) continue;
        onlyPaths.push(relative);
      }
      for (const relative of onlyPaths) {
        changed = true;
        delete files[relative];
        chunks = chunks.filter((chunk) => chunk.path !== relative);
        const loaded = await this.readVaultFile(relative);
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
      const seen = new Set();
      for await (const relative of this.policy.walk()) {
        options.signal?.throwIfAborted?.();
        if (!isIndexable(relative)) continue;
        seen.add(relative);
        let file;
        try {
          file = await this.policy.existingFile(relative, { maxBytes: MAX_TEXT_BYTES });
        } catch (error) {
          if (error.code === 'VAULT_FILE_TOO_LARGE') {
            if (old.files[relative]) changed = true;
            continue;
          }
          throw error;
        }
        const previous = old.files[relative];
        const metadataMatches = previous &&
          previous.size === file.stat.size &&
          Math.trunc(previous.mtimeMs) === Math.trunc(file.stat.mtimeMs) &&
          Math.trunc(previous.ctimeMs) === Math.trunc(file.stat.ctimeMs);
        if (metadataMatches && !options.verifyHashes) {
          files[relative] = previous;
          chunks.push(...(oldChunksByPath.get(relative) || []).map(cloneChunk));
          continue;
        }
        const loaded = await this.readVaultFile(relative);
        if (!loaded) {
          if (previous) changed = true;
          continue;
        }
        if (previous?.hash === loaded.hash) {
          files[relative] = {
            ...previous,
            size: loaded.stat.size,
            mtimeMs: loaded.stat.mtimeMs,
            ctimeMs: loaded.stat.ctimeMs,
          };
          chunks.push(...(oldChunksByPath.get(relative) || []).map(cloneChunk));
          if (!metadataMatches) changed = true;
        } else {
          changed = true;
          files[relative] = {
            hash: loaded.hash,
            size: loaded.stat.size,
            mtimeMs: loaded.stat.mtimeMs,
            ctimeMs: loaded.stat.ctimeMs,
            chunks: loaded.chunks.map((chunk) => chunk.id),
          };
          chunks.push(...loaded.chunks);
        }
      }
      if (Object.keys(old.files).some((relative) => !seen.has(relative))) changed = true;
    }

    const embedding = await this.embedMissing(chunks, old.chunks, options.signal);
    if (embedding.embedded) changed = true;
    this.lastError = embedding.error ? safeError(embedding.error, this.client.apiKey) : null;
    this.lastReconciledAt = new Date().toISOString();
    if (!changed) {
      await this.refreshWatchers(Object.keys(files));
      return old;
    }

    const next = {
      version: INDEX_VERSION,
      generation: generationId(),
      createdAt: new Date().toISOString(),
      embedding: this.signature,
      files,
      chunks: chunks.sort((left, right) => (
        left.path.localeCompare(right.path) || left.lineStart - right.lineStart
      )),
    };
    await this.persistGeneration(next);
    await this.refreshWatchers(Object.keys(files));
    return next;
  }

  async rebuild(options = {}) {
    await this.storageReady;
    const settings = { ...options, signal: options.signal || this.lifecycleController.signal };
    return this.enqueue(() => this.performRebuild(settings));
  }

  async updatePaths(paths) {
    await this.storageReady;
    return this.enqueue(() => this.performRebuild({
      onlyPaths: Array.isArray(paths) ? paths : [],
      signal: this.lifecycleController.signal,
    }));
  }

  scheduleRebuild() {
    if (this.closed) return;
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.rebuild({ signal: this.lifecycleController.signal }).catch((error) => {
        this.lastError = safeError(error, this.client.apiKey);
      });
    }, WATCH_DEBOUNCE_MS);
    this.watchTimer.unref?.();
  }

  async refreshWatchers(pathsInput = Object.keys(this.generation.files)) {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (!this.watchEnabled || this.closed) return;
    const directories = new Set(['']);
    for (const relative of pathsInput) {
      let directory = path.posix.dirname(relative);
      while (directory && directory !== '.') {
        if (!this.policy.isExcluded(directory)) directories.add(directory);
        const parent = path.posix.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    for (const relative of directories) {
      try {
        if (relative) {
          this.policy.assertAllowed(relative);
          await this.policy.assertNoSymlinks(relative);
        }
        const watcher = fs.watch(
          relative ? path.join(this.root, relative) : this.root,
          { persistent: false },
          () => this.scheduleRebuild(),
        );
        watcher.on('error', () => this.scheduleRebuild());
        this.watchers.push(watcher);
      } catch {}
    }
  }

  async queryVector(query, signal) {
    const key = sha256(`${this.signature.provider}\0${this.signature.model}\0${this.signature.dimensions}\0${query}`);
    const cached = this.queryVectors.get(key);
    if (cached) return { vector: cached, cacheHit: true };
    const vectors = await this.client.embed([query], {
      textType: 'query',
      instruct: QUERY_RETRIEVAL_INSTRUCTION,
      signal,
    });
    const vector = Array.isArray(vectors?.[0]) ? vectors[0].map(Number) : null;
    if (
      !vector || vector.length !== this.signature.dimensions ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      const error = new Error('Embedding client returned an invalid query vector.');
      error.code = 'EMBEDDING_DIMENSION_MISMATCH';
      throw error;
    }
    this.queryVectors.set(key, vector.map(Number));
    while (this.queryVectors.size > QUERY_VECTOR_CACHE_LIMIT) {
      this.queryVectors.delete(this.queryVectors.keys().next().value);
    }
    return { vector, cacheHit: false };
  }

  async search(queryInput, options = {}) {
    await this.ready;
    const query = String(queryInput || '').trim();
    const requestedRoute = String(options.route || 'hybrid').trim().toLowerCase();
    if (!['keyword', 'semantic', 'hybrid'].includes(requestedRoute)) {
      const error = new Error('Search route must be keyword, semantic, or hybrid.');
      error.code = 'INVALID_SEARCH_ROUTE';
      error.status = 400;
      throw error;
    }
    const limit = Math.max(1, Math.min(30, Number(options.limit) || this.topK));
    const diagnostics = {
      requestedRoute,
      effectiveRoute: requestedRoute,
      generation: this.generation.generation,
      embeddingProvider: this.signature.provider,
      embeddingEnabled: this.embeddingEnabled,
      embeddingUsed: false,
      queryVectorCacheHit: false,
      indexedChunks: this.generation.chunks.length,
      embeddedChunks: this.generation.chunks.filter((chunk) => Array.isArray(chunk.vector)).length,
    };
    if (!query) return { route: requestedRoute, query, results: [], diagnostics };

    const recallLimit = Math.max(30, limit * 4);
    const indexedPaths = Object.keys(this.generation.files || {});
    const entityAnchor = explicitEntityAnchor(query);
    const retrievalChunks = entityAnchor
      ? this.generation.chunks.filter((chunk) => chunkContainsEntity(chunk, entityAnchor))
      : this.generation.chunks;
    diagnostics.entityAnchorApplied = Boolean(entityAnchor);
    if (entityAnchor) diagnostics.entityMatchedChunks = retrievalChunks.length;
    const keyword = bm25Search(query, retrievalChunks, recallLimit);
    diagnostics.keywordCandidates = keyword.length;
    if (requestedRoute === 'keyword') {
      return {
        route: 'keyword',
        query,
        results: publicFileResults(keyword, query, limit, indexedPaths),
        diagnostics,
      };
    }

    if (entityAnchor && !retrievalChunks.length) {
      diagnostics.semanticCandidates = 0;
      return {
        route: requestedRoute,
        query,
        results: [],
        diagnostics,
      };
    }

    const embeddedChunks = retrievalChunks.filter((chunk) => (
      Array.isArray(chunk.vector) && chunk.vector.length === this.signature.dimensions
    ));
    if (!this.embeddingEnabled || !embeddedChunks.length) {
      diagnostics.effectiveRoute = 'keyword';
      diagnostics.fallback = this.embeddingEnabled ? 'no-indexed-vectors' : 'embeddings-disabled';
      return {
        route: 'keyword',
        query,
        results: publicFileResults(keyword, query, limit, indexedPaths),
        diagnostics,
      };
    }

    let semantic;
    try {
      const queryEmbedding = await this.queryVector(query, options.signal);
      diagnostics.queryVectorCacheHit = queryEmbedding.cacheHit;
      semantic = vectorSearch(queryEmbedding.vector, embeddedChunks, recallLimit);
      diagnostics.embeddingUsed = true;
      diagnostics.semanticCandidates = semantic.length;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      diagnostics.effectiveRoute = 'keyword';
      diagnostics.fallback = 'embedding-error';
      diagnostics.errorCode = String(error?.code || 'EMBEDDING_ERROR');
      return {
        route: 'keyword',
        query,
        results: publicFileResults(keyword, query, limit, indexedPaths),
        diagnostics,
      };
    }

    if (requestedRoute === 'semantic') {
      return {
        route: 'semantic',
        query,
        results: publicFileResults(semantic, query, limit, indexedPaths),
        diagnostics,
      };
    }
    const fused = reciprocalRankFusion(keyword, semantic);
    return {
      route: 'hybrid',
      query,
      results: publicFileResults(fused, query, limit, indexedPaths),
      diagnostics,
    };
  }

  /**
   * Build a complete logical-file inventory from the immutable active index
   * generation before using content relevance to order it. This deliberately
   * differs from search(): a low BM25/vector score can change ordering inside
   * the requested mtime window, but can never admit an out-of-window file or
   * remove an in-window logical file from the inventory.
   */
  async temporalInventory(queryInput, options = {}) {
    await this.ready;
    options.signal?.throwIfAborted?.();
    const query = String(queryInput || '').trim();
    const startMs = Number(options?.range?.startMs);
    const endMs = Number(options?.range?.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      const error = new Error('Temporal inventory requires a valid [start,end) mtime range.');
      error.code = 'INVALID_TEMPORAL_RANGE';
      error.status = 400;
      throw error;
    }
    const requestedScope = options.scope === 'learning' ? 'learning' : 'all';
    const indexedPaths = Object.keys(this.generation.files || {});
    const chunksByPath = this.chunksByPath(this.generation);
    // Time is the mandatory inclusion gate. Learning classification only
    // affects ordering: diary or inbox notes may contain the user's learning
    // record and must not disappear merely because their directory is not
    // named "learning".
    const eligiblePaths = indexedPaths;
    const invalidMtimePaths = eligiblePaths.filter((relative) => {
      return !validFileMtime(this.generation.files?.[relative]?.mtimeMs);
    });
    const inRangePaths = eligiblePaths.filter((relative) => {
      const mtimeMs = this.generation.files?.[relative]?.mtimeMs;
      return validFileMtime(mtimeMs) && mtimeMs >= startMs && mtimeMs < endMs;
    });
    const learningMatches = new Set(requestedScope === 'learning'
      ? inRangePaths.filter((relative) => (
          learningLikePath(relative) || learningLikeContent(chunksByPath.get(relative))
        ))
      : inRangePaths);
    const scopeApplied = requestedScope !== 'learning' || inRangePaths.length === 0 || learningMatches.size > 0;
    const pathSet = new Set(inRangePaths);
    const inRangeChunks = this.generation.chunks.filter((chunk) => pathSet.has(chunk.path));
    const rankedChunks = bm25Search(query, inRangeChunks, Math.max(1, inRangeChunks.length));
    const rankedById = new Map(rankedChunks.map((chunk, index) => [chunk.id, {
      rank: index,
      score: Number(chunk.bm25Score) || 0,
      matchedTerms: chunk.matchedTerms || [],
    }]));
    const groups = new Map();
    for (const relative of inRangePaths) {
      const key = logicalDocumentKey(relative);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(relative);
    }
    const logicalResults = [];
    for (const [logicalKey, paths] of groups) {
      options.signal?.throwIfAborted?.();
      const orderedPaths = [...paths].sort((left, right) => (
        Number(isOrganizedDocument(right)) - Number(isOrganizedDocument(left)) ||
        Number(this.generation.files?.[right]?.mtimeMs || 0) -
          Number(this.generation.files?.[left]?.mtimeMs || 0) ||
        left.localeCompare(right)
      ));
      const representative = orderedPaths[0];
      const representativeChunks = (chunksByPath.get(representative) || []).map((chunk) => {
        const rank = rankedById.get(chunk.id);
        return {
          ...chunk,
          bm25Score: rank?.score || 0,
          matchedTerms: rank?.matchedTerms || matchedTermsFor(chunk, query),
          temporalRank: rank?.rank ?? Number.MAX_SAFE_INTEGER,
        };
      }).sort((left, right) => (
        left.temporalRank - right.temporalRank || left.lineStart - right.lineStart
      ));
      const best = representativeChunks[0] || {
        path: representative,
        name: path.basename(representative),
        heading: '',
        lineStart: null,
        lineEnd: null,
        content: '',
        matchedTerms: [],
      };
      const allGroupChunks = paths.flatMap((relative) => chunksByPath.get(relative) || []);
      const bestGroupRank = allGroupChunks.reduce((bestRank, chunk) => (
        Math.min(bestRank, rankedById.get(chunk.id)?.rank ?? Number.MAX_SAFE_INTEGER)
      ), Number.MAX_SAFE_INTEGER);
      const bestGroupScore = allGroupChunks.reduce((score, chunk) => (
        Math.max(score, rankedById.get(chunk.id)?.score || 0)
      ), 0);
      const mtimeMs = Math.max(...paths.map((relative) => (
        Number(this.generation.files?.[relative]?.mtimeMs) || 0
      )));
      logicalResults.push({
        path: representative,
        name: best.name || path.basename(representative),
        heading: best.heading || '',
        lineStart: best.lineStart,
        lineEnd: best.lineEnd,
        snippet: snippetFor(best.content, best.matchedTerms),
        content: best.content,
        score: bestGroupScore,
        matchedTerms: best.matchedTerms,
        logicalKey,
        relatedPaths: orderedPaths.slice(1),
        mtimeMs,
        modifiedAt: new Date(mtimeMs).toISOString(),
        scopeMatch: requestedScope !== 'learning' || paths.some((relative) => learningMatches.has(relative)),
        temporalRank: bestGroupRank,
        deepExcerpts: representativeChunks.slice(0, 2).map((chunk) => ({
          path: representative,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          content: chunk.content,
          snippet: snippetFor(chunk.content, chunk.matchedTerms),
          matchedTerms: chunk.matchedTerms,
          mtimeMs,
          modifiedAt: new Date(mtimeMs).toISOString(),
        })),
      });
    }
    logicalResults.sort((left, right) => (
      Number(right.scopeMatch) - Number(left.scopeMatch) ||
      left.temporalRank - right.temporalRank ||
      right.score - left.score ||
      right.mtimeMs - left.mtimeMs ||
      left.path.localeCompare(right.path)
    ));
    const limit = Math.max(1, Math.min(
      TEMPORAL_INVENTORY_MAX_FILES,
      Number(options.limit) || TEMPORAL_INVENTORY_MAX_FILES,
    ));
    const results = logicalResults.slice(0, limit).map(({ temporalRank, ...item }) => item);
    const truncated = results.length < logicalResults.length;
    const metadataComplete = invalidMtimePaths.length === 0 && !truncated;
    const inventory = {
      basis: 'file_mtime',
      range: {
        startMs,
        endMs,
        startInclusive: new Date(startMs).toISOString(),
        endExclusive: new Date(endMs).toISOString(),
        timeZone: String(options?.range?.timeZone || ''),
      },
      scopeRequested: requestedScope,
      scopeApplied,
      totalIndexedFiles: indexedPaths.length,
      eligiblePhysicalFiles: eligiblePaths.length,
      inRangePhysicalFiles: inRangePaths.length,
      scopeMatchedPhysicalFiles: learningMatches.size,
      logicalFilesInRange: logicalResults.length,
      returnedLogicalFiles: results.length,
      invalidMtimeFiles: invalidMtimePaths.length,
      metadataComplete,
      truncated,
      generation: this.generation.generation,
    };
    return {
      route: 'mtime-inventory',
      query,
      results,
      inventory,
      diagnostics: {
        effectiveRoute: 'mtime-inventory',
        generation: this.generation.generation,
        mtimeStartInclusive: inventory.range.startInclusive,
        mtimeEndExclusive: inventory.range.endExclusive,
        scopeRequested: requestedScope,
        scopeApplied,
        indexedFiles: indexedPaths.length,
        inRangePhysicalFiles: inRangePaths.length,
        scopeMatchedPhysicalFiles: learningMatches.size,
        logicalFilesInRange: logicalResults.length,
        returnedLogicalFiles: results.length,
        invalidMtimeFiles: invalidMtimePaths.length,
        metadataComplete,
        truncated,
      },
    };
  }

  /**
   * Pin the exact in-memory generation used by a task. Index updates replace
   * `this.generation` atomically, so retaining this object reference is enough
   * to keep both ordinary searches and mtime inventories coherent without
   * copying a potentially large vector index.
   */
  acquireSnapshot() {
    if (this.closed) {
      const error = new Error('Knowledge index is closed.');
      error.code = 'KNOWLEDGE_INDEX_CLOSED';
      error.status = 503;
      throw error;
    }
    const view = Object.create(this);
    view.generation = this.generation;
    view.activeGenerationName = this.activeGenerationName;
    view.manifest = { ...this.manifest };
    let released = false;
    const assertHeld = () => {
      if (released) {
        const error = new Error('Knowledge index snapshot has already been released.');
        error.code = 'INDEX_SNAPSHOT_RELEASED';
        error.status = 409;
        throw error;
      }
    };
    const documentReads = new Map();
    return Object.freeze({
      generation: String(view.generation?.generation || 'unbuilt'),
      status: () => {
        assertHeld();
        return view.status();
      },
      search: (...args) => {
        assertHeld();
        return view.search(...args);
      },
      temporalInventory: (...args) => {
        assertHeld();
        return view.temporalInventory(...args);
      },
      listDocuments: () => {
        assertHeld();
        return Object.entries(view.generation.files || {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([relative, metadata]) => ({
            path: relative, hash: metadata.hash, size: metadata.size,
          }));
      },
      readDocument: async (relativeInput, options = {}) => {
        assertHeld();
        options.signal?.throwIfAborted?.();
        const { relative } = view.policy.assertAllowed(relativeInput);
        const expected = view.generation.files?.[relative];
        if (!expected) {
          const error = new Error('The document is not present in this index snapshot.');
          error.code = 'INDEX_DOCUMENT_NOT_FOUND';
          error.status = 404;
          throw error;
        }
        if (documentReads.has(relative)) return documentReads.get(relative);
        const file = await view.policy.existingFile(relative, { maxBytes: MAX_TEXT_BYTES });
        const buffer = await fsp.readFile(file.target, { signal: options.signal });
        assertHeld();
        options.signal?.throwIfAborted?.();
        if (sha256(buffer) !== expected.hash) {
          const error = new Error('The document changed after this index snapshot was created.');
          error.code = 'INDEX_DOCUMENT_CHANGED';
          error.status = 409;
          throw error;
        }
        if (buffer.includes(0)) {
          const error = new Error('The indexed document is not a text file.');
          error.code = 'UNSUPPORTED_VAULT_FILE';
          error.status = 415;
          throw error;
        }
        const document = Object.freeze({ path: relative, hash: expected.hash, text: buffer.toString('utf8') });
        documentReads.set(relative, document);
        return document;
      },
      release: () => {
        released = true;
        documentReads.clear();
      },
    });
  }

  status() {
    const embeddedChunks = this.generation.chunks.filter((chunk) => Array.isArray(chunk.vector)).length;
    return {
      available: this.generation.generation !== 'unbuilt',
      generation: this.generation.generation,
      previousGeneration: this.manifest.previous,
      createdAt: this.generation.createdAt,
      files: Object.keys(this.generation.files).length,
      chunks: this.generation.chunks.length,
      embeddedChunks,
      lexicalAvailable: this.generation.generation !== 'unbuilt',
      semanticAvailable: this.embeddingEnabled && embeddedChunks > 0,
      embedding: { ...this.signature },
      watchEnabled: this.watchEnabled,
      lastReconciledAt: this.lastReconciledAt,
      lastError: this.lastError ? { ...this.lastError } : null,
    };
  }

  async close() {
    this.closed = true;
    this.lifecycleController.abort(new DOMException('Index closing', 'AbortError'));
    clearTimeout(this.watchTimer);
    clearInterval(this.reconcileTimer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    await this.operationQueue.catch(() => {});
  }
}

export const knowledgeIndexConstants = {
  INDEX_VERSION,
  MAX_TEXT_BYTES,
  TARGET_CHUNK_CHARACTERS,
  CHUNK_OVERLAP_CHARACTERS,
  WATCH_DEBOUNCE_MS,
  RRF_K,
};

export const knowledgeIndexInternals = {
  explicitEntityAnchor,
  generationUsesAllowedPaths,
  markdownBlocks,
  reciprocalRankFusion,
  publicFileResults,
  queryTermsFor,
  validGeneration,
};
