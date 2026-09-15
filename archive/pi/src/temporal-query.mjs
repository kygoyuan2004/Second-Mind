const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

// Topic nouns such as “研究” and “论文” are deliberately insufficient: a
// public question about recent research must keep its normal Web/RAG route.
// Temporal inventory routing requires an owned Vault artefact, an explicit
// personal activity, or an activity-shaped note/file request.
// Keep the first-person subject adjacent to harmless time/aspect modifiers.
// A permissive `我.{0,20}更新了` also captures requests such as “我想知道…
// OpenAI 更新了什么”, which are public-current-events questions, not a
// private activity inventory.
const PERSONAL_ACTIVITY = /(?:我|本人|自己|我们|咱们)(?:(?:在|于|最近|近来|过去|这|前|本|上|个|第|都|主要|大概|已经|一共|还|又|曾经|期间)|[0-9一二两三四五六七八九十百半年月日周星期\s]){0,16}(?:学(?:习)?了|学过|复习了|读(?:书)?了|阅读了|研究了|写了|整理了|完成了|做了|记录了|新增了|修改了|更新了)/iu;
const OWNED_VAULT_ARTIFACT = /(?:我的|我在|本人(?:的)?|自己的|本地|当前|这个).{0,12}(?:vault|知识库|笔记|文件|日记|学习记录|阅读记录|课程记录|项目记录)|(?:vault|知识库|笔记|文件|日记).{0,12}(?:我的|我在|本人|自己)/iu;
const VAULT_ACTIVITY = /(?:写|整理|记录|创建|新增|修改|更新|完成)(?:了|过).{0,12}(?:vault|知识库|笔记|文件|日记)|(?:vault|知识库|笔记|文件|日记).{0,12}(?:写|整理|记录|创建|新增|修改|更新|完成)(?:了|过)/iu;
const PERSONAL_RECAP = /(?:盘点|汇总|总结|回顾).{0,20}(?:我的|我|本人|自己|vault|知识库|笔记|文件|日记)|(?:我的|本人|自己的).{0,12}(?:学习|阅读|课程|项目|论文|研究|笔记|文件|日记).{0,12}(?:内容|情况|进展|清单|盘点|汇总|总结|回顾|哪些|什么)/iu;
const ENGLISH_PERSONAL_INVENTORY = /(?:\b(?:i|we)\b\s+(?:(?:have|had|did|recently|just|also|mostly|personally|been)\s+){0,4}(?:learn(?:ed|t)?|study|studied|read|wrote|written|organized|completed|updated|created)\b|\bmy\s+(?:notes?|files?|vault|study|learning|reading)\b|\b(?:notes?|files?|vault)\b.{0,20}\b(?:i|my|mine|wrote|organized|updated|created)\b)/iu;
const LEARNING_SCOPE = /(?:学习|学了|学过|复习|课程|读书|阅读|论文|研究|教程|教材|文献|项目|learn|study|read|course|paper|research|tutorial|project)/iu;
const RELATIVE_TIME_SIGNAL = /(?:今天|今日|昨天|昨日|前天|本周|这周|这个星期|上周|上个星期|本月|这个月|上月|上个月|最近|近来|近\s*[0-9一二两三四五六七八九十百两半]|过去|这\s*[0-9一二两三四五六七八九十百两半]|前\s*[0-9一二两三四五六七八九十百两半]|past\s+|last\s+|this\s+)/iu;

function hasPrivateInventoryIntent(text) {
  return PERSONAL_ACTIVITY.test(text) ||
    OWNED_VAULT_ARTIFACT.test(text) ||
    VAULT_ACTIVITY.test(text) ||
    PERSONAL_RECAP.test(text) ||
    ENGLISH_PERSONAL_INVENTORY.test(text);
}

function numericChinese(value) {
  const raw = String(value || '').trim();
  if (/^\d{1,4}$/u.test(raw)) return Number(raw);
  if (raw === '半') return 0.5;
  const digits = new Map([
    ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3],
    ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
  ]);
  if (!raw || !/^[零〇一二两三四五六七八九十百]+$/u.test(raw)) return null;
  let total = 0;
  let current = 0;
  for (const character of raw) {
    if (digits.has(character)) {
      current = digits.get(character);
    } else if (character === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (character === '百') {
      total += (current || 1) * 100;
      current = 0;
    }
  }
  const parsed = total + current;
  return parsed > 0 ? parsed : null;
}

function formatterFor(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
}

function localParts(epochMs, timeZone) {
  const parts = {};
  for (const item of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (item.type !== 'literal') parts[item.type] = Number(item.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: 0,
  };
}

function zoneOffsetMs(epochMs, timeZone) {
  const parts = localParts(epochMs, timeZone);
  const represented = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second,
  );
  return represented - Math.trunc(epochMs / 1_000) * 1_000;
}

