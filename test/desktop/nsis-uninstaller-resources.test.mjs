import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { extractNsisUninstallerBuffer } from '../../scripts/nsis-uninstaller-resources.mjs';

const intermediate = await fs.readFile(new URL('../fixtures/nsis/uninstaller-intermediate.exe', import.meta.url));
const offset = 36864;

function blocksFromFixture() {
  const result = [];
  let position = offset + 28;
  while (position < intermediate.length - 4) {
    const size = intermediate.readUInt32LE(position);
    position += 4;
    const bytes = intermediate.subarray(position, position + (size & 0x7fffffff));
    result.push(Buffer.from(size & 0x80000000 ? inflateRawSync(bytes) : bytes));
    position += size & 0x7fffffff;
  }
  return result;
}

function repack(blocks, { flags = intermediate.readUInt32LE(offset) } = {}) {
  const packed = blocks.flatMap((block) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(block.length);
    return [size, block];
  });
  const result = Buffer.concat([intermediate.subarray(0, offset + 28), ...packed, Buffer.alloc(4)]);
  result.writeUInt32LE(flags, offset);
  result.writeUInt32LE(result.length - offset, offset + 24);
  result.writeUInt32LE(crc32(result.subarray(512, -4)), result.length - 4);
  return result;
}

test('NSIS extracted resource patches produce the exact Windows native WriteUninstaller bytes', () => {
  const extracted = extractNsisUninstallerBuffer(intermediate);
  assert.equal(createHash('sha256').update(extracted).digest('hex'), '4b8e798b57d577b7ee658a1dcb993c9fed29f7ada41d9288881d2a2b0ca7a739');
  assert.equal(extracted.readUInt32LE(offset) & 8, 8, 'forced CRC remains enabled');
  assert.equal(crc32(extracted.subarray(512, -4)), extracted.readUInt32LE(extracted.length - 4));
});

test('NSIS extraction rejects corrupt input and disabled CRC', () => {
  const corrupt = Buffer.from(intermediate);
  corrupt[1024] ^= 1;
  assert.throws(() => extractNsisUninstallerBuffer(corrupt), /CRC mismatch/);
  assert.throws(() => extractNsisUninstallerBuffer(repack(blocksFromFixture(), { flags: 4 })), /CRC must remain enabled/);
});

test('NSIS extraction refuses missing and out-of-bounds resource patches', () => {
  const missing = blocksFromFixture();
  missing.splice(1, 1);
  assert.throws(() => extractNsisUninstallerBuffer(repack(missing)), /resource patch/);
  const outOfBounds = blocksFromFixture();
  outOfBounds[1].writeUInt32LE(0xffffffff, 4);
  assert.throws(() => extractNsisUninstallerBuffer(repack(outOfBounds)), /exceeds executable bounds/);
});

test('NSIS extraction refuses a bad inner compiler CRC and ambiguous uninstallers', () => {
  const corruptInner = blocksFromFixture();
  corruptInner[2][corruptInner[2].length - 1] ^= 1;
  assert.throws(() => extractNsisUninstallerBuffer(repack(corruptInner)), /CRC mismatch/);
  const duplicate = blocksFromFixture();
  duplicate.push(duplicate[2]);
  assert.throws(() => extractNsisUninstallerBuffer(repack(duplicate)), /exactly one embedded/);
});
