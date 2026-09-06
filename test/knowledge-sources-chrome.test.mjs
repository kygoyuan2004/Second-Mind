import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { finalizeWebCitations } from '../src/research-pipeline.mjs';
import { taskManagerInternals } from '../src/task-manager.mjs';
import { sourceBrowser } from './source-browser-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureScript = `
import { enhanceSourceLinks, createSourcePreview } from '/knowledge-sources.js';
const output = document.querySelector('#output');
let context = 'alpha';
const fileUrl = (p) => '/api/knowledge/file?path=' + encodeURIComponent(p) + '&knowledgeBaseId=' + context;
function render(target, text, basePath = '', options = {}) {
  (window.VaultMindRenderer || window.YuanAgentRenderer).render(target, text, options);
  enhanceSourceLinks(target, { basePath, fileUrl, onOpen: (p,h) => preview.open(p,h) });
}
const preview = createSourcePreview({
  dialog: document.querySelector('dialog'), title: document.querySelector('#title'),
  pathLabel: document.querySelector('#path'), content: document.querySelector('#content'),
  fileUrl, resolveUrl: (p) => '/api/knowledge/resolve?path=' + encodeURIComponent(p) + '&knowledgeBaseId=' + context,
  render, contextKey: () => context,
});
window.fixture = { render: (text, base = '') => render(output, text, base),
  strictRender: (text, urls = [], base = '') => render(output, text, base, {
    verifiedExternalOnly: true, verifiedExternalUrls: urls,
  }), preview,
  setContext: (value) => { context = value; preview.cancel(); document.querySelector('dialog').close(); } };