function zonedEpoch(parts, timeZone) {
  const wallClock = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour || 0, parts.minute || 0, parts.second || 0, parts.millisecond || 0,
  );
  let result = wallClock - zoneOffsetMs(wallClock, timeZone);
  // A second pass handles an offset transition between the initial UTC guess
  // and the represented local time. Asia/Shanghai has no modern DST, while
  // this keeps tests and custom deployments correct in DST-aware zones too.
  result = wallClock - zoneOffsetMs(result, timeZone);
  return result;
}

function localDayStart(epochMs, timeZone) {
  const parts = localParts(epochMs, timeZone);
  return zonedEpoch({ year: parts.year, month: parts.month, day: parts.day }, timeZone);
}

function addLocalDays(epochMs, days, timeZone) {
  const parts = localParts(epochMs, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return zonedEpoch({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: parts.millisecond,
  }, timeZone);
}

function addLocalMonths(epochMs, months, timeZone) {
  const parts = localParts(epochMs, timeZone);
  const desiredDay = parts.day;
  const targetMonth = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(
    targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0,
  )).getUTCDate();
  return zonedEpoch({
    year: targetMonth.getUTCFullYear(),
    month: targetMonth.getUTCMonth() + 1,
    day: Math.min(desiredDay, lastDay),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: parts.millisecond,
  }, timeZone);
}

function startOfWeek(epochMs, timeZone) {
  const dayStart = localDayStart(epochMs, timeZone);
  const parts = localParts(dayStart, timeZone);
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return addLocalDays(dayStart, -((weekday + 6) % 7), timeZone);
}

function startOfMonth(epochMs, timeZone) {
  const parts = localParts(epochMs, timeZone);
  return zonedEpoch({ year: parts.year, month: parts.month, day: 1 }, timeZone);
}

function startOfYear(epochMs, timeZone) {
  const parts = localParts(epochMs, timeZone);
  return zonedEpoch({ year: parts.year, month: 1, day: 1 }, timeZone);
}

