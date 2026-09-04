import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from 'node:zlib';

const DEFAULT_PAGE_TIMEOUT_MS = 15_000;
const DEFAULT_BATCH_TIMEOUT_MS = 40_000;
const DEFAULT_HTML_BYTES = 2 * 1024 * 1024;
const DEFAULT_PDF_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_CHARS = 16_000;
const DEFAULT_TOTAL_CHARS = 40_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_REDIRECTS = 3;
const MIN_USEFUL_TEXT_CHARS = 80;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const SOURCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/u;
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'ac.jp', 'ac.nz', 'ac.uk', 'co.jp', 'co.kr', 'co.nz', 'co.uk',
  'com.au', 'com.br', 'com.cn', 'com.hk', 'com.sg', 'com.tw',
  'edu.au', 'edu.cn', 'edu.hk', 'edu.sg', 'edu.tw', 'go.jp', 'go.kr',
  'gov.au', 'gov.cn', 'gov.hk', 'gov.sg', 'gov.tw', 'govt.nz',
  'net.au', 'net.cn', 'net.hk', 'net.nz', 'net.sg', 'net.tw', 'net.uk',
  'org.au', 'org.cn', 'org.hk', 'org.nz', 'org.sg', 'org.tw', 'org.uk',
  'blogspot.com', 'github.io', 'netlify.app', 'pages.dev', 'vercel.app',
]);
const METADATA_IPV4 = new Set([
  '100.100.100.200', // Alibaba Cloud
  '168.63.129.16', // Azure platform virtual IP
  '169.254.169.254', // AWS/GCP/OpenStack and others
]);
const IPV4_DENY_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const IPV6_DENY_CIDRS = [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

export class SafeWebReaderError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'SafeWebReaderError';
    this.code = code;
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function compactText(value, maximum = 1_000) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > maximum ? text.slice(0, maximum) : text;
}

function urlHash(url) {
  return createHash('sha256').update(url, 'utf8').digest('hex');
}

function abortError(signal, message = 'Web page reading was cancelled.') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function timeoutError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ETIMEDOUT';
  return error;
}

function deadlineSignal(parentSignal, timeoutMs, message) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortError(parentSignal));
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError(message)), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
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

