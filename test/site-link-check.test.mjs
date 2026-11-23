import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyExternalLink,
  validateExternalLinks,
} from '../scripts/site-link-check.mjs';

function response(status, url, body = null) {
  return { status, url, body };
}

test('external link classification maps Pages URLs locally and allowlists this repository', () => {
  assert.deepEqual(
    classifyExternalLink('https://kygoyuan2004.github.io/Second-Mind/en/#limits'),
    { kind: 'site', reference: '/Second-Mind/en/#limits' },
  );
  assert.equal(
    classifyExternalLink('https://github.com/kygoyuan2004/Second-Mind/blob/main/LICENSE').kind,
    'network',
  );
  assert.equal(classifyExternalLink('http://github.com/kygoyuan2004/Second-Mind').kind, 'invalid');
  assert.equal(classifyExternalLink('https://example.test/elsewhere').kind, 'invalid');
  assert.equal(classifyExternalLink('https://github.com/another/repository').kind, 'invalid');
  assert.equal(classifyExternalLink('https://user:secret@github.com/kygoyuan2004/Second-Mind').kind, 'invalid');
  assert.equal(classifyExternalLink('https://github.com/kygoyuan2004/Second-Mind?token=secret').kind, 'invalid');
});

test('external link validation deduplicates successful HEAD requests', async () => {
  const calls = [];
  const url = 'https://github.com/kygoyuan2004/Second-Mind';
  const issues = await validateExternalLinks([url, url], {
    fetchImpl: async (reference, options) => {
      calls.push([reference, options.method]);
      return response(200, reference);
    },
  });
  assert.deepEqual(issues, []);
  assert.deepEqual(calls, [[url, 'HEAD']]);
});

test('external link validation falls back to a bounded range GET', async () => {
  const calls = [];
  const url = 'https://github.com/kygoyuan2004/Second-Mind/tree/main/docs';
  const issues = await validateExternalLinks([url], {
    fetchImpl: async (reference, options) => {
      calls.push(options);
      return response(options.method === 'HEAD' ? 405 : 206, reference);
    },
  });
  assert.deepEqual(issues, []);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'HEAD');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].headers.range, 'bytes=0-0');
  assert.equal(calls[1].redirect, 'follow');
  assert.ok(calls[1].signal instanceof AbortSignal);
});

test('external link validation retries transient status and sanitizes failures', async () => {
  const url = 'https://github.com/kygoyuan2004/Second-Mind/blob/main/missing';
  let attempts = 0;
  const recovered = await validateExternalLinks([url], {
    fetchImpl: async (reference) => response(++attempts === 1 ? 503 : 200, reference),
    sleep: async () => {},
  });
  assert.deepEqual(recovered, []);
  assert.equal(attempts, 2);

  const failed = await validateExternalLinks([url], {
    fetchImpl: async () => { throw new Error('private response detail'); },
    maxAttempts: 1,
  });
  assert.equal(failed.length, 1);
  assert.match(failed[0], /could not be reached within the bounded link check/);
  assert.doesNotMatch(failed[0], /private response detail/);
});

test('external link validation rejects a redirect outside the allowlist', async () => {
  const issues = await validateExternalLinks([
    'https://github.com/kygoyuan2004/Second-Mind',
  ], {
    fetchImpl: async () => response(200, 'https://example.test/captive-portal'),
  });
  assert.deepEqual(issues, [
    'https://github.com/kygoyuan2004/Second-Mind: redirect target is outside the public repository allowlist',
  ]);
});
