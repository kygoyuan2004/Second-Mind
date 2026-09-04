import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  benchmarkChromePdfInternals,
  createChromePdfRunner,
} from '../scripts/lib/benchmark-chrome-pdf.mjs';

test('Chrome runner uses argv-only local rendering and verifies the PDF', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'benchmark-chrome-pdf-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const htmlPath = path.join(root, 'report.html');
  const pdfPath = path.join(root, 'report.pdf');
  await fsp.writeFile(htmlPath, '<!doctype html><title>fixture</title>');
  const calls = [];
  const runner = createChromePdfRunner({
    chromePath: '/fixture/google-chrome',
    pdfInfoPath: '/fixture/pdfinfo',
    execFile: async (file, args, options) => {
      calls.push({ file, args: [...args], options: { ...options } });
      if (file.endsWith('google-chrome')) {
        const target = args.find((value) => value.startsWith('--print-to-pdf=')).slice(15);
        await fsp.writeFile(target, '%PDF-1.4\nfixture\n');
        return { stdout: '', stderr: '' };
      }
      return { stdout: 'Pages:          3\n', stderr: '' };
    },
  });
  assert.deepEqual(await runner({ htmlPath, pdfPath }), { pageCount: 3 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.at(-1), new URL(`file://${htmlPath}`).href);
  assert.ok(calls[0].args.includes('--disable-background-networking'));
  assert.deepEqual(calls[1].args, [pdfPath]);
});

test('page count parser and path validation fail closed', async () => {
  assert.equal(benchmarkChromePdfInternals.parsePageCount('Pages: 12\n'), 12);
  assert.throws(
    () => benchmarkChromePdfInternals.parsePageCount('Pages: unknown\n'),
    { code: 'PDFINFO_FAILED' },
  );
  const runner = createChromePdfRunner({ execFile: async () => ({ stdout: '' }) });
  await assert.rejects(
    () => runner({ htmlPath: 'relative.html', pdfPath: '/tmp/report.pdf' }),
    { code: 'UNSAFE_PDF_PATH' },
  );
});
