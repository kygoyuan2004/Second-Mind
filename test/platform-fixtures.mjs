import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { protectPrivatePath, verifyPrivatePath } from '../platform/private-storage.mjs';

export async function assertPrivateMode(filename, mode = 0o600) {
  if (process.platform === 'win32') await verifyPrivatePath(filename);
  else assert.equal((await fs.stat(filename)).mode & 0o777, mode);
}

// Exercise the same unsafe-permission scenarios using real Windows ACLs.
export async function setTestPermissions(filename, mode) {
  if (process.platform !== 'win32') return fs.chmod(filename, mode);
  if ((mode & 0o077) === 0 && mode !== 0) {
    await promisify(execFile)('icacls.exe', [filename, '/remove:d', '*S-1-1-0'], { windowsHide: true });
    return protectPrivatePath(filename);
  }
  const args = mode === 0
    // Deny file data / directory listing while leaving stat and ACL inspection
    // readable, matching POSIX mode 000 rather than denying metadata as well.
    ? [filename, '/deny', '*S-1-1-0:(RD)']
    : [filename, '/grant', `*S-1-1-0:(${mode & 0o022 ? 'F' : 'R'})`];
  await promisify(execFile)('icacls.exe', args, { windowsHide: true });
}
