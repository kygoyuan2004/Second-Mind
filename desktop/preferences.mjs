import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRemoteUrl } from './security.mjs';
import { assertNoReparseTraversal, isInsidePath, samePath, replaceFileAtomically } from '../platform/private-storage.mjs';

const emptyPreferences = () => ({ version: 1, mode: null, connectionId: null, connections: [], vaults: [] });
const validId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id);

export function sanitizePreferences(input) {
  const result = emptyPreferences();
  if (!input || typeof input !== 'object') return result;
  const connectionIds = new Set();
  for (const item of Array.isArray(input.connections) ? input.connections : []) {
    if (!validId(item?.id) || connectionIds.has(item.id)) continue;
    try {
      const url = normalizeRemoteUrl(item.url, item.trustedHttp === true);
      result.connections.push({ id: item.id, name: String(item.name || new URL(url).host).slice(0, 100), url, trustedHttp: new URL(url).protocol === 'http:' });
      connectionIds.add(item.id);
    } catch { /* Invalid stored connections are never loaded. */ }
  }
  const vaultIds = new Set();
  for (const item of Array.isArray(input.vaults) ? input.vaults : []) {
    if (!validId(item?.id) || vaultIds.has(item.id) || typeof item.path !== 'string' || !path.isAbsolute(item.path)) continue;
    result.vaults.push({ id: item.id, name: String(item.name || path.basename(item.path)).slice(0, 100), path: path.normalize(item.path) });
    vaultIds.add(item.id);
  }
  if (input.mode === 'local' && result.vaults.length) result.mode = 'local';
  if (input.mode === 'remote' && connectionIds.has(input.connectionId)) {
    result.mode = 'remote';
    result.connectionId = input.connectionId;
  }
  return result;
}

export class Preferences {
  constructor(stateRoot) {
    this.file = path.join(stateRoot, 'desktop-preferences.json');
    this.value = emptyPreferences();
    this.queue = Promise.resolve();
  }

  async load() {
    try { this.value = sanitizePreferences(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('桌面设置文件无法读取。请保留该文件并检查文件权限或内容。', { cause: error });
    }
    return structuredClone(this.value);
  }

  async save(value) {
    const next = sanitizePreferences(value);
    const operation = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await replaceFileAtomically(temporary, this.file);
        this.value = next;
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return structuredClone(next);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

export async function authorizeVault(selectedPath, existing = [], { stateRoot } = {}) {
  const absolute = path.resolve(selectedPath);
  try { await assertNoReparseTraversal(absolute); }
  catch (error) { throw new Error('知识库路径不能包含目录链接、重解析点或不安全的路径。', { cause: error }); }
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('请选择实际的知识库文件夹，不要选择目录链接。');
  const canonical = await fs.realpath(absolute);
  if (canonical === path.parse(canonical).root) throw new Error('请选择具体的知识库文件夹，不能授权整块磁盘。');
  try {
    const marker = path.join(canonical, '.obsidian');
    await assertNoReparseTraversal(marker);
    if (!(await fs.lstat(marker)).isDirectory()) throw new Error('Invalid Vault marker');
  } catch (error) { throw new Error('请选择在 Obsidian 中打开过的 Vault 根目录，其中应有实际的 .obsidian 文件夹。', { cause: error }); }
  if (stateRoot && (isInsidePath(stateRoot, canonical) || isInsidePath(canonical, stateRoot))) throw new Error('知识库不能与软件私有数据目录重叠，请选择独立的文件夹。');
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const found = existing.find((item) => (process.platform === 'win32' ? item.path.toLowerCase() : item.path) === normalized);
  if (found) return found;
  if (existing.some((item) => !samePath(item.path, canonical) && (isInsidePath(item.path, canonical) || isInsidePath(canonical, item.path)))) throw new Error('知识库文件夹之间不能互相包含，请选择独立的文件夹。');
  return { id: `vault-${randomUUID().replaceAll('-', '').slice(0, 24)}`, name: path.basename(canonical), path: canonical };
}
