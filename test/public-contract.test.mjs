import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('draft-ready audit warnings are surfaced by the browser UI', async () => {
  const source = await readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');
  const handler = source.match(
    /listen\('draft_ready',[\s\S]*?listen\('task_error'/,
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
    /listen\('task_error',[\s\S]*?listen\('done'/,
  )?.[0];
  const draftReady = source.match(
    /listen\('draft_ready',[\s\S]*?listen\('task_error'/,
  )?.[0];
  assert.match(taskError || '', /discardPartialAssistant\(\)/);
  assert.match(draftReady || '', /attachDraftButton\(state\.assistantNode\?\.closest/);
});

test('web-search control is opt-in, capability-gated, and preserves the conversation contract', async () => {
  const [html, source] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8'),
  ]);
  const checkbox = html.match(/<input id="knowledge-web-search"[^>]*>/)?.[0] || '';
  const newConversationHandler = source.match(
    /elements\.newConversation\.addEventListener\('click',[\s\S]*?\n\}\);/,
  )?.[0] || '';
  const webSearchHandler = source.match(
    /elements\.webSearch\.addEventListener\('change',[\s\S]*?\n\}\);/,
  )?.[0] || '';

  assert.match(html, /id="knowledge-web-field"[^>]*class="knowledge-toggle"[^>]*hidden/);
  assert.match(checkbox, /type="checkbox"/);
  assert.doesNotMatch(checkbox, /\schecked(?:\s|=|>)/);
  assert.match(html, /管理员选择的联网搜索供应商/);
  assert.match(html, /调用费用/);
  assert.match(html, /目标网站可能看到服务器出口 IP/);
  assert.match(source, /status\?\.webSearch\?\.enabled === true && status\?\.webSearch\?\.configured === true/);
  assert.match(source, /const disabled = state\.busy \|\| !qa \|\| !available/);
  assert.match(source, /elements\.webSearch\.disabled = disabled/);
  assert.match(source, /elements\.webField\.hidden = !qa/);
  assert.match(source, /当前任务会固定使用这一供应商，不会自动切换/);
  assert.match(webSearchHandler, /syncConversationContinuation\(\)/);
  assert.doesNotMatch(webSearchHandler, /state\.conversationId\s*=\s*null/);
  assert.match(source, /elements\.webSearch\.checked = conversation\.kind === 'qa' && conversation\.webSearch === true/);
  assert.match(source, /state\.status\.activeTask\.webSearch === true/);
  assert.match(source, /webSearch: Boolean\(state\.kind === 'qa' && webSearchAvailable\(\) && elements\.webSearch\.checked\)/);
  assert.doesNotMatch(newConversationHandler, /webSearch\.checked\s*=/);
});

test('the browser restores only an opaque per-user conversation selection and honors explicit new chat', async () => {
  const source = await readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');
  const initialize = source.match(/async function initialize\(options = \{\}\)[\s\S]*?\n\}\n\nasync function switchKnowledgeBase/)?.[0] || '';
  const newConversationHandler = source.match(
    /elements\.newConversation\.addEventListener\('click',[\s\S]*?\n\}\);/,
  )?.[0] || '';

  assert.match(source, /const CONVERSATION_SELECTION_PREFIX = 'vaultmind:selected-conversation:v2:'/);
  assert.match(source, /const KNOWLEDGE_BASE_SELECTION_PREFIX = 'second-mind:selected-knowledge-base:v1:'/);
  assert.match(source, /encodeURIComponent\(knowledgeBaseId\)/);
  assert.match(source, /session\?\.user\?\.username/);
  assert.match(source, /const NEW_CONVERSATION_SENTINEL = '__new_conversation__'/);
  assert.match(source, /localStorage\.setItem\(state\.selectionStorageKey, value\)/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(?:messages|transcript)/);
  assert.match(newConversationHandler, /clearConversationSelection\(\{ persistNew: true \}\)/);
  assert.match(source, /const latestQa = state\.conversations\.find\(\(conversation\) => conversation\.kind === 'qa'\)/);
  assert.ok(
    initialize.indexOf('state.status.activeTask') < initialize.indexOf('restoreConversationSelection()'),
    'active task recovery must precede recent-selection recovery',
  );
});

test('fixed settings fork on submit without clearing the selected transcript, while task mode remains continuous', async () => {
  const [html, source] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8'),
  ]);
  const modelHandler = source.match(
    /elements\.model\.addEventListener\('change',[\s\S]*?\n\}\);/,
  )?.[0] || '';
  const effortHandler = source.match(
    /elements\.effort\.addEventListener\('change',[\s\S]*?\n\}\);/,
  )?.[0] || '';
  const taskModeHandler = source.match(
    /elements\.taskMode\.addEventListener\('change',[\s\S]*?\n\}\);/,
  )?.[0] || '';
  const submitHandler = source.match(
    /elements\.form\.addEventListener\('submit',[\s\S]*?\n\}\);/,
  )?.[0] || '';

  assert.match(html, /id="knowledge-continuation-status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(source, /正在继续：\$\{title\}/);
  assert.match(source, /将从“\$\{title\}”派生新会话并保留上下文/);
  assert.match(source, /webSearchProvider: webSearch \? String\(state\.status\?\.webSearch\?\.provider/);
  assert.match(source, /current\.webSearchProvider !== state\.conversationBaseline\.webSearchProvider/);
  assert.match(source, /current\.webSearchBindingRevision !== state\.conversationBaseline\.webSearchBindingRevision/);
  assert.match(source, /webSearchProvider: result\.webSearchProvider/);
  assert.match(source, /webSearchBindingRevision: result\.webSearchBindingRevision/);
  assert.match(modelHandler, /syncConversationContinuation\(\)/);
  assert.match(effortHandler, /syncConversationContinuation\(\)/);
  assert.doesNotMatch(modelHandler, /conversationId\s*=\s*null/);
  assert.doesNotMatch(effortHandler, /conversationId\s*=\s*null/);
  assert.doesNotMatch(taskModeHandler, /conversationId\s*=\s*null|conversationBaseline|pendingFork/);
  assert.match(submitHandler, /shouldFork/);
  assert.match(submitHandler, /\? \{ forkFromConversationId: state\.conversationId \}/);
  assert.match(submitHandler, /: \{ conversationId: state\.conversationId \}/);
  assert.match(submitHandler, /\.\.\.conversationReference/);
});

