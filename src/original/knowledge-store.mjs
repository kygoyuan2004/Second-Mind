import { markPublicMessage } from '../public-errors.mjs';
import { resolveSource } from './source-resolver.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.canvas', '.base', '.csv', '.yaml', '.yml', '.log',
]);
const INLINE_MIME_TYPES = new Map([
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.canvas', 'application/json; charset=utf-8'],
  ['.base', 'application/json; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.yaml', 'text/plain; charset=utf-8'],
  ['.yml', 'text/plain; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'],
]);
const DRAFT_KINDS = new Set(['diary', 'plan', 'scratch', 'video']);
const TITLED_DRAFT_KINDS = new Set(['scratch', 'video']);
const MAX_INDEXED_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_DRAFT_TEXT_BYTES = 512 * 1024;
const DRAFT_RETENTION_MS = 24 * 60 * 60_000;
const ATTACHMENT_START = '<!-- yuan-knowledge-attachments:start -->';
const ATTACHMENT_END = '<!-- yuan-knowledge-attachments:end -->';

function knowledgeError(status, message, code = 'KNOWLEDGE_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return markPublicMessage(error);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function cleanRelative(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) {
    throw knowledgeError(400, '知识库路径不合法。', 'INVALID_KNOWLEDGE_PATH');
  }
  const normalized = value.normalize('NFC').replace(/^\/+|\/+$/g, '');
  if (!normalized) throw knowledgeError(400, '缺少知识库路径。', 'INVALID_KNOWLEDGE_PATH');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw knowledgeError(400, '知识库路径不合法。', 'INVALID_KNOWLEDGE_PATH');
  }
  return parts.join('/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function normalizeKeywordSearch(value) {
  return normalizeSearch(value)
    .replace(
      /(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/g,
      (_, year, month, day) => (
        `${year}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`
      ),
    )
    .replace(/\s+/g, ' ')
    .trim();
}

const KEYWORD_STOP_TERMS = new Set([
  '请', '帮我', '查找', '搜索', '检索', '列出', '全部', '所有', '包含', '提到',
  '文件', '内容', '关于', '什么', '哪些', 'the', 'and', 'for', 'with', 'from',
]);

function keywordSearchTerms(query) {
  const normalized = normalizeKeywordSearch(query);
  const terms = [];
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const segment of segmenter.segment(normalized)) {
      const term = normalizeKeywordSearch(segment.segment);
      if (
        segment.isWordLike && term && !KEYWORD_STOP_TERMS.has(term) &&
        (term.length > 1 || /[a-z0-9]/i.test(term))
      ) terms.push(term);
    }
  } catch {
    for (const value of normalized.split(/[^\p{L}\p{N}_$+./-]+/u)) {
      const term = normalizeKeywordSearch(value);
      if (
        term && !KEYWORD_STOP_TERMS.has(term) &&
        (term.length > 1 || /[a-z0-9]/i.test(term))
      ) terms.push(term);
    }
  }
  if (!terms.length && normalized) terms.push(normalized);
  return [...new Set(terms)].slice(0, 16);
}

function searchTerms(query, options = {}) {
  const normalized = normalizeSearch(query).trim();
  if (!normalized) return [];
  const terms = new Set(options.includeWholeQuery === false ? [] : [normalized]);
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    for (const segment of segmenter.segment(normalized)) {
      const term = segment.segment.trim();
      if (segment.isWordLike && (term.length > 1 || /[a-z0-9]/i.test(term))) terms.add(term);
    }
  } catch {
    for (const term of normalized.split(/[^\p{L}\p{N}_+-]+/u)) {
      if (term.length > 1) terms.add(term);
    }
  }
  return [...terms].sort((left, right) => right.length - left.length).slice(0, 16);
}

function occurrences(haystack, needle, limit = 24) {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (count < limit) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    count += 1;
    cursor = found + Math.max(1, needle.length);
  }
  return count;
}

function makeSnippet(content, terms, length = 260) {
  const normalized = normalizeSearch(content);
  let index = -1;
  for (const term of terms) {
    const found = normalized.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) index = 0;
  const start = Math.max(0, index - Math.floor(length / 3));
  const text = content
    .slice(start, start + length)
    .replace(/\s+/g, ' ')
    .trim();
  return `${start > 0 ? '…' : ''}${text}${start + length < content.length ? '…' : ''}`;
}

