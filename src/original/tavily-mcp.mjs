import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TAVILY_SEARCH_TOOL = 'mcp__tavily__tavily_search';
export const TAVILY_EXTRACT_TOOL = 'mcp__tavily__tavily_extract';
export const TAVILY_MCP_TIMEOUT_MS = 60_000;
export const DEFAULT_TAVILY_KEY_FILE =
  '';
export const DEFAULT_TAVILY_NODE =
  process.execPath;
export const DEFAULT_TAVILY_SERVER =
  fileURLToPath(new URL('../../node_modules/tavily-mcp/build/index.js', import.meta.url));

export const DEFAULT_TAVILY_PARAMETERS = Object.freeze({
  search_depth: 'advanced',
  max_results: 8,
  include_raw_content: false,
  include_images: false,
  include_image_descriptions: false,
});

function tavilyError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export function resolveTavilyApiKey(options = {}) {
  const direct = String(options.apiKey || process.env.TAVILY_API_KEY || '').trim();
  if (direct) return direct;
  const keyFile = String(
    options.keyFile || process.env.TAVILY_API_KEY_FILE || DEFAULT_TAVILY_KEY_FILE,
  );
  try {
    const stat = fs.statSync(keyFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw tavilyError(
        'Tavily API Key 文件必须是权限 0600 的普通文件。',
        'TAVILY_KEY_FILE_UNSAFE',
      );
    }
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    if (!key) throw new Error('empty key');
    return key;
  } catch (error) {
    if (error?.code === 'TAVILY_KEY_FILE_UNSAFE') throw error;
    throw tavilyError(
      '没有可用于 Tavily MCP 联网搜索的 API Key。',
      'TAVILY_NOT_CONFIGURED',
      error,
    );
  }
}

function requireRegularFile(file, code, message) {
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a file');
  } catch (error) {
    throw tavilyError(message, code, error);
  }
}

export function createTavilyMcpConfig(options = {}) {
  const node = String(options.node || process.env.TAVILY_MCP_NODE || DEFAULT_TAVILY_NODE);
  const server = String(
    options.server || process.env.TAVILY_MCP_SERVER || DEFAULT_TAVILY_SERVER,
  );
  requireRegularFile(node, 'TAVILY_NODE_MISSING', 'Tavily MCP 的独立 Node.js 不可用。');
  requireRegularFile(server, 'TAVILY_SERVER_MISSING', 'Tavily MCP 固定版本未安装。');
  const apiKey = resolveTavilyApiKey(options);
  const parameters = {
    ...DEFAULT_TAVILY_PARAMETERS,
    ...(options.defaultParameters || {}),
  };
  return {
    type: 'stdio',
    command: node,
    args: [server],
    env: {
      TAVILY_API_KEY: apiKey,
      DEFAULT_PARAMETERS: JSON.stringify(parameters),
    },
    timeout: Number(options.timeoutMs || TAVILY_MCP_TIMEOUT_MS),
    alwaysLoad: true,
  };
}
