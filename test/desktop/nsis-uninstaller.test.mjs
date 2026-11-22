import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

test('Linux NSIS adapter only extracts this build intermediate and restores upstream behavior', { skip: process.platform !== 'linux' }, async () => {
  // The Windows installation intentionally contains no build-host dependencies.
  const { WineVmManager } = await import('app-builder-lib/out/vm/WineVm.js');
  const { useNativeNsisUninstallerExtraction } = await import('../../scripts/nsis-uninstaller.mjs');
  const originalVm = WineVmManager.prototype.exec;
  const extracted = [];
  const delegated = [];
  const directory = path.resolve('build', 'test-output');
  WineVmManager.prototype.exec = async (...args) => { delegated.push(args); return 'delegated'; };
  let restore;
  try {
    restore = useNativeNsisUninstallerExtraction(directory, { extract: async (...args) => { extracted.push(args); } });
    const vm = Object.create(WineVmManager.prototype);
    const expected = path.join(directory, 'SecondMind-0.1.0-windows-x64-setup.exe');
    const options = { env: { __COMPAT_LAYER: 'RunAsInvoker' } };
    await vm.exec(expected, [], options);
    assert.deepEqual(extracted, [[expected, expected.replace(/exe$/, '__uninstaller.exe')]]);
    await vm.exec(path.join(directory, '..', 'SecondMind-0.1.0-windows-x64-setup.exe'), [], options);
    await vm.exec(expected, ['--run'], options);
    await vm.exec(expected, [], {});
    await vm.exec(path.join(directory, 'different.exe'), [], options);
    assert.equal(delegated.length, 4);
    restore();
    await vm.exec(expected, [], options);
    assert.equal(delegated.length, 5);
  } finally {
    restore?.();
    WineVmManager.prototype.exec = originalVm;
  }
});
