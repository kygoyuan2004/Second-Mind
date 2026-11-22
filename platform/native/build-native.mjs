import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export async function buildNative({ cross = false } = {}) {
  const source = fileURLToPath(new URL('./SecondMind.Platform.cs', import.meta.url));
  const manifest = fileURLToPath(new URL('./SecondMind.Platform.manifest', import.meta.url));
  const output = fileURLToPath(new URL('./SecondMind.Platform.exe', import.meta.url));
  if (process.platform !== 'win32') {
    if (!cross) throw new Error('Use Windows csc.exe or --cross with Docker Mono to compile the platform helper.');
    const directory = path.dirname(source);
    const prefix = path.resolve(directory, '../../.local/mono/root');
    const mono = path.join(prefix, 'usr/bin/mono-sgen');
    if (await fs.access(mono).then(() => true, () => false)) {
      const assemblies = path.join(prefix, 'usr/lib/mono/4.5');
      // Runtime Mono assemblies expose APIs unavailable in Windows Framework.
      // Compile only against the Framework contract (mono-devel references).
      const contracts = path.join(prefix, 'usr/lib/mono/4.5-api');
      await fs.access(path.join(contracts, 'mscorlib.dll'));
      await fs.access(path.join(contracts, 'System.dll'));
      await promisify(execFile)(mono, [path.join(assemblies, 'mcs.exe'), '-noconfig', '-nostdlib',
        `-r:${path.join(contracts, 'mscorlib.dll')}`, `-r:${path.join(contracts, 'System.dll')}`,
        '-optimize+', '-platform:x64', '-target:exe', `-win32manifest:${manifest}`, `-out:${output}`, source], {
        env: { ...process.env, MONO_PATH: assemblies, MONO_CFG_DIR: path.join(prefix, 'etc') }, maxBuffer: 1024 * 1024,
      });
      return output;
    }
    const args = ['run', '--rm', '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${directory}:/native`,
      'mono:6.12', 'mcs', '-noconfig', '-nostdlib', '-r:/usr/lib/mono/4.5-api/mscorlib.dll', '-r:/usr/lib/mono/4.5-api/System.dll',
      '-optimize+', '-platform:x64', '-target:exe', '-win32manifest:/native/SecondMind.Platform.manifest', '-out:/native/SecondMind.Platform.exe', '/native/SecondMind.Platform.cs'];
    await promisify(execFile)('docker', args, { maxBuffer: 1024 * 1024 });
    return output;
  }
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await fs.access(compiler);
  await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/win32manifest:${manifest}`, `/out:${output}`, source], { windowsHide: true });
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildNative({ cross: process.argv.includes('--cross') }));
}