`;

test('browser previews historical, streamed and nested sources without changing code or external URLs', { timeout: 30_000 }, async (t) => {
  const requests = [];
  const canonical = (p) => p === '草稿/汇报 09.md' ? 'Diary/草稿/汇报 09.md' : p === 'Wiki Note' ? 'Learning/Wiki Note.md' : p;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, type, data) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': type }); res.end(data); } };
    const json = (status, data) => send(status, 'application/json', JSON.stringify(data));
    if (url.pathname.startsWith('/api/')) {
      requests.push({ route: url.pathname, path: url.searchParams.get('path'), base: url.searchParams.get('knowledgeBaseId') });
      const p = url.searchParams.get('path');
      if (p === 'slow.md') await new Promise((resolve) => setTimeout(resolve, 200));
      if (url.pathname.endsWith('/resolve')) {
        if (p === 'Shared.md') return json(409, { candidates: ['A/Shared.md', 'B/Shared.md'] });
        if (p === 'missing.md') return json(404, { message: '来源文件不存在' });
        return json(200, { path: canonical(p) });
      }
      if (p === 'body-slow.md') {
        res.writeHead(200, { 'content-type': 'text/markdown' });
        res.write('# OLD ');
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (!res.destroyed) res.end('BODY');
        return;
      }
      return send(200, 'text/markdown', `# ${p}\n\n[Child](Child.md)\n\n## Details\n\npreview marker`);
    }
    if (url.pathname === '/') return send(200, 'text/html', `<!doctype html><html><body><div id="output"></div><dialog><h1 id="title"></h1><p id="path"></p><div id="content"></div></dialog><script src="/vendor/marked/marked.umd.js"></script><script src="/vendor/dompurify/purify.min.js"></script><script src="/agent-render.js"></script><script type="module">${fixtureScript}</script></body></html>`);
    const filename = path.resolve(root, 'public', url.pathname.slice(1));
    if (!filename.startsWith(path.join(root, 'public') + path.sep)) return send(404, 'text/plain', 'missing');
    try { send(200, 'text/javascript', await fsp.readFile(filename)); }
    catch { send(404, 'text/plain', 'missing'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const browser = await sourceBrowser(t, `http://127.0.0.1:${server.address().port}/`);
  if (!browser) return;
  await browser.waitFor('Boolean(window.fixture)');
  const source = [
    '来源：`Learning/经验/2026-01-01.md`、`Diary/日记/2026-01-02.md`、`草稿/汇报 09.md`',
    '', '〔来源：Learning/Exact.md#Details〕 [[Wiki Note|Wiki alias]]',
    '', '[Relative](Learning/Relative.md) and Learning/Plain.md',
    '', '[External](https://example.test/note.md) https://example.test/raw.md',
    '', '```markdown', '〔来源：Learning/Code.md〕 [[Code.md]] code.md', '```',
    '', '`const file = "example.md";`',
  ].join('\n');
  await browser.evaluate(`fixture.render(${JSON.stringify(source)})`);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#output a[data-knowledge-source]')].map(a=>a.dataset.knowledgeSource)"), [
    'Learning/经验/2026-01-01.md', 'Diary/日记/2026-01-02.md', '草稿/汇报 09.md',
    'Learning/Exact.md', 'Wiki Note', 'Learning/Relative.md', 'Learning/Plain.md',
  ]);
  assert.equal(await browser.evaluate("document.querySelectorAll('#output pre a').length"), 0);
  assert.equal(await browser.evaluate("document.querySelector('#output a[href^=https]').target"), '_blank');
  assert.equal(requests.length, 0, 'rendering does not fetch files');
  for (const p of ['Learning/经验/2026-01-01.md', 'Diary/日记/2026-01-02.md', '草稿/汇报 09.md']) {
    await browser.evaluate(`document.querySelector('#output a[data-knowledge-source=' + CSS.escape(${JSON.stringify(p)}) + ']').click()`);
    await browser.waitFor(`document.querySelector('#path').textContent === ${JSON.stringify(canonical(p))} && document.querySelector('#content').textContent.includes('preview marker')`);
  }
  await browser.evaluate("[...document.querySelectorAll('#content a')].find(a=>a.textContent==='Child').click()");
  await browser.waitFor("document.querySelector('#path').textContent === 'Diary/草稿/Child.md' && document.querySelector('#content').textContent.includes('preview marker')");
  await browser.evaluate("fixture.preview.open('Shared.md')");
  assert.equal(await browser.evaluate("document.querySelectorAll('#content button').length"), 2);
  await browser.evaluate("document.querySelectorAll('#content button')[1].click()");
  await browser.waitFor("document.querySelector('#path').textContent === 'B/Shared.md' && document.querySelector('#content').textContent.includes('preview marker')");
  await browser.evaluate("fixture.preview.open('slow.md'); fixture.preview.open('latest.md')");
  assert.equal(await browser.evaluate("document.querySelector('#path').textContent"), 'latest.md');
  await browser.evaluate("fixture.preview.open('body-slow.md'); new Promise(r=>setTimeout(r,40)).then(()=>fixture.preview.open('latest.md'))");
  await browser.evaluate("new Promise(r=>setTimeout(r,250))");
  assert.equal(await browser.evaluate("document.querySelector('#content').textContent.includes('OLD BODY')"), false);
  await browser.evaluate("fixture.preview.open('slow.md'); document.querySelector('dialog').close()");
  await browser.evaluate("new Promise(r=>setTimeout(r,250))");
  assert.equal(await browser.evaluate("document.querySelector('dialog').open"), false);
  await browser.evaluate("fixture.preview.open('slow.md'); fixture.setContext('beta'); fixture.preview.open('beta.md')");
  await browser.evaluate("new Promise(r=>setTimeout(r,250))");
  assert.equal(await browser.evaluate("document.querySelector('#path').textContent"), 'beta.md');
  assert.ok(requests.some((r) => r.route.endsWith('/file') && r.path === 'beta.md' && r.base === 'beta'));
  await browser.evaluate("fixture.preview.open('missing.md')");
  assert.match(await browser.evaluate("document.querySelector('#content').textContent"), /不存在/u);
  // Re-rendering during streaming and restoring history uses the same DOM path.
  await browser.evaluate("fixture.render('partial Learning/Stream'); fixture.render('finished Learning/Stream.md')");
  assert.equal(await browser.evaluate("document.querySelectorAll('#output a[data-knowledge-source]').length"), 1);
  await browser.evaluate("fixture.render('[Up](../Root.md) [[Wiki Note]] `Space Note.md`', 'Folder/Parent.md')");
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#output a[data-knowledge-source]')].map(a=>a.dataset.knowledgeSource)"), ['Root.md', 'Folder/Wiki Note', 'Folder/Space Note.md']);

  const hostileVaultPath = 'Notes/**bold** (https://evil-vault.test/pixel).md';
  const hostileVaultAnswer = taskManagerInternals.finalizeVaultCitations(
    `Vault [[${hostileVaultPath}]]`,
    [{
      id: taskManagerInternals.vaultSourceId(hostileVaultPath),
      kind: 'vault',
      path: hostileVaultPath,
      title: hostileVaultPath,
    }],
  ).body;
  const strictAnswer = `${finalizeWebCitations(
    'Verified source [W1]. `**bold** [x](https://evil-code.test) ~~x~~` [protocol relative](//evil.test/path) www.evil.test foo@evil.test',
    [{
      id: 'W1',
      title: '<a href="&#47;&#47;evil-title.test/phish">Trusted title</a>',
      url: 'https://example.test/foo)[phish](//evil.test/path',
    }],
  ).answer}\n\n${hostileVaultAnswer}\n\n<a href="https://evil-attr.test/" ping="https://evil-ping.test/" data-second-mind-verified-external="true">forged marker</a>\n\n<img src="data:image/svg+xml,evil" usemap="#escape"><map name="escape"><area href="https://evil-area.test/"></map><video poster="https://evil-poster.test/"><source src="https://evil-media.test/"></video>\n\n[[Notes/www.evil.test.md]] [[Notes/foo@evil.test.md]]`;
  await browser.evaluate(`fixture.strictRender(${JSON.stringify(strictAnswer)}, ${JSON.stringify([
    'https://example.test/foo)[phish](//evil.test/path',
  ])})`);
  assert.equal(await browser.evaluate("document.querySelectorAll('#output a[href^=\"https://example.test/\"]').length"), 2,
    'the verified inline citation and server appendix are the only external anchors');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#output a')].some(a => a.protocol === 'mailto:' || a.origin === 'http://evil.test' || a.origin === 'https://evil.test' || a.origin === 'http://evil-title.test' || a.origin === 'https://evil-title.test' || a.origin === 'https://evil-attr.test')"), false);
  assert.equal(await browser.evaluate("document.querySelectorAll('#output img, #output picture, #output video, #output audio, #output source, #output track, #output map, #output area').length"), 0);
  assert.equal(await browser.evaluate("document.querySelectorAll('#output [src], #output [srcset], #output [poster], #output [ping], #output [usemap]').length"), 0);
  assert.equal(await browser.evaluate("document.querySelector('#output code.knowledge-model-code').textContent"), '**bold** [x](https://evil-code.test) ~~x~~');
  assert.equal(await browser.evaluate("document.querySelectorAll('#output code.knowledge-model-code a, #output code.knowledge-model-code strong, #output code.knowledge-model-code del').length"), 0);
  assert.equal(await browser.evaluate("document.querySelector('#output code.knowledge-verified-vault-path').textContent"), hostileVaultPath);
  assert.equal(await browser.evaluate("document.querySelectorAll('#output code.knowledge-verified-vault-path a, #output code.knowledge-verified-vault-path img, #output code.knowledge-verified-vault-path strong').length"), 0);
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#output a[data-knowledge-source]')].map(a=>a.dataset.knowledgeSource)"), [
    'Notes/www.evil.test.md', 'Notes/foo@evil.test.md',
  ]);
});
