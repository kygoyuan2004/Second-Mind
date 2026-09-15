import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BailianRetrievalClient,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  DEFAULT_RERANK_TIMEOUT_MS,
  resolveRetrievalApiKey,
  retrievalEndpoints,
} from '../../src/original/bailian-retrieval.mjs';

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test('Embedding 使用 workspace 原生接口、text_type、1024 维和固定英文指令', async () => {
  let request;
  const client = new BailianRetrievalClient({
    apiKey: 'test-key',
    workspaceId: 'ws-test',
    fetchFn: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response(200, {
        output: { embeddings: [{ text_index: 0, embedding: Array(1024).fill(0.25) }] },
      });
    },
  });
  const vectors = await client.embed(['追问检索'], { textType: 'query' });
  assert.match(request.url, /ws-test\.cn-beijing\.maas\.aliyuncs\.com\/api\/v1\/services\/embeddings/);
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'qwen3.7-text-embedding');
  assert.deepEqual(request.body.input.texts, ['追问检索']);
  assert.equal(request.body.parameters.text_type, 'query');
  assert.equal(request.body.parameters.dimension, 1024);
  assert.match(request.body.parameters.instruct, /^Given a knowledge-base question/);
  assert.equal(vectors[0].length, 1024);
  assert.equal(DEFAULT_EMBEDDING_TIMEOUT_MS, 12_000);
});

test('qwen3-rerank 使用顶层 query/documents/top_n 并解析顶层 results', async () => {
  let body;
  const client = new BailianRetrievalClient({
    apiKey: 'test-key',
    workspaceId: 'ws-test',
    fetchFn: async (url, options) => {
      assert.match(url, /compatible-api\/v1\/reranks$/);
      body = JSON.parse(options.body);
      return response(200, {
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.72 },
        ],
      });
    },
  });
  const ranked = await client.rerank('哪个答案', ['A', 'B'], { topN: 2 });
  assert.deepEqual(body.documents, ['A', 'B']);
  assert.equal(body.query, '哪个答案');
  assert.equal(body.top_n, 2);
  assert.equal('input' in body, false);
  assert.deepEqual(ranked, [{ index: 1, score: 0.91 }, { index: 0, score: 0.72 }]);
  assert.equal(DEFAULT_RERANK_TIMEOUT_MS, 20_000);
});

test('无 workspace 时复用权限 0600 的 Claude 百炼凭据并使用共享北京端点', {
  skip: process.platform === 'win32' && 'POSIX credential-file permissions run on Linux/macOS; Windows deploys the Linux container.',
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bailian-retrieval-key-'));
  const settingsFile = path.join(directory, 'settings.json');
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'reused-dashscope-key' },
    }), { mode: 0o600 });
    fs.chmodSync(settingsFile, 0o600);
    assert.equal(resolveRetrievalApiKey({ settingsFile }), 'reused-dashscope-key');
    assert.deepEqual(retrievalEndpoints(), {
      embedding: 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding',
      rerank: 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks',
    });

    fs.chmodSync(settingsFile, 0o644);
    assert.throws(
      () => resolveRetrievalApiKey({ settingsFile }),
      (error) => error.code === 'KNOWLEDGE_RETRIEVAL_INSECURE_CREDENTIAL_FILE',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('仅对 429 和 5xx 重试一次，维度不匹配会失败', async () => {
  let attempts = 0;
  const retrying = new BailianRetrievalClient({
    apiKey: 'test-key',
    embeddingEndpoint: 'https://example.test/embeddings',
    rerankEndpoint: 'https://example.test/reranks',
    dimensions: 4,
    fetchFn: async () => {
      attempts += 1;
      if (attempts === 1) return response(429, { message: 'slow down' });
      return response(200, { output: { embeddings: [{ text_index: 0, embedding: [1, 0, 0, 0] }] } });
    },
  });
  assert.deepEqual(await retrying.embed(['A']), [[1, 0, 0, 0]]);
  assert.equal(attempts, 2);

  let badRequestAttempts = 0;
  const badRequest = new BailianRetrievalClient({
    apiKey: 'test-key',
    embeddingEndpoint: 'https://example.test/embeddings',
    rerankEndpoint: 'https://example.test/reranks',
    dimensions: 4,
    fetchFn: async () => {
      badRequestAttempts += 1;
      return response(400, { message: 'bad request' });
    },
  });
  await assert.rejects(() => badRequest.embed(['A']), (error) => error.code === 'KNOWLEDGE_EMBEDDING_API_ERROR');
  assert.equal(badRequestAttempts, 1);

  const mismatch = new BailianRetrievalClient({
    apiKey: 'test-key',
    embeddingEndpoint: 'https://example.test/embeddings',
    rerankEndpoint: 'https://example.test/reranks',
    dimensions: 4,
    fetchFn: async () => response(200, {
      output: { embeddings: [{ text_index: 0, embedding: [1, 2] }] },
    }),
  });
  await assert.rejects(
    () => mismatch.embed(['A']),
    (error) => error.code === 'KNOWLEDGE_EMBEDDING_DIMENSION_MISMATCH',
  );
});

test('Embedding 超时使用 AbortSignal 中断', async () => {
  const client = new BailianRetrievalClient({
    apiKey: 'test-key',
    embeddingEndpoint: 'https://example.test/embeddings',
    rerankEndpoint: 'https://example.test/reranks',
    embeddingTimeoutMs: 10,
    fetchFn: async (_url, options) => new Promise((resolve, reject) => {
      const keepAlive = setInterval(() => {}, 50);
      options.signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  await assert.rejects(
    () => client.embed(['A']),
    (error) => error.code === 'KNOWLEDGE_EMBEDDING_TIMEOUT',
  );
});