function safeTimeZone(value) {
  const requested = String(value || DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;
  try {
    formatterFor(requested).format(new Date(0));
    return requested;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function localStamp(epochMs, timeZone) {
  const value = localParts(epochMs, timeZone);
  const two = (number) => String(number).padStart(2, '0');
  return `${value.year}-${two(value.month)}-${two(value.day)} ${two(value.hour)}:${two(value.minute)}:${two(value.second)}`;
}

function result(startMs, endMs, timeZone, label, scope) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
  return {
    kind: 'vault_mtime_inventory',
    scope,
    label,
    range: {
      startMs,
      endMs,
      startInclusive: new Date(startMs).toISOString(),
      endExclusive: new Date(endMs).toISOString(),
      startLocal: localStamp(startMs, timeZone),
      endLocal: localStamp(endMs, timeZone),
      timeZone,
    },
  };
}

function rollingRange(count, unit, nowMs, timeZone, prefix) {
  const dayStart = localDayStart(nowMs, timeZone);
  const closedPrevious = prefix === '前';
  if (unit === 'day') {
    const endMs = closedPrevious ? dayStart : nowMs + 1;
    const days = Math.max(1, Math.round(count));
    const startMs = addLocalDays(dayStart, closedPrevious ? -days : -(days - 1), timeZone);
    return { startMs, endMs };
  }
  if (unit === 'week') {
    if (closedPrevious) {
      const endMs = startOfWeek(nowMs, timeZone);
      return { startMs: addLocalDays(endMs, -7 * Math.max(1, Math.round(count)), timeZone), endMs };
    }
    const days = Math.max(1, Math.round(count * 7));
    return { startMs: addLocalDays(dayStart, -(days - 1), timeZone), endMs: nowMs + 1 };
  }
  if (unit === 'month') {
    if (closedPrevious) {
      const endMs = startOfMonth(nowMs, timeZone);
      return { startMs: addLocalMonths(endMs, -Math.max(1, Math.round(count)), timeZone), endMs };
    }
    return { startMs: localDayStart(addLocalMonths(nowMs, -count, timeZone), timeZone), endMs: nowMs + 1 };
  }
  if (unit === 'year') {
    if (closedPrevious) {
      const endMs = startOfYear(nowMs, timeZone);
      return { startMs: addLocalMonths(endMs, -12 * Math.max(1, Math.round(count)), timeZone), endMs };
    }
    return {
      startMs: localDayStart(addLocalMonths(nowMs, -12 * count, timeZone), timeZone),
      endMs: nowMs + 1,
    };
  }
  return null;
}

function temporalRequestSignal(question) {
  const text = String(question || '').normalize('NFKC').trim();
  return {
    text,
    matched: Boolean(text && hasPrivateInventoryIntent(text) && RELATIVE_TIME_SIGNAL.test(text)),
  };
}

/**
 * Parse relative-time Vault inventory questions into an explicit mtime window.
 * The end is always exclusive. Ongoing windows end one millisecond after the
 * task's fixed clock so a file modified exactly at task creation is included.
 */
export function parseVaultTemporalRequest(question, options = {}) {
  const signal = temporalRequestSignal(question);
  const { text } = signal;
  if (!signal.matched) return null;
  const nowMs = Number(options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now());
  if (!Number.isFinite(nowMs)) return null;
  const timeZone = safeTimeZone(options.timeZone);
  const scope = LEARNING_SCOPE.test(text) ? 'learning' : 'all';
  const dayStart = localDayStart(nowMs, timeZone);
  let match;

  if (/(?:今天|今日|\btoday\b)/iu.test(text)) {
    return result(dayStart, nowMs + 1, timeZone, '今天', scope);
  }
  if (/(?:昨天|昨日|\byesterday\b)/iu.test(text)) {
    return result(addLocalDays(dayStart, -1, timeZone), dayStart, timeZone, '昨天', scope);
  }
  if (/前天/iu.test(text)) {
    return result(addLocalDays(dayStart, -2, timeZone), addLocalDays(dayStart, -1, timeZone), timeZone, '前天', scope);
  }
  if (/(?:本周|这周|这个星期|\bthis\s+week\b)/iu.test(text)) {
    return result(startOfWeek(nowMs, timeZone), nowMs + 1, timeZone, '本周', scope);
  }
  if (/(?:上周|上个星期|\blast\s+week\b)/iu.test(text)) {
    const endMs = startOfWeek(nowMs, timeZone);
    return result(addLocalDays(endMs, -7, timeZone), endMs, timeZone, '上周', scope);
  }
  if (/(?:本月|这个月|\bthis\s+month\b)/iu.test(text)) {
    return result(startOfMonth(nowMs, timeZone), nowMs + 1, timeZone, '本月', scope);
  }
  if (/(?:上月|上个月|\blast\s+month\b)/iu.test(text)) {
    const endMs = startOfMonth(nowMs, timeZone);
    return result(addLocalMonths(endMs, -1, timeZone), endMs, timeZone, '上月', scope);
  }
  match = text.match(/(?:最近|近|过去|这)\s*半\s*个?\s*月/iu);
  if (match) {
    const range = rollingRange(15, 'day', nowMs, timeZone, '近');
    return result(range.startMs, range.endMs, timeZone, match[0].trim(), scope);
  }

  match = text.match(/(最近|近|过去|这|前)\s*([0-9一二两三四五六七八九十百]+)\s*(天|日|周|星期|个月|月|年)/iu);
  if (match) {
    const count = numericChinese(match[2]);
    if (count && count <= 366) {
      const unit = /天|日/u.test(match[3])
        ? 'day' : /周|星期/u.test(match[3]) ? 'week' : /年/u.test(match[3]) ? 'year' : 'month';
      // Capture the prefix directly. Deriving it with a string slice made
      // “前 2 周” retain a trailing space and incorrectly become a rolling
      // current window instead of two complete preceding weeks.
      const prefix = match[1];
      const range = rollingRange(count, unit, nowMs, timeZone, prefix);
      if (range) return result(range.startMs, range.endMs, timeZone, match[0].trim(), scope);
    }
  }

  match = text.match(/\b(?:past|last)\s+(\d{1,3})\s+(days?|weeks?|months?|years?)\b/iu);
  if (match) {
    const count = Number(match[1]);
    const unit = match[2].toLowerCase().startsWith('day')
      ? 'day' : match[2].toLowerCase().startsWith('week')
        ? 'week' : match[2].toLowerCase().startsWith('year') ? 'year' : 'month';
    const range = rollingRange(count, unit, nowMs, timeZone, 'past');
    if (range) return result(range.startMs, range.endMs, timeZone, match[0], scope);
  }
  return null;
}

/**
 * Distinguish a supported time window from an explicit private inventory whose
 * relative period is not safely understood. Callers must fail closed for the
 * latter instead of falling through to ordinary relevance or Web search.
 */
export function classifyVaultTemporalRequest(question, options = {}) {
  const signal = temporalRequestSignal(question);
  if (!signal.matched) return { matched: false, supported: false, plan: null, reason: '' };
  const plan = parseVaultTemporalRequest(signal.text, options);
  return plan
    ? { matched: true, supported: true, plan, reason: '' }
    : {
        matched: true,
        supported: false,
        plan: null,
        reason: 'unsupported_relative_period',
      };
}

export function isVaultTemporalInventoryQuestion(question, options = {}) {
  return classifyVaultTemporalRequest(question, options).matched;
}

export const temporalQueryInternals = {
  numericChinese,
  localParts,
  zonedEpoch,
  localDayStart,
  addLocalDays,
  startOfWeek,
  startOfMonth,
  startOfYear,
  hasPrivateInventoryIntent,
};
