import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEGACY_MODEL_ALIASES,
  createModelCatalog,
  publicModelCatalog,
  resolveModelSelection,
} from '../../src/original/model-catalog.mjs';

test('共享模型目录只公开真实模型名称和完整状态字段', () => {
  const catalog = createModelCatalog({ capabilities: {} });
  const models = publicModelCatalog(catalog);

  assert.deepEqual(models.map((model) => model.id), ['qwen', 'kimi', 'deepseek']);
  assert.equal(models.some((model) => /Fable|Opus|Sonnet|Haiku/.test(model.label)), false);
  assert.deepEqual(
    models.map(({ id, actualModel }) => [id, actualModel]),
    [
      ['qwen', 'qwen3.8-max[1M]'],
      ['kimi', 'kimi-k3[1M]'],
      ['deepseek', 'deepseek-v4-pro-0813'],
    ],
  );
  for (const model of models) {
    assert.equal(Array.isArray(model.modalities), true);
    assert.equal(Array.isArray(model.efforts), true);
    assert.equal(typeof model.defaultEffort, 'string');
    assert.equal(typeof model.available, 'boolean');
  }
  assert.deepEqual(models[0].efforts, ['low', 'medium', 'xhigh']);
  assert.deepEqual(models[1].efforts, ['default']);
  assert.deepEqual(models[2].efforts, ['default']);
});

test('历史模型别名映射到真实网关 ID 并安全回退旧 effort', () => {
  const catalog = createModelCatalog({ capabilities: {} });
  assert.deepEqual(LEGACY_MODEL_ALIASES, {
    default: 'qwen', fable: 'qwen', opus: 'qwen', sonnet: 'kimi', haiku: 'deepseek',
  });

  const qwen = resolveModelSelection('opus', 'high', { catalog });
  assert.equal(qwen.model.id, 'qwen');
  assert.equal(qwen.model.value, 'qwen3.8-max[1M]');
  assert.equal(qwen.effort.id, 'xhigh');

  const kimi = resolveModelSelection('sonnet', 'xhigh', { catalog });
  assert.equal(kimi.model.id, 'kimi');
  assert.equal(kimi.effort.id, 'default');

  const deepseek = resolveModelSelection('haiku', 'low', { catalog });
  assert.equal(deepseek.model.id, 'deepseek');
  assert.equal(deepseek.effort.id, 'default');

  assert.throws(
    () => resolveModelSelection('qwen', 'high', { catalog }),
    (error) => error.code === 'INVALID_EFFORT' && error.status === 400,
  );
});

test('只有能力探测缓存中成功的条件式档位才会出现', () => {
  const catalog = createModelCatalog({
    capabilities: {
      models: {
        kimi: { efforts: ['medium', 'xhigh', 'made-up'], defaultEffort: 'medium' },
        deepseek: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' },
      },
    },
  });
  const kimi = catalog.find((model) => model.id === 'kimi');
  const deepseek = catalog.find((model) => model.id === 'deepseek');

  assert.deepEqual(kimi.efforts, ['medium', 'xhigh']);
  assert.equal(kimi.defaultEffort, 'medium');
  assert.equal(kimi.capabilityVerified, true);
  assert.deepEqual(deepseek.efforts, ['high', 'max']);
  assert.equal(deepseek.defaultEffort, 'max');
});
