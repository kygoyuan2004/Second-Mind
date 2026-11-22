import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { locatePassage, passageHeadings } from '../../public/knowledge-passage.js';

export function registerEvidence(task, passage) {
  task.evidence ??= new Map();
  const id = crypto.createHash('sha256').update(JSON.stringify([
    passage.path, passage.line, passage.quote,
  ])).digest('hex').slice(0, 16);
  task.evidence.set(id, passage);
  return `〔依据：${id}〕`;
}

export async function confirmPassage(store, task, { path, quote, line }) {
  const file = await store.existingFile(path);
  if (!/\.(md|txt)$/iu.test(file.relative) || file.stat.size > 2 * 1024 * 1024) {
    throw new Error('请选择 2 MiB 以内的 Markdown 或文本笔记。');
  }
  const text = (await fsp.readFile(file.target, 'utf8')).replace(/\r\n/g, '\n');
  quote = quote.replace(/\r\n/g, '\n').trim();
  const match = locatePassage(text, quote, line);
  if (!match) throw new Error('请逐字复制原文中的连续文字；重复引文还需传入其准确起始行。');
  const headings = /\.md$/iu.test(file.relative) ? passageHeadings(text, match.line) : [];
  return registerEvidence(task, { path: file.relative, line: match.line, headings, quote });
}

export function citedEvidence(task, text) {
  const entries = {};
  for (const match of text.matchAll(/〔依据[：:]([a-f0-9]{16})〕/gu)) {
    const item = task.evidence?.get(match[1]);
    if (item) entries[match[1]] = item;
  }
  return entries;
}
