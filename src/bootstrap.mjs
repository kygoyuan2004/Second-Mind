import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createConfig } from './config.mjs';
import { KnowledgeBaseRegistry } from './knowledge-base-registry.mjs';
import { publicError } from './public-errors.mjs';
import {
  RuntimeConfigRegistry,
  runtimeConfigInternals,
} from './runtime-config-registry.mjs';
import { startServer } from './server.mjs';

const RUNTIME_DIRECTORY = 'runtime';

function validOpaqueCredential(value) {
  const credential = String(value || '').trim();
  return credential.length >= 8 && credential.length <= 16_384 &&
    !/[\s\u0000-\u001f\u007f]/u.test(credential);
}

function modelDefaults(config) {
  const source = Array.isArray(config.modelCatalog)
    ? config.modelCatalog
    : String(config.llm?.model || '').trim()
      ? [{
          id: 'configured',
          label: String(config.llm.model),
          shortLabel: String(config.llm.model),
          actualModel: String(config.llm.model),
          provider: String(config.llm.provider || 'openai-compatible'),
          efforts: ['default'],
          defaultEffort: 'default',
          available: true,
          capabilityVerified: true,
        }]
      : [];
  if (!source.length || !source.some((model) => model?.available !== false)) return [];
  try {
    runtimeConfigInternals.safeModelApiBase(config.llm?.apiBase, 'llm.apiBase');
  } catch {
    // Managed provider destinations are intentionally limited to public HTTPS.
    // A legacy loopback/private provider remains available through the static
    // `node src/server.mjs` entry point, but is never copied into managed state.
    return [];
  }
  const protocol = String(config.llm?.protocol || (
    config.llm?.provider === 'anthropic'
      ? 'anthropic-messages'
      : 'openai-chat-completions'
  )).trim().toLowerCase();
  const authMode = String(config.llm?.authMode || (
    protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'
  )).trim().toLowerCase();
  if (authMode !== 'none' && !validOpaqueCredential(config.llm?.apiKey)) return [];
  return source;
}

function embeddingDefaults(config) {
  const source = config.embedding || {};
  if (source.provider === 'disabled') {
    return {
      provider: 'disabled', apiBase: '', apiKey: '', model: '',
      dimensions: Number(source.dimensions) || 1_024,
    };
  }
  try {
    runtimeConfigInternals.safeEmbeddingUrl(source.apiBase);
  } catch {
    return {
      provider: 'disabled', apiBase: '', apiKey: '', model: '',
      dimensions: Number(source.dimensions) || 1_024,
    };
  }
  return {
    provider: source.provider,
    apiBase: source.apiBase,
    apiKey: validOpaqueCredential(source.apiKey) ? source.apiKey : '',
    model: source.model,
    dimensions: source.dimensions,
  };
}

function managedServerConfig(baseConfig, snapshot) {
  const selectedModel = snapshot.models.find((model) => (
    model.id === snapshot.defaultModelId && model.available !== false
  )) || snapshot.models.find((model) => model.available !== false) || null;
  return {
    ...baseConfig,
    appName: String(snapshot.branding?.appName || baseConfig.appName || 'Second Mind'),
    vaultLabel: String(snapshot.branding?.vaultLabel || baseConfig.vaultLabel || 'Knowledge Base'),
    runtimeManagedProviders: true,
    modelCatalog: snapshot.models,
    llm: {
      ...baseConfig.llm,
      apiKey: '',
      model: selectedModel?.actualModel || '',
    },
    // Desired Embedding settings live in the registry. They become active only
    // after the explicit validate/build/atomic-activate workflow has produced a
    // slot manifest. The fresh base index therefore remains lexical-only and
    // cannot make a provider request during process startup.
    embedding: {
      ...baseConfig.embedding,
      provider: 'disabled',
      apiBase: '',
      endpoint: '',
      apiKey: '',
      model: '',
    },
    webSearch: {
      ...baseConfig.webSearch,
      provider: snapshot.webSearch?.provider || baseConfig.webSearch?.provider || 'bailian-mcp',
      enabled: snapshot.webSearch?.enabled === true,
      apiKey: '',
    },
    responsesFallback: {
      ...baseConfig.responsesFallback,
      apiKey: '',
      reuseWebSearchKey: true,
    },
  };
}

export function runtimeBootstrapPaths(dataDir) {
  const runtimeRoot = path.resolve(dataDir, RUNTIME_DIRECTORY);
  return Object.freeze({
    runtimeRoot,
    managedFile: path.join(runtimeRoot, 'runtime-config.json'),
    backupFile: path.join(runtimeRoot, 'runtime-config.last-good.json'),
    knowledgeBaseFile: path.join(runtimeRoot, 'knowledge-bases.json'),
    activeProfileFile: path.join(runtimeRoot, 'embedding-active.json'),
    slotsRoot: path.join(runtimeRoot, 'embedding-slots'),
  });
}

function configuredAllowedRoots(baseConfig, options = {}) {
  const explicit = options.allowedRoots || String(
    process.env.KNOWLEDGE_BASE_ALLOWED_ROOTS || '',
  ).split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  const inputs = Array.isArray(explicit) && explicit.length ? explicit : [baseConfig.vaultPath];
  return inputs.map((entry, index) => {
    const value = entry && typeof entry === 'object' ? entry : { path: entry };
    return {
      id: String(value.id || `vaults-${index + 1}`),
      label: String(value.label || `Allowed Vaults ${index + 1}`),
      path: path.resolve(String(value.path || '')),
    };
  });
}

function stableDiscoveredId(mountId, relativePath, name) {
  const slug = String(name || 'vault').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 36) || 'vault';
  const suffix = crypto.createHash('sha256')
    .update(`${mountId}\0${relativePath}`).digest('hex').slice(0, 10);
  return `${slug}-${suffix}`;
}

