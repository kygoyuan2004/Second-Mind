const TASK_MODE_DEFINITIONS = Object.freeze({
  normal: Object.freeze({
    id: 'normal',
    label: 'Normal',
    description: 'One bounded hybrid retrieval pass followed by a grounded answer.',
    timeoutMs: 10 * 60_000,
    maxQueries: 1,
  }),
  deep: Object.freeze({
    id: 'deep',
    label: 'Deep',
    description: 'Decompose the question, run multiple hybrid searches, fuse evidence, then generate a cited answer.',
    timeoutMs: 30 * 60_000,
    maxQueries: 4,
  }),
});

export class TaskModeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TaskModeError';
    this.status = 400;
    this.code = code;
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
    .map(({ id, label, description }) => ({ id, label, description }));
}

const ACCEPTED_TASK_FIELDS = new Set([
  'kind', 'prompt', 'taskMode', 'conversationId', 'date', 'attachments',
  // Accepted for compatibility with the browser contract. The server still
  // selects its configured model and effort; clients cannot override policy.
  'model', 'effort',
]);

const RESERVED_POLICY_FIELD = /(?:agent|subagent|tool|systemprompt|developerprompt)/i;

export function rejectClientAgentOptions(body = {}) {
  for (const key of Object.keys(body || {})) {
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

export const TASK_MODES = TASK_MODE_DEFINITIONS;
