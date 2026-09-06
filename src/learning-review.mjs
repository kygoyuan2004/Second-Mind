import { createHash } from 'node:crypto';
import { parseVaultTemporalRequest } from './temporal-query.mjs';

export const learningReviewLimits = Object.freeze({
  maxBatchChars: 24_000, maxBatches: 12, maxTotalChars: 240_000,
  concurrency: 2, extractionTimeoutMs: 180_000, extractionOutputTokens: 12_000,
  maxRelatedQueries: 8, maxRelatedDocuments: 24, maxFactChars: 40_000,
});

const ALL_SCOPE = /^(?:所有(?:的)?|全部(?:的)?|都(?:要|总结)?|所有方向|全部方向|各个方向|all(?:\s+of\s+them)?)[。.!！\s]*$/iu;
const LEARNING = /学习|学了|学过|复习|读书|阅读|课程|learn|stud(?:y|ied|ies)|reading/iu;
const RECAP = /总结|回顾|盘点|汇总|学(?:习)?了什么|学(?:习)?了哪些|学习.{0,8}(?:重点|进展|情况|内容)|summari[sz]e|recap|review|what\s+(?:did|have)\s+i/iu;
const PERSONAL = /我(?:的|们)?|本人|自己|知识库|笔记|日记|\b(?:my|i|we|vault)\b/iu;
const PUBLIC_SUBJECT = /(?:学生|同学|这个模型|该模型|模型训练|人工智能|行业|市场|政策|新闻|发表|最新论文|公开|全球).{0,24}(?:学习|研究|进展|内容|更新)|(?:学习|研究).{0,16}(?:行业|全球|最新进展)|\b(?:industry|students?|news)\b/iu;
const PUBLIC_RESEARCH = /(?:机器学习|深度学习|强化学习|研究|论文|行业|领域|学术).{0,12}(?:最新|进展|趋势|动态|发展)|(?:最新|前沿).{0,12}(?:研究|论文|进展|趋势)/u;
const DAY_MS = 86_400_000;

