import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ACTIVE = new Set(['queued', 'scanning', 'verifying']);
export function inventoryError(message, status = 400) {
  return Object.assign(new Error(message), { status, code: 'KNOWLEDGE_INVENTORY_ERROR', publicMessage: true });
}
export function isInventoryRequest(body = {}) {
  if ((body.kind || 'qa') !== 'qa') return false;
  if (body.inventory) return true;
  const p = String(body.prompt || '');
  if (/提到|提及|包含(?!附件|图片)|关于|涉及|介绍|讨论|写了什么|讲了什么|总结|学习成果|学了什么|解释|展开|搜索|检索/.test(p)) return false;
  return /(?:哪些|什么|全部|所有|清单|列出|盘点).{0,30}(?:笔记|文件)|(?:笔记|文件).{0,30}(?:哪些|全部|所有|清单|盘点)/.test(p);
}
const DATE = '(\\d{4}-\\d{1,2}-\\d{1,2}(?:[T ]\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})?)?)';
function localParts(date) {
  const d = new Date(new Date(date).getTime() + 8 * 3600_000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}
function day(y, m, d) { return Date.UTC(y, m - 1, d) - 8 * 3600_000; }
function boundary(value, end = false) {
  const s = String(value || '');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(s);
  if (!m) throw inventoryError('日期格式无效，请使用 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss。');
  const [, y, mo, d, h, mi, se, frac, zone] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  if (+y < 1000 || +mo < 1 || +mo > 12 || +d < 1 || date.getUTCDate() !== +d || +(h || 0) > 23 || +(mi || 0) > 59 || +(se || 0) > 59) throw inventoryError('日期或时间不存在。');
  const iso = `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${(h || '00').padStart(2,'0')}:${mi || '00'}:${se || '00'}${frac || ''}${zone || '+08:00'}`;
  const result = Date.parse(iso) + (end && h === undefined ? 86400_000 : 0);
  if (!Number.isFinite(result)) throw inventoryError('日期或时区偏移无效。');
  return result;
}
export function inventoryRange(body = {}, previous = null, now = Date.now()) {
  now = new Date(now).getTime();
  if (!Number.isFinite(now)) throw inventoryError('查询时钟无效。',500);
  const input = body.inventory === true ? {} : body.inventory || {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw inventoryError('清单参数必须是对象。');
  if (Object.keys(input).some((k) => !['scope','start','end','timeZone','allTime'].includes(k))) throw inventoryError('清单仅接受范围、日期和时区，根目录由服务器决定。');
  if (input.timeZone && input.timeZone !== 'Asia/Shanghai') throw inventoryError('文件清单目前使用 Asia/Shanghai 时区。');
  const p = String(body.prompt || '');
  const scope = input.scope || (/全部文件|所有文件|包括附件|包含附件/.test(p) ? 'all' : 'markdown');
  if (!['all','markdown'].includes(scope)) throw inventoryError('范围必须是 markdown 或 all。');
  let start = input.start, end = input.end;
  const dates = [...p.matchAll(new RegExp(DATE, 'g'))].map((m) => m[1]);
  if (start === undefined && end === undefined && dates.length) { [start, end] = dates; if (!end) end = start; }
  let a = null, b = null, source = '全部时间';
  if (start !== undefined || end !== undefined) {
    if (!start || !end) throw inventoryError('请同时提供开始与结束日期。');
    a = boundary(start); b = boundary(end, true); source = '明确日期范围';
  } else if (input.allTime === true || /全部|所有/.test(p) && !/最近|近期|本月|上月|本周|上周|今天|昨天/.test(p)) {
    source = '全部时间';
  } else {
    const [y,m,d] = localParts(now), today = day(y,m,d);
    if (/上个?月/.test(p)) { a = day(y,m-1,1); b = day(y,m,1); source = '上一个日历月'; }
    else if (/本月|这个月/.test(p)) { a = day(y,m,1); b = +now; source = '本月至查询时刻'; }
    else if (/今天|昨天/.test(p)) { a = today - (/昨天/.test(p) ? 86400_000 : 0); b = /昨天/.test(p) ? today : +now; source = '北京时间日期'; }
    else if (/本周|上周/.test(p)) { const dow = new Date(today + 8*3600_000).getUTCDay() || 7; a = today-(dow-1)*86400_000; b = +now; if (/上周/.test(p)) { b=a; a-=7*86400_000; } source='北京时间自然周'; }
    else if (/最近\s*\d+\s*天/.test(p)) { const n=+p.match(/最近\s*(\d+)\s*天/)[1]; if (!n || n>36500) throw inventoryError('天数无效。'); a=+now-n*86400_000; b=+now; source='指定最近天数'; }
    else if (previous && Number.isFinite(previous.startMs) && Number.isFinite(previous.endMs) && !/重新指定|过去一个月|最近一个月|近一个月/.test(p)) { a=previous.startMs; b=previous.endMs; source='沿用当前对话时间范围'; }
    else if (/最近|近期|新写|修改|更新/.test(p)) {
      // Calendar month subtraction, clamped at month end, retaining local clock time.
      const last = new Date(Date.UTC(y,m-1,0)).getUTCDate();
      a=day(y,m-1,Math.min(d,last))+(+now-today); b=+now; source='最近一个自然月（同日同刻，月末截齐）';
    }
  }
  if (a !== null && (b === null || a >= b)) throw inventoryError('开始时间必须早于结束时间。');
  return { scope, timeZone:'Asia/Shanghai', startMs:a, endMs:b, start:a===null?null:new Date(a).toISOString(), end:b===null?null:new Date(b).toISOString(), boundary:'[start, end)', source,
    disclaimer:'以下按最后修改时间筛选，不能证明首次创建时间；这是扫描期间的观测清单，并非文件系统原子快照。',
    exclusions:'跳过隐藏路径、符号链接、非普通文件；Markdown 范围还排除其他扩展名。不读取正文。' };
}
function signature(s) { return [s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':'); }
function directoryNames(entries) { return entries.map(e=>`${e.name}:${e.isDirectory()?'d':e.isFile()?'f':e.isSymbolicLink()?'l':'o'}`).sort(compare); }
function compare(a,b) { return a < b ? -1 : a > b ? 1 : 0; }

export class KnowledgeInventories {
  constructor({ root, directory, now = () => Date.now(), onStep = null }) {
    this.root = path.resolve(root); this.directory = path.resolve(directory); this.now=now; this.onStep=onStep;
    this.records=new Map(); this.controllers=new Map(); this.writes=Promise.resolve();
    this.ready=this.initialize();
  }
  async initialize() {
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    const [root, storage] = await Promise.all([fs.realpath(this.root),fs.realpath(this.directory)]);
    if (storage===root || storage.startsWith(root+path.sep)) throw inventoryError('清单状态不能保存在知识库内。',500);
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const record=JSON.parse(await fs.readFile(path.join(this.directory,name),'utf8'));
      if (record.root !== this.root) continue;
      if (ACTIVE.has(record.status)) { record.status='interrupted'; record.finishedAt=new Date(this.now()).toISOString(); record.errors.push({path:'.',reason:'服务重启，扫描中断，请重新扫描'}); await this.save(record); }
      this.records.set(record.id,record);
    }
  }
  save(record) {
    const data=JSON.stringify(record), target=path.join(this.directory,record.id+'.json');
    const op=async()=>{ const temp=target+'.'+crypto.randomUUID()+'.tmp'; await fs.writeFile(temp,data,{mode:0o600,flag:'wx'}); await fs.rename(temp,target); };
    this.writes=this.writes.then(op,op); return this.writes;
  }
  async create(userId, conversationId, range, taskId) {
    await this.ready;
    const record={id:crypto.randomUUID(), userId,conversationId,taskId,root:this.root,range,status:'queued',startedAt:new Date(this.now()).toISOString(),finishedAt:null,discovered:0,processed:0,entries:[],excluded:[],errors:[],changes:[]};
    await this.save(record); this.records.set(record.id,record); return record;
  }
  owned(userId,id,conversationId) {
    const r=this.records.get(id);
    if (!r || r.userId!==userId || r.conversationId!==conversationId) throw inventoryError('文件清单不存在。',404);
    return r;
  }
  page(record,cursor='') {
    if (cursor && !/^\d+$/.test(String(cursor))) throw inventoryError('分页游标无效。');
    const offset=Number(cursor||0);
    if (!Number.isSafeInteger(offset) || offset<0 || offset%50 || offset>record.entries.length) throw inventoryError('分页游标无效。');
    const {root,userId,entries,...publicRecord}=record;
    return {...publicRecord, matched:ACTIVE.has(record.status)?null:entries.length, excludedCount:record.excluded.length,failedCount:record.errors.length,changedCount:record.changes.length,
      entries:ACTIVE.has(record.status)?[]:entries.slice(offset,offset+50),nextCursor:!ACTIVE.has(record.status)&&offset+50<entries.length?String(offset+50):null,pageSize:50,offset};
  }
  async removeConversation(id) {
    await this.writes;
    for (const [key,r] of this.records) if (r.conversationId===id) { this.controllers.get(key)?.abort(); await fs.rm(path.join(this.directory,key+'.json'),{force:true}); this.records.delete(key); }
  }
  cancel(record) { this.controllers.get(record.id)?.abort(); }
  // On Linux directory descriptors anchor each operation; O_NOFOLLOW rejects link swaps.
  // Other platforms recheck every ancestor and realpath before a metadata operation.
  async directoryHandle(target) {
    return fs.open(target,constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
  }
  async scan(record,{signal,onProgress=()=>{}}={}) {
    const controller=new AbortController(); this.controllers.set(record.id,controller);
    const aborted=()=>{ if (signal?.aborted || controller.signal.aborted) throw inventoryError('扫描已取消。',499); };
    const linux=process.platform==='linux',observed=[],dirs=[],files=[];
    let lastEmit=0;
    const progress=(force=false)=>{ if (force || this.now()-lastEmit>=100) { lastEmit=this.now(); onProgress(this.page(record)); } };
    const safePath=async(rel)=>{
      const parts=rel.split('/').filter(Boolean); let target=this.root;
      for (const p of ['',...parts]) { if (p) target=path.join(target,p); const s=await fs.lstat(target,{bigint:true}); if(s.isSymbolicLink()) throw inventoryError('路径已变为符号链接'); }
      const real=await fs.realpath(target);
      if(real!==this.root&&!real.startsWith(this.root+path.sep)) throw inventoryError('路径越界');
      return target;
    };
    const walk=async(rel,parentFd=null,name='')=>{
      aborted(); let handle;
      try {
        const target=linux&&parentFd!==null?`/proc/self/fd/${parentFd}/${name}`:await safePath(rel);
        handle=await this.directoryHandle(target);
        const stat=await handle.stat({bigint:true}); if (!stat.isDirectory()) throw inventoryError('目录类型发生变化');
        const prefix=linux?`/proc/self/fd/${handle.fd}`:target;
        const children=await fs.readdir(prefix,{withFileTypes:true}), names=children.map(e=>e.name).sort(compare); dirs.push({path:rel,signature:signature(stat),names:directoryNames(children)});
        for (const child of names) {
          aborted(); const relative=rel?rel+'/'+child:child; record.discovered++;
          try {
            if(child.startsWith('.')) { record.excluded.push({path:relative,reason:'hidden'}); continue; }
            const s=await fs.lstat(path.join(prefix,child),{bigint:true}); observed.push({path:relative,signature:signature(s)});
            if(s.isSymbolicLink()) { record.excluded.push({path:relative,reason:'symlink'}); continue; }
            if(s.isDirectory()) await walk(relative,handle.fd,child);
            else if(!s.isFile()) record.excluded.push({path:relative,reason:'not_regular_file'});
            else if(record.range.scope==='markdown'&&!/\.md$/i.test(child)) record.excluded.push({path:relative,reason:'outside_markdown_scope'});
            else files.push({path:relative,size:Number(s.size),mtimeMs:Number(s.mtimeNs)/1e6,mtime:new Date(Number(s.mtimeNs)/1e6).toISOString()});
          } catch(e) { if(e.status===499) throw e; record.errors.push({path:relative,reason:e.code||'无法获取文件属性'}); }
          finally { record.processed++; progress(); await this.onStep?.(relative,record); }
        }
      } catch(e) { if(e.status===499) throw e; if(!rel) throw e; record.errors.push({path:rel,reason:e.code||'目录无法访问'}); }
      finally { await handle?.close(); }
    };
    const verify=async(rel,directory=false)=>{
      // Open root and each parent with NOFOLLOW, never resolving a replaced link.
      if(!linux) { const target=await safePath(rel); return directory ? {stat:await fs.lstat(target,{bigint:true}),names:directoryNames(await fs.readdir(target,{withFileTypes:true}))} : {stat:await fs.lstat(target,{bigint:true})}; }
      let h=await this.directoryHandle(this.root);
      try {
        const parts=rel.split('/').filter(Boolean), leaf=parts.pop();
        for(const part of parts) { const next=await this.directoryHandle(`/proc/self/fd/${h.fd}/${part}`); await h.close(); h=next; }
        const target=leaf?`/proc/self/fd/${h.fd}/${leaf}`:`/proc/self/fd/${h.fd}`;
        if(directory) { if(leaf) { const next=await this.directoryHandle(target); await h.close(); h=next; } return {stat:await h.stat({bigint:true}),names:directoryNames(await fs.readdir(`/proc/self/fd/${h.fd}`,{withFileTypes:true}))}; }
        return {stat:await fs.lstat(target,{bigint:true})};
      } finally { await h.close(); }
    };
    try {
      aborted(); record.status='scanning'; progress(true); await walk('');
      record.status='verifying'; progress(true);
      for(const item of observed) { aborted(); try { if(signature((await verify(item.path)).stat)!==item.signature) record.changes.push({path:item.path,reason:'属性改变'}); } catch {record.changes.push({path:item.path,reason:'消失或路径不可访问'});} }
      for(const item of dirs) { aborted(); try { const v=await verify(item.path,true); if(signature(v.stat)!==item.signature || JSON.stringify(v.names)!==JSON.stringify(item.names)) record.changes.push({path:item.path||'.',reason:'目录或目录成员改变'}); } catch {record.changes.push({path:item.path||'.',reason:'目录不可访问'});} }
      record.status=record.errors.length||record.changes.length?'incomplete':'completed';
    } catch(e) { record.status=e.status===499?'cancelled':'failed'; if(e.status!==499) record.errors.push({path:'.',reason:e.code||'根目录不可访问'}); }
    record.entries=files.filter(f=>(record.range.startMs===null||f.mtimeMs>=record.range.startMs)&&(record.range.endMs===null||f.mtimeMs<record.range.endMs)).sort((a,b)=>b.mtimeMs-a.mtimeMs||compare(a.path,b.path));
    record.finishedAt=new Date(this.now()).toISOString(); this.controllers.delete(record.id);
    try { await this.save(record); }
    catch(error) { record.status='failed'; record.errors.push({path:'.',reason:'清单持久化失败，请重新扫描'}); progress(true); throw error; }
    progress(true); return record;
  }
}
