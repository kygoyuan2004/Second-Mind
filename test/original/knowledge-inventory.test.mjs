import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeInventories, inventoryRange, isInventoryRequest } from '../../src/original/knowledge-inventory.mjs';
import { KnowledgeAgentManager } from '../../src/original/knowledge-agent.mjs';

async function fixture(t,extra={}) {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'inventory-test-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'vault'),directory=path.join(temp,'state');await fs.mkdir(root);
 const service=new KnowledgeInventories({root,directory,...extra});await service.ready;
 return {root,directory,service,temp};
}
const full={scope:'markdown',startMs:null,endMs:null};
async function record(service,range=full){return service.create('alice','conversation',range,'task');}

test('enumeration includes root, deep, Chinese, spaces and >100 files; frozen paging and metadata invariance',async(t)=>{
 const {root,service,directory}=await fixture(t);const expected=[];const before=new Map();
 for(let i=0;i<127;i++){const rel=i%3?`多级/目录 带空格/file ${i}.MD`:`根目录 ${i}.md`;await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true});await fs.writeFile(path.join(root,rel),i===0?'':'# note '+i);await fs.utimes(path.join(root,rel),new Date('2026-09-01'),new Date('2026-09-01'));expected.push(rel);}
 await fs.mkdir(path.join(root,'.hidden'));await fs.writeFile(path.join(root,'.hidden/private.md'),'secret');await fs.writeFile(path.join(root,'image.png'),'image');await fs.symlink('/tmp',path.join(root,'outside'));await fs.symlink(path.join(root,expected[0]),path.join(root,'linked.md'));
 for(const p of expected){const st=await fs.stat(path.join(root,p));before.set(p,[st.size,st.mtimeMs,await fs.readFile(path.join(root,p),'utf8')]);}
 const r=await record(service);await service.scan(r);assert.equal(r.status,'completed');assert.equal(r.entries.length,127);assert.deepEqual(r.entries.map(x=>x.path),expected.sort());
 assert.deepEqual(new Set(r.excluded.map(x=>x.reason)),new Set(['hidden','symlink','outside_markdown_scope']));
 const pages=[service.page(r),service.page(r,'50'),service.page(r,'100')];assert.deepEqual(pages.map(p=>p.entries.length),[50,50,27]);assert.equal(pages[2].nextCursor,null);
 await fs.writeFile(path.join(root,'added-later.md'),'later');assert.deepEqual(service.page(r,'100'),pages[2]);
 const reload=new KnowledgeInventories({root,directory});await reload.ready;assert.deepEqual(reload.page(reload.owned('alice',r.id,'conversation'),'50'),pages[1]);
 assert.throws(()=>reload.owned('bob',r.id,'conversation'),{status:404});assert.throws(()=>reload.owned('alice',r.id,'other'),{status:404});assert.throws(()=>reload.page(r,'1'),{status:400});
 for(const [p,values]of before){const st=await fs.stat(path.join(root,p));assert.deepEqual([st.size,st.mtimeMs,await fs.readFile(path.join(root,p),'utf8')],values);}
 const all=await record(service,{...full,scope:'all'});await service.scan(all);assert.equal(all.entries.length,129);
 await reload.removeConversation('conversation');assert.equal(reload.records.size,0);
});

test('strict dates, Shanghai midnight, exact end exclusion, month clamping and inheritance',async(t)=>{
 const now=Date.parse('2026-03-31T02:15:00Z');
 const recent=inventoryRange({prompt:'最近新写了哪些笔记'},null,now);assert.equal(recent.start,'2026-02-28T02:15:00.000Z');
 const r=inventoryRange({prompt:'2026-08-16至2026-09-16修改了哪些文件'});assert.equal(r.start,'2026-08-15T16:00:00.000Z');assert.equal(r.end,'2026-09-16T16:00:00.000Z');
 assert.equal(inventoryRange({prompt:'最近新写了哪些笔记'},r,now).start,r.start);
 const exact=inventoryRange({prompt:'2026-09-16 00:00:00 — 2026-09-16 09:41:36 有哪些笔记'});assert.equal(exact.end,'2026-09-16T01:41:36.000Z');
 for(const [start,end] of [['2026-02-30','2026-03-01'],['2026-09-17','2026-09-16'],['bad','2026-09-16'],['2026-09-16 25:00:00','2026-09-17']])assert.throws(()=>inventoryRange({inventory:{start,end}}),{status:400});
 assert.throws(()=>inventoryRange({inventory:{root:'/tmp'}}),{status:400});assert.throws(()=>inventoryRange({inventory:{timeZone:'UTC'}}),{status:400});
 const {root,service}=await fixture(t);
 for(const [name,ms]of [['start.md',exact.startMs],['end.md',exact.endMs],['before.md',exact.startMs-1000]]) {await fs.writeFile(path.join(root,name),'');await fs.utimes(path.join(root,name),ms/1000,ms/1000);}
 const scanned=await record(service,exact);await service.scan(scanned);assert.deepEqual(scanned.entries.map(x=>x.path),['start.md']);
 const zero=await record(service,inventoryRange({inventory:{start:'2030-01-01',end:'2030-01-01'}}));await service.scan(zero);assert.equal(zero.status,'completed');assert.equal(service.page(zero).matched,0);
});

