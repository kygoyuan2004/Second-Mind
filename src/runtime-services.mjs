import { BailianResponsesExtractor } from './bailian-responses-extractor.mjs';
import { BailianWebSearchClient } from './bailian-web-search-client.mjs';
import {
  TAVILY_WEB_SEARCH_PROVIDER,
  TavilyExtractFallback,
  TavilyWebSearchClient,
} from './tavily-web-search-client.mjs';

export const BAILIAN_WEB_SEARCH_PROVIDER = 'bailian-mcp';
export const WEB_SEARCH_PROVIDERS = Object.freeze([
  BAILIAN_WEB_SEARCH_PROVIDER,
  TAVILY_WEB_SEARCH_PROVIDER,
]);

function runtimeSnapshot(registry) {
  if (!registry?.runtimeSnapshot) return null;
  return registry.runtimeSnapshot();
}

function hasOwn(value, key) {
  return Boolean(value && typeof value === 'object' && Object.hasOwn(value, key));
}

function providerId(value, fallback = BAILIAN_WEB_SEARCH_PROVIDER) {
  return String(value || fallback).trim().toLowerCase();
}

function providerProfile(value, provider) {
  if (!value || typeof value !== 'object') return {};
  for (const field of ['providers', 'profiles', 'providerConfigs']) {
    const collection = value[field];
    if (Array.isArray(collection)) {
      const selected = collection.find((entry) => providerId(entry?.id, '') === provider);
      if (selected && typeof selected === 'object') return selected;
    } else if (collection && typeof collection === 'object') {
      const selected = collection[provider];
      if (selected && typeof selected === 'object') return selected;
    }
  }
  return {};
}

function withoutProviderContainers(value) {
  if (!value || typeof value !== 'object') return {};
  const output = { ...value };
  delete output.providers;
  delete output.profiles;
  delete output.providerConfigs;
  return output;
}

function resolvedWebSearchConfig(snapshot, baseConfig = {}) {
  const current = snapshot?.webSearch || null;
  const baseProvider = providerId(baseConfig.provider);
  const provider = providerId(current?.provider, baseProvider);
  const baseProfile = providerProfile(baseConfig, provider);
  const currentProfile = providerProfile(current, provider);
  const hasSnapshot = Boolean(snapshot);
  let apiKey = '';
  if (hasOwn(currentProfile, 'apiKey')) apiKey = currentProfile.apiKey;
  else if (hasOwn(current, 'apiKey')) apiKey = current.apiKey;
  else if (hasOwn(baseProfile, 'apiKey')) apiKey = baseProfile.apiKey;
  else if (!hasSnapshot && provider === baseProvider && hasOwn(baseConfig, 'apiKey')) {
    apiKey = baseConfig.apiKey;
  }

  // Generic credentials from a different default provider are deliberately
  // removed before merging. A provider switch must never reinterpret a
  // Bailian key as Tavily (or vice versa).
  const base = withoutProviderContainers(baseConfig);
  const selected = withoutProviderContainers(current);
  delete base.apiKey;
  delete selected.apiKey;
  return {
    ...base,
    ...baseProfile,
    ...selected,
    ...currentProfile,
    provider,
    enabled: current ? current.enabled === true : baseConfig.enabled === true,
    apiKey: String(apiKey || ''),
  };
}

function publicClientStatus(client, config) {
  const status = client?.publicStatus?.() || {};
  const enabled = status.enabled === true || (
    status.enabled === undefined && config.enabled === true
  );
  return {
    enabled,
    configured: enabled && (status.configured === true || (
      status.configured === undefined && Boolean(config.apiKey)
    )),
    provider: config.provider,
    ...(config.bindingRevision ? { bindingRevision: String(config.bindingRevision) } : {}),
  };
}