function parseIpv4(address) {
  if (net.isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return octets.reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function parseIpv6(address) {
  if (net.isIP(address) !== 6) return null;
  const zoneIndex = address.indexOf('%');
  const unzoned = zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;
  let normalized = unzoned.toLowerCase();
  const lastColon = normalized.lastIndexOf(':');
  const ipv4Tail = normalized.slice(lastColon + 1);
  if (ipv4Tail.includes('.')) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (halves.length === 1 && omitted !== 0)) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(omitted).fill('0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
    return null;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function ipv4InCidr(address, base, prefix) {
  const value = parseIpv4(address);
  const network = parseIpv4(base);
  if (value === null || network === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6InCidr(address, base, prefix) {
  const value = parseIpv6(address);
  const network = parseIpv6(base);
  if (value === null || network === null) return false;
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (network >> shift);
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    if (METADATA_IPV4.has(address)) return false;
    return !IPV4_DENY_CIDRS.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
  }
  if (family === 6) {
    return !IPV6_DENY_CIDRS.some(([base, prefix]) => ipv6InCidr(address, base, prefix));
  }
  return false;
}

export function normalizeSafeHttpsUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    throw new SafeWebReaderError('The source URL is invalid.', 'WEB_READ_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    (parsed.port && parsed.port !== '443')
  ) {
    throw new SafeWebReaderError(
      'Only credential-free HTTPS URLs on port 443 may be read.',
      'WEB_READ_URL_NOT_ALLOWED',
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const unwrappedHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (
    !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || net.isIP(unwrappedHostname)
  ) {
    throw new SafeWebReaderError(
      'IP literals and local hostnames may not be read.',
      'WEB_READ_HOST_NOT_ALLOWED',
    );
  }
  parsed.hostname = hostname;
  parsed.hash = '';
  return parsed;
}

export function registrableDomain(hostname) {
  const labels = String(hostname || '').toLowerCase().replace(/\.$/u, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const suffix = labels.slice(-2).join('.');
  return labels.slice(MULTI_LABEL_PUBLIC_SUFFIXES.has(suffix) ? -3 : -2).join('.');
}

function redirectHostAllowed(initialHostname, nextHostname) {
  const initial = String(initialHostname || '').toLowerCase();
  const next = String(nextHostname || '').toLowerCase();
  if (initial === next) return true;
  // A hand-maintained public-suffix list is not a safe authorization boundary.
  // Permit only the conventional www alias; every other hostname change fails
  // closed even when both names appear to share an eTLD+1.
  return initial.replace(/^www\./u, '') === next.replace(/^www\./u, '') &&
    (initial.startsWith('www.') || next.startsWith('www.'));
}

function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value ?? '');
}

function decodeBody(buffer, encoding, maximum) {
  const normalized = String(encoding || 'identity').toLowerCase().trim();
  if (!normalized || normalized === 'identity') return buffer;
  const options = { maxOutputLength: maximum + 1 };
  if (normalized === 'gzip' || normalized === 'x-gzip') return gunzipSync(buffer, options);
  if (normalized === 'deflate') return inflateSync(buffer, options);
  if (normalized === 'br') return brotliDecompressSync(buffer, options);
  throw new SafeWebReaderError(
    'The page used an unsupported content encoding.',
    'WEB_READ_CONTENT_ENCODING_UNSUPPORTED',
  );
}

export function decodeBoundedBody(buffer, encoding, maximum) {
  const limit = boundedInteger(maximum, DEFAULT_HTML_BYTES, 1, DEFAULT_PDF_BYTES);
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (input.length > limit) {
    throw new SafeWebReaderError(
      'The compressed response exceeded its byte limit.',
      'WEB_READ_BODY_TOO_LARGE',
    );
  }
  try {
    const output = decodeBody(input, encoding, limit);
    if (output.length > limit) {
      throw new SafeWebReaderError(
        'The decompressed page exceeded its byte limit.',
        'WEB_READ_BODY_TOO_LARGE',
      );
    }
    return output;
  } catch (cause) {
    if (cause instanceof SafeWebReaderError) throw cause;
    throw new SafeWebReaderError(
      'The compressed page could not be decoded within its limit.',
      'WEB_READ_BODY_TOO_LARGE',
      { cause },
    );
  }
}

async function defaultTransport({
  url,
  address,
  family,
  signal,
  timeoutMs,
  bodyLimit,
  requestImpl = https.request,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = requestImpl(url, {
      method: 'GET',
      signal,
      agent: false,
      servername: url.hostname,
      rejectUnauthorized: true,
      headers: {
        Accept: 'text/html, application/xhtml+xml, text/plain, application/pdf;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'SecondMind-SafeReader/0.1',
      },
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      const headers = response.headers || {};
      if (REDIRECT_CODES.has(statusCode)) {
        finish(resolve, { statusCode, headers, body: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        finish(resolve, { statusCode, headers, body: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      let maximum;
      try {
        maximum = bodyLimit(headers);
      } catch (error) {
        finish(reject, error);
        response.destroy();
        return;
      }
      const declaredLength = Number(headerValue(headers, 'content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maximum) {
        finish(reject, new SafeWebReaderError(
          'The page exceeded its byte limit.',
          'WEB_READ_BODY_TOO_LARGE',
        ));
        response.destroy();
        return;
      }
      const chunks = [];
      let compressedBytes = 0;
      response.on('data', (chunk) => {
        compressedBytes += chunk.length;
        if (compressedBytes > maximum) {
          response.destroy(new SafeWebReaderError(
            'The compressed response exceeded its byte limit.',
            'WEB_READ_BODY_TOO_LARGE',
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = decodeBoundedBody(
            Buffer.concat(chunks, compressedBytes),
            headerValue(headers, 'content-encoding'),
            maximum,
          );
          if (body.length > maximum) {
            throw new SafeWebReaderError(
              'The decompressed page exceeded its byte limit.',
              'WEB_READ_BODY_TOO_LARGE',
            );
          }
          finish(resolve, { statusCode, headers, body });
        } catch (error) {
          finish(reject, error);
        }
      });
      response.on('aborted', () => finish(reject, new SafeWebReaderError(
        'The page response ended before completion.',
        'WEB_READ_RESPONSE_ABORTED',
      )));
      response.on('error', (error) => finish(reject, error));
    });
    request.setTimeout(timeoutMs, () => request.destroy(timeoutError('The page request timed out.')));
    request.on('error', (error) => finish(reject, error));
    request.end();
  });
}

async function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

async function defaultRunProcess(argv, { input, signal, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      cwd: '/',
      env: {
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PATH: '/usr/bin:/bin',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let storedStdoutBytes = 0;
    let stderrBytes = 0;
    let storedStderrBytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => child.kill('SIGKILL');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      const remaining = Math.max(0, maxOutputBytes - storedStdoutBytes);
      if (remaining) {
        const kept = chunk.subarray(0, remaining);
        stdout.push(kept);
        storedStdoutBytes += kept.length;
      }
      if (stdoutBytes > maxOutputBytes) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      const remaining = Math.max(0, 8_192 - storedStderrBytes);
      if (remaining) {
        const kept = chunk.subarray(0, remaining);
        stderr.push(kept);
        storedStderrBytes += kept.length;
      }
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (exitCode, childSignal) => {
      finish(resolve, {
        exitCode,
        signal: childSignal,
        stdout: Buffer.concat(stdout, storedStdoutBytes),
        stderr: Buffer.concat(stderr, storedStderrBytes),
        outputTooLarge: stdoutBytes > maxOutputBytes,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function executable(pathname) {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fixedPdfArgv(bwrapPath, pdftotextPath) {
  const argv = [
    bwrapPath,
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/usr', '/usr',
  ];
  for (const libraryPath of ['/lib', '/lib64']) {
    if (fs.existsSync(libraryPath)) argv.push('--ro-bind', libraryPath, libraryPath);
  }
  argv.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--chdir', '/tmp',
    '--', pdftotextPath, '-', '-',
  );
  return Object.freeze(argv);
}

function decodeEntities(text) {
  const named = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff) return ' ';
      try { return String.fromCodePoint(code); } catch { return ' '; }
    }
    return named[entity.toLowerCase()] ?? ' ';
  });
}

function htmlSection(html) {
  for (const tag of ['article', 'main', 'body']) {
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'iu').exec(html);
    if (match?.[1]) return match[1];
  }
  return html;
}

export function extractReadableText(html, maximum = DEFAULT_PAGE_CHARS) {
  const withoutDangerousBlocks = String(html || '')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed|form|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed|form)\b[^>]*>[\s\S]*$/giu, ' ');
  const section = htmlSection(withoutDangerousBlocks)
    .replace(/<(br|hr)\b[^>]*>/giu, '\n')
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|blockquote)\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  return decodeEntities(section)
    .replace(/\r/gu, '')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/\n\s*\n+/gu, '\n')
    .trim()
    .slice(0, maximum);
}

function extractPlainText(buffer, maximum) {
  return buffer.toString('utf8')
    .replace(/\u0000/gu, '')
    .replace(/\r/gu, '')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/\n\s*\n+/gu, '\n')
    .trim()
    .slice(0, maximum);
}

function mediaType(headers) {
  return headerValue(headers, 'content-type').split(';', 1)[0].trim().toLowerCase();
}

function isHtmlType(type) {
  return type === 'text/html' || type === 'application/xhtml+xml';
}

function isTextType(type) {
  return type === 'text/plain' || type === 'text/markdown' || type === 'text/x-markdown';
}

function normalizeDnsAnswers(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((answer) => {
    if (typeof answer === 'string') return { address: answer, family: net.isIP(answer) };
    return { address: String(answer?.address || ''), family: Number(answer?.family) };
  }).filter((answer) => answer.address && (answer.family === 4 || answer.family === 6));
}

function normalizedSourceMap(sources) {
  const output = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = compactText(source?.id || source?.sourceId, 100);
    if (!SOURCE_ID_PATTERN.test(id) || output.has(id)) continue;
    try {
      const parsed = normalizeSafeHttpsUrl(source?.url);
      output.set(id, {
        id,
        url: parsed.href,
        title: compactText(source?.title, 300),
        publishedAt: compactText(source?.publishedAt, 100),
      });
    } catch {
      // Invalid candidates never enter the allowlist.
    }
  }
  return output;
}

function requestedSources(sources, sourceIds, maximum) {
  const allowlist = normalizedSourceMap(sources);
  const requested = [];
  const errors = [];
  const seenIds = new Set();
  const selectedUrls = new Set();
  for (const rawId of Array.isArray(sourceIds) ? sourceIds : []) {
    const id = compactText(rawId, 100);
    if (!SOURCE_ID_PATTERN.test(id) || seenIds.has(id)) continue;
    seenIds.add(id);
    const source = allowlist.get(id);
    if (!source) {
      errors.push({
        sourceId: id || null,
        code: 'WEB_READ_SOURCE_NOT_ALLOWED',
        message: 'The requested source ID was not in the current allowlist.',
      });
      continue;
    }
    if (!selectedUrls.has(source.url) && selectedUrls.size >= maximum) continue;
    requested.push(source);
    selectedUrls.add(source.url);
  }
  return { requested, errors };
}

async function emitActivity(callback, event) {
  if (typeof callback !== 'function') return;
  try { await callback(Object.freeze({ ...event })); } catch {
    // Observability must never alter reading behavior.
  }
}

function safeFailure(error, sourceId) {
  const aborted = error?.name === 'AbortError';
  const rawCode = compactText(
    error?.code || (aborted ? 'WEB_READ_ABORTED' : 'WEB_READ_FAILED'),
    80,
  );
  const code = /^[A-Z][A-Z0-9_]{0,79}$/u.test(rawCode) ? rawCode : 'WEB_READ_FAILED';
  const messages = {
    WEB_READ_ABORTED: 'Web page reading was cancelled.',
    ETIMEDOUT: 'Web page reading timed out.',
  };
  return {
    sourceId,
    code: messages[code] ? (code === 'ETIMEDOUT' ? 'WEB_READ_TIMEOUT' : code) : code,
    message: messages[code] || 'Web page reading failed.',
  };
}

export class SafeWebReader {
  constructor(config = {}, options = {}) {
    this.provider = compactText(config.provider || 'server-safe-reader', 100);
    this.enabled = config.enabled === true;
    this.pageTimeoutMs = boundedInteger(
      config.pageTimeoutMs,
      DEFAULT_PAGE_TIMEOUT_MS,
      100,
      120_000,
    );
    this.batchTimeoutMs = boundedInteger(
      config.batchTimeoutMs,
      DEFAULT_BATCH_TIMEOUT_MS,
      100,
      300_000,
    );
    this.htmlMaxBytes = boundedInteger(
      config.htmlMaxBytes,
      DEFAULT_HTML_BYTES,
      1_024,
      DEFAULT_HTML_BYTES,
    );
    this.pdfMaxBytes = boundedInteger(
      config.pdfMaxBytes,
      DEFAULT_PDF_BYTES,
      1_024,
      DEFAULT_PDF_BYTES,
    );
    this.pageMaxChars = boundedInteger(
      config.pageMaxChars,
      DEFAULT_PAGE_CHARS,
      100,
      DEFAULT_PAGE_CHARS,
    );
    this.totalMaxChars = boundedInteger(
      config.totalMaxChars,
      DEFAULT_TOTAL_CHARS,
      100,
      DEFAULT_TOTAL_CHARS,
    );
    this.concurrency = boundedInteger(
      config.concurrency,
      DEFAULT_CONCURRENCY,
      1,
      DEFAULT_CONCURRENCY,
    );
    this.maxPagesPerBatch = boundedInteger(
      config.maxPagesPerBatch,
      DEFAULT_MAX_PAGES,
      1,
      DEFAULT_MAX_PAGES,
    );
    this.maxRedirects = boundedInteger(
      config.maxRedirects,
      DEFAULT_MAX_REDIRECTS,
      0,
      DEFAULT_MAX_REDIRECTS,
    );
    this.lookup = options.lookup || defaultLookup;
    this.transport = options.transport || (options.httpsRequest
      ? (request) => defaultTransport({ ...request, requestImpl: options.httpsRequest })
      : defaultTransport);
    this.runProcess = options.runProcess || defaultRunProcess;
    this.bwrapPath = '/usr/bin/bwrap';
    this.pdftotextPath = '/usr/bin/pdftotext';
    this.pdfEnabled = config.pdfEnabled === true;
    this.pdfAvailable = options.pdfAvailable ?? (
      this.pdfEnabled && executable(this.bwrapPath) && executable(this.pdftotextPath)
    );
    this.pdfArgv = fixedPdfArgv(this.bwrapPath, this.pdftotextPath);
  }

  publicStatus() {
    return {
      enabled: this.enabled,
      configured: this.enabled,
      provider: this.provider,
      pdfAvailable: this.pdfAvailable,
    };
  }

  async resolvePublicHost(hostname, signal) {
    let answers;
    try {
      answers = normalizeDnsAnswers(await abortable(this.lookup(hostname), signal));
    } catch (cause) {
      if (signal?.aborted) throw abortError(signal);
      throw new SafeWebReaderError(
        'The page hostname could not be resolved.',
        'WEB_READ_DNS_FAILED',
        { cause },
      );
    }
    if (!answers.length) {
      throw new SafeWebReaderError(
        'The page hostname did not resolve to an address.',
        'WEB_READ_DNS_EMPTY',
      );
    }
    if (answers.some((answer) => !isPublicAddress(answer.address))) {
      throw new SafeWebReaderError(
        'The page hostname resolved to a prohibited address.',
        'WEB_READ_ADDRESS_NOT_ALLOWED',
      );
    }
    return answers;
  }

  bodyLimit(headers) {
    const type = mediaType(headers);
    if (type === 'application/pdf') return this.pdfMaxBytes;
    if (isHtmlType(type) || isTextType(type)) return this.htmlMaxBytes;
    throw new SafeWebReaderError(
      'The page content type is not supported.',
      'WEB_READ_CONTENT_TYPE_UNSUPPORTED',
    );
  }

  async extractPdf(body, signal) {
    if (!this.pdfAvailable) {
      throw new SafeWebReaderError(
        'Sandboxed PDF extraction is unavailable.',
        'WEB_READ_PDF_UNAVAILABLE',
      );
    }
    const result = await abortable(this.runProcess(this.pdfArgv, {
      input: body,
      signal,
      timeoutMs: this.pageTimeoutMs,
      maxOutputBytes: this.pageMaxChars * 4,
    }), signal);
    if (result?.outputTooLarge) {
      throw new SafeWebReaderError(
        'PDF text exceeded its output limit.',
        'WEB_READ_PDF_TEXT_TOO_LARGE',
      );
    }
    if (result?.exitCode !== 0) {
      throw new SafeWebReaderError(
        'Sandboxed PDF extraction failed.',
        'WEB_READ_PDF_EXTRACTION_FAILED',
      );
    }
    return extractPlainText(Buffer.from(result.stdout || ''), this.pageMaxChars);
  }

  async readSource(source, signal) {
    const startedAt = Date.now();
    const firstUrl = normalizeSafeHttpsUrl(source.url);
    let currentUrl = firstUrl;
    let redirects = 0;
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const answers = await this.resolvePublicHost(currentUrl.hostname, signal);
      const selected = answers[0];
      const response = await abortable(this.transport({
        url: currentUrl,
        address: selected.address,
        family: selected.family,
        signal,
        timeoutMs: this.pageTimeoutMs,
        bodyLimit: (headers) => this.bodyLimit(headers),
      }), signal);
      const statusCode = Number(response?.statusCode || 0);
      if (REDIRECT_CODES.has(statusCode)) {
        if (redirects >= this.maxRedirects) {
          throw new SafeWebReaderError(
            'The page exceeded the redirect limit.',
            'WEB_READ_REDIRECT_LIMIT',
          );
        }
        const location = headerValue(response?.headers, 'location');
        if (!location) {
          throw new SafeWebReaderError(
            'The page returned a redirect without a location.',
            'WEB_READ_REDIRECT_INVALID',
          );
        }
        let nextUrl;
        try {
          nextUrl = normalizeSafeHttpsUrl(new URL(location, currentUrl).href);
        } catch (cause) {
          if (cause instanceof SafeWebReaderError) throw cause;
          throw new SafeWebReaderError(
            'The redirect URL was invalid.',
            'WEB_READ_REDIRECT_INVALID',
            { cause },
          );
        }
        if (!redirectHostAllowed(firstUrl.hostname, nextUrl.hostname)) {
          throw new SafeWebReaderError(
            'The page redirected outside its exact hostname or conventional www alias.',
            'WEB_READ_REDIRECT_DOMAIN_NOT_ALLOWED',
          );
        }
        currentUrl = nextUrl;
        redirects += 1;
        continue;
      }
      if (statusCode < 200 || statusCode >= 300) {
        throw new SafeWebReaderError(
          'The page returned a non-success HTTP status.',
          'WEB_READ_HTTP_STATUS',
        );
      }
      const type = mediaType(response?.headers);
      const maximum = this.bodyLimit(response?.headers);
      const body = Buffer.isBuffer(response?.body)
        ? response.body
        : Buffer.from(response?.body || '');
      if (body.length > maximum) {
        throw new SafeWebReaderError(
          'The page exceeded its byte limit.',
          'WEB_READ_BODY_TOO_LARGE',
        );
      }
      let text;
      if (type === 'application/pdf') text = await this.extractPdf(body, signal);
      else if (isHtmlType(type)) text = extractReadableText(body.toString('utf8'), this.pageMaxChars);
      else text = extractPlainText(body, this.pageMaxChars);
      if (text.length < MIN_USEFUL_TEXT_CHARS) {
        throw new SafeWebReaderError(
          'The page did not contain enough readable text.',
          'WEB_READ_TEXT_TOO_SHORT',
        );
      }
      return {
        sourceId: source.id,
        sourceIds: [source.id],
        // Preserve the WebSearch allowlist URL for downstream citations. An
        // exact-host or conventional bare-host/www redirect may be fetched,
        // but it cannot mint a new citable URL.
        url: firstUrl.href,
        resolvedUrlHash: urlHash(currentUrl.href),
        title: source.title || currentUrl.hostname,
        publishedAt: source.publishedAt,
        mediaType: type,
        text,
        fetchedAt: new Date().toISOString(),
        byteLength: body.length,
        httpStatus: statusCode,
        redirects,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    }
  }

  async readMany({ sources, sourceIds, signal, onActivity } = {}) {
    const output = {
      documents: [],
      attempts: [],
      errors: [],
      requestedCount: 0,
      totalChars: 0,
    };
    const selection = requestedSources(sources, sourceIds, this.maxPagesPerBatch);
    output.errors.push(...selection.errors);
    output.requestedCount = selection.requested.length;
    if (!selection.requested.length) return output;
    if (!this.enabled) {
      output.errors.push({
        sourceId: null,
        code: 'WEB_READ_DISABLED',
        message: 'Server-side web page reading is disabled.',
      });
      return output;
    }

    const unique = [];
    const byUrl = new Map();
    for (const source of selection.requested) {
      const existing = byUrl.get(source.url);
      if (existing) {
        existing.sourceIds.push(source.id);
        continue;
      }
      const item = { ...source, sourceIds: [source.id] };
      byUrl.set(source.url, item);
      unique.push(item);
    }
    const batchDeadline = deadlineSignal(
      signal,
      this.batchTimeoutMs,
      'The web page reading batch timed out.',
    );
    const domainTails = new Map();
    let nextIndex = 0;
    const runWithDomainLock = async (source, callback) => {
      const domain = registrableDomain(new URL(source.url).hostname);
      const previous = domainTails.get(domain) || Promise.resolve();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const tail = previous.catch(() => {}).then(() => gate);
      domainTails.set(domain, tail);
      await previous.catch(() => {});
      try { return await callback(); } finally {
        release();
        if (domainTails.get(domain) === tail) domainTails.delete(domain);
      }
    };
    const worker = async () => {
      while (nextIndex < unique.length) {
        const index = nextIndex;
        nextIndex += 1;
        const source = unique[index];
        if (batchDeadline.signal.aborted) break;
        const startedAt = Date.now();
        const attempt = {
          sourceId: source.id,
          sourceIds: [...source.sourceIds],
          urlHash: urlHash(source.url),
          status: 'started',
          durationMs: 0,
          byteLength: 0,
          httpStatus: 0,
          errorCode: '',
        };
        output.attempts.push(attempt);
        await emitActivity(onActivity, {
          stage: 'start',
          sourceId: source.id,
          index,
          total: unique.length,
        });
        const pageDeadline = deadlineSignal(
          batchDeadline.signal,
          this.pageTimeoutMs,
          'The page read timed out.',
        );
        try {
          const document = await runWithDomainLock(
            source,
            () => this.readSource(source, pageDeadline.signal),
          );
          document._order = index;
          document.sourceIds = [...source.sourceIds];
          attempt.status = 'completed';
          attempt.durationMs = document.durationMs;
          attempt.byteLength = document.byteLength;
          attempt.httpStatus = document.httpStatus;
          output.documents.push(document);
          await emitActivity(onActivity, {
            stage: 'complete',
            sourceId: source.id,
            index,
            total: unique.length,
            byteLength: document.byteLength,
            httpStatus: document.httpStatus,
          });
        } catch (error) {
          const failure = safeFailure(error, source.id);
          attempt.status = 'failed';
          attempt.durationMs = Math.max(0, Date.now() - startedAt);
          attempt.errorCode = failure.code;
          output.errors.push(failure);
          await emitActivity(onActivity, {
            stage: 'error',
            sourceId: source.id,
            index,
            total: unique.length,
            code: failure.code,
          });
        } finally {
          pageDeadline.cleanup();
        }
      }
    };
    try {
      await Promise.all(Array.from(
        { length: Math.min(this.concurrency, unique.length) },
        () => worker(),
      ));
    } finally {
      batchDeadline.cleanup();
    }

    output.documents.sort((left, right) => left._order - right._order);
    let remaining = this.totalMaxChars;
    for (const document of output.documents) {
      delete document._order;
      if (remaining <= 0) {
        document.text = '';
        continue;
      }
      if (document.text.length > remaining) document.text = document.text.slice(0, remaining);
      remaining -= document.text.length;
    }
    output.documents = output.documents.filter((document) => document.text.length > 0);
    output.totalChars = this.totalMaxChars - remaining;
    if (batchDeadline.signal.aborted && !signal?.aborted) {
      output.errors.push({
        sourceId: null,
        code: 'WEB_READ_BATCH_TIMEOUT',
        message: 'The web page reading batch timed out.',
      });
    }
    if (signal?.aborted) throw abortError(signal);
    return output;
  }
}
