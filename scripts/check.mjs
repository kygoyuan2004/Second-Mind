import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = ['src', 'scripts', 'public', 'test'];
const files = [];

async function walk(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (['node_modules', 'vendor'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) files.push(target);
  }
}

for (const directory of roots) await walk(path.join(root, directory));
for (const filename of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exitCode = 1;
  }
}
for (const filename of ['package.json']) JSON.parse(await fsp.readFile(path.join(root, filename), 'utf8'));
if (process.exitCode) process.exit(process.exitCode);
console.log(`Syntax checked ${files.length} JavaScript files.`);
