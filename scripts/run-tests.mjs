#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Web deployment checks refer to systemd and GitHub Pages, neither shipped by
// the desktop project. Every backend/SDK suite runs on Windows; POSIX-only
// assertions are marked individually and have native Windows counterparts.
export const WEB_DEPLOYMENT_SUITES = Object.freeze([
  'deployment-entrypoints.test.mjs', 'require-ci-success.test.mjs',
]);
export const WINDOWS_CONTAINER_SECURITY_SUITES = Object.freeze([]);

// These tests exercise repository publication tooling, which intentionally
// requires Git on a build host. Installed-runtime verification runs separately.
export const DEVELOPMENT_TOOL_SUITES = Object.freeze(['security-scan.test.mjs']);

export function selectTestFiles(files, platform = process.platform, { runtimeOnly = false } = {}) {
  return [...files].sort().filter((filename) => !WEB_DEPLOYMENT_SUITES.includes(path.basename(filename))
    && !(runtimeOnly && DEVELOPMENT_TOOL_SUITES.includes(path.basename(filename))));
}

async function main(extraArguments = process.argv.slice(2)) {
  const continuousIntegration = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const testRoot = fileURLToPath(new URL('../test/', import.meta.url));
  const files = (await fsp.readdir(testRoot, { recursive: true }))
    .filter((filename) => filename.endsWith('.test.mjs'))
    .map((filename) => path.join(testRoot, filename));
  const runtimeOnly = extraArguments.includes('--runtime-only');
  extraArguments = extraArguments.filter((argument) => argument !== '--runtime-only');
  const selected = selectTestFiles(files, process.platform, { runtimeOnly });
  process.stdout.write(`Running ${selected.length} desktop/backend suites on ${process.platform}.\n`);
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
