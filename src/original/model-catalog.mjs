import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CAPABILITY_CACHE = path.resolve(process.env.DATA_DIR || 'data', 'runtime/model-capabilities.json');

const EFFORT_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'default',
    label: '模型默认',
    description: '由当前模型和公司网关选择已支持的思考强度。',
  }),
  Object.freeze({ id: 'low', label: 'Low', description: '最快，使用较少推理资源。' }),
  Object.freeze({ id: 'medium', label: 'Medium', description: '适合日常修改和常规任务。' }),
  Object.freeze({ id: 'high', label: 'High', description: '更充分地分析问题。' }),
  Object.freeze({ id: 'xhigh', label: 'XHigh', description: '适合需要更深推理的复杂任务。' }),
  Object.freeze({ id: 'max', label: 'Max', description: '最深推理，耗时和用量通常最高。' }),
]);

const EFFORT_IDS = new Set(EFFORT_DEFINITIONS.map((item) => item.id));
const EFFORT_BY_ID = new Map(EFFORT_DEFINITIONS.map((item) => [item.id, item]));

export const LEGACY_MODEL_ALIASES = Object.freeze({
  default: 'qwen',
  fable: 'qwen',
  opus: 'qwen',
  sonnet: 'kimi',
  haiku: 'deepseek',
});

const BASE_MODELS = Object.freeze([
  Object.freeze({
    id: 'qwen',
    label: 'Qwen 3.8 Max · 1M',
    shortLabel: 'Qwen 3.8 Max',
    actualModel: 'qwen3.8-max[1M]',
    modalities: Object.freeze(['text', 'image', 'pdf']),
    confirmedEfforts: Object.freeze(['low', 'medium', 'xhigh']),
    defaultEffort: 'xhigh',
    description: '公司百炼网关中的 Qwen 长上下文模型。',
  }),
  Object.freeze({
    id: 'kimi',
    label: 'Kimi K3 · 1M',
    shortLabel: 'Kimi K3',
    actualModel: 'kimi-k3[1M]',
    modalities: Object.freeze(['text']),
    probeEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    description: '通过公司网关调用的 Kimi 长上下文模型。',
  }),
  Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek V4 Pro 0813',
    shortLabel: 'DeepSeek V4 Pro',
    actualModel: 'deepseek-v4-pro-0813',
    modalities: Object.freeze(['text']),
    probeEfforts: Object.freeze(['high', 'max']),
    description: '通过公司网关调用的 DeepSeek Pro 模型。',
  }),
]);

const capabilityCacheByPath = new Map();

function cleanEfforts(value, allowed) {
  if (!Array.isArray(value)) return [];
  const allowedIds = new Set(allowed);
  return [...new Set(value.map((item) => String(item || '').trim().toLowerCase()))]
    .filter((item) => EFFORT_IDS.has(item) && item !== 'default' && allowedIds.has(item));
}

function cachedModelCapabilities(capabilities, model) {
  const models = capabilities?.models && typeof capabilities.models === 'object'
    ? capabilities.models
    : capabilities;
  if (!models || typeof models !== 'object') return null;
  const value = models[model.id] ?? models[model.actualModel];
  return value && typeof value === 'object' ? value : null;
}

export function readModelCapabilityCache(file = process.env.AGENT_MODEL_CAPABILITY_CACHE) {
  const cacheFile = path.resolve(String(file || DEFAULT_CAPABILITY_CACHE));
  if (capabilityCacheByPath.has(cacheFile)) return capabilityCacheByPath.get(cacheFile);
  let value = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (parsed && typeof parsed === 'object') value = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[model-catalog] 无法读取能力缓存 ${cacheFile}：${error.message}`);
    }
  }
  capabilityCacheByPath.set(cacheFile, value);
  return value;
}

export function createModelCatalog(options = {}) {
  const capabilities = options.capabilities ?? readModelCapabilityCache(options.capabilityCacheFile);
  return BASE_MODELS.map((base) => {
    const cached = cachedModelCapabilities(capabilities, base);
    const confirmedEfforts = base.confirmedEfforts
      ? [...base.confirmedEfforts]
      : cleanEfforts(cached?.efforts, base.probeEfforts);
    const efforts = confirmedEfforts.length ? confirmedEfforts : ['default'];
    const preferredDefault = String(cached?.defaultEffort || base.defaultEffort || '').toLowerCase();
    const defaultEffort = efforts.includes(preferredDefault) ? preferredDefault : efforts[0];
    return Object.freeze({
      id: base.id,
      label: base.label,
      shortLabel: base.shortLabel,
      actualModel: base.actualModel,
      value: base.actualModel,
      modalities: [...base.modalities],
      efforts,
      defaultEffort,
      available: cached?.available !== false,
      capabilityVerified: Boolean(base.confirmedEfforts || confirmedEfforts.length),
      description: base.description,
    });
  });
}

export const MODEL_CATALOG = Object.freeze(createModelCatalog());
export const MODEL_EFFORTS = EFFORT_DEFINITIONS;

function normalizedModelKey(value) {
  return String(value || '').trim().toLowerCase();
}

export function findModel(value, catalog = MODEL_CATALOG) {
  const key = normalizedModelKey(value) || 'default';
  const canonicalId = LEGACY_MODEL_ALIASES[key] || key;
  return catalog.find((item) => (
    item.id.toLowerCase() === canonicalId || item.actualModel.toLowerCase() === canonicalId
  )) || null;
}

export class ModelSelectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ModelSelectionError';
    this.status = 400;
    this.code = code;
  }
}

export function resolveModelSelection(modelValue, effortValue, options = {}) {
  const catalog = options.catalog || MODEL_CATALOG;
  const rawModel = normalizedModelKey(modelValue) || 'default';
  const model = findModel(rawModel, catalog);
  if (!model) throw new ModelSelectionError('模型选项不正确。', 'INVALID_MODEL');
  if (!model.available && options.allowUnavailable !== true) {
    throw new ModelSelectionError('这个模型当前不可用。', 'MODEL_UNAVAILABLE');
  }

  const legacyAlias = Object.hasOwn(LEGACY_MODEL_ALIASES, rawModel);
  let effortId = String(effortValue || '').trim().toLowerCase() || model.defaultEffort;
  if (!model.efforts.includes(effortId)) {
    if (legacyAlias || options.allowUnsupportedEffortFallback === true) {
      effortId = model.defaultEffort;
    } else {
      throw new ModelSelectionError(
        `${model.label} 不支持所选思考强度。`,
        'INVALID_EFFORT',
      );
    }
  }

  return {
    model,
    effort: EFFORT_BY_ID.get(effortId),
    legacyAlias: legacyAlias ? rawModel : null,
  };
}

export function normalizeStoredModelSelection(modelValue, effortValue, catalog = MODEL_CATALOG) {
  return resolveModelSelection(modelValue, effortValue, {
    catalog,
    allowUnsupportedEffortFallback: true,
    allowUnavailable: true,
  });
}

export function publicModelCatalog(catalog = MODEL_CATALOG) {
  return catalog.map(({
    id, label, shortLabel, actualModel, modalities, efforts, defaultEffort,
    available, capabilityVerified, description,
  }) => ({
    id,
    label,
    shortLabel,
    actualModel,
    modalities: [...modalities],
    efforts: [...efforts],
    defaultEffort,
    available,
    capabilityVerified,
    description,
  }));
}

export const modelCatalogConstants = Object.freeze({
  DEFAULT_CAPABILITY_CACHE,
  BASE_MODELS,
});
