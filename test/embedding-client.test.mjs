import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeEmbeddingUrl,
  EmbeddingClient,
  EmbeddingClientError,
} from '../src/embedding-client.mjs';

function response(status, payload) {
  return Response.json(payload, { status });
}

test('OpenAI-compatible embeddings use /embeddings, allow an empty API key, and preserve index order', async () => {
  const requests = [];
  const client = new EmbeddingClient({
    provider: 'openai-compatible',
    apiBase: 'http://127.0.0.1:11434/v1/',
    apiKey: '',
    model: 'local-embedding',
    dimensions: 3,
    batchSize: 2,
    timeoutMs: 1_000,
  }, {
    fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, options, body });
      return response(200, {
        data: body.input.map((_, index) => ({
          index,
          embedding: [index + 1, 0, 0],
        })).reverse(),
      });
    },
  });

  const vectors = await client.embed(['first', 'second', 'third'], { textType: 'document' });
  assert.deepEqual(vectors, [[1, 0, 0], [2, 0, 0], [1, 0, 0]]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/v1/embeddings');
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.deepEqual(requests[0].body, {
    model: 'local-embedding',
    input: ['first', 'second'],
    dimensions: 3,
  });
  assert.deepEqual(client.status(), {
    enabled: true,
    provider: 'openai-compatible',
    model: 'local-embedding',
    dimensions: 3,
    endpointConfigured: true,
    apiKeyConfigured: false,
  });
});

test('DashScope uses its native payload and accepts both legacy and OpenAI-shaped responses', async () => {
  const requests = [];
  const client = new EmbeddingClient({
    provider: 'dashscope',
    apiBase: 'https://dashscope.example.test',
    apiKey: 'example-test-secret',
    model: 'text-embedding-v4',
    dimensions: 4,
    batchSize: 10,
    timeoutMs: 1_000,
  }, {
    fetchFn: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return response(200, {
        output: {
          embeddings: [
            { text_index: 1, embedding: [0, 1, 0, 0] },
            { text_index: 0, embedding: [1, 0, 0, 0] },
          ],
        },
      });
    },
  });

  assert.deepEqual(
    await client.embed(['alpha', 'beta'], { textType: 'query', instruct: 'Retrieve notes.' }),
    [[1, 0, 0, 0], [0, 1, 0, 0]],
  );
  assert.equal(
    requests[0].url,
    'https://dashscope.example.test/api/v1/services/embeddings/text-embedding/text-embedding',
  );
  assert.equal(requests[0].options.headers.Authorization, 'Bearer example-test-secret');
  assert.deepEqual(requests[0].body, {
    model: 'text-embedding-v4',
    input: { texts: ['alpha', 'beta'] },
    parameters: {
      text_type: 'query',
      dimension: 4,
      output_type: 'dense',
      instruct: 'Retrieve notes.',
    },
  });
});

test('timeouts and caller cancellation abort fetch with stable error codes', async () => {
  const hangingFetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const client = new EmbeddingClient({
    provider: 'openai-compatible',
    endpoint: 'http://127.0.0.1:18080/embeddings',
    model: 'test',
    dimensions: 2,
    timeoutMs: 20,
  }, { fetchFn: hangingFetch });

  await assert.rejects(
    () => client.embed(['timeout']),
    (error) => error instanceof EmbeddingClientError && error.code === 'EMBEDDING_TIMEOUT',
  );

  const controller = new AbortController();
  const pending = client.embed(['cancel'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    () => pending,
    (error) => error.code === 'EMBEDDING_ABORTED' && error.name === 'AbortError',
  );
});

test('dimension and provider errors never expose API keys', async () => {
  const secret = 'do-not-leak-this-key';
  const failing = new EmbeddingClient({
    provider: 'openai-compatible',
    endpoint: 'https://embedding.example.test/embeddings',
    apiKey: secret,
    model: 'test',
    dimensions: 3,
  }, {
    fetchFn: async () => response(401, {
      error: { message: `credential ${secret} was rejected` },
    }),
  });
  await assert.rejects(async () => {
    try {
      await failing.embed(['private note']);
    } catch (error) {
      assert.doesNotMatch(String(error), new RegExp(secret));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      throw error;
    }
  }, (error) => error.code === 'EMBEDDING_API_ERROR');

  const wrongDimensions = new EmbeddingClient({
    provider: 'openai-compatible',
    endpoint: 'http://127.0.0.1:18080/embeddings',
    model: 'test',
    dimensions: 3,
  }, {
    fetchFn: async () => response(200, { data: [{ index: 0, embedding: [1, 2] }] }),
  });
  await assert.rejects(
    () => wrongDimensions.embed(['note']),
    (error) => error.code === 'EMBEDDING_DIMENSION_MISMATCH',
  );
});

test('disabled embeddings fail locally without invoking fetch', async () => {
  let called = false;
  const client = new EmbeddingClient({ provider: 'disabled' }, {
    fetchFn: async () => { called = true; },
  });
  assert.equal(client.status().enabled, false);
  assert.deepEqual(await client.embed([]), []);
  await assert.rejects(
    () => client.embed(['note']),
    (error) => error.code === 'EMBEDDING_DISABLED',
  );
  assert.equal(called, false);
});

test('plain HTTP is limited to local providers unless explicitly allowed', () => {
  assert.equal(
    assertSafeEmbeddingUrl('http://host.docker.internal:11434/v1/embeddings'),
    'http://host.docker.internal:11434/v1/embeddings',
  );
  assert.throws(
    () => new EmbeddingClient({
      provider: 'openai-compatible',
      endpoint: 'http://embedding.internal:8000/embeddings',
      model: 'test',
      dimensions: 3,
    }),
    { code: 'EMBEDDING_INSECURE_ENDPOINT' },
  );
  assert.doesNotThrow(() => new EmbeddingClient({
    provider: 'openai-compatible',
    endpoint: 'http://embedding.internal:8000/embeddings',
    allowInsecureHttp: true,
    model: 'test',
    dimensions: 3,
  }));
  assert.doesNotThrow(() => new EmbeddingClient({
    provider: 'openai-compatible',
    endpoint: 'https://embeddings.example.test/embeddings',
    model: 'test',
    dimensions: 3,
  }));
});

test('embedding provider response bodies are bounded before JSON parsing', async () => {
  const client = new EmbeddingClient({
    provider: 'openai-compatible',
    endpoint: 'http://127.0.0.1:18080/embeddings',
    model: 'test',
    dimensions: 3,
    timeoutMs: 1_000,
  }, {
    fetchFn: async () => new Response('x'.repeat(2 * 1024 * 1024), {
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    () => client.embed(['note']),
    { code: 'EMBEDDING_RESPONSE_TOO_LARGE' },
  );
});
