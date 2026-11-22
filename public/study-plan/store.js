export const MAX_EVENTS = 5000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const CATEGORIES = new Set(['research', 'course', 'affairs', 'other']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_SEGMENTS = 24;

function problem(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'PlanStoreError';
  return error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freshId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function textField(value, label, limit, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw problem(`${label}必须是文字。`);
  const normalized = value.trim();
  if (required && !normalized) throw problem(`请填写${label}。`);
  if (normalized.length > limit) throw problem(`${label}不能超过 ${limit} 个字符。`);
  return normalized;
}

function booleanField(value, label) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw problem(`${label}必须为是或否。`);
  return value;
}

function timeMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function validateSegments(input) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw problem('分段时间必须是时间段数组。');
  if (input.length === 0) return undefined;
  if (input.length > MAX_SEGMENTS) throw problem(`每个事项最多可安排 ${MAX_SEGMENTS} 个时间段。`);
  const seen = new Set();
  const segments = input.map((segment) => {
    if (!object(segment)) throw problem('每个时间段必须是有效的对象。');
    if (typeof segment.id !== 'string' || !ID_PATTERN.test(segment.id)) throw problem('时间段编号无效。');
    if (seen.has(segment.id)) throw problem('同一事项的时间段编号不能重复。');
    seen.add(segment.id);
    if (typeof segment.startTime !== 'string' || !TIME_PATTERN.test(segment.startTime)) {
      throw problem('时间段开始时间无效，请使用 00:00–23:59 的时间。');
    }
    if (!Number.isInteger(segment.minutes) || segment.minutes < 1 || segment.minutes > 1440) {
      throw problem('每个时间段的用时必须为 1–1440 之间的整数分钟。');
    }
    return { id: segment.id, startTime: segment.startTime, minutes: segment.minutes,
      ...(segment.done !== undefined ? { done: booleanField(segment.done, '时段完成状态') } : {}),
      ...(segment.completionNotes !== undefined ? { completionNotes: textField(segment.completionNotes, '时段完成记录', 10000) } : {}),
    };
  }).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.id.localeCompare(b.id));
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    if (timeMinutes(previous.startTime) + previous.minutes > timeMinutes(segments[index].startTime)) {
      throw problem('同一事项的时间段不能重叠，请调整开始时间或用时。');
    }
  }
  if (segments.reduce((total, segment) => total + segment.minutes, 0) > 1440) {
    throw problem('同一事项所有时间段的总用时不能超过 1440 分钟。');
  }
  return segments;
}

function validateEvent(input, allowNewId = false) {
  if (!object(input)) throw problem('每个学习事项必须是有效的对象。');
  const id = allowNewId && (input.id === undefined || input.id === '') ? freshId() : input.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw problem('事项编号无效：请使用 1–128 位字母、数字、点、冒号、下划线或连字符。');
  if (!validDate(input.date)) throw problem('日期无效，请使用 2000 至 2100 年之间的真实日期，格式为 YYYY-MM-DD。');
  if (!CATEGORIES.has(input.category)) throw problem('事项类别无效，请选择科研、课程、事务或其他。');
  const segments = validateSegments(input.segments);
  const done = booleanField(input.done, '完成状态');
  if (segments?.some((segment) => segment.done !== undefined)) {
    for (const segment of segments) segment.done ??= done;
  }
  const minutes = segments ? segments.reduce((total, segment) => total + segment.minutes, 0)
    : input.minutes === undefined ? null : input.minutes;
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)) {
    throw problem('预计用时必须为空或 0–1440 之间的整数分钟。');
  }
  const startTime = segments ? segments[0].startTime : input.startTime === undefined ? '' : input.startTime;
  if (typeof startTime !== 'string' || (startTime !== '' && !TIME_PATTERN.test(startTime))) {
    throw problem('开始时间无效，请使用 00:00–23:59 的时间，或留空。');
  }
  return {
    id,
    date: input.date,
    title: textField(input.title, '事项名称', 300, true),
    category: input.category,
    minutes,
    uncertain: booleanField(input.uncertain, '待确认状态'),
    acceptance: textField(input.acceptance, '验收标准', 5000),
    notes: textField(input.notes, '备注', 10000),
    done: segments?.some((segment) => segment.done !== undefined)
      ? segments.every((segment) => segment.done)
      : done,
    startTime,
    ...(segments ? { segments } : {}),
    ...(input.completionNotes !== undefined ? { completionNotes: textField(input.completionNotes, '完成记录', 10000) } : {}),
  };
}

function validateEvents(events) {
  if (!Array.isArray(events)) throw problem('学习计划必须包含 events 事项数组。');
  if (events.length > MAX_EVENTS) throw problem(`学习计划最多可包含 ${MAX_EVENTS} 个事项。`);
  const seen = new Set();
  return events.map((value) => {
    const event = validateEvent(value);
    if (seen.has(event.id)) throw problem(`学习计划存在重复的事项编号：${event.id}。`);
    seen.add(event.id);
    return event;
  });
}


export { validateEvent, validateEvents, validDate };
