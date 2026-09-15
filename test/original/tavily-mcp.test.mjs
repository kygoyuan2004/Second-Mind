import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_TAVILY_PARAMETERS,
  TAVILY_EXTRACT_TOOL,
  TAVILY_MCP_TIMEOUT_MS,
  TAVILY_SEARCH_TOOL,
  createTavilyMcpConfig,
} from '../../src/original/tavily-mcp.mjs';

test('Tavily MCP 使用固定本地版本、独立凭据和 60 秒硬超时', {
  skip: process.platform === 'win32' && 'POSIX credential-file permissions run on Linux/macOS; Windows deploys the Linux container.',
}, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuan-tavily-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const node = path.join(root, 'node');
  const server = path.join(root, 'tavily-mcp.mjs');
  const keyFile = path.join(root, 'tavily.key');
  await Promise.all([
    fsp.writeFile(node, ''),
    fsp.writeFile(server, ''),
    fsp.writeFile(keyFile, 'tvly-test-key\n', { mode: 0o600 }),
  ]);

  const config = createTavilyMcpConfig({ node, server, keyFile });
  assert.equal(config.type, 'stdio');
  assert.equal(config.command, node);
  assert.deepEqual(config.args, [server]);
  assert.equal(config.timeout, 60_000);
  assert.equal(config.alwaysLoad, true);
  assert.equal(config.env.TAVILY_API_KEY, 'tvly-test-key');
  assert.deepEqual(JSON.parse(config.env.DEFAULT_PARAMETERS), DEFAULT_TAVILY_PARAMETERS);
  assert.equal(config.args.join(' ').includes('tvly-test-key'), false);
  assert.equal(TAVILY_MCP_TIMEOUT_MS, 60_000);
  assert.equal(TAVILY_SEARCH_TOOL, 'mcp__tavily__tavily_search');
  assert.equal(TAVILY_EXTRACT_TOOL, 'mcp__tavily__tavily_extract');
});

test('Tavily 凭据文件权限过宽时拒绝启动', {
  skip: process.platform === 'win32' && 'POSIX credential-file permissions run on Linux/macOS; Windows deploys the Linux container.',
}, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuan-tavily-permission-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const node = path.join(root, 'node');
  const server = path.join(root, 'tavily-mcp.mjs');
  const keyFile = path.join(root, 'tavily.key');
  await Promise.all([
    fsp.writeFile(node, ''),
    fsp.writeFile(server, ''),
    fsp.writeFile(keyFile, 'tvly-test-key\n'),
  ]);
  await fsp.chmod(keyFile, 0o644);
  assert.throws(
    () => createTavilyMcpConfig({ node, server, keyFile }),
    (error) => error.code === 'TAVILY_KEY_FILE_UNSAFE',
  );
});
