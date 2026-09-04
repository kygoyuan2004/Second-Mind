const SCHEMA_VERSION = 2;
const MAX_CONNECTIONS = 16;
const PROVIDER_SCHEMA_VERSION = 1;
const MAX_MODELS = 3;
const POLL_INTERVAL_MS = 2000;
const KNOWN_EFFORTS = Object.freeze(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const UNIVERSAL_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const REASONING_MAPPING_VALUES = Object.freeze(['default', ...UNIVERSAL_EFFORTS]);
const EFFORT_LABELS = Object.freeze({
  default: '模型默认', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
});
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WEB_PROVIDERS = Object.freeze(['bailian-mcp', 'tavily-rest']);
const RUNTIME_CONFIG_ENDPOINT = '/api/admin/runtime-config';
const PROVIDER_CONFIG_ENDPOINT = '/api/admin/provider-config';
const KNOWLEDGE_BASE_ENDPOINT = '/api/admin/knowledge-bases';
const KNOWLEDGE_BASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_KNOWLEDGE_BASES = 32;

const CONNECTION_PRESETS = Object.freeze({
  bailian: Object.freeze({
    id: 'bailian', label: '阿里云百炼',
    defaultApiBase: 'https://dashscope.aliyuncs.com/apps/anthropic',
    defaultProtocol: 'anthropic-messages', authMode: 'x-api-key',
    requestProfile: 'anthropic-standard', efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'xhigh',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
  }),
  deepseek: Object.freeze({
    id: 'deepseek', label: 'DeepSeek 官网',
    defaultApiBase: 'https://api.deepseek.com',
    defaultProtocol: 'openai-chat-completions', authMode: 'bearer',
    requestProfile: 'deepseek-openai', efforts: ['low', 'high', 'max'], defaultEffort: 'high',
    docsUrl: 'https://api-docs.deepseek.com/zh-cn/',
  }),
  glm: Object.freeze({
    id: 'glm', label: 'GLM / 智谱官网',
    defaultApiBase: 'https://open.bigmodel.cn/api/paas/v4',
    defaultProtocol: 'openai-chat-completions', authMode: 'bearer',
    requestProfile: 'glm-openai', efforts: ['low', 'high'], defaultEffort: 'high',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
  }),
  kimi: Object.freeze({
    id: 'kimi', label: 'Kimi / Moonshot 官网',
    defaultApiBase: 'https://api.moonshot.cn/v1',
    defaultProtocol: 'openai-chat-completions', authMode: 'bearer',
    requestProfile: 'default', efforts: ['default'], defaultEffort: 'default',
    docsUrl: 'https://platform.moonshot.cn/docs/',
  }),
  custom: Object.freeze({
    id: 'custom', label: '自定义兼容服务', defaultApiBase: '',
    defaultProtocol: 'openai-chat-completions', authMode: 'bearer',
    requestProfile: 'default', efforts: ['default'], defaultEffort: 'default', docsUrl: '',
  }),
});

const state = {
  session: null,
  config: null,
  revision: '',
  originalConnections: new Map(),
  dirty: false,
  dirtyRuntime: false,
  dirtyProviders: false,
  dirtyWebSearch: false,
  dirtyBranding: false,
  dirtyEmbedding: false,
  loading: false,
  saving: false,
  checkingConnectionId: '',
  validationStageId: '',
  validationStageExpiresAt: '',
  validationStageProviderIndexes: new Set(),
  validationStageLocalConnectionIds: new Set(),
  validationStageIdAssignments: { providers: [], models: [] },
  validationStageTimer: 0,
  candidateEditVersion: 0,
  building: false,
  activeRebuildId: '',
  cancellingRebuildId: '',
  pollTimer: 0,
  providerApiAvailable: false,
  providerOptions: Object.values(CONNECTION_PRESETS),
  workspaceStatus: null,
  knowledgeBaseRegistry: null,
  knowledgeBaseId: '',
  requestedKnowledgeBaseId: '',
  knowledgeBaseDirty: false,
  savingKnowledgeBases: false,
};

const elements = {
  gate: document.querySelector('#admin-gate'),
  gateTitle: document.querySelector('#gate-title'),
  gateMessage: document.querySelector('#gate-message'),
  gateAction: document.querySelector('#gate-action'),
  gateRetry: document.querySelector('#gate-retry'),
  app: document.querySelector('#admin-app'),
  user: document.querySelector('#admin-user'),
  knowledgeBaseField: document.querySelector('#admin-knowledge-base-field'),
  knowledgeBaseSelect: document.querySelector('#admin-knowledge-base-select'),
  knowledgeBaseConfig: document.querySelector('#knowledge-base-config'),
  knowledgeBaseList: document.querySelector('#knowledge-base-list'),
  knowledgeBaseTemplate: document.querySelector('#knowledge-base-template'),
  knowledgeBaseAdd: document.querySelector('#knowledge-base-add'),
  knowledgeBaseSave: document.querySelector('#knowledge-base-save'),
  description: document.querySelector('#admin-description'),
  brandName: document.querySelector('#admin-brand-name'),
  pageTitle: document.querySelector('#admin-page-title'),
  vaultName: document.querySelector('#admin-vault-name'),
  brandingAppName: document.querySelector('#branding-app-name'),
  brandingVaultLabel: document.querySelector('#branding-vault-label'),
  form: document.querySelector('#runtime-config-form'),
  reload: document.querySelector('#config-reload'),
  save: document.querySelector('#config-save'),
  revision: document.querySelector('#config-revision'),
  sourceLabel: document.querySelector('#config-source-label'),
  validity: document.querySelector('#config-validity'),
  indexSummary: document.querySelector('#index-summary'),
  staleNotice: document.querySelector('#config-stale-notice'),
  message: document.querySelector('#config-message'),
  connectionPreset: document.querySelector('#connection-preset'),
  connectionAdd: document.querySelector('#connection-add'),
  connectionList: document.querySelector('#connection-list'),
  connectionTemplate: document.querySelector('#connection-template'),
  modelAdd: document.querySelector('#model-add'),
  modelList: document.querySelector('#model-list'),
  modelTemplate: document.querySelector('#model-template'),
  defaultModel: document.querySelector('#default-model'),
  webEnabled: document.querySelector('#web-enabled'),
  webProviderList: document.querySelector('#web-provider-list'),
  embeddingProvider: document.querySelector('#embedding-provider'),
  embeddingModel: document.querySelector('#embedding-model'),
  embeddingUrl: document.querySelector('#embedding-url'),
  embeddingDimensions: document.querySelector('#embedding-dimensions'),
  embeddingKeyAction: document.querySelector('#embedding-key-action'),
  embeddingKeyField: document.querySelector('#embedding-key-field'),
  embeddingKey: document.querySelector('#embedding-key'),
  embeddingKeyState: document.querySelector('#embedding-key-state'),
  adminPassword: document.querySelector('#admin-password'),
  activeIndex: document.querySelector('#active-index'),
  pendingIndex: document.querySelector('#pending-index'),
  progressBlock: document.querySelector('#index-progress-block'),
  progress: document.querySelector('#index-progress'),
  progressText: document.querySelector('#index-progress-text'),
  indexDetail: document.querySelector('#index-detail'),
  build: document.querySelector('#embedding-build'),
  cancelBuild: document.querySelector('#embedding-cancel'),
  toast: document.querySelector('#admin-toast'),
};

function scopedApiPath(path) {
  const url = new URL(path, window.location.origin);
  const eligible = (
    (url.pathname.startsWith('/api/knowledge/') && url.pathname !== '/api/knowledge/bases') ||
    url.pathname === RUNTIME_CONFIG_ENDPOINT ||
    url.pathname.startsWith(`${PROVIDER_CONFIG_ENDPOINT}/`) ||
    url.pathname === PROVIDER_CONFIG_ENDPOINT ||
    url.pathname === '/api/admin/embedding-rebuild'
  );
  if (eligible && state.knowledgeBaseId) {
    url.searchParams.set('knowledgeBaseId', state.knowledgeBaseId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!['GET', 'HEAD'].includes(method)) headers.set('X-VaultMind-Request', '1');
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(scopedApiPath(path), {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    method,
    headers,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.code = payload.error || payload.code || '';
      error.configurationSaved = payload.configurationSaved === true;
      error.results = Array.isArray(payload.results) ? payload.results : [];
      error.webSearch = payload.webSearch && typeof payload.webSearch === 'object'
        ? payload.webSearch
        : null;
      throw error;
    }
    return payload;
  });
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listValue(value) {
  return Array.isArray(value) ? value : [];
}

function credentialConfigured(value) {
  return value?.apiKeyConfigured === true || value?.keyConfigured === true ||
    value?.configured === true || value?.hasKey === true;
}

function inferredProviderId(connection = {}) {
  const explicit = text(connection.providerId || connection.preset);
  if (explicit && (CONNECTION_PRESETS[explicit] || state.providerOptions.some((item) => item.id === explicit))) {
    return explicit;
  }
  try {
    const hostname = new URL(connection.apiBase || connection.baseUrl).hostname.toLowerCase();
    if (hostname === 'dashscope.aliyuncs.com') return 'bailian';
    if (hostname === 'api.deepseek.com') return 'deepseek';
    if (hostname === 'open.bigmodel.cn') return 'glm';
    if (hostname === 'api.moonshot.cn') return 'kimi';
  } catch {}
  return 'custom';
}

function normalizeProviderOptions(value) {
  const options = listValue(value).map((provider) => ({
    id: text(provider?.id),
    label: text(provider?.label, text(provider?.id, '未命名供应商')),
    defaultApiBase: text(provider?.defaultApiBase || provider?.apiBase),
    defaultProtocol: text(provider?.defaultProtocol, 'openai-chat-completions'),
    protocols: listValue(provider?.protocols),
    docsUrl: text(provider?.docsUrl),
  })).filter((provider) => provider.id);
  return options.length ? options : Object.values(CONNECTION_PRESETS);
}

function safeHttpsLink(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.toString()
      : '';
  } catch {
    return '';
  }
}

function normalizeConnections(value) {
  return listValue(value).map((connection) => ({
    id: text(connection?.id),
    label: text(connection?.label, text(connection?.id, '未命名供应商')),
    providerId: inferredProviderId(connection),
    protocol: text(connection?.protocol, 'openai-chat-completions'),
    apiBase: text(connection?.apiBase || connection?.baseUrl),
    authMode: text(connection?.authMode, connection?.protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'),
    endpointPreview: text(connection?.endpointPreview),
    docsUrl: text(connection?.docsUrl),
    apiKeyConfigured: credentialConfigured(connection),
  }));
}

function normalizeModels(value) {
  const models = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value).map(([id, model]) => ({ id, ...model }))
      : [];
  return models.map((model) => {
    const efforts = Array.isArray(model?.efforts)
      ? model.efforts
      : String(model?.efforts || '').split(',');
    return {
      id: text(model?.id || model?.slot),
      displayName: text(model?.displayName || model?.label, text(model?.id, '未命名模型')),
      shortLabel: text(model?.shortLabel, text(model?.displayName || model?.label || model?.id)),
      connectionId: text(model?.connectionId || model?.provider),
      actualModel: text(model?.actualModel || model?.model),
      requestProfile: text(model?.requestProfile, 'default'),
      efforts: [...new Set(efforts.map((effort) => text(effort).toLowerCase()).filter(Boolean))],
      defaultEffort: text(model?.defaultEffort || model?.effort, 'default').toLowerCase(),
      reasoningMapping: normalizeReasoningMapping(model?.reasoningMapping),
      effortMapping: normalizeEffortMapping(model?.effortMapping),
      automaticEffortMapping: normalizeEffortMapping(model?.automaticEffortMapping),
      enabled: model?.enabled !== false,
    };
  });
}

function normalizeEffortMapping(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(UNIVERSAL_EFFORTS.flatMap((effort) => {
    const mapped = text(value[effort]).toLowerCase();
    return REASONING_MAPPING_VALUES.includes(mapped) ? [[effort, mapped]] : [];
  }));
}

function normalizeReasoningMapping(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.mode !== 'manual') {
    return { mode: 'auto' };
  }
  const tiers = normalizeEffortMapping(value.tiers);
  return UNIVERSAL_EFFORTS.every((effort) => Object.hasOwn(tiers, effort))
    ? { mode: 'manual', tiers }
    : { mode: 'auto' };
}

function normalizeWebProviders(webSearch) {
  const input = webSearch?.providers;
  const entries = Array.isArray(input)
    ? input
    : input && typeof input === 'object'
      ? Object.entries(input).map(([id, provider]) => ({ id, ...provider }))
      : [];
  return Object.fromEntries(WEB_PROVIDERS.map((id) => {
    const provider = entries.find((entry) => entry?.id === id) || {};
    return [id, {
      id,
      label: text(provider.label, id === 'bailian-mcp' ? '百炼 WebSearch' : 'Tavily'),
      apiKeyConfigured: credentialConfigured(provider),
      extractFallbackEnabled: provider.extractFallbackEnabled === true,
    }];
  }));
}

