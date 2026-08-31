import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('draft-ready audit warnings are surfaced by the browser UI', async () => {
  const source = await readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');
  const handler = source.match(
    /source\.addEventListener\('draft_ready',[\s\S]*?source\.addEventListener\('task_error'/,
  )?.[0];

  assert.ok(handler, 'draft_ready event handler must exist');
  assert.match(handler, /state\.draft\.warnings\?\.length/);
  assert.match(handler, /appendNotice\(/);
  assert.match(handler, /toast\(/);
});

test('active-task recovery hydrates the transcript without replaying a durable trailing assistant twice', async () => {
  const source = await readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');
  assert.match(source, /function renderConversationTranscript\(conversation, options = \{\}\)/);
  assert.match(source, /options\.excludeTrailingAssistant && messages\.at\(-1\)\?\.role === 'assistant'/);
  assert.match(source, /renderConversationTranscript\(conversation, \{ excludeTrailingAssistant: true \}\)/);
});

test('failed streams discard partial answers and streamed drafts retain a reopen button', async () => {
  const source = await readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');
  const taskError = source.match(
    /source\.addEventListener\('task_error',[\s\S]*?source\.addEventListener\('done'/,
  )?.[0];
  const draftReady = source.match(
    /source\.addEventListener\('draft_ready',[\s\S]*?source\.addEventListener\('task_error'/,
  )?.[0];
  assert.match(taskError || '', /discardPartialAssistant\(\)/);
  assert.match(draftReady || '', /attachDraftButton\(state\.assistantNode\?\.closest/);
});
