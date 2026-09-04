import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  KnowledgeBaseRegistry,
  KnowledgeBaseRegistryError,
} from '../src/knowledge-base-registry.mjs';

async function fixture() {
  const created = await fsp.mkdtemp(path.join(os.tmpdir(), 'second-mind-kb-registry-'));
  const root = await fsp.realpath(created);
  const mounts = path.join(root, 'mounts');
  const state = path.join(root, 'state');
  const alpha = path.join(mounts, 'alpha');
  const beta = path.join(mounts, 'beta');
  await Promise.all([
    fsp.mkdir(path.join(alpha, '.obsidian'), { recursive: true }),
    fsp.mkdir(path.join(beta, '.obsidian'), { recursive: true }),
    fsp.mkdir(state, { recursive: true, mode: 0o700 }),
  ]);
  const legacy = {
    knowledgeBaseId: 'default',
    name: 'Example Notes',
    vaultPath: alpha,
    dataDir: state,
    indexDir: path.join(state, 'index'),
    draftDir: path.join(state, 'drafts'),
    recoveryDir: path.join(state, 'recovery'),
    conversationFile: path.join(state, 'conversations.json'),
    auditFile: path.join(state, 'audit.jsonl'),
  };
  const options = {
    managedFile: path.join(state, 'knowledge-bases.json'),
    stateDir: state,
    allowedRoots: [{ id: 'vaults', label: 'Configured Vaults', path: mounts }],
    privateStatePaths: [state],
    legacy,
  };
  return {
    root, mounts, state, alpha, beta, legacy, options,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

function twoBases(expectedRevision, overrides = {}) {
  return {
    expectedRevision,
    knowledgeBases: [
      {
        knowledgeBaseId: 'alpha',
        name: 'Example Alpha',
        mountId: 'vaults',
        relativePath: 'alpha',
        enabled: true,
        default: true,
        ...overrides.alpha,
      },
      {
        knowledgeBaseId: 'beta',
        name: 'Example Beta',
        mountId: 'vaults',
        relativePath: 'beta',
        enabled: true,
        default: false,
        ...overrides.beta,
      },
    ],
  };
}

test('legacy single-Vault configuration becomes a stable default without moving state', async () => {
  const value = await fixture();
  try {
    const registry = new KnowledgeBaseRegistry(value.options);
    const publicValue = await registry.ready;
    assert.equal(publicValue.source, 'legacy');
    assert.equal(publicValue.defaultKnowledgeBaseId, 'default');
    assert.deepEqual(publicValue.knowledgeBases.map((entry) => ({
      id: entry.knowledgeBaseId,
      name: entry.name,
      enabled: entry.enabled,
      default: entry.default,
    })), [{ id: 'default', name: 'Example Notes', enabled: true, default: true }]);
    assert.equal(JSON.stringify(publicValue).includes(value.root), false);

    const internal = registry.resolve('default');
    assert.equal(internal.rootPath, value.alpha);
    assert.equal(internal.state.conversationFile, value.legacy.conversationFile);
    await assert.rejects(fsp.access(value.options.managedFile), { code: 'ENOENT' });
  } finally {
    await value.cleanup();
  }
});

test('two Vaults receive independent private namespaces and a CAS revision', async () => {
  const value = await fixture();
  try {
    const registry = new KnowledgeBaseRegistry(value.options);
    const initial = await registry.ready;
    const updated = await registry.update(twoBases(initial.revision));
    assert.notEqual(updated.revision, initial.revision);
    assert.equal(updated.knowledgeBases.length, 2);
    assert.equal(updated.defaultKnowledgeBaseId, 'alpha');
    assert.equal(JSON.stringify(updated).includes(value.root), false);
    const administrative = registry.administrativeSnapshot();
    assert.deepEqual(administrative.knowledgeBases.map(({ mountId, relativePath }) => ({
      mountId, relativePath,
    })), [
      { mountId: 'vaults', relativePath: 'alpha' },
      { mountId: 'vaults', relativePath: 'beta' },
    ]);
    assert.equal(JSON.stringify(administrative).includes(value.root), false);
    const alpha = registry.resolve('alpha');
    const beta = registry.resolve('beta');
    assert.notEqual(alpha.state.dataDir, beta.state.dataDir);
    assert.match(alpha.state.dataDir, new RegExp(`${path.sep}knowledge-bases${path.sep}alpha-[a-f0-9]{16}$`));
    assert.match(beta.state.dataDir, new RegExp(`${path.sep}knowledge-bases${path.sep}beta-[a-f0-9]{16}$`));
    assert.equal((await fsp.stat(value.options.managedFile)).mode & 0o777, 0o600);
    const bindingFile = `${value.options.managedFile}.bindings`;
    assert.equal((await fsp.stat(bindingFile)).mode & 0o777, 0o600);
    const bindingText = await fsp.readFile(bindingFile, 'utf8');
    assert.equal(bindingText.includes(value.root), false);
    assert.equal(JSON.parse(bindingText).bindings.some((entry) => (
      entry.knowledgeBaseId === 'beta' && /^[a-f0-9]{64}$/u.test(entry.rootDigest)
    )), true);

    await assert.rejects(
      registry.update(twoBases(initial.revision)),
      (error) => error instanceof KnowledgeBaseRegistryError &&
        error.code === 'KNOWLEDGE_BASE_REVISION_CONFLICT' && error.status === 409,
    );
  } finally {
    await value.cleanup();
  }
});

test('duplicate, nested, disabled-default, and state-overlap registrations fail closed', async () => {
  const value = await fixture();
  try {
    const nested = path.join(value.alpha, 'nested');
    await fsp.mkdir(nested);
    const registry = new KnowledgeBaseRegistry(value.options);
    const initial = await registry.ready;
    await assert.rejects(
      registry.update(twoBases(initial.revision, {
        beta: { relativePath: 'alpha/nested' },
      })),
      (error) => error.code === 'NESTED_KNOWLEDGE_BASE_PATH',
    );
    await assert.rejects(
      registry.update(twoBases(initial.revision, {
        beta: { relativePath: 'alpha' },
      })),
      (error) => error.code === 'NESTED_KNOWLEDGE_BASE_PATH',
    );
    await assert.rejects(
      registry.update(twoBases(initial.revision, {
        alpha: { enabled: false, default: true },
      })),
      (error) => error.code === 'KNOWLEDGE_BASE_DEFAULT_REQUIRED',
    );
    const ordinary = path.join(value.mounts, 'ordinary-directory');
    await fsp.mkdir(ordinary);
    await assert.rejects(
      registry.update(twoBases(initial.revision, {
        beta: { relativePath: 'ordinary-directory' },
      })),
      (error) => error.code === 'KNOWLEDGE_BASE_LAYOUT_INVALID',
    );

    const unsafe = new KnowledgeBaseRegistry({
      ...value.options,
      allowedRoots: [{ id: 'state', label: 'Unsafe', path: value.state }],
      legacy: { ...value.legacy, vaultPath: value.state },
    });
    await assert.rejects(unsafe.ready, (error) => error.code === 'KNOWLEDGE_BASE_STATE_OVERLAP');
  } finally {
    await value.cleanup();
  }
});

test('symbolic-link paths and paths outside startup-authorized mounts are rejected', async (t) => {
  const value = await fixture();
  try {
    const link = path.join(value.mounts, 'linked');
    try {
      await fsp.symlink(value.beta, link, 'dir');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('Creating directory symlinks requires a Windows developer-mode permission.');
        return;
      }
      throw error;
    }
    const registry = new KnowledgeBaseRegistry(value.options);
    const initial = await registry.ready;
    await assert.rejects(
      registry.update(twoBases(initial.revision, { beta: { relativePath: 'linked' } })),
      (error) => error.code === 'KNOWLEDGE_BASE_PATH_SYMLINK',
    );
    await assert.rejects(
      registry.update(twoBases(initial.revision, { beta: { relativePath: '../state' } })),
      (error) => error.code === 'KNOWLEDGE_BASE_PATH_OUTSIDE_MOUNT',
    );
  } finally {
    await value.cleanup();
  }
});

test('a corrupt current registry falls back to the previous valid snapshot on restart', async () => {
  const value = await fixture();
  try {
    const first = new KnowledgeBaseRegistry(value.options);
    const initial = await first.ready;
    const two = await first.update(twoBases(initial.revision));
    await first.update({
      expectedRevision: two.revision,
      knowledgeBases: twoBases(two.revision).knowledgeBases.map((entry) => ({
        ...entry,
        name: entry.knowledgeBaseId === 'alpha' ? 'Renamed Alpha' : entry.name,
      })),
    });
    await fsp.writeFile(value.options.managedFile, '{broken', { mode: 0o600 });

    const recovered = new KnowledgeBaseRegistry(value.options);
    const snapshot = await recovered.ready;
    assert.equal(snapshot.source, 'previous');
    assert.equal(snapshot.stale, true);
    assert.equal(snapshot.revision, two.revision);
    assert.deepEqual(snapshot.knowledgeBases.map((entry) => entry.name), ['Example Alpha', 'Example Beta']);
  } finally {
    await value.cleanup();
  }
});

test('removing a registry entry never removes the Vault directory or its notes', async () => {
  const value = await fixture();
  try {
    const note = path.join(value.beta, 'kept.md');
    await fsp.writeFile(note, '# Kept\n');
    const registry = new KnowledgeBaseRegistry(value.options);
    const initial = await registry.ready;
    const two = await registry.update(twoBases(initial.revision));
    await registry.update({
      expectedRevision: two.revision,
      knowledgeBases: [twoBases(two.revision).knowledgeBases[0]],
    });
    assert.equal(await fsp.readFile(note, 'utf8'), '# Kept\n');
    assert.throws(() => registry.resolve('beta'), (error) => error.code === 'KNOWLEDGE_BASE_NOT_FOUND');
  } finally {
    await value.cleanup();
  }
});

test('a stable ID is permanently bound to its first Vault across deletion and restart', async () => {
  const value = await fixture();
  try {
    const gamma = path.join(value.mounts, 'gamma');
    await fsp.mkdir(path.join(gamma, '.obsidian'), { recursive: true });
    const registry = new KnowledgeBaseRegistry(value.options);
    const initial = await registry.ready;
    const two = await registry.update(twoBases(initial.revision));
    const originalBetaState = registry.resolve('beta').state.dataDir;

    await assert.rejects(
      registry.update(twoBases(two.revision, { beta: { relativePath: 'gamma' } })),
      (error) => error.code === 'KNOWLEDGE_BASE_ID_REBIND_FORBIDDEN' && error.status === 409,
    );
    assert.equal(registry.resolve('beta').rootPath, value.beta);

    const withoutBeta = await registry.update({
      expectedRevision: two.revision,
      knowledgeBases: [twoBases(two.revision).knowledgeBases[0]],
    });
    const rebound = {
      expectedRevision: withoutBeta.revision,
      knowledgeBases: [
        twoBases(withoutBeta.revision).knowledgeBases[0],
        { ...twoBases(withoutBeta.revision).knowledgeBases[1], relativePath: 'gamma' },
      ],
    };
    await assert.rejects(
      registry.update(rebound),
      (error) => error.code === 'KNOWLEDGE_BASE_ID_REBIND_FORBIDDEN' && error.status === 409,
    );

    const restarted = new KnowledgeBaseRegistry(value.options);
    const afterRestart = await restarted.ready;
    await assert.rejects(
      restarted.update({ ...rebound, expectedRevision: afterRestart.revision }),
      (error) => error.code === 'KNOWLEDGE_BASE_ID_REBIND_FORBIDDEN' && error.status === 409,
    );
    await restarted.update({
      expectedRevision: afterRestart.revision,
      knowledgeBases: twoBases(afterRestart.revision).knowledgeBases,
    });
    assert.equal(restarted.resolve('beta').rootPath, value.beta);
    assert.equal(restarted.resolve('beta').state.dataDir, originalBetaState);
  } finally {
    await value.cleanup();
  }
});

test('an externally edited registry cannot rebind an ID during refresh', async () => {
  const value = await fixture();
  try {
    const gamma = path.join(value.mounts, 'gamma');
    await fsp.mkdir(path.join(gamma, '.obsidian'), { recursive: true });
    const registry = new KnowledgeBaseRegistry(value.options);
    const initial = await registry.ready;
    await registry.update(twoBases(initial.revision));
    const raw = JSON.parse(await fsp.readFile(value.options.managedFile, 'utf8'));
    raw.revision = 'external-rebind-attempt';
    raw.knowledgeBases = raw.knowledgeBases.map((entry) => (
      entry.knowledgeBaseId === 'beta' ? { ...entry, relativePath: 'gamma' } : entry
    ));
    await fsp.writeFile(value.options.managedFile, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    const snapshot = await registry.refresh();
    assert.equal(snapshot.stale, true);
    assert.equal(registry.resolve('beta').rootPath, value.beta);
    assert.equal(registry.runtimeSnapshot().revision !== 'external-rebind-attempt', true);
  } finally {
    await value.cleanup();
  }
});

test('a previously registered unavailable Vault is isolated instead of invalidating healthy entries', async () => {
  const value = await fixture();
  try {
    const first = new KnowledgeBaseRegistry(value.options);
    const initial = await first.ready;
    await first.update(twoBases(initial.revision));
    await fsp.rm(value.beta, { recursive: true, force: true });

    const restarted = new KnowledgeBaseRegistry(value.options);
    const snapshot = await restarted.ready;
    assert.equal(snapshot.knowledgeBases.length, 2);
    assert.equal(restarted.resolve('alpha').unavailableCode, '');
    assert.equal(restarted.resolve('beta').unavailableCode, 'KNOWLEDGE_BASE_PATH_UNAVAILABLE');
    assert.equal(JSON.stringify(snapshot).includes(value.root), false);
  } finally {
    await value.cleanup();
  }
});
