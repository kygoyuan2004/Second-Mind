import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function temporaryProject(prefix = 'vaultmind-test-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const vaultPath = path.join(root, 'vault');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(vaultPath, { recursive: true });
  return {
    root,
    vaultPath,
    dataDir,
    config: {
      vaultPath,
      dataDir,
      indexDir: path.join(dataDir, 'index'),
      draftDir: path.join(dataDir, 'drafts'),
      recoveryDir: path.join(dataDir, 'recovery'),
      conversationFile: path.join(dataDir, 'conversations.json'),
      auditFile: path.join(dataDir, 'audit.jsonl'),
      autoCreateVaultPaths: true,
      paths: {
        diary: 'VaultMind/Diary',
        plan: 'VaultMind/Plans',
        scratch: 'VaultMind/Inbox',
      },
      templates: { diary: '', plan: '' },
      excludedPaths: ['.obsidian', '.trash', '.git', '.livesync'],
      limits: {
        attachmentCount: 8,
        attachmentBytes: 1024 * 1024,
        attachmentTotalBytes: 2 * 1024 * 1024,
        recoveryRetentionDays: 30,
        jsonBodyBytes: 4 * 1024 * 1024,
      },
    },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}
