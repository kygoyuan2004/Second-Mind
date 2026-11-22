#!/usr/bin/env node
// Run with the installed resources/runtime/node/node.exe. Credentials arrive
// only on stdin; stdout is a small JSONL report, never model/provider text.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const output = process.stdout.write.bind(process.stdout);
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
const emit = (value) => output(`${JSON.stringify(value)}\n`);
const failure = (code) => Object.assign(new Error(code), { code });
const safeCode = (error, fallback = 'LIVE_CHECK_FAILED') => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : fallback;
const report = { actualProvider: true, simulatedModel: false, checks: [], storageCodec: 'ephemeral AES; installed Electron DPAPI verified separately' };
let backend;
let fixture;
let connection;
let activeTask;
let completion = false;
let requiredCheckCount = 7;

function args() {
  const values = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (key === '--llm-only') { values.llmOnly = true; continue; }
    if (!['--resources', '--work-dir'].includes(key) || !process.argv[index + 1]) throw failure('ARGUMENTS_INVALID');
    values[key.slice(2)] = path.resolve(process.argv[++index]);
  }
  if (!values.resources || !values['work-dir']) throw failure('ARGUMENTS_REQUIRED');
  return values;
}

async function input() {
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => { emit({ check: 'input', ok: false, code: 'STDIN_TIMEOUT' }); process.exit(1); }, 15_000);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 256 * 1024) throw failure('INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw failure('INPUT_JSON_INVALID'); }
  } finally { clearTimeout(timer); for (const chunk of chunks) chunk.fill(0); }
}

function selectConfig(value, { llmOnly = false } = {}) {
  const selectedConnection = value.connection || value.connections?.find((item) => item.providerId === 'bailian' && item.protocol === 'anthropic-messages');
  if (!selectedConnection || !selectedConnection.apiKey) throw failure('BAILIAN_CREDENTIAL_REQUIRED');
  const base = new URL(selectedConnection.apiBase);
  if (base.protocol !== 'https:' || base.hostname !== 'dashscope.aliyuncs.com' || base.username || base.password || base.search || base.hash) throw failure('BAILIAN_ENDPOINT_INVALID');
  const selectedModel = value.model || value.models?.find((item) => item.enabled !== false && item.connectionId === selectedConnection.id && /^qwen/.test(item.actualModel));
  if (!selectedModel?.actualModel || !Array.isArray(selectedModel.efforts)) throw failure('BAILIAN_MODEL_REQUIRED');
  const effort = selectedModel.efforts.includes('low') ? 'low' : selectedModel.efforts.includes('medium') ? 'medium' : selectedModel.defaultEffort;
  const embedding = value.embedding;
  const webKey = value.webSearch?.providers?.['bailian-mcp']?.apiKey || value.webSearch?.apiKey;
  if (!llmOnly) {
    if (embedding?.provider !== 'dashscope' || !embedding.apiKey || !webKey) throw failure('EMBEDDING_AND_WEB_CREDENTIAL_REQUIRED');
    const embeddingBase = new URL(embedding.apiBase);
    if (embeddingBase.protocol !== 'https:' || embeddingBase.hostname !== 'dashscope.aliyuncs.com' || embeddingBase.username || embeddingBase.password || embeddingBase.search || embeddingBase.hash) throw failure('EMBEDDING_ENDPOINT_INVALID');
  }
  return {
    connection: {
      id: 'live-bailian', label: 'Live acceptance Bailian', providerId: 'bailian',
      protocol: 'anthropic-messages', apiBase: selectedConnection.apiBase,
      authMode: selectedConnection.authMode || 'x-api-key', apiKeyAction: 'replace', apiKey: selectedConnection.apiKey,
    },
    model: {
      id: 'live-qwen', displayName: 'Live acceptance Qwen', shortLabel: 'Qwen', connectionId: 'live-bailian',
      actualModel: selectedModel.actualModel, requestProfile: selectedModel.requestProfile || 'anthropic-standard',
      efforts: selectedModel.efforts, defaultEffort: selectedModel.defaultEffort, enabled: true, description: 'Synthetic acceptance only',
    },
    effort,
    embedding: !llmOnly ? { provider: 'dashscope', apiBase: embedding.apiBase, apiKey: embedding.apiKey, model: embedding.model,
      dimensions: embedding.dimensions, batchSize: 1, timeoutMs: 30_000 } : null,
    webKey,
    secrets: [selectedConnection.apiKey, embedding?.apiKey, webKey].filter(Boolean),
  };
}