function defaultClientFactories(options = {}) {
  const configured = options.clientFactories && typeof options.clientFactories === 'object'
    ? options.clientFactories
    : {};
  return new Map([
    [BAILIAN_WEB_SEARCH_PROVIDER,
      configured[BAILIAN_WEB_SEARCH_PROVIDER] || options.bailianClientFactory ||
        options.clientFactory || ((config) => new BailianWebSearchClient(config))],
    [TAVILY_WEB_SEARCH_PROVIDER,
      configured[TAVILY_WEB_SEARCH_PROVIDER] || options.tavilyClientFactory ||
        ((config) => new TavilyWebSearchClient(config, options.tavilyOptions))],
  ]);
}

function invalidProviderError(provider) {
  const error = new Error('The selected WebSearch provider is unsupported.');
  error.name = 'WebSearchProviderError';
  error.code = 'WEB_SEARCH_PROVIDER_UNSUPPORTED';
  error.provider = String(provider || '');
  return error;
}

function extractorLease(extractor, provider) {
  let closed = false;
  return Object.freeze({
    provider,
    publicStatus: () => extractor.publicStatus?.() || {
      enabled: true,
      configured: true,
      provider,
    },
    extract: async (options = {}) => {
      if (closed) {
        const error = new Error('The task-scoped Web Extract lease is closed.');
        error.code = 'WEB_EXTRACT_LEASE_CLOSED';
        throw error;
      }
      return extractor.extract(options);
    },
    close: async () => { closed = true; },
  });
}

export class RuntimeWebSearchClient {
  constructor(registry, baseConfig = {}, options = {}) {
    this.registry = registry;
    this.baseConfig = structuredClone(baseConfig || {});
    this.clientFactories = defaultClientFactories(options);
  }

  config() {
    return resolvedWebSearchConfig(runtimeSnapshot(this.registry), this.baseConfig);
  }

  createClient(config = this.config()) {
    const factory = this.clientFactories.get(config.provider);
    if (typeof factory !== 'function') throw invalidProviderError(config.provider);
    return factory({ ...config });
  }

  publicStatus() {
    const config = this.config();
    return publicClientStatus(this.createClient(config), config);
  }

  async resolvedClient(snapshotOverride = null) {
    const refreshed = snapshotOverride ? null : await this.registry?.refresh?.();
    const snapshot = snapshotOverride || runtimeSnapshot(this.registry);
    const config = resolvedWebSearchConfig(snapshot, this.baseConfig);
    return {
      client: this.createClient(config),
      config,
      revision: String(refreshed?.revision || snapshot?.revision || ''),
    };
  }

  async acquireForTask(options = {}) {
    const { client, config, revision } = await this.resolvedClient(options.runtimeSnapshot || null);
    const parentSignal = options.signal;
    let closed = false;
    let sessionPromise = null;
    const target = async () => {
      if (closed) {
        const error = new Error('The task-scoped WebSearch lease is closed.');
        error.code = 'WEB_SEARCH_LEASE_CLOSED';
        throw error;
      }
      if (!sessionPromise) {
        sessionPromise = typeof client.openSession === 'function'
          ? Promise.resolve(client.openSession({ signal: parentSignal }))
          : Promise.resolve(client);
      }
      return sessionPromise;
    };
    const lease = {
      provider: config.provider,
      revision,
      publicStatus: () => publicClientStatus(client, config),
      searchMany: async (queries, childOptions = {}) => {
        const selected = await target();
        if (typeof selected?.searchMany !== 'function') {
          const error = new Error('The WebSearch provider returned an invalid task session.');
          error.code = 'WEB_SEARCH_SESSION_INVALID';
          throw error;
        }
        return selected.searchMany(queries, {
          ...childOptions,
          signal: childOptions.signal || parentSignal,
        });
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (!sessionPromise) return;
        const selected = await sessionPromise.catch(() => null);
        await selected?.close?.();
      },
    };
    return Object.freeze(lease);
  }

