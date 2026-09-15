import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { sdkApplication, messageResponse, waitFor } from './sdk-test-helpers.mjs';

test('original ten-minute deadline aborts the real SDK transport and releases the task slot', {timeout: 30_000}, async t => {
  let upstreamStarted = false, upstreamAborted = false;
  const context = await sdkApplication(t, {fetch: async (_url, init) => {
    upstreamStarted = true;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => {
      upstreamAborted = true; reject(new DOMException('Aborted', 'AbortError'));
    }, {once: true}));
  }});
  // Capture the original scheduler callback. Simulate the deadline firing;
  // retain and assert the production duration, without a ten-minute test sleep.
  const schedule = globalThis.setTimeout;
  let deadline;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 600_000) deadline = callback;
    return schedule(callback, delay, ...args);
  };
  t.after(() => {globalThis.setTimeout = schedule;});
  const status = await (await context.call('/api/knowledge/status')).json();
  const response = await context.call('/api/knowledge/tasks', {method: 'POST', body: JSON.stringify({
    kind: 'qa', model: status.models[0].id, effort: 'low', prompt: 'Read the public evidence.'
  })});
  assert.equal(response.status, 201);
  const created = await response.json();
  await waitFor(() => upstreamStarted);
  globalThis.setTimeout = schedule;
  const task = context.manager.tasks.get(created.taskId);
  assert.equal(task.taskMode.timeoutMs, 600_000);
  assert.equal(task.taskMode.maxTurns, 20);
  assert.equal(typeof deadline, 'function');
  deadline();
  await waitFor(() => task.events.some(e => e.type === 'done'));
  await Promise.allSettled([...context.manager.running]);
  assert.equal(task.status, 'timed_out');
  assert.equal(upstreamAborted, true);
  assert.equal((await (await context.call('/api/knowledge/status')).json()).activeTask, null);
  assert.equal(task.events.find(e => e.type === 'done').data.status, 'timed_out');
});

test('full application resumes imported legacy text through the SDK and confirms an old draft without rewriting originals', {timeout: 30_000}, async t => {
  const conversationId=crypto.randomUUID(), draftId=crypto.randomUUID();
  let raw, draftRaw, legacyFile, draftFile, request;
  const context = await sdkApplication(t, {
    prepareProject: async p => {
      await fs.mkdir(p.config.draftDir, {recursive:true});
      raw=JSON.stringify({version:3,conversations:[{id:conversationId,userId:'admin',kind:'qa',model:'configured',effort:'low',title:'Imported public conversation',messages:[
        {role:'user',content:'Remember legacypublicmarker, a planned task.'},
        {role:'assistant',content:'legacypublicmarker is only planned.'}
      ]}]});
      legacyFile=p.config.conversationFile;await fs.writeFile(legacyFile,raw);
      await fs.mkdir(path.join(p.vaultPath,'Second-Mind/Inbox'),{recursive:true});
      await fs.mkdir(path.join(p.config.draftDir,draftId));
      draftFile=path.join(p.config.draftDir,draftId,'draft.json');
      draftRaw=JSON.stringify({id:draftId,userId:'admin',kind:'scratch',title:'Legacy public note',targetRelative:'Second-Mind/Inbox/Legacy public note.md',content:'# Legacy public note\n\nOnly planned.',sourceHash:null,attachments:[],createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00Z'});
      await fs.writeFile(draftFile,draftRaw);
    },
    fetch: async (_url, init) => {
      request=JSON.parse(init.body);
      return messageResponse({type:'text',text:'The imported task is still planned.'},'end_turn');
    }
  });
  const history=await(await context.call(`/api/knowledge/conversations/${conversationId}`)).json();
  assert.equal(history.messages.length,2);
  assert.match(history.messages[0].text,/legacypublicmarker/);
  const status=await(await context.call('/api/knowledge/status')).json();
  const started=await context.call('/api/knowledge/tasks',{method:'POST',body:JSON.stringify({kind:'qa',model:status.models[0].id,effort:'low',conversationId,prompt:'What was the state of that task?'})});
  const created=await started.json();
  assert.equal(started.status,201,JSON.stringify(created));
  const task=await waitFor(()=>{const task=context.manager.tasks.get(created.taskId);return task?.events.some(e=>e.type==='done')&&task});
  assert.equal(task.status,'completed');
  assert.match(JSON.stringify(request.messages),/legacypublicmarker/);
  assert.ok(context.manager.conversations.get(conversationId).sdkSessionId);
  const draft=await context.call(`/api/knowledge/drafts/${draftId}`);
  assert.equal(draft.status,200);
  const saved=await context.call(`/api/knowledge/drafts/${draftId}/save`,{method:'POST',body:JSON.stringify({content:'# Legacy public note\n\nReviewed, still planned.'})});
  assert.equal(saved.status,200,await saved.text());
  assert.match(await fs.readFile(path.join(context.project.vaultPath,'Second-Mind/Inbox/Legacy public note.md'),'utf8'),/Reviewed, still planned/);
  assert.equal(await fs.readFile(legacyFile,'utf8'),raw);
  assert.equal(await fs.readFile(draftFile,'utf8'),draftRaw);
});
