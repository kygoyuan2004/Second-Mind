import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkReleaseManifest } from '../scripts/download-page.mjs';

test('Mac download labels must point to the file for the named CPU', async () => {
  const manifest = JSON.parse(await readFile(new URL('../site/releases.json', import.meta.url)));
  checkReleaseManifest(manifest);
  const mac = manifest.editions.find(e => e.id === 'pi').assets.filter(file => file.os === 'macos');
  assert.equal(mac.length, 2);
  [mac[0].arch, mac[1].arch] = [mac[1].arch, mac[0].arch];
  assert.throws(() => checkReleaseManifest(manifest), /does not match its platform and architecture/);
});

test('a preview has its own release tag, image and port', async () => {
  const manifest = JSON.parse(await readFile(new URL('../site/releases.json', import.meta.url)));
  const stable = manifest.editions.find(edition => edition.id === 'pi');
  for (const field of ['release', 'checksums', 'image', 'port']) {
    const changed = structuredClone(manifest);
    changed.preview[field] = stable[field];
    assert.throws(() => checkReleaseManifest(changed), /Invalid release metadata/);
  }
  delete manifest.preview;
  checkReleaseManifest(manifest, true);
});
