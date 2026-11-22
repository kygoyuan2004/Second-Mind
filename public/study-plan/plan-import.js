import { validDate } from './store.js';

const minutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
export const endTime = (event) => {
  const end = minutes(event.startTime) + event.minutes;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
};
const titleKey = (s) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const periods = (e) => e.segments?.length ? e.segments : [e];
export const importKey = (e) => JSON.stringify([e.date, titleKey(e.title),
  periods(e).map((s) => [s.startTime, s.minutes]).sort()]);
export function overlaps(a, b) {
  return a.date === b.date && periods(a).some((x) => periods(b).some((y) =>
    x.startTime && y.startTime && x.minutes > 0 && y.minutes > 0
    && minutes(x.startTime) < minutes(y.startTime) + y.minutes
    && minutes(y.startTime) < minutes(x.startTime) + x.minutes));
}

export function normalizePlanMarkdown(value) {
  const text = String(value || '').trim();
  const fences = [...text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/gm)];
  if (!fences.length) return { content: `${text}\n`, warning: '' };
  const extracted = (content) => ({ content: `${content.trim()}\n`, warning: '已仅保留 Markdown 计划正文，请核对后保存。' });
  if (fences.length === 2) {
    const [open, close] = fences;
    const body = text.slice(open.index + open[0].length, close.index).trim();
    if (/^(?:markdown|md)?$/i.test(open[2].trim()) && !close[2].trim()
      && close[1][0] === open[1][0] && close[1].length >= open[1].length
      && /^ {0,3}#\s+.+/m.test(body)) {
      // The user explicitly chose to discard all commentary outside the block.
      return extracted(body);
    }
  } else if (fences.length === 1 && !fences[0][2].trim()) {
    const before = text.slice(0, fences[0].index);
    const headings = [...before.matchAll(/^ {0,3}#\s+[^\r\n]*(?:计划|日程)[^\r\n]*$/gm)];
    if (headings.length === 1) {
      const body = before.slice(headings[0].index);
      if (/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/m.test(body)
        || /^ {0,3}#{2,6}\s+(?:任务清单|今天的安排)/m.test(body)) return extracted(body);
    }
  }
  return { content: `${text}\n`, warning: '无法唯一确定 Markdown 计划正文，请在编辑框中仅保留要保存的一份计划后重新预览。', ambiguous: true };
}

export function parsePlan(value, date) {
  if (!validDate(date)) throw new Error('计划日期无效。');
  const normalized = normalizePlanMarkdown(value);
  const candidates = [], skipped = [];
  if (normalized.ambiguous) return { ...normalized, candidates, skipped };
  let sectionDateConflict = false;
  let ignoredSection = false;
  for (const [index, line] of normalized.content.split(/\r?\n/).entries()) {
    const dates = [...line.matchAll(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/g)]
      .map((m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
    if (/^#{1,6}\s/.test(line)) {
      if (dates.length) sectionDateConflict = dates.some((d) => d !== date);
      ignoredSection = /(?:备注|说明|参考资料|附件)/.test(line);
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.+)$/.exec(line);
    if (!item || ignoredSection) continue;
    const raw = item[2].replace(/：/g, ':');
    const range = /(?<!\d)(\d{1,2}):(\d{2})\s*(?:[-–—~～至]|到)\s*(\d{1,2}):(\d{2})(?!\d)/.exec(raw);
    let reason = '';
    let start = 0, end = 0;
    if (sectionDateConflict || dates.some((d) => d !== date)) reason = '条目日期与计划日期不一致';
    else if (!range) reason = '没有明确的起止时间';
    else {
      start = Number(range[1]) * 60 + Number(range[2]);
      end = Number(range[3]) * 60 + Number(range[4]);
      if (+range[1] > 23 || +range[2] > 59 || +range[3] > 24 || +range[4] > 59 || (+range[3] === 24 && +range[4] !== 0)) reason = '时间无效';
      else if (end <= start || /次日|翌日|明天/.test(raw)) reason = '跨日或结束时间不晚于开始时间，请手动安排';
    }
    const title = range ? `${raw.slice(0, range.index)} ${raw.slice(range.index + range[0].length)}`.trim().replace(/^[\s:：|—-]+|[\s|]+$/g, '') : raw;
    if (!title) reason ||= '缺少事项名称';
    if (reason) { skipped.push({ line: index + 1, text: item[2], reason }); continue; }
    candidates.push({ id: `line-${index + 1}`, date, title, category: 'other', startTime: `${range[1].padStart(2, '0')}:${range[2]}`,
      minutes: end - start, done: /x/i.test(item[1] || ''), uncertain: false, acceptance: '', notes: '' });
  }
  return { ...normalized, candidates, skipped };
}

export function annotateCandidates(candidates, existing) {
  const seen = new Set(existing.map(importKey));
  return candidates.map((event, index) => {
    const key = importKey(event), duplicate = seen.has(key);
    seen.add(key);
    return { ...event, duplicate, overlaps: [...existing, ...candidates.slice(0, index), ...candidates.slice(index + 1)]
      .filter((other) => importKey(other) !== key && overlaps(event, other)).map((other) => other.title) };
  });
}
