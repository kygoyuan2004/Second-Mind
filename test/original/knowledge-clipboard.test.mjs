import assert from 'node:assert/strict';
import test from 'node:test';
import { filesFromClipboard } from '../../public/knowledge-clipboard.js';

test('优先读取剪贴板 files 并避免与 items 重复', () => {
  const screenshot = { name: '截图.png', type: 'image/png', size: 128 };
  const duplicateItem = { kind: 'file', getAsFile: () => screenshot };
  assert.deepEqual(filesFromClipboard({ files: [screenshot], items: [duplicateItem] }), [screenshot]);
});

test('没有 files 时从剪贴板 items 提取文件并忽略文字项与空文件', () => {
  const note = { name: '记录.md', type: 'text/markdown', size: 64 };
  const clipboard = {
    files: [],
    items: [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => note },
      { kind: 'file', getAsFile: () => null },
    ],
  };
  assert.deepEqual(filesFromClipboard(clipboard), [note]);
  assert.deepEqual(filesFromClipboard(null), []);
});
