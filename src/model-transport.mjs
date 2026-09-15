import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

import { isPublicAddress } from './safe-web-reader.mjs';

function providerError(message, code = 'LLM_ERROR', cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

const MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024;

function isLocalHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === 'host.docker.internal' || value === '::1' ||
    value === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function normalizeDnsAnswers(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.map((entry) => {
    const address = String(entry?.address || '');
    return { address, family: isIP(address) };
  }).filter((entry) => entry.family > 0);
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The model request was cancelled.', 'AbortError');
}

function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function resolvePublicModelTarget(target, lookup, signal) {
  const hostname = target.hostname.startsWith('[') && target.hostname.endsWith(']')
    ? target.hostname.slice(1, -1)
    : target.hostname;
  if (!hostname || isIP(hostname)) {
    throw providerError('Model providers must use a public DNS hostname.', 'LLM_DESTINATION_DENIED');
  }
  let answers;
  try {
    answers = normalizeDnsAnswers(await withAbort(
      lookup(hostname, { all: true, verbatim: true }),
      signal,
    ));
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortReason(signal);
    throw providerError('The model provider hostname could not be resolved.', 'LLM_DNS_FAILED', error);
  }
  if (!answers.length || answers.some((entry) => !isPublicAddress(entry.address))) {
    throw providerError('Model providers must resolve only to public network addresses.', 'LLM_DESTINATION_DENIED');
  }
  return {
    hostname,
    selected: answers.find((entry) => entry.family === 4) || answers[0],
  };
}

function pinnedLookup(selected) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'object' && options ? options : {};
    if (settings.all === true) done(null, [{ address: selected.address, family: selected.family }]);
    else done(null, selected.address, selected.family);
  };
}

function sanitizedTransportHeaders(input, body) {
  const headers = new Headers(input || {});
  for (const name of ['host', 'connection', 'transfer-encoding', 'content-length']) {
    headers.delete(name);
  }
  headers.set('content-length', String(body.byteLength));
  return Object.fromEntries(headers.entries());
}

function responseHeaders(raw = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function requestAsFetch(requestFn, target, requestOptions, body, maxResponseBytes) {
  return new Promise((resolve, reject) => {
    let request;
    let response;
    let promiseSettled = false;
    let responseEnded = false;
    let streamController = null;
    let onAbort = null;
    const signal = requestOptions.signal;
    const cleanup = () => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    };
    const settle = (callback, value) => {
      if (promiseSettled) return;
      promiseSettled = true;
      callback(value);
    };
    try {
      request = requestFn(target, requestOptions, (incoming) => {
        response = incoming;
        const status = Number(incoming.statusCode || 0);
        if (status >= 300 && status < 400) {
          incoming.resume?.();
          incoming.destroy?.();
          cleanup();
          settle(reject, providerError('Model provider redirects are not permitted.', 'LLM_REDIRECT_DENIED'));
          return;
        }
        const declared = Number(incoming.headers?.['content-length']);
        if (Number.isFinite(declared) && declared > maxResponseBytes) {
          incoming.resume?.();
          incoming.destroy?.();
          cleanup();
          settle(reject, providerError('Model provider response exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE'));
          return;
        }
        let bytes = 0;
        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
            incoming.on('data', (chunk) => {
              if (responseEnded) return;
              const buffer = Buffer.from(chunk);
              bytes += buffer.byteLength;
              if (bytes > maxResponseBytes) {
                responseEnded = true;
                const error = providerError('Model provider response exceeded the safety limit.', 'LLM_RESPONSE_TOO_LARGE');
                controller.error(error);
                incoming.destroy?.(error);
                cleanup();
                return;
              }
              controller.enqueue(new Uint8Array(buffer));
            });
            incoming.once('end', () => {
              if (responseEnded) return;
              responseEnded = true;
              cleanup();
              controller.close();
            });
            incoming.once('error', (error) => {
              if (responseEnded) return;
              responseEnded = true;
              cleanup();
              controller.error(providerError(
                'The model provider response failed.',
                'LLM_NETWORK_ERROR',
                error,
              ));
            });
          },
          cancel(reason) {
            responseEnded = true;
            cleanup();
            incoming.destroy?.(reason instanceof Error ? reason : undefined);
          },
        });
        const safeStatus = status >= 200 && status <= 599 ? status : 502;
        const emptyStatus = [204, 205, 304].includes(safeStatus);
        settle(resolve, new Response(emptyStatus ? null : stream, {
          status: safeStatus,
          statusText: String(incoming.statusMessage || '').slice(0, 100),
          headers: responseHeaders(incoming.headers),
        }));
      });
    } catch (error) {
      cleanup();
      settle(reject, providerError('The model provider request could not be created.', 'LLM_NETWORK_ERROR', error));
      return;
    }
    request.once('error', (error) => {
      const safe = providerError(
        'The model provider request failed.',
        error?.name === 'AbortError' ? 'LLM_ABORTED' : 'LLM_NETWORK_ERROR',
        error,
      );
      if (!promiseSettled) {
        cleanup();
        settle(reject, safe);
      } else if (!responseEnded) {
        responseEnded = true;
        cleanup();
        streamController?.error(safe);
      }
    });
    onAbort = () => {
      const reason = abortReason(signal);
      if (!promiseSettled) settle(reject, reason);
      else if (!responseEnded) {
        responseEnded = true;
        streamController?.error(reason);
      }
      cleanup();
      response?.destroy?.(reason);
      request.destroy?.(reason);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    request.end(body);
  });
}

