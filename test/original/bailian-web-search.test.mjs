import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BAILIAN_SEARCH_TOOL,
  DEFAULT_BAILIAN_SEARCH_TIMEOUT_MS,
  createBailianSearchServer,
  parseBailianSearchResponse,
  searchBailianWeb,
} from '../../src/original/bailian-web-search.mjs';

const successPayload = {
  status: 'completed',
  output: [
    {
      type: 'web_search_call',
      action: {
        type: 'search',
        sources: [{ type: 'url', url: 'https://example.com/search-result' }],
      },
    },
    { type: 'web_extractor_call', urls: ['https://example.com/article'] },
    {
      type: 'message',
      content: [{ type: 'output_text', text: '这是经过真实搜索核验的摘要。' }],
    },
  ],
};

test('解析 Responses API 的真实搜索、网页抽取和来源 URL', () => {
  const result = parseBailianSearchResponse(successPayload);
  assert.equal(result.text, '这是经过真实搜索核验的摘要。');
  assert.equal(result.usedExtractor, true);
  assert.deepEqual(result.urls, [
    'https://example.com/search-result',
    'https://example.com/article',
  ]);
});

test('缺少真实 web_search_call 时拒绝把普通模型回答冒充搜索结果', () => {
  assert.throws(
    () => parseBailianSearchResponse({
      status: 'completed',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: '凭记忆生成的回答' }],
      }],
    }),
    (error) => error.code === 'BAILIAN_SEARCH_NOT_USED',
  );
});

test('搜索请求使用 web_search 与 web_extractor 且不设置费用上限', async () => {
  let request;
  const result = await searchBailianWeb('查询最新资料', {
    apiKey: 'test-key',
    fetchFn: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify(successPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(result.text, '这是经过真实搜索核验的摘要。');
  assert.deepEqual(request.tools, [{ type: 'web_search' }, { type: 'web_extractor' }]);
  assert.equal('max_output_tokens' in request, false);
  assert.equal('max_budget_usd' in request, false);
});

test('本地 MCP 服务器公开固定搜索工具且默认超时为 60 秒', () => {
  const server = createBailianSearchServer({ apiKey: 'test-key' });
  assert.equal(server.type, 'sdk');
  assert.equal(DEFAULT_BAILIAN_SEARCH_TIMEOUT_MS, 60_000);
  assert.equal(BAILIAN_SEARCH_TOOL, 'mcp__bailian_search__search_web');
});
