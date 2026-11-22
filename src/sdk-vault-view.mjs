import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ensurePrivateDirectory, isInsidePath } from '../platform/private-storage.mjs';
import { VaultPathPolicy } from './path-policy.mjs';
import { readFileRecord } from './vault-replica.mjs';

export class SdkVaultViews {
  constructor(config) {
    this.config = config;
    this.directory = path.join(config.dataDir, 'sdk-read-views');
    this.leases = new Map();
  }

  async open(conversationId, signal) {
    const key = createHash('sha256').update(conversationId).digest('hex');
    const directory = path.join(this.directory, key);
    const policy = await new VaultPathPolicy(this.config.vaultPath, this.config.excludedPaths).initialize();
    if (isInsidePath(policy.realRoot, directory)) throw new Error('SDK 临时读取目录必须位于知识库之外。');
    // A conversation resumes from the same working directory. Wait for its previous
    // SDK process and cleanup before rebuilding that view from the current notes.
    const previous = this.leases.get(key);
    let unlock;
    const current = new Promise((resolve) => { unlock = resolve; });
    this.leases.set(key, current);
    await previous;
    const clearView = () => fs.rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    const release = async () => {
      try { await clearView(); }
      finally {
        unlock();
        if (this.leases.get(key) === current) this.leases.delete(key);
      }
    };
    try {
      signal?.throwIfAborted();
      await ensurePrivateDirectory(this.directory);
      await clearView();
      await fs.mkdir(directory, { mode: 0o700 });
      for await (const relative of policy.walk()) {
        signal?.throwIfAborted();
        const { target, stat } = await policy.existingFile(relative);
        const copy = path.join(directory, relative);
        await fs.mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
        await readFileRecord(target, copy, signal, stat);
      }
      return { directory, release };
    } catch (error) {
      await release();
      throw error;
    }
  }
}
