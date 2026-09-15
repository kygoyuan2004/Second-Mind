import { createPiModelAdapter } from './pi-model-adapter.mjs';
import { llmInternals } from './llm-client.mjs';

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function executionError(message, code, status = 502, options = {}) {
  const error = new Error(message, options);
  error.name = 'PiGenerationError';
  error.code = code;
  error.status = status;
  return error;
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function applicationUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = {
    inputTokens: tokenCount(value.input),
    outputTokens: tokenCount(value.output),
    cacheReadInputTokens: tokenCount(value.cacheRead),
    cacheCreationInputTokens: tokenCount(value.cacheWrite),
    reasoningTokens: tokenCount(value.reasoning),
    totalTokens: tokenCount(value.totalTokens),
  };
  return Object.values(usage).some((item) => item !== null) ? Object.freeze(usage) : null;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { ...ZERO_COST },
  };
}

function textContent(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text || ''))
    .join('');
}

function reasoningContent(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'thinking')
    .map((part) => String(part.thinking || part.text || ''))
    .join('');
}

function terminalRequestError(message, binding) {
  const raw = String(message?.errorMessage || '').trim();
  const status = Number(raw.match(/^([1-5][0-9]{2})(?::|\s)/u)?.[1]) || 0;
  const detail = llmInternals.redactProviderDetail(raw, binding.apiKey);
  const code = status
    ? llmInternals.classifyProviderResponseError(status, detail)
    : 'LLM_REQUEST_FAILED';
  const error = executionError(
    detail ? `Model provider request failed: ${detail}` : 'The Pi model request failed.',
    code,
    status || 502,
  );
  error.stopReason = 'error';
  error.usage = applicationUsage(message?.usage);
  return error;
}

function piMessages(messages, model) {
  const systemPrompt = messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content || ''))
    .filter(Boolean)
    .join('\n\n');
  const conversation = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const content = String(message.content || '');
      if (message.role !== 'assistant') {
        return { role: 'user', content, timestamp: Date.now() };
      }
      const blocks = [];
      if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
        blocks.push({ type: 'thinking', thinking: message.reasoning_content });
      }
      if (content) blocks.push({ type: 'text', text: content });
      return {
        role: 'assistant',
        content: blocks,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: 'stop',
        timestamp: Date.now(),
      };
    })
    .filter((message) => message.content?.length || typeof message.content === 'string');
  return { systemPrompt, messages: conversation, tools: [] };
}

async function reportUsage(options, binding, message, stopReason) {
  if (typeof options.onUsage !== 'function') return;
  const usage = applicationUsage(message?.usage);
  await options.onUsage(Object.freeze({
    type: 'model_usage',
    phase: 'final',
    protocol: binding.protocol,
    stopReason: stopReason || null,
    usageAvailable: Boolean(usage),
    usage,
    cumulativeUsage: usage,
  }));
}

/**
 * Execute exactly one already-planned model call through Pi's provider/model
 * runtime. This deliberately exposes no tools and contains no Agent retry,
 * continuation, compaction, or autonomous turn loop; orchestration remains in
 * Second Mind's existing deterministic pipeline.
 */
