import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');
export const SITE_SOURCE = path.join(REPOSITORY_ROOT, 'site');
export const SITE_OUTPUT = path.join(REPOSITORY_ROOT, 'dist');
export const SCREENSHOT_SOURCE = path.join(REPOSITORY_ROOT, 'docs', 'assets');
export const SITE_BASE = '/Second-Mind/';
export const REQUIRED_SCREENSHOTS = Object.freeze([
  'second-mind-qa.png',
  'second-mind-execution.png',
  'second-mind-provider-config.png',
  'second-mind-diary.png',
  'second-mind-plan.png',
  'second-mind-mobile.png',
]);

function compareNames(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  const entries = (await readdir(source, { withFileTypes: true })).sort(compareNames);

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`Unsupported entry in site source: ${sourcePath}`);
    }
  }
}

function assertSafeOutputPath() {
  const expected = path.resolve(REPOSITORY_ROOT, 'dist');
  if (SITE_OUTPUT !== expected || path.dirname(SITE_OUTPUT) !== REPOSITORY_ROOT) {
    throw new Error(`Refusing to clean unexpected output path: ${SITE_OUTPUT}`);
  }
}

async function isRegularFile(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function buildSite({ log = true } = {}) {
  assertSafeOutputPath();
  await rm(SITE_OUTPUT, { recursive: true, force: true });
  await copyDirectory(SITE_SOURCE, SITE_OUTPUT);
  await writeFile(path.join(SITE_OUTPUT, '.nojekyll'), '', 'utf8');

  const assetOutput = path.join(SITE_OUTPUT, 'assets');
  await mkdir(assetOutput, { recursive: true });
  const missingScreenshots = [];

  for (const filename of REQUIRED_SCREENSHOTS) {
    const source = path.join(SCREENSHOT_SOURCE, filename);
    if (!(await isRegularFile(source))) {
      missingScreenshots.push(filename);
      continue;
    }
    await copyFile(source, path.join(assetOutput, filename));
  }

  if (log) {
    process.stdout.write(`Built static site at ${path.relative(REPOSITORY_ROOT, SITE_OUTPUT)}\n`);
    if (missingScreenshots.length > 0) {
      process.stderr.write(`Missing release screenshots: ${missingScreenshots.join(', ')}\n`);
    }
  }

  return { missingScreenshots };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await buildSite();
}