  async openSession(options = {}) {
    const { client } = await this.resolvedClient();
    if (typeof client.openSession === 'function') return client.openSession(options);
    return {
      owner: client,
      searchMany: (queries, childOptions = {}) => client.searchMany(queries, {
        ...childOptions,
        signal: childOptions.signal || options.signal,
      }),
      close: async () => {},
    };
  }

  async searchMany(queries, options = {}) {
    const { client } = await this.resolvedClient();
    return client.searchMany(queries, options);
  }
}

function activeBailianCredential(snapshot) {
  const current = snapshot?.webSearch || {};
  const provider = providerId(current.provider);
  const profile = providerProfile(current, BAILIAN_WEB_SEARCH_PROVIDER);
  if (hasOwn(profile, 'apiKey')) return String(profile.apiKey || '');
  if (provider === BAILIAN_WEB_SEARCH_PROVIDER && hasOwn(current, 'apiKey')) {
    return String(current.apiKey || '');
  }
  return '';
}

export class RuntimeResponsesExtractor {
  constructor(registry, baseConfig = {}, options = {}) {
    this.registry = registry;
    this.baseConfig = { ...baseConfig };
    this.extractorFactory = options.extractorFactory
      || ((config) => new BailianResponsesExtractor(config));
  }

  config() {
    const snapshot = runtimeSnapshot(this.registry);
    const current = snapshot?.webSearch || {};
    const activeProvider = providerId(current.provider);
    // Reuse is scoped to Bailian's own credential profile. In particular, an
    // active Tavily credential must never be sent to a Bailian endpoint.
    const reuseWebSearchKey = this.baseConfig.reuseWebSearchKey !== false;
    const apiKey = String(
      reuseWebSearchKey && snapshot
        ? activeBailianCredential(snapshot)
        : this.baseConfig.apiKey || '',
    );
    const bailianWebSearchEnabled = snapshot
      ? current.enabled === true && activeProvider === BAILIAN_WEB_SEARCH_PROVIDER
      : false;
    const bailianProfile = providerProfile(current, BAILIAN_WEB_SEARCH_PROVIDER);
    const extractFallbackEnabled = hasOwn(bailianProfile, 'extractFallbackEnabled')
      ? bailianProfile.extractFallbackEnabled === true
      : hasOwn(current, 'extractFallbackEnabled')
        ? current.extractFallbackEnabled === true
        : true;
    return {
      ...this.baseConfig,
      enabled: this.baseConfig.enabled === true && bailianWebSearchEnabled &&
        extractFallbackEnabled && Boolean(apiKey),
      apiKey,
    };
  }

  publicStatus() {
    const config = this.config();
    return {
      enabled: config.enabled === true,
      configured: config.enabled === true && Boolean(config.apiKey),
      provider: 'bailian-responses',
    };
  }

  async extract(options = {}) {
    await this.registry?.refresh?.();
    return this.extractorFactory(this.config()).extract(options);
  }

  async acquireForTask(options = {}) {
    if (!options.runtimeSnapshot) await this.registry?.refresh?.();
    const config = options.runtimeSnapshot
      ? this.configForSnapshot(options.runtimeSnapshot)
      : this.config();
    return extractorLease(this.extractorFactory(config), 'bailian-responses');
  }

  configForSnapshot(snapshot) {
    const current = snapshot?.webSearch || {};
    const activeProvider = providerId(current.provider);
    const profile = providerProfile(current, BAILIAN_WEB_SEARCH_PROVIDER);
    const apiKey = String(
      this.baseConfig.reuseWebSearchKey !== false
        ? activeBailianCredential(snapshot)
        : this.baseConfig.apiKey || '',
    );
    const extractFallbackEnabled = hasOwn(profile, 'extractFallbackEnabled')
      ? profile.extractFallbackEnabled === true
      : hasOwn(current, 'extractFallbackEnabled')
        ? current.extractFallbackEnabled === true
        : true;
    return {
      ...this.baseConfig,
      enabled: this.baseConfig.enabled === true && current.enabled === true &&
        activeProvider === BAILIAN_WEB_SEARCH_PROVIDER && extractFallbackEnabled && Boolean(apiKey),
      apiKey,
    };
  }
}