export async function generateWithPi(binding, messagesInput, options = {}) {
  const messages = (Array.isArray(messagesInput) ? messagesInput : [])
    .map((message) => ({
      role: ['system', 'assistant'].includes(message?.role) ? message.role : 'user',
      content: String(message?.content || ''),
      ...(typeof message?.reasoning_content === 'string'
        ? { reasoning_content: message.reasoning_content }
        : {}),
    }))
    .filter((message) => message.content || message.reasoning_content);
  if (!messages.length) {
    throw executionError('At least one model message is required.', 'LLM_INPUT_REQUIRED', 400);
  }
  if (options.signal?.aborted) {
    throw options.signal.reason || new DOMException('Aborted', 'AbortError');
  }
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 120_000);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const checkDeadline = () => {
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
    if (timeoutSignal.aborted) throw executionError('The Pi model request exceeded its deadline.', 'LLM_TIMEOUT', 504);
  };
  const adapterFactory = options.adapterFactory || createPiModelAdapter;
  const adapter = await adapterFactory(binding, {
    fetch: binding.fetch,
    signal,
    timeoutMs,
    streamFactory: options.streamFactory,
  });
  const context = piMessages(messages, adapter.model);
  const maximumCharacters = Math.max(
    4_096,
    Math.min(2_000_000, (Number(options.maxOutputTokens) || adapter.model.maxTokens || 4_096) * 8),
  );
  const requestOptions = {
    reasoning: adapter.thinkingLevelFor(options.effort || options.reasoningEffort),
    maxTokens: Math.min(
      Number(options.maxOutputTokens) || adapter.model.maxTokens,
      adapter.model.maxTokens,
    ),
    timeoutMs,
    maxRetries: 0,
    cacheRetention: 'none',
    signal,
  };
  if (Object.hasOwn(options, 'temperature')) requestOptions.temperature = options.temperature;

  let finalMessage = null;
  let stopReason = '';
  let output = '';
  let attemptedToolUse = false;
  const stream = adapter.modelRuntime.streamSimple(adapter.model, context, requestOptions);
  try {
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        const delta = String(event.delta || '');
        if (output.length + delta.length > maximumCharacters) {
          throw executionError(
            'Model output exceeded the configured safety limit.',
            'LLM_OUTPUT_TOO_LARGE',
          );
        }
        output += delta;
        options.onToken?.(delta);
      } else if (event.type === 'done') {
        finalMessage = event.message;
        stopReason = String(event.reason || event.message?.stopReason || '');
      } else if (event.type === 'error') {
        finalMessage = event.error;
        stopReason = String(event.reason || event.error?.stopReason || 'error');
      } else if (String(event.type || '').startsWith('toolcall_')) {
        attemptedToolUse = true;
      }
    }
  } catch (error) {
    checkDeadline();
    if (error?.code) throw error;
    throw executionError('The Pi model request failed.', 'LLM_REQUEST_FAILED', 502, { cause: error });
  }

  // A provider may coalesce text without emitting deltas. Reconcile from the
  // authoritative terminal message without duplicating already-streamed text.
  const terminalText = textContent(finalMessage);
  if (!output && terminalText) {
    output = terminalText;
    options.onToken?.(terminalText);
  }
  await reportUsage(options, binding, finalMessage, stopReason);
  checkDeadline();
  if (attemptedToolUse || stopReason === 'toolUse') {
    throw executionError(
      'A model attempted tool use during a single-generation request.',
      'PI_TOOL_USE_FORBIDDEN',
    );
  }
  if (typeof options.onAssistantMessage === 'function' && finalMessage) {
    const reasoning = reasoningContent(finalMessage);
    await options.onAssistantMessage(Object.freeze({
      role: 'assistant',
      content: output,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    }));
  }
  if (stopReason === 'length') {
    const error = executionError(
      'Model output reached the provider token limit before the answer completed.',
      'LLM_OUTPUT_TRUNCATED',
    );
    error.stopReason = 'length';
    error.usage = applicationUsage(finalMessage?.usage);
    error.outputCharacters = output.length;
    throw error;
  }
  if (
    stopReason === 'error' &&
    /(?:finish_reason|stop_reason)\s*:\s*["']?max_(?:tokens?|output_tokens?)/iu
      .test(String(finalMessage?.errorMessage || ''))
  ) {
    const error = executionError(
      'Model output reached the provider token limit before the answer completed.',
      'LLM_OUTPUT_TRUNCATED',
    );
    error.stopReason = 'length';
    error.usage = applicationUsage(finalMessage?.usage);
    error.outputCharacters = output.length;
    throw error;
  }
  if (stopReason === 'aborted') {
    throw options.signal?.reason || new DOMException('Aborted', 'AbortError');
  }
  if (stopReason === 'error') {
    throw terminalRequestError(finalMessage, binding);
  }
  if (stopReason !== 'stop') {
    const error = executionError(
      'Model provider ended with an unsupported completion state.',
      'LLM_UNSUPPORTED_STOP_REASON',
    );
    error.stopReason = stopReason || null;
    throw error;
  }
  if (!output.trim()) throw executionError('Model returned an empty response.', 'LLM_EMPTY_RESPONSE');
  return output;
}

export const piGenerationInternals = Object.freeze({
  applicationUsage,
  piMessages,
  reasoningContent,
  terminalRequestError,
  textContent,
});
