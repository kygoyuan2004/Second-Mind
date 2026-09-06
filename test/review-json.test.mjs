import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReviewJson } from '../src/review-json.mjs';

test('unescaped interior quotes are recovered without changing the text values', () => {
  const parsed = parseReviewJson('{"facts":[{"topic":"了解"测算子"","statement":"阅读 "CUDA" 的介绍","evidence":[{"quote":"已复习 "CUDA" 基础"}]}]}');
  assert.equal(parsed.facts[0].topic, '了解"测算子"');
  assert.equal(parsed.facts[0].statement, '阅读 "CUDA" 的介绍');
  assert.equal(parsed.facts[0].evidence[0].quote, '已复习 "CUDA" 基础');
  assert.deepEqual(parseReviewJson(`JSON\n\`\`\`JSON\n${JSON.stringify(parsed)}\n\`\`\``), parsed);
});

test('quote recovery rejects every other kind of repair, including invented closing content', () => {
  for (const input of [
    '{"facts":[{"topic":"CUDA" "status":"planned"}]}',
    '{"facts":[{"topic":"CUDA",}]}', '{facts:[]}', "{'facts':[]}",
    '{"facts":True}', '{"facts":[{"topic":"CUDA',
    '{"facts":[{"quote":"first\nsecond"}]}',
  ]) assert.throws(() => parseReviewJson(input), SyntaxError, input);
  assert.throws(() => parseReviewJson(`{"facts":[{"quote":"${'x'.repeat(128_000)} "CUDA""}]}`), SyntaxError);
});
