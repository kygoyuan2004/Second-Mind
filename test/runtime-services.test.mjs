import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RuntimeResponsesExtractor,
  RuntimeTavilyExtractFallback,
  RuntimeWebSearchClient,
} from '../src/runtime-services.mjs';

const WEB_KEY_ONE = ['web', 'runtime', 'credential', 'one'].join('-');
const WEB_KEY_TWO = ['web', 'runtime', 'credential', 'two'].join('-');
const RESPONSES_KEY = ['responses', 'dedicated', 'credential'].join('-');
const WEB_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';
const RESPONSES_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/apps/example/responses';

class MutableRegistry {
  constructor(webSearch) {
    this.current = structuredClone(webSearch);
    this.pending = null;
    this.refreshes = 0;
  }

  stage(webSearch) {
    this.pending = structuredClone(webSearch);
  }

  async refresh() {
    this.refreshes += 1;
    if (this.pending) {
      this.current = this.pending;
      this.pending = null;
    }
    return { revision: `refresh-${this.refreshes}`, stale: false };
  }

  runtimeSnapshot() {
    return { webSearch: structuredClone(this.current) };
  }
}

test('each new WebSearch session uses the latest managed key while an existing session stays pinned', async () => {
  const registry = new MutableRegistry({
    enabled: true,
    endpoint: WEB_ENDPOINT,
    apiKey: WEB_KEY_ONE,
  });
  const constructed = [];
  const client = new RuntimeWebSearchClient(registry, {
    enabled: false,
    endpoint: WEB_ENDPOINT,
    apiKey: 'unused-default',
    resultCount: 15,
  }, {
    clientFactory(config) {
      constructed.push({ ...config });
      const pinnedKey = config.apiKey;
      return {
        async openSession() {
          return { pinnedKey };
        },
        async searchMany() {
          return { pinnedKey };
        },
      };
    },
  });

  const first = await client.openSession();
  registry.stage({ enabled: true, endpoint: WEB_ENDPOINT, apiKey: WEB_KEY_TWO });
  const second = await client.openSession();

  assert.equal(first.pinnedKey, WEB_KEY_ONE);
  assert.equal(second.pinnedKey, WEB_KEY_TWO);
  assert.equal(constructed[0].resultCount, 15);
  assert.equal(constructed[1].resultCount, 15);
  assert.equal(registry.refreshes, 2);
  const publicJson = JSON.stringify(client.publicStatus());
  assert.equal(publicJson.includes(WEB_KEY_ONE), false);
  assert.equal(publicJson.includes(WEB_KEY_TWO), false);
  assert.deepEqual(client.publicStatus(), {
    enabled: true,
    configured: true,
    provider: 'bailian-mcp',
  });
});

test('clearing or disabling the managed WebSearch credential does not fall back to an old key', async () => {
  const registry = new MutableRegistry({
    enabled: true,
    endpoint: WEB_ENDPOINT,
    apiKey: WEB_KEY_ONE,
  });
  const configs = [];
  const client = new RuntimeWebSearchClient(registry, {
    enabled: true,
    endpoint: WEB_ENDPOINT,
    apiKey: 'must-not-be-reused',
  }, {
    clientFactory(config) {
      configs.push(config);
      return { async openSession() { return null; } };
    },
  });

  registry.stage({ enabled: false, endpoint: WEB_ENDPOINT, apiKey: '' });
  await client.openSession();
  assert.equal(configs[0].enabled, false);
  assert.equal(configs[0].apiKey, '');
  assert.deepEqual(client.publicStatus(), {
    enabled: false,
    configured: false,
    provider: 'bailian-mcp',
  });
});

test('Responses fallback explicitly reuses the latest WebSearch key when configured to do so', async () => {
  const registry = new MutableRegistry({
    enabled: true,
    endpoint: WEB_ENDPOINT,
    apiKey: WEB_KEY_ONE,
  });
  const configs = [];
  const extractor = new RuntimeResponsesExtractor(registry, {
    enabled: true,
    endpoint: RESPONSES_ENDPOINT,
    apiKey: 'unused-dedicated-key',
  }, {
    extractorFactory(config) {
      configs.push(config);
      return { async extract() { return { selectedKey: config.apiKey }; } };
    },
  });

  assert.equal((await extractor.extract()).selectedKey, WEB_KEY_ONE);
  registry.stage({ enabled: true, endpoint: WEB_ENDPOINT, apiKey: WEB_KEY_TWO });
  assert.equal((await extractor.extract()).selectedKey, WEB_KEY_TWO);
  assert.equal(configs[0].enabled, true);
  assert.equal(configs[1].enabled, true);
  const publicJson = JSON.stringify(extractor.publicStatus());
  assert.equal(publicJson.includes(WEB_KEY_ONE), false);
  assert.equal(publicJson.includes(WEB_KEY_TWO), false);

  registry.stage({ enabled: false, endpoint: WEB_ENDPOINT, apiKey: WEB_KEY_TWO });
  await extractor.extract();
  assert.equal(configs[2].enabled, false);
});

