import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const INDEXED_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.canvas', '.base', '.csv', '.yaml', '.yml', '.log',
]);

export const PREVIEW_MIME_TYPES = new Map([
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.canvas', 'application/json; charset=utf-8'],
  ['.base', 'application/json; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.yaml', 'text/plain; charset=utf-8'],
  ['.yml', 'text/plain; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'],
]);

export function pathError(status, message, code = 'INVALID_VAULT_PATH') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function normalizeRelative(value, options = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) {
    throw pathError(400, 'Vault path is invalid.');
  }
  const normalized = value.normalize('NFC').replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    if (options.allowEmpty) return '';
    throw pathError(400, 'Vault path is required.');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw pathError(400, 'Vault path is invalid.');
  }
  return parts.join('/');
}

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeExclusion(value) {
  return String(value || '').normalize('NFC').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
}

export class VaultPathPolicy {
  constructor(root, exclusions = []) {
    this.root = path.resolve(root);
    this.exclusions = exclusions.map(normalizeExclusion).filter(Boolean);
    this.realRoot = null;
  }

  async initialize() {
    const stat = await fsp.stat(this.root).catch(() => null);
    if (!stat?.isDirectory()) {
      throw pathError(503, `Vault directory is unavailable: ${this.root}`, 'VAULT_UNAVAILABLE');
    }
    this.realRoot = await fsp.realpath(this.root);
    return this;
  }

  isExcluded(relativeInput) {
    const relative = normalizeRelative(relativeInput, { allowEmpty: true });
    if (!relative) return false;
    const parts = relative.split('/');
    if (parts.some((part) => part.startsWith('.'))) return true;
    return this.exclusions.some((excluded) => (
      relative === excluded || relative.startsWith(`${excluded}/`)
    ));
  }

  assertAllowed(relativeInput) {
    const relative = normalizeRelative(relativeInput);
    if (this.isExcluded(relative)) {
      throw pathError(403, 'This Vault path is excluded from indexing and access.', 'VAULT_PATH_EXCLUDED');
    }
    const target = path.resolve(this.root, relative);
    if (!isInside(this.root, target)) throw pathError(400, 'Vault path escapes the configured root.');
    return { relative, target };
  }

  async assertNoSymlinks(relativeInput, options = {}) {
    const relative = normalizeRelative(relativeInput, { allowEmpty: true });
    let cursor = this.root;
    for (const part of relative ? relative.split('/') : []) {
      cursor = path.join(cursor, part);
      const stat = await fsp.lstat(cursor).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) {
        if (options.allowMissing) return;
        throw pathError(404, 'Vault path does not exist.', 'VAULT_FILE_NOT_FOUND');
      }
      if (stat.isSymbolicLink()) {
        throw pathError(403, 'Symbolic links are not allowed inside accessible Vault paths.', 'VAULT_SYMLINK_DENIED');
      }
    }
  }

  async existingFile(relativeInput, options = {}) {
    const { relative, target } = this.assertAllowed(relativeInput);
    await this.assertNoSymlinks(relative);
    const stat = await fsp.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') throw pathError(404, 'Vault file was not found.', 'VAULT_FILE_NOT_FOUND');
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw pathError(400, 'Vault path is not a regular file.', 'INVALID_VAULT_FILE');
    }
    if (options.maxBytes && stat.size > options.maxBytes) {
      throw pathError(413, 'Vault file is too large to read.', 'VAULT_FILE_TOO_LARGE');
    }
    const realTarget = await fsp.realpath(target);
    if (!isInside(this.realRoot, realTarget)) {
      throw pathError(403, 'Resolved Vault file escapes the configured root.', 'VAULT_SYMLINK_DENIED');
    }
    return { relative, target: realTarget, stat };
  }

  async *walk(relativeInput = '') {
    const relative = normalizeRelative(relativeInput, { allowEmpty: true });
    if (relative && this.isExcluded(relative)) return;
    const directory = relative ? path.join(this.root, relative) : this.root;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (this.isExcluded(child) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) yield* this.walk(child);
      else if (entry.isFile()) yield child;
    }
  }
}

export function mimeTypeFor(relative) {
  return PREVIEW_MIME_TYPES.get(path.extname(relative).toLowerCase()) || 'application/octet-stream';
}

export function isIndexable(relative) {
  return INDEXED_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

export const pathPolicyInternals = { normalizeExclusion, fsConstants: fs.constants };
