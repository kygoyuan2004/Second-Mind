import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createPinnedModelFetch } from './model-transport.mjs';
import { markPublicMessage } from './public-errors.mjs';
import { identifyModelProvider, resolveModelProvider, providerModelReasoningPolicy } from './model-provider-registry.mjs';

function failure(code, message, status = 400) {
  return markPublicMessage(Object.assign(new Error(message), { code, status }));
}

const bindingByModel = new WeakMap();
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function sdkCatalog(snapshot) {
  const connections = snapshot.connections || [];
  return (snapshot.models || []).filter((m) => m.enabled !== false).map((source) => {
    const connection = connections.find((c) => c.id === (source.connectionId || source.provider));
    const providerId = connection?.providerId || identifyModelProvider(connection || {});
    let native = { efforts: ['default'], defaultEffort: 'default' };
    try {
      native = providerModelReasoningPolicy(resolveModelProvider({ ...connection, providerId }), source.actualModel);
    } catch { /* Invalid bindings remain visible and fail explicitly when selected. */ }
    const model = {
      ...source,
      label: source.label || source.displayName || source.actualModel,
      shortLabel: source.shortLabel || source.label || source.displayName || source.actualModel,
      value: source.actualModel,
      modalities: /^qwen3\.8-max/.test(source.actualModel) ? ['text', 'image', 'pdf'] : ['text'],
      efforts: native.efforts,
      defaultEffort: native.efforts.includes(source.defaultEffort) ? source.defaultEffort : native.defaultEffort,
      available: Boolean(connection && (connection.authMode === 'none' || connection.apiKey) && source.available !== false),
      capabilityVerified: false,
    };
    if (connection) bindingByModel.set(model, Object.freeze({
      ...connection, providerId, model: source.actualModel, webSearch: snapshot.webSearch,
      revision: digest({ connectionId: connection.id, protocol: connection.protocol,
        apiBase: connection.apiBase, actualModel: source.actualModel,
        webSearch: snapshot.webSearch ? { enabled: snapshot.webSearch.enabled, provider: snapshot.webSearch.provider } : null }),
    }));
    return model;
  });
}

export function sdkBinding(model) {
  const binding = bindingByModel.get(model);
  if (!binding) throw failure('MODEL_CONNECTION_INCOMPLETE', '模型连接未配置，请在配置管理页保存设置。', 409);
  if (binding.protocol !== 'anthropic-messages') {
    throw failure('SDK_PROTOCOL_UNSUPPORTED', 'Claude Agent SDK 需要 Anthropic Messages 协议；当前连接尚未通过 SDK 兼容验证。', 422);
  }
  const url = new URL(binding.apiBase);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw failure('SDK_ENDPOINT_INVALID', '模型地址必须是无凭据参数的 HTTPS API Base。');
  }
  if (binding.providerId === 'deepseek' && url.hostname !== 'api.deepseek.com') {
    throw failure('SDK_ENDPOINT_INVALID', 'DeepSeek 官方凭据只允许发送到 api.deepseek.com。');
  }
  return binding;
}

/** The SDK owns the agent loop. This local transport only forwards Messages
 * requests, keeping the real key out of SDK processes, settings and sessions.
 * Pinned HTTPS rejects redirects and private destinations on the server side. */
