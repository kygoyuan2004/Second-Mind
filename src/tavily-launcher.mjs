import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// SDK serializes stdio MCP configuration into argv. Pass only a private file
// reference there; load the credential inside this worker, never in argv.
try {
  const file = process.env.SECOND_MIND_TAVILY_CREDENTIAL_FILE;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error();
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!key || /\s/.test(key)) throw new Error();
  process.env.TAVILY_API_KEY = key;
  delete process.env.SECOND_MIND_TAVILY_CREDENTIAL_FILE;
  const require = createRequire(import.meta.url);
  await import(pathToFileURL(require.resolve('tavily-mcp/build/index.js')).href);
} catch {
  process.stderr.write('TAVILY_WORKER_START_FAILED\n');
  process.exitCode = 1;
}
