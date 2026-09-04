import { filesFromClipboard } from './knowledge-clipboard.js?v=1.0.0';

const CONVERSATION_SELECTION_PREFIX = 'vaultmind:selected-conversation:v2:';
const KNOWLEDGE_BASE_SELECTION_PREFIX = 'second-mind:selected-knowledge-base:v1:';
const NEW_CONVERSATION_SENTINEL = '__new_conversation__';
const CLIENT_BUILD_REVISION = 'knowledge-ui-2.1.6';
const MODEL_CATALOG_REVISION = /^[0-9a-f]{64}$/i;
const UNIVERSAL_EFFORT_IDS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFECTIVE_EFFORT_IDS = new Set(['minimal', ...UNIVERSAL_EFFORT_IDS, 'default']);

const state = {
  session: null,
  status: null,
  knowledgeBases: [],
  knowledgeBaseId: '',
  knowledgeBaseEpoch: 0,
  kind: 'qa',
  busy: false,
  taskId: null,
  conversationId: null,
  selectedConversationId: null,
  conversationBaseline: null,
  pendingFork: false,
  selectionStorageKey: '',
  conversations: [],
  attachments: [],
  assistantText: '',
  assistantNode: null,
  processCard: null,
  processSummary: null,
  processList: null,
  processGroups: new Map(),
  processPhaseNodes: new Map(),
  processCurrentPhase: 'prepare',
  processCurrentItem: null,
  processLastKey: '',
  processGenerating: false,
  processStartedAt: 0,
  processFinishedAt: 0,
  processElapsed: null,
  processSummaryElapsed: null,
  processLiveMessage: null,
  processTimer: null,
  processUsage: null,
  processUsageSummary: null,
  processUsageStatus: null,
  processUsageGrid: null,
  processUsageRecords: new Map(),
  processUsageCalls: new Map(),
  processUsageEventIds: new Set(),
  source: null,
  sourceObjectUrl: '',
  draft: null,
  recognition: null,
  voiceMode: 'none',
  listening: false,
  voiceStopRequested: false,
  voiceBase: '',
  voiceTranscript: '',
  mediaRecorder: null,
  mediaStream: null,
  mediaChunks: [],
  mediaStartedAt: 0,
  mediaTimer: null,
  transcribing: false,
  loggingOut: false,
  formErrorTimer: null,
  searchController: null,
  searchRequestId: 0,
};

const elements = {
  appName: document.querySelector('#knowledge-app-name'),
  headerAppName: document.querySelector('#knowledge-header-app-name'),
  headerVaultLabel: document.querySelector('#knowledge-header-vault-label'),
  footerAppName: document.querySelector('#knowledge-footer-app-name'),
  footerVaultLabel: document.querySelector('#knowledge-footer-vault-label'),
  syncStatus: document.querySelector('#knowledge-sync-status'),
  appDescription: document.querySelector('#app-description'),
  gate: document.querySelector('#knowledge-gate'),
  gateTitle: document.querySelector('#knowledge-gate-title'),
  gateMessage: document.querySelector('#knowledge-gate-message'),
  gateLink: document.querySelector('#knowledge-gate-link'),
  retry: document.querySelector('#knowledge-retry'),
  loginForm: document.querySelector('#knowledge-login-form'),
  username: document.querySelector('#knowledge-username'),
  password: document.querySelector('#knowledge-password'),
  loginError: document.querySelector('#knowledge-login-error'),
  logout: document.querySelector('#knowledge-logout'),
  adminConfig: document.querySelector('#knowledge-admin-config'),
  knowledgeBaseField: document.querySelector('#knowledge-base-field'),
  knowledgeBaseSelect: document.querySelector('#knowledge-base-select'),
  app: document.querySelector('#knowledge-app'),
  sidebar: document.querySelector('.knowledge-sidebar'),
  sidebarToggle: document.querySelector('#knowledge-sidebar-toggle'),
  sidebarDetails: document.querySelector('#knowledge-sidebar-details'),
  modes: document.querySelector('#knowledge-modes'),
  model: document.querySelector('#knowledge-model'),
  effortField: document.querySelector('#knowledge-effort-field'),
  effortControl: document.querySelector('.knowledge-effort-control'),
  effort: document.querySelector('#knowledge-effort'),
  modelDescription: document.querySelector('#knowledge-model-description'),
  taskModeField: document.querySelector('#knowledge-task-mode-field'),
  taskMode: document.querySelector('#knowledge-task-mode'),
  taskModeSegmented: document.querySelector('#knowledge-task-mode-segmented'),
  taskModeOptions: document.querySelector('#knowledge-task-mode-options'),
  taskModeDescription: document.querySelector('#knowledge-task-mode-description'),
  dateField: document.querySelector('#knowledge-date-field'),
  date: document.querySelector('#knowledge-date'),
  webField: document.querySelector('#knowledge-web-field'),
  webSearch: document.querySelector('#knowledge-web-search'),
  webStatus: document.querySelector('#knowledge-web-status'),
  searchPanel: document.querySelector('#knowledge-search-panel'),
  searchForm: document.querySelector('#knowledge-search-form'),
  searchInput: document.querySelector('#knowledge-search-input'),
  searchResults: document.querySelector('#knowledge-search-results'),
  clearSearch: document.querySelector('#knowledge-clear-search'),
  newConversation: document.querySelector('#knowledge-new-conversation'),
  clearHistory: document.querySelector('#knowledge-clear-history'),
  conversationList: document.querySelector('#knowledge-conversation-list'),
  stateDot: document.querySelector('#knowledge-state-dot'),
  stateTitle: document.querySelector('#knowledge-state-title'),
  stateMessage: document.querySelector('#knowledge-state-message'),
  stop: document.querySelector('#knowledge-stop'),
  transcript: document.querySelector('#knowledge-transcript'),
  form: document.querySelector('#knowledge-form'),
  continuationStatus: document.querySelector('#knowledge-continuation-status'),
  compactContext: document.querySelector('.knowledge-composer-context'),
  compactKind: document.querySelector('#knowledge-kind-compact'),
  compactKindValue: document.querySelector('#knowledge-kind-compact-value'),
  compactTaskMode: document.querySelector('#knowledge-task-mode-compact'),
  compactTaskModeValue: document.querySelector('#knowledge-task-mode-compact-value'),
  compactModel: document.querySelector('#knowledge-model-compact'),
  compactModelValue: document.querySelector('#knowledge-model-compact-value'),
  compactEffort: document.querySelector('#knowledge-effort-compact'),
  compactEffortValue: document.querySelector('#knowledge-effort-compact-value'),
  compactMenu: document.querySelector('#knowledge-compact-menu'),
  prompt: document.querySelector('#knowledge-prompt'),
  attachments: document.querySelector('#knowledge-attachments'),
  attachmentInput: document.querySelector('#knowledge-attachment-input'),
  attachmentHelp: document.querySelector('#knowledge-attachment-help'),
  voicePrivacy: document.querySelector('#knowledge-voice-privacy'),
  attach: document.querySelector('#knowledge-attach'),
  mic: document.querySelector('#knowledge-mic'),
  cancel: document.querySelector('#knowledge-cancel'),
  send: document.querySelector('#knowledge-send'),
  error: document.querySelector('#knowledge-error'),
  draftDialog: document.querySelector('#knowledge-draft-dialog'),
  draftForm: document.querySelector('#knowledge-draft-form'),
  draftTitleField: document.querySelector('#knowledge-draft-title-field'),
  draftTitle: document.querySelector('#knowledge-draft-title'),
  draftTarget: document.querySelector('#knowledge-draft-target'),
  draftContent: document.querySelector('#knowledge-draft-content'),
  draftRendered: document.querySelector('#knowledge-draft-rendered'),
  draftError: document.querySelector('#knowledge-draft-error'),
  draftClose: document.querySelector('#knowledge-draft-close'),
  discardDraft: document.querySelector('#knowledge-discard-draft'),
  saveDraft: document.querySelector('#knowledge-save-draft'),
  sourceDialog: document.querySelector('#knowledge-source-dialog'),
  sourceTitle: document.querySelector('#knowledge-source-title'),
  sourcePath: document.querySelector('#knowledge-source-path'),
  sourceContent: document.querySelector('#knowledge-source-content'),
  sourceClose: document.querySelector('#knowledge-source-close'),
  toast: document.querySelector('#knowledge-toast'),
};

const motionTimers = new WeakMap();
const motionFrames = new WeakMap();

function stopOneShotMotion(element, className) {
  if (!element) return;
  const previousFrame = motionFrames.get(element);
  const previousTimer = motionTimers.get(element);
  if (previousFrame !== undefined) window.cancelAnimationFrame(previousFrame);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);
  element.classList.remove(className);
  motionFrames.delete(element);
  motionTimers.delete(element);
}

function playOneShotMotion(element, className, duration = 280) {
  if (!element) return;
  stopOneShotMotion(element, className);
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const frame = window.requestAnimationFrame(() => {
    motionFrames.delete(element);
    element.classList.add(className);
    const timer = window.setTimeout(() => {
      element.classList.remove(className);
      motionTimers.delete(element);
    }, duration);
    motionTimers.set(element, timer);
  });
  motionFrames.set(element, frame);
}

function dispatchUserChange(select, origin) {
  const event = new Event('change', { bubbles: true });
  event.knowledgeUserInitiated = true;
  event.knowledgeChangeOrigin = origin;
  select.dispatchEvent(event);
}

function userInitiatedChange(event) {
  return event.isTrusted || event.knowledgeUserInitiated === true;
}

function commitTaskModeMotion(element, commit) {
  stopOneShotMotion(element, 'is-switching');
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    commit();
    return;
  }
  void element.offsetWidth;
  element.classList.add('is-switching');
  commit();
  const timer = window.setTimeout(() => {
    element.classList.remove('is-switching');
    motionTimers.delete(element);
  }, 480);
  motionTimers.set(element, timer);
}

const kindCopy = {
  qa: {
    title: '知识问答',
    placeholder: '向知识库提问……',
    state: '输入问题后，系统会先筛选候选，再由 AI 助手搜索全库核验来源。',
  },
  diary: {
    title: '日记模式',
    placeholder: '说说今天发生的事项、感悟和其他需要记录的内容……',
    state: 'AI 将按日记模板生成预览；同日文件存在时会保留原内容并智能合并。',
  },
  plan: {
    title: '计划模式',
    placeholder: '说说当天要完成的任务、时间安排和备注……',
    state: 'AI 将按计划模板整理任务清单，确认后才写入 Obsidian。',
  },
  scratch: {
    title: '随心记模式',
    placeholder: '记录刚学到的内容，也可以添加图片、PDF或文本文件……',
    state: 'AI 将生成标题和结构化笔记，原始附件只在确认后保存。',
  },
};

const qaSuggestionsMarkup = `
  <button class="knowledge-suggestion-card" type="button" data-prompt="梳理知识库中关于 RAG 的关键概念">
    <span class="knowledge-suggestion-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M5 3.5h9l4 4V13M14 3.5V8h4M5 3.5v17h8"></path><circle cx="17" cy="17" r="3"></circle><path d="m19.2 19.2 2 2"></path></svg></span>
    <span>梳理知识库中关于 RAG 的关键概念</span>
  </button>
  <button class="knowledge-suggestion-card" type="button" data-prompt="总结最近一个月的学习重点">
    <span class="knowledge-suggestion-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M5 5h14M5 10h9M5 15h11M5 20h7"></path><path d="m17 13 2 2 3-4"></path></svg></span>
    <span>总结最近一个月的学习重点</span>
  </button>
  <button class="knowledge-suggestion-card" type="button" data-prompt="查找知识库里关于推理优化的笔记">
    <span class="knowledge-suggestion-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M5 3.5h9l4 4V13"></path><path d="M14 3.5V8h4M5 3.5v17h8"></path><circle cx="17" cy="17" r="3"></circle><path d="m19.2 19.2 2 2"></path></svg></span>
    <span>查找知识库里关于推理优化的笔记</span>
  </button>`;

function selectedOptionLabel(select) {
  return select.selectedOptions[0]?.textContent || select.value;
}

function selectedModel() {
  return state.status?.models?.find((item) => item.id === elements.model.value);
}

function modelCatalogRevisionRequest(status = state.status) {
  const supported = status?.taskContractVersion === 2
    && status?.capabilities?.modelCatalogRevision === true;
  if (!supported) return {};
  if (status?.buildRevision !== CLIENT_BUILD_REVISION) {
    const error = new Error('页面版本与服务端不一致，请强制刷新页面后重试。');
    error.code = 'CLIENT_BUILD_REVISION_MISMATCH';
    throw error;
  }
  const revision = status?.modelCatalogRevision;
  if (typeof revision !== 'string' || !MODEL_CATALOG_REVISION.test(revision)) {
    const error = new Error('模型目录校验状态无效，请刷新页面后重试。');
    error.code = 'INVALID_MODEL_CATALOG_REVISION';
    throw error;
  }
  return { modelCatalogRevision: revision.toLowerCase() };
}

function localizedTaskModeLabel(item) {
  const label = String(item?.label || '').trim();
  if (item?.id === 'normal' && (!label || /^normal$/i.test(label))) return '普通';
  if (item?.id === 'deep' && (!label || /^deep$/i.test(label))) return '深度';
  return label || String(item?.id || '普通');
}

function localizedTaskModeDescription(item) {
  const description = String(item?.description || '').trim();
  if (item?.id === 'normal') {
    return '基于知识库进行检索与生成。';
  }
  if (item?.id === 'deep') {
    return '分解问题，执行多路混合检索并融合证据后生成可引用回答。';
  }
  return description;
}

const localizedEffortNames = Object.freeze({
  default: '模型默认', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
});

function localizedEffortLabel(effort) {
  const id = String(effort?.id || '').trim();
  const label = String(effort?.label || '').trim();
  if (localizedEffortNames[id] && (!label || label.toLowerCase() === id || /^default$/i.test(label))) {
    return localizedEffortNames[id];
  }
  return label || localizedEffortNames[id] || id;
}

function taskModeDefinitions() {
  const modes = state.status?.taskModes;
  return Array.isArray(modes) && modes.length
    ? modes
    : [{ id: 'normal', label: '普通', description: '默认任务模式。' }];
}

function selectedTaskMode() {
  return taskModeDefinitions().find((item) => item.id === elements.taskMode.value);
}

function syncTaskModeVisualState(options = {}) {
  const modes = taskModeDefinitions();
  const value = selectedTaskMode()?.id || modes[0]?.id || 'normal';
  const index = Math.max(0, modes.findIndex((item) => item.id === value));
  const disabled = state.busy || state.kind !== 'qa' || modes.length < 2;
  const previous = elements.taskModeSegmented?.dataset.taskMode || '';
  if (elements.taskModeSegmented) {
    const commit = () => {
      elements.taskModeSegmented.dataset.taskMode = value;
      elements.taskModeSegmented.style.setProperty('--kb-task-mode-count', String(Math.max(1, modes.length)));
      elements.taskModeSegmented.style.setProperty('--kb-task-mode-index', String(index));
    };
    if (options.animate && previous && previous !== value) commitTaskModeMotion(elements.taskModeSegmented, commit);
    else {
      stopOneShotMotion(elements.taskModeSegmented, 'is-switching');
      commit();
    }
    elements.taskModeSegmented.setAttribute('aria-disabled', String(disabled));
    elements.taskModeSegmented.querySelectorAll('[data-task-mode]').forEach((button) => {
      const selected = button.dataset.taskMode === value;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.disabled = disabled;
    });
  }
  elements.taskModeField?.setAttribute('aria-disabled', String(disabled));
  elements.compactTaskMode.dataset.taskMode = value;
  if (options.animate && previous && previous !== value) {
    if (options.compact) playOneShotMotion(elements.compactTaskMode, 'is-changing', 340);
    else stopOneShotMotion(elements.compactTaskMode, 'is-changing');
  } else if (!options.animate) {
    stopOneShotMotion(elements.compactTaskMode, 'is-changing');
  }
}