async function discoverMountedVaults(allowedRoots) {
  const discovered = [];
  for (const mount of allowedRoots) {
    const root = await fsp.realpath(mount.path);
    const rootMarker = await fsp.lstat(path.join(root, '.obsidian')).catch(() => null);
    if (rootMarker?.isDirectory()) continue;
    const children = await fsp.readdir(root, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!child.isDirectory() || child.isSymbolicLink?.()) continue;
      const marker = await fsp.lstat(path.join(root, child.name, '.obsidian')).catch(() => null);
      if (!marker?.isDirectory()) continue;
      discovered.push({
        knowledgeBaseId: stableDiscoveredId(mount.id, child.name, child.name),
        name: child.name,
        mountId: mount.id,
        relativePath: child.name,
        enabled: true,
        default: discovered.length === 0,
      });
    }
  }
  return discovered.slice(0, 32);
}

export async function createRuntimeBootstrap(options = {}) {
  const baseConfig = options.config || createConfig(options.configOverrides || {});
  const paths = runtimeBootstrapPaths(baseConfig.dataDir);
  const suppliedDependencies = options.dependencies || {};
  const runtimeConfig = options.runtimeConfig || suppliedDependencies.runtimeConfig ||
    new RuntimeConfigRegistry({
      managedFile: paths.managedFile,
      backupFile: paths.backupFile,
      modelCatalog: modelDefaults(baseConfig),
      llm: baseConfig.llm,
      embedding: embeddingDefaults(baseConfig),
      webSearch: {
        ...baseConfig.webSearch,
        apiKey: validOpaqueCredential(baseConfig.webSearch?.apiKey)
          ? baseConfig.webSearch.apiKey
          : '',
      },
      branding: {
        appName: baseConfig.appName || 'Second Mind',
        vaultLabel: baseConfig.vaultLabel || 'Knowledge Base',
      },
    });
  await runtimeConfig.ready;
  let publicSnapshot = runtimeConfig.publicSnapshot();
  if (publicSnapshot.version !== 2 && publicSnapshot.stale !== true) {
    publicSnapshot = await runtimeConfig.bootstrapManagedV2({
      branding: {
        appName: baseConfig.appName || 'Second Mind',
        vaultLabel: baseConfig.vaultLabel || 'Knowledge Base',
      },
    });
  }
  const privateSnapshot = runtimeConfig.runtimeSnapshot();
  const config = managedServerConfig(baseConfig, privateSnapshot);
  const allowedRoots = configuredAllowedRoots(baseConfig, options);
  const knowledgeBaseRegistry = options.knowledgeBaseRegistry || suppliedDependencies.knowledgeBaseRegistry ||
    new KnowledgeBaseRegistry({
      managedFile: paths.knowledgeBaseFile,
      stateDir: baseConfig.dataDir,
      allowedRoots,
      privateStatePaths: [baseConfig.dataDir, paths.runtimeRoot],
      legacy: {
        knowledgeBaseId: 'default',
        name: baseConfig.vaultLabel || 'Knowledge Base',
        vaultPath: baseConfig.vaultPath,
        dataDir: baseConfig.dataDir,
        indexDir: baseConfig.indexDir,
        draftDir: baseConfig.draftDir,
        recoveryDir: baseConfig.recoveryDir,
        conversationFile: baseConfig.conversationFile,
        auditFile: baseConfig.auditFile,
        embeddingProfileFile: paths.activeProfileFile,
        embeddingSlotsRoot: paths.slotsRoot,
      },
    });
  await knowledgeBaseRegistry.ready;
  if (
    knowledgeBaseRegistry.publicSnapshot().source === 'legacy'
    && options.autoDiscoverKnowledgeBases !== false
  ) {
    const discovered = await discoverMountedVaults(allowedRoots);
    if (discovered.length) {
      await knowledgeBaseRegistry.update({
        expectedRevision: knowledgeBaseRegistry.publicSnapshot().revision,
        knowledgeBases: discovered,
      });
    }
  }
  return {
    config,
    paths,
    runtimeConfig,
    knowledgeBaseRegistry,
    publicSnapshot,
    dependencies: {
      ...suppliedDependencies,
      runtimeConfig,
      knowledgeBaseRegistry,
      embeddingRuntimeOptions: {
        activeProfileFile: paths.activeProfileFile,
        slotsRoot: paths.slotsRoot,
        ...(suppliedDependencies.embeddingRuntimeOptions || {}),
      },
    },
  };
}

export async function startApplication(options = {}) {
  const bootstrap = await createRuntimeBootstrap(options);
  return startServer({ config: bootstrap.config, dependencies: bootstrap.dependencies });
}

const launchedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (launchedDirectly) {
  startApplication().then((app) => {
    const close = async () => {
      if (app.knowledgeBaseHub) await app.knowledgeBaseHub.close();
      else await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    };
    process.once('SIGINT', () => close().finally(() => process.exit(0)));
    process.once('SIGTERM', () => close().finally(() => process.exit(0)));
  }).catch((error) => {
    const failure = publicError(error, {
      fallbackCode: 'STARTUP_FAILED',
      fallbackMessage: 'Second Mind could not start. Check the configuration and filesystem permissions.',
    });
    console.error('[second-mind]', failure.code, failure.message);
    process.exitCode = 1;
  });
}

export const bootstrapInternals = Object.freeze({
  validOpaqueCredential,
  modelDefaults,
  embeddingDefaults,
  managedServerConfig,
  configuredAllowedRoots,
  stableDiscoveredId,
  discoverMountedVaults,
});
