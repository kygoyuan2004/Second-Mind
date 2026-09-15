import fs from 'node:fs';

export const DEFAULT_EMBEDDING_MODEL = 'qwen3.7-text-embedding';
export const DEFAULT_RERANK_MODEL = 'qwen3-rerank';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 12_000;
export const DEFAULT_RERANK_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRIEVAL_SETTINGS_FILE = '';
export const QUERY_RETRIEVAL_INSTRUCTION =
  'Given a knowledge-base question, retrieve passages that directly answer it. Preserve names, dates, paths, identifiers, and temporal context.';
export const RERANK_INSTRUCTION =
  'Given a knowledge-base question, retrieve passages that directly answer the question.';

function retrievalError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function resolveRetrievalApiKey(options = {}) {
  const direct = String(
    options.apiKey ||
      process.env.KNOWLEDGE_BAILIAN_API_KEY ||
      process.env.DASHSCOPE_API_KEY ||
      process.env.BAILIAN_API_KEY ||
      '',
  ).trim();
  if (direct) return direct;
  const settingsFile = String(
    options.settingsFile ||
      process.env.KNOWLEDGE_BAILIAN_SETTINGS_FILE ||
      DEFAULT_RETRIEVAL_SETTINGS_FILE,
  );
  try {
    const stat = fs.statSync(settingsFile);
    if ((stat.mode & 0o077) !== 0) {
      throw retrievalError(
        `百炼凭据文件权限必须为 0600：${settingsFile}。`,
        'KNOWLEDGE_RETRIEVAL_INSECURE_CREDENTIAL_FILE',
      );
    }
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const fromSettings = String(
      parsed?.env?.DASHSCOPE_API_KEY || parsed?.env?.ANTHROPIC_AUTH_TOKEN || '',
    ).trim();
    if (fromSettings) return fromSettings;
  } catch (error) {
    if (error?.code === 'KNOWLEDGE_RETRIEVAL_INSECURE_CREDENTIAL_FILE') throw error;
  }
  throw retrievalError(
    '混合检索未找到可用的百炼 API Key。',
    'KNOWLEDGE_RETRIEVAL_NOT_CONFIGURED',
  );
}

function retrievalHost(options = {}) {
  const workspaceId = String(
    options.workspaceId || process.env.KNOWLEDGE_BAILIAN_WORKSPACE_ID || '',
  ).trim();
  if (workspaceId && !/^[a-zA-Z0-9-]+$/.test(workspaceId)) {
    throw retrievalError(
      '混合检索未配置有效的百炼业务空间 ID。',
      'KNOWLEDGE_RETRIEVAL_NOT_CONFIGURED',
    );
  }
  const region = String(
    options.region || process.env.KNOWLEDGE_BAILIAN_REGION || 'cn-beijing',
  ).trim();
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw retrievalError('百炼地域配置不正确。', 'KNOWLEDGE_RETRIEVAL_INVALID_REGION');
  }
  if (workspaceId) return `https://${workspaceId}.${region}.maas.aliyuncs.com`;
  const sharedHosts = {
    'cn-beijing': 'https://dashscope.aliyuncs.com',
    'ap-southeast-1': 'https://dashscope-intl.aliyuncs.com',
    'us-east-1': 'https://dashscope-us.aliyuncs.com',
  };
  const shared = sharedHosts[region];
  if (!shared) {
    throw retrievalError(
      `百炼地域 ${region} 必须配置业务空间 ID。`,
      'KNOWLEDGE_RETRIEVAL_NOT_CONFIGURED',
    );
  }
  return shared;
}

export function retrievalEndpoints(options = {}) {
  let host = '';
  const getHost = () => {
    if (!host) host = retrievalHost(options);
    return host;
  };
  return {
    embedding: String(
      options.embeddingEndpoint || process.env.KNOWLEDGE_EMBEDDING_ENDPOINT || '',
    ).trim() || `${getHost()}/api/v1/services/embeddings/text-embedding/text-embedding`,
    rerank: String(
      options.rerankEndpoint || process.env.KNOWLEDGE_RERANK_ENDPOINT || '',
    ).trim() || `${getHost()}/compatible-api/v1/reranks`,
  };
}

function parsePayload(raw, code) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw retrievalError('百炼检索服务返回了无法解析的响应。', code, error);
  }
}

