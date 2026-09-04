import assert from 'node:assert/strict';
import test from 'node:test';

import {
  markPublicMessage,
  publicError,
  publicErrorCode,
} from '../src/public-errors.mjs';
import { serverInternals } from '../src/server.mjs';

test('public errors preserve marked application messages and bounded codes', () => {
  const error = markPublicMessage(Object.assign(new Error('Refresh the page and try again.'), {
    code: 'REVISION_CONFLICT',
  }));
  assert.deepEqual(publicError(error), {
    code: 'REVISION_CONFLICT',
    message: 'Refresh the page and try again.',
  });
  assert.equal(publicErrorCode({ code: 'secret.example/path' }, 'SERVER_ERROR'), 'SERVER_ERROR');
});

test('untrusted provider failures expose neither endpoint, credential, nor raw code', () => {
  const secret = 'fixture-secret-value-12345';
  const endpoint = 'https://private-provider.example/v1';
  const error = Object.assign(
    new Error(`request to ${endpoint} failed: api_key=${secret}`),
    { code: `LLM_NETWORK_ERROR_${secret}` },
  );
  const failure = publicError(error, {
    fallbackCode: 'TASK_FAILED',
    fallbackMessage: 'Safe fallback.',
  });
  assert.deepEqual(failure, { code: 'TASK_FAILED', message: 'Safe fallback.' });
  assert.equal(JSON.stringify(failure).includes(secret), false);
  assert.equal(JSON.stringify(failure).includes(endpoint), false);
});

test('recognized provider codes map to fixed actionable text without raw details', () => {
  const endpoint = 'https://private-provider.example/v1';
  const error = Object.assign(new Error(`connection to ${endpoint} failed`), {
    code: 'LLM_NETWORK_ERROR',
  });
  const failure = publicError(error, { fallbackCode: 'TASK_FAILED' });
  assert.equal(failure.code, 'LLM_NETWORK_ERROR');
  assert.match(failure.message, /model provider/i);
  assert.equal(failure.message.includes(endpoint), false);
});

test('marked messages fail closed when they contain a private URL or host path', () => {
  for (const detail of [
    'Failure at https://private-provider.example/v1.',
    'Failure while reading /srv/example/private/config.json.',
    'Failure with authorization=fixture-secret-value.',
  ]) {
    const failure = publicError(markPublicMessage(new Error(detail)), {
      fallbackCode: 'SAFE_ERROR',
      fallbackMessage: 'Safe fallback.',
    });
    assert.deepEqual(failure, { code: 'SAFE_ERROR', message: 'Safe fallback.' });
  }
});

test('model validation result projection drops provider-controlled details', () => {
  const endpoint = 'https://private-provider.example/v1';
  const credential = 'fixture-secret-value-12345';
  const results = serverInternals.safeModelValidationResults([{
    modelId: 'fixture-model',
    ok: false,
    code: 'LLM_AUTH_FAILED',
    message: `${endpoint} rejected api_key=${credential}`,
    privateExtra: credential,
  }]);
  assert.deepEqual(results, [{
    modelId: 'fixture-model',
    ok: false,
    code: 'LLM_AUTH_FAILED',
    message: 'Model provider authentication failed. Check the API Key in Settings.',
  }]);
  assert.equal(JSON.stringify(results).includes(endpoint), false);
  assert.equal(JSON.stringify(results).includes(credential), false);
});
