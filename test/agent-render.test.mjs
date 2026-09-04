import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

async function loadRenderer() {
  const source = await readFile(new URL('../public/agent-render.js', import.meta.url), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window });
  return window.VaultMindRenderer;
}

test('explicit TeX delimiters survive Markdown parsing by becoming KaTeX-safe dollar delimiters', async () => {
  const renderer = await loadRenderer();
  const source = String.raw`训练显存：

\[M_{\text{train}} \approx M_{\text{model state}} + M_{\text{activation}}\]

其中 \(P\) 是参数量。`;

  assert.equal(
    renderer.normalizeDisplayMath(source),
    String.raw`训练显存：

$$M_{\text{train}} \approx M_{\text{model state}} + M_{\text{activation}}$$

其中 $P$ 是参数量。`,
  );
});

test('math normalization leaves fenced code unchanged and compacts multiline display formulas', async () => {
  const renderer = await loadRenderer();
  const source = [
    String.raw`\[`,
    '  a + b',
    String.raw`\]`,
    '',
    '```text',
    String.raw`\[not_math\]`,
    String.raw`\(also_not_math\)`,
    '```',
  ].join('\n');

  assert.equal(
    renderer.normalizeDisplayMath(source),
    [
      '$$a + b$$',
      '',
      '```text',
      String.raw`\[not_math\]`,
      String.raw`\(also_not_math\)`,
      '```',
    ].join('\n'),
  );
});

test('long CommonMark fences protect shorter fence runs and TeX inside the block', async () => {
  const renderer = await loadRenderer();
  const source = [
    '````markdown',
    String.raw`\[not_math\]`,
    '```',
    String.raw`\(still_not_math\)`,
    '````',
    String.raw`\[real_math\]`,
  ].join('\n');

  assert.equal(
    renderer.normalizeDisplayMath(source),
    [
      '````markdown',
      String.raw`\[not_math\]`,
      '```',
      String.raw`\(still_not_math\)`,
      '````',
      '$$real_math$$',
    ].join('\n'),
  );
});

test('math normalization leaves inline code delimiters untouched', async () => {
  const renderer = await loadRenderer();
  const source = 'Use \\(x\\), but keep `\\(literal\\)` as code.';

  assert.equal(
    renderer.normalizeDisplayMath(source),
    'Use $x$, but keep `\\(literal\\)` as code.',
  );
});

test('math normalization follows CommonMark matching runs for multi-backtick code spans', async () => {
  const renderer = await loadRenderer();
  const source = 'Use \\(x\\), keep ``code `tick` \\(literal\\)`` and convert \\(y\\).';

  assert.equal(
    renderer.normalizeDisplayMath(source),
    'Use $x$, keep ``code `tick` \\(literal\\)`` and convert $y$.',
  );
});

test('multi-backtick code spans may contain line endings without exposing literal TeX', async () => {
  const renderer = await loadRenderer();
  const source = [
    'Before \\(x\\), then ``code `tick`',
    '\\(literal\\)`` and \\(y\\).',
  ].join('\n');

  assert.equal(
    renderer.normalizeDisplayMath(source),
    [
      'Before $x$, then ``code `tick`',
      '\\(literal\\)`` and $y$.',
    ].join('\n'),
  );
});

test('an unmatched backtick run does not suppress later math normalization', async () => {
  const renderer = await loadRenderer();
  const source = 'Unmatched `` marker, then \\(x\\).';

  assert.equal(renderer.normalizeDisplayMath(source), 'Unmatched `` marker, then $x$.');
});

test('an unmatched leading run does not misclassify plain text before a later valid code span', async () => {
  const renderer = await loadRenderer();
  const source = 'Unmatched ` then \\(x\\), keep ``code \\(literal\\)`` and render \\(y\\).';

  assert.equal(
    renderer.normalizeDisplayMath(source),
    'Unmatched ` then $x$, keep ``code \\(literal\\)`` and render $y$.',
  );
});

test('repairs standalone bare square-bracket display TeX without changing prose or source tokens', async () => {
  const renderer = await loadRenderer();
  const source = [
    '训练显存公式：',
    '',
    String.raw`[M_{\text{train}} \approx M_{\text{model state}} + M_{\text{activation}}]`,
    '',
    '[W1]',
    '[普通说明]',
  ].join('\n');

  assert.equal(
    renderer.normalizeDisplayMath(source),
    [
      '训练显存公式：',
      '',
      String.raw`$$M_{\text{train}} \approx M_{\text{model state}} + M_{\text{activation}}$$`,
      '',
      '[W1]',
      '[普通说明]',
    ].join('\n'),
  );
});
