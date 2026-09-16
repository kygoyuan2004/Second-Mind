import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sdkApplication, waitFor } from './sdk-test-helpers.mjs';
import { sourceBrowser } from './source-browser-helper.mjs';

test('inventory API and browser work with disabled model; pagination, scopes, history, cancellation and KB isolation', {timeout:60000},async(t)=>{
 let calls=0;
 const f=await sdkApplication(t,{
  config:{llm:{provider:'disabled'},embedding:{provider:'disabled'}},fetch:async()=>{calls++;throw Error('inventory must not call provider');},
  prepareProject:async(p)=>{
   const mounts=path.join(p.root,'vaults');p.vaultPath=path.join(mounts,'alpha');p.config.vaultPath=p.vaultPath;
   await fs.mkdir(p.vaultPath,{recursive:true});await fs.mkdir(path.join(mounts,'beta','.obsidian'),{recursive:true});await fs.writeFile(path.join(mounts,'beta','独立.md'),'beta');
   for(let i=0;i<105;i++)await fs.writeFile(path.join(p.vaultPath,`笔记 ${i}.MD`),i===0?'':'fixture');
   await fs.writeFile(path.join(p.vaultPath,'附件.png'),'attachment');
  },
  applicationOptions:(p)=>({allowedRoots:[{id:'vaults',path:path.join(p.root,'vaults'),label:'样本'}]})
 });
 const {call,base,app,manager}=f;const kb=app.knowledgeBaseHub.publicStatus().knowledgeBases.find(k=>k.knowledgeBaseId!=='default').knowledgeBaseId;
 assert.equal((await fetch(base+'/api/knowledge/inventories/id')).status,401);
 const bad=await call('/api/knowledge/inventories',{method:'POST',body:JSON.stringify({start:'2026-02-30',end:'2026-03-01'})});assert.equal(bad.status,400);assert.equal(manager.inventories.records.size,0);
 const response=await call('/api/knowledge/tasks',{method:'POST',body:JSON.stringify({kind:'qa',prompt:'列出全部笔记'})});assert.equal(response.status,201);const created=await response.json();
 const url=`/api/knowledge/inventories/${created.inventoryId}?conversationId=${created.conversationId}`;
 const first=await waitFor(async()=>{const p=await(await call(url)).json();return p.status==='completed'&&p;});assert.equal(first.matched,106);assert.equal(first.entries.length,50);
 assert.equal((await call(url+'&knowledgeBaseId='+kb)).status,404);assert.equal((await call(url.replace(created.conversationId,'other'))).status,404);
 const second=await(await call(url+'&cursor=50')).json();const third=await(await call(url+'&cursor=100')).json();assert.equal(new Set([...first.entries,...second.entries,...third.entries].map(f=>f.path)).size,106);
 const beta=await(await call('/api/knowledge/inventories?knowledgeBaseId='+kb,{method:'POST',body:JSON.stringify({scope:'all'})})).json();const bp=await waitFor(async()=>{const p=await(await call(`/api/knowledge/inventories/${beta.inventoryId}?knowledgeBaseId=${kb}&conversationId=${beta.conversationId}`)).json();return p.status==='completed'&&p;});assert.equal(bp.matched,1);assert.equal(bp.entries[0].path,'独立.md');
 const browser=await sourceBrowser(t,base+'/knowledge.html');if(!browser)return;
 await waitFor(()=>browser.evaluate(`document.querySelector('#knowledge-login-form')?.hidden===false`));
 await browser.evaluate(`document.querySelector('#knowledge-username').value='admin';document.querySelector('#knowledge-password').value='synthetic admin password';document.querySelector('#knowledge-login-form').requestSubmit()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('.knowledge-conversation-open')!==null`));
 await browser.evaluate(`document.querySelector('.knowledge-conversation-open').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('.knowledge-inventory')?.dataset.status==='completed'`));
 assert.equal(await browser.evaluate(`document.querySelectorAll('.knowledge-inventory tbody tr').length`),50);
 await browser.evaluate(`[...document.querySelectorAll('.inventory-actions button')].find(b=>b.textContent==='下一页').click()`);
 await waitFor(()=>browser.evaluate(`document.querySelector('.inventory-actions').innerText.includes('2 / 3')`));
 await browser.evaluate(`window.inventoryBeforeReload=true`);await browser.call('Page.reload');await waitFor(()=>browser.evaluate(`window.inventoryBeforeReload===undefined && document.querySelector('.knowledge-conversation-open')!==null`));await browser.evaluate(`document.querySelector('.knowledge-conversation-open').click()`);await waitFor(()=>browser.evaluate(`document.querySelector('.knowledge-inventory')?.dataset.status==='completed'`));
 const fileUrl=await browser.evaluate(`document.querySelector('.knowledge-inventory tbody a').getAttribute('href')`);assert.equal((await call(fileUrl)).status,200);
 await browser.evaluate(`document.querySelector('.inventory-actions select').value='all';[...document.querySelectorAll('.inventory-actions button')].find(b=>b.textContent==='重新扫描').click()`);
 await waitFor(()=>browser.evaluate(`[...document.querySelectorAll('.knowledge-inventory')].some(c=>c.dataset.status==='completed' && c.innerText.includes('匹配 107'))`));
 // Slow metadata enumeration to observe truthful progress and cancel through task endpoint.
 await waitFor(()=>[...manager.tasks.values()].every(t=>t.status==='completed'));
 manager.inventories.onStep=async()=>new Promise(r=>setTimeout(r,5));
 const cancel=await(await call('/api/knowledge/inventories',{method:'POST',body:JSON.stringify({scope:'all'})})).json();
 const running=await waitFor(async()=>{const p=await(await call(`/api/knowledge/inventories/${cancel.inventoryId}?conversationId=${cancel.conversationId}`)).json();return p.processed>0&&p;});assert.equal(running.matched,null);
 await call(`/api/knowledge/tasks/${cancel.taskId}/cancel`,{method:'POST'});
 await waitFor(async()=>{const p=await(await call(`/api/knowledge/inventories/${cancel.inventoryId}?conversationId=${cancel.conversationId}`)).json();return p.status==='cancelled';});
 assert.equal(calls,0);assert.equal([...manager.tasks.values()].some(t=>t.sdkTransport||t.retrieval),false);
 await call('/api/knowledge/conversations/'+created.conversationId,{method:'DELETE'});assert.equal((await call(url)).status,404);
});