function digest(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 20); }
function short(value, limit) { return String(value || '').trim().slice(0, limit); }
function calendarDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return null;
  return date.toISOString().slice(0, 10);
}
function validDay(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  return match ? calendarDate(...match.slice(1)) : null;
}
function localDay(epoch, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(epoch)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function localStamp(epoch, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function windowDays(review) {
  const start = Date.parse(review?.range?.startInclusive);
  const end = Date.parse(review?.range?.endExclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
  try {
    return { start: localDay(start, review.range.timeZone), end: localDay(end - 1, review.range.timeZone) };
  } catch { return null; }
}

export function normalizeLearningReview(value) {
  if (!value || value.kind !== 'personal_learning_review') return null;
  const range = value.range || {};
  const start = Date.parse(range.startInclusive);
  const end = Date.parse(range.endExclusive);
  const captured = Date.parse(value.capturedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isFinite(captured)) return null;
  const normalized = {
    kind: 'personal_learning_review',
    originalQuestion: short(value.originalQuestion, 4_000),
    scope: 'all',
    range: {
      startInclusive: new Date(start).toISOString(), endExclusive: new Date(end).toISOString(),
      timeZone: short(range.timeZone, 80) || 'Asia/Shanghai',
    },
    capturedAt: new Date(captured).toISOString(),
  };
  if (!normalized.originalQuestion || !windowDays(normalized)) return null;
  normalized.range.startLocal = localStamp(start, normalized.range.timeZone);
  normalized.range.endLocal = localStamp(end, normalized.range.timeZone);
  return normalized;
}

/** Personal recaps are a local activity question even when Chinese omits 我. */
export function resolveLearningReviewRequest(question, options = {}) {
  const raw = short(question, 4_000).normalize('NFKC');
  if (!raw) return null;
  if (ALL_SCOPE.test(raw)) {
    const previous = normalizeLearningReview(options.previousReview);
    if (previous) return previous;
    for (const message of [...(options.history || [])].reverse()) {
      if (message?.role !== 'user' || ALL_SCOPE.test(String(message.content || ''))) continue;
      // Only the nearest complete user request may supply the missing intent.
      // Do not reach through a newer unrelated question into a stale recap.
      return resolveLearningReviewRequest(message.content, {
        now: Number.isFinite(Date.parse(message.at)) ? Date.parse(message.at) : options.now,
        timeZone: options.timeZone,
      });
    }
    return null;
  }
  if (!LEARNING.test(raw) || !RECAP.test(raw)) return null;
  if (/(?:修改|更新|新增|创建).{0,8}(?:文件|笔记)|(?:文件|笔记).{0,8}(?:修改|更新|新增|创建)/u.test(raw)) return null;
  if ((PUBLIC_SUBJECT.test(raw) || PUBLIC_RESEARCH.test(raw)) && !/(?:总结|回顾|盘点|汇总).{0,12}(?:我(?:的)?|本人|自己)(?!想|要知道)|(?:我|本人|自己).{0,18}(?:学(?:习)?了|读了|复习了|学习重点)/u.test(raw)) return null;
  if (!PERSONAL.test(raw) && !/(?:总结|回顾|盘点|汇总).{0,35}学习(?:的)?(?:重点|内容|情况|进展)|(?:最近|过去|本月|上月|本周|上周).{0,20}学习重点/u.test(raw)) return null;
  const now = Number(options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now());
  if (!Number.isFinite(now)) return null;
  const parsed = parseVaultTemporalRequest(`我的知识库 ${raw}`, { now, timeZone: options.timeZone });
  if (!parsed) return null;
  return normalizeLearningReview({
    kind: 'personal_learning_review', originalQuestion: raw, scope: 'all',
    range: parsed.range, capturedAt: new Date(now).toISOString(),
  });
}

function fullDates(value) {
  return [...String(value || '').matchAll(/(?<!\d)((?:19|20)\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?(?!\d)/gu)]
    .map((match) => ({ day: calendarDate(match[1], match[2], match[3]), index: match.index, end: match.index + match[0].length }))
    .filter((item) => item.day);
}
function dateExpression(value, years, allowShort = false) {
  const text = String(value || '');
  const full = fullDates(text);
  if (full.length) {
    const first = full[0];
    const second = full[1];
    if (second && /^\s*(?:[-—–~～至到]|→)\s*$/u.test(text.slice(first.end, second.index))) {
      return second.day >= first.day ? { start: first.day, end: second.day } : null;
    }
    const tail = text.slice(first.end).match(/^\s*[-—–~～至到]\s*(\d{1,2})[-/月](\d{1,2})日?(?!\d)/u);
    if (tail) {
      let end = calendarDate(first.day.slice(0, 4), tail[1], tail[2]);
      if (end && end < first.day) end = calendarDate(Number(first.day.slice(0, 4)) + 1, tail[1], tail[2]);
      return end ? { start: first.day, end } : null;
    }
    return { start: first.day, end: first.day };
  }
  if (!allowShort) return null;
  const match = text.match(/(?<![\d/.-])(\d{1,2})[-/月](\d{1,2})日?(?:\s*[-—–~～至到]\s*(\d{1,2})[-/月](\d{1,2})日?)?(?![\d/.-])/u);
  if (!match) return null;
  const possibilities = [...new Set(years)].map((year) => {
    const start = calendarDate(year, match[1], match[2]);
    let end = match[3] ? calendarDate(year, match[3], match[4]) : start;
    if (start && end && end < start) end = calendarDate(Number(year) + 1, match[3], match[4]);
    return start && end ? { start, end } : null;
  }).filter(Boolean);
  return possibilities.length === 1 ? possibilities[0] : null;
}
function overlaps(left, right) { return left && right && left.start <= right.end && left.end >= right.start; }
function recordType(path) {
  return /(?:^|[/ _-])(?:计划|周计划|月计划|plans?|weekly|monthly)(?:[/ _.-]|$)/iu.test(path)
    ? 'plan' : /日记|diary|journal/iu.test(path) ? 'diary'
      : /(?:^|[/ _-])(?:学习记录|复习记录|实践记录|阅读记录|学习日志)(?:[/ _.-]|$)/u.test(path) ? 'activity' : 'note';
}
function activityRecordTitle(value) {
  const title = String(value || '').replace(
    /(?:(?:19|20)\d{2}[-/年])?\d{1,2}[-/月]\d{1,2}日?|(?:19|20)\d{2}年?/gu, ' ',
  ).replace(/^[\s—–~～:：()（）-]+/u, '').trim();
  return /^(?:我的|个人)?(?:学习记录|复习记录|实践记录|阅读记录|学习日志)(?:$|[\s:：()（）｜|—–-])/u.test(title);
}
function documentYearContext(path, lines, filenameDate) {
  if (filenameDate) return Number(filenameDate.start.slice(0, 4));
  const opening = lines.slice(0, 30);
  for (const line of opening) {
    const year = line.match(/^\s*(?:year|年份|年度)\s*[:：]\s*["']?((?:19|20)\d{2})(?:["']?\s*(?:#.*)?)?$/iu)?.[1];
    if (year) return Number(year);
  }
  const context = opening.filter((line) => /^#\s|^\s*(?:date|日期)\s*[:：]/iu.test(line)).join('\n');
  const full = fullDates(context)[0]?.day;
  if (full) return Number(full.slice(0, 4));
  const titleYear = context.match(/(?<!\d)((?:19|20)\d{2})(?:年|年度|(?!\d))/u)?.[1];
  if (titleYear) return Number(titleYear);
  const pathYear = String(path).match(/(?:^|[/ _-])((?:19|20)\d{2})(?:[/ _.-]|$)/u)?.[1];
  return pathYear ? Number(pathYear) : null;
}
function referencesFrom(text) {
  const refs = [];
  for (const match of text.matchAll(/\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]|\[[^\]\n]*\]\(([^)\n]+)\)/gu)) {
    const ref = short(match[1] || match[2], 1_000).replace(/^<|>$/gu, '');
    if (ref && !/^[a-z][a-z0-9+.-]*:/iu.test(ref) && !ref.startsWith('//')) refs.push(ref);
  }
  return [...new Set(refs)].slice(0, 50);
}

/** Return contiguous original lines whose record date overlaps the review. */
export function learningReviewSegments(path, textInput, review) {
  const window = windowDays(review);
  if (!window) return [];
  const text = String(textInput || '');
  const lines = text.split(/\r?\n/u);
  const filenameDate = dateExpression(path, [], false);
  const documentYear = documentYearContext(path, lines, filenameDate);
  // An undated generic note is not evidence of activity this year. Only a
  // clearly dated-record collection can inherit the request's unique year.
  const datedCollection = recordType(path) !== 'note' || /(?:^|[/ _-])(?:daily|logs?|日志|学习记录)(?:[/ _.-]|$)/iu.test(path);
  const years = documentYear ? [documentYear] : datedCollection
    ? [...new Set([Number(window.start.slice(0, 4)), Number(window.end.slice(0, 4))])] : [];
  const inheritedYearBasis = documentYear ? 'explicit' : 'request_window';
  const headings = [];
  let boldDateSection = null;
  let boldActivitySection = false;
  const segments = [];
  let current = null;
  let fence = null;
  let dateColumn = -1;
  let tableHeader = '';
  const flush = () => {
    if (!current) return;
    current.text = current.lines.join('\n');
    delete current.lines;
    if (current.text.trim()) {
      current.id = `L${digest(`${path}\0${current.lineStart}\0${current.lineEnd}\0${current.text}`)}`;
      current.references = referencesFrom(current.text);
      segments.push(current);
    }
    current = null;
  };
  for (const [index, line] of lines.entries()) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
    const inFence = Boolean(fence);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
    }
    let override = null;
    if (!inFence && !fenceMatch) {
      const heading = line.match(/^(#{1,6})\s+(.+)$/u);
      if (heading) {
        boldDateSection = null;
        boldActivitySection = false;
        while (headings.length && headings.at(-1).level >= heading[1].length) headings.pop();
        // Month/day headings require a hyphen or explicit date label. This
        // avoids interpreting "1/2" topic fractions as calendar dates.
        const allowShort = /\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日|日期|日程|时间|\bdate\b/iu.test(heading[2]);
        const date = dateExpression(heading[2], years, allowShort);
        headings.push({ level: heading[1].length, date, activity: activityRecordTitle(heading[2]),
          yearBasis: fullDates(heading[2]).length ? 'explicit' : inheritedYearBasis });
      }
      // Weekly plans often use **W1 (08-31–09-06)** as a section title.
      // Treat its dated body like an ATX heading so the following W2 body
      // cannot inherit an earlier, broader project range.
      const boldTitle = line.match(/^\s*\*\*([^*]+)\*\*/u)?.[1];
      if (boldTitle) {
        boldActivitySection = activityRecordTitle(boldTitle);
        const date = dateExpression(boldTitle, years,
          /\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日|日期|日程|时间/iu.test(boldTitle));
        if (date) boldDateSection = { date, yearBasis: fullDates(boldTitle).length ? 'explicit' : inheritedYearBasis };
      }
      if (/^\s*\|/u.test(line)) {
        const cells = line.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim().replace(/\*|`/gu, ''));
        const found = cells.findIndex((cell) => /^(?:日期|时间|日程|date|day|week)$/iu.test(cell));
        if (found >= 0) { dateColumn = found; tableHeader = line; }
        else if (dateColumn >= 0 && cells[dateColumn] && !/^:?-+:?$/u.test(cells[dateColumn])) {
          // Dates belong only to the declared date cell, never other cells.
          const date = dateExpression(cells[dateColumn], years, true);
          override = { date, basis: 'table',
            yearBasis: fullDates(cells[dateColumn]).length ? 'explicit' : inheritedYearBasis };
        }
      } else { dateColumn = -1; tableHeader = ''; }
    }
    const datedHeading = boldDateSection || [...headings].reverse().find((heading) => heading.date);
    const headingDate = datedHeading?.date;
    const date = override ? override.date : headingDate || filenameDate;
    const basis = override ? override.basis : headingDate ? 'heading' : 'filename';
    const yearBasis = override ? override.yearBasis : headingDate ? datedHeading.yearBasis : 'explicit';
    const pathRecordType = recordType(path);
    const segmentRecordType = pathRecordType === 'note' && (boldActivitySection || headings.some((heading) => heading.activity))
      ? 'activity' : pathRecordType;
    if (!overlaps(date, window)) { flush(); continue; }
    const range = { start: date.start < window.start ? window.start : date.start, end: date.end > window.end ? window.end : date.end };
    const key = `${range.start}/${range.end}/${date.start}/${date.end}/${basis}/${yearBasis}/${segmentRecordType}`;
    if (!current || current.key !== key) {
      flush();
      current = {
        path, lineStart: index + 1, lineEnd: index + 1, lines: [], key,
        dateRange: range, eventDate: range.start === range.end ? range.start : null,
        recordDateRange: { start: date.start, end: date.end },
        dateBasis: basis, yearBasis, recordType: segmentRecordType,
        ...(basis === 'table' && tableHeader ? { context: tableHeader } : {}),
      };
    }
    current.lines.push(line);
    current.lineEnd = index + 1;
  }
  flush();
  return segments.map(({ key, ...segment }) => segment);
}

function splitSegment(segment, ceiling) {
  if (segment.text.length <= ceiling) return [segment];
  const lines = segment.text.split('\n');
  const output = [];
  let buffer = [];
  let length = 0;
  let start = segment.lineStart;
  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join('\n');
    output.push({ ...segment, id: `L${digest(`${segment.id}\0${start}\0${text}`)}`, text,
      lineStart: start, lineEnd: start + buffer.length - 1, references: referencesFrom(text) });
    start += buffer.length; buffer = []; length = 0;
  };
  for (const line of lines) {
    if (buffer.length && length + 1 + line.length > ceiling) flush();
    if (line.length > ceiling) {
      for (let offset = 0; offset < line.length; offset += ceiling) {
        const text = line.slice(offset, offset + ceiling);
        output.push({ ...segment, id: `L${digest(`${segment.id}\0${start}\0${offset}`)}`,
          text, lineStart: start, lineEnd: start, references: referencesFrom(text) });
      }
      start += 1;
    } else { buffer.push(line); length += line.length + (buffer.length > 1 ? 1 : 0); }
  }
  flush();
  return output;
}

export function buildLearningReviewBatches(segments, options = {}) {
  const ceiling = Math.max(256, Math.min(learningReviewLimits.maxBatchChars, Number(options.maxBatchChars) || learningReviewLimits.maxBatchChars));
  const maxBatches = Math.max(0, Number.isFinite(options.maxBatches) ? Math.floor(options.maxBatches) : learningReviewLimits.maxBatches);
  const maxTotal = Math.max(0, Number.isFinite(options.maxTotalChars) ? Math.floor(options.maxTotalChars) : learningReviewLimits.maxTotalChars);
  const pieces = (segments || []).flatMap((segment) => splitSegment(segment, ceiling));
  const batches = [];
  let current = null;
  let includedCharacters = 0;
  let includedSegments = 0;
  for (const piece of pieces) {
    const cost = piece.text.length;
    if (includedCharacters + cost > maxTotal) break;
    if (!current || current.characters + cost > ceiling) {
      if (batches.length >= maxBatches) break;
      current = { id: `batch-${batches.length + 1}`, segments: [], characters: 0 };
      batches.push(current);
    }
    current.segments.push(piece); current.characters += cost;
    includedCharacters += cost; includedSegments += 1;
  }
  return {
    batches,
    coverage: {
      totalSegments: pieces.length, includedSegments, omittedSegments: pieces.length - includedSegments,
      totalCharacters: pieces.reduce((total, piece) => total + piece.text.length, 0),
      includedCharacters, truncated: includedSegments < pieces.length,
    },
  };
}

function parseFacts(output) {
  if (output && typeof output === 'object') return Array.isArray(output.facts) ? output.facts : [];
  try {
    const clean = String(output || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
    const result = JSON.parse(clean);
    return Array.isArray(result?.facts) ? result.facts : [];
  } catch { return []; }
}

function citedContext(segment, start, end) {
  const lines = segment.text.split('\n');
  const first = start - segment.lineStart;
  const excerpt = lines.slice(first, end - segment.lineStart + 1).join('\n');
  if (/^\s+\S/u.test(lines[first] || '') && !/^\s*[-*+]\s+\[[ xX]\]/u.test(lines[first] || '')) {
    for (let index = first - 1; index >= Math.max(0, first - 20); index -= 1) {
      if (!lines[index].trim()) break;
      if (/^\s*[-*+]\s+\[[ xX]\]/u.test(lines[index])) return `${lines[index]}\n${excerpt}`;
    }
  }
  return excerpt;
}

function evidenceDateRange(excerpt, years) {
  const text = String(excerpt).replace(/\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]+\)/gu,
    (match) => ' '.repeat(match.length));
  const token = '(?:(?:19|20)\\d{2}[-/年]\\d{1,2}[-/月]\\d{1,2}日?|\\d{1,2}[-/月]\\d{1,2}日?)';
  const pattern = new RegExp(`(?<![a-zA-Z\\d/.-])${token}(?:\\s*[-—–~～至到]\\s*${token})?(?![a-zA-Z\\d/.-])`, 'gu');
  const ranges = [];
  for (const match of text.matchAll(pattern)) {
    const prefix = text.slice(Math.max(0, match.index - 20), match.index);
    const suffix = text.slice(match.index + match[0].length);
    if (!fullDates(match[0]).length) {
      // “第 5-15 页” and “2/3” are not learning-event dates.
      if (/(?:第|\bpages?)\s*$/iu.test(prefix) || /^\s*(?:页|章|节|行|题|倍|小时|分钟|%|pages?\b)/iu.test(suffix)) continue;
      if (match[0].includes('/') && !/(?:^|[\n：:（(]|日期|时间|于|在|日记)\s*$/u.test(prefix)) continue;
    }
    const range = dateExpression(match[0], years, true);
    if (range) ranges.push(range);
  }
  return ranges.length ? {
    start: ranges.map((range) => range.start).sort()[0],
    end: ranges.map((range) => range.end).sort().at(-1),
  } : null;
}

function locateEvidenceQuote(segment, proposed, quote) {
  const start = Number(proposed.lineStart ?? segment.lineStart);
  const end = Number(proposed.lineEnd ?? segment.lineEnd);
  if (Number.isInteger(start) && Number.isInteger(end) && start >= segment.lineStart && end <= segment.lineEnd && end >= start) {
    const text = segment.text.split('\n').slice(start - segment.lineStart, end - segment.lineStart + 1).join('\n');
    if (text.includes(quote)) return { start, end };
  }
  // The source text and exact quote are trusted; model-supplied line numbers
  // are not. Repair only one unambiguous verbatim occurrence in this segment.
  const offset = segment.text.indexOf(quote);
  if (offset < 0 || segment.text.indexOf(quote, offset + 1) >= 0) return null;
  const resolvedStart = segment.lineStart + (segment.text.slice(0, offset).match(/\n/gu)?.length || 0);
  return { start: resolvedStart, end: resolvedStart + (quote.match(/\n/gu)?.length || 0) };
}

/** Model dates/status are proposals; only actual, in-batch primary evidence counts. */
export function validateLearningReviewFacts(output, batch, review) {
  const input = parseFacts(output);
  const window = windowDays(review);
  const segments = Array.isArray(batch) ? batch : batch?.segments || [];
  const facts = [];
  let rejectedCount = Math.max(0, input.length - 100);
  let temporalUncertainCount = 0;
  for (const item of input.slice(0, 100)) {
    const topic = short(item?.topic, 160);
    const statement = short(item?.statement, 1_000);
    const evidence = [];
    const primary = [];
    let unresolvedYear = false;
    for (const proposed of Array.isArray(item?.evidence) ? item.evidence.slice(0, 12) : []) {
      const segment = segments.find((candidate) => proposed.segmentId
        ? candidate.id === proposed.segmentId
        : candidate.path === proposed.path && Number(proposed.lineStart) >= candidate.lineStart && Number(proposed.lineEnd) <= candidate.lineEnd);
      if (!segment || (proposed.path && proposed.path !== segment.path)) continue;
      const quote = short(proposed.quote, 2_000);
      if (!quote) continue;
      const located = locateEvidenceQuote(segment, proposed, quote);
      if (!located) continue;
      const { start, end } = located;
      evidence.push({ segmentId: segment.id, path: segment.path, lineStart: start, lineEnd: end, quote });
      // A dated reference article may describe its author's activities. Its
      // filename/header date cannot establish the vault owner's learning.
      // Keep it as supporting evidence only when a real activity record anchors
      // the same fact; explicit learning-log sections qualify independently.
      if (segment.dateBasis !== 'related' && ['plan', 'diary', 'activity'].includes(segment.recordType) && overlaps(segment.dateRange, window)) {
        const excerpt = citedContext(segment, start, end);
        if (segment.yearBasis === 'request_window' && !evidenceDateRange(excerpt, [])) {
          unresolvedYear = true;
        } else primary.push({ segment, quote, excerpt });
      }
    }
    if (!topic || !statement || !primary.length) {
      rejectedCount += 1;
      if (unresolvedYear) temporalUncertainCount += 1;
      continue;
    }
    const crossesWindow = primary.some((entry) => {
      const recorded = entry.segment.recordDateRange || entry.segment.dateRange;
      if (recorded.start >= window.start && recorded.end <= window.end) return false;
      const explicit = evidenceDateRange(entry.excerpt, [Number(recorded.start.slice(0, 4))]);
      return !explicit || explicit.start < window.start || explicit.end > window.end;
    });
    if (crossesWindow) { rejectedCount += 1; temporalUncertainCount += 1; continue; }
    let start = primary.reduce((value, entry) => value < entry.segment.dateRange.start ? value : entry.segment.dateRange.start, primary[0].segment.dateRange.start);
    let end = primary.reduce((value, entry) => value > entry.segment.dateRange.end ? value : entry.segment.dateRange.end, primary[0].segment.dateRange.end);
    // An explicit date quoted in the evidence takes precedence over the
    // enclosing diary/plan date, including a retrospective out-of-window date.
    // Inspect the complete cited lines, not merely a provider-selected quote:
    // “2026-07-01 已完成 X” must not become August activity when the model
    // quotes only “已完成 X”. Short month/day dates need a hyphen/date label
    // so arithmetic fractions elsewhere in the line do not change its date.
    const explicit = primary.flatMap((entry) => {
      const range = evidenceDateRange(entry.excerpt, [Number(entry.segment.dateRange.start.slice(0, 4))]);
      return range ? [range.start, range.end] : [];
    });
    if (explicit.length) { start = [...explicit].sort()[0]; end = [...explicit].sort().at(-1); }
    if (!overlaps({ start, end }, window) || start < window.start || end > window.end) { rejectedCount += 1; continue; }
    const requestedDate = item.eventDate ? validDay(item.eventDate) : null;
    if (item.eventDate && (!requestedDate || requestedDate < start || requestedDate > end || (start !== end && !explicit.includes(requestedDate)))) {
      rejectedCount += 1; continue;
    }
    const contexts = primary.map((entry) => entry.excerpt).join('\n');
    const checked = /\[[xX]\]|✅/u.test(contexts);
    const explicitlyPlanned = /\[ \]/u.test(contexts) || (!checked &&
      /(?:计划|目标|打算|准备|拟|希望|要求|争取).{0,16}(?:学习|读|复习|完成|做完|结束)/u.test(contexts));
    const denied = /(?:未|没(?:有)?|尚未|还没|不曾).{0,4}(?:完成|做完|读完|看完|掌握|学过|读过|复习过|学习|阅读|复习)/u.test(contexts);
    const completed = !explicitlyPlanned && !denied && /\[[xX]\]|(?:已|彻底|全部|正式)(?:经)?(?:完成|做完|读完|看完|结束|复习)|(?:完成|做完|读完|看完)了|已读|读过|学过|复习过|✅/u.test(contexts);
    const ongoing = !explicitlyPlanned && !denied && /进行中|正在|继续|推进|学习了|学了|读了|复习了|阅读了/u.test(contexts);
    const planned = explicitlyPlanned || primary.every((entry) => entry.segment.recordType === 'plan');
    const deniesCompletion = /(?:尚未|还没(?:有)?|没有|未曾|不曾|未|没)(?:能)?(?:彻底|完全|全部)?(?:完成|做完|学完|读完|看完|掌握)/u;
    if (deniesCompletion.test(statement) && !deniesCompletion.test(contexts)) {
      rejectedCount += 1; continue;
    }
    if (!completed && /已(?:经)?(?:完成|掌握|结束|做完|读完)|彻底完成|完成了|做完了|掌握了|读完了/u.test(statement) &&
      !/(?:未|没|不).{0,4}(?:完成|掌握|结束|做完|读完)/u.test(statement)) {
      rejectedCount += 1; continue;
    }
    let status = ['completed', 'in_progress', 'planned', 'unconfirmed'].includes(item.status) ? item.status : 'unconfirmed';
    if (status === 'completed' && !completed) status = ongoing ? 'in_progress' : planned ? 'planned' : 'unconfirmed';
    if (status === 'in_progress' && !ongoing && !completed) status = planned ? 'planned' : 'unconfirmed';
    facts.push({
      id: `F${digest(`${topic}\0${statement}\0${start}\0${end}\0${status}`)}`,
      topic, statement, status, eventDate: start === end ? start : null,
      dateRange: { start, end }, evidence,
    });
  }
  return { facts: facts.filter((fact, index) => facts.findIndex((other) => other.id === fact.id) === index), rejectedCount, temporalUncertainCount };
}

export const learningReviewInternals = { dateExpression, fullDates, validDay, windowDays, recordType, DAY_MS };