export class RuntimeTavilyExtractFallback {
  constructor(registry, baseConfig = {}, options = {}) {
    this.registry = registry;
    this.baseConfig = { ...baseConfig };
    this.extractorFactory = options.extractorFactory
      || ((config) => new TavilyExtractFallback(config, options.tavilyOptions));
  }

  config() {
    const snapshot = runtimeSnapshot(this.registry);
    const webSearch = resolvedWebSearchConfig(snapshot, this.baseConfig.webSearch || {});
    return {
      ...this.baseConfig,
      provider: 'tavily-extract-rest',
      enabled: this.baseConfig.enabled === true && webSearch.enabled === true &&
        webSearch.provider === TAVILY_WEB_SEARCH_PROVIDER &&
        (!hasOwn(webSearch, 'extractFallbackEnabled') ||
          webSearch.extractFallbackEnabled === true) && Boolean(webSearch.apiKey),
      apiKey: webSearch.provider === TAVILY_WEB_SEARCH_PROVIDER ? webSearch.apiKey : '',
    };
  }

  publicStatus() {
    const config = this.config();
    return {
      enabled: config.enabled === true,
      configured: config.enabled === true && Boolean(config.apiKey),
      provider: 'tavily-extract-rest',
    };
  }

  async extract(options = {}) {
    await this.registry?.refresh?.();
    return this.extractorFactory(this.config()).extract(options);
  }

  async acquireForTask(options = {}) {
    if (!options.runtimeSnapshot) await this.registry?.refresh?.();
    const webSearch = resolvedWebSearchConfig(
      options.runtimeSnapshot,
      this.baseConfig.webSearch || {},
    );
    const config = options.runtimeSnapshot ? {
      ...this.baseConfig,
      provider: 'tavily-extract-rest',
      enabled: this.baseConfig.enabled === true && webSearch.enabled === true &&
        webSearch.provider === TAVILY_WEB_SEARCH_PROVIDER &&
        (!hasOwn(webSearch, 'extractFallbackEnabled') ||
          webSearch.extractFallbackEnabled === true) && Boolean(webSearch.apiKey),
      apiKey: webSearch.provider === TAVILY_WEB_SEARCH_PROVIDER ? webSearch.apiKey : '',
    } : this.config();
    return extractorLease(this.extractorFactory(config), 'tavily-extract-rest');
  }
}

export class RuntimeWebExtractFallback {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.bailian = options.bailian || new RuntimeResponsesExtractor(
      registry,
      options.bailianConfig || {},
      options.bailianOptions || {},
    );
    this.tavily = options.tavily || new RuntimeTavilyExtractFallback(
      registry,
      options.tavilyConfig || {},
      options.tavilyOptions || {},
    );
  }

  selected(snapshot = runtimeSnapshot(this.registry)) {
    const provider = providerId(snapshot?.webSearch?.provider);
    if (provider === BAILIAN_WEB_SEARCH_PROVIDER) return this.bailian;
    if (provider === TAVILY_WEB_SEARCH_PROVIDER) return this.tavily;
    throw invalidProviderError(provider);
  }

  publicStatus() {
    return this.selected().publicStatus();
  }

  async acquireForTask(options = {}) {
    const snapshot = options.runtimeSnapshot || runtimeSnapshot(this.registry);
    return this.selected(snapshot).acquireForTask({ ...options, runtimeSnapshot: snapshot });
  }

  async extract(options = {}) {
    const lease = await this.acquireForTask();
    try {
      return await lease.extract(options);
    } finally {
      await lease.close();
    }
  }
}

export const runtimeWebSearchInternals = Object.freeze({
  providerId,
  providerProfile,
  resolvedWebSearchConfig,
  activeBailianCredential,
});
