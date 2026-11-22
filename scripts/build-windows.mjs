import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setDefaultResultOrder } from 'node:dns';
import { build, Platform, Arch } from 'electron-builder';
import configuration from '../electron-builder.config.cjs';
import { useNativeNsisUninstallerExtraction } from './nsis-uninstaller.mjs';
import { extractNsisUninstaller } from './nsis-uninstaller-resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'build', 'backend');
const prepareOnly = process.argv.includes('--prepare-only');
const skipRuntime = process.argv.includes('--skip-runtime');
process.env.ELECTRON_CACHE ||= path.join(root, '.local', 'electron-cache');
process.env.ELECTRON_BUILDER_CACHE ||= path.join(root, '.local', 'electron-builder-cache');
// Some build hosts have a working but severely throttled IPv6 route to npm's CDN.
setDefaultResultOrder('ipv4first');

async function run(command, args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`)));
  });
}

async function digest(file) {
  const hash = createHash('sha256');
  const handle = await fs.open(file);
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}

async function ensureWindowsSdk() {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const key = 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64';
  const destination = path.join(backend, key);
  try { await fs.access(path.join(destination, 'package.json')); return; } catch {}
  // npm < 10 on Linux does not implement --os. Fetch only this locked native target,
  // never force-install every architecture or substitute the host binary.
  const entry = lock.packages[key];
  if (entry?.version !== '0.3.247' || !entry.integrity?.startsWith('sha512-')) throw new Error('Missing locked Windows SDK integrity');
  const cache = path.join(root, 'build', 'runtime-cache', 'claude-agent-sdk-win32-x64-0.3.247.tgz');
  let archive;
  try { archive = await fs.readFile(cache); } catch {}
  const valid = (buffer) => buffer && `sha512-${createHash('sha512').update(buffer).digest('base64')}` === entry.integrity;
  if (!valid(archive)) {
    console.log('Downloading the locked Claude Agent SDK Windows x64 binary');
    const response = await fetch(entry.resolved);
    if (!response.ok) throw new Error(`SDK download failed (${response.status})`);
    archive = Buffer.from(await response.arrayBuffer());
    if (!valid(archive)) throw new Error('Windows SDK archive integrity mismatch');
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, archive);
  }
  const { x: extractTar } = await import('tar');
  await fs.mkdir(destination, { recursive: true });
  await extractTar({ file: cache, cwd: destination, strip: 1, strict: true, preservePaths: false });
  console.log('Verified and installed Claude Agent SDK Windows x64 0.3.247');
}

if (!skipRuntime) await run(process.env.BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['scripts/prepare-windows-runtime.py']);
await fs.access(path.join(root, 'build', 'runtime', 'win-x64', 'manifest.json'));
if (process.platform === 'win32') await run(process.execPath, ['platform/native/build-native.mjs']);
// Cross builds must supply the same helper compiled from the checked-in source.
await fs.access(path.join(root, 'platform', 'native', 'SecondMind.Platform.exe'));

await fs.rm(backend, { recursive: true, force: true });
await fs.mkdir(backend, { recursive: true });
for (const directory of ['src', 'public', 'desktop', 'platform']) {
  await fs.cp(path.join(root, directory), path.join(backend, directory), {
    recursive: true, dereference: false,
    filter: (entry) => !entry.endsWith('__pycache__') && !entry.endsWith('.pyc'),
  });
}
for (const filename of ['package.json', 'package-lock.json', 'LICENSE']) {
  await fs.copyFile(path.join(root, filename), path.join(backend, filename));
}
// npm ci honours the project's lock while selecting target-specific optional packages.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script with npm run desktop:build:win so npm_execpath is available.');
await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--include=optional', '--os=win32', '--cpu=x64', '--no-audit', '--no-fund'], backend);
await ensureWindowsSdk();
for (const name of await fs.readdir(path.join(backend, 'node_modules', '@anthropic-ai'))) {
  if (name.startsWith('claude-agent-sdk-') && name !== 'claude-agent-sdk-win32-x64') {
    await fs.rm(path.join(backend, 'node_modules', '@anthropic-ai', name), { recursive: true });
  }
}
const sdkPackage = path.join(backend, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64');
const sdk = JSON.parse(await fs.readFile(path.join(sdkPackage, 'package.json'), 'utf8'));
if (sdk.version !== '0.3.247') throw new Error('Windows SDK binary version must be 0.3.247');
// Retain a dependency inventory alongside the original dependency license files.
const dependencies = JSON.parse(await fs.readFile(path.join(backend, 'package-lock.json'), 'utf8'));
const inventory = (await Promise.all(Object.entries(dependencies.packages || {}).filter(([key, value]) => key && !value.dev)
  .map(async ([location, value]) => {
    try { await fs.access(path.join(backend, location, 'package.json')); } catch { return null; }
    return { location, version: value.version, license: value.license || 'See package documentation', integrity: value.integrity };
  }))).filter(Boolean);
await fs.writeFile(path.join(backend, 'third-party-dependencies.json'), JSON.stringify(inventory, null, 2) + '\n');
if (prepareOnly) {
  console.log(`Prepared Windows backend: ${backend}`);
} else {
  const output = path.join(root, configuration.directories.output);
  const restoreExtraction = useNativeNsisUninstallerExtraction(output, {
    extract: async (installerPath, uninstallerPath) => {
      await extractNsisUninstaller(installerPath, uninstallerPath);
      // Keep these small build-only artifacts for native checksum/lifecycle
      // verification after electron-builder removes its temporary uninstaller.
      const auditDirectory = path.join(root, 'build', 'nsis');
      await fs.mkdir(auditDirectory, { recursive: true });
      await fs.copyFile(installerPath, path.join(auditDirectory, 'uninstaller-intermediate.exe'));
      await fs.copyFile(uninstallerPath, path.join(auditDirectory, 'SecondMind-uninstaller.exe'));
    },
  });
  try { await build({ publish: 'never', projectDir: root, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config: configuration }); }
  finally { restoreExtraction(); }
  const files = (await fs.readdir(output)).filter((file) => /^SecondMind-.*-windows-x64-setup\.exe$/.test(file));
  if (!files.length) throw new Error('No Windows installer was produced');
  const checksums = await Promise.all(files.map(async (file) => `${await digest(path.join(output, file))}  ${file}`));
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  await fs.copyFile(path.join(root, 'docs', 'windows-user-guide.md'), path.join(output, '使用说明.md'));
  await fs.copyFile(path.join(root, 'docs', 'windows-third-party.md'), path.join(output, 'THIRD-PARTY-NOTICES.md'));
  console.log(`Windows installer and checksums: ${output}`);
}