function renderTaskModeOptions() {
  if (!elements.taskModeOptions) return;
  elements.taskModeOptions.replaceChildren(...taskModeDefinitions().map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'knowledge-task-mode-option';
    button.setAttribute('role', 'radio');
    button.dataset.taskMode = item.id;
    button.textContent = localizedTaskModeLabel(item);
    return button;
  }));
  syncTaskModeVisualState();
}

function updateTaskModeUi(options = {}) {
  const qa = state.kind === 'qa';
  if (!qa) elements.taskMode.value = 'normal';
  if (!selectedTaskMode()) elements.taskMode.value = taskModeDefinitions()[0]?.id || 'normal';
  elements.taskMode.disabled = state.busy || !qa || taskModeDefinitions().length < 2;
  elements.compactTaskMode.hidden = !qa;
  elements.compactTaskMode.disabled = state.busy || !qa || taskModeDefinitions().length < 2;
  const taskMode = selectedTaskMode();
  elements.taskModeDescription.textContent = qa
    ? localizedTaskModeDescription(taskMode)
    : '当前功能固定使用普通任务模式。';
  syncTaskModeVisualState(options);
}

function effortDefinition(id) {
  return state.status?.efforts?.find((item) => item.id === id);
}

function effectiveModelEffort(model, requestedEffort) {
  const requested = String(requestedEffort || '').trim().toLowerCase();
  const mapped = model?.effortMapping && Object.hasOwn(model.effortMapping, requested)
    ? String(model.effortMapping[requested] || '').trim().toLowerCase()
    : requested;
  return EFFECTIVE_EFFORT_IDS.has(mapped) ? mapped : requested;
}

function effortSelectLabel(model, effortId) {
  const effort = effortDefinition(effortId) || { id: effortId, label: effortId };
  const label = localizedEffortLabel(effort);
  const effective = effectiveModelEffort(model, effortId);
  if (effective === 'default') return `${label}（模型默认）`;
  if (effective !== effortId) {
    return `${label}（实际：${localizedEffortLabel({ id: effective, label: effective })}）`;
  }
  return effortId === model?.defaultEffort ? `${label}（默认）` : label;
}

function selectedEffortMappingDescription(model = selectedModel()) {
  const requested = String(elements.effort.value || '').trim().toLowerCase();
  if (!model || !UNIVERSAL_EFFORT_IDS.includes(requested)) return '';
  const requestedLabel = localizedEffortLabel({ id: requested, label: requested });
  const effective = effectiveModelEffort(model, requested);
  if (effective === 'default') return `当前“${requestedLabel}”由模型默认策略处理`;
  if (effective === requested) return '';
  const effectiveLabel = localizedEffortLabel({ id: effective, label: effective });
  return `当前“${requestedLabel}”映射为供应商“${effectiveLabel}”`;
}

function sessionEffortDescription(data = {}) {
  const requested = String(data.requestedEffort || data.effort || '').trim().toLowerCase();
  if (!requested) return '';
  const requestedLabel = localizedEffortLabel({ id: requested, label: requested });
  const effective = String(data.effectiveEffort || '').trim().toLowerCase();
  if (!effective || effective === requested) return requestedLabel;
  if (effective === 'default') return `${requestedLabel} → 模型默认`;
  return `${requestedLabel} → 实际${localizedEffortLabel({ id: effective, label: effective })}`;
}

function refreshModelOptionLabels() {
  const compact = window.matchMedia?.('(max-width: 760px)').matches;
  for (const option of elements.model.options) {
    const model = state.status?.models?.find((item) => item.id === option.value);
    if (model) option.textContent = compact ? model.shortLabel || model.label : model.label;
  }
}

function renderModelCatalog(preferredModel = '', preferredEffort = '') {
  const models = Array.isArray(state.status?.models) ? state.status.models : [];
  elements.model.replaceChildren(...models.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    option.disabled = item.available === false;
    return option;
  }));
  const preferred = models.find((item) => (
    item.available !== false && (item.id === preferredModel || item.actualModel === preferredModel)
  ));
  elements.model.value = preferred?.id || models.find((item) => item.available !== false)?.id || '';
  if (!elements.model.value) throw new Error('当前没有可用的生成模型。');
  refreshModelOptionLabels();
  updateEffortOptions(preferredEffort);
  syncCompactSettingLabels();
}

function updateModelDescription() {
  const model = selectedModel();
  if (!model) {
    elements.modelDescription.textContent = '';
    return;
  }
  const mapping = selectedEffortMappingDescription(model);
  const capability = model.capabilityVerified === false && !model.effortMapping
    ? '思考档位尚未通过网关探测，当前使用模型默认。'
    : '';
  elements.modelDescription.textContent = [
    model.actualModel || model.id ? `实际模型 ID：${model.actualModel || model.id}` : '',
    mapping,
    capability,
  ].filter(Boolean).join(' · ');
}

function syncEffortVisualState(options = {}) {
  const value = elements.effort.value || 'default';
  const previous = elements.effortField?.dataset.effort || '';
  if (elements.effortField) elements.effortField.dataset.effort = value;
  elements.compactEffort.dataset.effort = value;
  if (options.animate && previous && previous !== value) {
    playOneShotMotion(elements.effortControl || elements.effortField, 'is-changing', 260);
    if (options.compact) playOneShotMotion(elements.compactEffort, 'is-changing', 260);
    else stopOneShotMotion(elements.compactEffort, 'is-changing');
  } else {
    stopOneShotMotion(elements.effortControl || elements.effortField, 'is-changing');
    stopOneShotMotion(elements.compactEffort, 'is-changing');
  }
}

function updateEffortOptions(preferredValue, options = {}) {
  const model = selectedModel();
  if (!model) {
    elements.effort.replaceChildren();
    updateModelDescription();
    syncEffortVisualState();
    return;
  }
  const effortIds = UNIVERSAL_EFFORT_IDS;
  elements.effort.replaceChildren(...effortIds.map((id) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = effortSelectLabel(model, id);
    return option;
  }));
  const preferred = String(preferredValue || '');
  const fallback = effortIds.includes(model.defaultEffort) ? model.defaultEffort : 'medium';
  elements.effort.value = effortIds.includes(preferred) ? preferred : fallback;
  updateModelDescription();
  syncEffortVisualState(options);
}

function syncCompactSettingLabels() {
  elements.compactKindValue.textContent = kindCopy[state.kind].title.replace(/模式$/, '');
  elements.compactTaskModeValue.textContent = localizedTaskModeLabel(selectedTaskMode());
  elements.compactTaskMode.dataset.taskMode = selectedTaskMode()?.id || 'normal';
  const model = selectedModel();
  elements.compactModelValue.textContent = model?.shortLabel || model?.label || selectedOptionLabel(elements.model);
  elements.compactEffortValue.textContent = selectedOptionLabel(elements.effort);
  elements.compactEffort.dataset.effort = elements.effort.value || 'default';
}

function compactSettingOptions(setting) {
  if (setting === 'kind') {
    return Object.entries(kindCopy).map(([value, copy]) => ({
      value,
      label: copy.title.replace(/模式$/, ''),
      selected: value === state.kind,
    }));
  }
  const select = setting === 'model'
    ? elements.model
    : setting === 'taskMode'
      ? elements.taskMode
      : elements.effort;
  return [...select.options].map((option) => ({
    value: option.value,
    label: setting === 'model'
      ? state.status?.models?.find((item) => item.id === option.value)?.shortLabel || option.textContent
      : option.textContent,
    selected: option.selected,
  }));
}

function closeCompactMenu() {
  elements.compactMenu.hidden = true;
  elements.compactMenu.replaceChildren();
  delete elements.compactMenu.dataset.setting;
  elements.compactContext.querySelectorAll('[aria-expanded="true"]').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
  });
}

function openCompactMenu(setting) {
  if (state.busy) return;
  if (!elements.compactMenu.hidden && elements.compactMenu.dataset.setting === setting) {
    closeCompactMenu();
    return;
  }
  closeCompactMenu();
  const options = compactSettingOptions(setting);
  elements.compactMenu.replaceChildren(...options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'option';
    button.dataset.value = option.value;
    button.setAttribute('aria-selected', String(option.selected));
    button.textContent = option.label;
    return button;
  }));
  elements.compactMenu.dataset.setting = setting;
  elements.compactMenu.hidden = false;
  elements.compactContext.querySelector(`[data-compact-setting="${setting}"]`)
    ?.setAttribute('aria-expanded', 'true');
}

function chooseCompactSetting(setting, value) {
  if (setting === 'kind') {
    setKind(value);
  } else {
    const select = setting === 'model'
      ? elements.model
      : setting === 'taskMode'
        ? elements.taskMode
        : elements.effort;
    select.value = value;
    dispatchUserChange(select, 'compact');
  }
  syncCompactSettingLabels();
  closeCompactMenu();
  window.requestAnimationFrame(() => elements.prompt.focus({ preventScroll: true }));
}

function knowledgeApiPath(input, knowledgeBaseId = state.knowledgeBaseId) {
  const value = String(input || '');
  const url = new URL(value, window.location.href);
  if (
    String(knowledgeBaseId || '').trim()
    && url.pathname.startsWith('/api/knowledge/')
    && url.pathname !== '/api/knowledge/bases'
  ) {
    url.searchParams.set('knowledgeBaseId', String(knowledgeBaseId).trim());
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!['GET', 'HEAD'].includes(method)) headers.set('X-VaultMind-Request', '1');
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(knowledgeApiPath(path), {
    credentials: 'same-origin', ...options, method, headers,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.code = payload.error || payload.code || '';
      throw error;
    }
    return payload;
  });
}

function friendlyModelError(code, fallback = '') {
  const messages = {
    LLM_MODEL_NOT_FOUND: '模型 ID 不存在，或当前 API Key 没有该模型权限。请到“模型配置”核对真实模型 ID。',
    LLM_AUTH_FAILED: '模型 API Key 无效、已过期或权限不足。请到“模型配置”更换凭据并检查连接。',
    LLM_PAYMENT_REQUIRED: '模型供应商账户余额不足或尚未开通计费。请先到供应商控制台检查余额与模型权限。',
    LLM_ENDPOINT_NOT_FOUND: '模型 API 地址不正确，或所选接口格式与地址不匹配。请到“模型配置”检查实际请求地址。',
    LLM_REQUEST_INCOMPATIBLE: '模型接口不接受当前请求参数。请到“模型配置”核对供应商、API 地址和模型 ID。',
    LLM_BAD_REQUEST: '模型服务拒绝了请求。请到“模型配置”执行连接检查，查看具体模型错误。',
    LLM_RATE_LIMITED: '模型服务当前限流或额度不足，请稍后重试并检查供应商额度。',
    LLM_PROVIDER_UNAVAILABLE: '模型供应商暂时不可用，请稍后重试。',
    LLM_STREAM_INCOMPLETE: '模型连接在完整结束前中断；半截回答没有保存，请重新提交。',
    LLM_RESPONSE_BLOCKED: '模型供应商拦截或拒绝了本次回答；未完成内容没有保存。',
    LLM_UNSUPPORTED_STOP_REASON: '模型以当前工作台不支持的状态结束；未完成内容没有保存，请检查模型兼容性。',
    MODEL_CONNECTION_INCOMPLETE: '模型连接缺少 API 地址、模型 ID 或 API Key。请先完成模型配置。',
  };
  return messages[String(code || '')] || String(fallback || '知识库任务失败。');
}

