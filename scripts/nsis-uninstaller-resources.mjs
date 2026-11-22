import fs from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const SIGNATURE = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex');
const MAX_INTERMEDIATE_BYTES = 16 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function signatureAt(bytes, offset) {
  return offset + 28 <= bytes.length && bytes.subarray(offset + 4, offset + 20).equals(SIGNATURE);
}

function verifyCrc(bytes, offset) {
  const flags = bytes.readUInt32LE(offset);
  if ((flags & ~15) !== 0 || (flags & 4) !== 0) throw new Error('Unsupported NSIS flags: CRC must remain enabled.');
  if (offset + bytes.readUInt32LE(offset + 24) !== bytes.length) throw new Error('NSIS length mismatch.');
  // NSIS excludes the first 512 PE bytes, which may be edited by signing tools.
  // The checksum is verified against the compiler's value; never rewritten.
  if (crc32(bytes.subarray(512, -4)) !== bytes.readUInt32LE(bytes.length - 4)) throw new Error('NSIS CRC mismatch.');
}

function applyResourcePatches(stub, patches) {
  const result = Buffer.from(stub);
  let position = 0;
  let count = 0;
  while (position + 4 <= patches.length) {
    const length = patches.readUInt32LE(position);
    position += 4;
    if (length === 0) {
      if (position !== patches.length || count === 0) throw new Error('Invalid NSIS resource patch terminator.');
      return result;
    }
    if (position + 4 > patches.length) throw new Error('Truncated NSIS resource patch offset.');
    const offset = patches.readUInt32LE(position);
    position += 4;
    if (offset < 512 || offset + length > stub.length || position + length > patches.length) {
      throw new Error('NSIS resource patch exceeds executable bounds.');
    }
    patches.copy(result, offset, position, position + length);
    position += length;
    count += 1;
  }
  throw new Error('Missing NSIS resource patch terminator.');
}

/**
 * Reproduce NSIS 3.0.4.1 WriteUninstaller for our unsigned zlib intermediate.
 * electron-builder 26.15.3's UninstallerReader omits the preceding icon resource
 * patches, leaving its output with an invalid compiler-generated CRC. Apply the
 * same [size, PE offset, payload] records as NSIS's EW_WRITEUNINSTALLER, then
 * verify the original checksum. Windows builds keep native WriteUninstaller.
 * https://github.com/NSIS-Dev/nsis/blob/master/Source/exehead/exec.c
 */
export function extractNsisUninstallerBuffer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1024 || bytes.length > MAX_INTERMEDIATE_BYTES) {
    throw new Error('Invalid NSIS intermediate size.');
  }
  if (bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Missing NSIS PE signature.');
  const peOffset = bytes.readUInt32LE(60);
  if (peOffset + 4 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('Invalid NSIS PE signature.');
  }
  let offset = 512;
  while (offset + 28 <= bytes.length && !signatureAt(bytes, offset)) offset += 512;
  if (!signatureAt(bytes, offset)) throw new Error('NSIS first header not found.');
  if ((bytes.readUInt32LE(offset) & 1) !== 0) throw new Error('Expected NSIS installer intermediate.');
  verifyCrc(bytes, offset);
  const blocks = [];
  let position = offset + 28;
  while (position < bytes.length - 4) {
    if (position + 4 > bytes.length - 4) throw new Error('Truncated NSIS block.');
    const rawLength = bytes.readUInt32LE(position);
    const length = rawLength & 0x7fffffff;
    position += 4;
    if (length === 0 || position + length > bytes.length - 4) throw new Error('Invalid NSIS block length.');
    const data = bytes.subarray(position, position + length);
    blocks.push((rawLength & 0x80000000) ? inflateRawSync(data, { maxOutputLength: MAX_INTERMEDIATE_BYTES }) : data);
    position += length;
  }
  const candidates = blocks.flatMap((block, index) => signatureAt(block, 0) ? [index] : []);
  if (candidates.length !== 1) throw new Error('Expected exactly one embedded NSIS uninstaller.');
  const index = candidates[0];
  const inner = blocks[index];
  if ((inner.readUInt32LE(0) & 1) === 0 || inner.readUInt32LE(24) !== inner.length) {
    throw new Error('Invalid embedded NSIS uninstaller header.');
  }
  let result = Buffer.concat([bytes.subarray(0, offset), inner]);
  try {
    verifyCrc(result, offset);
  } catch {
    if (index < 1) throw new Error('Missing NSIS uninstaller resource patches.');
    result = Buffer.concat([applyResourcePatches(bytes.subarray(0, offset), blocks[index - 1]), inner]);
    verifyCrc(result, offset);
  }
  return result;
}

export async function extractNsisUninstaller(installerPath, uninstallerPath) {
  const result = extractNsisUninstallerBuffer(await fs.readFile(installerPath));
  await fs.writeFile(uninstallerPath, result);
}
