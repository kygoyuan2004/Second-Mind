import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { checkReleaseManifest } from './download-page.mjs';

const source = new URL('../site/releases.json', import.meta.url);
const manifest = JSON.parse(await fs.readFile(source));
const checkOnly = process.argv.includes('--check');
for (const edition of manifest.editions) {
  const api = await fetch('https://api.github.com/repos' + new URL(edition.repo).pathname + '/releases/tags/v' + edition.version);
  if (!api.ok) throw new Error(edition.name + ' release metadata HTTP ' + api.status);
  const release = await api.json();
  assert.equal(release.tag_name, 'v' + edition.version);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  const files = new Map(release.assets.map(file => [file.name, file]));
  const sums = files.get('SHA256SUMS.txt');
  assert.equal(sums?.browser_download_url, edition.checksums);
  const download = await fetch(edition.checksums);
  if (!download.ok) throw new Error('Could not download checksums for ' + edition.name);
  const text = Buffer.from(await download.arrayBuffer());
  assert.equal('sha256:' + createHash('sha256').update(text).digest('hex'), sums.digest);
  const hashes = new Map();
  for (const line of text.toString('utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *]([\w.-]+)$/u.exec(line);
    assert.ok(match, 'Malformed checksum line');
    assert.ok(!hashes.has(match[2]), 'Duplicate checksum');
    hashes.set(match[2], match[1]);
  }
  assert.equal(hashes.size, edition.assets.length);
  for (const file of edition.assets) {
    const actual = files.get(file.name);
    const sha = hashes.get(file.name);
    assert.ok(sha && actual?.size > 0, file.name);
    assert.equal(actual.browser_download_url, file.url);
    assert.equal(actual.digest, 'sha256:' + sha, file.name);
    if (checkOnly) {
      assert.equal(file.sha256, sha, file.name);
      assert.equal(file.bytes, actual.size, file.name);
    } else {
      file.sha256 = sha;
      file.bytes = actual.size;
    }
  }
}
checkReleaseManifest(manifest, true);
if (!checkOnly) await fs.writeFile(source, JSON.stringify(manifest, null, 2) + '\n');
console.log('Public release files, sizes and SHA-256 records match.');
