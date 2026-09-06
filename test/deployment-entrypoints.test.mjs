import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('supported npm, container, and systemd entry points use the managed bootstrap', async () => {
  const packageDocument = JSON.parse(await fsp.readFile(
    path.join(projectRoot, 'package.json'),
    'utf8',
  ));
  const dockerfile = await fsp.readFile(path.join(projectRoot, 'Dockerfile'), 'utf8');
  const systemd = await fsp.readFile(
    path.join(projectRoot, 'deploy', 'systemd', 'vaultmind.service.example'),
    'utf8',
  );

  assert.match(packageDocument.scripts.start, /\bsrc\/bootstrap\.mjs\b/u);
  assert.doesNotMatch(packageDocument.scripts.start, /\bsrc\/server\.mjs\b/u);
  assert.match(dockerfile, /CMD \["node", "src\/bootstrap\.mjs"\]/u);
  assert.doesNotMatch(dockerfile, /CMD \["node", "src\/server\.mjs"\]/u);
  assert.match(systemd, /ExecStart=.*\/src\/bootstrap\.mjs"/u);
  assert.doesNotMatch(systemd, /ExecStart=.*\/src\/server\.mjs"/u);
});