export async function openSdkTransport(binding, options = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const fetchFn = options.fetch || createPinnedModelFetch();
  const requests = [];
  const controllers = new Set();
  const sockets = new Set();
  const base = binding.apiBase.replace(/\/+$/, '');
  const endpoint = base.endsWith('/v1/messages') ? base : base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  const server = http.createServer(async (req, res) => {
    const deny = (status, code) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: code, message: code } }));
    };
    if (req.headers['x-api-key'] !== token && req.headers.authorization !== `Bearer ${token}`) return deny(401, 'authentication_error');
    const requestPath = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(requestPath)) return deny(404, 'not_found_error');
    const controller = new AbortController();
    controllers.add(controller);
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) return deny(413, 'request_too_large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Preserve the SDK's context-window suffix handling while preventing
      // aliases or helper requests from silently choosing a different model.
      const wireModel = binding.model.replace(/\[(?:1m|200k)\]$/i, '');
      if (![binding.model, wireModel].includes(body.model)) return deny(400, 'model_mismatch');
      const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
      if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
      if (binding.authMode === 'bearer') headers.authorization = `Bearer ${binding.apiKey}`;
      else if (binding.authMode !== 'none') headers['x-api-key'] = binding.apiKey;
      const record = { model: body.model, configuredModel: binding.model, host: new URL(endpoint).hostname,
        startedAt: new Date().toISOString(), stream: body.stream === true,
        effort: body.output_config?.effort || null, thinking: body.thinking?.type || null,
        maxTokens: body.max_tokens, toolCount: body.tools?.length || 0 };
      requests.push(record);
      const upstream = await fetchFn(requestPath.endsWith('/count_tokens') ? `${endpoint}/count_tokens` : endpoint, { method: 'POST', headers,
        body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      record.status = upstream.status;
      if (!upstream.ok) {
        // Vendor diagnostics can echo credentials, request content or account IDs.
        await upstream.body?.cancel?.();
        deny(upstream.status, upstream.status === 401 || upstream.status === 403
          ? 'authentication_error' : upstream.status === 429 ? 'rate_limit_error' : 'api_error');
        options.onFailure?.({ status: upstream.status });
        return;
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      record.finishedAt = new Date().toISOString();
      res.end();
    } catch {
      if (!res.headersSent) deny(502, 'api_error');
      else res.destroy();
    } finally { controllers.delete(controller); }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`, token, requests,
    async close() {
      for (const c of controllers) c.abort();
      const done = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await done;
    },
  };
}

export async function sdkEnvironment(root, transport) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  // A strict allowlist prevents host credentials, provider routing, user
  // plugins, proxy authentication and private Claude settings from inheriting.
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root,
    ANTHROPIC_BASE_URL: transport.baseUrl, ANTHROPIC_AUTH_TOKEN: transport.token,
    CUDA_VISIBLE_DEVICES: '', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '131072',
  };
}

export class SdkModelRuntime {
  constructor(options = {}) {
    this.registry = options.registry;
    this.stateDir = path.resolve(options.stateDir || 'data/sdk-validation');
    this.query = options.query || query;
    this.fetch = options.fetch;
  }

  async validateAllEnabled(snapshot, options = {}) {
    const catalog = sdkCatalog(snapshot).filter((model) => !options.modelIds || options.modelIds.includes(model.id));
    if (!catalog.length) throw failure('MODEL_CATALOG_EMPTY', '至少需要一个已启用的模型。');
    const results = [];
    // Probes are intentionally bounded and sequential to avoid paid fan-out.
    for (const model of catalog) {
      let transport, handle;
      const abortController = new AbortController();
      const timer = setTimeout(() => { abortController.abort(); handle?.close?.(); }, 90_000);
      const root = path.join(this.stateDir, crypto.randomUUID());
      try {
        transport = await openSdkTransport(sdkBinding(model), { fetch: this.fetch, onFailure: () => {
          abortController.abort(); handle?.close?.();
        } });
        const env = await sdkEnvironment(root, transport);
        handle = this.query({ prompt: 'Connection check. Reply with OK.', options: {
          cwd: root, model: model.actualModel, tools: [], allowedTools: [],
          permissionMode: 'dontAsk', settingSources: [], strictMcpConfig: true,
          mcpServers: {}, skills: [], env, abortController, maxTurns: 2,
          effort: (model.effortMapping?.[model.defaultEffort] || model.defaultEffort) === 'default' ? undefined : (model.effortMapping?.[model.defaultEffort] || model.defaultEffort),
          includePartialMessages: true, stderr: () => {},
        } });
        let success = false;
        for await (const message of handle) if (message.type === 'result') success = message.subtype === 'success';
        if (!success) throw failure('SDK_VALIDATION_FAILED', 'SDK 连接检查未完成；请检查协议、模型和凭据。', 422);
        results.push({ modelId: model.id, ok: true, code: 'SDK_CONNECTION_VERIFIED', message: '', capability: 'sdk-connection' });
      } catch (error) {
        const code = /^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'SDK_VALIDATION_FAILED';
        results.push({ modelId: model.id, ok: false, code, message: code === 'SDK_PROTOCOL_UNSUPPORTED'
          ? '此连接需要受支持的 Anthropic Messages 接口。' : 'SDK 连接检查失败；请核对模型与凭据。' });
      } finally {
        clearTimeout(timer); handle?.close?.(); await transport?.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    }
    if (results.some((r) => !r.ok)) {
      const error = failure('LLM_VALIDATION_FAILED', '部分模型未通过 SDK 连接检查。', 422);
      error.results = results; throw error;
    }
    return { ok: true, checked: results.length, results };
  }
  validateSnapshot(snapshot, options) { return this.validateAllEnabled(snapshot, options); }
}