test('a dedicated Responses key remains independent from WebSearch key updates but respects its switch', async () => {
  const registry = new MutableRegistry({
    enabled: true,
    endpoint: WEB_ENDPOINT,
    apiKey: WEB_KEY_ONE,
  });
  const configs = [];
  const extractor = new RuntimeResponsesExtractor(registry, {
    enabled: true,
    endpoint: RESPONSES_ENDPOINT,
    apiKey: RESPONSES_KEY,
    reuseWebSearchKey: false,
  }, {
    extractorFactory(config) {
      configs.push(config);
      return { async extract() { return { selectedKey: config.apiKey }; } };
    },
  });

  assert.equal((await extractor.extract()).selectedKey, RESPONSES_KEY);
  registry.stage({ enabled: true, endpoint: WEB_ENDPOINT, apiKey: WEB_KEY_TWO });
  assert.equal((await extractor.extract()).selectedKey, RESPONSES_KEY);
  assert.equal(configs.every((config) => config.enabled === true), true);
  assert.deepEqual(extractor.publicStatus(), {
    enabled: true,
    configured: true,
    provider: 'bailian-responses',
  });

  registry.stage({ enabled: false, endpoint: WEB_ENDPOINT, apiKey: WEB_KEY_TWO });
  await extractor.extract();
  assert.equal(configs[2].apiKey, RESPONSES_KEY);
  assert.equal(configs[2].enabled, false);
});

test('without a registry, Responses fallback keeps its base credential private but remains disabled', async () => {
  let selected;
  const extractor = new RuntimeResponsesExtractor(null, {
    enabled: true,
    endpoint: RESPONSES_ENDPOINT,
    apiKey: RESPONSES_KEY,
    reuseWebSearchKey: true,
  }, {
    extractorFactory(config) {
      selected = config;
      return { async extract() { return { ok: true }; } };
    },
  });

  assert.deepEqual(await extractor.extract(), { ok: true });
  assert.equal(selected.apiKey, RESPONSES_KEY);
  assert.equal(selected.enabled, false);
  assert.equal(JSON.stringify(extractor.publicStatus()).includes(RESPONSES_KEY), false);
});

test('a task-scoped lease pins both provider and credential while later tasks hot-switch', async () => {
  const bailianKey = ['bailian', 'profile', 'credential'].join('-');
  const tavilyKey = ['tavily', 'profile', 'credential'].join('-');
  const registry = new MutableRegistry({
    provider: 'bailian-mcp',
    enabled: true,
    providers: {
      'bailian-mcp': { endpoint: WEB_ENDPOINT, apiKey: bailianKey },
      'tavily-rest': { apiKey: tavilyKey },
    },
  });
  const constructed = [];
  const factory = (provider) => (config) => {
    constructed.push({ provider, apiKey: config.apiKey });
    return {
      publicStatus: () => ({ enabled: config.enabled, configured: Boolean(config.apiKey) }),
      async openSession() {
        return {
          async searchMany() { return { provider, apiKey: config.apiKey }; },
          async close() {},
        };
      },
    };
  };
  const client = new RuntimeWebSearchClient(registry, {
    provider: 'bailian-mcp',
    enabled: false,
    apiKey: 'legacy-default-must-not-cross',
  }, {
    clientFactories: {
      'bailian-mcp': factory('bailian-mcp'),
      'tavily-rest': factory('tavily-rest'),
    },
  });

  const bailianLease = await client.acquireForTask();
  registry.stage({
    provider: 'tavily-rest',
    enabled: true,
    providers: {
      'bailian-mcp': { endpoint: WEB_ENDPOINT, apiKey: bailianKey },
      'tavily-rest': { apiKey: tavilyKey },
    },
  });
  const oldTaskResult = await bailianLease.searchMany(['old task']);
  const tavilyLease = await client.acquireForTask();
  const newTaskResult = await tavilyLease.searchMany(['new task']);

  assert.deepEqual(oldTaskResult, { provider: 'bailian-mcp', apiKey: bailianKey });
  assert.deepEqual(newTaskResult, { provider: 'tavily-rest', apiKey: tavilyKey });
  assert.equal(bailianLease.provider, 'bailian-mcp');
  assert.equal(tavilyLease.provider, 'tavily-rest');
  assert.deepEqual(constructed, [
    { provider: 'bailian-mcp', apiKey: bailianKey },
    { provider: 'tavily-rest', apiKey: tavilyKey },
  ]);
  assert.equal(JSON.stringify(bailianLease).includes(bailianKey), false);
  assert.equal(JSON.stringify(tavilyLease).includes(tavilyKey), false);
  await Promise.all([bailianLease.close(), tavilyLease.close()]);
});

