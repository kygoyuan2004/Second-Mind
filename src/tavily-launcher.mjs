import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readPrivateFile } from '../platform/private-storage.mjs';

// SDK serializes stdio MCP configuration into argv. Pass only a private file
// reference there; load the credential inside this worker, never in argv.
try {
  const file = process.env.SECOND_MIND_TAVILY_CREDENTIAL_FILE;
  const raw = (await readPrivateFile(file, { maxBytes: 32 * 1024 })).toString('utf8').trim();
  let key;
  if (raw.startsWith('{')) {
    const descriptor = JSON.parse(raw), url = new URL(descriptor.url);
    if (descriptor.version !== 1 || !/^[a-f0-9]{64}$/.test(descriptor.token) ||
        url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
        url.pathname !== '/credential' || url.username || url.password || url.search || url.hash) throw new Error();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${descriptor.token}` },
      signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) throw new Error();
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16_384) throw new Error();
      chunks.push(chunk);
    }
    key = Buffer.concat(chunks).toString('utf8');
  } else {
    if (process.env.SECOND_MIND_DESKTOP === '1') throw new Error();
    key = raw;
  }
  if (!key || key.length > 16_384 || /\s/.test(key)) throw new Error();
  process.env.TAVILY_API_KEY = key;
  delete process.env.SECOND_MIND_TAVILY_CREDENTIAL_FILE;
  const require = createRequire(import.meta.url);
  await import(pathToFileURL(require.resolve('tavily-mcp/build/index.js')).href);
} catch {
  process.stderr.write('TAVILY_WORKER_START_FAILED\n');
  process.exitCode = 1;
}
