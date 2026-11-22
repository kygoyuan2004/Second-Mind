import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('SMENC1\n');
let privateCodec = null;
let storageHelper = null;
let explicitHelperPath = '';

// The desktop backend installs an IPC codec. Only the Electron main process
// possesses safeStorage; no key or plaintext temporary file is needed here.
export function installPrivateCodec({ encrypt, decrypt, requireEncryption = true }) {
  if (typeof encrypt !== 'function' || typeof decrypt !== 'function') {
    throw new TypeError('A private storage codec requires encrypt and decrypt functions.');
  }
  const previous = privateCodec;
  const installed = { encrypt, decrypt, requireEncryption };
  privateCodec = installed;
  return () => { if (privateCodec === installed) privateCodec = previous; };
}

export function hasPrivateCodec() { return privateCodec !== null; }

export async function encodePrivateBytes(bytes) {
  if (!privateCodec) return Buffer.from(bytes);
  const encrypted = Buffer.from(await privateCodec.encrypt(Buffer.from(bytes)));
  if (!encrypted.length) throw storageError('Private encryption returned no data.', 'PRIVATE_ENCRYPTION_FAILED');
  return Buffer.concat([MAGIC, Buffer.from(encrypted.toString('base64'))]);
}

export async function decodePrivateBytes(bytes) {
  bytes = Buffer.from(bytes);
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (privateCodec?.requireEncryption) {
      throw storageError('Private configuration must be encrypted.', 'PRIVATE_ENCRYPTION_REQUIRED');
    }
    return bytes;
  }
  if (!privateCodec) throw storageError('Private configuration requires its desktop encryption provider.', 'PRIVATE_CODEC_UNAVAILABLE');
  const encoded = bytes.subarray(MAGIC.length).toString('ascii');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded.length) {
    throw storageError('Encrypted configuration is malformed.', 'PRIVATE_ENCRYPTION_INVALID');
  }
  return Buffer.from(await privateCodec.decrypt(Buffer.from(encoded, 'base64')));
}

export function storageError(message, code = 'UNSAFE_PRIVATE_STORAGE') {
  return Object.assign(new Error(message), { code });
}

export function pathIdentity(filename, platform = process.platform) {
  if (platform !== 'win32') return path.posix.resolve(filename);
  let normalized = path.win32.resolve(filename);
  if (normalized.startsWith('\\\\?\\UNC\\')) normalized = `\\\\${normalized.slice(8)}`;
  else if (normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4);
  return normalized.toLowerCase();
}

export function samePath(left, right, platform = process.platform) {
  return pathIdentity(left, platform) === pathIdentity(right, platform);
}

export function isInsidePath(root, target, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const relative = paths.relative(pathIdentity(root, platform), pathIdentity(target, platform));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

export function isWindowsPathSegment(segment) {
  return Boolean(segment) && !/[<>:"|?*\u0000-\u001f]/u.test(segment) &&
    !/[. ]$/u.test(segment) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment);
}

export function nativeHelperPath() {
  return explicitHelperPath || fileURLToPath(new URL('./native/SecondMind.Platform.exe', import.meta.url));
}

// Only the trusted desktop main process calls this before opening a window.
export function setNativeHelperPath(filename) {
  if (!path.isAbsolute(filename)) throw new TypeError('Native helper path must be absolute.');
  if (storageHelper) { storageHelper.child.kill(); storageHelper = null; }
  explicitHelperPath = filename;
}

export async function nativeStorageCommand(command, filename) {
  if (process.platform !== 'win32') return;
  if (!['protect', 'verify', 'check-path', 'list-reparse'].includes(command)) throw new Error('Unsupported native storage operation.');
  if (!storageHelper) {
    const child = spawn(nativeHelperPath(), ['serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const session = { child, pending: new Map(), output: '' };
    storageHelper = session;
    const fail = () => {
      if (storageHelper === session) storageHelper = null;
      for (const request of session.pending.values()) { clearTimeout(request.timer); request.reject(storageError('Windows storage helper is unavailable.', 'PRIVATE_HELPER_UNAVAILABLE')); }
      session.pending.clear();
    };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
    child.stdout.on('data', (bytes) => {
      session.output += bytes.toString('utf8');
      if (session.output.length > 4 * 1024 * 1024) { child.kill(); fail(); return; }
      let newline;
      while ((newline = session.output.indexOf('\n')) !== -1) {
        const line = session.output.slice(0, newline).trimEnd(); session.output = session.output.slice(newline + 1);
        const [id, status, payload = ''] = line.split('\t');
        const request = session.pending.get(id);
        if (!request) continue;
        session.pending.delete(id); clearTimeout(request.timer);
        if (status === 'OK') request.resolve(Buffer.from(payload, 'base64').toString('utf8'));
        else request.reject(storageError('Windows storage operation was refused.', 'UNSAFE_PRIVATE_PATH'));
      }
    });
    // The pipe closes automatically on owner exit; the helper is not a reason
    // to keep a shutting-down desktop process alive.
    child.unref(); child.stdin.unref(); child.stdout.unref();
  }
  const session = storageHelper, id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { session.pending.delete(id); session.child.kill(); reject(storageError('Windows storage operation timed out.', 'PRIVATE_HELPER_TIMEOUT')); }, 15_000);
    session.pending.set(id, { resolve, reject, timer });
    session.child.stdin.write(`${id}\t${command}\t${Buffer.from(path.resolve(filename)).toString('base64')}\n`);
  });
}

