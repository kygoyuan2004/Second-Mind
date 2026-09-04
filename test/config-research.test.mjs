import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configInternals,
  createConfig,
  publicConfig,
  validateRuntimeConfig,
} from '../src/config.mjs';

const SK_WS_PREFIX = ['sk', 'ws'].join('-');
const RESPONSES_API_KEY = `${SK_WS_PREFIX}-fixture-responses-capable-key`;

function validBase(overrides = {}) {
  return createConfig({
    auth: {
      password: 'correct horse battery staple',
      sessionSecret: 'TEST_ONLY_NOT_A_REAL_SESSION_SECRET',
    },
    llm: { model: 'local-test-model' },
    ...overrides,
  });
}

test('research and outbound page-reading features default off with bounded limits', () => {
  const config = createConfig();
  assert.deepEqual(config.research, {
    contextualizerEnabled: false,
    loopEnabled: false,
    contextualizerTimeoutMs: 45_000,
    evidenceTimeoutMs: 60_000,
  });
  assert.equal(config.webReader.enabled, false);
  assert.equal(config.webReader.pdfEnabled, false);
  assert.equal(config.webReader.pageTimeoutMs, 15_000);
  assert.equal(config.webReader.batchTimeoutMs, 40_000);
  assert.equal(config.webReader.htmlMaxBytes, 2 * 1024 * 1024);
  assert.equal(config.webReader.pdfMaxBytes, 8 * 1024 * 1024);
  assert.equal(config.webReader.pageMaxChars, 16_000);
  assert.equal(config.webReader.totalMaxChars, 40_000);
  assert.equal(config.webReader.concurrency, 2);
  assert.equal(config.webReader.normalMaxPages, 2);
  assert.equal(config.webReader.deepMaxPagesPerRound, 3);
  assert.equal(config.responsesFallback.enabled, false);
  assert.equal(config.responsesFallback.model, 'qwen3.8-max');
  assert.deepEqual(config.webSearch.officialDomains, []);
});

test('only an exact read-only Docker secret mount can waive host mode bits', () => {
  const { isReadOnlyContainerSecretMount } = configInternals;
  const readOnly = '42 31 0:77 /source /run/secrets/admin_password ro,nosuid,nodev - fuse source rw';
  const writable = '42 31 0:77 /source /run/secrets/admin_password rw,nosuid,nodev - fuse source rw';
  const parentOnly = '42 31 0:77 /source /run/secrets ro,nosuid,nodev - fuse source rw';

  assert.equal(isReadOnlyContainerSecretMount('/run/secrets/admin_password', readOnly), true);
  assert.equal(isReadOnlyContainerSecretMount('/run/secrets/admin_password', writable), false);
  assert.equal(isReadOnlyContainerSecretMount('/run/secrets/admin_password', parentOnly), false);
  assert.equal(isReadOnlyContainerSecretMount('/tmp/admin_password', readOnly), false);
  assert.equal(isReadOnlyContainerSecretMount('/run/secrets/nested/value', readOnly), false);
  assert.equal(isReadOnlyContainerSecretMount('/run/secrets/../secrets/admin_password', readOnly), false);
  assert.equal(isReadOnlyContainerSecretMount('run/secrets/admin_password', readOnly), false);
  assert.equal(isReadOnlyContainerSecretMount('\\run\\secrets\\admin_password', readOnly), false);
});

test('organization-official domains are normalized, minimized, and strictly validated', () => {
  const config = createConfig({
    webSearch: {
      officialDomains: ' News.GROUP-A.EXAMPLE.COM. , group-a.example.com, 集团.example.cn',
    },
  });
  assert.deepEqual(config.webSearch.officialDomains, ['group-a.example.com', 'xn--3bst00m.example.cn']);

  for (const invalid of [
    'https://group-a.example.com', '*.group-a.example.com', 'group-a.example.com/path',
    'group-a.example.com:443', '127.0.0.1', 'localhost', 'com.cn',
  ]) {
    assert.throws(
      () => createConfig({ webSearch: { officialDomains: [invalid] } }),
      /WEB_SEARCH_OFFICIAL_DOMAINS/u,
    );
  }
});

test('public WebSearch status accepts an sk-ws fallback key and exposes only safe fields', () => {
  const config = validBase({
    webSearch: {
      enabled: true,
      apiKey: 'web-secret',
      endpoint: 'https://private.invalid/mcp',
      officialDomains: ['private-official.example.cn'],
    },
    webReader: { enabled: true },
    responsesFallback: {
      enabled: true,
      apiBase: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: RESPONSES_API_KEY,
    },
  });
  assert.deepEqual(publicConfig(config).webSearch, {
    enabled: true,
    configured: true,
    provider: 'bailian-mcp',
    fallbackConfigured: true,
  });
  const serialized = JSON.stringify(publicConfig(config));
  assert.doesNotMatch(
    serialized,
    /web-secret|fixture-responses-capable-key|private\.invalid|workspace\.|private-official/u,
  );
});