function keywordSurfaceVariants(term) {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(term);
  if (!date) return [term];
  const [, year, paddedMonth, paddedDay] = date;
  const month = String(Number(paddedMonth));
  const day = String(Number(paddedDay));
  return [
    term,
    `${year}-${month}-${day}`,
    `${year}/${paddedMonth}/${paddedDay}`,
    `${year}/${month}/${day}`,
    `${year}.${paddedMonth}.${paddedDay}`,
    `${year}.${month}.${day}`,
    `${year}年${paddedMonth}月${paddedDay}日`,
    `${year}年${month}月${day}日`,
  ];
}

function normalizedDisplayMap(value) {
  let normalized = '';
  const starts = [];
  let offset = 0;
  for (const symbol of String(value || '')) {
    const start = offset;
    offset += symbol.length;
    const folded = normalizeSearch(symbol);
    normalized += folded;
    for (let index = 0; index < folded.length; index += 1) starts.push(start);
  }
  return { normalized, starts };
}

function keywordSurfaceIndex(line, matchedTerms) {
  const display = normalizedDisplayMap(line);
  let earliest = -1;
  for (const term of matchedTerms) {
    for (const variant of keywordSurfaceVariants(term)) {
      const found = display.normalized.indexOf(normalizeSearch(variant));
      if (found < 0) continue;
      const original = display.starts[found] ?? found;
      if (earliest < 0 || original < earliest) earliest = original;
    }
  }
  return earliest;
}

function makeKeywordSnippet(content, matchedTerms, length = 260) {
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const normalized = normalizeKeywordSearch(line);
    if (!matchedTerms.some((term) => normalized.includes(term))) continue;
    const matchIndex = keywordSurfaceIndex(line, matchedTerms);
    const start = Math.max(0, (matchIndex < 0 ? 0 : matchIndex) - Math.floor(length / 3));
    const raw = line.slice(start, start + length);
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return `${start > 0 ? '…' : ''}${text}${start + length < line.length ? '…' : ''}`;
  }
  return '';
}

function firstHeading(content) {
  return content.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim().slice(0, 160) || '';
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value || '').trim());
  if (!match) throw knowledgeError(400, '日期必须采用 YYYY-MM-DD 格式。', 'INVALID_DATE');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw knowledgeError(400, '日期不存在。', 'INVALID_DATE');
  }
  return {
    year,
    month,
    day,
    canonical: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function safeTitle(value, fallback = '随心记录') {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#^\[\]]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function safeAttachmentName(value, index) {
  const extension = path.extname(String(value || '')).slice(0, 20);
  const stem = path.basename(String(value || ''), extension);
  const cleanedStem = safeTitle(stem, `附件-${index + 1}`).slice(0, 100);
  const cleanedExtension = extension.replace(/[^.a-z0-9_-]/gi, '').toLowerCase();
  return `${cleanedStem}${cleanedExtension}`;
}

function uniqueNames(names, reservedNames = []) {
  const used = new Set(
    reservedNames.map((name) => String(name).toLocaleLowerCase('zh-CN')),
  );
  return names.map((name) => {
    const extension = path.extname(name);
    const stem = path.basename(name, extension);
    let candidate = name;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase('zh-CN'))) {
      candidate = `${stem}-${suffix}${extension}`;
      suffix += 1;
    }
    used.add(candidate.toLocaleLowerCase('zh-CN'));
    return candidate;
  });
}

function stripMarkdownFence(value) {
  const text = String(value || '').trim();
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  return `${(match ? match[1] : text).trim()}\n`;
}

function setDocumentTitle(content, title) {
  const heading = `# ${title}`;
  if (/^#\s+.+$/m.test(content)) return content.replace(/^#\s+.+$/m, heading);
  return `${heading}\n\n${content.trim()}\n`;
}

function extractAttachmentLines(content) {
  const pattern = new RegExp(`${ATTACHMENT_START}([\\s\\S]*?)${ATTACHMENT_END}`, 'g');
  const lines = [];
  for (const match of String(content || '').matchAll(pattern)) {
    lines.push(...match[1].split(/\r?\n/).map((line) => line.trim()).filter((line) => (
      /^-\s+!?\[\[[^\]\r\n]+\]\]$/.test(line)
    )));
  }
  return [...new Set(lines)];
}

function attachmentBlock(assetFolder, attachments, preservedLines = []) {
  const addedLines = attachments.map((attachment) => {
    const target = `${assetFolder}/${attachment.finalName}`;
    return ['image', 'pdf'].includes(attachment.kind)
      ? `- ![[${target}]]`
      : `- [[${target}]]`;
  });
  const lines = [...new Set([...preservedLines, ...addedLines])];
  if (!lines.length) return '';
  return [ATTACHMENT_START, '## 附件', '', ...lines, ATTACHMENT_END].join('\n');
}

