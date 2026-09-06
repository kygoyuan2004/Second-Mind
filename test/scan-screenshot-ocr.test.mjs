import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCREENSHOT_PATHS,
  findOcrCategories,
  formatFindings,
  parsePrivateTerms,
} from '../scripts/scan-screenshot-ocr.mjs';

test('OCR scanner covers the illustration and six canonical release screenshots', () => {
  assert.deepEqual(SCREENSHOT_PATHS, [
    'docs/assets/second-mind-hero.png',
    'docs/assets/second-mind-qa.png',
    'docs/assets/second-mind-execution.png',
    'docs/assets/second-mind-provider-config.png',
    'docs/assets/second-mind-diary.png',
    'docs/assets/second-mind-plan.png',
    'docs/assets/second-mind-mobile.png',
  ]);
  assert.equal(new Set(SCREENSHOT_PATHS).size, 7);
});

test('OCR scanner identifies credential, address, private path, and denylist categories', () => {
  const accessKey = ['AKIA', 'A'.repeat(16)].join('');
  const privatePath = ['', 'home', 'synthetic-user', 'vault', 'note.md'].join('/');
  const privateTerm = ['synthetic', 'private', 'customer'].join('-');
  const text = [
    accessKey,
    privatePath,
    'Service: localhost',
    'Remote endpoint: 192.0.2.10',
    privateTerm,
  ].join('\n');

  assert.deepEqual(new Set(findOcrCategories(text, [privateTerm])), new Set([
    'AWS access key',
    'private filesystem path',
    'localhost address',
    'IP address',
    'operator-supplied private term',
  ]));
});

test('OCR findings report categories without disclosing recognized values', () => {
  const credential = ['sk', 'Z'.repeat(24)].join('-');
  const categories = findOcrCategories(`API key: ${credential}`);
  const report = formatFindings(categories.map((category) => ({
    relative: SCREENSHOT_PATHS[0],
    category,
  })));

  assert.match(report, /OpenAI-style secret/u);
  assert.match(report, /visible credential value/u);
  assert.equal(report.includes(credential), false);
});

test('private-term parsing trims, deduplicates, and ignores empty entries', () => {
  assert.deepEqual(parsePrivateTerms(' alpha, beta,alpha, ,'), ['alpha', 'beta']);
  assert.deepEqual(findOcrCategories('API key configured: false'), []);
});