test('Responses API base derives an approved exact endpoint', () => {
  const base = 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  assert.equal(
    configInternals.bailianResponsesEndpoint(base),
    `${base}/responses`,
  );
  assert.equal(
    configInternals.validBailianResponsesEndpoint(`${base}/responses`),
    true,
  );
  assert.equal(
    configInternals.validBailianResponsesEndpoint('http://127.0.0.1/responses'),
    false,
  );
});

test('Responses API key validation accepts sk-ws credentials and enforces opaque bounds', () => {
  const { validBailianApiKey } = configInternals;
  assert.equal(validBailianApiKey(`${SK_WS_PREFIX}-xy`), true);
  assert.equal(validBailianApiKey(` \t${RESPONSES_API_KEY}\r\n`), true);
  assert.equal(validBailianApiKey('x'.repeat(16_384)), true);
  for (const invalidKey of [
    '',
    `${SK_WS_PREFIX}-x`,
    'x'.repeat(16_385),
    `${SK_WS_PREFIX}-valid key`,
    `${SK_WS_PREFIX}-valid\u0000key`,
  ]) {
    assert.equal(validBailianApiKey(invalidKey), false);
  }
});

test('runtime validation enforces research and reader dependency gates', () => {
  assert.throws(
    () => validateRuntimeConfig(validBase({
      research: { contextualizerEnabled: false, loopEnabled: true },
    })),
    /QA_RESEARCH_LOOP_ENABLED requires QA_CONTEXTUALIZER_ENABLED/u,
  );
  assert.throws(
    () => validateRuntimeConfig(validBase({
      webReader: { enabled: true },
    })),
    /WEB_READER_ENABLED requires WEB_SEARCH_ENABLED/u,
  );
  assert.throws(
    () => validateRuntimeConfig(validBase({
      webReader: { enabled: false, pdfEnabled: true },
    })),
    /PDF_ENABLED requires WEB_READER_ENABLED/u,
  );
});

test('Responses fallback requires its safe prerequisites, key, endpoint, and pinned model', () => {
  const common = {
    webSearch: { enabled: true, apiKey: 'web-key' },
    webReader: { enabled: true },
    responsesFallback: {
      enabled: true,
      apiBase: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: RESPONSES_API_KEY,
    },
  };
  assert.doesNotThrow(() => validateRuntimeConfig(validBase(common)));
  assert.throws(
    () => validateRuntimeConfig(validBase({
      ...common,
      responsesFallback: { ...common.responsesFallback, model: 'another-model' },
    })),
    /pinned to qwen3\.8-max/u,
  );
  assert.throws(
    () => validateRuntimeConfig(validBase({
      ...common,
      responsesFallback: { ...common.responsesFallback, apiKey: '' },
    })),
    /BAILIAN_RESPONSES_FALLBACK_API_KEY is required/u,
  );
  for (const invalidKey of [
    `${SK_WS_PREFIX}-x`,
    'x'.repeat(16_385),
    `${SK_WS_PREFIX}-valid key`,
    `${SK_WS_PREFIX}-valid\u0000key`,
  ]) {
    assert.throws(
      () => validateRuntimeConfig(validBase({
        ...common,
        responsesFallback: { ...common.responsesFallback, apiKey: invalidKey },
      })),
      /BAILIAN_RESPONSES_FALLBACK_API_KEY/u,
    );
    assert.equal(publicConfig(validBase({
      ...common,
      responsesFallback: { ...common.responsesFallback, apiKey: invalidKey },
    })).webSearch.fallbackConfigured, false);
  }
});

test('managed startup allows no LLM and provider credentials never inherit one another', {
  concurrency: false,
}, () => {
  const names = [
    'LLM_API_KEY', 'LLM_API_KEY_FILE',
    'EMBEDDING_API_KEY', 'EMBEDDING_API_KEY_FILE',
    'WEB_SEARCH_API_KEY', 'WEB_SEARCH_API_KEY_FILE',
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.LLM_API_KEY = ['llm', 'fixture', 'credential', '123456'].join('-');
    const isolated = createConfig();
    assert.equal(isolated.llm.apiKey, process.env.LLM_API_KEY);
    assert.equal(isolated.embedding.apiKey, '');
    assert.equal(isolated.webSearch.apiKey, '');

    process.env.EMBEDDING_API_KEY = ['embedding', 'fixture', 'credential', '123456'].join('-');
    process.env.WEB_SEARCH_API_KEY = ['search', 'fixture', 'credential', '123456'].join('-');
    const distinct = createConfig();
    assert.equal(distinct.llm.apiKey, process.env.LLM_API_KEY);
    assert.equal(distinct.embedding.apiKey, process.env.EMBEDDING_API_KEY);
    assert.equal(distinct.webSearch.apiKey, process.env.WEB_SEARCH_API_KEY);

    const managed = validBase({ runtimeManagedProviders: true, llm: { model: '' } });
    assert.doesNotThrow(() => validateRuntimeConfig(managed));
    assert.equal(publicConfig(managed).llm.configured, false);
    assert.throws(
      () => validateRuntimeConfig(validBase({ llm: { model: '' } })),
      /LLM_MODEL is required/u,
    );
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
