import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRuntimeBootstrap } from '../src/bootstrap.mjs';
import { createConfig } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { temporaryProject } from './helpers.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_PASSWORD = 'runtime bootstrap fixture password';
const LLM_CREDENTIAL = ['llm', 'bootstrap', 'fixture', 'credential'].join('-');
const EMBEDDING_CREDENTIAL = ['embedding', 'bootstrap', 'fixture', 'credential'].join('-');
const WEB_CREDENTIAL = ['web', 'bootstrap', 'fixture', 'credential'].join('-');

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  return { response, body: await response.json() };
}

test('repository bootstrap remains offline and useful with an empty LLM catalog', async () => {
  const project = await temporaryProject('second-mind-runtime-bootstrap-');
  const originalFetch = globalThis.fetch;
  let externalFetches = 0;
  let embeddingFetches = 0;
  let llmCalls = 0;
  let app = null;
  globalThis.fetch = async (input, init) => {
    const target = new URL(String(input));
    if (['127.0.0.1', 'localhost'].includes(target.hostname)) {
      return originalFetch(input, init);
    }
    externalFetches += 1;
    throw new Error('Unexpected outbound fetch in runtime bootstrap test.');
  };
  try {
    await fsp.mkdir(path.join(project.vaultPath, '.obsidian'), { recursive: true });
    await fsp.mkdir(path.join(project.vaultPath, 'Notes'), { recursive: true });
    await fsp.writeFile(
      path.join(project.vaultPath, 'Notes', 'Bootstrap.md'),
      '# Bootstrap\n\nlexicalbootstrapmarker is available without a language model.\n',
    );
    const config = createConfig({
      ...project.config,
      projectRoot,
      publicDir: path.join(projectRoot, 'public'),
      appName: 'Second Mind',
      vaultLabel: 'Bootstrap Fixture Vault',
      host: '127.0.0.1',
      port: 0,
      timezone: 'UTC',
      trustProxy: false,
      auth: {
        username: 'admin',
        password: ADMIN_PASSWORD,
        sessionSecret: ['test', 'only', 'bootstrap', 'session', 'fixture', 'value'].join('-'),
        sessionTtlSeconds: 3_600,
        secureCookie: false,
      },
      llm: {
        provider: 'openai-compatible',
        apiBase: 'https://models.example.com/v1',
        apiKey: LLM_CREDENTIAL,
        model: '',
        timeoutMs: 1_000,
        maxOutputTokens: 256,
        temperature: 0,
        allowInsecureHttp: false,
      },
      embedding: {
        provider: 'openai-compatible',
        apiBase: 'https://embeddings.example.com/v1',
        endpoint: '',
        apiKey: EMBEDDING_CREDENTIAL,
        model: 'fixture-embedding-model',
        dimensions: 128,
        batchSize: 2,
        timeoutMs: 1_000,
        allowInsecureHttp: false,
      },
      webSearch: {
        provider: 'bailian-mcp',
        enabled: true,
        apiKey: WEB_CREDENTIAL,
        timeoutMs: 1_000,
        resultCount: 5,
        deepResultCount: 3,
        maxResultsPerDomain: 2,
        modelSourceLimit: 5,
        maxContextChars: 10_000,
        officialDomains: [],
      },
      webReader: { enabled: false, pdfEnabled: false },
      responsesFallback: { enabled: false },
      retrieval: { topK: 8, maxContextChars: 10_000, watch: false, reconcileIntervalMs: 60_000 },
      deep: { enabled: true, topK: 12 },
      sync: { provider: 'filesystem', displayName: 'Fixture filesystem' },
    });
    const bootstrap = await createRuntimeBootstrap({
      config,
      dependencies: {
        llm: {
          publicStatus: () => ({ configured: false }),
          generate: async () => {
            llmCalls += 1;
            return 'unexpected';
          },
        },
        embeddingRuntimeOptions: {
          embeddingFetch: async () => {
            embeddingFetches += 1;
            throw new Error('Unexpected embedding request in runtime bootstrap test.');
          },
        },
      },
    });
    for (const filename of [
      bootstrap.paths.managedFile,
      bootstrap.paths.backupFile,
      bootstrap.paths.activeProfileFile,
      bootstrap.paths.slotsRoot,
    ]) {
      const relative = path.relative(project.dataDir, filename);
      assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
    }
    assert.deepEqual(bootstrap.publicSnapshot.models, []);
    assert.equal(bootstrap.config.embedding.provider, 'disabled');
    assert.equal(bootstrap.runtimeConfig.runtimeSnapshot().embedding.provider, 'openai-compatible');
    assert.equal((await fsp.stat(bootstrap.paths.managedFile)).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(bootstrap.paths.backupFile)).mode & 0o777, 0o600);

    app = await startServer({ config: bootstrap.config, dependencies: bootstrap.dependencies });
    await app.ready;
    const base = `http://127.0.0.1:${app.port}`;
    assert.equal((await requestJson(base, '/health/live')).response.status, 200);
    assert.equal((await requestJson(base, '/health/ready')).response.status, 200);

    const login = await requestJson(base, '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vaultmind-request': '1' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get('set-cookie');
    const headers = { cookie, 'content-type': 'application/json', 'x-vaultmind-request': '1' };

    const session = await requestJson(base, '/api/session', { headers: { cookie } });
    assert.equal(session.body.permissions.manageRuntimeConfig, true);
    const admin = await requestJson(base, '/api/admin/provider-config', { headers });
    assert.equal(admin.response.status, 200);
    assert.deepEqual(admin.body.providers, []);
    assert.equal(admin.body.defaultModelId, '');
    assert.doesNotMatch(
      JSON.stringify(admin.body),
      new RegExp(`${LLM_CREDENTIAL}|${EMBEDDING_CREDENTIAL}|${WEB_CREDENTIAL}`, 'u'),
    );

    const status = await requestJson(base, '/api/knowledge/status', { headers: { cookie } });
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body.models, []);
    assert.equal(status.body.defaultModelId, null);
    assert.equal(status.body.llm.configured, false);
    assert.equal(status.body.llm.model, null);
    assert.equal(status.body.embedding.enabled, false);
    assert.doesNotMatch(
      JSON.stringify(status.body),
      new RegExp(`${LLM_CREDENTIAL}|${EMBEDDING_CREDENTIAL}|${WEB_CREDENTIAL}|models\.example|embeddings\.example`, 'u'),
    );

    const search = await requestJson(
      base,
      '/api/knowledge/search?q=lexicalbootstrapmarker&mode=keyword',
      { headers: { cookie } },
    );
    assert.equal(search.response.status, 200);
    assert.equal(search.body.results[0].path, 'Notes/Bootstrap.md');

    const rejected = await requestJson(base, '/api/knowledge/tasks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'qa', prompt: 'Answer without a configured model.' }),
    });
    assert.equal(rejected.response.status, 503);
    assert.equal(rejected.body.error, 'LLM_NOT_CONFIGURED');
    const conversations = await requestJson(base, '/api/knowledge/conversations', {
      headers: { cookie },
    });
    assert.deepEqual(conversations.body.conversations, []);
    assert.equal(app.manager.tasks.size, 0);
    const draftEntries = await fsp.readdir(project.config.draftDir).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(draftEntries, []);
    assert.equal(llmCalls, 0);
    assert.equal(embeddingFetches, 0);
    assert.equal(externalFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (app) {
      await app.manager.close();
      await new Promise((resolve) => app.server.close(resolve));
    }
    await project.cleanup();
  }
});

