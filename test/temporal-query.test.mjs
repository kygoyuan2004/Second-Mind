import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyVaultTemporalRequest,
  isVaultTemporalInventoryQuestion,
  parseVaultTemporalRequest,
} from '../src/temporal-query.mjs';

const NOW = Date.parse('2026-09-03T06:30:00.000Z'); // 2026-09-03 14:30 in Shanghai

test('parses a two-week learning inventory using an explicit Shanghai mtime window', () => {
  const value = parseVaultTemporalRequest('这两周我都学习了哪些内容', {
    now: NOW,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(value.kind, 'vault_mtime_inventory');
  assert.equal(value.scope, 'learning');
  assert.equal(value.range.startLocal, '2026-08-21 00:00:00');
  assert.equal(value.range.endLocal, '2026-09-03 14:30:00');
  assert.equal(value.range.startInclusive, '2026-08-20T16:00:00.000Z');
  assert.equal(value.range.endExclusive, '2026-09-03T06:30:00.001Z');
});

test('calendar periods use [start,end) boundaries in the configured timezone', () => {
  const thisWeek = parseVaultTemporalRequest('本周更新了哪些笔记', {
    now: NOW,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(thisWeek.range.startLocal, '2026-08-31 00:00:00');
  assert.equal(thisWeek.range.endExclusive, '2026-09-03T06:30:00.001Z');

  const lastWeek = parseVaultTemporalRequest('上周写了哪些文件', {
    now: NOW,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(lastWeek.range.startLocal, '2026-08-24 00:00:00');
  assert.equal(lastWeek.range.endLocal, '2026-08-31 00:00:00');

  const lastMonth = parseVaultTemporalRequest('上个月整理了哪些笔记', {
    now: NOW,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(lastMonth.range.startLocal, '2026-08-01 00:00:00');
  assert.equal(lastMonth.range.endLocal, '2026-09-01 00:00:00');
});

test('half-month and one-year personal inventories parse deterministically', () => {
  const halfMonth = parseVaultTemporalRequest('过去半个月我学习了什么', {
    now: NOW,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(halfMonth.range.startLocal, '2026-08-20 00:00:00');
  assert.equal(halfMonth.range.endExclusive, '2026-09-03T06:30:00.001Z');

  const year = parseVaultTemporalRequest('最近一年我学习了什么', {
    now: NOW,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(year.range.startLocal, '2025-09-03 00:00:00');
  assert.equal(year.range.endExclusive, '2026-09-03T06:30:00.001Z');
});

test('spaced and unspaced preceding-week phrases use complete past calendar weeks', () => {
  for (const question of ['前2周我学习了什么', '前 2 周我学习了什么']) {
    const value = parseVaultTemporalRequest(question, {
      now: NOW,
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(value.range.startLocal, '2026-08-17 00:00:00');
    assert.equal(value.range.endLocal, '2026-08-31 00:00:00');
  }
});

test('an explicit private inventory with an unsupported relative period is classified fail-closed', () => {
  const value = classifyVaultTemporalRequest('最近一个季度我学习了什么', {
    now: NOW,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(value.matched, true);
  assert.equal(value.supported, false);
  assert.equal(value.plan, null);
  assert.equal(value.reason, 'unsupported_relative_period');
  assert.equal(isVaultTemporalInventoryQuestion('最近一个季度我学习了什么'), true);
});

test('does not reinterpret an ordinary time-sensitive fact question as a Vault inventory', () => {
  assert.equal(isVaultTemporalInventoryQuestion('这两周天气怎么样'), false);
  assert.equal(isVaultTemporalInventoryQuestion('这两周有什么新闻'), false);
  assert.equal(isVaultTemporalInventoryQuestion('最近两周量子计算研究有哪些进展'), false);
  assert.equal(isVaultTemporalInventoryQuestion('最近两周有哪些论文发表'), false);
  assert.equal(isVaultTemporalInventoryQuestion('最近两周学生学习了哪些内容'), false);
  assert.equal(isVaultTemporalInventoryQuestion('这个模型最近两周学习了哪些内容'), false);
  assert.equal(isVaultTemporalInventoryQuestion('我想知道最近两周 OpenAI 更新了哪些模型'), false);
  assert.equal(isVaultTemporalInventoryQuestion('我们国家最近两周更新了哪些政策'), false);
  assert.equal(isVaultTemporalInventoryQuestion('I want to know what OpenAI updated in the last 2 weeks'), false);
  assert.equal(isVaultTemporalInventoryQuestion('What did I study in the last 2 weeks?'), true);
  assert.equal(parseVaultTemporalRequest('最近两周市场有哪些更新', { now: NOW }), null);
  assert.equal(parseVaultTemporalRequest('目前董事长是谁', { now: NOW }), null);
  assert.equal(isVaultTemporalInventoryQuestion('这两周我都学习了哪些内容'), true);
});