function codec() {
  const key = crypto.randomBytes(32);
  return {
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt(value) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]);
    },
  };
}

async function call(route, options = {}) {
  const response = await fetch(`${connection.origin}${route}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(95_000),
    headers: { 'X-SecondMind-Desktop-Token': connection.token, 'x-vaultmind-request': '1',
      origin: connection.origin, 'content-type': 'application/json', ...options.headers },
  });
  if (!response.ok) {
    let code;
    try { code = (await response.json()).error; } catch {}
    throw failure(/^[A-Z][A-Z0-9_]{0,79}$/.test(code || '') ? code : `LOCAL_HTTP_${response.status}`);
  }
  return response;
}

async function check(name, operation) {
  const started = Date.now();
  emit({ check: name, phase: 'starting', actualProvider: true });
  try {
    const details = await operation();
    const result = { check: name, ok: true, elapsedMs: Date.now() - started, ...details };
    report.checks.push(result); emit(result); return true;
  } catch (error) {
    const result = { check: name, ok: false, code: safeCode(error), elapsedMs: Date.now() - started };
    report.checks.push(result); emit(result); return false;
  }
}

async function cancelTask() {
  if (!activeTask || !connection) return;
  try { await call(`/api/knowledge/tasks/${activeTask}/cancel?knowledgeBaseId=live-vault`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) }); } catch {}
}

async function task(mode, selected) {
  const created = await (await call('/api/knowledge/tasks?knowledgeBaseId=live-vault', {
    method: 'POST',
    body: JSON.stringify({ kind: 'qa', model: 'live-qwen', effort: selected.effort, taskMode: mode,
      webSearch: false,
      prompt: mode === 'normal'
        ? '这是一次极小验收任务。只用 Read 读取 Evidence.md 后回答：验收标记是什么，计划完成了吗？答案限制80字，必须包含文件中的验收标记，并按〔来源：Evidence.md#Evidence〕格式引用。不要联网，不创建子任务。'
        : '这是一次极小深度模式验收。先用 KnowledgeSearch 搜索 acceptance-evidence，再用 Read 读取 Evidence.md 核对计划状态。答案限制80字，必须含文件中的验收标记及〔来源：Evidence.md#Evidence〕。仅这两个工具步骤，不联网、不创建子任务，不需要展开分析。',
    }),
  })).json();
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(created.taskId || '')) throw failure('TASK_IDENTIFIER_INVALID');
  activeTask = created.taskId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80_000);
  let text = '';
  let textEvents = 0;
  let toolStarts = 0;
  let terminal;
  const tools = new Set();
  let reader;
  try {
    const stream = await call(`/api/knowledge/tasks/${activeTask}/events?knowledgeBaseId=live-vault`, { signal: controller.signal });
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalBytes = 0;
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > 512 * 1024) throw failure('SSE_BUDGET_EXCEEDED');
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let delimiter;
      while ((delimiter = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, delimiter); buffer = buffer.slice(delimiter + 2);
        const event = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
        const dataText = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!dataText) continue;
        let data; try { data = JSON.parse(dataText); } catch { throw failure('SSE_DATA_INVALID'); }
        if (event === 'text') { textEvents += 1; text += String(data.text || ''); }
        if (event === 'activity' && data.toolName) {
          if (/^(Read|Glob|Grep|KnowledgeSearch|mcp__knowledge__KnowledgeSearch)$/.test(data.toolName)) tools.add(data.toolName);
          if (data.stage === 'starting') toolStarts += 1;
          if (data.toolName === 'Agent') throw failure('SUBAGENT_BUDGET_EXCEEDED');
        }
        if (text.length > 4000 || toolStarts > 4) throw failure('TASK_BUDGET_EXCEEDED');
        if (event === 'done') terminal = data.status;
      }
    }
    if (terminal !== 'completed') throw failure(terminal === 'failed' ? 'SDK_TASK_FAILED' : 'SDK_TASK_INCOMPLETE');
    if (!textEvents || !text.includes('SM-WIN-LIVE-3917') || !text.includes('Evidence.md') || !tools.has('Read')) throw failure('EVIDENCE_OR_CITATION_MISSING');
    if (mode === 'deep' && !tools.has('mcp__knowledge__KnowledgeSearch')) throw failure('DEEP_SEARCH_TOOL_MISSING');
    return { mode, sdkVersion: '0.3.247', streamed: true, citedEvidence: true, readTool: true, toolStarts, answerCharacters: text.length };
  } catch (error) {
    await cancelTask();
    if (controller.signal.aborted) throw failure('TASK_ACCEPTANCE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
    activeTask = null;
  }
}

async function assertNoPlaintextCredentials(directory, secrets) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertNoPlaintextCredentials(target, secrets);
    else if (entry.isFile()) {
      const stat = await fs.stat(target);
      if (stat.size > 32 * 1024 * 1024) throw failure('ARTIFACT_SCAN_LIMIT');
      const bytes = await fs.readFile(target);
      if (secrets.some((secret) => bytes.includes(Buffer.from(secret)))) throw failure('PLAINTEXT_CREDENTIAL_FOUND');
    }
  }
}

async function main() {
  if (process.platform !== 'win32') throw failure('WINDOWS_REQUIRED');
  const options = args();
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  process.env.PATH = [path.join(options.resources, 'runtime/node'), path.join(systemRoot, 'System32'), systemRoot, path.join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(path.delimiter);
  const selected = selectConfig(await input(), options);
  requiredCheckCount = options.llmOnly ? 5 : 7;
  report.scope = options.llmOnly ? 'llm-only' : 'full';
  if (options.llmOnly) report.omittedChecks = ['live_embedding', 'live_bailian_search'];
  const backendRoot = path.join(options.resources, 'backend');
  const moduleAt = (relative) => import(pathToFileURL(path.join(backendRoot, relative)).href);
  const { legacyV2ProviderFields } = await moduleAt('src/model-provider-registry.mjs');
  const policy = legacyV2ProviderFields({ providerId: 'bailian', protocol: selected.connection.protocol,
    apiBase: selected.connection.apiBase, authMode: selected.connection.authMode, actualModel: selected.model.actualModel });
  // The persisted provider policy owns defaultEffort; per-task effort remains
  // separately bounded. Overriding the stored default with 'low' is rejected.
  selected.model.requestProfile = policy.requestProfile;
  selected.model.efforts = policy.efforts;
  selected.model.defaultEffort = policy.defaultEffort;
  await fs.mkdir(options['work-dir'], { recursive: true });
  fixture = await fs.mkdtemp(path.join(options['work-dir'], 'live-acceptance-'));
  const vault = path.join(fixture, 'Synthetic Vault');
  await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await fs.writeFile(path.join(vault, 'Evidence.md'), '# Evidence\n\nacceptance-evidence：验收标记是 SM-WIN-LIVE-3917，计划尚未完成。\n');
  const { BackendController } = await moduleAt('desktop/backend-controller.mjs');
  backend = new BackendController({ appRoot: backendRoot, resourcesPath: options.resources,
    stateRoot: path.join(fixture, 'state'), packaged: true, codec: codec() });
  const initialized = await check('installed_backend', async () => {
    connection = await backend.start([{ id: 'live-vault', name: 'Synthetic acceptance', path: vault }]);
    const status = await (await call('/api/knowledge/status?knowledgeBaseId=live-vault')).json();
    if (status.sdkVersion !== '0.3.247') throw failure('SDK_VERSION_MISMATCH');
    return { sdkVersion: status.sdkVersion, fixtureOnly: true };
  });
  if (!initialized) return;
  const configured = await check('live_sdk_config_validation', async () => {
    const current = await (await call('/api/admin/runtime-config?knowledgeBaseId=live-vault')).json();
    await call('/api/admin/runtime-config?knowledgeBaseId=live-vault', { method: 'PUT', body: JSON.stringify({
      schemaVersion: 2, expectedRevision: current.revision,
      connections: [selected.connection], models: [selected.model], defaultModelId: selected.model.id,
      webSearch: { enabled: false, provider: 'bailian-mcp', providers: {} },
    }) });
    return { provider: 'bailian', model: selected.model.actualModel, effort: selected.effort };
  });
  if (configured) {
    const ordinary = await check('live_ordinary_qa', () => task('normal', selected));
    if (ordinary) await check('live_deep_tools', () => task('deep', selected));
    else { const result = { check: 'live_deep_tools', ok: false, skipped: true, code: 'ORDINARY_CHECK_FAILED' }; report.checks.push(result); emit(result); }
  }
  if (!options.llmOnly) await check('live_embedding', async () => {
    const { EmbeddingClient } = await moduleAt('src/embedding-client.mjs');
    const vectors = await new EmbeddingClient(selected.embedding).embed(['Synthetic Windows acceptance evidence.'], { signal: AbortSignal.timeout(35_000) });
    if (vectors.length !== 1 || vectors[0].length !== selected.embedding.dimensions || !vectors[0].every(Number.isFinite)) throw failure('EMBEDDING_SHAPE_INVALID');
    return { model: selected.embedding.model, vectors: 1, dimensions: vectors[0].length, requests: 1, indexRebuilt: false };
  });
  if (!options.llmOnly) await check('live_bailian_search', async () => {
    const { BailianWebSearchClient } = await moduleAt('src/bailian-web-search-client.mjs');
    const client = new BailianWebSearchClient({ enabled: true, apiKey: selected.webKey,
      endpoint: 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp', timeoutMs: 35_000, resultCount: 1, maxContextChars: 1000 });
    const result = await client.searchMany(['Obsidian official help Markdown'], { signal: AbortSignal.timeout(40_000) });
    if (result.errors?.length || !result.results?.length) throw failure(result.errors?.[0]?.code && /^[A-Z_]{1,80}$/.test(result.errors[0].code) ? result.errors[0].code : 'WEB_SEARCH_NO_RESULTS');
    return { provider: 'bailian-mcp', queries: 1, results: result.results.length, responseTextRecorded: false };
  });
  await backend.stop();
  await check('credential_artifacts', async () => { await assertNoPlaintextCredentials(fixture, selected.secrets); return { plaintextKeysFound: false }; });
}

const hardDeadline = setTimeout(() => {
  emit({ check: 'deadline', ok: false, code: 'ACCEPTANCE_DEADLINE' });
  process.exit(1); // Windows Job Object closes the child process tree on owner exit.
}, 6 * 60_000);
hardDeadline.unref();

try { await main(); completion = true; }
catch (error) { report.checks.push({ check: 'runner', ok: false, code: safeCode(error) }); }
finally {
  await cancelTask();
  await backend?.stop().catch(() => {});
  if (fixture) await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => { report.checks.push({ check: 'cleanup', ok: false, code: 'FIXTURE_CLEANUP_FAILED' }); });
  clearTimeout(hardDeadline);
  report.ok = completion && report.checks.length >= requiredCheckCount && report.checks.every((entry) => entry.ok);
  emit({ summary: report });
  process.exitCode = report.ok ? 0 : 1;
}
