#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Second Mind is deployed in a Linux container on every host. These suites
// exercise fail-closed POSIX ownership, mode-bit, O_NOFOLLOW, and directory
// durability guarantees that NTFS/libuv cannot represent faithfully. Linux and
// macOS still run the complete suite; Windows runs every portable suite.
export const WINDOWS_CONTAINER_SECURITY_SUITES = Object.freeze([
  'embedding-runtime.test.mjs',
  'knowledge-base-registry.test.mjs',
  'multi-knowledge-base-api.test.mjs',
  'runtime-admin-api.test.mjs',
  'runtime-admin-v2-security.test.mjs',
  'runtime-bootstrap.test.mjs',
  'runtime-config-registry-boundaries.test.mjs',
  'runtime-config-registry.test.mjs',
  'sdk-browser.test.mjs',
  'sdk-lifecycle.test.mjs',
  'sdk-media.test.mjs',
  'sdk-multi-knowledge-base-browser.test.mjs',
  'sdk-production.test.mjs',
  'sdk-provider-matrix.test.mjs',
  'server.test.mjs',
  'vault-replica.test.mjs',
]);

export function selectTestFiles(files, platform = process.platform) {
  const ordered = [...files].sort();
  if (platform !== 'win32') return ordered;
  const containerOnly = new Set(WINDOWS_CONTAINER_SECURITY_SUITES);
  return ordered.filter((filename) => !containerOnly.has(path.basename(filename)));
}

async function main(extraArguments = process.argv.slice(2)) {
  const continuousIntegration = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const testRoot = fileURLToPath(new URL('../test/', import.meta.url));
  const files = (await fsp.readdir(testRoot, { recursive: true }))
    .filter((filename) => filename.endsWith('.test.mjs'))
    .map((filename) => path.join(testRoot, filename));
  const available = new Set(files.map((filename) => path.basename(filename)));
  const missing = WINDOWS_CONTAINER_SECURITY_SUITES.filter((filename) => !available.has(filename));
  if (missing.length) throw new Error('The Windows container-security suite inventory is stale.');
  const selected = selectTestFiles(files);
  if (process.platform === 'win32') {
    process.stdout.write(
      `Windows: running ${selected.length} portable suites; ` +
      `${WINDOWS_CONTAINER_SECURITY_SUITES.length} POSIX container-security suites run on Linux/macOS CI.\n`,
    );
  }
  const preload = pathToFileURL(path.join(testRoot, 'test-environment.mjs')).href;
  const child = spawn(process.execPath, [
    '--import', preload,
    '--test',
    '--test-reporter=spec',
    ...(continuousIntegration ? [
      '--test-reporter-destination=stdout',
      `--test-reporter=${new URL('./ci-test-reporter.mjs', import.meta.url).href}`,
      '--test-reporter-destination=stderr',
    ] : []),
    '--test-concurrency=1',
    '--test-timeout=60000',
    ...extraArguments,
    ...selected,
  ], {
    env: process.env,
    stdio: ['inherit', 'inherit', continuousIntegration ? 'pipe' : 'inherit'],
  });
  let diagnosticTail = '';
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
    diagnosticTail = (diagnosticTail + chunk).slice(-32_000);
  });
  let deadline;
  let timedOut = false;
  if (continuousIntegration) {
    deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 5 * 60_000);
  }
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    clearTimeout(deadline);
  }
  if (timedOut) {
    console.error('::error title=Offline test deadline::The bounded test runner exceeded five minutes.');
  }
  if (continuousIntegration && exitCode !== 0 && diagnosticTail && !diagnosticTail.includes('::error ')) {
    const escaped = diagnosticTail.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.error(`::error title=Test runner diagnostic::${escaped}`);
  }
  process.exitCode = exitCode;
}

const launchedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (launchedDirectly) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