function withAttachmentBlock(content, assetFolder, attachments, preservedLines = []) {
  const pattern = new RegExp(`${ATTACHMENT_START}[\\s\\S]*?${ATTACHMENT_END}`, 'g');
  const cleaned = String(content || '').replace(pattern, '').trim();
  const block = attachmentBlock(assetFolder, attachments, preservedLines);
  return `${cleaned}${block ? `\n\n${block}` : ''}\n`;
}

export class KnowledgeStore {
  constructor(options = {}) {
    this.requireStructure = options.requireStructure !== false;
    this.root = path.resolve(
      options.root || process.env.KNOWLEDGE_ROOT || path.resolve(process.env.VAULT_PATH || 'vault'),
    );
    this.draftRoot = path.resolve(
      options.draftRoot ||
        process.env.KNOWLEDGE_DRAFT_DIR ||
        path.resolve(process.env.DATA_DIR || 'data', 'sdk-drafts'),
    );
    this.auditFile = path.resolve(
      options.auditFile ||
        process.env.KNOWLEDGE_AUDIT_FILE ||
        path.resolve(process.env.DATA_DIR || 'data', 'sdk-audit.jsonl'),
    );
    this.paths = {
      diary: 'daily_doc/日记',
      plan: 'daily_doc/计划',
      scratch: 'daily_doc/随心草稿',
      video: 'daily_doc/随心草稿/视频整理',
    };
    this.templates = {
      diary: 'daily_doc/日记/模板 1.md',
      plan: 'daily_doc/计划/模板 1.md',
    };
    this.realRoot = null;
    this.index = options.index || null;
  }

  attachIndex(index) {
    this.index = index || null;
    return this;
  }

  async initialize() {
    const rootStat = await fsp.stat(this.root).catch(() => null);
    if (!rootStat?.isDirectory()) {
      throw knowledgeError(503, `知识库目录不可用：${this.root}`, 'KNOWLEDGE_ROOT_UNAVAILABLE');
    }
    this.realRoot = await fsp.realpath(this.root);
    await fsp.mkdir(this.draftRoot, { recursive: true, mode: 0o700 });
    const realDraftRoot = await fsp.realpath(this.draftRoot);
    if (isInside(this.realRoot, realDraftRoot)) {
      throw knowledgeError(500, '临时草稿目录不能位于 Obsidian 知识库内。', 'UNSAFE_DRAFT_ROOT');
    }
    for (const relative of [...Object.values(this.paths), ...Object.values(this.templates)]) {
      const target = path.join(this.root, relative);
      const stat = await fsp.lstat(target).catch(() => null);
      if ((!stat && this.requireStructure) || stat?.isSymbolicLink()) {
        throw knowledgeError(503, `知识库必要路径不可用：${relative}`, 'KNOWLEDGE_PATH_UNAVAILABLE');
      }
    }
    await this.cleanupDrafts();
    return this;
  }

  resolve(relative) {
    const clean = cleanRelative(relative);
    const target = path.resolve(this.root, clean);
    if (!isInside(this.root, target)) {
      throw knowledgeError(400, '路径超出知识库范围。', 'INVALID_KNOWLEDGE_PATH');
    }
    return { clean, target };
  }