/**
 * Fetch-compatible, POST-only transport for user-managed model endpoints.
 * Public HTTPS requests are resolved on every call, reject mixed/private DNS
 * answers and connect to one validated address while preserving TLS SNI.
 */
export function createPinnedModelFetch(options = {}) {
  const lookup = options.lookup || dns.lookup;
  const httpsRequest = options.httpsRequest || options.request || https.request;
  const httpRequest = options.httpRequest || http.request;
  const allowInsecureHttp = options.allowInsecureHttp === true;
  const maxResponseBytes = Math.min(
    MAX_MODEL_RESPONSE_BYTES,
    Math.max(1_024, Number(options.maxResponseBytes) || MAX_MODEL_RESPONSE_BYTES),
  );
  return async (input, init = {}) => {
    let target;
    try { target = new URL(String(input)); }
    catch { throw providerError('Model provider URL is invalid.', 'LLM_INVALID_ENDPOINT'); }
    if (
      target.username || target.password || target.search || target.hash ||
      !['https:', 'http:'].includes(target.protocol)
    ) {
      throw providerError('Model provider URL must be credential-free and cannot contain a query or fragment.', 'LLM_INVALID_ENDPOINT');
    }
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'POST') throw providerError('The model transport only permits POST requests.', 'LLM_METHOD_DENIED');
    if (init.signal?.aborted) throw abortReason(init.signal);
    const body = Buffer.isBuffer(init.body)
      ? init.body
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : Buffer.from(String(init.body ?? ''), 'utf8');
    if (target.protocol === 'http:') {
      if (!isLocalHostname(target.hostname) && !allowInsecureHttp) {
        throw providerError('Plain HTTP is permitted only for loopback providers or an explicitly enabled trusted private network.', 'LLM_INSECURE_ENDPOINT');
      }
      return requestAsFetch(httpRequest, target, {
        method,
        headers: sanitizedTransportHeaders(init.headers, body),
        signal: init.signal,
        agent: false,
      }, body, maxResponseBytes);
    }
    if (target.port && target.port !== '443') {
      throw providerError('Public model providers must use HTTPS on port 443.', 'LLM_INVALID_ENDPOINT');
    }
    const { hostname, selected } = await resolvePublicModelTarget(target, lookup, init.signal);
    if (init.signal?.aborted) throw abortReason(init.signal);
    return requestAsFetch(httpsRequest, target, {
      method,
      headers: sanitizedTransportHeaders(init.headers, body),
      signal: init.signal,
      agent: false,
      family: selected.family,
      lookup: pinnedLookup(selected),
      servername: hostname,
      rejectUnauthorized: true,
    }, body, maxResponseBytes);
  };
}

export const modelTransportInternals = { abortReason, resolvePublicModelTarget };
