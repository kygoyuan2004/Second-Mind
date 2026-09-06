const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,99}$/u;
const SENSITIVE_MESSAGE = /(?:https?:\/\/|file:\/\/|(?:^|[\s("'`])(?:(?:\/(?:[^/\s]+\/)*[^/\s]+)|(?:[A-Za-z]:[\\/]))|\bBearer\s+\S{8,}|\bsk-[A-Za-z0-9._-]{8,}|(?:api[-_ ]?key|authorization|credential)\s*[:=]\s*\S+)/iu;

const PROVIDER_MESSAGES = Object.freeze({
  LLM_AUTH_FAILED: 'Model provider authentication failed. Check the API Key in Settings.',
  LLM_PAYMENT_REQUIRED: 'The model provider account has insufficient balance or requires payment.',
  LLM_MODEL_NOT_FOUND: 'The configured model ID does not exist or is unavailable to this account.',
  LLM_ENDPOINT_NOT_FOUND: 'The configured API address does not expose the expected model endpoint.',
  LLM_REQUEST_INCOMPATIBLE: 'The model provider rejected one or more request parameters.',
  LLM_BAD_REQUEST: 'The model provider rejected the request. Check its compatibility and model settings.',
  LLM_RATE_LIMITED: 'The model provider rate limit or quota was exceeded. Try again later.',
  LLM_TIMEOUT: 'The model provider did not respond before the request deadline.',
  LLM_OUTPUT_TRUNCATED: 'Model output reached the provider token limit before the answer completed.',
  LLM_RESPONSE_BLOCKED: 'The model provider blocked or refused the response.',
  LLM_EMPTY_RESPONSE: 'The model provider returned an empty response.',
  PI_TOOL_CALL_REQUIRED: 'The selected model returned text but did not call the required Pi tool.',
  PI_TOOL_RESULT_NOT_OBSERVED: 'The selected model called a tool but did not consume its result.',
  PI_TOOL_ROUND_TRIP_INCOMPLETE: 'The selected model did not complete the required Pi tool round trip.',
  PI_TOOL_PROBE_TIMEOUT: 'The Pi tool capability check timed out.',
  PI_TOOL_PROBE_ABORTED: 'The Pi tool capability check was cancelled.',
  PI_TOOL_PROBE_BINDING_INVALID: 'The selected model configuration cannot be adapted to Pi tool calling.',
  PI_TOOL_PROBE_REQUEST_FAILED: 'The provider failed the Pi tool capability check.',
  PI_AGENT_MODEL_FAILED: 'The Pi model turn failed. Check the model settings and try again.',
  PI_AGENT_OUTPUT_TRUNCATED: 'The Pi answer reached the configured model output limit.',
  PI_AGENT_EMPTY_RESPONSE: 'The Pi model returned no final answer.',
  PI_AGENT_STEP_LIMIT: 'The Pi agent reached the bounded model-turn limit before completing.',
  PI_AGENT_TOOL_LIMIT: 'The Pi agent reached the bounded tool-call limit before completing.',
  PI_AGENT_REQUIRED: 'The selected model cannot use the required Pi Agent tool-calling engine.',
  PI_AGENT_COVERAGE_REQUIRED: 'The Pi agent did not verify reading coverage before completing this exhaustive request.',
  PI_AGENT_INVENTORY_REQUIRED: 'The Pi agent did not obtain the required date inventory for this learning review.',
  PI_SESSION_PERSISTENCE_FAILED: 'The private Pi session could not be persisted.',
  PI_SESSION_PATH_UNSAFE: 'The configured Pi session directory is unsafe.',
  CONVERSATION_WRITE_CONFLICT: 'The conversation changed in another request. Refresh and try again.',
});

export function publicErrorCode(value, fallback = 'SERVER_ERROR') {
  const candidate = String(value?.code || value || '').trim();
  return ERROR_CODE.test(candidate) ? candidate : fallback;
}

function providerMessage(code) {
  if (PROVIDER_MESSAGES[code]) return PROVIDER_MESSAGES[code];
  if (code.startsWith('LLM_') || code.startsWith('MODEL_')) {
    return 'The model provider could not complete this request. Check Settings and try again.';
  }
  if (code.startsWith('PI_')) {
    return 'The Pi agent could not complete this request. Check Settings and try again.';
  }
  if (
    code.startsWith('EMBEDDING_') || code.startsWith('ACTIVE_EMBEDDING_') ||
    code.startsWith('INDEX_REBUILD_')
  ) {
    return 'The embedding provider could not complete this request. Check Settings and try again.';
  }
  if (
    code.startsWith('WEB_SEARCH_') || code.startsWith('WEB_EXTRACT_') ||
    code.startsWith('WEB_READ_') || code.startsWith('TAVILY_') || code.startsWith('BAILIAN_')
  ) {
    return 'The Web Search provider could not complete this request. Check Settings and try again.';
  }
  return '';
}

function boundedMarkedMessage(value, fallback) {
  const message = String(value || '').replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 800);
  if (!message || SENSITIVE_MESSAGE.test(message)) return fallback;
  return message;
}

export function publicError(error, options = {}) {
  const fallbackCode = publicErrorCode(options.fallbackCode, 'SERVER_ERROR');
  const fallbackMessage = String(options.fallbackMessage || 'The server could not complete this request.');
  const code = publicErrorCode(error, fallbackCode);
  const message = error?.publicMessage === true
    ? boundedMarkedMessage(error.message, fallbackMessage)
    : providerMessage(code) || fallbackMessage;
  return Object.freeze({ code, message });
}

export function markPublicMessage(error) {
  Object.defineProperty(error, 'publicMessage', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

export const publicErrorInternals = Object.freeze({
  ERROR_CODE,
  PROVIDER_MESSAGES,
  SENSITIVE_MESSAGE,
  boundedMarkedMessage,
  providerMessage,
});
