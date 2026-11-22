/** Build-host tools and private state never enter the installable application. */
const path = require('node:path');
module.exports = {
  appId: 'io.secondmind.desktop',
  productName: 'Second Mind',
  artifactName: 'SecondMind-${version}-windows-${arch}-setup.${ext}',
  directories: { output: 'dist/windows', buildResources: 'build/assets' },
  asar: true,
  npmRebuild: false,
  files: [
    'desktop/**', 'platform/**', 'package.json',
    '!platform/native/*.exe', '!platform/native/*.cs', '!platform/native/build-native.mjs',
    '!desktop/**/*.test.*', '!node_modules/**',
  ],
  extraResources: [
    { from: 'build/backend', to: 'backend', filter: ['**/*'] },
    // electron-builder's directory filter always excludes a root node_modules.
    // Make that directory its own source root so production dependencies survive.
    { from: 'build/backend/node_modules', to: 'backend/node_modules', filter: ['**/*', '!.bin{,/**/*}', '!.package-lock.json'] },
    { from: 'build/runtime/win-x64', to: 'runtime', filter: ['**/*'] },
    { from: 'docs/windows-user-guide.md', to: '使用说明.md' },
    { from: 'docs/windows-third-party.md', to: 'THIRD-PARTY-NOTICES.md' },
    { from: 'scripts/windows-runtime-lock.json', to: 'runtime-lock.json' },
  ],
  afterPack: async (context) => {
    const { verifyPackagedBackend } = await import('./scripts/verify-packaged-backend.mjs');
    const result = await verifyPackagedBackend({
      stagedRoot: path.join(__dirname, 'build', 'backend'),
      packagedRoot: path.join(context.appOutDir, 'resources', 'backend'),
    });
    console.log(`Verified ${result.filesVerified} packaged production dependency files, including the Windows SDK executable`);
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    signAndEditExecutable: false,
    requestedExecutionLevel: 'asInvoker',
    legalTrademarks: 'Third-party names remain the property of their owners.',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    installerLanguages: ['zh_CN', 'en_US'],
    shortcutName: 'Second Mind',
  },
};