async function postJson(endpoint, body, options) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs);
  const maxAttempts = 2;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener('abort', relayAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload;
      try {
        payload = parsePayload(raw, options.invalidResponseCode);
      } catch (error) {
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          lastError = error;
          continue;
        }
        throw error;
      }
      if (response.ok && !payload?.code && !payload?.error) return payload;
      const message = String(
        payload?.error?.message || payload?.message || `HTTP ${response.status}`,
      ).slice(0, 600);
      const error = retrievalError(
        `百炼检索服务请求失败：${message}`,
        options.apiErrorCode,
      );
      error.status = response.status;
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        lastError = error;
        continue;
      }
      throw error;
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (options.signal?.aborted) throw error;
        throw retrievalError(options.timeoutMessage, options.timeoutCode, error);
      }
      lastError = error;
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relayAbort);
    }
  }
  throw lastError;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class BailianRetrievalClient {
  constructor(options = {}) {
    this.options = options;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.embeddingModel = String(
      options.embeddingModel ||
        process.env.KNOWLEDGE_EMBEDDING_MODEL ||
        DEFAULT_EMBEDDING_MODEL,
    );
    this.rerankModel = String(
      options.rerankModel || process.env.KNOWLEDGE_RERANK_MODEL || DEFAULT_RERANK_MODEL,
    );
    this.dimensions = positiveInteger(
      options.dimensions || process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS,
      DEFAULT_EMBEDDING_DIMENSIONS,
    );
    this.embeddingTimeoutMs = positiveInteger(
      options.embeddingTimeoutMs || process.env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS,
      DEFAULT_EMBEDDING_TIMEOUT_MS,
    );
    this.rerankTimeoutMs = positiveInteger(
      options.rerankTimeoutMs || process.env.KNOWLEDGE_RERANK_TIMEOUT_MS,
      DEFAULT_RERANK_TIMEOUT_MS,
    );
  }

  configuration() {
    const apiKey = resolveRetrievalApiKey(this.options);
    const endpoints = retrievalEndpoints(this.options);
    return { apiKey, endpoints };
  }

  async embed(textsInput, options = {}) {
    const texts = (Array.isArray(textsInput) ? textsInput : [textsInput])
      .map((text) => String(text || ''));
    if (!texts.length || texts.some((text) => !text.trim())) {
      throw retrievalError('向量化文本不能为空。', 'KNOWLEDGE_EMBEDDING_INPUT_REQUIRED');
    }
    if (texts.length > 20) {
      throw retrievalError('单次向量化最多 20 个文本。', 'KNOWLEDGE_EMBEDDING_BATCH_TOO_LARGE');
    }
    const textType = options.textType === 'query' ? 'query' : 'document';
    const { apiKey, endpoints } = this.configuration();
    const parameters = {
      text_type: textType,
      dimension: this.dimensions,
      output_type: 'dense',
    };
    if (textType === 'query') {
      parameters.instruct = String(options.instruct || QUERY_RETRIEVAL_INSTRUCTION);
    }
    const payload = await postJson(endpoints.embedding, {
      model: this.embeddingModel,
      input: { texts },
      parameters,
    }, {
      apiKey,
      fetchFn: this.fetchFn,
      signal: options.signal,
      timeoutMs: this.embeddingTimeoutMs,
      timeoutMessage: `百炼 Embedding 超过 ${Math.round(this.embeddingTimeoutMs / 1000)} 秒，已回退词法检索。`,
      timeoutCode: 'KNOWLEDGE_EMBEDDING_TIMEOUT',
      invalidResponseCode: 'KNOWLEDGE_EMBEDDING_INVALID_RESPONSE',
      apiErrorCode: 'KNOWLEDGE_EMBEDDING_API_ERROR',
    });
    const rows = Array.isArray(payload?.output?.embeddings)
      ? payload.output.embeddings
      : Array.isArray(payload?.data) ? payload.data : [];
    const ordered = [...rows].sort((left, right) => (
      Number(left.text_index ?? left.index) - Number(right.text_index ?? right.index)
    ));
    const vectors = ordered.map((row) => row?.embedding);
    if (
      vectors.length !== texts.length ||
      vectors.some((vector) => !Array.isArray(vector) || vector.length !== this.dimensions)
    ) {
      throw retrievalError(
        `Embedding 维度与索引配置不一致（期望 ${this.dimensions} 维）。`,
        'KNOWLEDGE_EMBEDDING_DIMENSION_MISMATCH',
      );
    }
    return vectors;
  }

  async rerank(queryInput, documentsInput, options = {}) {
    const query = String(queryInput || '').trim();
    const documents = (Array.isArray(documentsInput) ? documentsInput : [])
      .map((document) => String(document || ''));
    if (!query || !documents.length) {
      throw retrievalError('重排序查询和候选文档不能为空。', 'KNOWLEDGE_RERANK_INPUT_REQUIRED');
    }
    const { apiKey, endpoints } = this.configuration();
    const topN = Math.max(1, Math.min(documents.length, positiveInteger(options.topN, documents.length)));
    const payload = await postJson(endpoints.rerank, {
      model: this.rerankModel,
      query,
      documents,
      top_n: topN,
      instruct: String(options.instruct || RERANK_INSTRUCTION),
    }, {
      apiKey,
      fetchFn: this.fetchFn,
      signal: options.signal,
      timeoutMs: this.rerankTimeoutMs,
      timeoutMessage: `百炼 Reranker 超过 ${Math.round(this.rerankTimeoutMs / 1000)} 秒，已使用 RRF 结果。`,
      timeoutCode: 'KNOWLEDGE_RERANK_TIMEOUT',
      invalidResponseCode: 'KNOWLEDGE_RERANK_INVALID_RESPONSE',
      apiErrorCode: 'KNOWLEDGE_RERANK_API_ERROR',
    });
    const results = Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload?.output?.results) ? payload.output.results : [];
    const parsed = results.map((result) => ({
      index: Number(result?.index),
      score: Number(result?.relevance_score),
    })).filter((result) => (
      Number.isSafeInteger(result.index) &&
      result.index >= 0 &&
      result.index < documents.length &&
      Number.isFinite(result.score)
    ));
    if (!parsed.length) {
      throw retrievalError('百炼 Reranker 没有返回可用结果。', 'KNOWLEDGE_RERANK_EMPTY');
    }
    return parsed.slice(0, topN);
  }
}
