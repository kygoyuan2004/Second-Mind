function providerError(message, code = 'LLM_ERROR', cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function endpoint(base, suffix) {
  const clean = String(base || '').replace(/\/+$/, '');
  return clean.endsWith(suffix) ? clean : `${clean}${suffix}`;
}

function isLocalHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === 'host.docker.internal' || value === '::1' ||
    value === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

export function assertSafeProviderUrl(urlInput, allowInsecureHttp = false) {
  let url;
  try {
    url = new URL(urlInput);
  } catch {
    throw providerError('Model provider URL is invalid.', 'LLM_INVALID_ENDPOINT');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw providerError('Model provider URL must use HTTP or HTTPS.', 'LLM_INVALID_ENDPOINT');
  }
  if (url.username || url.password) {
    throw providerError('Model provider credentials must be supplied through an API-key secret, not the URL.', 'LLM_INVALID_ENDPOINT');
  }
  if (url.protocol === 'http:' && !isLocalHostname(url.hostname) && !allowInsecureHttp) {
    throw providerError(
      'Plain HTTP is only allowed for loopback model providers. Set ALLOW_INSECURE_PROVIDER_HTTP=true only on a trusted private network.',
      'LLM_INSECURE_ENDPOINT',
    );
  }
  return url.href;
}

async function readResponseText(response, signal, maxBytes) {
  if (!response.body) return '';
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw providerError('Model provider response exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw providerError('Model provider response exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function responseError(response, apiKey = '', signal) {
  const raw = await readResponseText(response, signal, 64 * 1024).catch((error) => {
    if (error?.code === 'LLM_RESPONSE_TOO_LARGE' || signal?.aborted) throw error;
    return '';
  });
  let message = '';
  try {
    const payload = JSON.parse(raw);
    message = payload?.error?.message || payload?.message || '';
  } catch {}
  let safe = String(message || `HTTP ${response.status}`).replace(/[\r\n]+/g, ' ');
  if (apiKey) safe = safe.split(apiKey).join('[redacted]');
  safe = safe.slice(0, 500);
  return providerError(`Model provider request failed: ${safe}`, 'LLM_API_ERROR');
}

async function readSse(response, onEvent, signal, limits = {}) {
  if (!response.body) throw providerError('Model provider returned no response body.', 'LLM_INVALID_RESPONSE');
  const maxBytes = Number(limits.maxBytes) || 8 * 1024 * 1024;
  const maxBufferCharacters = Number(limits.maxBufferCharacters) || 512 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw providerError('Model provider stream exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      bytes += value?.byteLength || 0;
      if (bytes > maxBytes) {
        throw providerError('Model provider stream exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
      }
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (buffer.length > maxBufferCharacters && !/\r?\n\r?\n/.test(buffer)) {
        throw providerError('Model provider stream event exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
      }
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        const data = block.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') await onEvent(data, block);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: ['system', 'assistant'].includes(message?.role) ? message.role : 'user',
    content: String(message?.content || ''),
  })).filter((message) => message.content);
}

export class ChatModelClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
  }

  publicStatus() {
    return {
      provider: this.config.provider,
      model: this.config.model,
      configured: Boolean(this.config.apiBase && this.config.model),
    };
  }

  async generate(messagesInput, options = {}) {
    const messages = normalizeMessages(messagesInput);
    if (!messages.length) throw providerError('At least one model message is required.', 'LLM_INPUT_REQUIRED');
    if (this.config.provider === 'anthropic') return this.generateAnthropic(messages, options);
    return this.generateOpenAiCompatible(messages, options);
  }

  async request(url, init, options, consume) {
    assertSafeProviderUrl(url, this.config.allowInsecureHttp);
    const controller = new AbortController();
    let timedOut = false;
    const relay = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(providerError('Model request timed out.', 'LLM_TIMEOUT'));
    }, this.config.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal });
      return await consume(response, controller.signal);
    } catch (error) {
      if (timedOut) {
        throw providerError(`Model request exceeded ${Math.round(this.config.timeoutMs / 1000)} seconds.`, 'LLM_TIMEOUT', error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
      if (!controller.signal.aborted) controller.abort();
    }
  }

  async generateOpenAiCompatible(messages, options) {
    const url = endpoint(this.config.apiBase, '/chat/completions');
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return this.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model || this.config.model,
        messages,
        stream: true,
        temperature: options.temperature ?? this.config.temperature,
        max_tokens: options.maxOutputTokens || this.config.maxOutputTokens,
      }),
    }, options, async (response, signal) => {
      if (!response.ok) throw await responseError(response, this.config.apiKey, signal);
      const contentType = response.headers.get('content-type') || '';
      const maximumCharacters = Math.max(
        4_096,
        Math.min(2_000_000, Number(options.maxOutputTokens || this.config.maxOutputTokens) * 8),
      );
      let output = '';
      const push = (text) => {
        if (!text) return;
        if (output.length + text.length > maximumCharacters) {
          throw providerError('Model output exceeded the configured safety limit.', 'LLM_OUTPUT_TOO_LARGE');
        }
        output += text;
        options.onToken?.(text);
      };
      if (contentType.includes('text/event-stream')) {
        await readSse(response, async (data) => {
          let payload;
          try { payload = JSON.parse(data); }
          catch { throw providerError('Model stream contained invalid JSON.', 'LLM_INVALID_RESPONSE'); }
          push(payload?.choices?.[0]?.delta?.content || payload?.choices?.[0]?.text || '');
        }, signal, {
          maxBytes: Math.min(8 * 1024 * 1024, maximumCharacters * 4 + 64 * 1024),
          maxBufferCharacters: Math.min(4 * 1024 * 1024, maximumCharacters * 2 + 64 * 1024),
        });
      } else {
        let payload;
        try {
          payload = JSON.parse(await readResponseText(
            response,
            signal,
            Math.min(8 * 1024 * 1024, maximumCharacters * 4 + 64 * 1024),
          ));
        }
        catch (error) {
          if (signal.aborted) throw signal.reason || error;
          throw providerError('Model provider returned invalid JSON.', 'LLM_INVALID_RESPONSE', error);
        }
        push(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || '');
      }
      if (!output.trim()) throw providerError('Model returned an empty response.', 'LLM_EMPTY_RESPONSE');
      return output;
    });
  }

  async generateAnthropic(messages, options) {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const conversation = messages.filter((message) => message.role !== 'system');
    const url = endpoint(this.config.apiBase, '/v1/messages');
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.config.apiKey) headers['x-api-key'] = this.config.apiKey;
    return this.request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model || this.config.model,
        system,
        messages: conversation,
        stream: true,
        temperature: options.temperature ?? this.config.temperature,
        max_tokens: options.maxOutputTokens || this.config.maxOutputTokens,
      }),
    }, options, async (response, signal) => {
      if (!response.ok) throw await responseError(response, this.config.apiKey, signal);
      const contentType = response.headers.get('content-type') || '';
      const maximumCharacters = Math.max(
        4_096,
        Math.min(2_000_000, Number(options.maxOutputTokens || this.config.maxOutputTokens) * 8),
      );
      let output = '';
      const push = (text) => {
        if (!text) return;
        if (output.length + text.length > maximumCharacters) {
          throw providerError('Model output exceeded the configured safety limit.', 'LLM_OUTPUT_TOO_LARGE');
        }
        output += text;
        options.onToken?.(text);
      };
      if (contentType.includes('text/event-stream')) {
        await readSse(response, async (data) => {
          let payload;
          try { payload = JSON.parse(data); }
          catch { throw providerError('Model stream contained invalid JSON.', 'LLM_INVALID_RESPONSE'); }
          if (payload?.type === 'content_block_delta' && payload?.delta?.type === 'text_delta') {
            push(payload.delta.text || '');
          }
        }, signal, {
          maxBytes: Math.min(8 * 1024 * 1024, maximumCharacters * 4 + 64 * 1024),
          maxBufferCharacters: Math.min(4 * 1024 * 1024, maximumCharacters * 2 + 64 * 1024),
        });
      } else {
        let payload;
        try {
          payload = JSON.parse(await readResponseText(
            response,
            signal,
            Math.min(8 * 1024 * 1024, maximumCharacters * 4 + 64 * 1024),
          ));
        }
        catch (error) {
          if (signal.aborted) throw signal.reason || error;
          throw providerError('Model provider returned invalid JSON.', 'LLM_INVALID_RESPONSE', error);
        }
        for (const block of payload?.content || []) if (block?.type === 'text') push(block.text || '');
      }
      if (!output.trim()) throw providerError('Model returned an empty response.', 'LLM_EMPTY_RESPONSE');
      return output;
    });
  }
}

export const llmInternals = { endpoint, isLocalHostname, normalizeMessages, readResponseText, readSse };