function configuredTimezone() {
  return String(
    state.status?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
}

function todayForTimezone() {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: configuredTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function syncSummary(sync) {
  if (typeof sync === 'string' && sync.trim()) return { text: sync.trim(), connected: null };
  if (!sync || typeof sync !== 'object') return { text: '同步状态未知', connected: null };
  const provider = String(sync.displayName || sync.label || sync.provider || sync.type || '').trim();
  const rawState = String(sync.status || sync.state || '').trim();
  const connected = typeof sync.connected === 'boolean'
    ? sync.connected
    : /^(connected|ready|healthy|ok|synced)$/i.test(rawState)
      ? true
      : /^(disconnected|error|unavailable|offline)$/i.test(rawState)
        ? false
        : null;
  const stateLabel = connected === true ? '已连接' : connected === false ? '未连接' : rawState;
  return {
    text: [provider, stateLabel].filter(Boolean).join(' · ') || '同步状态未知',
    connected,
  };
}

function applyStatusConfiguration(status) {
  const appName = String(status?.appName || 'Second Mind').trim() || 'Second Mind';
  const vaultLabel = String(status?.vaultLabel || status?.rootLabel || '知识库').trim() || '知识库';
  const sync = syncSummary(status?.sync);
  document.title = appName;
  elements.appDescription?.setAttribute('content', `${appName}：AI 知识库检索、日记、计划与学习记录工作台。`);
  [elements.appName, elements.headerAppName, elements.footerAppName].forEach((node) => {
    if (node) node.textContent = appName;
  });
  if (elements.headerVaultLabel) elements.headerVaultLabel.textContent = vaultLabel;
  if (elements.footerVaultLabel) elements.footerVaultLabel.textContent = `${vaultLabel} · ${configuredTimezone()}`;
  if (elements.syncStatus) {
    elements.syncStatus.textContent = sync.text;
    elements.syncStatus.parentElement.dataset.syncState = sync.connected === true
      ? 'connected'
      : sync.connected === false
        ? 'disconnected'
        : 'unknown';
  }
}

function webSearchAvailable(status = state.status) {
  return status?.webSearch?.enabled === true && status?.webSearch?.configured === true;
}

function knowledgeBaseSelectionStorageKey(session = state.session) {
  const username = String(session?.user?.username || '').trim();
  return username ? `${KNOWLEDGE_BASE_SELECTION_PREFIX}${encodeURIComponent(username)}` : '';
}

function readKnowledgeBaseSelection() {
  const key = knowledgeBaseSelectionStorageKey();
  if (!key) return '';
  try { return String(window.localStorage.getItem(key) || '').slice(0, 64); }
  catch { return ''; }
}

function persistKnowledgeBaseSelection(id = state.knowledgeBaseId) {
  const key = knowledgeBaseSelectionStorageKey();
  if (!key || !id) return;
  try { window.localStorage.setItem(key, String(id)); }
  catch { /* Storage can be unavailable in private browsing. */ }
}

function usableKnowledgeBase(entry) {
  return entry?.enabled !== false && !['disabled', 'failed'].includes(String(entry?.status || ''));
}

function chooseKnowledgeBase(payload, requested = '') {
  const entries = Array.isArray(payload?.knowledgeBases) ? payload.knowledgeBases : [];
  const candidates = [requested, readKnowledgeBaseSelection(), payload?.defaultKnowledgeBaseId]
    .map((item) => String(item || '').trim()).filter(Boolean);
  for (const id of candidates) {
    const found = entries.find((item) => item.knowledgeBaseId === id && usableKnowledgeBase(item));
    if (found) return found.knowledgeBaseId;
  }
  return entries.find(usableKnowledgeBase)?.knowledgeBaseId
    || entries.find((item) => item.default)?.knowledgeBaseId
    || entries[0]?.knowledgeBaseId
    || '';
}

function renderKnowledgeBaseSelector() {
  if (!elements.knowledgeBaseSelect || !elements.knowledgeBaseField) return;
  elements.knowledgeBaseSelect.replaceChildren(...state.knowledgeBases.map((entry) => {
    const option = document.createElement('option');
    option.value = entry.knowledgeBaseId;
    option.textContent = `${entry.name || entry.knowledgeBaseId}${usableKnowledgeBase(entry) ? '' : '（不可用）'}`;
    option.disabled = !usableKnowledgeBase(entry);
    return option;
  }));
  elements.knowledgeBaseSelect.value = state.knowledgeBaseId;
  elements.knowledgeBaseField.hidden = state.knowledgeBases.length === 0;
}

function updateWebSearchUi() {
  const qa = state.kind === 'qa';
  const enabled = state.status?.webSearch?.enabled === true;
  const configured = state.status?.webSearch?.configured === true;
  const available = enabled && configured;
  const disabled = state.busy || !qa || !available;
  elements.webField.hidden = !qa;
  elements.webSearch.disabled = disabled;
  elements.webField.classList.toggle('is-unavailable', !available);
  elements.webField.setAttribute('aria-disabled', String(disabled));
  if (!available) elements.webSearch.checked = false;
  const provider = state.status?.webSearch?.provider === 'tavily-rest'
    ? 'Tavily'
    : '百炼 WebSearch';
  elements.webStatus.textContent = available
    ? `${provider} 已配置；当前任务会固定使用这一供应商，不会自动切换。`
    : enabled
      ? '联网搜索尚未完成服务配置，当前不可用。'
      : '联网搜索未启用，当前不可用。';
}

function conversationSelectionStorageKey(session = state.session) {
  const username = String(session?.user?.username || '').trim();
  const knowledgeBaseId = String(state.knowledgeBaseId || '').trim();
  return username && knowledgeBaseId
    ? `${CONVERSATION_SELECTION_PREFIX}${encodeURIComponent(username)}:${encodeURIComponent(knowledgeBaseId)}`
    : '';
}

function initializeConversationSelectionStorage() {
  state.selectionStorageKey = conversationSelectionStorageKey();
}

function readConversationSelection() {
  if (!state.selectionStorageKey) return { state: 'uninitialized', id: null };
  try {
    const value = window.localStorage.getItem(state.selectionStorageKey);
    if (value === null) return { state: 'uninitialized', id: null };
    if (value === NEW_CONVERSATION_SENTINEL) return { state: 'new', id: null };
    return value && value.length <= 200
      ? { state: 'selected', id: value }
      : { state: 'invalid', id: null };
  } catch {
    return { state: 'unavailable', id: null };
  }
}

function persistConversationSelection(conversationId) {
  if (!state.selectionStorageKey) return;
  const value = conversationId ? String(conversationId) : NEW_CONVERSATION_SENTINEL;
  try {
    // Deliberately persist only the opaque server ID (or the explicit-new sentinel), never transcript data.
    window.localStorage.setItem(state.selectionStorageKey, value);
  } catch {
    // Private browsing and storage policies may disable localStorage; server history remains available.
  }
}

function currentFixedConversationSettings() {
  const model = selectedModel();
  const webSearch = Boolean(
    state.kind === 'qa' && webSearchAvailable() && elements.webSearch.checked
  );
  return {
    model: elements.model.value,
    actualModel: model?.actualModel || '',
    modelProvider: model?.provider || '',
    modelBindingRevision: model?.bindingRevision || '',
    effort: elements.effort.value,
    webSearch,
    webSearchProvider: webSearch ? String(state.status?.webSearch?.provider || '') : '',
    webSearchBindingRevision: webSearch
      ? String(state.status?.webSearch?.bindingRevision || '')
      : '',
  };
}

function fixedConversationSettingsChanged() {
  if (state.kind !== 'qa' || !state.conversationId || !state.conversationBaseline) return false;
  const current = currentFixedConversationSettings();
  return current.model !== state.conversationBaseline.model
    || (
      state.conversationBaseline.actualModel
      && current.actualModel !== state.conversationBaseline.actualModel
    )
    || (
      state.conversationBaseline.modelProvider
      && current.modelProvider !== state.conversationBaseline.modelProvider
    )
    || (
      state.conversationBaseline.modelBindingRevision
      && current.modelBindingRevision !== state.conversationBaseline.modelBindingRevision
    )
    || current.effort !== state.conversationBaseline.effort
    || current.webSearch !== state.conversationBaseline.webSearch
    || (
      current.webSearch && state.conversationBaseline.webSearch
      && state.conversationBaseline.webSearchProvider
      && current.webSearchProvider !== state.conversationBaseline.webSearchProvider
    )
    || (
      current.webSearch && state.conversationBaseline.webSearch
      && state.conversationBaseline.webSearchBindingRevision
      && current.webSearchBindingRevision !== state.conversationBaseline.webSearchBindingRevision
    );
}

function syncConversationContinuation() {
  const visible = state.kind === 'qa'
    && Boolean(state.conversationId)
    && state.conversationBaseline?.id === state.conversationId;
  state.pendingFork = visible && fixedConversationSettingsChanged();
  if (!elements.continuationStatus) return;
  elements.continuationStatus.hidden = !visible;
  if (!visible) {
    elements.continuationStatus.textContent = '';
    delete elements.continuationStatus.dataset.state;
    return;
  }
  const title = String(state.conversationBaseline.title || '当前对话').trim() || '当前对话';
  elements.continuationStatus.dataset.state = state.pendingFork ? 'fork' : 'continue';
  elements.continuationStatus.textContent = state.pendingFork
    ? `将从“${title}”派生新会话并保留上下文`
    : `正在继续：${title}`;
}

function selectConversation(conversation, options = {}) {
  const id = String(conversation?.id || '');
  const kind = conversation?.kind;
  const current = currentFixedConversationSettings();
  const knownModel = state.status?.models?.find((item) => (
    item.id === conversation?.model || item.actualModel === conversation?.model
  ));
  const storedEffort = String(conversation?.requestedEffort || conversation?.effort || '').trim().toLowerCase();
  state.selectedConversationId = id || null;
  state.conversationId = kind === 'qa' && id ? id : null;
  state.conversationBaseline = kind === 'qa' && id
    ? {
        id,
        title: String(conversation?.title || options.title || '当前对话'),
        model: knownModel?.id || conversation?.model || current.model,
        actualModel: conversation?.actualModel || '',
        modelProvider: conversation?.modelProvider || '',
        modelBindingRevision: conversation?.modelBindingRevision || '',
        // Conversations created before the universal five-level catalog can
        // contain `default`; treat the already-selected model default as the
        // compatible equivalent instead of immediately forcing a fork.
        effort: UNIVERSAL_EFFORT_IDS.includes(storedEffort) ? storedEffort : current.effort,
        webSearch: Object.hasOwn(conversation || {}, 'webSearch')
          ? conversation.webSearch === true
          : current.webSearch,
        webSearchProvider: conversation?.webSearchProvider || '',
        webSearchBindingRevision: conversation?.webSearchBindingRevision || '',
      }
    : null;
  state.pendingFork = false;
  if (options.persist !== false) persistConversationSelection(id || null);
  syncConversationContinuation();
}

function clearConversationSelection(options = {}) {
  state.conversationId = null;
  state.selectedConversationId = null;
  state.conversationBaseline = null;
  state.pendingFork = false;
  if (options.persistNew) persistConversationSelection(null);
  syncConversationContinuation();
}

function refreshSelectedConversationTitle() {
  if (!state.conversationBaseline) return;
  const selected = state.conversations.find((conversation) => conversation.id === state.conversationBaseline.id);
  if (selected?.title) state.conversationBaseline.title = selected.title;
  syncConversationContinuation();
}

function setGate(title, message, options = {}) {
  elements.gateTitle.textContent = title;
  elements.gateMessage.textContent = message;
  elements.loginForm.hidden = !options.login;
  elements.retry.hidden = !options.retry;
  elements.gateLink.hidden = !options.link;
  elements.gate.hidden = false;
  elements.app.hidden = true;
  if (options.login) elements.username.focus();
}

function setStatus(kind, title, message) {
  elements.stateDot.className = `knowledge-state-dot ${kind || ''}`.trim();
  elements.stateTitle.textContent = title;
  elements.stateMessage.textContent = message;
}

function setIdleStatus() {
  const message = state.kind === 'qa'
    ? '输入问题后开始检索与核验。'
    : kindCopy[state.kind].state;
  setStatus('', '准备就绪', message);
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => elements.toast.classList.remove('show'), 2800);
}

function clearFormError() {
  window.clearTimeout(state.formErrorTimer);
  state.formErrorTimer = null;
  elements.error.textContent = '';
}

function setFormError(message, options = {}) {
  clearFormError();
  const text = String(message || '');
  elements.error.textContent = text;
  const clearAfterMs = Number(options.clearAfterMs || 0);
  if (!text || clearAfterMs <= 0) return;
  state.formErrorTimer = window.setTimeout(() => {
    if (elements.error.textContent !== text) return;
    elements.error.textContent = '';
    state.formErrorTimer = null;
    options.onClear?.();
  }, clearAfterMs);
}

function showVoiceError(message) {
  setStatus('error', '口述转写失败', message);
  setFormError(message, {
    clearAfterMs: 4800,
    onClear: () => {
      if (!state.busy && !state.listening && !state.transcribing) {
        setIdleStatus();
      }
    },
  });
  toast(message);
}

function setBusy(value) {
  state.busy = value;
  elements.stop.hidden = !value;
  elements.cancel.hidden = !value;
  elements.send.hidden = value;
  elements.send.disabled = value;
  elements.newConversation.disabled = value;
  const visibleConversationCount = state.conversations.filter((conversation) => conversation.kind === state.kind).length;
  elements.clearHistory.disabled = value || visibleConversationCount === 0;
  elements.modes.querySelectorAll('button').forEach((button) => { button.disabled = value; });
  elements.model.disabled = value;
  elements.effort.disabled = value;
  elements.taskMode.disabled = value || state.kind !== 'qa' || taskModeDefinitions().length < 2;
  elements.compactKind.disabled = value;
  elements.compactTaskMode.disabled = value || state.kind !== 'qa' || taskModeDefinitions().length < 2;
  elements.compactModel.disabled = value;
  elements.compactEffort.disabled = value;
  elements.date.disabled = value;
  updateWebSearchUi();
  elements.attach.disabled = value;
  elements.mic.disabled = value || state.transcribing;
  elements.conversationList.querySelectorAll('button').forEach((button) => { button.disabled = value; });
  syncTaskModeVisualState();
}

function normalizeInternalPath(basePath, reference) {
  const raw = String(reference || '').split('|')[0].split('#')[0].trim().replaceAll('\\', '/');
  if (!raw || raw.startsWith('/') || raw.includes('..')) return '';
  if (raw.includes('/') && !raw.startsWith('./')) return raw;
  const base = String(basePath || '').split('/').slice(0, -1);
  return [...base, ...raw.replace(/^\.\//, '').split('/')].filter(Boolean).join('/');
}

function knowledgeFileLink(relativePath) {
  return knowledgeApiPath(`/api/knowledge/file?path=${encodeURIComponent(relativePath)}`);
}

function preprocessMarkdown(source, basePath = '') {
  let text = String(source || '');
  text = text.replace(/〔来源：([^〕#]+?)(?:#([^〕]+))?〕/g, (_match, file, heading) => {
    const clean = file.trim();
    const label = `〔来源：${clean}${heading ? `#${heading}` : ''}〕`;
    return `[${label}](${knowledgeFileLink(clean)})`;
  });
  text = text.replace(/!\[\[([^\]]+)\]\]/g, (_match, reference) => {
    const resolved = normalizeInternalPath(basePath, reference);
    if (!resolved) return _match;
    const label = reference.split('|').pop().trim();
    if (/\.(?:png|jpe?g|gif|webp)$/i.test(resolved)) {
      return `![${label}](${knowledgeFileLink(resolved)})`;
    }
    return `[附件：${label}](${knowledgeFileLink(resolved)})`;
  });
  text = text.replace(/(?<!!)\[\[([^\]]+)\]\]/g, (_match, reference) => {
    const resolved = normalizeInternalPath(basePath, reference);
    if (!resolved) return _match;
    const label = reference.includes('|') ? reference.split('|').pop().trim() : reference;
    return `[${label}](${knowledgeFileLink(resolved)})`;
  });
  return text;
}

function bindKnowledgeLinks(target) {
  target.querySelectorAll('a[href*="/api/knowledge/file?path="]').forEach((link) => {
    link.target = '';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const url = new URL(link.href, window.location.origin);
      openSource(url.searchParams.get('path') || '');
    });
  });
}

function renderMarkdown(target, source, basePath = '') {
  if (!window.VaultMindRenderer?.render) {
    target.textContent = source;
    return;
  }
  window.VaultMindRenderer.render(target, preprocessMarkdown(source, basePath));
  bindKnowledgeLinks(target);
}

const PROCESS_PHASES = [
  { id: 'prepare', label: '理解与准备' },
  { id: 'research', label: '检索与核验' },
  { id: 'answer', label: '组织与生成' },
];

const USAGE_METRICS = [
  { id: 'inputTokens', label: '输入' },
  { id: 'outputTokens', label: '输出' },
  { id: 'cacheReadTokens', label: '缓存读取' },
  { id: 'cacheWriteTokens', label: '缓存写入' },
  { id: 'reasoningTokens', label: '推理' },
  { id: 'totalTokens', label: '总计' },
];

function clearProcessTimer() {
  if (state.processTimer !== null) window.clearInterval(state.processTimer);
  state.processTimer = null;
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${String(remainingSeconds).padStart(2, '0')} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
}

function formatCompactElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes < 60
    ? `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

function tokenValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function firstTokenValue(...values) {
  for (const value of values) {
    const parsed = tokenValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizeUsagePayload(data = {}) {
  const usage = data?.usage && typeof data.usage === 'object'
    ? data.usage
    : data?.tokenUsage && typeof data.tokenUsage === 'object'
      ? data.tokenUsage
      : data;
  if (!usage || typeof usage !== 'object') return null;
  const promptDetails = usage.prompt_tokens_details || usage.promptTokensDetails
    || usage.input_tokens_details || usage.inputTokensDetails || {};
  const completionDetails = usage.completion_tokens_details || usage.completionTokensDetails
    || usage.output_tokens_details || usage.outputTokensDetails || {};
  const normalized = {
    inputTokens: firstTokenValue(
      usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens,
    ),
    outputTokens: firstTokenValue(
      usage.outputTokens, usage.output_tokens, usage.completionTokens, usage.completion_tokens,
    ),
    cacheReadTokens: firstTokenValue(
      usage.cacheReadTokens, usage.cacheReadInputTokens, usage.cache_read_input_tokens,
      promptDetails.cachedTokens, promptDetails.cached_tokens,
    ),
    cacheWriteTokens: firstTokenValue(
      usage.cacheWriteTokens, usage.cacheCreationTokens, usage.cacheCreationInputTokens,
      usage.cache_write_input_tokens, usage.cache_creation_input_tokens,
    ),
    reasoningTokens: firstTokenValue(
      usage.reasoningTokens, usage.reasoning_tokens,
      completionDetails.reasoningTokens, completionDetails.reasoning_tokens,
    ),
    totalTokens: firstTokenValue(usage.totalTokens, usage.total_tokens),
  };
  if (!Object.values(normalized).some((value) => value !== null)) return null;
  if (
    normalized.totalTokens === null
    && normalized.inputTokens !== null
    && normalized.outputTokens !== null
  ) {
    // Cache counters are normally subsets of input tokens, so they must not be
    // added again when deriving a total.
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens;
  }
  return normalized;
}

function sumUsageRecords() {
  const taskSnapshot = state.processUsageRecords.get('__task__');
  if (taskSnapshot) return { ...taskSnapshot };
  const totals = Object.fromEntries(USAGE_METRICS.map(({ id }) => [id, null]));
  for (const usage of state.processUsageRecords.values()) {
    for (const { id } of USAGE_METRICS) {
      if (usage[id] === null) continue;
      totals[id] = (totals[id] || 0) + usage[id];
    }
  }
  if (
    totals.totalTokens === null
    && totals.inputTokens !== null
    && totals.outputTokens !== null
  ) totals.totalTokens = totals.inputTokens + totals.outputTokens;
  return totals;
}

function formatTokenCount(value) {
  return value === null ? '—' : new Intl.NumberFormat('zh-CN').format(value);
}

function processUsageCoverage() {
  const calls = [...state.processUsageCalls.values()];
  return {
    total: calls.length,
    reported: calls.filter((call) => call.reported === true).length,
  };
}

function renderProcessUsage(options = {}) {
  if (!state.processUsageStatus || !state.processUsageGrid) return;
  const hasUsage = state.processUsage && Object.values(state.processUsage).some((value) => value !== null);
  const coverage = processUsageCoverage();
  const coverageText = coverage.total ? ` · ${coverage.reported}/${coverage.total} 次调用` : '';
  state.processUsageGrid.hidden = !hasUsage;
  if (!hasUsage) {
    state.processUsageStatus.textContent = options.final
      ? `未收到供应商统计${coverageText}`
      : `等待供应商统计${coverageText}`;
    state.processUsageSummary.textContent = 'Token：等待统计';
    state.processUsageSummary.dataset.state = options.final ? 'unavailable' : 'pending';
    if (options.final && state.processLiveMessage) {
      state.processLiveMessage.textContent = '任务已结束；本次没有收到可核验的供应商 Token 计量。';
    }
    return;
  }
  const partial = coverage.total > 0 && coverage.reported < coverage.total;
  state.processUsageStatus.textContent = options.final
    ? `${partial ? '部分供应商统计' : '最终供应商统计'}${coverageText}`
    : `供应商统计实时更新中${coverageText}`;
  const summaryTotal = state.processUsage.totalTokens;
  state.processUsageSummary.textContent = summaryTotal === null
    ? 'Token：已收到统计'
    : `Token：${formatTokenCount(summaryTotal)}`;
  state.processUsageSummary.dataset.state = 'available';
  for (const { id } of USAGE_METRICS) {
    const node = state.processUsageGrid.querySelector(`[data-usage-value="${id}"]`);
    if (node) node.textContent = formatTokenCount(state.processUsage[id]);
  }
}

function updateProcessUsage(data = {}, options = {}) {
  const recordId = String(
    data?.callId || data?.requestId || data?.usageId || data?.providerCallId || '',
  );
  const phase = String(data?.phase || '').toLowerCase();
  if (recordId) {
    const previousCall = state.processUsageCalls.get(recordId) || {
      reported: false,
      terminal: false,
    };
    state.processUsageCalls.set(recordId, {
      reported: previousCall.reported || data?.usageAvailable === true || Boolean(data?.usage),
      terminal: previousCall.terminal || ['final', 'complete', 'truncated', 'failed'].includes(phase),
    });
  }
  const usage = normalizeUsagePayload(data);
  if (!usage) {
    renderProcessUsage({ final: options.final === true });
    return false;
  }
  const eventId = String(options.eventId || '');
  const isDelta = data?.mode === 'delta' || data?.delta === true || data?.isDelta === true;
  if (isDelta && eventId && state.processUsageEventIds.has(eventId)) return false;
  if (eventId) state.processUsageEventIds.add(eventId);

  const taskScoped = data?.scope === 'task' || data?.cumulative === true || (!recordId && !isDelta);
  const key = taskScoped ? '__task__' : recordId || '__delta__';
  const previousRecord = state.processUsageRecords.get(key);
  if (taskScoped) state.processUsageRecords.clear();
  if (isDelta) {
    const previous = previousRecord
      || Object.fromEntries(USAGE_METRICS.map(({ id }) => [id, null]));
    for (const { id } of USAGE_METRICS) {
      if (usage[id] !== null) previous[id] = (previous[id] || 0) + usage[id];
    }
    state.processUsageRecords.set(key, previous);
  } else {
    state.processUsageRecords.set(key, previousRecord
      ? Object.fromEntries(USAGE_METRICS.map(({ id }) => [
          id,
          usage[id] === null ? previousRecord[id] : usage[id],
        ]))
      : usage);
  }
  state.processUsage = sumUsageRecords();
  renderProcessUsage({ final: options.final === true });
  return true;
}

function finishProcessItem(item, finishedAt = Date.now()) {
  if (!item) return;
  item.classList.remove('is-current');
  item.classList.add('is-complete');
  const startedAt = Number(item.dataset.startedAt) || finishedAt;
  item.dataset.finishedAt = String(finishedAt);
  const time = item.querySelector('.knowledge-process-step-time');
  if (time) time.textContent = formatElapsed(finishedAt - startedAt);
}

function updateProcessClock() {
  if (!state.processStartedAt || !state.processCard) return;
  const now = state.processFinishedAt || Date.now();
  const elapsed = Math.max(0, now - state.processStartedAt);
  if (state.processElapsed) state.processElapsed.textContent = formatElapsed(elapsed);
  if (state.processSummaryElapsed) state.processSummaryElapsed.textContent = formatCompactElapsed(elapsed);
  if (state.processCurrentItem && !state.processFinishedAt) {
    const startedAt = Number(state.processCurrentItem.dataset.startedAt) || now;
    const stageElapsed = Math.max(0, now - startedAt);
    const time = state.processCurrentItem.querySelector('.knowledge-process-step-time');
    if (time) time.textContent = `进行中 · ${formatElapsed(stageElapsed)}`;
    if (state.processLiveMessage) {
      state.processLiveMessage.textContent = state.processGenerating
        ? `回答正在持续生成，当前已等待 ${formatElapsed(stageElapsed)}；可随时取消任务。`
        : `当前阶段正在进行，已持续 ${formatElapsed(stageElapsed)}。`;
    }
  }
}

function processPhaseForStep(title = '', key = '') {
  const text = `${title} ${key}`.toLowerCase();
  if (key === 'generating' || key === 'complete' || /回答|生成答案|生成回答|compos|final/.test(text)) {
    return 'answer';
  }
  if (
    key.startsWith('tool:')
    || /检索|搜索|召回|候选|来源|证据|核验|网页|读取|融合|路径|embedding|retriev|search|source|evidence|read/.test(text)
  ) return 'research';
  return state.processCurrentPhase || 'prepare';
}

function updateProcessPhase(phase, options = {}) {
  const requestedIndex = PROCESS_PHASES.findIndex((item) => item.id === phase);
  const currentIndex = PROCESS_PHASES.findIndex((item) => item.id === state.processCurrentPhase);
  const nextIndex = Math.max(0, currentIndex, requestedIndex);
  state.processCurrentPhase = PROCESS_PHASES[nextIndex].id;
  for (const [index, definition] of PROCESS_PHASES.entries()) {
    const group = state.processGroups.get(definition.id);
    const phaseNode = state.processPhaseNodes.get(definition.id);
    const hasSteps = Boolean(group?.list.children.length);
    const phaseState = options.complete === true
      ? hasSteps ? 'done' : 'skipped'
      : options.failed === true
        ? index < nextIndex ? (hasSteps ? 'done' : 'skipped') : index === nextIndex ? 'error' : 'pending'
        : index < nextIndex ? (hasSteps ? 'done' : 'skipped') : index === nextIndex ? 'current' : 'pending';
    if (group) group.section.dataset.state = phaseState;
    if (phaseNode) {
      phaseNode.dataset.state = phaseState;
      phaseNode.setAttribute('aria-current', phaseState === 'current' ? 'step' : 'false');
      phaseNode.title = phaseState === 'skipped' ? '本次任务未执行此阶段' : '';
    }
    if (group && phaseState === 'skipped') group.count.textContent = '本次未执行';
  }
}

function resetTranscript() {
  clearProcessTimer();
  state.assistantNode = null;
  state.assistantText = '';
  state.processCard = null;
  state.processSummary = null;
  state.processList = null;
  state.processGroups = new Map();
  state.processPhaseNodes = new Map();
  state.processCurrentPhase = 'prepare';
  state.processCurrentItem = null;
  state.processLastKey = '';
  state.processGenerating = false;
  state.processStartedAt = 0;
  state.processFinishedAt = 0;
  state.processElapsed = null;
  state.processSummaryElapsed = null;
  state.processLiveMessage = null;
  state.processUsage = null;
  state.processUsageSummary = null;
  state.processUsageStatus = null;
  state.processUsageGrid = null;
  state.processUsageRecords = new Map();
  state.processUsageCalls = new Map();
  state.processUsageEventIds = new Set();
  elements.transcript.classList.add('is-welcome');
  elements.transcript.innerHTML = `
    <div class="knowledge-welcome">
      <h2>${kindCopy[state.kind].title}</h2>
      <p>${kindCopy[state.kind].state}</p>
      <p class="knowledge-process-note">生成时可展开“执行过程”，查看检索和阅读工具的实时状态。</p>
      ${state.kind === 'qa' ? `<div class="knowledge-suggestions">
        ${qaSuggestionsMarkup}
      </div>` : ''}
    </div>`;
  bindSuggestions();
}

function removeWelcome() {
  elements.transcript.querySelector('.knowledge-welcome')?.remove();
  elements.transcript.classList.remove('is-welcome');
}

function scrollTranscript() {
  window.requestAnimationFrame(() => {
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
  });
}

function startProcess(title = '正在分析请求', options = {}) {
  clearProcessTimer();
  removeWelcome();
  const details = document.createElement('details');
  details.className = 'knowledge-process';
  details.open = true;
  const summary = document.createElement('summary');
  const indicator = document.createElement('span');
  indicator.className = 'knowledge-process-indicator working';
  indicator.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  copy.className = 'knowledge-process-summary';
  const heading = document.createElement('strong');
  heading.textContent = '执行过程';
  const status = document.createElement('small');
  status.textContent = title;
  copy.append(heading, status);
  const summaryMeta = document.createElement('span');
  summaryMeta.className = 'knowledge-process-summary-meta';
  const summaryElapsed = document.createElement('span');
  summaryElapsed.className = 'knowledge-process-summary-badge';
  summaryElapsed.textContent = '00:00';
  const usageSummary = document.createElement('span');
  usageSummary.className = 'knowledge-process-summary-badge knowledge-process-token-badge';
  usageSummary.dataset.state = 'pending';
  usageSummary.textContent = 'Token：等待统计';
  summaryMeta.append(summaryElapsed, usageSummary);
  summary.append(indicator, copy, summaryMeta);
  const body = document.createElement('div');
  body.className = 'knowledge-process-body';
  const privacy = document.createElement('p');
  privacy.textContent = '这里展示可核验的处理步骤和工具调用，不展示模型的隐藏内部推理。';
  const phases = document.createElement('div');
  phases.className = 'knowledge-process-phases';
  phases.setAttribute('role', 'list');
  const telemetry = document.createElement('section');
  telemetry.className = 'knowledge-process-telemetry';
  telemetry.setAttribute('aria-label', '任务耗时与 Token 使用');
  const elapsedBlock = document.createElement('div');
  elapsedBlock.className = 'knowledge-process-telemetry-primary';
  const elapsedLabel = document.createElement('small');
  elapsedLabel.textContent = '已用时';
  const elapsed = document.createElement('strong');
  elapsed.textContent = '0 秒';
  elapsedBlock.append(elapsedLabel, elapsed);
  const usageBlock = document.createElement('div');
  usageBlock.className = 'knowledge-process-telemetry-primary';
  const usageLabel = document.createElement('small');
  usageLabel.textContent = 'Token 使用';
  const usageStatus = document.createElement('strong');
  usageStatus.textContent = '等待供应商统计';
  usageStatus.setAttribute('aria-live', 'polite');
  usageBlock.append(usageLabel, usageStatus);
  const liveMessage = document.createElement('p');
  liveMessage.className = 'knowledge-process-live-message';
  liveMessage.textContent = '当前阶段正在进行，页面会实时更新。';
  const usageGrid = document.createElement('div');
  usageGrid.className = 'knowledge-process-usage-grid';
  usageGrid.hidden = true;
  for (const metric of USAGE_METRICS) {
    const metricNode = document.createElement('span');
    const metricLabel = document.createElement('small');
    metricLabel.textContent = metric.label;
    const value = document.createElement('strong');
    value.dataset.usageValue = metric.id;
    value.textContent = '—';
    metricNode.append(metricLabel, value);
    usageGrid.append(metricNode);
  }
  telemetry.append(elapsedBlock, usageBlock, liveMessage, usageGrid);

  const groups = document.createElement('div');
  groups.className = 'knowledge-process-groups';
  state.processGroups = new Map();
  state.processPhaseNodes = new Map();
  for (const [index, definition] of PROCESS_PHASES.entries()) {
    const phaseNode = document.createElement('span');
    phaseNode.className = 'knowledge-process-phase';
    phaseNode.dataset.phase = definition.id;
    phaseNode.dataset.state = index === 0 ? 'current' : 'pending';
    phaseNode.setAttribute('role', 'listitem');
    phaseNode.setAttribute('aria-current', index === 0 ? 'step' : 'false');
    phaseNode.textContent = `${index + 1}. ${definition.label}`;
    phases.append(phaseNode);
    state.processPhaseNodes.set(definition.id, phaseNode);

    const section = document.createElement('section');
    section.className = 'knowledge-process-group';
    section.dataset.phase = definition.id;
    section.dataset.state = index === 0 ? 'current' : 'pending';
    const groupHeader = document.createElement('header');
    const groupTitle = document.createElement('strong');
    groupTitle.textContent = definition.label;
    const count = document.createElement('small');
    count.textContent = '等待开始';
    groupHeader.append(groupTitle, count);
    const list = document.createElement('ol');
    list.className = 'knowledge-process-list';
    section.append(groupHeader, list);
    groups.append(section);
    state.processGroups.set(definition.id, { section, list, count });
  }
  body.append(privacy, phases, telemetry, groups);
  details.append(summary, body);
  elements.transcript.append(details);
  state.processCard = details;
  state.processSummary = status;
  state.processList = state.processGroups.get('prepare').list;
  state.processCurrentPhase = 'prepare';
  state.processCurrentItem = null;
  state.processLastKey = '';
  state.processGenerating = false;
  const suppliedStartedAt = new Date(options.startedAt || 0).getTime();
  state.processStartedAt = Number.isFinite(suppliedStartedAt) && suppliedStartedAt > 0
    ? Math.min(suppliedStartedAt, Date.now())
    : Date.now();
  state.processFinishedAt = 0;
  state.processElapsed = elapsed;
  state.processSummaryElapsed = summaryElapsed;
  state.processLiveMessage = liveMessage;
  state.processUsage = null;
  state.processUsageSummary = usageSummary;
  state.processUsageStatus = usageStatus;
  state.processUsageGrid = usageGrid;
  state.processUsageRecords = new Map();
  state.processUsageCalls = new Map();
  state.processUsageEventIds = new Set();
  updateProcessPhase('prepare');
  renderProcessUsage();
  updateProcessClock();
  state.processTimer = window.setInterval(updateProcessClock, 1_000);
  appendProcessStep('分析请求', kindCopy[state.kind].state, 'analysis');
  scrollTranscript();
}

function appendProcessStep(title, detail = '', key = '') {
  if (!state.processCard) startProcess();
  const normalizedKey = key || `${title}:${detail}`;
  const phase = processPhaseForStep(title, normalizedKey);
  updateProcessPhase(phase);
  const group = state.processGroups.get(state.processCurrentPhase);
  state.processList = group?.list || state.processList;
  let item = state.processCurrentItem;
  if (!item || state.processLastKey !== normalizedKey) {
    finishProcessItem(state.processCurrentItem);
    item = document.createElement('li');
    item.className = 'is-current';
    item.dataset.startedAt = String(Date.now());
    item.dataset.processKey = normalizedKey.slice(0, 160);
    const marker = document.createElement('span');
    marker.className = 'knowledge-process-step-dot';
    marker.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('div');
    const heading = document.createElement('strong');
    heading.className = 'knowledge-process-step-title';
    const description = document.createElement('p');
    description.className = 'knowledge-process-step-description';
    const time = document.createElement('time');
    time.className = 'knowledge-process-step-time';
    time.textContent = '进行中 · 0 秒';
    copy.append(heading, description, time);
    item.append(marker, copy);
    state.processList.append(item);
    state.processCurrentItem = item;
    state.processLastKey = normalizedKey;
    if (group) {
      group.count.textContent = `${group.list.children.length} 个步骤`;
      group.section.dataset.empty = 'false';
    }
  }
  item.querySelector('.knowledge-process-step-title').textContent = title;
  item.querySelector('.knowledge-process-step-description').textContent = detail;
  item.querySelector('.knowledge-process-step-description').hidden = !detail;
  state.processSummary.textContent = title;
  updateProcessClock();
  scrollTranscript();
  return item;
}

function appendProcessCandidates(data = {}) {
  const candidates = Array.isArray(data.candidateSources) ? data.candidateSources : [];
  const includedCount = Number.isInteger(data.includedCount)
    ? data.includedCount
    : candidates.filter((candidate) => candidate?.included === true).length;
  const detail = `${candidates.length} 条有效候选 · ${includedCount} 条进入模型上下文`;
  const item = appendProcessStep(data.title || '联网候选已整理', data.message || detail, 'web-candidates');
  item.querySelector('.knowledge-process-candidates')?.remove();
  if (candidates.length === 0) return;

  const disclosure = document.createElement('details');
  disclosure.className = 'knowledge-process-candidates';
  const summary = document.createElement('summary');
  summary.textContent = `查看 ${candidates.length} 条候选`;
  const list = document.createElement('ol');

  for (const candidate of candidates) {
    let parsedUrl;
    try {
      parsedUrl = new URL(String(candidate?.url || ''));
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== 'https:') continue;

    const row = document.createElement('li');
    const link = document.createElement('a');
    link.href = parsedUrl.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer nofollow';
    link.textContent = String(candidate?.title || parsedUrl.hostname).slice(0, 240);
    const meta = document.createElement('small');
    const queryIndex = Number.isInteger(candidate?.queryIndex) ? candidate.queryIndex + 1 : null;
    const stateLabel = candidate?.included === true ? '已进入模型' : '未进入模型';
    meta.textContent = [queryIndex && `检索 ${queryIndex}`, parsedUrl.hostname, stateLabel]
      .filter(Boolean)
      .join(' · ');
    row.append(link, meta);
    list.append(row);
  }

  if (!list.children.length) return;
  disclosure.append(summary, list);
  item.querySelector('div').append(disclosure);
}

function completeProcess(success, detail = '') {
  if (!state.processCard) return;
  const indicator = state.processCard.querySelector('.knowledge-process-indicator');
  indicator.className = `knowledge-process-indicator ${success ? 'done' : 'error'}`;
  state.processSummary.textContent = success ? '处理完成' : '处理已结束';
  appendProcessStep(success ? '完成回答' : '任务结束', detail, 'complete');
  state.processFinishedAt = Date.now();
  finishProcessItem(state.processCurrentItem, state.processFinishedAt);
  state.processCurrentItem?.classList.add(success ? 'is-success' : 'is-error');
  clearProcessTimer();
  updateProcessClock();
  updateProcessPhase('answer', { complete: success, failed: !success });
  renderProcessUsage({ final: true });
  if (state.processLiveMessage && state.processUsage) {
    state.processLiveMessage.textContent = success
      ? '任务已完成；下方为供应商返回的最终可核验计量。'
      : '任务已结束；下方保留供应商已返回的可核验计量。';
  }
}

function attachDraftButton(article, draftId) {
  if (!article || !draftId || article.querySelector('.knowledge-open-draft')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'knowledge-open-draft';
  button.textContent = '打开待确认草稿';
  button.addEventListener('click', () => loadDraft(draftId));
  article.append(button);
}

function appendMessage(role, text, options = {}) {
  removeWelcome();
  const article = document.createElement('article');
  article.className = `knowledge-message ${role}`;
  const label = document.createElement('div');
  label.className = 'knowledge-message-label';
  label.textContent = role === 'user' ? '你' : '知识库助手';
  const content = document.createElement('div');
  content.className = 'knowledge-message-content';
  if (role === 'assistant') renderMarkdown(content, text);
  else content.textContent = text;
  article.append(label, content);
  attachDraftButton(article, options.draftId);
  elements.transcript.append(article);
  scrollTranscript();
  return content;
}

function appendNotice(message, type = '', options = {}) {
  removeWelcome();
  const notice = document.createElement('div');
  notice.className = `knowledge-notice ${type}`.trim();
  notice.textContent = message;
  if (options.configurationLink === true && !elements.adminConfig?.hidden) {
    const link = document.createElement('a');
    link.href = state.knowledgeBaseId
      ? `./admin-config.html?knowledgeBaseId=${encodeURIComponent(state.knowledgeBaseId)}`
      : './admin-config.html';
    link.textContent = '打开模型配置';
    link.className = 'knowledge-notice-action';
    notice.append(document.createTextNode(' '), link);
  }
  elements.transcript.append(notice);
  scrollTranscript();
}

function discardPartialAssistant() {
  if (!state.assistantNode) return false;
  state.assistantNode.closest('.knowledge-message')?.remove();
  state.assistantNode = null;
  state.assistantText = '';
  return true;
}

function bindSuggestions() {
  elements.transcript.querySelectorAll('.knowledge-suggestions button').forEach((button) => {
    button.addEventListener('click', () => {
      elements.prompt.value = button.dataset.prompt || button.textContent.trim();
      elements.prompt.focus();
    });
  });
}

function setKind(kind, reset = true) {
  if (!kindCopy[kind] || state.busy) return;
  const kindChanged = state.kind !== kind;
  state.kind = kind;
  clearFormError();
  updateTaskModeUi();
  syncCompactSettingLabels();
  elements.modes.querySelectorAll('[data-kind]').forEach((button) => {
    const selected = button.dataset.kind === kind;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  elements.dateField.hidden = !['diary', 'plan'].includes(kind);
  updateWebSearchUi();
  elements.searchPanel.hidden = kind !== 'qa';
  elements.attach.hidden = false;
  elements.attachmentInput.multiple = true;
  elements.attachmentInput.accept = kind === 'qa'
    ? 'text/*,.json,.js,.mjs,.ts,.tsx,.jsx,.py,.c,.cc,.cpp,.cu,.h,.hpp,.java,.rs,.sh,.sql,.yaml,.yml,.toml,.xml,.csv,.log,.md'
    : 'image/jpeg,image/png,image/gif,image/webp,application/pdf,text/*,.json,.js,.mjs,.ts,.tsx,.jsx,.py,.c,.cc,.cpp,.cu,.h,.hpp,.java,.rs,.sh,.sql,.yaml,.yml,.toml,.xml,.csv,.log,.md';
  elements.attach.replaceChildren();
  const attachIcon = document.createElement('span');
  attachIcon.setAttribute('aria-hidden', 'true');
  attachIcon.textContent = '＋';
  elements.attach.append(attachIcon, document.createTextNode(' 添加文件'));
  const limits = attachmentLimits();
  const typeHelp = kind === 'qa' ? '文本附件' : '图片、PDF 与文本附件';
  elements.attachmentHelp.textContent = `${typeHelp} · 支持粘贴 · 最多 ${limits.count} 个 · 单个 ${formatBytes(limits.bytesPerAttachment)} · 总计 ${formatBytes(limits.totalBytes)}`;
  elements.prompt.required = true;
  elements.prompt.placeholder = kindCopy[kind].placeholder;
  if (kindChanged) clearAttachments();
  if (reset && kindChanged) {
    clearConversationSelection();
    resetTranscript();
  }
  syncConversationContinuation();
  setIdleStatus();
  renderConversationList();
}

function conversationTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: configuredTimezone(), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }
}

function renderConversationList() {
  elements.conversationList.replaceChildren();
  const relevant = state.conversations.filter((conversation) => conversation.kind === state.kind);
  elements.clearHistory.disabled = state.busy || relevant.length === 0;
  if (!relevant.length) {
    const empty = document.createElement('p');
    empty.textContent = '这个模式还没有历史记录。';
    elements.conversationList.append(empty);
    return;
  }
  for (const conversation of relevant) {
    const row = document.createElement('div');
    row.className = 'knowledge-conversation-item';
    row.classList.toggle('active', conversation.id === state.selectedConversationId);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'knowledge-conversation-open';
    open.innerHTML = `<strong></strong><small></small>`;
    open.querySelector('strong').textContent = conversation.title || '未命名对话';
    open.querySelector('small').textContent = `${conversationTime(conversation.updatedAt)}${conversation.activeTask ? ' · 运行中' : ''}`;
    open.addEventListener('click', () => openConversation(conversation.id));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'knowledge-conversation-delete';
    remove.textContent = '×';
    remove.title = '删除聊天记录，不删除知识库文件';
    remove.setAttribute('aria-label', `删除“${conversation.title || '未命名对话'}”聊天记录`);
    remove.addEventListener('click', () => deleteConversation(conversation));
    row.append(open, remove);
    elements.conversationList.append(row);
  }
}

async function loadConversations() {
  const knowledgeBaseId = state.knowledgeBaseId;
  const epoch = state.knowledgeBaseEpoch;
  try {
    const payload = await api('/api/knowledge/conversations');
    if (state.knowledgeBaseId !== knowledgeBaseId || state.knowledgeBaseEpoch !== epoch) return false;
    state.conversations = payload.conversations || [];
    refreshSelectedConversationTitle();
    renderConversationList();
    return true;
  } catch (error) {
    if (state.knowledgeBaseId !== knowledgeBaseId || state.knowledgeBaseEpoch !== epoch) return false;
    elements.conversationList.replaceChildren(searchMessage(error.message));
    return false;
  }
}

function renderConversationTranscript(conversation, options = {}) {
  resetTranscript();
  let messages = [...(conversation.messages || [])];
  // An active-task snapshot can race task completion before this conversation
  // request returns. In that case the final assistant is already durable, but
  // the in-memory SSE backlog will replay it too. Render all prior turns and
  // let SSE own the active task's trailing assistant to avoid duplication.
  if (options.excludeTrailingAssistant && messages.at(-1)?.role === 'assistant') {
    messages = messages.slice(0, -1);
  }
  for (const message of messages) {
    const names = message.role === 'user' && message.attachments?.length
      ? `\n\n附件：${message.attachments.join('、')}` : '';
    appendMessage(message.role, `${message.text ?? message.content ?? ''}${names}`, { draftId: message.draftId });
  }
}

async function openConversation(id) {
  if (state.busy) return;
  const knowledgeBaseId = state.knowledgeBaseId;
  const epoch = state.knowledgeBaseEpoch;
  try {
    const conversation = await api(`/api/knowledge/conversations/${encodeURIComponent(id)}`);
    if (state.knowledgeBaseId !== knowledgeBaseId || state.knowledgeBaseEpoch !== epoch) return false;
    if (!kindCopy[conversation.kind]) throw new Error('该历史记录的模式在当前版本中不可用。');
    setKind(conversation.kind, false);
    elements.taskMode.value = conversation.kind === 'qa' ? conversation.taskMode || 'normal' : 'normal';
    if (!selectedTaskMode()) elements.taskMode.value = 'normal';
    updateTaskModeUi();
    const conversationModel = state.status?.models?.find((item) => (
      item.id === conversation.model || item.actualModel === conversation.model
    ));
    elements.model.value = conversationModel?.id || conversation.model;
    if (!selectedModel() || selectedModel().available === false) {
      throw new Error('该对话使用的模型当前不可用。');
    }
    updateEffortOptions(conversation.requestedEffort || conversation.effort);
    elements.webSearch.checked = conversation.kind === 'qa' && conversation.webSearch === true;
    updateWebSearchUi();
    syncCompactSettingLabels();
    selectConversation(conversation);
    renderConversationTranscript(conversation);
    setStatus('', conversation.title, conversation.kind === 'qa' ? '已恢复对话，可以继续追问。' : '已打开历史记录。');
    renderConversationList();
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

async function restoreConversationSelection() {
  const stored = readConversationSelection();
  if (stored.state === 'new') {
    clearConversationSelection();
    return;
  }
  if (stored.state === 'selected') {
    const exists = state.conversations.some((conversation) => conversation.id === stored.id);
    if (exists && await openConversation(stored.id)) return;
    clearConversationSelection({ persistNew: true });
    return;
  }
  if (!['uninitialized', 'unavailable'].includes(stored.state)) {
    clearConversationSelection({ persistNew: true });
    return;
  }

  // Upgrade path: with no prior browser selection, continue the newest Q&A once.
  const latestQa = state.conversations.find((conversation) => conversation.kind === 'qa');
  if (latestQa && await openConversation(latestQa.id)) return;
  clearConversationSelection({ persistNew: stored.state === 'uninitialized' });
}

async function deleteConversation(conversation) {
  if (state.busy || !window.confirm(`删除聊天记录“${conversation.title}”吗？知识库文件不会被删除。`)) return;
  try {
    await api(`/api/knowledge/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
    if (state.selectedConversationId === conversation.id) {
      clearConversationSelection({ persistNew: true });
      resetTranscript();
    }
    await loadConversations();
    toast('聊天记录已删除，知识库文件未受影响。');
  } catch (error) {
    toast(error.message);
  }
}