export async function reparseChildren(directory) {
  if (process.platform !== 'win32') return new Set();
  const output = await nativeStorageCommand('list-reparse', directory);
  return new Set(output.split('\n').filter(Boolean).map((line) => Buffer.from(line, 'base64').toString('utf8')));
}

export async function assertNoReparseTraversal(filename, { allowMissing = false } = {}) {
  const target = path.resolve(filename);
  const root = path.parse(target).root;
  let current = root;
  for (const component of target.slice(root.length).split(path.sep).filter(Boolean)) {
    if (process.platform === 'win32' && !isWindowsPathSegment(component)) {
      throw storageError('Windows path contains a reserved or ambiguous name.', 'UNSAFE_PRIVATE_PATH');
    }
    current = path.join(current, component);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') {
        await nativeStorageCommand('check-path', path.dirname(current));
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw storageError('Symbolic links and junctions are not permitted.', 'UNSAFE_PRIVATE_PATH');
  }
  // FILE_ATTRIBUTE_REPARSE_POINT catches reparse types not exposed as links
  // by Node's lstat (including cloud placeholders and volume mount points).
  await nativeStorageCommand('check-path', target);
}

export async function protectPrivatePath(filename) {
  await assertNoReparseTraversal(filename);
  if (process.platform === 'win32') return nativeStorageCommand('protect', filename);
  const stat = await fsp.lstat(filename);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw storageError('Private storage must belong to the current user.');
  }
  await fsp.chmod(filename, stat.isDirectory() ? 0o700 : 0o600);
}

export async function protectPrivateDirectory(directory) {
  await assertNoReparseTraversal(directory, { allowMissing: true });
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await protectPrivatePath(directory);
  return directory;
}

export async function verifyPrivatePath(filename) {
  await assertNoReparseTraversal(filename);
  if (process.platform === 'win32') {
    try { await nativeStorageCommand('verify', filename); }
    catch (cause) { throw Object.assign(storageError('Private storage permissions are unsafe.', 'UNSAFE_PRIVATE_FILE'), { cause }); }
  }
}

export async function ensurePrivateDirectory(directory) {
  await assertNoReparseTraversal(directory, { allowMissing: true });
  const created = await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (created) await protectPrivatePath(directory);
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== 'win32' && ((stat.mode & 0o022) !== 0 ||
       (typeof process.getuid === 'function' && stat.uid !== process.getuid())))) {
    throw storageError('Private directory must be controlled by its owner.', 'UNSAFE_PRIVATE_PATH');
  }
  try { await verifyPrivatePath(directory); }
  catch (cause) { throw Object.assign(storageError('Private directory permissions are unsafe.', 'UNSAFE_PRIVATE_PATH'), { cause }); }
  return directory;
}

export function assertPrivateFileStat(stat, { maxBytes = 2 * 1024 * 1024, minBytes = 1 } = {}) {
  if (!stat.isFile() || Number(stat.nlink) !== 1 ||
      (process.platform !== 'win32' && ((Number(stat.mode) & 0o777) !== 0o600 ||
       (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()))) ||
      Number(stat.size) < minBytes || Number(stat.size) > maxBytes) {
    throw storageError('Private file must be an owner-controlled regular file within the size limit.', 'UNSAFE_PRIVATE_FILE');
  }
}

export function sameFileStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function readPrivateFile(filename, { optional = false, maxBytes = 2 * 1024 * 1024 } = {}) {
  let handle;
  try {
    await verifyPrivatePath(filename);
    handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    assertPrivateFileStat(before, { maxBytes });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathname = await fsp.lstat(filename, { bigint: true });
    if (!sameFileStat(before, after) || !sameFileStat(after, pathname) || pathname.isSymbolicLink()) {
      throw storageError('Private file changed during the read.', 'PRIVATE_FILE_CHANGED');
    }
    return bytes;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close().catch(() => {}); }
}

// Never unlink the destination to work around a Windows sharing violation.
// A bounded retry preserves the old committed document on failure.
export async function replaceFileAtomically(source, destination, { rename = fsp.rename, platform = process.platform } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await rename(source, destination); }
    catch (error) {
      if (platform !== 'win32' || attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20 * 2 ** attempt, 320)));
    }
  }
}

export async function atomicPrivateFile(filename, bytes, { syncDirectory, verifyTarget = true } = {}) {
  if (!path.isAbsolute(filename)) throw storageError('Private storage path must be absolute.', 'UNSAFE_PRIVATE_PATH');
  const directory = await ensurePrivateDirectory(path.dirname(filename));
  const temporary = path.join(directory, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
  let handle, directoryHandle, committed = false;
  try {
    handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    await protectPrivatePath(temporary);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    if (verifyTarget) await readPrivateFile(filename, { optional: true });
    await assertNoReparseTraversal(directory);
    if (process.platform !== 'win32') directoryHandle = await fsp.open(directory, fs.constants.O_RDONLY);
    await replaceFileAtomically(temporary, filename);
    committed = true;
    try {
      if (syncDirectory) await syncDirectory(directoryHandle);
      else await directoryHandle?.sync();
    } catch { /* Commit is visible. A metadata flush failure is not rollback. */ }
  } finally {
    await handle?.close().catch(() => {});
    await directoryHandle?.close().catch(() => {});
    if (!committed) await fsp.unlink(temporary).catch(() => {});
  }
}
