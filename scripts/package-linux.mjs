import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { build, Platform, Arch } from 'electron-builder';
import electronExecutable from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stage = path.resolve(process.argv[2]);
const out = path.join(root, 'dist', 'linux');
await build({ publish: 'never', projectDir: root, targets: Platform.LINUX.createTarget(['AppImage', 'deb'], Arch.x64), config: {
  extends: null, appId: 'io.secondmind.desktop', productName: 'Second Mind', asar: true, npmRebuild: false,
  directories: { output: out, buildResources: 'build/assets' },
  artifactName: 'SecondMind-${version}-linux-${arch}.${ext}',
  files: ['desktop/**/*', 'platform/*.mjs', 'package.json', '!node_modules/**'],
  extraResources: [
    { from: path.join(stage, 'backend'), to: 'backend', filter: ['**/*', '!node_modules/**', '!node_modules'] },
    { from: path.join(stage, 'backend/node_modules'), to: 'backend/node_modules', filter: ['**/*', '!.bin{,/**/*}', '!.package-lock.json'] },
    { from: path.join(stage, 'runtime'), to: 'runtime' },
  ],
  electronDist: path.dirname(electronExecutable),
  linux: { category: 'Office', executableName: 'second-mind', maintainer: 'Second Mind maintainers <opensource@users.noreply.github.com>' },
  extraMetadata: { homepage: 'https://github.com/kygoyuan2004/Second-Mind' },
  afterPack: async ({ appOutDir }) => {
    for (const file of ['runtime/bin/python','runtime/bin/node','runtime/bin/ffmpeg','backend/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude','backend/public/study-plan/daily.html']) {
      await fs.access(path.join(appOutDir,'resources',file));
    }
  },
} });
const sums = [];
for (const name of (await fs.readdir(out)).filter(n => /\.(deb|AppImage)$/.test(n)).sort()) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(out, name))) hash.update(chunk);
  sums.push(hash.digest('hex') + '  ' + name);
}
if (sums.length !== 2) throw new Error('Expected one AppImage and one Debian package');
await fs.writeFile(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