test('switching to Tavily never sends its credential to the Bailian Responses fallback', async () => {
  const tavilyKey = ['tavily', 'must', 'stay', 'isolated'].join('-');
  const registry = new MutableRegistry({
    provider: 'tavily-rest',
    enabled: true,
    apiKey: tavilyKey,
  });
  let selected;
  const extractor = new RuntimeResponsesExtractor(registry, {
    enabled: true,
    endpoint: RESPONSES_ENDPOINT,
    apiKey: 'unused-bailian-default',
    reuseWebSearchKey: true,
  }, {
    extractorFactory(config) {
      selected = config;
      return { async extract() { return { enabled: config.enabled }; } };
    },
  });

  assert.deepEqual(await extractor.extract(), { enabled: false });
  assert.equal(selected.enabled, false);
  assert.equal(selected.apiKey, '');
  assert.equal(JSON.stringify(selected).includes(tavilyKey), false);
});

test('a missing Tavily profile fails unconfigured without inheriting the legacy Bailian key', async () => {
  const bailianKey = ['legacy', 'bailian', 'credential'].join('-');
  const configs = [];
  const registry = new MutableRegistry({
    provider: 'tavily-rest',
    enabled: true,
    providers: {
      'bailian-mcp': { apiKey: bailianKey },
      'tavily-rest': {},
    },
  });
  const client = new RuntimeWebSearchClient(registry, {
    provider: 'bailian-mcp',
    enabled: true,
    apiKey: bailianKey,
  }, {
    tavilyClientFactory(config) {
      configs.push(config);
      return {
        publicStatus: () => ({ enabled: config.enabled, configured: Boolean(config.apiKey) }),
        async searchMany() { return { apiKey: config.apiKey }; },
      };
    },
  });

  assert.deepEqual(client.publicStatus(), {
    enabled: true,
    configured: false,
    provider: 'tavily-rest',
  });
  assert.equal(configs[0].apiKey, '');
  assert.equal(JSON.stringify(configs[0]).includes(bailianKey), false);
});

test('the runtime Tavily Extract fallback uses only the selected Tavily profile', async () => {
  const bailianKey = ['bailian', 'separate', 'credential'].join('-');
  const tavilyKey = ['tavily', 'separate', 'credential'].join('-');
  const registry = new MutableRegistry({
    provider: 'tavily-rest',
    enabled: true,
    providers: {
      'bailian-mcp': { apiKey: bailianKey },
      'tavily-rest': { apiKey: tavilyKey },
    },
  });
  const configs = [];
  const fallback = new RuntimeTavilyExtractFallback(registry, {
    enabled: true,
  }, {
    extractorFactory(config) {
      configs.push(config);
      return { async extract() { return { provider: config.provider, apiKey: config.apiKey }; } };
    },
  });

  assert.deepEqual(await fallback.extract(), {
    provider: 'tavily-extract-rest',
    apiKey: tavilyKey,
  });
  assert.equal(configs[0].apiKey, tavilyKey);
  assert.equal(JSON.stringify(configs[0]).includes(bailianKey), false);

  registry.stage({
    provider: 'bailian-mcp',
    enabled: true,
    providers: {
      'bailian-mcp': { apiKey: bailianKey },
      'tavily-rest': { apiKey: tavilyKey },
    },
  });
  await fallback.extract();
  assert.equal(configs[1].enabled, false);
  assert.equal(configs[1].apiKey, '');
});

test('an acquired Tavily Extract lease keeps its credential pinned and exposes no secret', async () => {
  const firstKey = ['tavily', 'extract', 'first'].join('-');
  const secondKey = ['tavily', 'extract', 'second'].join('-');
  const registry = new MutableRegistry({
    provider: 'tavily-rest', enabled: true, apiKey: firstKey,
  });
  const fallback = new RuntimeTavilyExtractFallback(registry, { enabled: true }, {
    extractorFactory(config) {
      return {
        publicStatus: () => ({ enabled: config.enabled, configured: Boolean(config.apiKey) }),
        async extract() { return { apiKey: config.apiKey }; },
      };
    },
  });

  const lease = await fallback.acquireForTask();
  registry.stage({ provider: 'tavily-rest', enabled: true, apiKey: secondKey });
  assert.deepEqual(await lease.extract(), { apiKey: firstKey });
  assert.equal(JSON.stringify(lease).includes(firstKey), false);
  await lease.close();
  await assert.rejects(
    lease.extract(),
    (error) => error?.code === 'WEB_EXTRACT_LEASE_CLOSED',
  );
});

test('an unsupported runtime provider fails closed instead of falling back with its key', () => {
  const registry = new MutableRegistry({
    provider: 'unknown-provider',
    enabled: true,
    apiKey: 'credential-that-must-not-be-sent',
  });
  const client = new RuntimeWebSearchClient(registry, {
    provider: 'bailian-mcp',
    enabled: true,
    apiKey: WEB_KEY_ONE,
  });

  assert.throws(
    () => client.publicStatus(),
    (error) => error?.code === 'WEB_SEARCH_PROVIDER_UNSUPPORTED',
  );
});
