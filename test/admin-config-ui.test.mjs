import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlUrl = new URL('../public/admin-config.html', import.meta.url);
const sourceUrl = new URL('../public/admin-config.js', import.meta.url);

async function assets() {
  return Promise.all([readFile(htmlUrl, 'utf8'), readFile(sourceUrl, 'utf8')]);
}

test('simplified Provider page uses a matching cache revision and caps the visible catalog at three models', async () => {
  const [html, source] = await assets();

  assert.match(html, /admin-config\.css\?v=2\.1\.6/);
  assert.match(html, /admin-config\.js\?v=2\.1\.6/);
  assert.match(source, /const PROVIDER_SCHEMA_VERSION = 1/);
  assert.match(source, /const MAX_MODELS = 3/);
  assert.match(html, /最多三个/);
  assert.match(html, /id="connection-template"/);
  assert.match(html, /id="model-template"/);
  assert.doesNotMatch(html, /id="config-source"/);
});

test('ordinary Provider UI exposes supplier, endpoint, Key state and real model ID but hides internal routing fields', async () => {
  const [html, source] = await assets();

  for (const providerId of ['bailian', 'deepseek', 'glm', 'kimi', 'custom']) {
    assert.match(html, new RegExp(`value="${providerId}"`));
  }
  assert.match(html, /data-provider-endpoint/);
  assert.match(html, /data-provider-docs/);
  assert.match(html, /data-connection-check>检查连接/);
  assert.match(html, /data-connection-key-state/);
  assert.match(html, /data-model-field="actualModel"/);
  assert.match(html, /data-model-field="displayName"/);
  assert.match(html, /data-model-default/);
  assert.match(html, /data-model-reasoning/);
  assert.match(html, /思考强度映射/);
  assert.match(html, /手动设置五档映射/);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.match(html, new RegExp(`data-model-reasoning-tier="${effort}"`));
  }
  assert.match(source, /const REASONING_MAPPING_VALUES = Object\.freeze\(\['default', \.\.\.UNIVERSAL_EFFORTS\]\)/);
  assert.match(source, /function syncModelReasoningUi\(row, model = null\)/);
  assert.match(html, /data-provider-advanced/);
  assert.match(html, /Custom 高级选项/);
  assert.match(html, /Key 传递方式/);
  assert.match(source, /advanced\.hidden = true/);
  assert.match(source, /requestProfile: 'deepseek-openai', efforts: \['low', 'high', 'max'\]/);
  assert.doesNotMatch(html, />稳定模型 ID</);
  assert.doesNotMatch(html, />请求 Profile</);
  assert.doesNotMatch(html, />短名称</);
  assert.match(html, /data-connection-field="id" type="hidden"/);
  assert.match(html, /data-model-field="requestProfile" type="hidden"/);
});

test('card-level connection checks stage the full candidate but only bill the selected Provider', async () => {
  const [html, source] = await assets();
  const checker = source.match(/async function checkConnection\(card\)[\s\S]*?\n\}/)?.[0] || '';

  assert.match(html, /检查连接/);
  assert.match(html, /联网检查结果会逐模型显示/);
  assert.match(checker, /window\.confirm/);
  assert.match(checker, /可能产生费用/);
  assert.match(checker, /validateProviderIndex: providerIndex/);
  assert.match(checker, /validationStageId: state\.validationStageId/);
  assert.match(checker, /webSearch: collectWebSearch\(\)/);
  assert.match(checker, /PROVIDER_CONFIG_ENDPOINT\}\/validate/);
  assert.match(checker, /result\?\.webSearch\?\.skipped !== true/);
  assert.match(checker, /Object\.hasOwn\(result \|\| \{\}, 'validationId'\)/);
  assert.match(checker, /rememberValidationStage/);
  assert.doesNotMatch(checker, /validateConnectionId|method: 'PUT'|validationId,/);
  assert.match(checker, /clearSecretInputs\(\)/);
  assert.match(checker, /配置未保存/);
  assert.doesNotMatch(checker, /dataset\.persisted/);
  assert.match(html, /页面内存只保留不含密钥的暂存编号/);
  assert.match(html, /服务器内存保留最多 10 分钟/);
  assert.match(source, /function invalidateValidationStage/);
  assert.match(source, /candidateEditVersion/);
});