test('every model exposes the same five effort choices and explains provider mappings', async () => {
  const source = await readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');
  const modelHandler = source.match(
    /elements\.model\.addEventListener\('change',[\s\S]*?\n\}\);/,
  )?.[0] || '';

  assert.match(source, /const UNIVERSAL_EFFORT_IDS = Object\.freeze\(\['low', 'medium', 'high', 'xhigh', 'max'\]\)/);
  assert.match(source, /const effortIds = UNIVERSAL_EFFORT_IDS/);
  assert.match(source, /model\?\.effortMapping && Object\.hasOwn\(model\.effortMapping, requested\)/);
  assert.match(source, /return `\$\{label\}（模型默认）`/);
  assert.match(source, /return `\$\{label\}（实际：\$\{localizedEffortLabel/);
  assert.match(source, /当前“\$\{requestedLabel\}”映射为供应商“\$\{effectiveLabel\}”/);
  assert.match(source, /data\.requestedEffort \|\| data\.effort/);
  assert.match(source, /data\.effectiveEffort/);
  assert.match(source, /\$\{requestedLabel\} → 模型默认/);
  assert.match(modelHandler, /const preferredEffort = elements\.effort\.value/);
  assert.match(modelHandler, /updateEffortOptions\(preferredEffort,/);
  assert.match(source, /activeTask\.requestedEffort \|\| state\.status\.activeTask\.effort/);
});

test('web-search candidates are rendered as a safe collapsible execution-trace list', async () => {
  const source = await readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');

  assert.match(source, /function appendProcessCandidates\(data = \{\}\)/);
  assert.match(source, /Array\.isArray\(data\.candidateSources\)/);
  assert.match(source, /parsedUrl\.protocol !== 'https:'/);
  assert.match(source, /link\.rel = 'noopener noreferrer nofollow'/);
  assert.match(source, /candidate\?\.included === true \? '已进入模型' : '未进入模型'/);
  assert.doesNotMatch(source, /candidate\?\.snippet/);
});

test('administrator configuration UI is permission-gated and never stores or echoes secret fields', async () => {
  const [mainHtml, html, source] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin-config.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/admin-config.js', import.meta.url), 'utf8'),
  ]);

  assert.match(mainHtml, /id="knowledge-admin-config"[^>]*href="\.\/admin-config\.html"[^>]*hidden/);
  assert.match(html, /id="embedding-build"/);
  assert.match(html, /type="password"[^>]*autocomplete="new-password"/);
  assert.match(source, /session\.permissions\?\.manageRuntimeConfig !== true/);
  assert.match(source, /const PROVIDER_CONFIG_ENDPOINT = '\/api\/admin\/provider-config'/);
  assert.match(source, /api\(`\$\{PROVIDER_CONFIG_ENDPOINT\}\/validate`/);
  assert.match(source, /return api\(PROVIDER_CONFIG_ENDPOINT/);
  assert.match(source, /api\('\/api\/admin\/embedding-rebuild'/);
  assert.match(source, /expectedRevision: state\.revision/);
  assert.match(source, /validationId/);
  assert.match(html, /id="embedding-dimensions"[^>]*readonly/);
  assert.match(source, /elements\.adminPassword\.value = ''/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
});

test('model catalog concurrency guard is capability-gated and the UI asset has a matching cache revision', async () => {
  const [html, source] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /knowledge\.js\?v=2\.1\.6/);
  assert.match(html, /knowledge\.css\?v=2\.1\.6/);
  assert.match(source, /const CLIENT_BUILD_REVISION = 'knowledge-ui-2\.1\.6'/);
  assert.match(source, /function modelCatalogRevisionRequest\(status = state\.status\)/);
  assert.match(source, /status\?\.taskContractVersion === 2/);
  assert.match(source, /status\?\.capabilities\?\.modelCatalogRevision === true/);
  assert.match(source, /status\?\.buildRevision !== CLIENT_BUILD_REVISION/);
  assert.match(source, /CLIENT_BUILD_REVISION_MISMATCH/);
  assert.match(source, /return \{ modelCatalogRevision: revision\.toLowerCase\(\) \}/);
  assert.match(source, /\.\.\.catalogRevision/);
  assert.match(source, /'MODEL_CATALOG_CHANGED'/);
  assert.match(source, /'INVALID_MODEL_CATALOG_REVISION'/);
  assert.match(source, /'CONVERSATION_SETTINGS_CHANGED'/);
  assert.match(source, /'FORK_SETTINGS_UNCHANGED'/);
  assert.match(source, /会话绑定设置刚刚变化/);
  assert.match(source, /LLM_PAYMENT_REQUIRED: '模型供应商账户余额不足或尚未开通计费/);
  assert.match(source, /LLM_MODEL_NOT_FOUND: '模型 ID 不存在/);
  assert.match(source, /LLM_AUTH_FAILED: '模型 API Key 无效/);
  assert.match(source, /LLM_REQUEST_INCOMPATIBLE: '模型接口不接受当前请求参数/);
});

test('execution UI separates stages, elapsed time, and verified provider usage', async () => {
  const [source, css] = await Promise.all([
    readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/knowledge.css', import.meta.url), 'utf8'),
  ]);

  assert.match(source, /const PROCESS_PHASES = \[/);
  assert.match(source, /理解与准备/);
  assert.match(source, /检索与核验/);
  assert.match(source, /组织与生成/);
  assert.match(source, /function updateProcessClock\(\)/);
  assert.match(source, /回答正在持续生成/);
  assert.match(source, /等待供应商统计/);
  assert.match(source, /部分供应商统计/);
  assert.match(source, /listen\('usage', handleUsage\)/);
  assert.match(source, /listen\('token_usage', handleUsage\)/);
  const textReplacement = source.match(
    /listen\('text_replace',[\s\S]*?listen\('draft_ready'/,
  )?.[0] || '';
  assert.match(textReplacement, /state\.assistantText = String\(data\.text \|\| ''\)/);
  assert.match(textReplacement, /renderMarkdown\(state\.assistantNode, state\.assistantText\)/);
  assert.doesNotMatch(textReplacement, /state\.assistantText \+=/);
  assert.match(source, /data\?\.callId \|\| data\?\.requestId/);
  assert.match(source, /usage\.cacheReadInputTokens/);
  assert.match(source, /usage\.cacheCreationInputTokens/);
  assert.match(source, /规划估算约 .*不作为供应商计量/);
  assert.match(source, /renderProcessUsage\(\{ final: true \}\)/);
  assert.match(css, /\.knowledge-process-group\[data-state="current"\]/);
  assert.match(css, /\.knowledge-process-step-time/);
  assert.match(css, /\.knowledge-process-usage-grid/);
  assert.match(css, /\.knowledge-message-content \.katex-display/);
  assert.match(css, /overflow-x: auto/);
});
