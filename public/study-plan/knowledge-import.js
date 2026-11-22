function newOperationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
import { annotateCandidates, endTime, normalizePlanMarkdown } from './plan-import.js?v=20260922-2';

const esc = (v) => String(v).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
const categories = { other: '其他', research: '科研 · 论文', course: '课程', affairs: '个人事务' };
const minute = (v) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };

export function mountKnowledgeImport({ container, textarea, api, onError }) {
  let draft, preview, operationId, pendingId, serial = 0, busy = false;
  const enabled = () => draft?.kind === 'plan' && container.querySelector('[data-enable]')?.checked;
  function invalidate() {
    preview = null; operationId = null; serial++;
    container.querySelector('[data-rows]')?.replaceChildren();
    const status = container.querySelector('[data-status]');
    if (status) status.textContent = '正文已修改，请重新生成日程预览。';
  }
  textarea.addEventListener('input', invalidate);
  function readItems() {
    return [...container.querySelectorAll('[data-row]')].filter((row) => row.querySelector('[data-selected]').checked).map((row) => {
      const candidate = preview.candidates.find((c) => c.id === row.dataset.row);
      const startTime = row.querySelector('[data-start]').value;
      const end = row.querySelector('[data-end]').value;
      if (!/^\d\d:\d\d$/.test(startTime) || !/^(?:[0-2]\d):[0-5]\d$/.test(end)
        || minute(end) <= minute(startTime) || minute(end) > 1440) throw new Error('请填写当天有效的起止时间；结束时间必须晚于开始时间。');
      const title = row.querySelector('[data-title]').value.trim();
      if (!title) throw new Error('请填写事项名称。');
      return { ...candidate, title, startTime, minutes: minute(end) - minute(startTime), category: row.querySelector('[data-category]').value };
    });
  }
  function annotate() {
    if (!preview) return;
    try {
      const items = annotateCandidates(readItems(), preview.existing);
      for (const row of container.querySelectorAll('[data-row]')) {
        const item = items.find((i) => i.id === row.dataset.row);
        row.querySelector('[data-flags]').textContent = !item ? '未选择，不加入日程' : [
          `${item.minutes} 分钟`, item.duplicate ? '完全重复，保存时跳过' : '新增事项', item.overlaps.length ? `时间重叠：${item.overlaps.join('、')}` : '',
        ].filter(Boolean).join(' · ');
      }
    } catch (e) { container.querySelector('[data-status]').textContent = e.message; }
  }
  async function generate() {
    if (busy || pendingId) return;
    busy = true; const request = ++serial;
    const button = container.querySelector('[data-generate]'); button.disabled = true;
    try {
      const normalized = normalizePlanMarkdown(textarea.value);
      const result = await api(`/api/knowledge/drafts/${encodeURIComponent(draft.id)}/schedule-preview`, {
        method: 'POST', body: JSON.stringify({ content: normalized.content }),
      });
      if (request !== serial) return;
      result.warning ||= normalized.warning;
      preview = result; operationId = null;
      textarea.value = result.content;
      textarea.dispatchEvent(new Event('plan-normalized'));
      container.querySelector('[data-status]').textContent = result.ambiguous
        ? `${result.date} · 尚未提取日程。${result.warning}`
        : `${result.date} · ${result.candidates.length} 条可导入事项。${result.warning || ''}`;
      container.querySelector('[data-rows]').innerHTML = result.candidates.map((e) => `<div class="plan-import-row" data-row="${esc(e.id)}"><label><input type="checkbox" data-selected ${e.duplicate ? '' : 'checked'}> 加入 ${esc(e.date)} 的安排${e.done ? '（已完成）' : ''}</label><div class="plan-import-fields"><label>事项<input data-title value="${esc(e.title)}" maxlength="300"></label><label>开始<input data-start type="time" value="${esc(e.startTime)}"></label><label>结束<input data-end inputmode="numeric" placeholder="HH:MM" value="${endTime(e)}" aria-label="结束时间，支持 24:00"></label><label>分类<select data-category>${Object.entries(categories).map(([value, label]) => `<option value="${value}" ${value === e.category ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><p data-flags class="plan-import-warning"></p></div>`).join('')
        + (result.skipped.length ? `<details open><summary>${result.skipped.length} 条未导入</summary><ul>${result.skipped.map((s) => `<li>${esc(s.text)}：${esc(s.reason)}</li>`).join('')}</ul></details>` : '');
      annotate();
    } catch (e) { if (request === serial) onError(e.message); }
    finally { busy = false; button.disabled = false; }
  }
  container.addEventListener('input', (e) => { if (e.target.closest('[data-row]')) { operationId = null; annotate(); } });
  container.addEventListener('change', (e) => { if (e.target.closest('[data-row]')) { operationId = null; annotate(); } });
  return {
    setSaving(saving) {
      textarea.readOnly = saving || Boolean(pendingId);
      for (const control of container.querySelectorAll('input, select, button')) control.disabled = saving;
    },
    hasPending: () => Boolean(pendingId),
    open(value) {
      draft = value; preview = null; operationId = null; pendingId = null; serial++;
      textarea.readOnly = false;
      container.hidden = value.kind !== 'plan';
      container.innerHTML = `<label><input type="checkbox" data-enable checked> 同时加入每日计划表</label><p>保存前核对日期和事项。仅导入明确起止时间，保留已有安排。</p><button type="button" data-generate>生成日程预览</button><p data-status role="status"></p><div data-rows></div>`;
      container.querySelector('[data-generate]').onclick = generate;
      container.querySelector('[data-enable]').onchange = () => {
        container.querySelector('[data-generate]').hidden = !enabled();
        container.querySelector('[data-rows]').hidden = !enabled();
      };
    },
    prepare() {
      if (pendingId) return { retryId: pendingId };
      if (!enabled()) {
        if (draft?.kind === 'plan') {
          const normalized = normalizePlanMarkdown(textarea.value);
          if (normalized.ambiguous) throw new Error(normalized.warning);
          textarea.value = normalized.content;
          textarea.dispatchEvent(new Event('plan-normalized'));
        }
        return {};
      }
      if (preview?.ambiguous) throw new Error(preview.warning);
      if (!preview?.id || busy) throw new Error('请先生成并核对日程预览，再确认保存。');
      if (textarea.value !== preview.content) { invalidate(); throw new Error('正文已修改，请重新生成日程预览。'); }
      operationId ||= newOperationId();
      return { previewId: preview.id, operationId, items: readItems().map(({ id, title, startTime, minutes, category }) => ({ id, title, startTime, minutes, category })) };
    },
    async retry(id) { return api(`/api/knowledge/schedule/operations/${encodeURIComponent(id)}/retry`, { method: 'POST' }); },
    pending(result) {
      pendingId = result.operationId; textarea.readOnly = true;
      container.hidden = false;
      container.innerHTML = '<p role="status">Markdown 已保存，日程待同步。点击下方“重试同步”，无需再次保存 Markdown。</p>';
    },
    invalidate,
  };
}