test('explicit Vault mounts discover immediate Obsidian children with stable isolated identities', async () => {
  const project = await temporaryProject('second-mind-runtime-discovery-');
  try {
    const alpha = path.join(project.vaultPath, 'Alpha Notes');
    const beta = path.join(project.vaultPath, '中文资料');
    await Promise.all([
      fsp.mkdir(path.join(alpha, '.obsidian'), { recursive: true }),
      fsp.mkdir(path.join(beta, '.obsidian'), { recursive: true }),
      fsp.mkdir(path.join(project.vaultPath, 'ordinary-folder'), { recursive: true }),
    ]);
    const config = createConfig({
      ...project.config,
      projectRoot,
      publicDir: path.join(projectRoot, 'public'),
      appName: 'Second Mind',
      vaultLabel: 'Discovery Root',
      retrieval: { ...project.config.retrieval, watch: false },
      llm: { ...project.config.llm, model: '', apiKey: '' },
      embedding: { ...project.config.embedding, provider: 'disabled', apiKey: '' },
      webSearch: { ...project.config.webSearch, enabled: false, apiKey: '' },
      responsesFallback: { ...project.config.responsesFallback, enabled: false, apiKey: '' },
    });
    const allowedRoots = [{ id: 'vaults', label: 'Configured Vaults', path: project.vaultPath }];
    const first = await createRuntimeBootstrap({ config, allowedRoots });
    const firstSnapshot = first.knowledgeBaseRegistry.administrativeSnapshot();
    assert.equal(firstSnapshot.source, 'managed');
    assert.deepEqual(firstSnapshot.knowledgeBases.map((entry) => entry.name), ['Alpha Notes', '中文资料']);
    assert.deepEqual(firstSnapshot.knowledgeBases.map((entry) => entry.relativePath), ['Alpha Notes', '中文资料']);
    assert.equal(firstSnapshot.knowledgeBases[0].default, true);
    assert.equal(firstSnapshot.knowledgeBases[1].default, false);
    assert.ok(firstSnapshot.knowledgeBases.every((entry) => /^[a-z0-9][a-z0-9.-]{0,63}$/u.test(entry.knowledgeBaseId)));
    assert.equal(new Set(firstSnapshot.knowledgeBases.map((entry) => entry.knowledgeBaseId)).size, 2);
    assert.equal((await fsp.stat(first.paths.knowledgeBaseFile)).mode & 0o777, 0o600);

    const runtimeEntries = first.knowledgeBaseRegistry.runtimeSnapshot().knowledgeBases;
    assert.notEqual(runtimeEntries[0].state.dataDir, runtimeEntries[1].state.dataDir);
    assert.ok(runtimeEntries.every((entry) => entry.state.dataDir.startsWith(project.dataDir)));

    const second = await createRuntimeBootstrap({ config, allowedRoots });
    const secondSnapshot = second.knowledgeBaseRegistry.administrativeSnapshot();
    assert.deepEqual(
      secondSnapshot.knowledgeBases.map((entry) => entry.knowledgeBaseId),
      firstSnapshot.knowledgeBases.map((entry) => entry.knowledgeBaseId),
    );
    assert.equal(secondSnapshot.revision, firstSnapshot.revision);
  } finally {
    await project.cleanup();
  }
});