test('inventory conversation can continue into ordinary content QA with fixed range and preserved card', {timeout:30000},async(t)=>{
 let calls=0;let observed='';
 const {messageResponse}=await import('./sdk-test-helpers.mjs');
 const {call,manager}=await sdkApplication(t,{fetch:async(_url,init)=>{calls++;observed+=init.body;return messageResponse({type:'text',text:'正文解释，计划尚未完成。〔来源：Evidence.md〕'},'end_turn');}});
 const created=await(await call('/api/knowledge/tasks',{method:'POST',body:JSON.stringify({prompt:'列出 2026-08-16 至 2026-09-16 修改了哪些笔记'})})).json();
 await Promise.all([...manager.inventoryRuns]);assert.equal(calls,0);
 const originalCard=(await(await call('/api/knowledge/inventories/'+created.inventoryId)).json());assert.equal(originalCard.range.start,'2026-08-15T16:00:00.000Z');
 const status=await(await call('/api/knowledge/status')).json();
 const follow=await call('/api/knowledge/tasks',{method:'POST',body:JSON.stringify({prompt:'解释 Evidence.md 的正文内容，并注明计划是否完成。',conversationId:created.conversationId,model:status.models.find(m=>m.available).id,effort:'low'})});assert.equal(follow.status,201);
 const task=await follow.json();await waitFor(()=>manager.getTask([...manager.conversations.values()][0].userId,task.taskId).status==='completed');
 assert.ok(calls>0);assert.match(observed,/已有后端文件清单/);assert.match(observed,/2026-08-15T16:00:00/);
 const history=await(await call('/api/knowledge/conversations/'+created.conversationId)).json();assert.equal(history.messages.filter(m=>m.inventoryId).length,1);assert.equal(history.inventoryOnly,false);
 assert.equal((await(await call('/api/knowledge/inventories/'+created.inventoryId)).json()).matched,originalCard.matched);
});
