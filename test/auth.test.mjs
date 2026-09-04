import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager, requireWriteGuard } from '../src/auth.mjs';

const config = {
  username: 'admin',
  password: 'correct horse battery staple',
  sessionSecret: 'TEST_ONLY_NOT_A_REAL_SESSION_SECRET',
  sessionTtlSeconds: 3600,
  secureCookie: true,
};

function request(headers = {}, address = '127.0.0.1') {
  return { headers, socket: { remoteAddress: address }, method: 'POST' };
}

test('session cookie is signed, HttpOnly, SameSite, and Secure when configured', () => {
  const manager = new SessionManager(config);
  const req = request();
  const user = manager.authenticate('admin', config.password, req);
  const cookie = manager.cookie(user);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(manager.user({ headers: { cookie } })?.id, 'admin');
});

test('tampered sessions and invalid credentials are rejected', () => {
  const manager = new SessionManager(config);
  assert.throws(() => manager.authenticate('admin', 'incorrect-password', request()), {
    code: 'INVALID_CREDENTIALS',
  });
  const cookie = manager.cookie({ id: 'admin' });
  const [pair, ...attributes] = cookie.split('; ');
  const tamperedPair = `${pair.slice(0, -1)}${pair.endsWith('x') ? 'y' : 'x'}`;
  assert.equal(manager.user({ headers: { cookie: [tamperedPair, ...attributes].join('; ') } }), null);
});

test('write guard requires a custom header and same origin', () => {
  assert.throws(() => requireWriteGuard(request({ host: 'vault.test' })), { code: 'CSRF_GUARD_REQUIRED' });
  assert.doesNotThrow(() => requireWriteGuard(request({
    host: 'vault.test',
    origin: 'https://vault.test',
    'x-vaultmind-request': '1',
  })));
  assert.throws(() => requireWriteGuard(request({
    host: 'vault.test',
    origin: 'https://evil.test',
    'x-vaultmind-request': '1',
  })), { code: 'ORIGIN_DENIED' });
});

test('login throttling is bounded by client IP rather than attacker-controlled usernames', () => {
  const manager = new SessionManager(config);
  for (let index = 0; index < 10; index += 1) {
    assert.throws(
      () => manager.authenticate(`rotated-user-${index}`, 'incorrect-password', request()),
      { code: 'INVALID_CREDENTIALS' },
    );
  }
  assert.throws(
    () => manager.authenticate('another-username', 'incorrect-password', request()),
    { code: 'TOO_MANY_ATTEMPTS' },
  );
  assert.equal(manager.attempts.size, 1);
});
