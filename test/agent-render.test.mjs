import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

async function loadRenderer() {
  const source = await readFile(new URL('../public/agent-render.js', import.meta.url), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window });
  return window.YuanAgentRenderer;
}

test('the migrated page exposes the original Yuan renderer contract', async () => {
  const renderer = await loadRenderer();
  assert.equal(typeof renderer?.normalizeDisplayMath, 'function');
  assert.equal(typeof renderer?.render, 'function');
  assert.equal(Object.isFrozen(renderer), true);
});

test('the original renderer compacts display math and preserves inline TeX', async () => {
  const renderer = await loadRenderer();
  const source = [
    '$$',
    ' a + b ',
    '$$',
    String.raw`\[`,
    ' c + d ',
    String.raw`\]`,
    String.raw`inline \(x\)`,
  ].join('\n');
  assert.equal(
    renderer.normalizeDisplayMath(source),
    ['$$a + b$$', String.raw`\[c + d\]`, String.raw`inline \(x\)`].join('\n'),
  );
});

test('the original renderer does not normalize TeX inside fenced code', async () => {
  const renderer = await loadRenderer();
  const source = ['```text', '$$', ' a + b ', '$$', '```', '$$', ' c + d ', '$$'].join('\n');
  assert.equal(
    renderer.normalizeDisplayMath(source),
    ['```text', '$$', ' a + b ', '$$', '```', '$$c + d$$'].join('\n'),
  );
});
