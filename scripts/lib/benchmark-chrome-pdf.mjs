import { execFile as execFileCallback } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export class BenchmarkChromePdfError extends Error {
  constructor(message, code = 'CHROME_PDF_FAILED', options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'BenchmarkChromePdfError';
    this.code = code;
  }
}

function fail(message, code, cause) {
  throw new BenchmarkChromePdfError(message, code, cause ? { cause } : {});
}

async function regularAbsoluteFile(filename, label) {
  if (!path.isAbsolute(String(filename || ''))) {
    fail(`${label} must be an absolute path.`, 'UNSAFE_PDF_PATH');
  }
  const target = path.resolve(String(filename));
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular file.`, 'UNSAFE_PDF_PATH');
  }
  return target;
}

async function absoluteOutput(filename) {
  if (!path.isAbsolute(String(filename || ''))) {
    fail('pdfPath must be an absolute path.', 'UNSAFE_PDF_PATH');
  }
  const target = path.resolve(String(filename));
  const parent = await fsp.realpath(path.dirname(target));
  const existing = await fsp.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    fail('pdfPath must be absent or a regular file.', 'UNSAFE_PDF_PATH');
  }
  return path.join(parent, path.basename(target));
}

function parsePageCount(output) {
  const match = /^Pages:\s+(\d+)\s*$/mu.exec(String(output || ''));
  const pages = Number(match?.[1]);
  if (!Number.isInteger(pages) || pages < 1) {
    fail('pdfinfo did not report a positive page count.', 'PDFINFO_FAILED');
  }
  return pages;
}

/**
 * Create the injected renderer expected by benchmark-report-renderer.mjs.
 * Chrome receives only a self-contained local HTML path and a PDF target.
 */
export function createChromePdfRunner(options = {}) {
  const chromePath = path.resolve(String(options.chromePath || '/usr/bin/google-chrome'));
  const pdfInfoPath = path.resolve(String(options.pdfInfoPath || '/usr/bin/pdfinfo'));
  const run = options.execFile || execFile;
  const timeoutMs = Number(options.timeoutMs || 120_000);
  if (typeof run !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    fail('Chrome runner options are invalid.', 'INVALID_CHROME_OPTIONS');
  }
  return async ({ htmlPath: htmlInput, pdfPath: pdfInput }) => {
    const htmlPath = await regularAbsoluteFile(htmlInput, 'htmlPath');
    const pdfPath = await absoluteOutput(pdfInput);
    const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultmind-report-chrome-'));
    try {
      await run(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-pdf-header-footer',
        `--user-data-dir=${profile}`,
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ], {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const pdf = await fsp.lstat(pdfPath).catch(() => null);
      if (!pdf?.isFile() || pdf.isSymbolicLink() || pdf.size < 8) {
        fail('Chrome did not create a usable PDF.', 'PDF_OUTPUT_MISSING');
      }
      const signature = Buffer.alloc(5);
      const handle = await fsp.open(pdfPath, 'r');
      try {
        await handle.read(signature, 0, signature.length, 0);
      } finally {
        await handle.close();
      }
      if (signature.toString('ascii') !== '%PDF-') {
        fail('Chrome output does not have a PDF signature.', 'INVALID_PDF_OUTPUT');
      }
      const info = await run(pdfInfoPath, [pdfPath], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      });
      return { pageCount: parsePageCount(info.stdout) };
    } catch (error) {
      if (error instanceof BenchmarkChromePdfError) throw error;
      fail('Headless Chrome could not render the report.', 'CHROME_PDF_FAILED', error);
    } finally {
      await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  };
}

export const benchmarkChromePdfInternals = Object.freeze({ parsePageCount });
