import { createHash, randomUUID } from 'node:crypto';
import { validateRemoteUrl } from './security.mjs';

export function connectionPartition(id) {
  return `persist:remote-${createHash('sha256').update(String(id)).digest('hex').slice(0, 32)}`;
}

export async function makeConnection(input, existing = [], resolver) {
  const url = await validateRemoteUrl(input?.url, input?.trustedHttp === true, resolver);
  const previous = existing.find((item) => item.url === url);
  const name = String(input?.name || new URL(url).host).trim().slice(0, 100);
  if (!name) throw new Error('请输入连接名称。');
  return { id: previous?.id || randomUUID(), name, url, trustedHttp: new URL(url).protocol === 'http:' };
}
