import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  SCREENSHOT_SPECS,
  parseArguments,
  pngDimensions,
  stripPngMetadata,
} from '../scripts/capture-screenshots.mjs';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([
    length,
    Buffer.from(type, 'ascii'),
    data,
    Buffer.alloc(4),
  ]);
}

function fixturePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(360, 0);
  header.writeUInt32BE(800, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from('capture=private metadata')),
    chunk('pHYs', Buffer.alloc(9, 1)),
    chunk('IDAT', Buffer.from([120, 156, 3, 0, 0, 0, 0, 1])),
    chunk('IEND'),
  ]);
}

test('release capture specification has the exact stable filenames and viewports', () => {
  assert.deepEqual(SCREENSHOT_SPECS, [
    { name: 'second-mind-qa.png', width: 1440, height: 1050 },
    { name: 'second-mind-execution.png', width: 1440, height: 1050 },
    { name: 'second-mind-provider-config.png', width: 1440, height: 1050 },
    { name: 'second-mind-diary.png', width: 1280, height: 960 },
    { name: 'second-mind-plan.png', width: 1280, height: 960 },
    { name: 'second-mind-mobile.png', width: 360, height: 800 },
  ]);
  assert.equal(new Set(SCREENSHOT_SPECS.map(({ name }) => name)).size, 6);
});

test('capture CLI parses explicit destinations and rejects ambiguous arguments', () => {
  const defaults = parseArguments([]);
  assert.match(defaults.outputDir, /[/\\]docs[/\\]assets$/u);
  assert.equal(defaults.chromePath, '/usr/bin/google-chrome');
  assert.equal(defaults.help, false);

  assert.deepEqual(parseArguments([
    '--output-dir', 'tmp/release-captures',
    '--chrome', '/opt/chrome',
  ]), {
    outputDir: path.resolve('tmp/release-captures'),
    chromePath: '/opt/chrome',
    help: false,
  });
  assert.equal(parseArguments(['--help']).help, true);
  assert.throws(() => parseArguments(['--output-dir']), /requires a value/u);
  assert.throws(() => parseArguments(['--surprise']), /Unknown option/u);
});

test('PNG metadata stripping preserves dimensions and critical image chunks', () => {
  const original = fixturePng();
  const stripped = stripPngMetadata(original);

  assert.deepEqual(pngDimensions(original), { width: 360, height: 800 });
  assert.deepEqual(pngDimensions(stripped), { width: 360, height: 800 });
  assert.equal(stripped.includes(Buffer.from('tEXt')), false);
  assert.equal(stripped.includes(Buffer.from('pHYs')), false);
  assert.equal(stripped.includes(Buffer.from('IDAT')), true);
  assert.equal(stripped.includes(Buffer.from('IEND')), true);
  assert.deepEqual(stripPngMetadata(stripped), stripped);
});

test('PNG helpers reject non-PNG and truncated data', () => {
  assert.throws(() => pngDimensions(Buffer.from('not a png')), /did not return a PNG/u);
  assert.throws(
    () => stripPngMetadata(fixturePng().subarray(0, -3)),
    /truncated|boundary chunks/u,
  );
});