async function clearCurrentHistory() {
  if (state.busy) return;
  const relevant = state.conversations.filter((conversation) => conversation.kind === state.kind);
  if (!relevant.length) return;
  const mode = kindCopy[state.kind]?.title || '当前模式';
  const confirmed = window.confirm(
    `清空“${mode}”中的 ${relevant.length} 条历史记录吗？此操作不可撤销，但不会删除知识库文件、已保存笔记或草稿。`,
  );
  if (!confirmed) return;
  elements.clearHistory.disabled = true;
  try {
    const result = await api(
      `/api/knowledge/conversations?kind=${encodeURIComponent(state.kind)}`,
      { method: 'DELETE' },
    );
    clearConversationSelection({ persistNew: true });
    resetTranscript();
    setIdleStatus();
    await loadConversations();
    toast(`已清空 ${Number(result.deletedCount) || 0} 条“${mode}”历史，知识库文件和草稿未受影响。`);
  } catch (error) {
    toast(error.message);
    renderConversationList();
  }
}

function parseEvent(event) {
  try { return JSON.parse(event.data); } catch { return {}; }
}

function connectTask(taskId, options = {}) {
  state.taskId = taskId;
  state.source?.close();
  if (!state.processCard) startProcess('正在连接知识库助手', { startedAt: options.startedAt });
  const knowledgeBaseId = state.knowledgeBaseId;
  const epoch = state.knowledgeBaseEpoch;
  const active = () => (
    state.knowledgeBaseId === knowledgeBaseId && state.knowledgeBaseEpoch === epoch
  );
  const source = new EventSource(knowledgeApiPath(
    `/api/knowledge/tasks/${encodeURIComponent(taskId)}/events`,
    knowledgeBaseId,
  ));
  const listen = (type, handler) => source.addEventListener(type, (event) => {
    if (active()) handler(event);
  });
  state.source = source;
  listen('state', (event) => {
    const data = parseEvent(event);
    if (data.usage || data.tokenUsage) updateProcessUsage(data, { eventId: event.lastEventId });
    setStatus('working', '正在处理', data.message || 'AI 助手正在读取知识库。');
    appendProcessStep('任务已开始', data.message || 'AI 助手正在读取知识库。', 'task-state');
  });
  listen('session', (event) => {
    const data = parseEvent(event);
    if (data.usage || data.tokenUsage) updateProcessUsage(data, { eventId: event.lastEventId });
    const effort = sessionEffortDescription(data);
    const taskMode = taskModeDefinitions().find((item) => item.id === data.taskMode);
    const detail = [
      taskMode && `任务：${localizedTaskModeLabel(taskMode)}`,
      data.model,
      effort && `思考强度：${effort}`,
    ].filter(Boolean).join(' · ');
    appendProcessStep('模型会话已建立', detail, 'session');
  });
  listen('thinking', (event) => {
    const data = parseEvent(event);
    if (data.usage || data.tokenUsage) updateProcessUsage(data, { eventId: event.lastEventId });
    const tokens = Number(data.estimatedTokens) > 0
      ? ` · 规划估算约 ${data.estimatedTokens} Token（不作为供应商计量）`
      : '';
    appendProcessStep('正在分析与规划', `${data.message || '正在规划下一步。'}${tokens}`, 'thinking');
  });
  listen('activity', (event) => {
    const data = parseEvent(event);
    if (data.usage || data.tokenUsage) updateProcessUsage(data, { eventId: event.lastEventId });
    setStatus('working', data.title || '正在检索', data.message || '');
    const key = data.toolName ? `tool:${data.toolName}:${data.stage || ''}` : '';
    if (Array.isArray(data.candidateSources)) appendProcessCandidates(data);
    else appendProcessStep(data.title || '正在调用工具', data.message || '', key);
  });
  listen('diagnostic', (event) => {
    const data = parseEvent(event);
    if (data.message) appendProcessStep('运行信息', data.message.slice(0, 500), 'diagnostic');
  });
  listen('warning', (event) => {
    const data = parseEvent(event);
    const message = data.message || '任务正在重试。';
    appendProcessStep(data.title || '服务正在重试', message, data.key || 'warning');
    appendNotice(message);
  });
  const handleUsage = (event) => {
    updateProcessUsage(parseEvent(event), { eventId: event.lastEventId });
  };
  // `usage` is the forward-compatible task-level contract. `token_usage` is
  // accepted as an adapter-friendly alias; both require real provider counters.
  listen('usage', handleUsage);
  listen('token_usage', handleUsage);
  listen('text', (event) => {
    const data = parseEvent(event);
    if (data.usage || data.tokenUsage) updateProcessUsage(data, { eventId: event.lastEventId });
    const text = data.text || '';
    if (!state.processGenerating) {
      state.processGenerating = true;
      appendProcessStep('正在生成回答', '答案会持续排版；Token 统计以供应商返回为准。', 'generating');
    }
    if (!state.assistantNode) state.assistantNode = appendMessage('assistant', '');
    state.assistantText += text;
    renderMarkdown(state.assistantNode, state.assistantText);
    scrollTranscript();
  });
  listen('text_replace', (event) => {
    const data = parseEvent(event);
    if (data.usage || data.tokenUsage) updateProcessUsage(data, { eventId: event.lastEventId });
    if (!state.processGenerating) {
      state.processGenerating = true;
      appendProcessStep('正在生成回答', '正在应用最终核验后的回答内容。', 'generating');
    }
    if (!state.assistantNode) state.assistantNode = appendMessage('assistant', '');
    state.assistantText = String(data.text || '');
    renderMarkdown(state.assistantNode, state.assistantText);
    scrollTranscript();
  });
  listen('draft_ready', (event) => {
    state.draft = parseEvent(event);
    attachDraftButton(state.assistantNode?.closest('.knowledge-message'), state.draft.id);
    clearAttachments();
    openDraft(state.draft);
    if (state.draft.warnings?.length) {
      appendNotice(`草稿已生成，但后台记录出现警告：${state.draft.warnings.join(', ')}`);
      toast('草稿已生成，但请检查服务日志。');
    }
  });
  listen('task_error', (event) => {
    const data = parseEvent(event);
    const message = friendlyModelError(data.code, data.message || '知识库任务失败。');
    const configurationLink = String(data.code || '').startsWith('LLM_') ||
      String(data.code || '').startsWith('MODEL_');
    discardPartialAssistant();
    appendNotice(message, 'error', { configurationLink });
    completeProcess(false, message);
    setStatus('error', '任务失败', message);
  });
  listen('done', (event) => {
    const data = parseEvent(event);
    updateProcessUsage(data, { eventId: event.lastEventId, final: true });
    const doneMessage = data.status === 'failed'
      ? friendlyModelError(data.code, data.message || '')
      : data.message || '';
    source.close();
    state.source = null;
    state.taskId = null;
    setBusy(false);
    const discarded = data.status !== 'completed' && discardPartialAssistant();
    completeProcess(data.status === 'completed', doneMessage);
    if (data.status === 'cancelled') {
      if (discarded) appendNotice('任务已取消，未完成的流式回答没有保存。');
      setIdleStatus();
    }
    else setStatus(data.status === 'completed' ? '' : 'error', data.status === 'completed' ? '任务完成' : '任务结束', doneMessage);
    loadConversations();
  });
  source.onerror = () => {
    if (active() && state.busy) setStatus('working', '正在重新连接', '任务仍在服务器运行，正在恢复事件流。');
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function classifyFile(file) {
  const extension = `.${file.name.split('.').pop()?.toLowerCase() || ''}`;
  const imageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const textExtensions = new Set(['.json','.js','.mjs','.ts','.tsx','.jsx','.py','.c','.cc','.cpp','.cu','.h','.hpp','.java','.rs','.sh','.sql','.yaml','.yml','.toml','.xml','.csv','.log','.md','.txt']);
  if (imageTypes.has(file.type)) return { kind: 'image', type: file.type };
  if (file.type === 'application/pdf' || extension === '.pdf') return { kind: 'pdf', type: 'application/pdf' };
  if (file.type.startsWith('text/') || textExtensions.has(extension)) return { kind: 'text', type: file.type || 'text/plain' };
  return null;
}

function attachmentLimits() {
  const configured = state.status?.attachmentLimits || {};
  return {
    count: Number(configured.count) || 8,
    bytesPerAttachment: Number(configured.bytesPerAttachment ?? configured.perFileBytes) || 5 * 1024 * 1024,
    totalBytes: Number(configured.totalBytes) || 15 * 1024 * 1024,
  };
}

async function addAttachments(files) {
  const limits = attachmentLimits();
  if (state.attachments.length + files.length > limits.count) {
    throw new Error(`每次最多添加 ${limits.count} 个附件。`);
  }
  let total = state.attachments.reduce((sum, item) => sum + item.bytes, 0);
  const prepared = [];
  for (const file of files) {
    const classification = classifyFile(file);
    if (!classification) throw new Error(`${file.name} 暂不支持。`);
    if (state.kind === 'qa' && classification.kind !== 'text') {
      throw new Error('知识问答当前仅支持文本附件；图片与 PDF 可在日记、计划或随心记中保存。');
    }
    if (!file.size) throw new Error(`${file.name} 为空文件。`);
    if (file.size > limits.bytesPerAttachment) {
      throw new Error(`${file.name} 超过单文件限制 ${formatBytes(limits.bytesPerAttachment)}。`);
    }
    total += file.size;
    if (total > limits.totalBytes) {
      throw new Error(`附件总大小不能超过 ${formatBytes(limits.totalBytes)}。`);
    }
    prepared.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      name: file.name,
      type: classification.type,
      kind: classification.kind,
      bytes: file.size,
      data: await fileAsBase64(file),
    });
  }
  state.attachments.push(...prepared);
  renderAttachments();
}

