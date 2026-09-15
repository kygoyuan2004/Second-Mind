import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

async function missing(url) {
  try { await access(url); return false; } catch { return true; }
}

test('the public knowledge page keeps the original Second Mind UI contract', async () => {
  const html = await readFile(new URL('../public/knowledge.html', import.meta.url), 'utf8');

  for (const id of [
    'knowledge-gate', 'knowledge-login-form', 'knowledge-app', 'knowledge-modes',
    'knowledge-model', 'knowledge-effort', 'knowledge-task-mode', 'knowledge-transcript',
    'knowledge-form', 'knowledge-prompt', 'knowledge-send', 'knowledge-source-dialog',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }
  assert.match(html, /\/styles\.css/);
  assert.match(html, /\/overrides\.css\?v=9/);
  assert.match(html, /\/knowledge\.css\?v=19/);
  assert.match(html, /\/agent-render\.js\?v=2/);
  assert.match(html, /\/knowledge\.js\?v=19/);
  assert.doesNotMatch(html, /\/drive\.html|Yuan Drive/);
  assert.match(html, /href="\/admin-config\.html\?knowledgeBaseId=default">配置管理/);
});

test('the original browser client keeps its API, streaming, source and write-preview flows', async () => {
  const source = await readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');

  assert.match(source, /api\('\/api\/session'/);
  assert.match(source, /api\('\/api\/knowledge\/status'/);
  assert.match(source, /api\('\/api\/knowledge\/tasks'/);
  assert.match(source, /new EventSource\(knowledgeUrl\(/);
  assert.match(source, /api\(`\/api\/knowledge\/drafts\/\$\{encodeURIComponent\(state\.draft\.id\)\}\/save`/);
  assert.match(source, /createSourcePreview\(/);
  assert.match(source, /conversationId: state\.kind === 'qa' \? state\.conversationId : undefined/);
  assert.match(source, /taskMode: state\.kind === 'qa' \? elements\.taskMode\.value : 'normal'/);
  assert.doesNotMatch(source, /PiAgentRuntime|personal_learning_review/);
});

test('the standalone migration intentionally omits Yuan Drive and Home pages', async () => {
  for (const relative of ['drive.html', 'drive.js', 'home.html', 'home.js']) {
    assert.equal(await missing(new URL(`../public/${relative}`, import.meta.url)), true, relative);
  }
});

test('administrator configuration remains permission-gated and secret-safe', async () => {
  const [html, source] = await Promise.all([
    readFile(new URL('../public/admin-config.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin-config.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="embedding-build"/);
  assert.match(html, /type="password"[^>]*autocomplete="new-password"/);
  assert.match(source, /session\.permissions\?\.manageRuntimeConfig !== true/);
  assert.match(source, /const PROVIDER_CONFIG_ENDPOINT = '\/api\/admin\/provider-config'/);
  assert.match(source, /api\('\/api\/admin\/embedding-rebuild'/);
  assert.match(source, /expectedRevision: state\.revision/);
  assert.match(source, /elements\.adminPassword\.value = ''/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
});
