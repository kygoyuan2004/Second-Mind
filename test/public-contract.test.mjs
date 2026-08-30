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