function renderAttachments() {
  elements.attachments.replaceChildren();
  elements.attachments.hidden = !state.attachments.length;
  for (const attachment of state.attachments) {
    const row = document.createElement('div');
    row.className = 'knowledge-attachment';
    const name = document.createElement('strong');
    name.textContent = attachment.name;
    const size = document.createElement('small');
    size.textContent = formatBytes(attachment.bytes);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `移除附件“${attachment.name}”`);
    remove.addEventListener('click', () => {
      state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
    });
    row.append(name, size, remove);
    elements.attachments.append(row);
  }
}

function clearAttachments() {
  state.attachments = [];
  elements.attachmentInput.value = '';
  renderAttachments();
}

function searchMessage(text, className = '') {
  const message = document.createElement('p');
  message.className = className;
  message.textContent = text;
  return message;
}

function highlightTerms(terms) {
  const normalized = (Array.isArray(terms) ? terms : [])
    .map((term) => String(term || '').trim())
    .filter(Boolean);
  const variants = normalized.flatMap((term) => {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(term);
    if (!date) return [term];
    const [, year, paddedMonth, paddedDay] = date;
    const month = String(Number(paddedMonth));
    const day = String(Number(paddedDay));
    return [
      term,
      `${year}-${month}-${day}`,
      `${year}/${paddedMonth}/${paddedDay}`,
      `${year}/${month}/${day}`,
      `${year}.${paddedMonth}.${paddedDay}`,
      `${year}.${month}.${day}`,
      `${year}年${paddedMonth}月${paddedDay}日`,
      `${year}年${month}月${day}日`,
    ];
  });
  return [...new Set(variants)]
    .sort((left, right) => right.length - left.length);
}

function foldedDisplayMap(value) {
  let folded = '';
  const starts = [];
  const ends = [];
  let offset = 0;
  for (const symbol of String(value || '')) {
    const start = offset;
    offset += symbol.length;
    const normalized = symbol.normalize('NFKC').toLocaleLowerCase('zh-CN');
    folded += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      starts.push(start);
      ends.push(offset);
    }
  }
  return { folded, starts, ends };
}

function appendHighlightedText(container, value, rawTerms) {
  const text = String(value || '');
  const terms = highlightTerms(rawTerms);
  if (!text || !terms.length) {
    container.append(document.createTextNode(text));
    return;
  }

  const display = foldedDisplayMap(text);
  const foldedTerms = terms
    .map((term) => term.normalize('NFKC').toLocaleLowerCase('zh-CN'))
    .filter(Boolean);
  let foldedCursor = 0;
  let originalCursor = 0;
  while (foldedCursor < display.folded.length) {
    let next = null;
    for (const term of foldedTerms) {
      let index = display.folded.indexOf(term, foldedCursor);
      while (index >= 0) {
        const end = display.ends[index + term.length - 1];
        if (end > originalCursor) break;
        index = display.folded.indexOf(term, index + 1);
      }
      if (index < 0) continue;
      if (!next || index < next.index || (index === next.index && term.length > next.length)) {
        next = { index, length: term.length };
      }
    }
    if (!next) {
      container.append(document.createTextNode(text.slice(originalCursor)));
      break;
    }
    const originalStart = display.starts[next.index] ?? originalCursor;
    const originalEnd = display.ends[next.index + next.length - 1] ?? originalStart;
    if (originalStart > originalCursor) {
      container.append(document.createTextNode(text.slice(originalCursor, originalStart)));
    }
    const mark = document.createElement('mark');
    mark.className = 'knowledge-search-highlight';
    mark.textContent = text.slice(Math.max(originalCursor, originalStart), originalEnd);
    container.append(mark);
    originalCursor = originalEnd;
    foldedCursor = next.index + next.length;
    while (
      foldedCursor < display.folded.length &&
      display.ends[foldedCursor] <= originalCursor
    ) foldedCursor += 1;
  }
  if (!display.folded.length && text) container.append(document.createTextNode(text));
}

function renderSearchResult(result, mode) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'knowledge-search-result';
  button.dataset.searchMode = mode;
  const terms = result.matchedTerms;
  const title = document.createElement('strong');
  appendHighlightedText(title, result.heading || result.name || result.path, terms);
  const file = document.createElement('small');
  appendHighlightedText(file, result.path, terms);
  button.append(title, file);
  if (result.snippet) {
    const snippet = document.createElement('span');
    appendHighlightedText(snippet, result.snippet, terms);
    button.append(snippet);
  }
  button.addEventListener('click', () => openSource(result.path));
  elements.searchResults.append(button);
}

function abortSearch() {
  state.searchController?.abort();
  state.searchController = null;
  state.searchRequestId += 1;
}

function clearSearchResults() {
  abortSearch();
  elements.searchResults.replaceChildren(searchMessage('输入关键词后直接返回候选。'));
  if (elements.clearSearch) elements.clearSearch.disabled = true;
}

function renderSemanticSearchAction(query) {
  const empty = document.createElement('div');
  empty.className = 'knowledge-search-empty';
  empty.append(searchMessage(`未找到包含“${query}”的文件。`));
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'knowledge-semantic-search';
  button.className = 'knowledge-semantic-search kb-action--secondary';
  button.textContent = '尝试语义查找';
  button.addEventListener('click', () => runSearch('semantic', query));
  empty.append(button);
  elements.searchResults.append(empty);
}

async function runSearch(mode = 'keyword', requestedQuery = '') {
  const query = String(requestedQuery || elements.searchInput.value).trim();
  if (!query) {
    clearSearchResults();
    return;
  }

  state.searchController?.abort();
  const requestId = state.searchRequestId + 1;
  state.searchRequestId = requestId;
  const controller = new AbortController();
  state.searchController = controller;
  elements.searchResults.replaceChildren(searchMessage(
    mode === 'semantic' ? '正在查找语义相近的文件……' : '正在严格匹配关键词……',
    'knowledge-search-status',
  ));
  if (elements.clearSearch) elements.clearSearch.disabled = false;

  try {
    const parameters = new URLSearchParams({ q: query, limit: '30', mode });
    const payload = await api(`/api/knowledge/search?${parameters}`, { signal: controller.signal });
    if (requestId !== state.searchRequestId) return;
    if (payload?.route !== mode) {
      const error = new Error('快速检索工作进程版本未更新，请重启知识库工作进程后再试。');
      error.code = 'SEARCH_PROTOCOL_MISMATCH';
      throw error;
    }

    elements.searchResults.replaceChildren();
    const results = Array.isArray(payload.results) ? payload.results : [];
    if (mode === 'semantic') {
      const semanticHeader = document.createElement('div');
      semanticHeader.className = 'knowledge-search-semantic-header';
      const semanticTitle = document.createElement('strong');
      semanticTitle.textContent = '语义推荐';
      semanticHeader.append(
        semanticTitle,
        searchMessage('语义推荐，不代表文件包含原关键词。', 'knowledge-search-semantic-note'),
      );
      elements.searchResults.append(semanticHeader);
      if (!results.length) {
        elements.searchResults.append(searchMessage('没有找到语义相近的文件。'));
        return;
      }
    } else if (!results.length) {
      renderSemanticSearchAction(query);
      return;
    }

    for (const result of results) renderSearchResult(result, mode);
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== state.searchRequestId) return;
    const message = mode === 'semantic' && (error.status === 503 || error.code === 'SEMANTIC_SEARCH_UNAVAILABLE')
      ? '语义查找当前不可用，请稍后再试。'
      : error.message;
    elements.searchResults.replaceChildren(searchMessage(message, 'knowledge-search-error'));
  } finally {
    if (requestId === state.searchRequestId) state.searchController = null;
  }
}

async function openSource(relativePath) {
  if (!relativePath) return;
  const knowledgeBaseId = state.knowledgeBaseId;
  const epoch = state.knowledgeBaseEpoch;
  if (state.sourceObjectUrl) URL.revokeObjectURL(state.sourceObjectUrl);
  state.sourceObjectUrl = '';
  elements.sourceTitle.textContent = relativePath.split('/').pop() || '来源预览';
  elements.sourcePath.textContent = relativePath;
  elements.sourceContent.innerHTML = '<p>正在读取来源……</p>';
  elements.sourceDialog.showModal();
  try {
    const response = await fetch(knowledgeApiPath(
      `/api/knowledge/file?path=${encodeURIComponent(relativePath)}`,
      knowledgeBaseId,
    ), { credentials: 'same-origin' });
    if (state.knowledgeBaseId !== knowledgeBaseId || state.knowledgeBaseEpoch !== epoch) return;
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || '无法读取来源文件。');
    }
    const type = response.headers.get('content-type') || '';
    elements.sourceContent.replaceChildren();
    if (type.startsWith('text/') || type.includes('json')) {
      const text = await response.text();
      if (type.includes('markdown')) renderMarkdown(elements.sourceContent, text, relativePath);
      else {
        const pre = document.createElement('pre');
        pre.textContent = text;
        elements.sourceContent.append(pre);
      }
    } else {
      const blob = await response.blob();
      state.sourceObjectUrl = URL.createObjectURL(blob);
      if (type.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = state.sourceObjectUrl;
        image.alt = relativePath;
        elements.sourceContent.append(image);
      } else if (type === 'application/pdf') {
        const frame = document.createElement('iframe');
        frame.src = state.sourceObjectUrl;
        frame.title = relativePath;
        elements.sourceContent.append(frame);
      } else {
        const link = document.createElement('a');
        link.href = state.sourceObjectUrl;
        link.download = relativePath.split('/').pop();
        link.textContent = '下载这个文件';
        elements.sourceContent.append(link);
      }
    }
  } catch (error) {
    elements.sourceContent.textContent = error.message;
  }
}