test('LLM and WebSearch changes share one provider validation receipt and commit without a second model call', async () => {
  const [html, source] = await assets();

  assert.match(source, /const PROVIDER_CONFIG_ENDPOINT = '\/api\/admin\/provider-config'/);
  assert.match(source, /api\(`\$\{PROVIDER_CONFIG_ENDPOINT\}\/validate`/);
  assert.match(source, /webSearch: collectWebSearch\(\)/);
  assert.match(source, /validationStageId = state\.validationStageId/);
  assert.match(source, /validationStageId,[\s\S]*?adminPassword/);
  assert.match(source, /validationId/);
  assert.match(source, /return api\(PROVIDER_CONFIG_ENDPOINT,[\s\S]*?validationId/);
  assert.doesNotMatch(source, /function saveWebSearchPatch/);
  assert.match(html, /最终保存只实测尚未检查的模型/);
  assert.match(html, /保存 receipt 不会再次调用模型/);
  assert.match(source, /schemaVersion: PROVIDER_SCHEMA_VERSION/);
  assert.match(source, /expectedRevision: state\.revision/);
});

test('WebSearch validation errors distinguish search from optional extraction without exposing provider messages', async () => {
  const [, source] = await assets();
  const formatter = source.match(/function webValidationFailureMessage\(error\)[\s\S]*?\n\}/)?.[0] || '';

  assert.match(source, /error\.webSearch = payload\.webSearch/);
  assert.match(formatter, /detail\.stage === 'extract'/);
  assert.match(formatter, /detail\.searchPassed === true/);
  assert.match(formatter, /搜索检查已通过/);
  assert.match(formatter, /取消勾选该抽取兜底后重新保存/);
  assert.match(formatter, /服务端安全网页直读不受影响/);
  assert.match(formatter, /联网搜索检查失败/);
  assert.match(formatter, /\^\[A-Z\]\[A-Z0-9_\]/);
  assert.doesNotMatch(formatter, /error\.message/);
  assert.match(source, /validationDetail \|\| error\.message/);
});

test('simplified provider payload sends only semantic reasoning mapping and supports a new model as default', async () => {
  const [, source] = await assets();
  const collector = source.match(/function collectProviderConfigPayload\(\)[\s\S]*?\n\}/)?.[0] || '';

  assert.match(collector, /providerId,/);
  assert.match(collector, /actualModel,/);
  assert.match(collector, /displayName:/);
  assert.match(collector, /enabled:/);
  assert.match(collector, /default: row\.querySelector/);
  assert.match(collector, /reasoningMapping: modelReasoningMapping\(row\)/);
  assert.doesNotMatch(collector, /requestProfile|efforts|defaultEffort|shortLabel|effortMapping|automaticEffortMapping/);
  assert.doesNotMatch(collector, /defaultModelId/);
});

test('manual effort overrides stay semantic and the page explains server-side capability projection', async () => {
  const [html, source] = await assets();
  const collector = source.match(/function modelReasoningMapping\(row\)[\s\S]*?\n\}/)?.[0] || '';

  assert.match(html, /自动模式会按当前供应商能力安全映射/);
  assert.match(html, /手动模式仍会经过能力投影/);
  assert.match(collector, /mode: 'auto'/);
  assert.match(collector, /mode: 'manual'/);
  assert.match(collector, /Object\.fromEntries\(UNIVERSAL_EFFORTS\.map/);
  assert.match(source, /保存后仍由供应商能力投影/);
  assert.match(source, /normalizeReasoningMapping\(model\?\.reasoningMapping\)/);
});

test('provider and search credentials remain isolated and all browser secret fields are ephemeral', async () => {
  const [html, source] = await assets();

  assert.match(html, /name="web-provider" value="bailian-mcp"/);
  assert.match(html, /name="web-provider" value="tavily-rest"/);
  assert.doesNotMatch(html, /Key 操作|保留现有 Key|替换 Key|清除 Key/);
  assert.doesNotMatch(html, /<select[^>]*(?:data-(?:web|connection)-key-action|id="embedding-key-action")/u);
  assert.equal((html.match(/data-web-key-action type="hidden"/g) || []).length, 2);
  assert.match(html, /data-connection-key-action type="hidden"/);
  assert.match(html, /id="embedding-key-action" type="hidden"/);
  assert.match(html, /已配置时留空即可保留/);
  assert.match(html, /输入新值即替换/);
  assert.match(html, /删除 Provider 会同时删除它的服务端凭据/);
  assert.match(source, /for \(const row of referencedRows\) row\.remove\(\)/);
  assert.match(source, /删除此 Provider 会同时删除\$\{consequences\}/);
  assert.doesNotMatch(source, /该 Provider 仍被模型使用，请先更换或删除相关模型/);
  assert.match(source, /for \(const id of WEB_PROVIDERS\)/);
  assert.match(source, /providers\[id\] = \{/);
  assert.match(source, /return \{ enabled: elements\.webEnabled\.checked, provider, providers \}/);
  assert.match(source, /event\.target\.value\.trim\(\) \? 'replace' : 'keep'/);
  assert.match(source, /return \{ apiKeyAction: action, apiKey: value \}/);
  assert.match(source, /return \{ apiKeyAction: action \}/);
  assert.match(html, /失败时不会自动切换供应商/);
  assert.match(source, /for \(const input of elements\.form\.querySelectorAll\('input\[type="password"\]'\)\) input\.value = ''/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
});

test('workspace branding is dynamic and provider documentation links are restricted to HTTPS', async () => {
  const [html, source] = await assets();

  assert.match(html, /id="branding-app-name"/);
  assert.match(html, /id="branding-vault-label"/);
  assert.match(html, /id="admin-brand-name"/);
  assert.match(html, /id="admin-vault-name"/);
  assert.match(source, /function applyWorkspaceIdentity/);
  assert.match(source, /document\.title = `Provider 配置 · \$\{appName\}`/);
  assert.match(source, /function safeHttpsLink/);
  assert.match(source, /parsed\.protocol === 'https:'/);
});

test('Embedding rebuild detects dimensions server-side and atomically preserves the active index', async () => {
  const [html, source] = await assets();

  assert.match(html, /value="dashscope"/);
  assert.match(html, /value="openai-compatible"/);
  assert.match(html, /value="disabled"/);
  assert.match(html, /id="embedding-dimensions"[^>]*readonly/);
  assert.match(html, /当前 \/ 已探测维度/);
  const collector = source.match(/function collectEmbeddingPayload\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(collector, /dimensions/);
  assert.match(source, /api\('\/api\/admin\/embedding-rebuild'/);
  assert.match(source, /action: 'validate-and-build'/);
  assert.match(source, /action: 'cancel'/);
  assert.match(source, /活动索引保持不变/);
  assert.match(html, /会把可索引文本发送到所配置的 Embedding 服务/);
});