  async assertPathNoSymlinks(relative) {
    const clean = cleanRelative(relative);
    let cursor = this.root;
    for (const part of clean.split('/')) {
      cursor = path.join(cursor, part);
      const stat = await fsp.lstat(cursor).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) break;
      if (stat.isSymbolicLink()) {
        throw knowledgeError(400, '知识库路径包含符号链接，已拒绝访问。', 'KNOWLEDGE_SYMLINK_DENIED');
      }
    }
  }

  async assertNoSymlinks(relative = '') {
    const directory = relative ? path.join(this.root, relative) : this.root;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw knowledgeError(
          503,
          `知识库包含不允许的符号链接：${child}`,
          'KNOWLEDGE_SYMLINK_DENIED',
        );
      }
      if (entry.isDirectory()) await this.assertNoSymlinks(child);
    }
  }

  async resolveSource(reference) {
    return resolveSource(reference, {
      existingFile: (relative) => this.existingFile(relative),
      walk: () => this.walk(),
    });
  }

  async existingFile(relative) {
    const { clean, target } = this.resolve(relative);
    await this.assertPathNoSymlinks(clean);
    const stat = await fsp.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') throw knowledgeError(404, '知识库文件不存在。', 'FILE_NOT_FOUND');
      throw error;
    });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw knowledgeError(400, '目标不是可读取的普通文件。', 'INVALID_KNOWLEDGE_FILE');
    }
    const realTarget = await fsp.realpath(target);
    if (!isInside(this.realRoot, realTarget)) {
      throw knowledgeError(400, '不能通过链接访问知识库之外的文件。', 'INVALID_KNOWLEDGE_PATH');
    }
    return {
      relative: clean,
      target: realTarget,
      stat,
      mime: INLINE_MIME_TYPES.get(path.extname(clean).toLowerCase()) || 'application/octet-stream',
    };
  }

  async *walk(relative = '') {
    const directory = relative ? path.join(this.root, relative) : this.root;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) yield* this.walk(child);
      else if (entry.isFile()) yield child;
    }
  }

  async search(queryInput, options = {}) {
    const query = String(queryInput || '').trim();
    if (!query) return [];
    const allowLongQuery = options.allowLongQuery === true;
    if (query.length > 200 && !allowLongQuery) {
      throw knowledgeError(413, '检索词最多 200 个字符。', 'SEARCH_QUERY_TOO_LONG');
    }
    const terms = searchTerms(query, {
      includeWholeQuery: query.length <= 200,
    });
    const limit = Math.max(1, Math.min(30, Number(options.limit) || 30));
    const results = [];
    for await (const relative of this.walk()) {
      const extension = path.extname(relative).toLowerCase();
      const name = path.basename(relative);
      const normalizedPath = normalizeSearch(relative);
      const normalizedName = normalizeSearch(name);
      let score = 0;
      for (const term of terms) {
        score += occurrences(normalizedName, term, 4) * 18;
        score += occurrences(normalizedPath, term, 6) * 7;
      }
      let content = '';
      let heading = '';
      if (TEXT_EXTENSIONS.has(extension)) {
        const target = path.join(this.root, relative);
        const stat = await fsp.stat(target);
        if (stat.size <= MAX_INDEXED_TEXT_BYTES) {
          content = await fsp.readFile(target, 'utf8').catch(() => '');
          if (content.includes('\u0000')) content = '';
          const normalizedContent = normalizeSearch(content);
          heading = firstHeading(content);
          const normalizedHeading = normalizeSearch(heading);
          for (const term of terms) {
            score += occurrences(normalizedHeading, term, 6) * 12;
            score += occurrences(normalizedContent, term, 24) * 2;
          }
        }
      }
      if (score <= 0) continue;
      results.push({
        path: relative,
        name,
        heading,
        mime: INLINE_MIME_TYPES.get(extension) || 'application/octet-stream',
        snippet: content ? makeSnippet(content, terms) : '',
        score,
      });
    }
    return results
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, 'zh-CN'))
      .slice(0, limit);
  }

  async keywordSearch(queryInput, options = {}) {
    const query = String(queryInput || '').trim();
    if (!query) return [];
    if (query.length > 200) {
      throw knowledgeError(413, '检索词最多 200 个字符。', 'SEARCH_QUERY_TOO_LONG');
    }
    const phrase = normalizeKeywordSearch(query);
    const terms = keywordSearchTerms(query);
    const limit = Math.max(1, Math.min(30, Number(options.limit) || 30));
    const results = [];
    for await (const relative of this.walk()) {
      const extension = path.extname(relative).toLowerCase();
      const name = path.basename(relative);
      const normalizedPath = normalizeKeywordSearch(relative);
      const normalizedName = normalizeKeywordSearch(name);
      let content = '';
      let heading = '';
      if (TEXT_EXTENSIONS.has(extension)) {
        const target = path.join(this.root, relative);
        const stat = await fsp.stat(target);
        if (stat.size <= MAX_INDEXED_TEXT_BYTES) {
          content = await fsp.readFile(target, 'utf8').catch(() => '');
          if (content.includes('\u0000')) content = '';
          heading = firstHeading(content);
        }
      }
      const normalizedHeading = normalizeKeywordSearch(heading);
      const normalizedContent = normalizeKeywordSearch(content);
      const fields = [normalizedPath, normalizedName, normalizedHeading, normalizedContent];
      const phraseMatched = Boolean(phrase && fields.some((field) => field.includes(phrase)));
      const allTermsMatched = Boolean(
        terms.length && terms.every((term) => fields.some((field) => field.includes(term))),
      );
      if (!phraseMatched && !allTermsMatched) continue;
      const matchedTerms = [...new Set([
        ...(phraseMatched ? [phrase] : []),
        ...terms.filter((term) => fields.some((field) => field.includes(term))),
      ])].sort((left, right) => right.length - left.length);
      const contentMatchedTerms = matchedTerms.filter((term) => normalizedContent.includes(term));
      let score = 0;
      if (normalizedName.includes(phrase)) score += 120;
      if (normalizedPath.includes(phrase)) score += 90;
      if (normalizedHeading.includes(phrase)) score += 70;
      if (normalizedContent.includes(phrase)) score += 40;
      for (const term of terms) {
        if (normalizedName.includes(term)) score += 18;
        if (normalizedPath.includes(term)) score += 12;
        if (normalizedHeading.includes(term)) score += 10;
        if (normalizedContent.includes(term)) score += 3;
      }
      results.push({
        path: relative,
        name,
        heading,
        mime: INLINE_MIME_TYPES.get(extension) || 'application/octet-stream',
        snippet: contentMatchedTerms.length
          ? makeKeywordSnippet(content, contentMatchedTerms)
          : '',
        matchedTerms,
        score,
      });
    }
    return results
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path, 'zh-CN'))
      .slice(0, limit);
  }

  async semanticSearch(queryInput, options = {}) {
    const query = String(queryInput || '').trim();
    if (query.length > 200 && options.allowLongQuery !== true) {
      throw knowledgeError(413, '检索词最多 200 个字符。', 'SEARCH_QUERY_TOO_LONG');
    }
    const status = this.index?.status?.();
    if (!status?.available) {
      throw knowledgeError(503, '语义检索暂不可用。', 'SEMANTIC_SEARCH_UNAVAILABLE');
    }
    const result = await this.index.search(query, { ...options, route: 'semantic' });
    if (
      result?.diagnostics?.fallback === 'bm25' ||
      result?.diagnostics?.embeddingUsed === false
    ) {
      throw knowledgeError(
        503,
        '语义检索暂不可用。',
        'SEMANTIC_SEARCH_UNAVAILABLE',
      );
    }
    return result;
  }

  async hybridSearch(queryInput, options = {}) {
    if (!this.index) {
      return {
        route: 'legacy',
        query: String(queryInput || '').trim(),
        results: await this.search(queryInput, options),
        diagnostics: { fallback: 'legacy-scan', embeddingUsed: false, rerankerUsed: false },
      };
    }
    try {
      return await this.index.search(queryInput, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return {
        route: 'legacy',
        query: String(queryInput || '').trim(),
        results: await this.search(queryInput, options),
        diagnostics: {
          fallback: 'legacy-scan',
          embeddingUsed: false,
          rerankerUsed: false,
          warning: error?.code || 'KNOWLEDGE_INDEX_UNAVAILABLE',
        },
      };
    }
  }

  async findDatedTarget(kind, dateInput) {
    if (!['diary', 'plan'].includes(kind)) {
      throw knowledgeError(400, '记录类型不正确。', 'INVALID_DRAFT_KIND');
    }
    const date = parseDate(dateInput);
    const directoryRelative = this.paths[kind];
    const directory = path.join(this.root, directoryRelative);
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    const existing = entries.find((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) return false;
      const match = /^(\d{4})-(\d{1,2})-(\d{1,2})\.md$/.exec(entry.name);
      return Boolean(
        match &&
        Number(match[1]) === date.year &&
        Number(match[2]) === date.month &&
        Number(match[3]) === date.day,
      );
    });
    const filename = existing?.name || `${date.canonical}.md`;
    return { date: date.canonical, relative: `${directoryRelative}/${filename}`, exists: Boolean(existing) };
  }

  async prepareDatedDocument(kind, dateInput) {
    const target = await this.findDatedTarget(kind, dateInput);
    const template = await fsp.readFile(path.join(this.root, this.templates[kind]), 'utf8');
    let current = '';
    if (target.exists) current = await fsp.readFile(path.join(this.root, target.relative), 'utf8');
    return {
      ...target,
      template: template.replaceAll('YYYY-MM-DD', target.date),
      current,
      sourceHash: target.exists ? sha256(Buffer.from(current)) : null,
    };
  }

  async chooseTitledTarget(kind, titleInput) {
    if (!TITLED_DRAFT_KINDS.has(kind)) {
      throw knowledgeError(400, '记录类型不正确。', 'INVALID_DRAFT_KIND');
    }
    const baseTitle = safeTitle(titleInput, kind === 'video' ? '视频整理' : '随心记录');
    let suffix = 1;
    while (suffix < 10_000) {
      const title = suffix === 1 ? baseTitle : `${baseTitle}-${suffix}`;
      const relative = `${this.paths[kind]}/${title}.md`;
      const assetRelative = `${this.paths[kind]}/assets/${title}`;
      const [noteExists, assetsExist] = await Promise.all([
        fsp.lstat(path.join(this.root, relative)).then(() => true, () => false),
        fsp.lstat(path.join(this.root, assetRelative)).then(() => true, () => false),
      ]);
      if (!noteExists && !assetsExist) return { title, relative, assetRelative };
      suffix += 1;
    }
    throw knowledgeError(409, '无法生成不冲突的记录文件名。', 'DRAFT_NAME_CONFLICT');
  }

  async createDraft({ userId, kind, content, date, prepared, attachments = [] }) {
    if (!DRAFT_KINDS.has(kind)) {
      throw knowledgeError(400, '只有日记、计划、随心记和视频整理可以生成草稿。', 'INVALID_DRAFT_KIND');
    }
    let normalizedContent = stripMarkdownFence(content);
    if (!normalizedContent.trim()) {
      throw knowledgeError(502, 'AI 没有生成可保存的 Markdown。', 'EMPTY_DRAFT');
    }
    if (Buffer.byteLength(normalizedContent) > MAX_DRAFT_TEXT_BYTES) {
      throw knowledgeError(413, '生成的草稿超过 512 KB。', 'DRAFT_TOO_LARGE');
    }
    const id = crypto.randomUUID();
    let title = '';
    let targetRelative;
    let sourceHash = null;
    let assetRelative = '';
    let existingAttachmentLines = [];
    if (TITLED_DRAFT_KINDS.has(kind)) {
      const fallback = kind === 'video' ? '视频整理' : '随心记录';
      title = safeTitle(firstHeading(normalizedContent), `${fallback}-${new Date().toISOString().slice(0, 10)}`);
      const target = await this.chooseTitledTarget(kind, title);
      title = target.title;
      targetRelative = target.relative;
      assetRelative = target.assetRelative;
      normalizedContent = setDocumentTitle(normalizedContent, title);
    } else {
      if (!prepared || prepared.date !== parseDate(date).canonical) {
        throw knowledgeError(409, '草稿日期上下文已经失效。', 'DRAFT_CONTEXT_INVALID');
      }
      targetRelative = prepared.relative;
      sourceHash = prepared.sourceHash;
      assetRelative = `${this.paths[kind]}/assets/${prepared.date}`;
      existingAttachmentLines = extractAttachmentLines(prepared.current);
    }

    let reservedAttachmentNames = [];
    if (assetRelative) {
      const assetDirectory = path.join(this.root, assetRelative);
      const assetStat = await fsp.lstat(assetDirectory).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (assetStat?.isSymbolicLink() || (assetStat && !assetStat.isDirectory())) {
        throw knowledgeError(409, '附件目录不再是普通目录。', 'DRAFT_CONFLICT');
      }
      if (assetStat) reservedAttachmentNames = await fsp.readdir(assetDirectory);
    }
    const finalNames = uniqueNames(
      attachments.map((attachment, index) => safeAttachmentName(attachment.name, index)),
      reservedAttachmentNames,
    );
    const persistedAttachments = attachments.map((attachment, index) => ({
      originalName: String(attachment.name || finalNames[index]).slice(0, 160),
      finalName: finalNames[index],
      type: String(attachment.type || 'application/octet-stream'),
      kind: String(attachment.kind || 'file'),
      bytes: attachment.buffer.length,
      tempName: `${String(index + 1).padStart(2, '0')}-${crypto.randomUUID()}.bin`,
    }));
    if (persistedAttachments.length || existingAttachmentLines.length) {
      const relativeAssetFromNote = path
        .relative(path.dirname(targetRelative), assetRelative)
        .split(path.sep)
        .join('/');
      normalizedContent = withAttachmentBlock(
        normalizedContent,
        relativeAssetFromNote,
        persistedAttachments,
        existingAttachmentLines,
      );
    }
    const now = new Date();
    const metadata = {
      version: 1,
      id,
      userId,
      kind,
      title,
      date: date || null,
      targetRelative,
      assetRelative,
      sourceHash,
      content: normalizedContent,
      attachments: persistedAttachments,
      existingAttachmentLines,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DRAFT_RETENTION_MS).toISOString(),
    };
    const directory = path.join(this.draftRoot, id);
    await fsp.mkdir(directory, { mode: 0o700 });
    try {
      await Promise.all(attachments.map((attachment, index) => (
        fsp.writeFile(
          path.join(directory, persistedAttachments[index].tempName),
          attachment.buffer,
          { mode: 0o600, flag: 'wx' },
        )
      )));
      await fsp.writeFile(
        path.join(directory, 'draft.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
    } catch (error) {
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await this.audit({ action: 'draft_created', userId, draftId: id, kind, targetRelative });
    return this.publicDraft(metadata);
  }

  draftDirectory(id) {
    if (!/^[a-f0-9-]{36}$/i.test(String(id || ''))) {
      throw knowledgeError(404, '草稿不存在。', 'DRAFT_NOT_FOUND');
    }
    return path.join(this.draftRoot, id);
  }

  async readDraft(userId, id) {
    const directory = this.draftDirectory(id);
    let draft;
    try {
      draft = JSON.parse(await fsp.readFile(path.join(directory, 'draft.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw knowledgeError(404, '草稿不存在或已经过期。', 'DRAFT_NOT_FOUND');
      throw error;
    }
    if (draft.userId !== userId) throw knowledgeError(404, '草稿不存在。', 'DRAFT_NOT_FOUND');
    if (new Date(draft.expiresAt).getTime() <= Date.now()) {
      await fsp.rm(directory, { recursive: true, force: true });
      throw knowledgeError(410, '草稿已经过期，请重新生成。', 'DRAFT_EXPIRED');
    }
    return { directory, draft };
  }

  publicDraft(draft) {
    return {
      id: draft.id,
      kind: draft.kind,
      title: draft.title,
      date: draft.date,
      targetPath: draft.targetRelative,
      content: draft.content,
      attachments: draft.attachments.map(({ originalName, finalName, type, kind, bytes }) => ({
        originalName, finalName, type, kind, bytes,
      })),
      createdAt: draft.createdAt,
      expiresAt: draft.expiresAt,
    };
  }

  async getDraft(userId, id) {
    const { draft } = await this.readDraft(userId, id);
    return this.publicDraft(draft);
  }

  async deleteDraft(userId, id) {
    const { directory, draft } = await this.readDraft(userId, id);
    await fsp.rm(directory, { recursive: true, force: true });
    await this.audit({ action: 'draft_deleted', userId, draftId: id, kind: draft.kind });
    return { ok: true };
  }

  async currentHash(relative) {
    const target = path.join(this.root, relative);
    try {
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw knowledgeError(409, '目标路径不再是普通文件。', 'DRAFT_CONFLICT');
      }
      return sha256(await fsp.readFile(target));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveDraft(userId, id, changes = {}) {
    const { directory: draftDirectory, draft } = await this.readDraft(userId, id);
    let content = stripMarkdownFence(changes.content ?? draft.content);
    if (!content.trim() || Buffer.byteLength(content) > MAX_DRAFT_TEXT_BYTES) {
      throw knowledgeError(413, '草稿内容为空或超过 512 KB。', 'INVALID_DRAFT_CONTENT');
    }
    let title = draft.title;
    let targetRelative = draft.targetRelative;
    let assetRelative = draft.assetRelative;
    if (TITLED_DRAFT_KINDS.has(draft.kind)) {
      title = safeTitle(changes.title ?? draft.title);
      const currentBase = path.basename(targetRelative, '.md');
      if (title !== currentBase || await this.currentHash(targetRelative) !== null) {
        const target = await this.chooseTitledTarget(draft.kind, title);
        title = target.title;
        targetRelative = target.relative;
        assetRelative = target.assetRelative;
      }
      content = setDocumentTitle(content, title);
    } else {
      const current = await this.currentHash(targetRelative);
      if (current !== draft.sourceHash) {
        throw knowledgeError(
          409,
          '目标文件在草稿生成后已发生变化，请重新生成合并预览。',
          'DRAFT_CONFLICT',
        );
      }
    }
    const existingAttachmentLines = Array.isArray(draft.existingAttachmentLines)
      ? draft.existingAttachmentLines : [];
    if (draft.attachments.length || existingAttachmentLines.length) {
      const relativeAssetFromNote = path
        .relative(path.dirname(targetRelative), assetRelative)
        .split(path.sep)
        .join('/');
      content = withAttachmentBlock(
        content,
        relativeAssetFromNote,
        draft.attachments,
        existingAttachmentLines,
      );
    }

    const target = path.join(this.root, targetRelative);
    const targetParent = path.dirname(target);
    const realParent = await fsp.realpath(targetParent);
    if (!isInside(this.realRoot, realParent)) {
      throw knowledgeError(400, '目标目录超出知识库范围。', 'INVALID_KNOWLEDGE_PATH');
    }
    const allowedRoot = path.join(this.root, this.paths[draft.kind]);
    if (!isInside(allowedRoot, target)) {
      throw knowledgeError(403, '草稿目标不在允许写入的目录中。', 'KNOWLEDGE_WRITE_DENIED');
    }

    const noteTemporary = path.join(targetParent, `.yuan-knowledge-${id}.tmp`);
    let finalAssetDirectory = '';
    let createdAssetDirectory = false;
    const copiedAttachments = [];
    await fsp.writeFile(noteTemporary, content, { mode: 0o640, flag: 'wx' });
    try {
      if (draft.attachments.length) {
        const assetRoot = path.join(this.root, this.paths[draft.kind], 'assets');
        await fsp.mkdir(assetRoot, { recursive: true });
        const realAssetRoot = await fsp.realpath(assetRoot);
        if (!isInside(this.realRoot, realAssetRoot)) {
          throw knowledgeError(400, '附件目录超出知识库范围。', 'INVALID_KNOWLEDGE_PATH');
        }
        finalAssetDirectory = path.join(this.root, assetRelative);
        if (!isInside(realAssetRoot, finalAssetDirectory)) {
          throw knowledgeError(400, '附件目录超出允许范围。', 'INVALID_KNOWLEDGE_PATH');
        }
        const finalAssetStat = await fsp.lstat(finalAssetDirectory).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (finalAssetStat?.isSymbolicLink() || (finalAssetStat && !finalAssetStat.isDirectory())) {
          throw knowledgeError(409, '附件目录不再是普通目录。', 'DRAFT_CONFLICT');
        }
        if (!finalAssetStat) {
          await fsp.mkdir(finalAssetDirectory, { mode: 0o750 });
          createdAssetDirectory = true;
        }
        const realFinalAssetDirectory = await fsp.realpath(finalAssetDirectory);
        if (!isInside(realAssetRoot, realFinalAssetDirectory)) {
          throw knowledgeError(400, '附件目录超出允许范围。', 'INVALID_KNOWLEDGE_PATH');
        }
        for (const attachment of draft.attachments) {
          const destination = path.join(realFinalAssetDirectory, attachment.finalName);
          await fsp.copyFile(
            path.join(draftDirectory, attachment.tempName),
            destination,
            fs.constants.COPYFILE_EXCL,
          );
          copiedAttachments.push(destination);
        }
      }
      await fsp.rename(noteTemporary, target);
    } catch (error) {
      await fsp.rm(noteTemporary, { force: true }).catch(() => {});
      await Promise.all(copiedAttachments.map((file) => fsp.rm(file, { force: true }).catch(() => {})));
      if (createdAssetDirectory && finalAssetDirectory) {
        await fsp.rmdir(finalAssetDirectory).catch(() => {});
      }
      if (error.code === 'EEXIST') {
        throw knowledgeError(409, '附件名称发生冲突，请重新生成草稿。', 'DRAFT_CONFLICT');
      }
      throw error;
    }
    const finalHash = sha256(Buffer.from(content));
    await fsp.rm(draftDirectory, { recursive: true, force: true });
    await this.audit({
      action: 'draft_saved',
      userId,
      draftId: id,
      kind: draft.kind,
      targetRelative,
      beforeHash: draft.sourceHash,
      afterHash: finalHash,
      attachmentCount: draft.attachments.length,
    });
    this.index?.updatePaths([targetRelative]).catch(() => {});
    return { ok: true, path: targetRelative, hash: finalHash, title };
  }

  async cleanupDrafts() {
    const entries = await fsp.readdir(this.draftRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
      const directory = path.join(this.draftRoot, entry.name);
      try {
        const metadata = JSON.parse(await fsp.readFile(path.join(directory, 'draft.json'), 'utf8'));
        if (new Date(metadata.expiresAt).getTime() > Date.now()) continue;
      } catch {
        const stat = await fsp.stat(directory).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs < DRAFT_RETENTION_MS) continue;
      }
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }

  async audit(event) {
    const entry = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    await fsp.mkdir(path.dirname(this.auditFile), { recursive: true, mode: 0o700 });
    await fsp.appendFile(this.auditFile, entry, { mode: 0o600 });
  }
}

export const knowledgeInternals = {
  cleanRelative,
  parseDate,
  safeTitle,
  searchTerms,
  stripMarkdownFence,
  withAttachmentBlock,
};