function normalizedConfig(payload) {
  const providerPayload = payload?.providerConfigPayload || null;
  const runtimePayload = payload?.runtimeConfigPayload || payload;
  const runtimeBody = runtimePayload?.config && typeof runtimePayload.config === 'object'
    ? runtimePayload.config : runtimePayload || {};
  const providerBody = providerPayload?.config && typeof providerPayload.config === 'object'
    ? providerPayload.config : providerPayload || {};
  const providerSchema = Number(providerBody.schemaVersion);
  const isProviderDto = providerSchema === PROVIDER_SCHEMA_VERSION && Array.isArray(providerBody.providers);
  const schemaVersion = Number(runtimeBody.schemaVersion || runtimeBody.version || runtimePayload?.schemaVersion);
  if (!isProviderDto && (schemaVersion !== SCHEMA_VERSION || !Array.isArray(runtimeBody.connections))) {
    const error = new Error('服务端尚未提供 v2 动态配置接口，请先升级 Second Mind 服务端。');
    error.code = 'RUNTIME_CONFIG_SERVER_UPGRADE_REQUIRED';
    throw error;
  }
  state.providerOptions = normalizeProviderOptions(providerBody.providerOptions);
  const dtoProviders = isProviderDto ? providerBody.providers : [];
  const connections = isProviderDto
    ? normalizeConnections(dtoProviders)
    : normalizeConnections(runtimeBody.connections);
  const models = isProviderDto
    ? normalizeModels(dtoProviders.flatMap((provider) => listValue(provider.models).map((model) => ({
      ...model,
      connectionId: provider.id,
    }))))
    : normalizeModels(runtimeBody.models || runtimeBody.modelCatalog);
  if (models.length > MAX_MODELS) {
    const error = new Error(`当前配置含 ${models.length} 个模型；简化页面最多管理 ${MAX_MODELS} 个，请先缩减模型目录。`);
    error.code = 'TOO_MANY_MODELS_FOR_SIMPLE_UI';
    throw error;
  }
  const supportingBody = isProviderDto ? providerBody : runtimeBody;
  const embedding = { ...(supportingBody.embedding || {}) };
  for (const secretField of ['apiKey', 'key', 'token', 'authorization']) delete embedding[secretField];
  const webSearch = { ...(supportingBody.webSearch || {}) };
  for (const secretField of ['apiKey', 'key', 'token', 'authorization']) delete webSearch[secretField];
  webSearch.providers = normalizeWebProviders(webSearch);
  const index = supportingBody.index || embedding.index || {};
  const rebuild = supportingBody.rebuild || embedding.rebuild || supportingBody.embeddingRebuild || {};
  const branding = { ...(providerBody.branding || runtimeBody.branding || {}) };
  return {
    schemaVersion: SCHEMA_VERSION,
    providerSchemaVersion: isProviderDto ? PROVIDER_SCHEMA_VERSION : null,
    revision: text(providerPayload?.revision || providerBody.revision || runtimePayload?.revision || runtimeBody.revision),
    stale: providerPayload?.stale === true || providerBody.stale === true || runtimePayload?.stale === true || runtimeBody.stale === true,
    source: isProviderDto ? 'provider-config' : 'managed',
    connections,
    models,
    defaultModelId: text(providerBody.defaultModelId || runtimeBody.defaultModelId),
    branding,
    webSearch,
    embedding,
    index,
    rebuild,
  };
}

let toastTimer;
function toast(message, error = false) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', error);
  elements.toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 3200);
}

function showMessage(message, type = '') {
  elements.message.textContent = message;
  elements.message.className = `notice${type ? ` notice-${type}` : ''}`;
  elements.message.hidden = !message;
}

function webValidationFailureMessage(error) {
  const detail = error?.webSearch;
  if (!detail || detail.ok !== false) return '';
  const provider = detail.provider === 'tavily-rest' ? 'Tavily' : '百炼 WebSearch';
  const causeCode = /^[A-Z][A-Z0-9_]{0,79}$/u.test(String(detail.causeCode || ''))
    ? detail.causeCode
    : detail.code;
  const codeSuffix = causeCode ? `（错误码：${causeCode}）` : '';
  if (detail.stage === 'extract' && detail.searchPassed === true) {
    const fallback = detail.provider === 'tavily-rest' ? 'Tavily Extract 兜底' : '网页抽取兜底';
    return `${provider} 的搜索检查已通过，但“${fallback}”检查失败${codeSuffix}。` +
      '本次 Key 尚未保存；若只需要联网搜索，请取消勾选该抽取兜底后重新保存。' +
      '服务端安全网页直读不受影响。';
  }
  return `${provider} 的联网搜索检查失败${codeSuffix}，网页抽取尚未检查。` +
    '请核对当前供应商、Key、接口权限和额度后重试。';
}

function setGate(title, message, { action = false, retry = false } = {}) {
  elements.gateTitle.textContent = title;
  elements.gateMessage.textContent = message;
  elements.gateAction.hidden = !action;
  elements.gateRetry.hidden = !retry;
  elements.gate.hidden = false;
  elements.app.hidden = true;
}

