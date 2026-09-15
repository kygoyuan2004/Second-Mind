export const TASK_MODES = Object.freeze({
  normal: Object.freeze({
    id: 'normal',
    label: '普通',
    maxTurns: 20,
    timeoutMs: 10 * 60_000,
    maxSubagents: 0,
    description: '默认模式，最多 20 轮，最长 10 分钟，不创建子 Agent。',
  }),
  deep: Object.freeze({
    id: 'deep',
    label: '深度',
    maxTurns: 50,
    timeoutMs: 30 * 60_000,
    maxSubagents: 2,
    description: '最多 50 轮，最长 30 分钟，按条件最多使用两个只读子 Agent。',
  }),
});

const RESERVED_SUBAGENT_FIELDS = Object.freeze([
  'agent', 'agents', 'subagent', 'subAgent', 'subagents', 'subAgents',
  'maxAgents', 'maxSubagents', 'maxSubAgents', 'agentDefinitions',
]);

export class TaskModeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TaskModeError';
    this.status = 400;
    this.code = code;
  }
}

export function rejectClientSubagentFields(body = {}) {
  const visit = (value, trail = [], depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return null;
    for (const [key, child] of Object.entries(value)) {
      if (RESERVED_SUBAGENT_FIELDS.includes(key)) return [...trail, key].join('.');
      const nested = visit(child, [...trail, key], depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  const field = visit(body);
  if (field) {
    throw new TaskModeError(
      `子 Agent 配置只能由服务端生成，不接受客户端参数：${field}。`,
      'CLIENT_SUBAGENT_OPTIONS_DENIED',
    );
  }
}

export function resolveTaskMode(value, options = {}) {
  const id = String(value || 'normal').trim().toLowerCase();
  const mode = TASK_MODES[id];
  if (!mode) throw new TaskModeError('任务模式不正确。', 'INVALID_TASK_MODE');
  if (mode.id === 'deep' && options.allowDeep === false) {
    throw new TaskModeError('当前功能固定使用普通任务模式。', 'DEEP_MODE_NOT_ALLOWED');
  }
  return mode;
}

export function publicTaskModes() {
  return Object.values(TASK_MODES).map(({ id, label, maxTurns, timeoutMs, maxSubagents, description }) => ({
    id,
    label,
    maxTurns,
    timeoutMs,
    maxSubagents,
    description,
  }));
}

export function deploymentFeatureEnabled(name, developmentDefault = true) {
  const value = process.env[name];
  if (value === undefined) return developmentDefault && process.env.NODE_ENV !== 'production';
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

export class UserTaskRegistry {
  constructor() {
    this.active = new Map();
  }

  claim(userId, taskId, surface) {
    const key = String(userId);
    const current = this.active.get(key);
    if (current && current.taskId !== taskId) {
      const error = new Error('当前已有 AI 任务运行，请先等待或取消。');
      error.status = 409;
      error.code = 'USER_TASK_BUSY';
      throw error;
    }
    this.active.set(key, { taskId, surface, claimedAt: new Date().toISOString() });
    return this.active.get(key);
  }

  release(userId, taskId) {
    const key = String(userId);
    const current = this.active.get(key);
    if (!current || current.taskId !== taskId) return false;
    this.active.delete(key);
    return true;
  }

  get(userId) {
    return this.active.get(String(userId)) || null;
  }
}

export const taskModeConstants = Object.freeze({ RESERVED_SUBAGENT_FIELDS });