test('metadata lists route deterministically, content queries keep normal retrieval',()=>{
 for(const prompt of ['告诉我最近新写了哪些笔记','列出全部笔记','全部文件','最近修改了哪些文件','有哪些笔记','盘点文件'])assert.ok(isInventoryRequest({prompt}),prompt);
 for(const prompt of ['哪些笔记提到了 CUDA','哪些笔记包含 CUDA','关于 CUDA 的笔记有哪些','哪些文件包含 CUDA 内容','总结最近学了什么','解释这些笔记','搜索 CUDA','学习成果有哪些'])assert.equal(isInventoryRequest({prompt}),false,prompt);
 assert.equal(isInventoryRequest({kind:'diary',prompt:'哪些笔记'}),false);
});

test('changes during enumeration are incomplete; directory additions/deletions and file mutations detected',async(t)=>{
 let changed=false;const f=await fixture(t,{onStep:async(rel)=>{if(!changed&&rel==='a.md'){changed=true;await fs.writeFile(path.join(f.root,'a.md'),'changed');await fs.writeFile(path.join(f.root,'new.md'),'new');await fs.rm(path.join(f.root,'b.md'));}}});
 await fs.writeFile(path.join(f.root,'a.md'),'a');await fs.writeFile(path.join(f.root,'b.md'),'b');const r=await record(f.service);await f.service.scan(r);assert.equal(r.status,'incomplete');assert.ok(r.changes.some(x=>x.path==='a.md'));assert.ok(r.changes.some(x=>x.path==='.'));assert.ok(r.errors.some(x=>x.path==='b.md'));
});

test('unreadable directory is a reported gap; missing root fails; cancellation and restart never complete',async(t)=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.root,'blocked'));await fs.writeFile(path.join(f.root,'blocked/note.md'),'private');await fs.chmod(path.join(f.root,'blocked'),0);t.after(()=>fs.chmod(path.join(f.root,'blocked'),0o700).catch(()=>{}));
 if(process.getuid?.()!==0){const r=await record(f.service);await f.service.scan(r);assert.equal(r.status,'incomplete');assert.ok(r.errors.some(x=>x.path==='blocked'));}
 await fs.chmod(path.join(f.root,'blocked'),0o700);
 const r=await record(f.service);const abort=new AbortController();abort.abort();await f.service.scan(r,{signal:abort.signal});assert.equal(r.status,'cancelled');
 const pending=await record(f.service);const reload=new KnowledgeInventories({root:f.root,directory:f.directory});await reload.ready;assert.equal(reload.records.get(pending.id).status,'interrupted');
 await fs.rename(f.root,f.root+'-gone');const missing=await record(f.service);await f.service.scan(missing);assert.equal(missing.status,'failed');assert.ok(missing.errors.length);
});

test('symlink replacement during scan never enters external directory',async(t)=>{
 let changed=false;const f=await fixture(t,{onStep:async(rel)=>{if(!changed&&rel==='a.md'){changed=true;await fs.rm(path.join(f.root,'z'),{recursive:true});await fs.symlink(f.temp,path.join(f.root,'z'));}}});
 await fs.writeFile(path.join(f.temp,'secret.md'),'secret');await fs.writeFile(path.join(f.root,'a.md'),'a');await fs.mkdir(path.join(f.root,'z'));await fs.writeFile(path.join(f.root,'z/old.md'),'old');const r=await record(f.service);await f.service.scan(r);assert.equal(r.status,'incomplete');assert.equal(r.entries.some(x=>x.path.includes('secret')),false);
});

test('task integration works without model, search or SDK; resumes snapshot history and cleans with conversation',async(t)=>{
 const {root,temp}=await fixture(t);await fs.writeFile(path.join(root,'root.md'),'untouched');await fs.symlink('/tmp',path.join(root,'link'));
 const options={store:{root,realRoot:root,initialize:async()=>{},attachIndex(){},audit:async()=>{},assertNoSymlinks:async()=>{throw Error('ordinary-only guard');}},modelCatalog:[],queryFn:()=>{throw Error('SDK must not run');},index:false,conversationFile:path.join(temp,'history/conversations.json'),videoProcessor:{ready:Promise.resolve(),cleanupStale:async()=>{}},now:()=>Date.parse('2026-09-16T02:00:00Z')};
 const manager=new KnowledgeAgentManager(options);t.after(()=>manager.close());await manager.ready;
 const task=await manager.createTask('alice',{kind:'qa',prompt:'列出全部笔记'});await Promise.all([...manager.inventoryRuns]);
 const page=await manager.getInventory('alice',task.inventoryId,task.conversationId);assert.equal(page.status,'completed');assert.equal(page.matched,1);assert.equal(manager.getTask('alice',task.taskId).events.some(e=>e.type==='session'),false);
 manager.conversations.get(task.conversationId).inventoryOnly=false;
 const convo=manager.getConversation('alice',task.conversationId);assert.equal(convo.messages[1].inventoryId,task.inventoryId);
 await assert.rejects(manager.getInventory('bob',task.inventoryId,task.conversationId),{status:404});
 const restored=new KnowledgeAgentManager(options);t.after(()=>restored.close());await restored.ready;assert.equal((await restored.getInventory('alice',task.inventoryId,task.conversationId)).matched,1);
 await restored.deleteConversation('alice',task.conversationId);await assert.rejects(restored.getInventory('alice',task.inventoryId,task.conversationId),{status:404});assert.equal(restored.inventories.records.size,0);
});


test('persistence failure cannot advertise a completed durable snapshot',async(t)=>{
 const {root,service}=await fixture(t);await fs.writeFile(path.join(root,'note.md'),'');const r=await record(service);service.save=async()=>{throw Error('disk full')};
 await assert.rejects(service.scan(r),/disk full/);assert.equal(service.page(r).status,'failed');assert.equal(service.page(r).failedCount,1);
});
