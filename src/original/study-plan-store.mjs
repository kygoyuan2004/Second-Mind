import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicPrivateFile } from '../../platform/private-storage.mjs';
import { markPublicMessage } from '../public-errors.mjs';
import { validateEvent, validateEvents, MAX_IMPORT_BYTES } from '../../public/study-plan/store.js';
import { parsePlan, annotateCandidates, importKey } from '../../public/study-plan/plan-import.js';

export const planError = (status, message, code = 'PLAN_ERROR') => markPublicMessage(Object.assign(new Error(message), { status, code }));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const conflict = () => planError(409, '日程已在其他页面修改，请刷新预览或重新打开事项。未提交的内容已保留。', 'PLAN_CONFLICT');
const cleanEvents = (events) => {
  if (Buffer.byteLength(JSON.stringify(events)) > MAX_IMPORT_BYTES) throw planError(413, '日程数据不能超过 2 MB。');
  return validateEvents(events);
};
const eventContent = (e) => JSON.stringify(validateEvent(e));
const uuid = (v) => typeof v === 'string' && /^[a-f0-9-]{36}$/i.test(v);

export class StudyPlanStore {
  constructor({ root, knowledgeStore, seed = [] }) {
    this.root = path.resolve(root);
    this.knowledge = knowledgeStore;
    this.seed = cleanEvents(seed);
    this.queues = new Map();
    this.ready = this.recoverPending();
  }
  async recoverPending() {
    const files = await fsp.readdir(this.root).catch((error) => {
      if (error.code !== 'ENOENT') console.error('无法扫描待同步日程：', error.message);
      return [];
    });
    for (const file of files) {
      if (!/^[a-z0-9-]{1,80}\.json$/i.test(file)) continue;
      await this.get(file.slice(0, -5)).catch((error) => console.error('日程恢复未完成，原数据已保留：', error.message));
    }
  }
  filename(user) {
    if (!/^[a-z0-9-]{1,80}$/i.test(user)) throw planError(401, '账号身份无效。');
    return path.join(this.root, `${user}.json`);
  }
  async locked(user, fn) {
    this.filename(user);
    const previous = this.queues.get(user) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.queues.set(user, current);
    try { return await current; } catch (error) { if (error.name === 'PlanStoreError') error.status = 400; throw error; } finally { if (this.queues.get(user) === current) this.queues.delete(user); }
  }
  async read(user) {
    try {
      const data = JSON.parse(await fsp.readFile(this.filename(user), 'utf8'));
      if (data.version !== 1 || !Number.isInteger(data.revision) || data.revision < 0 || typeof data.initialized !== 'boolean'
        || !Array.isArray(data.events) || data.events.some((e) => !Number.isInteger(e.revision) || e.revision < 0 || e.revision > data.revision)
        || ['previews', 'operations', 'migrations', 'deleted'].some((key) => !data[key] || typeof data[key] !== 'object' || Array.isArray(data[key]))) throw new Error('invalid');
      cleanEvents(data.events);
      return data;
    } catch (e) {
      if (e.code !== 'ENOENT') throw planError(503, '服务器日程读取失败，原文件已保留，请恢复备份后重试。');
      return { version: 1, initialized: false, revision: 0, events: this.seed.map((e) => ({ ...e, revision: 0 })), previews: {}, operations: {}, migrations: {}, deleted: {} };
    }
  }
  async write(user, data) {
    cleanEvents(data.events);
    await atomicPrivateFile(this.filename(user), JSON.stringify(data));
  }
  snapshot(data) {
    return { revision: data.revision, initialized: data.initialized, events: data.events,
      operations: Object.values(data.operations).filter((o) => o.status !== 'complete').map((o) => ({ id: o.id, status: o.status, date: o.date, message: o.message })) };
  }
  async get(user) {
    return this.locked(user, async () => {
      const data = await this.read(user);
      for (const op of Object.values(data.operations)) {
        if (['saving', 'pending'].includes(op.status)) await this.finish(user, data, op).catch(() => {});
      }
      return this.snapshot(data);
    });
  }
  async mutate(user, action, body) {
    return this.locked(user, async () => {
      const data = await this.read(user);
      if (action === 'save') {
        const item = validateEvent(body.event, true);
        const old = data.events.find((e) => e.id === item.id);
        if (old ? body.expectedRevision !== old.revision : body.expectedRevision !== null || data.deleted[item.id]) throw conflict();
        data.events = data.events.filter((e) => e.id !== item.id);
        data.events.push({ ...item, revision: data.revision + 1, ...(old?.source ? { source: old.source } : {}) });
      } else if (action === 'delete') {
        const old = data.events.find((e) => e.id === body.id);
        if (!old || old.revision !== body.expectedRevision) throw conflict();
        data.events = data.events.filter((e) => e.id !== body.id);
        data.deleted[body.id] = true;
      } else if (action === 'replace') {
        if (body.expectedRevision !== data.revision) throw conflict();
        if (![1, 2, 3].includes(body.data?.version)) throw planError(400, '请选择版本 1、2 或 3 的日程备份。');
        const events = cleanEvents(body.data.events);
        for (const old of data.events) data.deleted[old.id] = true;
        data.events = events.map((e) => ({ ...e, revision: data.revision + 1 }));
      } else if (action === 'migrate') {
        if (!uuid(body.migrationId)) throw planError(400, '迁移编号无效。');
        if (data.migrations[body.migrationId]) return this.snapshot(data);
        if (body.expectedRevision !== data.revision) throw conflict();
        const events = cleanEvents(body.events);
        if (!data.initialized) data.events = events.map((e) => ({ ...e, revision: data.revision + 1 }));
        else {
          const incoming = new Map(data.events.map((e) => [e.id, e]));
          const keys = new Set(data.events.map(importKey));
          for (const e of events) {
            const old = incoming.get(e.id);
            if (old && eventContent(old) !== eventContent(e)) {
              if (body.choices?.[e.id] === 'local') {
                incoming.set(e.id, { ...e, revision: data.revision + 1, ...(old.source ? { source: old.source } : {}) });
                keys.delete(importKey(old)); keys.add(importKey(e));
              }
            } else if (!old && !data.deleted[e.id] && !keys.has(importKey(e))) {
              incoming.set(e.id, { ...e, revision: data.revision + 1 }); keys.add(importKey(e));
            }
          }
          data.events = [...incoming.values()];
        }
        data.migrations[body.migrationId] = true;
      } else throw planError(404, '日程操作不存在。');
      data.initialized = true; data.revision++;
      await this.write(user, data);
      return this.snapshot(data);
    });
  }
  async preview(user, draftId, body) {
    return this.locked(user, async () => {
      const draft = await this.knowledge.getDraft(user, draftId);
      if (draft.kind !== 'plan') throw planError(400, '只有计划草稿可以加入日程。');
      const content = body.content ?? draft.content;
      if (typeof content !== 'string' || Buffer.byteLength(content) > 512 * 1024) throw planError(413, '草稿超过大小限制。');
      const parsed = parsePlan(content, draft.date);
      const data = await this.read(user);
      const id = crypto.randomUUID();
      const preview = { id, draftId, content: parsed.content, contentHash: hash(parsed.content), date: draft.date,
        targetPath: draft.targetPath, revision: data.revision, expires: Date.now() + 3600000, candidates: parsed.candidates };
      data.previews = Object.fromEntries(Object.entries(data.previews).filter(([, p]) => p.expires > Date.now()).slice(-19));
      if (!parsed.ambiguous) data.previews[id] = preview;
      await this.write(user, data);
      return { ...parsed, id: parsed.ambiguous ? null : id, date: draft.date, revision: data.revision,
        candidates: annotateCandidates(parsed.candidates, data.events), existing: data.events.filter((e) => e.date === draft.date) };
    });
  }
  async saveDraft(user, draftId, body) {
    return this.locked(user, async () => {
      const data = await this.read(user);
      const id = body.operationId;
      if (!uuid(id)) throw planError(400, '保存操作编号无效。');
      let op = data.operations[id];
      if (op) {
        if (op.draftId !== draftId) throw planError(409, '保存编号已用于另一份草稿。');
        return this.finish(user, data, op);
      }
      const preview = data.previews[body.previewId];
      if (!preview || preview.draftId !== draftId || preview.expires <= Date.now()
        || hash(String(body.content)) !== preview.contentHash || preview.revision !== data.revision) throw conflict();
      if (!Array.isArray(body.items) || body.items.length > preview.candidates.length) throw planError(400, '请选择预览中的事项。');
      const selected = new Set();
      const events = body.items.map((item) => {
        const candidate = preview.candidates.find((c) => c.id === item.id);
        if (!candidate || selected.has(item.id)) throw planError(400, '选择的事项无效或重复。');
        selected.add(item.id);
        const e = validateEvent({ ...candidate, title: item.title, category: item.category, startTime: item.startTime, minutes: item.minutes });
        const [h, m] = e.startTime.split(':').map(Number);
        if (!e.startTime || !e.minutes || h * 60 + m + e.minutes > 1440) throw planError(400, '请填写有效的当天起止时间。');
        return { ...e, id: crypto.randomUUID(), source: { draftId, operationId: id, path: preview.targetPath } };
      });
      const proposed = [...data.events]; const keys = new Set(proposed.map(importKey));
      for (const event of events) if (!keys.has(importKey(event))) { proposed.push(event); keys.add(importKey(event)); }
      cleanEvents(proposed);
      op = { id, draftId, date: preview.date, content: preview.content, events, status: 'saving' };
      data.operations[id] = op;
      await this.write(user, data); // Durable intent before touching Markdown.
      return this.finish(user, data, op);
    });
  }
  async retry(user, id) {
    return this.locked(user, async () => {
      const data = await this.read(user), op = data.operations[id];
      if (!op) throw planError(404, '保存操作不存在。');
      return this.finish(user, data, op);
    });
  }
  async finish(user, data, op) {
    if (op.status === 'complete') return op.result;
    if (op.status === 'failed') throw planError(409, op.message, 'DRAFT_CONFLICT');
    if (op.status === 'saving') {
      try {
        op.saved = await this.knowledge.saveDraft(user, op.draftId, { content: op.content, operationId: op.id });
        op.status = 'pending';
        await this.write(user, data);
      } catch (e) {
        if ([404, 409, 410].includes(e.status)) { op.status = 'failed'; op.message = e.message; await this.write(user, data); }
        throw e;
      }
    }
    const before = structuredClone(data);
    try {
      const keys = new Set(data.events.map(importKey)); let added = 0, skipped = 0;
      for (const e of op.events) {
        if (keys.has(importKey(e))) { skipped++; continue; }
        data.events.push({ ...e, revision: data.revision + 1 }); keys.add(importKey(e)); added++;
      }
      data.initialized = true; data.revision++;
      op.result = { ...op.saved, date: op.date, operationId: op.id, schedule: { status: 'complete', added, skipped } };
      op.status = 'complete'; delete op.events; delete op.content; delete op.message;
      await this.write(user, data);
      return op.result;
    } catch (e) {
      Object.assign(data, before);
      return { ...before.operations[op.id].saved, date: op.date, operationId: op.id,
        schedule: { status: 'pending', message: 'Markdown 已保存，日程待同步。请重试同步。' } };
    }
  }
}
