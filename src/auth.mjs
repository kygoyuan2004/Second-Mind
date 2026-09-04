import crypto from 'node:crypto';
import { markPublicMessage } from './public-errors.mjs';

const COOKIE_NAME = 'vaultmind_session';
const MAX_USERNAME_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 4_096;
const MAX_RATE_LIMIT_KEYS = 4_096;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

function authError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return markPublicMessage(error);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function cookies(header = '') {
  const output = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) output[key] = value;
  }
  return output;
}

export class SessionManager {
  constructor(config) {
    this.config = config;
    this.key = Buffer.from(config.sessionSecret);
    this.attempts = new Map();
    this.nextAttemptPruneAt = 0;
  }

  clientIp(req, trustProxy = false) {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded.slice(0, 100);
    }
    return String(req.socket.remoteAddress || 'unknown').slice(0, 100);
  }

  authenticate(usernameInput, passwordInput, req, trustProxy = false) {
    const username = String(usernameInput || '').trim();
    const password = String(passwordInput || '');
    const key = this.clientIp(req, trustProxy);
    const now = Date.now();
    if (now >= this.nextAttemptPruneAt || this.attempts.size >= MAX_RATE_LIMIT_KEYS) {
      for (const [candidate, value] of this.attempts) {
        if (value.resetAt <= now) this.attempts.delete(candidate);
      }
      while (this.attempts.size >= MAX_RATE_LIMIT_KEYS) {
        this.attempts.delete(this.attempts.keys().next().value);
      }
      this.nextAttemptPruneAt = now + 60_000;
    }
    const attempt = this.attempts.get(key) || { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
    if (now > attempt.resetAt) {
      attempt.count = 0;
      attempt.resetAt = now + ATTEMPT_WINDOW_MS;
    }
    if (attempt.count >= 10) {
      throw authError(429, 'Too many login attempts. Try again later.', 'TOO_MANY_ATTEMPTS');
    }
    if (
      username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH ||
      !safeEqual(username, this.config.username) || !safeEqual(password, this.config.password)
    ) {
      attempt.count += 1;
      this.attempts.set(key, attempt);
      throw authError(401, 'Username or password is incorrect.', 'INVALID_CREDENTIALS');
    }
    this.attempts.delete(key);
    return { id: 'admin', username: this.config.username, role: 'admin' };
  }

  token(user) {
    const expires = Math.floor(Date.now() / 1000) + this.config.sessionTtlSeconds;
    const nonce = crypto.randomBytes(16).toString('base64url');
    const payload = `${expires}.${user.id}.${nonce}`;
    const signature = crypto.createHmac('sha256', this.key).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  user(req) {
    const token = cookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [expiresText, userId, nonce, signature] = parts;
    const expires = Number(expiresText);
    if (!Number.isSafeInteger(expires) || expires < Date.now() / 1000 || userId !== 'admin' || !nonce) return null;
    const expected = crypto.createHmac('sha256', this.key)
      .update(`${expiresText}.${userId}.${nonce}`)
      .digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    return { id: 'admin', username: this.config.username, role: 'admin' };
  }

  require(req) {
    const user = this.user(req);
    if (!user) throw authError(401, 'Please sign in.', 'AUTH_REQUIRED');
    return user;
  }

  cookie(user) {
    return [
      `${COOKIE_NAME}=${this.token(user)}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${this.config.sessionTtlSeconds}`,
      this.config.secureCookie ? 'Secure' : '',
    ].filter(Boolean).join('; ');
  }

  clearCookie() {
    return [
      `${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0',
      this.config.secureCookie ? 'Secure' : '',
    ].filter(Boolean).join('; ');
  }
}

export function requireWriteGuard(req) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-vaultmind-request'] !== '1') {
    throw authError(403, 'Request verification failed. Refresh and try again.', 'CSRF_GUARD_REQUIRED');
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; }
    catch { throw authError(403, 'Request origin is invalid.', 'ORIGIN_DENIED'); }
    if (originHost !== req.headers.host) throw authError(403, 'Cross-origin request denied.', 'ORIGIN_DENIED');
  }
}

export const authInternals = { COOKIE_NAME, cookies, safeEqual };