function openDraft(draft) {
  state.draft = draft;
  elements.draftTitleField.hidden = draft.kind !== 'scratch';
  elements.draftTitle.value = draft.title || '';
  elements.draftTarget.textContent = draft.targetPath;
  elements.draftContent.value = draft.content || '';
  elements.draftError.textContent = '';
  showDraftView('edit');
  if (!elements.draftDialog.open) elements.draftDialog.showModal();
}

async function loadDraft(id) {
  const knowledgeBaseId = state.knowledgeBaseId;
  const epoch = state.knowledgeBaseEpoch;
  try {
    const draft = await api(`/api/knowledge/drafts/${encodeURIComponent(id)}`);
    if (state.knowledgeBaseId === knowledgeBaseId && state.knowledgeBaseEpoch === epoch) openDraft(draft);
  }
  catch (error) {
    if (state.knowledgeBaseId === knowledgeBaseId && state.knowledgeBaseEpoch === epoch) toast(error.message);
  }
}

function showDraftView(view) {
  document.querySelectorAll('[data-preview]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.preview === view));
  });
  const rendered = view === 'render';
  elements.draftContent.hidden = rendered;
  elements.draftRendered.hidden = !rendered;
  if (rendered) renderMarkdown(elements.draftRendered, elements.draftContent.value);
}

async function saveCurrentDraft() {
  const draft = state.draft;
  if (!draft) return;
  const knowledgeBaseId = state.knowledgeBaseId;
  const epoch = state.knowledgeBaseEpoch;
  const current = () => (
    state.knowledgeBaseId === knowledgeBaseId && state.knowledgeBaseEpoch === epoch
  );
  const title = draft.kind === 'scratch' ? elements.draftTitle.value.trim() : undefined;
  const content = elements.draftContent.value;
  elements.saveDraft.disabled = true;
  elements.draftError.textContent = '';
  try {
    const result = await api(`/api/knowledge/drafts/${encodeURIComponent(draft.id)}/save`, {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    });
    if (!current()) return;
    elements.draftDialog.close();
    appendNotice(`已保存到 ${result.path}`);
    if (result.warnings?.length) {
      appendNotice(`文件已保存，但后台记录出现警告：${result.warnings.join(', ')}`);
      toast('文件已保存，但请检查服务日志。');
    } else {
      toast(`已保存：${result.path}`);
    }
    state.draft = null;
    await loadConversations();
  } catch (error) {
    if (current()) elements.draftError.textContent = error.message;
  } finally {
    if (current()) elements.saveDraft.disabled = false;
  }
}

async function discardCurrentDraft() {
  const draft = state.draft;
  if (!draft || !window.confirm('放弃这份待确认草稿吗？正式知识库文件不会受到影响。')) return;
  const knowledgeBaseId = state.knowledgeBaseId;
  const epoch = state.knowledgeBaseEpoch;
  const current = () => (
    state.knowledgeBaseId === knowledgeBaseId && state.knowledgeBaseEpoch === epoch
  );
  try {
    const result = await api(`/api/knowledge/drafts/${encodeURIComponent(draft.id)}`, { method: 'DELETE' });
    if (!current()) return;
    elements.draftDialog.close();
    state.draft = null;
    if (result.warnings?.length) {
      appendNotice(`草稿已清理，但后台记录出现警告：${result.warnings.join(', ')}`);
      toast('草稿已清理，但请检查服务日志。');
    } else {
      toast('待确认草稿已清理。');
    }
  } catch (error) {
    if (current()) elements.draftError.textContent = error.message;
  }
}

