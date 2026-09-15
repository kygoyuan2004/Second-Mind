import { markPublicMessage } from '../../../src/public-errors.mjs';

const TASK_MODE_DEFINITIONS = Object.freeze({
  normal: Object.freeze({
    id: 'normal',
    label: '普通',
    description: '默认模式，最多 20 次既定模型调用，最长 10 分钟。',
    timeoutMs: 10 * 60_000,
    maxModelCalls: 20,
    maxQueries: 1,
  }),
  deep: Object.freeze({
    id: 'deep',
    label: '深度',
    description: '最多 50 次既定模型调用，最长 30 分钟；执行 2–4 路互补检索与证据核验。',
    timeoutMs: 30 * 60_000,
    maxModelCalls: 50,
    maxQueries: 4,
  }),
});

export const TASK_CONTRACT_VERSION = 2;
export const TASK_BUILD_REVISION = 'knowledge-ui-2.1.7';

const MODEL_CATALOG_REVISION = /^[0-9a-f]{64}$/iu;

export class TaskModeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TaskModeError';
    this.status = 400;
    this.code = code;
    markPublicMessage(this);
  }
}

export function resolveTaskMode(value, options = {}) {
  const id = String(value || 'normal').trim().toLowerCase();
  const mode = TASK_MODE_DEFINITIONS[id];
  if (!mode) throw new TaskModeError('Task mode is invalid.', 'INVALID_TASK_MODE');
  if (mode.id === 'deep' && options.allowDeep === false) {
    throw new TaskModeError('Deep mode is available only for knowledge Q&A when enabled by the server.', 'DEEP_MODE_NOT_ALLOWED');
  }
  return mode;
}

export function publicTaskModes(options = {}) {
  const enabled = options.deepEnabled !== false;
  return Object.values(TASK_MODE_DEFINITIONS)
    .filter((mode) => mode.id !== 'deep' || enabled)
    .map(({ id, label, description, timeoutMs, maxModelCalls }) => ({
      id, label, description, timeoutMs, maxModelCalls,
    }));
}

const ACCEPTED_TASK_FIELDS = new Set([
  'kind', 'prompt', 'taskMode', 'conversationId', 'forkFromConversationId', 'date',
  'attachments', 'webSearch', 'modelCatalogRevision',
  // Clients select only an enabled stable catalog ID and one of that model's
  // declared effort values; the server resolves the immutable runtime binding.
  'model', 'effort',
]);

const RESERVED_POLICY_FIELD = /(?:agent|subagent|tool|systemprompt|developerprompt)/i;

export function rejectClientAgentOptions(body = {}) {
  const prototype = body && typeof body === 'object' && !Array.isArray(body)
    ? Object.getPrototypeOf(body)
    : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TaskModeError('Task request must be a JSON object.', 'INVALID_TASK_REQUEST');
  }
  for (const key of Object.keys(body)) {
    if (!ACCEPTED_TASK_FIELDS.has(key)) {
      const policyField = RESERVED_POLICY_FIELD.test(key);
      throw new TaskModeError(
        policyField
          ? `Agent and tool execution policy is controlled by the server; client field “${key}” is not accepted.`
          : `Task request field “${key}” is not supported.`,
        policyField ? 'CLIENT_AGENT_OPTIONS_DENIED' : 'UNSUPPORTED_TASK_OPTION',
      );
    }
  }
}

export function isModelCatalogRevision(value) {
  return typeof value === 'string' && MODEL_CATALOG_REVISION.test(value);
}

export function optionalModelCatalogRevision(body = {}) {
  if (!Object.hasOwn(body, 'modelCatalogRevision')) return null;
  const value = body.modelCatalogRevision;
  if (!isModelCatalogRevision(value)) {
    throw new TaskModeError(
      'Model catalog revision must be a 64-character hexadecimal string.',
      'INVALID_MODEL_CATALOG_REVISION',
    );
  }
  return value.toLowerCase();
}

export const TASK_MODES = TASK_MODE_DEFINITIONS;
