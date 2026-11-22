import path from 'node:path';
import { createRequire } from 'node:module';
import { WineVmManager } from 'app-builder-lib/out/vm/WineVm.js';
import { extractNsisUninstaller } from './nsis-uninstaller-resources.mjs';

/**
 * Extract only this unsigned NSIS intermediate on Linux, including the resource
 * patches omitted by electron-builder's parser. Both compiler CRCs must match.
 * No Windows executable is emulated or executed here.
 * Every other VM operation retains electron-builder's normal implementation.
 */
export function useNativeNsisUninstallerExtraction(outputDirectory, { extract = extractNsisUninstaller } = {}) {
  if (process.platform !== 'linux' || process.env.SECOND_MIND_NSIS_USE_WINE === '1') return () => {};
  if (createRequire(import.meta.url)('app-builder-lib/package.json').version !== '26.15.3') {
    throw new Error('NSIS native extraction is validated for electron-builder 26.15.3; revalidate this adapter when upgrading.');
  }
  const original = WineVmManager.prototype.exec;
  const outputRoot = path.resolve(outputDirectory);
  WineVmManager.prototype.exec = async function (file, args, options, ...rest) {
    const installer = path.resolve(file);
    const relative = path.relative(outputRoot, installer);
    if (Array.isArray(args) && args.length === 0 && options?.env?.__COMPAT_LAYER === 'RunAsInvoker'
      && relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      && /^SecondMind-.*-windows-x64-setup\.exe$/.test(path.basename(installer))) {
      const uninstaller = path.join(path.dirname(installer), `${path.basename(installer, 'exe')}__uninstaller.exe`);
      await extract(installer, uninstaller);
      console.log('Extracted NSIS uninstaller with complete resources and verified compiler CRC');
      return '';
    }
    return original.call(this, file, args, options, ...rest);
  };
  return () => { WineVmManager.prototype.exec = original; };
}
