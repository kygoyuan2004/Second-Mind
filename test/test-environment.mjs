import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nativeHelperPath } from '../platform/private-storage.mjs';

// Darwin commonly exposes its temporary root through /var even though the
// canonical path begins with /private/var. Security tests intentionally compare
// lexical and canonical paths, so make only the test sandbox root canonical.
let canonicalTempRoot = fs.realpathSync.native(os.tmpdir());
if (process.platform === 'win32') {
  // Production creates an ACL-protected app root. Give test fixtures the same
  // inheritance rather than weakening storage checks for the Windows runner.
  canonicalTempRoot = fs.mkdtempSync(path.join(canonicalTempRoot, 'second-mind-tests-'));
  execFileSync(nativeHelperPath(), ['protect', canonicalTempRoot], { windowsHide: true });
  process.on('exit', () => { try { fs.rmSync(canonicalTempRoot, { recursive: true, force: true }); } catch {} });
}
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = canonicalTempRoot;
