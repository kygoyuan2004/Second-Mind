import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sdkApplication, messageResponse, waitFor } from './sdk-test-helpers.mjs';
import { sourceBrowser } from './source-browser-helper.mjs';

test('full SDK browser isolates two Vaults, histories, source preview and confirmed draft writes', { timeout: 60_000 }, async (t) => {
  let betaRoot;
  const fixture = await sdkApplication(t, {
    prepareProject: async (project) => {
      const mounts = path.join(project.root, 'vaults');
      project.vaultPath = path.join(mounts, 'alpha');
      project.config.vaultPath = project.vaultPath;
      betaRoot = path.join(mounts, 'beta');
      await fs.mkdir(project.vaultPath, { recursive: true });
      await fs.mkdir(path.join(betaRoot, '.obsidian'), { recursive: true });
      await fs.writeFile(path.join(betaRoot, 'Evidence.md'), '# Beta evidence\n\nbeta-notebook 只属于第二个知识库。\n');
    },
    applicationOptions: (project) => ({ allowedRoots: [{ id: 'vaults', path: path.join(project.root, 'vaults'), label: '演示知识库' }] }),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (JSON.stringify(body.messages).includes('beta-draft')) return messageResponse({ type: 'text', text: '# 第二库日记\n\n已完成 beta-draft。' }, 'end_turn');
      const results = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool_result');
      if (!results.length) return messageResponse({ type: 'tool_use', name: 'Read', id: 'read-evidence', input: { file_path: 'Evidence.md' } }, 'tool_use');
      const beta = JSON.stringify(results).includes('beta-notebook');
      return messageResponse({ type: 'text', text: `${beta ? 'beta-notebook 只属于第二个知识库' : 'sdkmarker 计划尚未完成'}。〔来源：Evidence.md〕` }, 'end_turn');
    },
  });
  const { app, base, call, project } = fixture;
  const hubs = app.knowledgeBaseHub.publicStatus().knowledgeBases;
  assert.equal(hubs.length, 2);
  const betaId = hubs.find((entry) => entry.knowledgeBaseId !== 'default').knowledgeBaseId;
  const alphaManager = app.knowledgeBaseHub.resolve('default').manager;
  const betaManager = app.knowledgeBaseHub.resolve(betaId).manager;
  assert.notEqual(alphaManager.sdkStateDir, betaManager.sdkStateDir);
  const browser = await sourceBrowser(t, `${base}/?knowledgeBaseId=default`);
  if (!browser) return;
  const waitPage = (expression) => waitFor(() => browser.evaluate(expression));
  await waitPage(`document.querySelector('#knowledge-login-form')?.hidden === false`);
  await browser.evaluate(`document.querySelector('#knowledge-username').value='admin'; document.querySelector('#knowledge-password').value='synthetic admin password'; document.querySelector('#knowledge-login-form').requestSubmit()`);
  await waitPage(`document.querySelector('#knowledge-base-select')?.options.length === 2`);
  const ask = async (prompt) => {
    await browser.evaluate(`document.querySelector('#knowledge-prompt').value=${JSON.stringify(prompt)}; document.querySelector('#knowledge-form').requestSubmit()`);
  };
  await ask('请读取 Evidence.md，回答当前库的标记并引用。');
  await waitPage(`document.querySelector('#knowledge-transcript').innerText.includes('sdkmarker 计划尚未完成')`);
  const alphaConversation = [...alphaManager.conversations.values()][0].id;
  const switchTo = async (id) => {
    await browser.evaluate(`document.querySelector('#knowledge-base-select').value=${JSON.stringify(id)}; document.querySelector('#knowledge-base-select').dispatchEvent(new Event('change'))`);
    await waitPage(`new URL(location.href).searchParams.get('knowledgeBaseId') === ${JSON.stringify(id)} && document.querySelector('#knowledge-base-select')?.value === ${JSON.stringify(id)}`);
  };
  await switchTo(betaId);
  assert.equal(await browser.evaluate(`document.querySelector('.knowledge-conversation-open') === null`), true);
  await ask('请读取 Evidence.md，回答当前库的标记并引用。');
  await waitPage(`document.querySelector('#knowledge-transcript').innerText.includes('beta-notebook 只属于第二个知识库')`);
  await browser.evaluate(`document.querySelector('[data-knowledge-source]').click()`);
  await waitPage(`document.querySelector('#knowledge-source-dialog')?.open && document.querySelector('#knowledge-source-content').innerText.includes('beta-notebook')`);
  const forbidden = await call(`/api/knowledge/conversations/${alphaConversation}?knowledgeBaseId=${encodeURIComponent(betaId)}`);
  assert.equal(forbidden.status, 404);
  await browser.evaluate(`document.querySelector('#knowledge-source-close').click(); document.querySelector('[data-kind="diary"]').click(); document.querySelector('#knowledge-date').value='2026-09-15'`);
  await ask('beta-draft：今天完成第二个演示知识库验收。');
  await waitFor(() => [...betaManager.tasks.values()].some((task) => task.kind === 'diary' && task.status === 'completed'));
  const diaryTask = [...betaManager.tasks.values()].find((task) => task.kind === 'diary');
  await waitPage(`document.querySelector('#knowledge-draft-dialog')?.open === true`);
  // Loading via the actual authenticated endpoint also verifies that the draft
  // identifier belongs exclusively to the selected Vault.
  assert.equal((await call(`/api/knowledge/drafts/${diaryTask.draftId}?knowledgeBaseId=default`)).status, 404);
  assert.equal(await fs.access(path.join(betaRoot, 'daily_doc')).then(() => true, () => false), false);
  await browser.evaluate(`document.querySelector('#knowledge-draft-content').value='# 第二库确认日记\\n\\n仅保存到 beta。'; document.querySelector('#knowledge-draft-form').requestSubmit()`);
  await waitPage(`document.querySelector('#knowledge-draft-dialog')?.open === false`);
  assert.match(await fs.readFile(path.join(betaRoot, 'daily_doc/日记/2026-09-15.md'), 'utf8'), /仅保存到 beta/);
  assert.equal(await fs.access(path.join(project.vaultPath, 'daily_doc')).then(() => true, () => false), false);
  await browser.evaluate(`document.querySelector('#knowledge-draft-dialog')?.close()`);
  await switchTo('default');
  await waitPage(`document.querySelector('.knowledge-conversation-open')`);
  await browser.evaluate(`document.querySelector('.knowledge-conversation-open').click()`);
  await waitPage(`document.querySelector('#knowledge-transcript').innerText.includes('sdkmarker 计划尚未完成')`);
  assert.equal(await browser.evaluate(`document.querySelector('#knowledge-transcript').innerText.includes('beta-notebook')`), false);
});