function isTouchDevice() {
  return window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

function setMicButton(label, active = false) {
  elements.mic.replaceChildren();
  const dot = document.createElement('span');
  dot.setAttribute('aria-hidden', 'true');
  dot.textContent = '●';
  elements.mic.append(dot, document.createTextNode(` ${label}`));
  elements.mic.classList.toggle('knowledge-mic-active', active);
}

function growPrompt() {
  elements.prompt.style.height = 'auto';
  const maximum = Math.max(110, Math.min(300, window.innerHeight * 0.28));
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, maximum)}px`;
}

function appendVoiceText(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const current = elements.prompt.value.trimEnd();
  elements.prompt.value = `${current}${current ? '\n' : ''}${clean}`;
  growPrompt();
  elements.prompt.focus({ preventScroll: true });
}

function blobAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('无法读取手机录音。'));
    reader.readAsDataURL(blob);
  });
}

function preferredRecordingType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return types.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

async function transcribeRecording(blob, durationMs) {
  clearFormError();
  state.transcribing = true;
  elements.mic.disabled = true;
  setMicButton('正在转写…');
  setStatus('working', '正在转写口述', '录音仅在服务器临时处理，转写结束后立即删除。');
  try {
    const payload = await api('/api/knowledge/transcribe', {
      method: 'POST',
      body: JSON.stringify({
        type: blob.type || state.mediaRecorder?.mimeType || 'audio/webm',
        data: await blobAsBase64(blob),
        durationMs,
      }),
    });
    appendVoiceText(payload.text);
    clearFormError();
    toast('口述已转成文字，可以继续编辑。');
    setStatus('', '口述已就绪', '口述已填入输入框，确认内容后即可发送。');
  } catch (error) {
    showVoiceError(error.message);
  } finally {
    state.transcribing = false;
    elements.mic.disabled = state.busy;
    setMicButton('开始口述');
  }
}

function finishMediaRecording() {
  window.clearTimeout(state.mediaTimer);
  state.mediaTimer = null;
  state.mediaStream?.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  state.listening = false;
  elements.mic.classList.remove('knowledge-mic-active');
}

async function startMediaRecording() {
  clearFormError();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const type = preferredRecordingType();
    const recorder = new MediaRecorder(stream, {
      ...(type ? { mimeType: type } : {}),
      audioBitsPerSecond: 32_000,
    });
    state.mediaStream = stream;
    state.mediaRecorder = recorder;
    state.mediaChunks = [];
    state.mediaStartedAt = Date.now();
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) state.mediaChunks.push(event.data);
    });
    recorder.addEventListener('stop', async () => {
      const durationMs = Date.now() - state.mediaStartedAt;
      const blob = new Blob(state.mediaChunks, { type: recorder.mimeType || type || 'audio/webm' });
      finishMediaRecording();
      state.mediaChunks = [];
      if (state.loggingOut) return;
      if (blob.size) await transcribeRecording(blob, durationMs);
      else {
        setMicButton('开始口述');
        toast('没有录到声音，请重试。');
      }
    }, { once: true });
    recorder.addEventListener('error', () => {
      finishMediaRecording();
      setMicButton('开始口述');
      toast('手机录音失败，请检查麦克风权限。');
    });
    recorder.start(1000);
    state.listening = true;
    setMicButton('停止并转写', true);
    setStatus('working', '正在听你口述', '再次点击按钮即可停止并转成文字，最长 5 分钟。');
    state.mediaTimer = window.setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, state.status?.speechTranscription?.maxDurationMs || 300_000);
  } catch (error) {
    finishMediaRecording();
    setMicButton('开始口述');
    const denied = ['NotAllowedError', 'SecurityError'].includes(error.name);
    const message = denied
      ? '麦克风权限被拒绝，请在浏览器的网站设置中允许后重试。'
      : `无法启动手机录音：${error.message || error.name}`;
    showVoiceError(message);
  }
}

function setupRecognition(Recognition) {
  const recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.continuous = !isTouchDevice();
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0]?.transcript || '';
      if (event.results[index].isFinal) state.voiceTranscript += text;
      else interim += text;
    }
    const separator = state.voiceBase && !state.voiceBase.endsWith('\n') ? '\n' : '';
    elements.prompt.value = `${state.voiceBase}${separator}${state.voiceTranscript}${interim}`;
    growPrompt();
  };
  recognition.onerror = (event) => {
    state.voiceStopRequested = true;
    const messages = {
      'not-allowed': '麦克风权限被拒绝，请在浏览器的网站设置中允许后重试。',
      'no-speech': '没有听到清晰语音，请靠近麦克风后重试。',
      network: '浏览器语音服务连接失败，请改用手机键盘的麦克风听写。',
    };
    showVoiceError(messages[event.error] || `语音识别失败：${event.error}`);
  };
  recognition.onend = () => {
    if (state.listening && !state.voiceStopRequested && isTouchDevice()) {
      try { recognition.start(); return; } catch { /* finish below */ }
    }
    state.listening = false;
    state.voiceStopRequested = false;
    setMicButton('开始口述');
  };
  state.recognition = recognition;
}

function setupSpeech() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = Boolean(
    state.status?.speechTranscription?.available &&
    navigator.mediaDevices?.getUserMedia &&
    window.MediaRecorder,
  );
  elements.mic.hidden = false;
  elements.voicePrivacy.hidden = false;
  if (canRecord && isTouchDevice()) {
    state.voiceMode = 'recording';
    setMicButton('开始口述');
    return;
  }
  if (Recognition) {
    state.voiceMode = 'recognition';
    setupRecognition(Recognition);
    setMicButton('开始口述');
    return;
  }
  if (canRecord) {
    state.voiceMode = 'recording';
    setMicButton('开始口述');
    return;
  }
  state.voiceMode = 'keyboard';
  setMicButton('键盘听写');
}

function toggleSpeech() {
  if (!state.listening && !state.transcribing) clearFormError();
  if (state.voiceMode === 'recording') {
    if (state.listening && state.mediaRecorder?.state === 'recording') state.mediaRecorder.stop();
    else if (!state.transcribing) startMediaRecording();
    return;
  }
  if (state.voiceMode === 'keyboard') {
    elements.prompt.focus();
    toast('请点击手机键盘上的麦克风图标进行听写。');
    return;
  }
  if (!state.recognition) return;
  if (state.listening) {
    state.voiceStopRequested = true;
    state.recognition.stop();
    return;
  }
  state.voiceBase = elements.prompt.value;
  state.voiceTranscript = '';
  state.voiceStopRequested = false;
  state.listening = true;
  setMicButton('停止口述', true);
  setStatus('working', '正在听你口述', '语音识别由浏览器或平台提供，音频可能交由其云服务处理。');
  try { state.recognition.start(); }
  catch {
    state.listening = false;
    setMicButton('开始口述');
  }
}

async function initialize(options = {}) {
  const initializationEpoch = state.knowledgeBaseEpoch;
  const current = () => initializationEpoch === state.knowledgeBaseEpoch;
  try {
    const session = await api('/api/session');
    if (!current()) return;
    state.session = session;
    if (!session.authenticated) {
      elements.logout.hidden = true;
      if (elements.adminConfig) elements.adminConfig.hidden = true;
      setGate('登录 Second Mind', '请输入你的知识库账号和密码。', { login: true });
      return;
    }
    state.loggingOut = false;
    if (!session.permissions?.useKnowledge) {
      setGate('当前账号无权访问', '此账号没有使用知识库的权限。', { link: true });
      return;
    }
    const bases = await api('/api/knowledge/bases');
    if (!current()) return;
    state.knowledgeBases = Array.isArray(bases.knowledgeBases) ? bases.knowledgeBases : [];
    state.knowledgeBaseId = chooseKnowledgeBase(bases, options.knowledgeBaseId || state.knowledgeBaseId);
    if (!state.knowledgeBaseId) throw new Error('没有可用的知识库。');
    persistKnowledgeBaseSelection();
    renderKnowledgeBaseSelector();
    initializeConversationSelectionStorage();
    clearConversationSelection();
    state.status = await api('/api/knowledge/status');
    if (!current()) return;
    if (
      state.status.knowledgeBaseId
      && state.status.knowledgeBaseId !== state.knowledgeBaseId
    ) throw new Error('知识库选择已变化，请重试。');
    if (state.status.available === false) {
      throw new Error(state.status.message || '知识库服务尚未就绪。');
    }
    applyStatusConfiguration(state.status);
    elements.logout.hidden = false;
    if (elements.adminConfig) {
      elements.adminConfig.hidden = session.permissions?.manageRuntimeConfig !== true;
      elements.adminConfig.href = `./admin-config.html?knowledgeBaseId=${encodeURIComponent(state.knowledgeBaseId)}`;
    }
    elements.taskMode.replaceChildren(...(state.status.taskModes || [
      { id: 'normal', label: '普通', description: '默认任务模式。' },
    ]).map((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = localizedTaskModeLabel(item);
      return option;
    }));
    renderTaskModeOptions();
    elements.taskMode.value = 'normal';
    renderModelCatalog();
    elements.date.value = todayForTimezone();
    elements.gate.hidden = true;
    elements.app.hidden = false;
    if (state.voiceMode === 'none') setupSpeech();
    elements.webSearch.checked = false;
    setKind('qa');
    const conversationsLoaded = await loadConversations();
    if (state.status.activeTask && kindCopy[state.status.activeTask.kind]) {
      setKind(state.status.activeTask.kind);
      elements.taskMode.value = state.status.activeTask.kind === 'qa'
        ? state.status.activeTask.taskMode || 'normal'
        : 'normal';
      updateTaskModeUi();
      if (state.status.activeTask.model) elements.model.value = state.status.activeTask.model;
      updateEffortOptions(state.status.activeTask.requestedEffort || state.status.activeTask.effort);
      elements.webSearch.checked = state.status.activeTask.kind === 'qa'
        && state.status.activeTask.webSearch === true;
      updateWebSearchUi();
      syncCompactSettingLabels();
      try {
        const conversation = await api(
          `/api/knowledge/conversations/${encodeURIComponent(state.status.activeTask.conversationId)}`,
        );
        renderConversationTranscript(conversation, { excludeTrailingAssistant: true });
        selectConversation(conversation);
      } catch {
        resetTranscript();
        const summary = state.conversations.find((item) => item.id === state.status.activeTask.conversationId);
        selectConversation(summary || {
          id: state.status.activeTask.conversationId,
          kind: state.status.activeTask.kind,
          title: '运行中的对话',
        });
      }
      setBusy(true);
      appendNotice('正在恢复运行中的知识库任务。');
      connectTask(state.status.activeTask.id, { startedAt: state.status.activeTask.createdAt });
    } else if (conversationsLoaded) {
      await restoreConversationSelection();
    } else {
      setStatus('error', '历史会话暂未恢复', '本地恢复指针已保留；重试后会继续当前会话。');
    }
  } catch (error) {
    if (!current()) return;
    setGate('知识库暂时不可用', error.message, { retry: true });
  }
}

async function switchKnowledgeBase(id) {
  const selected = state.knowledgeBases.find((entry) => entry.knowledgeBaseId === id);
  if (!selected || !usableKnowledgeBase(selected) || id === state.knowledgeBaseId) {
    renderKnowledgeBaseSelector();
    return;
  }
  state.knowledgeBaseEpoch += 1;
  state.source?.close();
  state.source = null;
  state.taskId = null;
  abortSearch();
  clearProcessTimer();
  state.sourceObjectUrl && URL.revokeObjectURL(state.sourceObjectUrl);
  state.sourceObjectUrl = '';
  if (elements.sourceDialog.open) elements.sourceDialog.close();
  if (elements.draftDialog.open) elements.draftDialog.close();
  state.draft = null;
  elements.saveDraft.disabled = false;
  elements.draftError.textContent = '';
  state.knowledgeBaseId = id;
  persistKnowledgeBaseSelection(id);
  state.selectionStorageKey = '';
  state.conversations = [];
  clearConversationSelection();
  clearAttachments();
  resetTranscript();
  setBusy(false);
  renderConversationList();
  setStatus('working', '正在切换知识库', '正在加载独立索引与会话。');
  await initialize({ knowledgeBaseId: id });
}

async function logout() {
  elements.logout.disabled = true;
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    state.loggingOut = true;
    state.source?.close();
    state.source = null;
    clearProcessTimer();
    state.recognition?.abort?.();
    if (state.mediaRecorder?.state === 'recording') state.mediaRecorder.stop();
    state.mediaStream?.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
    state.session = null;
    state.status = null;
    state.knowledgeBases = [];
    state.knowledgeBaseId = '';
    state.knowledgeBaseEpoch += 1;
    state.taskId = null;
    clearConversationSelection();
    state.selectionStorageKey = '';
    state.conversations = [];
    state.busy = false;
    elements.prompt.value = '';
    clearAttachments();
    resetTranscript();
    renderConversationList();
    elements.draftDialog.open && elements.draftDialog.close();
    elements.sourceDialog.open && elements.sourceDialog.close();
    elements.sidebar.classList.remove('mobile-open');
    elements.sidebarToggle.setAttribute('aria-expanded', 'false');
    elements.logout.hidden = true;
    if (elements.knowledgeBaseField) elements.knowledgeBaseField.hidden = true;
    if (elements.adminConfig) elements.adminConfig.hidden = true;
    elements.loginError.textContent = '';
    setGate('登录 Second Mind', '你已安全退出，请重新输入账号和密码。', { login: true });
  } catch (error) {
    toast(`退出失败：${error.message}`);
  } finally {
    elements.logout.disabled = false;
  }
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.loginError.textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: elements.username.value.trim(), password: elements.password.value }),
    });
    elements.password.value = '';
    await initialize();
  } catch (error) {
    elements.loginError.textContent = error.message;
  }
});

elements.retry.addEventListener('click', initialize);
elements.logout.addEventListener('click', logout);
elements.knowledgeBaseSelect?.addEventListener('change', () => {
  switchKnowledgeBase(elements.knowledgeBaseSelect.value).catch((error) => {
    toast(`切换失败：${error.message}`);
    renderKnowledgeBaseSelector();
  });
});
elements.sidebarToggle.addEventListener('click', () => {
  const expanded = !elements.sidebar.classList.contains('mobile-open');
  elements.sidebar.classList.toggle('mobile-open', expanded);
  elements.sidebarToggle.setAttribute('aria-expanded', String(expanded));
  elements.sidebarToggle.querySelector('[aria-hidden="true"]').textContent = expanded ? '⌃' : '⌄';
});
elements.modes.addEventListener('click', (event) => {
  const button = event.target.closest('[data-kind]');
  if (button) {
    setKind(button.dataset.kind);
    if (window.matchMedia('(max-width: 760px)').matches) {
      elements.sidebar.classList.remove('mobile-open');
      elements.sidebarToggle.setAttribute('aria-expanded', 'false');
      elements.sidebarToggle.querySelector('[aria-hidden="true"]').textContent = '⌄';
    }
  }
});
elements.modes.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...elements.modes.querySelectorAll('[data-kind]:not(:disabled)')];
  if (!tabs.length) return;
  const current = Math.max(0, tabs.indexOf(event.target.closest('[data-kind]')));
  let next = current;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (current - 1 + tabs.length) % tabs.length;
  else next = (current + 1) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  setKind(tabs[next].dataset.kind);
});
elements.newConversation.addEventListener('click', () => {
  if (state.busy) return;
  clearConversationSelection({ persistNew: true });
  resetTranscript();
  setIdleStatus();
  renderConversationList();
  elements.prompt.focus();
});
elements.clearHistory.addEventListener('click', clearCurrentHistory);
elements.searchForm.addEventListener('submit', (event) => { event.preventDefault(); runSearch(); });
elements.clearSearch?.addEventListener('click', clearSearchResults);
elements.attach.addEventListener('click', () => {
  clearFormError();
  elements.attachmentInput.click();
});
elements.attachmentInput.addEventListener('change', async () => {
  try {
    await addAttachments([...elements.attachmentInput.files]);
    clearFormError();
  } catch (error) {
    setFormError(error.message);
  }
  elements.attachmentInput.value = '';
});
elements.prompt.addEventListener('paste', async (event) => {
  const files = filesFromClipboard(event.clipboardData);
  if (!files.length) return;

  event.preventDefault();
  if (state.busy) {
    setFormError('当前任务运行中，请结束后再粘贴附件。', { clearAfterMs: 3600 });
    return;
  }
  try {
    await addAttachments(files);
    clearFormError();
    toast(`已从剪贴板添加 ${files.length} 个附件。`);
  } catch (error) {
    setFormError(error.message);
    toast(error.message);
  }
});
elements.mic.addEventListener('click', toggleSpeech);
elements.prompt.addEventListener('input', () => {
  clearFormError();
  growPrompt();
});
elements.model.addEventListener('change', (event) => {
  const preferredEffort = elements.effort.value;
  updateEffortOptions(preferredEffort, {
    animate: userInitiatedChange(event),
    compact: event.knowledgeChangeOrigin === 'compact',
  });
  syncCompactSettingLabels();
  syncConversationContinuation();
  renderConversationList();
});
elements.effort.addEventListener('change', (event) => {
  syncEffortVisualState({
    animate: userInitiatedChange(event),
    compact: event.knowledgeChangeOrigin === 'compact',
  });
  updateModelDescription();
  syncCompactSettingLabels();
  syncConversationContinuation();
  renderConversationList();
});
elements.taskMode.addEventListener('change', (event) => {
  if (state.kind !== 'qa') elements.taskMode.value = 'normal';
  updateTaskModeUi({
    animate: userInitiatedChange(event),
    compact: event.knowledgeChangeOrigin === 'compact',
  });
  syncCompactSettingLabels();
  syncConversationContinuation();
});
elements.webSearch.addEventListener('change', () => {
  if (!webSearchAvailable() || state.kind !== 'qa') elements.webSearch.checked = false;
  updateWebSearchUi();
  syncConversationContinuation();
  renderConversationList();
});
elements.taskModeOptions?.addEventListener('click', (event) => {
  const option = event.target.closest('[data-task-mode]');
  if (!option || option.disabled || state.busy || state.kind !== 'qa') return;
  if (elements.taskMode.value === option.dataset.taskMode) return;
  elements.taskMode.value = option.dataset.taskMode;
  dispatchUserChange(elements.taskMode, 'segmented');
});
elements.taskModeOptions?.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const options = [...elements.taskModeOptions.querySelectorAll('[data-task-mode]:not(:disabled)')];
  if (!options.length) return;
  const focused = event.target.closest('[data-task-mode]');
  const currentIndex = Math.max(0, options.indexOf(focused));
  let nextIndex = currentIndex;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = options.length - 1;
  else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + options.length) % options.length;
  else nextIndex = (currentIndex + 1) % options.length;
  event.preventDefault();
  const next = options[nextIndex];
  next.focus();
  if (elements.taskMode.value !== next.dataset.taskMode) {
    elements.taskMode.value = next.dataset.taskMode;
    dispatchUserChange(elements.taskMode, 'segmented');
  }
});
window.addEventListener('resize', () => {
  refreshModelOptionLabels();
  syncCompactSettingLabels();
});
elements.compactContext.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.knowledge-compact-setting')) event.preventDefault();
});
elements.compactContext.addEventListener('click', (event) => {
  const button = event.target.closest('[data-compact-setting]');
  if (button) openCompactMenu(button.dataset.compactSetting);
});
elements.compactMenu.addEventListener('pointerdown', (event) => event.preventDefault());
elements.compactMenu.addEventListener('click', (event) => {
  const option = event.target.closest('[data-value]');
  if (option) chooseCompactSetting(elements.compactMenu.dataset.setting, option.dataset.value);
});
elements.form.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.knowledge-composer-context, .knowledge-compact-menu')) closeCompactMenu();
});

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const submittedKnowledgeBaseId = state.knowledgeBaseId;
  const submittedKnowledgeBaseEpoch = state.knowledgeBaseEpoch;
  const prompt = elements.prompt.value.trim();
  if (!prompt) return;
  clearFormError();
  const names = state.attachments.map((attachment) => attachment.name);
  appendMessage('user', `${prompt}${names.length ? `\n\n附件：${names.join('、')}` : ''}`);
  state.assistantNode = null;
  state.assistantText = '';
  startProcess('正在启动知识库助手');
  setBusy(true);
  setStatus('working', '正在启动', '正在连接知识库助手。');
  try {
    syncConversationContinuation();
    const shouldFork = state.kind === 'qa' && state.pendingFork && Boolean(state.conversationId);
    const parentTitle = state.conversationBaseline?.title || prompt;
    const conversationReference = state.kind !== 'qa' || !state.conversationId
      ? {}
      : shouldFork
        ? { forkFromConversationId: state.conversationId }
        : { conversationId: state.conversationId };
    const catalogRevision = modelCatalogRevisionRequest();
    const result = await api('/api/knowledge/tasks', {
      method: 'POST',
      body: JSON.stringify({
        kind: state.kind,
        prompt,
        taskMode: state.kind === 'qa' ? elements.taskMode.value : 'normal',
        date: ['diary', 'plan'].includes(state.kind) ? elements.date.value : undefined,
        model: elements.model.value,
        effort: elements.effort.value,
        webSearch: Boolean(state.kind === 'qa' && webSearchAvailable() && elements.webSearch.checked),
        attachments: state.attachments.map(({ name, type, data }) => ({ name, type, data })),
        ...catalogRevision,
        ...conversationReference,
      }),
    });
    if (
      state.knowledgeBaseId !== submittedKnowledgeBaseId
      || state.knowledgeBaseEpoch !== submittedKnowledgeBaseEpoch
    ) return;
    selectConversation({
      id: result.conversationId,
      kind: state.kind,
      title: shouldFork ? parentTitle : prompt,
      model: elements.model.value,
      actualModel: result.actualModel,
      modelProvider: result.modelProvider,
      modelBindingRevision: result.modelBindingRevision,
      effort: elements.effort.value,
      webSearch: Boolean(state.kind === 'qa' && webSearchAvailable() && elements.webSearch.checked),
      webSearchProvider: result.webSearchProvider,
      webSearchBindingRevision: result.webSearchBindingRevision,
    });
    elements.prompt.value = '';
    clearAttachments();
    connectTask(result.taskId);
    loadConversations();
  } catch (error) {
    if (
      state.knowledgeBaseId !== submittedKnowledgeBaseId
      || state.knowledgeBaseEpoch !== submittedKnowledgeBaseEpoch
    ) return;
    if ([
      'MODEL_CATALOG_CHANGED',
      'INVALID_MODEL_CATALOG_REVISION',
      'CONVERSATION_SETTINGS_CHANGED',
      'FORK_SETTINGS_UNCHANGED',
    ].includes(error.code)) {
      const previousModel = elements.model.value;
      const previousEffort = elements.effort.value;
      try {
        state.status = await api('/api/knowledge/status');
        applyStatusConfiguration(state.status);
        renderModelCatalog(previousModel, previousEffort);
        updateWebSearchUi();
        syncConversationContinuation();
        renderConversationList();
        error.message = error.code === 'MODEL_CATALOG_CHANGED'
          ? '模型目录刚刚更新，已刷新真实模型 ID；请核对设置后重新提交。'
          : error.code === 'INVALID_MODEL_CATALOG_REVISION'
            ? '模型目录校验状态无效，已刷新配置；请核对设置后重新提交。'
            : '会话绑定设置刚刚变化，已刷新配置；页面会按当前状态继续或派生，请重新提交。';
      } catch {
        error.message = '模型目录刚刚更新，但自动刷新失败；请刷新页面后重试。';
      }
    }
    error.message = friendlyModelError(error.code, error.message);
    setBusy(false);
    completeProcess(false, error.message);
    setStatus('error', '任务未启动', error.message);
    setFormError(error.message);
  }
});

async function cancelTask() {
  if (!state.taskId) return;
  try {
    const result = await api(`/api/knowledge/tasks/${encodeURIComponent(state.taskId)}/cancel`, {
      method: 'POST', body: '{}',
    });
    if (result.status === 'completing') toast('回答已经生成，正在完成安全保存。');
  } catch (error) { toast(error.message); }
}
elements.stop.addEventListener('click', cancelTask);
elements.cancel.addEventListener('click', cancelTask);
document.querySelectorAll('[data-preview]').forEach((button) => {
  button.addEventListener('click', () => showDraftView(button.dataset.preview));
});
elements.draftForm.addEventListener('submit', (event) => { event.preventDefault(); saveCurrentDraft(); });
elements.draftClose.addEventListener('click', () => elements.draftDialog.close());
elements.discardDraft.addEventListener('click', discardCurrentDraft);
elements.sourceClose.addEventListener('click', () => elements.sourceDialog.close());
elements.sourceDialog.addEventListener('close', () => {
  if (state.sourceObjectUrl) URL.revokeObjectURL(state.sourceObjectUrl);
  state.sourceObjectUrl = '';
});

const MOBILE_KEYBOARD_MIN_DELTA = 120;
let mobileViewportBaseline = Math.round(window.visualViewport?.height || window.innerHeight);
let keyboardFocusSession = false;

function setKeyboardFocusMode(enabled) {
  const changed = document.body.classList.contains('knowledge-keyboard-open') !== enabled;
  document.body.classList.toggle('knowledge-keyboard-open', enabled);
  if (enabled && changed) scrollTranscript();
  if (!enabled) closeCompactMenu();
}

function syncViewportHeight() {
  const height = Math.round(window.visualViewport?.height || window.innerHeight);
  document.documentElement.style.setProperty('--kb-viewport-height', `${height}px`);

  const mobile = window.matchMedia('(max-width: 760px)').matches;
  const promptFocused = document.activeElement === elements.prompt;
  if (!mobile) {
    mobileViewportBaseline = height;
    keyboardFocusSession = false;
    setKeyboardFocusMode(false);
    return;
  }

  if (!keyboardFocusSession) mobileViewportBaseline = height;
  if (promptFocused) keyboardFocusSession = true;

  const keyboardDelta = mobileViewportBaseline - height;
  const keyboardOpen = keyboardFocusSession && keyboardDelta >= Math.max(
    MOBILE_KEYBOARD_MIN_DELTA,
    Math.round(mobileViewportBaseline * 0.16),
  );
  setKeyboardFocusMode(keyboardOpen);

  if (!keyboardOpen && !promptFocused && height >= mobileViewportBaseline - 60) {
    keyboardFocusSession = false;
    mobileViewportBaseline = height;
  }
}

elements.prompt.addEventListener('focus', () => {
  keyboardFocusSession = true;
  elements.sidebar.classList.remove('mobile-open');
  elements.sidebarToggle.setAttribute('aria-expanded', 'false');
  elements.sidebarToggle.querySelector('[aria-hidden="true"]').textContent = '⌄';
  window.requestAnimationFrame(syncViewportHeight);
});
elements.prompt.addEventListener('blur', () => window.setTimeout(syncViewportHeight, 80));
syncViewportHeight();
window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('scroll', syncViewportHeight);
window.addEventListener('resize', syncViewportHeight);
window.addEventListener('orientationchange', () => {
  keyboardFocusSession = false;
  setKeyboardFocusMode(false);
  window.setTimeout(() => {
    mobileViewportBaseline = Math.round(window.visualViewport?.height || window.innerHeight);
    syncViewportHeight();
  }, 300);
});
window.addEventListener('beforeunload', () => {
  state.searchController?.abort();
  state.source?.close();
  if (state.mediaRecorder?.state === 'recording') state.mediaRecorder.stop();
  state.mediaStream?.getTracks().forEach((track) => track.stop());
});
initialize();
