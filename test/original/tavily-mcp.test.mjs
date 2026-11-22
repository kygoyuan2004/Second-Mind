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

test('Tavily MCP 使用固定本地版本、显式独立凭据和 60 秒硬超时', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuan-tavily-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const node = path.join(root, 'node');
  const server = path.join(root, 'tavily-mcp.mjs');
  await Promise.all([
    fsp.writeFile(node, ''),
    fsp.writeFile(server, ''),
  ]);

  // Desktop passes its runtime-managed key explicitly, then replaces it with
  // the memory-broker descriptor before the SDK serializes MCP configuration.
  const config = createTavilyMcpConfig({ node, server, apiKey: 'tvly-test-key' });
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

test('兼容入口：Tavily POSIX 凭据文件导入，并拒绝过宽权限', {
  skip: process.platform === 'win32' && 'Legacy POSIX key-file import; desktop uses the memory broker tested in sdk-transport.test.mjs and Windows ACL checks in platform/windows-native.test.mjs.',
}, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuan-tavily-permission-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const node = path.join(root, 'node');
  const server = path.join(root, 'tavily-mcp.mjs');
  const keyFile = path.join(root, 'tavily.key');
  await Promise.all([
    fsp.writeFile(node, ''),
    fsp.writeFile(server, ''),
    fsp.writeFile(keyFile, 'tvly-test-key\n', { mode: 0o600 }),
  ]);
  await fsp.chmod(keyFile, 0o600);
  assert.equal(createTavilyMcpConfig({ node, server, keyFile }).env.TAVILY_API_KEY, 'tvly-test-key');
  await fsp.chmod(keyFile, 0o644);
  assert.throws(
    () => createTavilyMcpConfig({ node, server, keyFile }),
    (error) => error.code === 'TAVILY_KEY_FILE_UNSAFE',
  );
});