function uniqueId(base, selector, fieldSelector) {
  const taken = new Set([...document.querySelectorAll(selector)]
    .map((node) => node.querySelector(fieldSelector)?.value.trim().toLowerCase())
    .filter(Boolean));
  const stem = String(base || 'item').toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'item';
  if (!taken.has(stem)) return stem;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}`;
}

function connectionCards() {
  return [...elements.connectionList.querySelectorAll('[data-connection-card]')];
}

function modelRows() {
  return [...elements.modelList.querySelectorAll('[data-model-row]')];
}

function knowledgeBaseCards() {
  return [...elements.knowledgeBaseList.querySelectorAll('[data-knowledge-base-card]')];
}

function knowledgeBaseField(card, name) {
  return card.querySelector(`[data-knowledge-base-field="${name}"]`);
}

function knowledgeBaseUsable(entry) {
  return entry?.enabled !== false && entry?.pathAvailable !== false && entry?.status === 'ready';
}

function knowledgeBaseStatusText(entry) {
  if (!entry?.knowledgeBaseId) return '尚未保存';
  if (entry.enabled === false || entry.status === 'disabled') return '已禁用';
  if (entry.status === 'ready') {
    const count = Math.max(0, Number(entry.retrieval?.documentCount) || 0);
    return `可用 · ${count} 个文档`;
  }
  if (entry.status === 'starting') return '正在启动';
  return entry.errorCode ? `不可用 · ${entry.errorCode}` : '不可用';
}

function renderKnowledgeBase(entry = {}, { existing = true } = {}) {
  const card = elements.knowledgeBaseTemplate.content.firstElementChild.cloneNode(true);
  card.dataset.existing = existing ? 'true' : 'false';
  const id = knowledgeBaseField(card, 'knowledgeBaseId');
  id.value = text(entry.knowledgeBaseId);
  id.readOnly = existing;
  knowledgeBaseField(card, 'name').value = text(entry.name);
  const mount = knowledgeBaseField(card, 'mountId');
  mount.replaceChildren(...listValue(state.knowledgeBaseRegistry?.allowedMounts).map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    return option;
  }));
  mount.value = text(entry.mountId, mount.options[0]?.value || '');
  knowledgeBaseField(card, 'relativePath').value = text(entry.relativePath, '.');
  knowledgeBaseField(card, 'enabled').checked = entry.enabled !== false;
  card.querySelector('[data-knowledge-base-default]').checked = entry.default === true;
  const status = card.querySelector('[data-knowledge-base-status]');
  status.textContent = knowledgeBaseStatusText(entry);
  status.classList.toggle('is-ready', knowledgeBaseUsable(entry));
  status.classList.toggle('is-error', entry.status === 'failed' || entry.pathAvailable === false);
  elements.knowledgeBaseList.append(card);
  return card;
}

function chooseKnowledgeBase(registry, preferred = '') {
  const entries = listValue(registry?.knowledgeBases);
  return entries.find((entry) => entry.knowledgeBaseId === preferred && knowledgeBaseUsable(entry)) ||
    entries.find((entry) => entry.knowledgeBaseId === registry?.defaultKnowledgeBaseId && knowledgeBaseUsable(entry)) ||
    entries.find(knowledgeBaseUsable) || null;
}

function renderKnowledgeBaseSelector(registry, preferred = '') {
  const selected = chooseKnowledgeBase(registry, preferred);
  elements.knowledgeBaseSelect.replaceChildren(...listValue(registry?.knowledgeBases).map((entry) => {
    const option = document.createElement('option');
    option.value = entry.knowledgeBaseId;
    option.textContent = `${entry.name} · ${knowledgeBaseStatusText(entry)}`;
    option.disabled = !knowledgeBaseUsable(entry);
    return option;
  }));
  state.knowledgeBaseId = selected?.knowledgeBaseId || '';
  elements.knowledgeBaseSelect.value = state.knowledgeBaseId;
  elements.knowledgeBaseField.hidden = false;
  elements.knowledgeBaseSelect.disabled = !selected;
  return selected;
}

function updateSelectedKnowledgeBaseUrl() {
  const url = new URL(window.location.href);
  if (state.knowledgeBaseId) url.searchParams.set('knowledgeBaseId', state.knowledgeBaseId);
  else url.searchParams.delete('knowledgeBaseId');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function applyKnowledgeBaseRegistry(registry, { preferred = state.knowledgeBaseId, preserveEdits = false } = {}) {
  state.knowledgeBaseRegistry = registry;
  const selected = renderKnowledgeBaseSelector(registry, preferred);
  if (!preserveEdits) {
    elements.knowledgeBaseList.replaceChildren();
    for (const entry of listValue(registry?.knowledgeBases)) renderKnowledgeBase(entry);
    state.knowledgeBaseDirty = false;
  }
  elements.knowledgeBaseConfig.hidden = false;
  updateSelectedKnowledgeBaseUrl();
  setBusyState();
  return selected;
}

async function loadKnowledgeBases({ quiet = false, preserveEdits = false } = {}) {
  if (state.session?.permissions?.manageKnowledgeBases !== true) return null;
  const registry = await api(KNOWLEDGE_BASE_ENDPOINT);
  const preferred = state.requestedKnowledgeBaseId || state.knowledgeBaseId || registry.defaultKnowledgeBaseId;
  state.requestedKnowledgeBaseId = '';
  applyKnowledgeBaseRegistry(registry, { preferred, preserveEdits });
  if (!quiet) showMessage('已读取知识库注册表。', 'success');
  return registry;
}

function markKnowledgeBaseDirty() {
  state.knowledgeBaseDirty = true;
  state.dirty = true;
  setBusyState();
}

function addKnowledgeBase() {
  if (knowledgeBaseCards().length >= MAX_KNOWLEDGE_BASES) {
    showMessage(`最多可配置 ${MAX_KNOWLEDGE_BASES} 个知识库。`, 'error');
    return;
  }
  const id = uniqueId('knowledge-base', '[data-knowledge-base-card]', '[data-knowledge-base-field="knowledgeBaseId"]');
  const card = renderKnowledgeBase({
    knowledgeBaseId: id,
    name: '新知识库',
    mountId: state.knowledgeBaseRegistry?.allowedMounts?.[0]?.id || '',
    relativePath: '.',
    enabled: true,
    default: false,
  }, { existing: false });
  if (!knowledgeBaseCards().some((item) => item.querySelector('[data-knowledge-base-default]').checked)) {
    card.querySelector('[data-knowledge-base-default]').checked = true;
  }
  markKnowledgeBaseDirty();
  knowledgeBaseField(card, 'knowledgeBaseId').focus();
}

function removeKnowledgeBase(card) {
  if (knowledgeBaseCards().length <= 1) {
    showMessage('至少要保留一个知识库注册项。', 'error');
    return;
  }
  const name = knowledgeBaseField(card, 'name').value.trim() || '该知识库';
  if (!window.confirm(`移除“${name}”的注册项？笔记、索引、会话和草稿都不会被删除。`)) return;
  const wasDefault = card.querySelector('[data-knowledge-base-default]').checked;
  card.remove();
  if (wasDefault) {
    const replacement = knowledgeBaseCards().find((item) => knowledgeBaseField(item, 'enabled').checked);
    if (replacement) replacement.querySelector('[data-knowledge-base-default]').checked = true;
  }
  markKnowledgeBaseDirty();
}

function collectKnowledgeBases() {
  const cards = knowledgeBaseCards();
  if (!cards.length || cards.length > MAX_KNOWLEDGE_BASES) {
    throw new Error(`知识库数量必须是 1–${MAX_KNOWLEDGE_BASES}。`);
  }
  const allowedMounts = new Set(listValue(state.knowledgeBaseRegistry?.allowedMounts).map((item) => item.id));
  const seen = new Set();
  const entries = cards.map((card) => {
    const knowledgeBaseId = knowledgeBaseField(card, 'knowledgeBaseId').value.trim().toLowerCase();
    const name = knowledgeBaseField(card, 'name').value.trim();
    const mountId = knowledgeBaseField(card, 'mountId').value;
    const relativePath = knowledgeBaseField(card, 'relativePath').value.trim().replaceAll('\\', '/');
    const enabled = knowledgeBaseField(card, 'enabled').checked;
    const isDefault = card.querySelector('[data-knowledge-base-default]').checked;
    if (!KNOWLEDGE_BASE_ID_PATTERN.test(knowledgeBaseId)) throw new Error('知识库稳定 ID 只能使用小写字母、数字、点、下划线和连字符。');
    if (seen.has(knowledgeBaseId)) throw new Error('知识库稳定 ID 不能重复。');
    if (!name || name.length > 120) throw new Error('每个知识库都需要 1–120 个字符的显示名称。');
    if (!allowedMounts.has(mountId)) throw new Error('请选择启动时授权的挂载点。');
    if (!relativePath || relativePath.startsWith('/') || /^[A-Za-z]:\//u.test(relativePath) || relativePath.split('/').includes('..')) {
      throw new Error('知识库目录必须是挂载点内的相对路径，不能包含上级目录跳转。');
    }
    seen.add(knowledgeBaseId);
    return { knowledgeBaseId, name, mountId, relativePath, enabled, default: isDefault };
  });
  const enabled = entries.filter((entry) => entry.enabled);
  if (!enabled.length) throw new Error('至少要启用一个知识库。');
  if (enabled.filter((entry) => entry.default).length !== 1 || entries.some((entry) => entry.default && !entry.enabled)) {
    throw new Error('必须且只能将一个已启用的知识库设为默认。');
  }
  return entries;
}

async function saveKnowledgeBases() {
  if (!state.knowledgeBaseDirty || state.savingKnowledgeBases) {
    if (!state.knowledgeBaseDirty) showMessage('知识库注册表没有待保存的修改。', 'success');
    return;
  }
  const adminPassword = elements.adminPassword.value;
  let knowledgeBases;
  try {
    knowledgeBases = collectKnowledgeBases();
    if (!adminPassword) throw new Error('请输入当前管理员密码以确认注册表修改。');
  } catch (error) {
    showMessage(error.message, 'error');
    return;
  }
  if (!window.confirm('保存知识库注册表？被修改或移除的知识库必须没有运行中的任务，服务器会重新校验全部路径边界。')) return;
  state.savingKnowledgeBases = true;
  setBusyState();
  try {
    const response = await api(KNOWLEDGE_BASE_ENDPOINT, {
      method: 'PUT',
      body: JSON.stringify({
        expectedRevision: state.knowledgeBaseRegistry.revision,
        knowledgeBases,
        adminPassword,
      }),
    });
    const selected = applyKnowledgeBaseRegistry(response, { preferred: state.knowledgeBaseId });
    state.dirty = state.dirtyRuntime || state.dirtyEmbedding;
    showMessage('知识库注册表已原子保存；笔记和历史数据均未删除。', 'success');
    toast('知识库注册表已保存');
    if (selected) await loadConfig({ quiet: true });
  } catch (error) {
    if (error.status === 409) {
      showMessage(error.code === 'KNOWLEDGE_BASE_BUSY'
        ? '相关知识库仍有运行中的任务；请等待任务结束后再保存。'
        : '注册表已被其他页面更新；当前编辑仍保留，请刷新并核对后重试。', 'warning');
    } else {
      showMessage(`注册表保存失败：${error.message}`, 'error');
    }
  } finally {
    elements.adminPassword.value = '';
    state.savingKnowledgeBases = false;
    setBusyState();
  }
}

function connectionField(card, name) {
  return card.querySelector(`[data-connection-field="${name}"]`);
}

function modelField(row, name) {
  return row.querySelector(`[data-model-field="${name}"]`);
}

function effortList(value) {
  return [...new Set(String(value || '')
    .split(/[，,\s]+/u)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))];
}

function syncDefaultEffort(row, preferred = '') {
  const effortInput = modelField(row, 'efforts');
  const defaultSelect = modelField(row, 'defaultEffort');
  const efforts = effortList(effortInput.value);
  const selected = preferred || defaultSelect.value;
  defaultSelect.replaceChildren(...efforts.map((effort) => {
    const option = document.createElement('option');
    option.value = effort;
    option.textContent = effort;
    return option;
  }));
  defaultSelect.value = efforts.includes(selected) ? selected : efforts[0] || '';
}

function modelReasoningMapping(row) {
  const manual = row.querySelector('[data-model-reasoning-manual]')?.checked === true;
  if (!manual) return { mode: 'auto' };
  return {
    mode: 'manual',
    tiers: Object.fromEntries(UNIVERSAL_EFFORTS.map((effort) => [
      effort,
      row.querySelector(`[data-model-reasoning-tier="${effort}"]`)?.value || effort,
    ])),
  };
}

function syncModelReasoningUi(row, model = null) {
  const manualControl = row.querySelector('[data-model-reasoning-manual]');
  const grid = row.querySelector('[data-model-reasoning-grid]');
  const summary = row.querySelector('[data-model-reasoning-summary]');
  const effective = row.querySelector('[data-model-reasoning-effective]');
  if (!manualControl || !grid || !summary || !effective) return;
  const initial = normalizeReasoningMapping(model?.reasoningMapping);
  if (model) manualControl.checked = initial.mode === 'manual';
  const automatic = normalizeEffortMapping(model?.automaticEffortMapping);
  const resolved = normalizeEffortMapping(model?.effortMapping);
  for (const effort of UNIVERSAL_EFFORTS) {
    const select = row.querySelector(`[data-model-reasoning-tier="${effort}"]`);
    const selected = model && initial.mode === 'manual' ? initial.tiers[effort] : select.value || effort;
    select.replaceChildren(...REASONING_MAPPING_VALUES.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = EFFORT_LABELS[value];
      return option;
    }));
    select.value = REASONING_MAPPING_VALUES.includes(selected) ? selected : effort;
  }
  const manual = manualControl.checked;
  grid.hidden = !manual;
  summary.textContent = manual ? '手动' : '自动（推荐）';
  const mapping = manual
    ? Object.fromEntries(UNIVERSAL_EFFORTS.map((effort) => [
        effort,
        row.querySelector(`[data-model-reasoning-tier="${effort}"]`).value,
      ]))
    : automatic;
  const effectiveParts = UNIVERSAL_EFFORTS.flatMap((effort) => {
    const semantic = mapping[effort];
    const wire = manual ? '' : resolved[effort];
    if (!semantic && !wire) return [];
    const target = wire || semantic;
    return [`${EFFORT_LABELS[effort]}→${EFFORT_LABELS[target] || target}`];
  });
  effective.textContent = effectiveParts.length
    ? `${manual ? '保存后仍由供应商能力投影：' : '当前自动映射：'}${effectiveParts.join('，')}`
    : manual
      ? '保存后，服务端会再次按供应商实际能力投影。'
      : '保存时由服务端根据供应商能力自动生成。';
}

function providerOption(providerId) {
  return state.providerOptions.find((item) => item.id === providerId) || CONNECTION_PRESETS[providerId] || CONNECTION_PRESETS.custom;
}

function providerIdForCard(card) {
  return card.querySelector('[data-provider-preset]')?.value || 'custom';
}

function providerProtocol(card) {
  const id = providerIdForCard(card);
  const apiBase = connectionField(card, 'apiBase').value.trim();
  if (id === 'custom') return connectionField(card, 'protocol').value || 'openai-chat-completions';
  if (id === 'bailian' && /\/compatible-mode\/v1(?:\/chat\/completions)?\/?$/iu.test(apiBase)) {
    return 'openai-chat-completions';
  }
  return providerOption(id).defaultProtocol || CONNECTION_PRESETS[id]?.defaultProtocol || 'openai-chat-completions';
}

function endpointPreview(apiBase, protocol) {
  const clean = String(apiBase || '').trim().replace(/\/+$/u, '');
  if (!clean) return '填写 API Base 后显示';
  const suffix = protocol === 'anthropic-messages' ? '/v1/messages' : '/chat/completions';
  if (clean.endsWith(suffix)) return clean;
  if (protocol === 'anthropic-messages' && clean.endsWith('/v1')) return `${clean}/messages`;
  return `${clean}${suffix}`;
}

function replaceProviderSelectOptions(select, preferred = '') {
  const options = state.providerOptions.length ? state.providerOptions : Object.values(CONNECTION_PRESETS);
  select.replaceChildren(...options.map((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    return option;
  }));
  select.value = options.some((item) => item.id === preferred) ? preferred : options[0]?.id || 'custom';
}

function refreshProviderChoiceLists() {
  replaceProviderSelectOptions(elements.connectionPreset, elements.connectionPreset.value || 'bailian');
  for (const card of connectionCards()) {
    replaceProviderSelectOptions(card.querySelector('[data-provider-preset]'), providerIdForCard(card));
  }
}

function syncProviderCard(card, { applyDefaults = false } = {}) {
  const providerId = providerIdForCard(card);
  const option = providerOption(providerId);
  const fallback = CONNECTION_PRESETS[providerId] || CONNECTION_PRESETS.custom;
  const advanced = card.querySelector('[data-provider-advanced]');
  const apiBase = connectionField(card, 'apiBase');
  const label = connectionField(card, 'label');
  const protocol = connectionField(card, 'protocol');
  const authMode = connectionField(card, 'authMode');
  if (applyDefaults) {
    apiBase.value = option.defaultApiBase || fallback.defaultApiBase || '';
    label.value = option.label || fallback.label;
    protocol.value = option.defaultProtocol || fallback.defaultProtocol;
    authMode.value = fallback.authMode || (protocol.value === 'anthropic-messages' ? 'x-api-key' : 'bearer');
  }
  if (providerId !== 'custom') {
    protocol.value = providerProtocol(card);
    authMode.value = protocol.value === 'anthropic-messages' ? 'x-api-key' : 'bearer';
    if (applyDefaults || !label.value.trim()) label.value = option.label || fallback.label;
    advanced.hidden = true;
    advanced.open = false;
  } else {
    advanced.hidden = false;
    if (!label.value.trim()) label.value = option.label || fallback.label;
  }
  const preview = card.dataset.endpointPreview && !applyDefaults
    ? card.dataset.endpointPreview
    : endpointPreview(apiBase.value, providerProtocol(card));
  card.dataset.endpointPreview = '';
  card.querySelector('[data-provider-endpoint]').textContent = preview;
  const docs = card.querySelector('[data-provider-docs]');
  const docsUrl = safeHttpsLink(card.dataset.docsUrl || option.docsUrl || fallback.docsUrl || '');
  docs.hidden = !docsUrl;
  if (docsUrl) docs.href = docsUrl;
  else docs.removeAttribute('href');
  card.querySelector('[data-connection-title]').textContent = providerId === 'custom'
    ? label.value.trim() || 'Custom'
    : option.label || fallback.label || 'Provider';
  setConnectionKeyUi(card);
}

function connectionOptions() {
  return connectionCards().map((card) => ({
    id: connectionField(card, 'id').value.trim(),
    label: providerIdForCard(card) === 'custom'
      ? connectionField(card, 'label').value.trim()
      : providerOption(providerIdForCard(card)).label,
    protocol: providerProtocol(card),
  })).filter((connection) => connection.id);
}

function syncModelConnectionOptions(replacedId = '', replacementId = '') {
  const choices = connectionOptions();
  for (const row of modelRows()) {
    const select = modelField(row, 'connectionId');
    let selected = select.value;
    if (replacedId && selected === replacedId) selected = replacementId;
    select.replaceChildren(...choices.map((connection) => {
      const option = document.createElement('option');
      option.value = connection.id;
      option.textContent = connection.label || '未命名 Provider';
      return option;
    }));
    select.value = choices.some((choice) => choice.id === selected) ? selected : choices[0]?.id || '';
  }
  updateConnectionUsage();
}

function setConnectionKeyUi(card) {
  const action = card.querySelector('[data-connection-key-action]');
  const field = card.querySelector('[data-connection-key-field]');
  const input = card.querySelector('[data-connection-key]');
  const help = card.querySelector('[data-connection-key-help]');
  const status = card.querySelector('[data-connection-key-state]');
  const authMode = connectionField(card, 'authMode').value;
  const configured = card.dataset.apiKeyConfigured === 'true';
  const needsReplacement = action.value === 'replace';
  if (authMode === 'none') {
    action.value = 'clear';
    input.value = '';
  }
  field.hidden = authMode === 'none';
  input.required = action.value === 'replace' && authMode !== 'none' && !state.validationStageId;
  input.placeholder = configured ? '已配置时留空即可保留' : '请输入 API Key';
  if (authMode === 'none') {
    status.textContent = '此 Provider 不使用 Key';
    help.textContent = '当前连接设置为无鉴权。';
  } else if (needsReplacement && state.validationStageId && !input.value) {
    status.textContent = '新 Key 已安全暂存（浏览器中已清空）';
    help.textContent = '本轮检查有效时无需再次填写；修改配置后需要重新输入。';
  } else if (needsReplacement) {
    status.textContent = configured ? '目标或 Key 已变化，等待替换' : '服务端尚未配置 Key';
    help.textContent = '请输入该 Provider 当前地址所使用的 API Key。';
  } else {
    status.textContent = '服务端已配置 Key（不会回显）';
    help.textContent = '留空保留服务端现有 Key；输入新值即替换。';
  }
}

function connectionTransportChanged(card) {
  const original = state.originalConnections.get(card.dataset.originalId || '');
  if (!original) return true;
  const normalizeUrl = (value) => String(value || '').trim().replace(/\/+$/u, '');
  return providerIdForCard(card) !== original.providerId ||
    providerProtocol(card) !== original.protocol ||
    normalizeUrl(connectionField(card, 'apiBase').value) !== normalizeUrl(original.apiBase) ||
    connectionField(card, 'authMode').value !== original.authMode;
}

function enforceConnectionCredentialChange(card) {
  const action = card.querySelector('[data-connection-key-action]');
  const input = card.querySelector('[data-connection-key]');
  const authMode = connectionField(card, 'authMode').value;
  if (authMode === 'none') {
    action.value = 'clear';
    setConnectionKeyUi(card);
    return;
  }
  const mustReplace = connectionTransportChanged(card) || card.dataset.apiKeyConfigured !== 'true';
  const previousAction = action.value;
  action.value = input.value.trim() || mustReplace ? 'replace' : 'keep';
  setConnectionKeyUi(card);
  if (mustReplace && previousAction !== 'replace') {
    showMessage('供应商、API 地址或鉴权方式已变化，请填写该目标对应的新 Key。', 'warning');
  }
}

function updateConnectionUsage() {
  const references = new Map();
  for (const row of modelRows()) {
    const id = modelField(row, 'connectionId').value;
    references.set(id, (references.get(id) || 0) + 1);
  }
  for (const card of connectionCards()) {
    const id = connectionField(card, 'id').value.trim();
    const count = references.get(id) || 0;
    const providerId = providerIdForCard(card);
    card.querySelector('[data-connection-title]').textContent = providerId === 'custom'
      ? connectionField(card, 'label').value.trim() || 'Custom'
      : providerOption(providerId).label;
    card.querySelector('[data-connection-usage]').textContent = count ? `${count} 个模型正在使用` : '未被模型使用';
    const remove = card.querySelector('[data-connection-delete]');
    remove.disabled = connectionCards().length <= 1;
    remove.title = count
      ? `删除此 Provider 时会同时删除其 ${count} 个模型和服务端凭据`
      : '删除此 Provider 及其服务端凭据';
  }
}

function renderConnection(connection, { persisted = true } = {}) {
  const card = elements.connectionTemplate.content.firstElementChild.cloneNode(true);
  card.dataset.persisted = String(persisted);
  card.dataset.apiKeyConfigured = String(connection.apiKeyConfigured === true);
  card.dataset.originalId = persisted ? connection.id : '';
  card.dataset.lastId = connection.id;
  card.dataset.endpointPreview = connection.endpointPreview || '';
  card.dataset.docsUrl = connection.docsUrl || '';
  replaceProviderSelectOptions(card.querySelector('[data-provider-preset]'), connection.providerId || inferredProviderId(connection));
  for (const name of ['id', 'label', 'protocol', 'apiBase', 'authMode']) {
    connectionField(card, name).value = connection[name] || '';
  }
  const action = card.querySelector('[data-connection-key-action]');
  action.value = connection.authMode === 'none'
    ? 'clear'
    : persisted && connection.apiKeyConfigured
      ? 'keep'
      : 'replace';
  elements.connectionList.append(card);
  syncProviderCard(card);
  return card;
}

function addConnection() {
  if (connectionCards().length >= MAX_CONNECTIONS) {
    showMessage(`最多只能配置 ${MAX_CONNECTIONS} 个 Provider。`, 'error');
    return;
  }
  const providerId = elements.connectionPreset.value || 'custom';
  const preset = providerOption(providerId);
  const fallback = CONNECTION_PRESETS[providerId] || CONNECTION_PRESETS.custom;
  const id = uniqueId(preset.id, '[data-connection-card]', '[data-connection-field="id"]');
  const card = renderConnection({
    id,
    providerId,
    label: preset.label,
    protocol: preset.defaultProtocol || fallback.defaultProtocol,
    apiBase: preset.defaultApiBase || fallback.defaultApiBase,
    authMode: fallback.authMode,
    apiKeyConfigured: false,
  }, { persisted: false });
  card.querySelector('[data-connection-key-action]').value = fallback.authMode === 'none' ? 'clear' : 'replace';
  setConnectionKeyUi(card);
  syncModelConnectionOptions();
  markRuntimeDirty();
  card.querySelector('[data-provider-preset]').focus();
}

function deleteConnection(card) {
  const id = connectionField(card, 'id').value.trim();
  const referencedRows = modelRows().filter((row) => modelField(row, 'connectionId').value === id);
  if (connectionCards().length <= 1) {
    showMessage('至少需要保留一个 Provider。', 'warning');
    return;
  }
  const consequences = [
    referencedRows.length ? `其 ${referencedRows.length} 个生成模型` : '',
    card.dataset.apiKeyConfigured === 'true' ? '保存在服务器上的 API Key' : '',
  ].filter(Boolean).join('和');
  if (consequences && !window.confirm(`删除此 Provider 会同时删除${consequences}。确认继续？`)) return;
  for (const row of referencedRows) row.remove();
  card.remove();
  syncModelConnectionOptions();
  updateModelRowButtons();
  updateDefaultModelOptions();
  updateConnectionUsage();
  markRuntimeDirty();
  if (!modelRows().length) {
    showMessage('Provider 已删除；保存前请为保留的 Provider 添加至少一个生成模型。', 'warning');
  }
}

function suggestedProfile(connectionId) {
  const connection = connectionOptions().find((item) => item.id === connectionId);
  if (!connection) return 'default';
  const card = connectionCards().find((item) => connectionField(item, 'id').value.trim() === connectionId);
  const providerId = card ? providerIdForCard(card) : 'custom';
  if (providerId === 'bailian') return connection.protocol === 'anthropic-messages' ? 'anthropic-standard' : 'bailian-openai';
  if (providerId === 'deepseek') return 'deepseek-openai';
  if (providerId === 'glm') return 'glm-openai';
  return 'default';
}

function suggestedEfforts(connectionId) {
  const card = connectionCards().find((item) => connectionField(item, 'id').value.trim() === connectionId);
  const providerId = card ? providerIdForCard(card) : 'custom';
  const preset = CONNECTION_PRESETS[providerId] || CONNECTION_PRESETS.custom;
  return { efforts: [...preset.efforts], defaultEffort: preset.defaultEffort };
}

function renderModel(model, { persisted = true } = {}) {
  const row = elements.modelTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.persisted = String(persisted);
  const id = modelField(row, 'id');
  id.value = model.id || '';
  modelField(row, 'enabled').checked = model.enabled !== false;
  modelField(row, 'displayName').value = model.displayName || '';
  modelField(row, 'shortLabel').value = model.shortLabel || '';
  modelField(row, 'actualModel').value = model.actualModel || '';
  modelField(row, 'requestProfile').value = model.requestProfile || 'default';
  modelField(row, 'efforts').value = (model.efforts?.length ? model.efforts : ['default']).join(', ');
  elements.modelList.append(row);
  syncModelConnectionOptions();
  modelField(row, 'connectionId').value = model.connectionId || connectionOptions()[0]?.id || '';
  syncDefaultEffort(row, model.defaultEffort || model.efforts?.[0] || 'default');
  syncModelReasoningUi(row, model);
  const providerCard = connectionCards().find((card) => (
    connectionField(card, 'id').value.trim() === modelField(row, 'connectionId').value
  ));
  const clientAlias = providerCard && providerIdForCard(providerCard) !== 'custom' && /\[[^\]]+\]$/u.test(model.actualModel || '');
  setModelCheckState(
    row,
    clientAlias ? '需改为直连模型 ID' : persisted ? '已加载 · 保存时实测' : '待检查',
    clientAlias ? 'error' : persisted ? 'valid' : '',
  );
  updateModelRowButtons();
  return row;
}

function setModelCheckState(row, message = '待检查', kind = '') {
  const badge = row.querySelector('[data-model-check-state]');
  badge.textContent = message;
  badge.classList.toggle('is-valid', kind === 'valid');
  badge.classList.toggle('is-error', kind === 'error');
}

function syncModelAdapterFields(row, { force = false } = {}) {
  const connectionId = modelField(row, 'connectionId').value;
  const profile = suggestedProfile(connectionId);
  const suggestion = suggestedEfforts(connectionId);
  if (force || row.dataset.persisted === 'false') {
    modelField(row, 'requestProfile').value = profile;
    modelField(row, 'efforts').value = suggestion.efforts.join(', ');
    syncDefaultEffort(row, suggestion.defaultEffort);
  }
  // A Provider/model change can alter native reasoning capabilities. Automatic
  // mode follows the new adapter; an explicit semantic override remains intact
  // and is projected again by the server when saved.
  syncModelReasoningUi(row);
}

function addModel() {
  if (modelRows().length >= MAX_MODELS) {
    showMessage(`最多只能配置 ${MAX_MODELS} 个生成模型。`, 'error');
    return;
  }
  if (!connectionCards().length) {
    showMessage('请先添加一个 Provider。', 'warning');
    return;
  }
  const connectionId = connectionOptions()[0]?.id || '';
  const id = uniqueId('model', '[data-model-row]', '[data-model-field="id"]');
  const profile = suggestedProfile(connectionId);
  const suggestion = suggestedEfforts(connectionId);
  const row = renderModel({
    id,
    displayName: '',
    shortLabel: '',
    connectionId,
    actualModel: '',
    requestProfile: profile,
    efforts: suggestion.efforts,
    defaultEffort: suggestion.defaultEffort,
    enabled: true,
  }, { persisted: false });
  updateDefaultModelOptions();
  updateConnectionUsage();
  markRuntimeDirty();
  modelField(row, 'actualModel').focus();
}

function deleteModel(row) {
  if (modelRows().length <= 1) {
    showMessage('至少需要保留一个生成模型。', 'warning');
    return;
  }
  const wasDefault = elements.defaultModel.value === modelField(row, 'id').value;
  row.remove();
  updateModelRowButtons();
  updateDefaultModelOptions(wasDefault ? '' : elements.defaultModel.value);
  updateConnectionUsage();
  markRuntimeDirty();
}

function moveModel(row, direction) {
  if (direction === 'up' && row.previousElementSibling) row.before(row.previousElementSibling);
  if (direction === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
  updateModelRowButtons();
  markRuntimeDirty();
}

function updateModelRowButtons() {
  const rows = modelRows();
  rows.forEach((row, index) => {
    row.querySelector('[data-model-move="up"]').disabled = index === 0;
    row.querySelector('[data-model-move="down"]').disabled = index === rows.length - 1;
    row.querySelector('[data-model-delete]').disabled = rows.length <= 1;
  });
}

function updateDefaultModelOptions(preferred = elements.defaultModel.value) {
  const enabledModels = modelRows().filter((row) => modelField(row, 'enabled').checked).map((row) => ({
    id: modelField(row, 'id').value.trim(),
    label: modelField(row, 'displayName').value.trim(),
  })).filter((model) => model.id);
  elements.defaultModel.replaceChildren(...enabledModels.map((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label ? `${model.label} · ${model.id}` : model.id;
    return option;
  }));
  elements.defaultModel.value = enabledModels.some((model) => model.id === preferred)
    ? preferred
    : enabledModels[0]?.id || '';
  for (const row of modelRows()) {
    const enabled = modelField(row, 'enabled').checked;
    const radio = row.querySelector('[data-model-default]');
    radio.checked = enabled && modelField(row, 'id').value.trim() === elements.defaultModel.value;
    radio.disabled = !enabled;
    radio.title = '';
  }
}

function webProviderPanel(id) {
  return elements.webProviderList.querySelector(`[data-web-provider-panel="${id}"]`);
}

function selectedWebProvider() {
  return elements.form.querySelector('input[name="web-provider"]:checked')?.value || 'bailian-mcp';
}

function syncWebProviderUi() {
  const selected = selectedWebProvider();
  for (const id of WEB_PROVIDERS) {
    const panel = webProviderPanel(id);
    panel.classList.toggle('is-selected', id === selected);
    setWebKeyUi(panel);
  }
}

function setWebKeyUi(panel) {
  const action = panel.querySelector('[data-web-key-action]');
  const field = panel.querySelector('[data-web-key-field]');
  const input = panel.querySelector('[data-web-key]');
  const help = panel.querySelector('[data-web-key-help]');
  const status = panel.querySelector('[data-web-key-state]');
  const configured = panel.dataset.apiKeyConfigured === 'true';
  const activeAndRequired = elements.webEnabled.checked && selectedWebProvider() === panel.dataset.webProviderPanel;
  field.hidden = false;
  input.required = !state.validationStageId && (
    action.value === 'replace' || (activeAndRequired && !configured && !input.value.trim())
  );
  input.placeholder = configured ? '已配置时留空即可保留' : '请输入 API Key';
  if (action.value === 'replace' && state.validationStageId && !input.value) {
    status.textContent = '新 Key 已安全暂存（浏览器中已清空）';
    help.textContent = '本轮检查有效时无需再次填写；修改配置后需要重新输入。';
  } else if (input.value.trim()) {
    status.textContent = configured ? '将替换服务端现有 Key' : '将配置新的 Key';
    help.textContent = '保存前会使用该 Key 检查当前搜索供应商。';
  } else {
    status.textContent = configured ? '服务端已配置 Key' : '服务端尚未配置 Key';
    help.textContent = configured
      ? '留空保留服务端现有 Key；输入新值即替换。'
      : activeAndRequired
        ? '启用此搜索供应商前必须输入 API Key。'
        : '需要使用此搜索供应商时再输入 API Key。';
  }
}

function fillWebSearch(webSearch) {
  elements.webEnabled.checked = webSearch.enabled === true;
  const selected = WEB_PROVIDERS.includes(webSearch.provider) ? webSearch.provider : 'bailian-mcp';
  const radio = elements.form.querySelector(`input[name="web-provider"][value="${selected}"]`);
  if (radio) radio.checked = true;
  for (const id of WEB_PROVIDERS) {
    const panel = webProviderPanel(id);
    const provider = webSearch.providers[id];
    panel.dataset.apiKeyConfigured = String(provider.apiKeyConfigured === true);
    panel.querySelector('[data-web-key-action]').value = 'keep';
    panel.querySelector('[data-web-key]').value = '';
    panel.querySelector('[data-web-extract]').checked = provider.extractFallbackEnabled === true;
    setWebKeyUi(panel);
  }
  syncWebProviderUi();
}

function indexLabel(index) {
  const embedding = index?.embedding || {};
  const model = text(
    index?.model || index?.modelId || index?.embeddingModel || embedding.model,
    embedding.provider === 'disabled' ? '仅关键词' : '',
  );
  const dimensions = numberOr(index?.dimensions || index?.dimension || embedding.dimensions);
  const revision = text(index?.revision || index?.generation);
  const files = numberOr(index?.files || index?.documentCount, -1);
  const pieces = [model, dimensions > 0 ? `${dimensions} 维` : '', revision ? `代际 ${revision}` : '', files >= 0 ? `${files} 个文件` : ''];
  return pieces.filter(Boolean).join(' · ') || '暂无可用索引';
}

function rebuildStatus(rebuild) {
  return text(rebuild?.status || rebuild?.state, 'idle').toLowerCase();
}

function rebuilding(rebuild) {
  return ['queued', 'pending', 'validating', 'building', 'running', 'indexing'].includes(rebuildStatus(rebuild));
}

function fillIndex(index, rebuild) {
  elements.activeIndex.textContent = indexLabel(index?.active || index);
  const pending = rebuild?.pending || index?.pending || {};
  elements.pendingIndex.textContent = Object.keys(pending).length ? indexLabel(pending) : rebuilding(rebuild) ? '等待生成新索引代际' : '无';
  const active = rebuilding(rebuild);
  const activeRebuildId = active ? text(rebuild?.id || pending?.id) : '';
  if (!active || state.activeRebuildId !== activeRebuildId) state.cancellingRebuildId = '';
  state.activeRebuildId = activeRebuildId;
  const progress = rebuild?.progress && typeof rebuild.progress === 'object' ? rebuild.progress : {};
  const total = Math.max(0, numberOr(progress.total || rebuild?.total || rebuild?.totalFiles || rebuild?.documentsTotal));
  const completed = Math.max(0, numberOr(progress.completed || rebuild?.completed || rebuild?.processed || rebuild?.documentsProcessed));
  const explicitPercent = numberOr(progress.percent ?? rebuild?.progress ?? rebuild?.percent, -1);
  const percent = explicitPercent >= 0
    ? Math.min(100, explicitPercent <= 1 ? explicitPercent * 100 : explicitPercent)
    : total > 0 ? Math.min(100, completed / total * 100) : 0;
  elements.progressBlock.hidden = !active;
  elements.progress.value = percent;
  elements.progress.textContent = `${Math.round(percent)}%`;
  elements.progressText.textContent = state.cancellingRebuildId
    ? '正在取消'
    : text(
        rebuild?.message || rebuild?.stageLabel || rebuild?.stage || rebuild?.phase || progress.phase,
        active ? '处理中' : '',
      );
  const error = text(rebuild?.errorMessage || rebuild?.error || rebuild?.errorCode);
  const status = rebuildStatus(rebuild);
  elements.indexDetail.textContent = active
    ? `${completed}${total ? ` / ${total}` : ''} 个文件 · ${state.cancellingRebuildId ? '正在停止后台构建；' : ''}新索引完成前，查询继续使用活动索引。`
    : status === 'cancelled'
      ? '上次构建已取消，活动索引未切换。'
    : error
      ? `上次构建失败：${error}`
      : '只有点击下方按钮才会验证模型并产生向量调用费用。';
  elements.indexSummary.textContent = active ? `${Math.round(percent)}% · 构建中` : text(index?.status, index?.available === false ? '不可用' : '可用');
  state.building = active;
}

function setEmbeddingCredentialUi(embedding) {
  elements.embeddingKey.dataset.apiKeyConfigured = String(credentialConfigured(embedding));
  elements.embeddingKeyState.textContent = credentialConfigured(embedding)
    ? '服务端已配置 Embedding Key'
    : embedding?.provider === 'disabled'
      ? '语义检索已禁用'
      : '服务端尚未配置 Embedding Key';
}

function updateEmbeddingFields() {
  const disabled = elements.embeddingProvider.value === 'disabled';
  for (const control of [elements.embeddingModel, elements.embeddingUrl]) {
    control.required = !disabled;
    control.disabled = disabled;
  }
  elements.embeddingDimensions.value = disabled
    ? '语义检索已禁用'
    : elements.embeddingDimensions.dataset.detected || '构建时自动探测';
  if (disabled) {
    elements.embeddingKeyAction.value = 'keep';
  }
  updateEmbeddingKeyField();
}

function updateEmbeddingKeyField() {
  const disabled = elements.embeddingProvider.value === 'disabled';
  const configured = elements.embeddingKey.dataset.apiKeyConfigured === 'true';
  const help = document.querySelector('#embedding-key-help');
  elements.embeddingKeyField.hidden = disabled;
  elements.embeddingKey.required = !disabled && elements.embeddingKeyAction.value === 'replace';
  elements.embeddingKey.placeholder = configured ? '已配置时留空即可保留' : '请输入 API Key';
  if (disabled) {
    elements.embeddingKey.value = '';
    help.textContent = '启用语义检索后再配置对应服务的 API Key。';
  } else if (elements.embeddingKeyAction.value === 'replace') {
    help.textContent = '请输入当前 Provider 和 API Base 所使用的 API Key。';
  } else {
    help.textContent = '留空保留服务端现有 Key；输入新值即替换。';
  }
}

function embeddingTransportChanged() {
  const original = state.config?.embedding || {};
  const normalizeUrl = (value) => String(value || '').trim().replace(/\/+$/u, '');
  return elements.embeddingProvider.value !== text(original.provider) ||
    normalizeUrl(elements.embeddingUrl.value) !== normalizeUrl(
      original.apiBase || original.url || original.endpoint || original.baseUrl,
    );
}

function syncEmbeddingKeyIntent() {
  if (elements.embeddingProvider.value === 'disabled') {
    elements.embeddingKeyAction.value = 'keep';
  } else {
    const mustReplace = embeddingTransportChanged() || elements.embeddingKey.dataset.apiKeyConfigured !== 'true';
    elements.embeddingKeyAction.value = elements.embeddingKey.value.trim() || mustReplace ? 'replace' : 'keep';
  }
  updateEmbeddingKeyField();
}

function applyWorkspaceIdentity(status = {}, branding = {}) {
  const appName = text(branding.appName || status.appName, 'Second Mind');
  const selectedEntry = listValue(state.knowledgeBaseRegistry?.knowledgeBases)
    .find((entry) => entry.knowledgeBaseId === state.knowledgeBaseId);
  const vaultLabel = text(selectedEntry?.name || branding.vaultLabel || status.vaultLabel || status.rootLabel, '知识库');
  state.workspaceStatus = status;
  document.title = `Provider 配置 · ${appName}`;
  elements.description?.setAttribute('content', `${appName} 管理员 Provider 配置`);
  elements.brandName.textContent = appName;
  elements.pageTitle.textContent = `${appName} 配置`;
  elements.vaultName.textContent = vaultLabel;
}

function fillForm(payload) {
  clearValidationStage();
  state.candidateEditVersion = 0;
  const config = normalizedConfig(payload);
  state.config = config;
  state.revision = config.revision;
  state.originalConnections = new Map(config.connections.map((connection) => [connection.id, { ...connection }]));
  elements.revision.textContent = config.revision || '未提供';
  elements.sourceLabel.textContent = config.source === 'provider-config' ? 'Provider API' : '网页托管';
  elements.validity.textContent = config.stale ? '沿用最后有效版本' : '当前有效';
  elements.staleNotice.hidden = !config.stale;
  elements.brandingAppName.value = text(config.branding.appName, 'Second Mind');
  elements.brandingVaultLabel.value = text(config.branding.vaultLabel, '知识库');
  refreshProviderChoiceLists();
  elements.connectionList.replaceChildren();
  for (const connection of config.connections) renderConnection(connection);
  elements.modelList.replaceChildren();
  for (const model of config.models) renderModel(model);
  syncModelConnectionOptions();
  updateDefaultModelOptions(config.defaultModelId);
  fillWebSearch(config.webSearch);
  const embedding = config.embedding;
  elements.embeddingProvider.value = text(embedding.provider, 'disabled');
  elements.embeddingModel.value = text(embedding.model || embedding.modelId);
  elements.embeddingUrl.value = text(embedding.apiBase || embedding.url || embedding.endpoint || embedding.baseUrl);
  const activeEmbedding = config.index?.active?.embedding || config.index?.embedding || {};
  const detectedDimensions = numberOr(
    activeEmbedding.dimensions || activeEmbedding.dimension || embedding.dimensions || embedding.dimension,
  );
  elements.embeddingDimensions.dataset.detected = detectedDimensions > 0 ? `${detectedDimensions} 维` : '';
  elements.embeddingDimensions.value = detectedDimensions > 0 ? `${detectedDimensions} 维` : '构建时自动探测';
  setEmbeddingCredentialUi(embedding);
  elements.embeddingKeyAction.value = embedding.provider !== 'disabled' && !credentialConfigured(embedding)
    ? 'replace'
    : 'keep';
  elements.embeddingKey.value = '';
  updateEmbeddingKeyField();
  updateEmbeddingFields();
  fillIndex(config.index, config.rebuild);
  applyWorkspaceIdentity(state.workspaceStatus || {}, config.branding);
  state.dirty = state.knowledgeBaseDirty;
  state.dirtyRuntime = false;
  state.dirtyProviders = false;
  state.dirtyWebSearch = false;
  state.dirtyBranding = false;
  state.dirtyEmbedding = false;
  setBusyState();
  schedulePoll();
}

function setBusyState() {
  const checking = Boolean(state.checkingConnectionId);
  const busy = state.loading || state.saving || state.savingKnowledgeBases || checking;
  elements.reload.disabled = busy;
  elements.save.disabled = busy || state.building;
  elements.build.disabled = busy || state.building;
  elements.cancelBuild.hidden = !state.building || !state.activeRebuildId;
  elements.cancelBuild.disabled = busy || Boolean(state.cancellingRebuildId);
  elements.connectionAdd.disabled = busy || connectionCards().length >= MAX_CONNECTIONS;
  elements.modelAdd.disabled = busy || modelRows().length >= MAX_MODELS;
  elements.knowledgeBaseAdd.disabled = busy || knowledgeBaseCards().length >= MAX_KNOWLEDGE_BASES;
  elements.knowledgeBaseSave.disabled = busy || !state.knowledgeBaseDirty;
  elements.knowledgeBaseSave.textContent = state.savingKnowledgeBases ? '正在保存…' : '保存注册表';
  elements.knowledgeBaseSelect.disabled = busy || !chooseKnowledgeBase(state.knowledgeBaseRegistry);
  elements.save.textContent = state.saving ? '正在检查并保存…' : '检查并保存';
  elements.reload.textContent = state.loading ? '正在读取…' : '刷新配置';
  elements.build.textContent = state.building ? '索引构建中…' : '验证并构建索引';
  elements.cancelBuild.textContent = state.cancellingRebuildId ? '正在取消…' : '取消本次构建';
  connectionCards().forEach((card, providerIndex) => {
    const button = card.querySelector('[data-connection-check]');
    if (!button) return;
    const active = connectionField(card, 'id').value.trim() === state.checkingConnectionId;
    const staged = state.validationStageProviderIndexes.has(providerIndex);
    button.disabled = busy || state.building || staged;
    button.textContent = active ? '正在检查…' : staged ? '本轮已检查' : '检查连接';
  });
}

async function loadConfig({ quiet = false } = {}) {
  if (state.loading) return null;
  state.loading = true;
  setBusyState();
  try {
    const workspaceRequest = api('/api/knowledge/status').catch(() => null);
    let providerConfigPayload;
    try {
      providerConfigPayload = await api(PROVIDER_CONFIG_ENDPOINT);
    } catch (error) {
      if (error.status !== 404 && error.code !== 'NOT_FOUND') throw error;
      providerConfigPayload = null;
    }
    const runtimeConfigPayload = providerConfigPayload || await api(RUNTIME_CONFIG_ENDPOINT);
    const workspaceStatus = await workspaceRequest;
    state.providerApiAvailable = Boolean(providerConfigPayload);
    state.workspaceStatus = workspaceStatus;
    const payload = { runtimeConfigPayload, providerConfigPayload };
    fillForm(payload);
    if (!quiet) showMessage('已读取服务端最新配置。', 'success');
    return payload;
  } catch (error) {
    if (error.status === 401) {
      setGate('登录已失效', '请返回知识库重新登录后再打开配置页面。', { action: true });
      stopPoll();
    } else if (error.status === 403) {
      setGate('无管理员权限', '当前账号不能查看或修改运行配置。', { action: true });
      stopPoll();
    } else {
      showMessage(`读取失败：${error.message}`, 'error');
      if (!state.config) setGate('暂时无法读取配置', error.message, { retry: true });
    }
    return null;
  } finally {
    state.loading = false;
    setBusyState();
  }
}

function validatedRemoteBase(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} 必须是有效的 URL。`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} 必须是无凭据、query 和 fragment 的公网 HTTPS 地址。`);
  }
  return parsed.toString().replace(/\/+$/u, '');
}

function secretPatch(select, input, label = 'API Key') {
  const action = select.value;
  if (action === 'replace') {
    const value = input.value.trim();
    if (!value) throw new Error(`${label} 不能为空；已有凭据可直接留空保留。`);
    return { apiKeyAction: action, apiKey: value };
  }
  return { apiKeyAction: action };
}

function collectConnections() {
  const cards = connectionCards();
  if (!cards.length || cards.length > MAX_CONNECTIONS) throw new Error(`Provider 数量必须是 1–${MAX_CONNECTIONS}。`);
  const seen = new Set();
  return cards.map((card) => {
    syncProviderCard(card);
    const id = connectionField(card, 'id').value.trim();
    if (!MODEL_ID_PATTERN.test(id)) throw new Error('Provider 内部标识无效，请刷新配置后重试。');
    if (seen.has(id.toLowerCase())) throw new Error('Provider 内部标识重复，请刷新配置后重试。');
    seen.add(id.toLowerCase());
    const label = connectionField(card, 'label').value.trim();
    if (!label) throw new Error('Custom Provider 显示名不能为空。');
    const protocol = providerProtocol(card);
    const authMode = connectionField(card, 'authMode').value;
    const apiBase = validatedRemoteBase(connectionField(card, 'apiBase').value.trim(), `${label} API Base URL`);
    const action = card.querySelector('[data-connection-key-action]');
    const input = card.querySelector('[data-connection-key]');
    if (authMode !== 'none' && connectionTransportChanged(card) && action.value === 'keep') {
      throw new Error(`${label} 的目标或协议已变化，请填写该地址对应的新 Key。`);
    }
    const keyPatch = authMode === 'none' ? { apiKeyAction: 'clear' } : secretPatch(action, input, `连接 ${id} 的 API Key`);
    return { id, label, protocol, apiBase, authMode, ...keyPatch };
  });
}

function collectModels(connections) {
  const rows = modelRows();
  if (!rows.length || rows.length > MAX_MODELS) throw new Error(`生成模型数量必须是 1–${MAX_MODELS}。`);
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const seen = new Set();
  const models = rows.map((row) => {
    const id = modelField(row, 'id').value.trim();
    if (!MODEL_ID_PATTERN.test(id)) throw new Error(`模型稳定 ID“${id || '空'}”格式无效。`);
    if (seen.has(id.toLowerCase())) throw new Error(`模型稳定 ID“${id}”重复。`);
    seen.add(id.toLowerCase());
    const connectionId = modelField(row, 'connectionId').value;
    const connection = connectionById.get(connectionId);
    if (!connection) throw new Error(`模型 ${id} 没有选择有效连接。`);
    const actualModel = modelField(row, 'actualModel').value.trim();
    if (!actualModel || /\s/u.test(actualModel)) throw new Error(`模型 ${id} 的真实模型 ID 不能为空且不能包含空白。`);
    const card = connectionCards().find((item) => connectionField(item, 'id').value.trim() === connectionId);
    if (card && providerIdForCard(card) !== 'custom' && /\[[^\]]+\]$/u.test(actualModel)) {
      throw new Error(`模型 ${actualModel} 看起来包含客户端别名；请填写供应商直连接口的真实模型 ID。`);
    }
    const displayName = modelField(row, 'displayName').value.trim() || actualModel;
    const requestProfile = modelField(row, 'requestProfile').value;
    if (requestProfile === 'anthropic-standard' && connection.protocol !== 'anthropic-messages') {
      throw new Error(`模型 ${id} 的 Anthropic Profile 与连接协议不匹配。`);
    }
    if (['openai-standard', 'deepseek-openai', 'glm-openai'].includes(requestProfile) && connection.protocol !== 'openai-chat-completions') {
      throw new Error(`模型 ${id} 的 OpenAI Profile 与连接协议不匹配。`);
    }
    const efforts = effortList(modelField(row, 'efforts').value);
    const invalid = efforts.filter((effort) => !KNOWN_EFFORTS.includes(effort));
    if (!efforts.length || invalid.length) throw new Error(`模型 ${id} 的思考强度无效${invalid.length ? `：${invalid.join(', ')}` : ''}。`);
    const defaultEffort = modelField(row, 'defaultEffort').value;
    if (!efforts.includes(defaultEffort)) throw new Error(`模型 ${id} 的默认思考强度必须位于可用列表中。`);
    return {
      id,
      displayName,
      shortLabel: displayName,
      connectionId,
      actualModel,
      requestProfile,
      efforts,
      defaultEffort,
      reasoningMapping: modelReasoningMapping(row),
      enabled: modelField(row, 'enabled').checked,
    };
  });
  if (!models.some((model) => model.enabled)) throw new Error('至少需要启用一个生成模型。');
  return models;
}

function collectProviderConfigPayload() {
  const connections = collectConnections();
  const connectionIds = new Set(connections.map((connection) => connection.id));
  let enabledModels = 0;
  for (const row of modelRows()) {
    const connectionId = modelField(row, 'connectionId').value;
    if (!connectionIds.has(connectionId)) throw new Error('模型没有选择有效的供应商。');
    const actualModel = modelField(row, 'actualModel').value.trim();
    if (!actualModel || /[\s\u0000-\u001f\u007f]/u.test(actualModel)) {
      throw new Error('真实模型 ID 不能为空且不能包含空白或控制字符。');
    }
    const card = connectionCards().find((item) => connectionField(item, 'id').value.trim() === connectionId);
    if (card && providerIdForCard(card) !== 'custom' && /\[[^\]]+\]$/u.test(actualModel)) {
      throw new Error(`模型 ${actualModel} 看起来包含客户端别名；请填写供应商直连接口的真实模型 ID。`);
    }
    if (modelField(row, 'enabled').checked) enabledModels += 1;
  }
  if (!enabledModels) throw new Error('至少需要启用一个生成模型。');
  const providers = connections.map((connection) => {
    const card = connectionCards().find((item) => connectionField(item, 'id').value.trim() === connection.id);
    const providerId = providerIdForCard(card);
    const rows = modelRows().filter((row) => modelField(row, 'connectionId').value === connection.id);
    if (!rows.length) throw new Error(`${connection.label} 尚未关联模型；请添加模型或删除该 Provider。`);
    const secret = secretPatch(
      card.querySelector('[data-connection-key-action]'),
      card.querySelector('[data-connection-key]'),
      `${connection.label} API Key`,
    );
    return {
      ...(card.dataset.persisted === 'true' ? { id: connection.id } : {}),
      providerId,
      apiBase: connection.apiBase,
      ...secret,
      ...(providerId === 'custom' ? { protocol: connection.protocol, authMode: connection.authMode } : {}),
      models: rows.map((row) => {
        const actualModel = modelField(row, 'actualModel').value.trim();
        return {
          ...(row.dataset.persisted === 'true' ? { id: modelField(row, 'id').value.trim() } : {}),
          actualModel,
          displayName: modelField(row, 'displayName').value.trim() || actualModel,
          enabled: modelField(row, 'enabled').checked,
          default: row.querySelector('[data-model-default]').checked,
          reasoningMapping: modelReasoningMapping(row),
        };
      }),
    };
  });
  return {
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    expectedRevision: state.revision,
    providers,
  };
}

function collectWebSearch() {
  const provider = selectedWebProvider();
  const providers = {};
  for (const id of WEB_PROVIDERS) {
    const panel = webProviderPanel(id);
    providers[id] = {
      ...secretPatch(panel.querySelector('[data-web-key-action]'), panel.querySelector('[data-web-key]'), `${id} API Key`),
      extractFallbackEnabled: panel.querySelector('[data-web-extract]').checked,
    };
  }
  if (elements.webEnabled.checked) {
    const panel = webProviderPanel(provider);
    const action = panel.querySelector('[data-web-key-action]').value;
    const currentlyConfigured = panel.dataset.apiKeyConfigured === 'true';
    if (action === 'clear' || (action === 'keep' && !currentlyConfigured)) {
      throw new Error('启用联网搜索前，请为当前选中的供应商配置 API Key。');
    }
  }
  return { enabled: elements.webEnabled.checked, provider, providers };
}

function collectBranding() {
  const appName = elements.brandingAppName.value.trim();
  const vaultLabel = elements.brandingVaultLabel.value.trim();
  if (!appName || !vaultLabel) throw new Error('工作台标题和知识库名称不能为空。');
  return { appName, vaultLabel };
}

function collectPayload() {
  const adminPassword = elements.adminPassword.value;
  if (!adminPassword) throw new Error('请输入当前管理员密码以确认本次操作。');
  const connections = collectConnections();
  const models = collectModels(connections);
  const defaultModelId = elements.defaultModel.value;
  if (!models.some((model) => model.id === defaultModelId && model.enabled)) {
    throw new Error('默认模型必须指向一个已启用的模型。');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    expectedRevision: state.revision,
    adminPassword,
    connections,
    models,
    defaultModelId,
    branding: collectBranding(),
    webSearch: collectWebSearch(),
  };
}

function collectEmbeddingPayload() {
  const provider = elements.embeddingProvider.value.trim();
  if (provider === 'disabled') return { provider, apiKeyAction: 'keep' };
  const apiBase = validatedRemoteBase(elements.embeddingUrl.value.trim(), 'Embedding API Base URL');
  const model = elements.embeddingModel.value.trim();
  if (!['dashscope', 'openai-compatible'].includes(provider) || !model) {
    throw new Error('Embedding Provider 和模型 ID 均不能为空。');
  }
  if (elements.embeddingKeyAction.value === 'keep' && elements.embeddingKey.dataset.apiKeyConfigured !== 'true') {
    throw new Error('请填写 Embedding API Key。');
  }
  return {
    provider,
    model,
    apiBase,
    ...secretPatch(elements.embeddingKeyAction, elements.embeddingKey, 'Embedding API Key'),
  };
}

function clearSecretInputs() {
  for (const input of elements.form.querySelectorAll('input[type="password"]')) input.value = '';
  for (const card of connectionCards()) setConnectionKeyUi(card);
  for (const id of WEB_PROVIDERS) setWebKeyUi(webProviderPanel(id));
  updateEmbeddingKeyField();
}

function clearValidationStage({ markChecks = false } = {}) {
  window.clearTimeout(state.validationStageTimer);
  state.validationStageTimer = 0;
  if (markChecks) {
    for (const row of modelRows()) {
      if (state.validationStageLocalConnectionIds.has(modelField(row, 'connectionId').value)) {
        setModelCheckState(row, '配置已变化 · 需重新检查');
      }
    }
  }
  state.validationStageId = '';
  state.validationStageExpiresAt = '';
  state.validationStageProviderIndexes = new Set();
  state.validationStageLocalConnectionIds = new Set();
  state.validationStageIdAssignments = { providers: [], models: [] };
  for (const card of connectionCards()) setConnectionKeyUi(card);
  for (const id of WEB_PROVIDERS) setWebKeyUi(webProviderPanel(id));
}

function invalidateValidationStage({ notify = false } = {}) {
  if (!state.validationStageId) return false;
  clearValidationStage({ markChecks: true });
  if (notify) {
    showMessage('页面配置已变化，之前的分阶段检查已失效；保存前需要重新检查。', 'warning');
  }
  setBusyState();
  return true;
}

function mergedIdAssignments(current = {}, incoming = {}) {
  const merge = (kind) => {
    const entries = [...listValue(current?.[kind]), ...listValue(incoming?.[kind])];
    const byPosition = new Map();
    for (const entry of entries) {
      const providerIndex = Number(kind === 'providers' ? entry?.index ?? entry?.providerIndex : entry?.providerIndex);
      const modelIndex = kind === 'models' ? Number(entry?.modelIndex) : -1;
      const id = text(entry?.id);
      if (!Number.isSafeInteger(providerIndex) || providerIndex < 0 || !id) continue;
      if (kind === 'models' && (!Number.isSafeInteger(modelIndex) || modelIndex < 0)) continue;
      byPosition.set(`${providerIndex}:${modelIndex}`, entry);
    }
    return [...byPosition.values()];
  };
  return { providers: merge('providers'), models: merge('models') };
}

function rememberValidationStage(result, providerIndex, localConnectionId) {
  const token = text(result?.validationStageId);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error('服务端未返回有效的分阶段检查凭据；配置未保存。');
  }
  const replacingStage = token !== state.validationStageId;
  if (replacingStage) {
    clearValidationStage();
    state.validationStageId = token;
  }
  state.validationStageExpiresAt = text(result?.expiresAt);
  state.validationStageProviderIndexes.add(providerIndex);
  state.validationStageLocalConnectionIds.add(localConnectionId);
  state.validationStageIdAssignments = mergedIdAssignments(
    replacingStage ? {} : state.validationStageIdAssignments,
    result?.idAssignments,
  );
  for (const card of connectionCards()) setConnectionKeyUi(card);
  for (const id of WEB_PROVIDERS) setWebKeyUi(webProviderPanel(id));
  window.clearTimeout(state.validationStageTimer);
  state.validationStageTimer = 0;
  const expiry = Date.parse(state.validationStageExpiresAt);
  if (Number.isFinite(expiry)) {
    const delay = Math.max(0, Math.min(2_147_000_000, expiry - Date.now() + 50));
    state.validationStageTimer = window.setTimeout(() => {
      if (!state.validationStageId) return;
      clearValidationStage({ markChecks: true });
      setBusyState();
      showMessage('分阶段连接检查已过期；保存前需要重新检查。', 'warning');
    }, delay);
  }
}

function asksToClearCredential() {
  if (connectionCards().some((card) => card.querySelector('[data-connection-key-action]').value === 'clear')) return true;
  return WEB_PROVIDERS.some((id) => webProviderPanel(id).querySelector('[data-web-key-action]').value === 'clear');
}

function applyModelValidationResults(results = [], idAssignments = {}, connectionScope = '') {
  const allRows = modelRows();
  const rows = connectionScope
    ? allRows.filter((row) => modelField(row, 'connectionId').value === connectionScope)
    : allRows;
  const assignedRows = new Map();
  const cards = connectionCards();
  for (const assignment of listValue(idAssignments?.models)) {
    const card = cards[Number(assignment?.providerIndex)];
    if (!card) continue;
    const connectionId = connectionField(card, 'id').value.trim();
    const providerRows = allRows.filter((row) => modelField(row, 'connectionId').value === connectionId);
    const row = providerRows[Number(assignment?.modelIndex)];
    if (row && text(assignment?.id)) assignedRows.set(text(assignment.id), row);
  }
  const matched = new Set();
  const unmatchedEnabled = cards.flatMap((card) => {
    const connectionId = connectionField(card, 'id').value.trim();
    return rows.filter((row) => (
      modelField(row, 'connectionId').value === connectionId && modelField(row, 'enabled').checked
    ));
  });
  for (const result of listValue(results)) {
    const modelId = text(result?.modelId);
    let row = rows.find((item) => modelField(item, 'id').value.trim() === modelId) || assignedRows.get(modelId);
    if (row && connectionScope && modelField(row, 'connectionId').value !== connectionScope) row = null;
    if (!row) row = unmatchedEnabled.find((item) => !matched.has(item));
    if (!row) continue;
    matched.add(row);
    const detail = text(result?.message || result?.code).slice(0, 160);
    setModelCheckState(
      row,
      result.ok === true ? '联网实测通过' : detail ? `联网实测失败：${detail}` : '联网实测失败',
      result.ok === true ? 'valid' : 'error',
    );
    row.querySelector('[data-model-check-state]').title = detail;
  }
}

function connectionCheckSignature(card) {
  if (!card?.isConnected) return '';
  const connectionId = connectionField(card, 'id').value.trim();
  return JSON.stringify({
    connectionId,
    providerId: providerIdForCard(card),
    protocol: providerProtocol(card),
    authMode: connectionField(card, 'authMode').value,
    apiBase: connectionField(card, 'apiBase').value.trim(),
    apiKeyAction: card.querySelector('[data-connection-key-action]').value,
    models: modelRows().filter((row) => modelField(row, 'connectionId').value === connectionId).map((row) => ({
      actualModel: modelField(row, 'actualModel').value.trim(),
      enabled: modelField(row, 'enabled').checked,
    })),
  });
}

async function checkConnection(card) {
  if (state.loading || state.saving || state.building || state.checkingConnectionId) return;
  if (!state.providerApiAvailable) {
    showMessage('当前服务端不支持独立 Provider 检查，请先升级 Second Mind 服务端。', 'warning');
    return;
  }
  const providerIndex = connectionCards().indexOf(card);
  if (providerIndex < 0) return;
  if (state.validationStageProviderIndexes.has(providerIndex)) {
    showMessage('该 Provider 已在本轮通过检查；最终保存不会重复调用其模型。', 'success');
    return;
  }
  const connectionId = connectionField(card, 'id').value.trim();
  const label = card.querySelector('[data-connection-title]').textContent.trim() || '当前 Provider';
  const targetRows = modelRows().filter((row) => (
    modelField(row, 'connectionId').value === connectionId && modelField(row, 'enabled').checked
  ));
  if (!targetRows.length) {
    showMessage(`${label} 没有已启用模型，无法检查连接。`, 'warning');
    return;
  }
  const adminPassword = elements.adminPassword.value;
  if (!adminPassword) {
    showMessage('请输入当前管理员密码以确认真实连接检查。', 'error');
    elements.adminPassword.focus();
    return;
  }
  const usingStage = Boolean(state.validationStageId);
  let requestBody;
  try {
    requestBody = usingStage
      ? {
          schemaVersion: PROVIDER_SCHEMA_VERSION,
          expectedRevision: state.revision,
          validationStageId: state.validationStageId,
          validateProviderIndex: providerIndex,
          adminPassword,
        }
      : {
          ...collectProviderConfigPayload(),
          webSearch: collectWebSearch(),
          validateProviderIndex: providerIndex,
          adminPassword,
        };
  } catch (error) {
    showMessage(error.message, 'error');
    return;
  }
  const stageCopy = usingStage
    ? '将复用服务器暂存的同一候选配置。'
    : '服务器会临时保存当前完整候选配置，以便后续检查和保存无需在浏览器保留 Key。';
  if (!window.confirm(`检查“${label}”会对该连接下 ${targetRows.length} 个已启用模型各发起一次真实请求，可能产生费用；${stageCopy}不会调用 WebSearch，也不会保存生效。确认继续？`)) return;
  const signature = connectionCheckSignature(card);
  const editVersion = state.candidateEditVersion;
  for (const row of targetRows) setModelCheckState(row, '正在联网检查…');
  state.checkingConnectionId = connectionId;
  setBusyState();
  try {
    const request = api(`${PROVIDER_CONFIG_ENDPOINT}/validate`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
    clearSecretInputs();
    const result = await request;
    if (
      result?.scope?.kind !== 'provider' || Number(result?.scope?.providerIndex) !== providerIndex ||
      !text(result?.scope?.connectionId) ||
      (usingStage && text(result?.validationStageId) !== requestBody.validationStageId) ||
      result?.webSearch?.skipped !== true || Object.hasOwn(result || {}, 'validationId')
    ) {
      throw new Error('服务端没有返回安全的单 Provider 检查结果；配置未保存。');
    }
    if (
      listValue(result.results).length !== targetRows.length ||
      listValue(result.results).some((entry) => entry?.ok !== true)
    ) {
      throw new Error('服务端返回的逐模型检查结果不完整；配置未保存。');
    }
    if (state.candidateEditVersion !== editVersion || connectionCheckSignature(card) !== signature) {
      clearValidationStage({ markChecks: true });
      for (const row of targetRows) setModelCheckState(row, '配置已变化 · 需重新检查');
      showMessage('检查期间页面内容发生变化，已丢弃过期结果；配置未保存。', 'warning');
      return;
    }
    rememberValidationStage(result, providerIndex, connectionId);
    applyModelValidationResults(result.results, state.validationStageIdAssignments, connectionId);
    showMessage(`${label} 连接检查完成：${targetRows.length} 个已启用模型通过并已暂存；未调用 WebSearch、未保存生效，最终保存不会重复检查本卡。`, 'success');
    toast('连接检查通过');
  } catch (error) {
    if (usingStage && error.status === 409) {
      clearValidationStage({ markChecks: true });
    }
    if (state.candidateEditVersion === editVersion && connectionCheckSignature(card) === signature) {
      for (const row of targetRows) setModelCheckState(row, '联网实测失败', 'error');
      applyModelValidationResults(error.results, state.validationStageIdAssignments, connectionId);
    }
    showMessage(`连接检查失败，配置未保存：${error.message}`, 'error');
  } finally {
    clearSecretInputs();
    state.checkingConnectionId = '';
    setBusyState();
  }
}

async function saveThroughProviderApi(adminPassword) {
  const branding = collectBranding();
  if (!state.dirtyProviders && !state.dirtyWebSearch) {
    return api(PROVIDER_CONFIG_ENDPOINT, {
      method: 'PUT',
      body: JSON.stringify({
        schemaVersion: PROVIDER_SCHEMA_VERSION,
        expectedRevision: state.revision,
        branding,
        adminPassword,
      }),
    });
  }
  const validationStageId = state.validationStageId;
  const candidate = validationStageId ? null : {
    ...collectProviderConfigPayload(),
    webSearch: collectWebSearch(),
  };
  let validation;
  try {
    validation = await api(`${PROVIDER_CONFIG_ENDPOINT}/validate`, {
      method: 'POST',
      body: JSON.stringify(validationStageId
        ? {
            schemaVersion: PROVIDER_SCHEMA_VERSION,
            expectedRevision: state.revision,
            validationStageId,
            adminPassword,
          }
        : { ...candidate, adminPassword }),
    });
  } catch (error) {
    applyModelValidationResults(error.results, state.validationStageIdAssignments);
    if (validationStageId && error.status === 409) clearValidationStage({ markChecks: true });
    throw error;
  } finally {
    clearSecretInputs();
  }
  applyModelValidationResults(
    validation.results,
    mergedIdAssignments(state.validationStageIdAssignments, validation.idAssignments),
  );
  const validationId = text(validation.validationId);
  if (!validationId) throw new Error('服务端未返回有效的检查凭据，原配置未改变。');
  clearValidationStage();
  return api(PROVIDER_CONFIG_ENDPOINT, {
    method: 'PUT',
    body: JSON.stringify({
      schemaVersion: PROVIDER_SCHEMA_VERSION,
      expectedRevision: state.revision,
      validationId,
      branding,
      adminPassword,
    }),
  });
}

async function saveConfig() {
  if (state.saving || state.loading) return false;
  if (!state.dirtyRuntime) {
    showMessage('当前没有需要保存的 Provider、名称或联网搜索修改。', 'success');
    return true;
  }
  let payload;
  const adminPassword = elements.adminPassword.value;
  try {
    if (!elements.form.reportValidity()) return false;
    if (!adminPassword) throw new Error('请输入当前管理员密码以确认本次操作。');
    if (state.providerApiAvailable) {
      if ((state.dirtyProviders || state.dirtyWebSearch) && !state.validationStageId) {
        collectProviderConfigPayload();
        collectWebSearch();
      }
      collectBranding();
      payload = null;
    } else {
      payload = collectPayload();
    }
  } catch (error) {
    showMessage(error.message, 'error');
    return false;
  }
  if (asksToClearCredential() && !window.confirm('确认清除所选 API Key？依赖该凭据的新任务将不可用。')) return false;
  const willValidate = state.dirtyProviders || state.dirtyWebSearch;
  const stagedCount = state.validationStageProviderIndexes.size;
  const validationCopy = stagedCount
    ? `已有 ${stagedCount} 个 Provider 在本轮通过检查；保存只会实测其余启用模型，再检查当前搜索供应商和抽取兜底，不会重复调用已检查模型。`
    : '保存会实测全部启用的 LLM，并检查当前搜索供应商和抽取兜底。';
  if (willValidate && !window.confirm(`${validationCopy}可能产生费用。测试不自动重试，失败时原配置继续生效。确认继续？`)) return false;
  state.saving = true;
  setBusyState();
  let configurationCommitted = false;
  try {
    if (!state.providerApiAvailable) {
      const request = api(RUNTIME_CONFIG_ENDPOINT, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      clearSecretInputs();
      await request;
      configurationCommitted = true;
    } else {
      await saveThroughProviderApi(adminPassword);
      configurationCommitted = true;
    }
    const refreshed = await loadConfig({ quiet: true });
    if (!refreshed) {
      showMessage('配置已保存，但自动读取最新状态失败；请刷新页面核对当前版本。', 'warning');
      toast('配置已保存，请刷新核对');
      return true;
    }
    showMessage(
      willValidate
        ? '相关 Provider 已通过连通测试并原子生效；新任务将使用此版本。'
        : '工作台名称已保存；刷新知识库页面即可看到更新。',
      'success',
    );
    toast(willValidate ? '配置已检查并保存' : '名称已保存');
    return true;
  } catch (error) {
    clearSecretInputs();
    if (error.status === 409 && [
      'PROVIDER_VALIDATION_STAGE_INVALID',
      'PROVIDER_VALIDATION_STAGE_MISMATCH',
      'INVALID_PROVIDER_VALIDATION_STAGE',
    ].includes(error.code)) {
      clearValidationStage({ markChecks: true });
      showMessage('分阶段检查已失效，未保存的页面内容仍保留；请重新填写需要替换的 Key 后再次检查。', 'warning');
    } else if (error.status === 409) {
      showMessage(
        configurationCommitted
          ? '配置已保存，但刷新状态时发现其他页面又更新了配置；正在重新读取，请核对当前版本。'
          : '配置已被其他页面更新，正在重新读取；请核对后再次保存。',
        'warning',
      );
      await loadConfig({ quiet: true });
    } else {
      const validationDetail = webValidationFailureMessage(error);
      showMessage(
        configurationCommitted
          ? `配置已保存，但重新读取最新状态失败：${error.message}。请刷新页面核对。`
          : `保存或连通测试失败，原配置继续生效：${validationDetail || error.message}`,
        'error',
      );
      if (configurationCommitted) await loadConfig({ quiet: true });
    }
    return false;
  } finally {
    elements.adminPassword.value = '';
    state.saving = false;
    setBusyState();
  }
}

async function buildIndex() {
  if (state.building || state.saving || state.loading) return;
  if (state.dirtyRuntime) {
    showMessage('模型或联网配置还有未保存的修改。请先保存，再启动索引构建。', 'warning');
    return;
  }
  const adminPassword = elements.adminPassword.value;
  if (!adminPassword) {
    showMessage('请输入当前管理员密码以确认索引构建。', 'error');
    elements.adminPassword.focus();
    return;
  }
  if (!window.confirm('验证 Embedding 配置并发送全部可索引文本来构建完整索引，可能产生费用。确认继续？')) return;
  let embedding;
  try {
    embedding = collectEmbeddingPayload();
    if (embedding.apiKeyAction === 'clear') throw new Error('清除 Embedding Key 后无法构建索引，请选择保留或替换。');
  } catch (error) {
    showMessage(error.message, 'error');
    return;
  }
  try {
    state.building = true;
    setBusyState();
    showMessage('正在提交索引构建任务，请勿重复点击。');
    const request = api('/api/admin/embedding-rebuild', {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision: state.revision,
        action: 'validate-and-build',
        adminPassword,
        embedding,
      }),
    });
    clearSecretInputs();
    const response = await request;
    if (response?.revision) state.revision = String(response.revision);
    if (response?.config) fillForm(response);
    else if (response?.rebuild || response?.embeddingRebuild || response?.index) {
      const merged = {
        ...(state.config || {}),
        revision: state.revision,
        rebuild: response.rebuild || response.embeddingRebuild || response,
        index: response.index || state.config?.index,
      };
      fillForm(merged);
    }
    state.building = true;
    setBusyState();
    showMessage('索引任务已开始。旧索引会持续服务，完整成功后再原子切换。', 'success');
    schedulePoll(true);
  } catch (error) {
    state.building = false;
    setBusyState();
    if (error.status === 409) {
      showMessage('配置版本已经变化，已重新读取；请核对后再次构建。', 'warning');
      await loadConfig({ quiet: true });
    } else {
      showMessage(`无法启动索引构建：${error.message}`, 'error');
    }
  } finally {
    elements.adminPassword.value = '';
  }
}

async function cancelIndexBuild() {
  const rebuildId = state.activeRebuildId;
  if (!state.building || !rebuildId || state.cancellingRebuildId || state.loading || state.saving) return;
  const adminPassword = elements.adminPassword.value;
  if (!adminPassword) {
    showMessage('请输入当前管理员密码以确认取消索引构建。', 'error');
    elements.adminPassword.focus();
    return;
  }
  if (!window.confirm('确认取消本次索引构建？活动索引不会切换，查询仍继续使用旧索引。')) return;
  state.cancellingRebuildId = rebuildId;
  setBusyState();
  try {
    await api('/api/admin/embedding-rebuild', {
      method: 'POST',
      body: JSON.stringify({
        action: 'cancel',
        rebuildId,
        adminPassword,
      }),
    });
    showMessage('已请求取消索引构建；活动索引保持不变，正在等待后台清理候选槽位。', 'success');
    schedulePoll(true);
  } catch (error) {
    state.cancellingRebuildId = '';
    setBusyState();
    if (error.status === 404) {
      showMessage('该索引任务已结束或已不存在，正在重新读取状态。', 'warning');
      await loadConfig({ quiet: true });
    } else {
      showMessage(`无法取消索引构建：${error.message}`, 'error');
    }
  } finally {
    elements.adminPassword.value = '';
  }
}

function stopPoll() {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = 0;
}

function schedulePoll(force = false) {
  stopPoll();
  if (!force && !state.building) return;
  state.pollTimer = window.setTimeout(async () => {
    await loadConfig({ quiet: true });
    schedulePoll();
  }, POLL_INTERVAL_MS);
}

function markRuntimeDirty() {
  state.candidateEditVersion += 1;
  invalidateValidationStage({ notify: true });
  state.dirty = true;
  state.dirtyRuntime = true;
  state.dirtyProviders = true;
  setBusyState();
}

function markDirty(event) {
  if (!event.target.closest('#runtime-config-form') || event.target === elements.adminPassword) return;
  state.dirty = true;
  const inProviderSection = Boolean(event.target.closest('[aria-labelledby="providers-heading"]'));
  const inWebSection = Boolean(event.target.closest('[aria-labelledby="web-heading"]'));
  const isBranding = [elements.brandingAppName, elements.brandingVaultLabel].includes(event.target);
  if ((inProviderSection && !isBranding) || inWebSection) {
    state.candidateEditVersion += 1;
    invalidateValidationStage({ notify: true });
  }
  if (event.target.closest('[aria-labelledby="embedding-heading"]')) {
    state.dirtyEmbedding = true;
  } else {
    state.dirtyRuntime = true;
    if (event.target.closest('[aria-labelledby="providers-heading"]')) {
      if ([elements.brandingAppName, elements.brandingVaultLabel].includes(event.target)) {
        state.dirtyBranding = true;
        applyWorkspaceIdentity(state.workspaceStatus || {}, {
          appName: elements.brandingAppName.value.trim() || 'Second Mind',
          vaultLabel: elements.brandingVaultLabel.value.trim() || '知识库',
        });
      } else {
        state.dirtyProviders = true;
      }
    }
    if (event.target.closest('[aria-labelledby="web-heading"]')) state.dirtyWebSearch = true;
  }
  if (event.target === elements.embeddingProvider) updateEmbeddingFields();
  if (event.target === elements.embeddingKey) syncEmbeddingKeyIntent();
  if ([elements.embeddingProvider, elements.embeddingUrl].includes(event.target)) {
    const wasKeeping = elements.embeddingKeyAction.value === 'keep';
    syncEmbeddingKeyIntent();
    if (
      elements.embeddingProvider.value !== 'disabled' &&
      elements.embeddingKeyAction.value === 'replace' &&
      wasKeeping
    ) showMessage('Embedding Provider 或 API Base 已变化，请同时填写该地址对应的新 Key。', 'warning');
  }
  if (event.target === elements.webEnabled || event.target.matches('input[name="web-provider"]')) {
    for (const id of WEB_PROVIDERS) setWebKeyUi(webProviderPanel(id));
  }
}

function handleConnectionEvent(event) {
  const card = event.target.closest('[data-connection-card]');
  if (!card) return;
  if (event.target.closest('[data-connection-check]')) {
    void checkConnection(card);
    return;
  }
  if (event.target.matches('[data-connection-delete]')) {
    deleteConnection(card);
    return;
  }
  if (event.target.matches('[data-connection-key]')) {
    const action = card.querySelector('[data-connection-key-action]');
    const mustReplace = connectionTransportChanged(card) || card.dataset.apiKeyConfigured !== 'true';
    action.value = event.target.value.trim() || mustReplace ? 'replace' : 'keep';
    setConnectionKeyUi(card);
    return;
  }
  if (event.target.matches('[data-provider-preset]')) {
    syncProviderCard(card, { applyDefaults: true });
    enforceConnectionCredentialChange(card);
    syncModelConnectionOptions();
    for (const row of modelRows()) {
      if (modelField(row, 'connectionId').value === connectionField(card, 'id').value) {
        syncModelAdapterFields(row, { force: true });
        setModelCheckState(row);
      }
    }
    updateConnectionUsage();
    return;
  }
  if (event.target.matches('[data-connection-field]')) {
    syncProviderCard(card);
    syncModelConnectionOptions();
    enforceConnectionCredentialChange(card);
    for (const row of modelRows()) {
      if (modelField(row, 'connectionId').value === connectionField(card, 'id').value) {
        syncModelAdapterFields(row, { force: true });
        setModelCheckState(row);
      }
    }
    updateConnectionUsage();
  }
}

function handleModelEvent(event) {
  const row = event.target.closest('[data-model-row]');
  if (!row) return;
  const move = event.target.closest('[data-model-move]');
  if (move) {
    moveModel(row, move.dataset.modelMove);
    return;
  }
  if (event.target.closest('[data-model-delete]')) {
    deleteModel(row);
    return;
  }
  if (event.target.matches('[data-model-default]')) {
    if (event.target.checked) elements.defaultModel.value = modelField(row, 'id').value.trim();
    updateDefaultModelOptions(elements.defaultModel.value);
    return;
  }
  if (
    event.target.matches('[data-model-reasoning-manual]') ||
    event.target.matches('[data-model-reasoning-tier]')
  ) syncModelReasoningUi(row);
  if (event.target === modelField(row, 'connectionId')) syncModelAdapterFields(row, { force: true });
  if (event.target === modelField(row, 'actualModel')) syncModelReasoningUi(row);
  setModelCheckState(row);
  updateDefaultModelOptions();
  updateConnectionUsage();
}

async function initialize() {
  stopPoll();
  try {
    const requested = new URL(window.location.href).searchParams.get('knowledgeBaseId') || '';
    state.requestedKnowledgeBaseId = KNOWLEDGE_BASE_ID_PATTERN.test(requested) ? requested : '';
    state.knowledgeBaseId = state.requestedKnowledgeBaseId;
    const session = await api('/api/session');
    state.session = session;
    if (!session.authenticated) {
      setGate('需要登录', '请先返回知识库登录，再打开管理员配置。', { action: true });
      return;
    }
    if (session.user?.role !== 'admin') {
      setGate('无管理员权限', '当前账号不能查看或修改运行配置。', { action: true });
      return;
    }
    if (session.permissions?.manageRuntimeConfig !== true) {
      setGate('无配置管理权限', '当前账号可以使用知识库，但不能查看或修改运行配置。', { action: true });
      return;
    }
    elements.user.textContent = session.user.username || 'admin';
    elements.user.hidden = false;
    elements.gate.hidden = true;
    elements.app.hidden = false;
    await loadKnowledgeBases({ quiet: true });
    const loaded = await loadConfig({ quiet: true });
    if (!loaded) return;
    showMessage('配置与凭据仅在服务器端保存；本页不会回显任何 API Key。');
  } catch (error) {
    setGate('配置服务暂时不可用', error.message, { retry: true });
  }
}

elements.form.addEventListener('input', markDirty);
elements.form.addEventListener('change', markDirty);
elements.connectionList.addEventListener('input', handleConnectionEvent);
elements.connectionList.addEventListener('change', handleConnectionEvent);
elements.connectionList.addEventListener('click', handleConnectionEvent);
elements.modelList.addEventListener('input', handleModelEvent);
elements.modelList.addEventListener('change', handleModelEvent);
elements.modelList.addEventListener('click', handleModelEvent);
elements.knowledgeBaseList.addEventListener('input', (event) => {
  if (!event.target.closest('[data-knowledge-base-card]')) return;
  markKnowledgeBaseDirty();
});
elements.knowledgeBaseList.addEventListener('change', (event) => {
  const card = event.target.closest('[data-knowledge-base-card]');
  if (!card) return;
  if (event.target.matches('[data-knowledge-base-default]') && event.target.checked) {
    knowledgeBaseField(card, 'enabled').checked = true;
  }
  markKnowledgeBaseDirty();
});
elements.knowledgeBaseList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-knowledge-base-delete]');
  if (button) removeKnowledgeBase(button.closest('[data-knowledge-base-card]'));
});
function handleWebCredentialEvent(event) {
  const panel = event.target.closest('[data-web-provider-panel]');
  if (!panel || !event.target.matches('[data-web-key]')) return;
  panel.querySelector('[data-web-key-action]').value = event.target.value.trim() ? 'replace' : 'keep';
  setWebKeyUi(panel);
}
elements.webProviderList.addEventListener('input', handleWebCredentialEvent);
elements.webProviderList.addEventListener('change', handleWebCredentialEvent);
elements.form.querySelectorAll('input[name="web-provider"]').forEach((radio) => {
  radio.addEventListener('change', syncWebProviderUi);
});
elements.connectionAdd.addEventListener('click', addConnection);
elements.modelAdd.addEventListener('click', addModel);
elements.knowledgeBaseAdd.addEventListener('click', addKnowledgeBase);
elements.knowledgeBaseSave.addEventListener('click', saveKnowledgeBases);
elements.knowledgeBaseSelect.addEventListener('change', async () => {
  const next = elements.knowledgeBaseSelect.value;
  if (next === state.knowledgeBaseId) return;
  if ((state.dirtyRuntime || state.dirtyEmbedding) && !window.confirm('切换知识库会放弃尚未保存的运行配置修改。确认继续？')) {
    elements.knowledgeBaseSelect.value = state.knowledgeBaseId;
    return;
  }
  stopPoll();
  clearSecretInputs();
  clearValidationStage();
  state.knowledgeBaseId = next;
  updateSelectedKnowledgeBaseUrl();
  await loadConfig();
});
elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  saveConfig();
});
elements.reload.addEventListener('click', () => {
  if (state.dirty && !window.confirm('放弃尚未保存的页面修改并重新读取？')) return;
  Promise.resolve(loadKnowledgeBases({ quiet: true })).then(() => loadConfig());
});
elements.save.addEventListener('click', () => saveConfig());
elements.build.addEventListener('click', buildIndex);
elements.cancelBuild.addEventListener('click', cancelIndexBuild);
elements.gateRetry.addEventListener('click', initialize);
window.addEventListener('beforeunload', (event) => {
  if (!state.dirty && !state.knowledgeBaseDirty) return;
  event.preventDefault();
  event.returnValue = '';
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopPoll();
  else if (state.building) schedulePoll(true);
});

initialize();
