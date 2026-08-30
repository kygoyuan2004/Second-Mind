import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VaultPathPolicy, isInside, mimeTypeFor, normalizeRelative, pathError } from './path-policy.mjs';

const DRAFT_KINDS = new Set(['diary', 'plan', 'scratch']);
const MAX_DRAFT_BYTES = 512 * 1024;
const DRAFT_RETENTION_MS = 24 * 60 * 60_000;
const ATTACHMENT_START = '<!-- vaultmind-attachments:start -->';
const ATTACHMENT_END = '<!-- vaultmind-attachments:end -->';

const DEFAULT_TEMPLATES = Object.freeze({
  diary: [
    '# YYYY-MM-DD',
    '',
    '## Today',
    '',
    '## Reflection',
    '',
    '## Tomorrow',
    '',
  ].join('\n'),
  plan: [
    '# YYYY-MM-DD Plan',
    '',
    '## Priorities',
    '',
    '- [ ] ',
    '',
    '## Schedule',
    '',
    '## Notes',
    '',
  ].join('\n'),
});

function vaultError(status, message, code = 'VAULT_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) throw vaultError(400, 'Date must use YYYY-MM-DD.', 'INVALID_DATE');
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) throw vaultError(400, 'Date does not exist.', 'INVALID_DATE');
  return String(value);
}

function safeTitle(value, fallback = 'Untitled note') {
  const title = String(value || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#^\[\]]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  return title || fallback;
}

function firstHeading(markdown) {
  return String(markdown || '').match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || '';
}

function stripFence(value) {
  const text = String(value || '').trim();
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  return `${(match ? match[1] : text).trim()}\n`;
}

function setTitle(markdown, title) {
  const heading = `# ${title}`;
  if (/^#\s+.+$/m.test(markdown)) return markdown.replace(/^#\s+.+$/m, heading);
  return `${heading}\n\n${markdown.trim()}\n`;
}

function safeAttachmentName(value, index) {
  const raw = path.basename(String(value || ''));
  const extension = path.extname(raw).replace(/[^.a-z0-9_-]/gi, '').slice(0, 20).toLowerCase();
  return `${safeTitle(path.basename(raw, path.extname(raw)), `attachment-${index + 1}`).slice(0, 100)}${extension}`;
}

function uniqueNames(names, reserved = []) {
  const used = new Set(reserved.map((item) => item.toLowerCase()));
  return names.map((name) => {
    const extension = path.extname(name);
    const stem = path.basename(name, extension);
    let candidate = name;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${stem}-${suffix++}${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function attachmentBlock(assetPath, attachments) {
  if (!attachments.length) return '';
  const lines = attachments.map((attachment) => {
    const target = `${assetPath}/${attachment.finalName}`;
    return ['image', 'pdf'].includes(attachment.kind) ? `- ![[${target}]]` : `- [[${target}]]`;
  });
  return [ATTACHMENT_START, '## Attachments', '', ...lines, ATTACHMENT_END].join('\n');
}

function withAttachmentBlock(content, assetPath, attachments) {
  const pattern = new RegExp(`${ATTACHMENT_START}[\\s\\S]*?${ATTACHMENT_END}`, 'g');
  const clean = String(content).replace(pattern, '').trim();
  const block = attachmentBlock(assetPath, attachments);
  return `${clean}${block ? `\n\n${block}` : ''}\n`;
}

async function atomicJson(filename, value, mode = 0o600) {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
  try {
    await fsp.rename(temporary, filename);
    await fsp.chmod(filename, mode).catch(() => {});
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class VaultStore {
  constructor(config, options = {}) {
    this.config = config;
    this.root = path.resolve(options.root || config.vaultPath);
    this.draftRoot = path.resolve(options.draftRoot || config.draftDir);
    this.recoveryRoot = path.resolve(options.recoveryRoot || config.recoveryDir || path.join(config.dataDir, 'recovery'));
    this.auditFile = path.resolve(options.auditFile || config.auditFile);
    this.paths = { ...config.paths, ...(options.paths || {}) };
    this.templates = { ...config.templates, ...(options.templates || {}) };
    this.policy = options.policy || new VaultPathPolicy(this.root, config.excludedPaths);
    this.index = options.index || null;
    this.ready = this.initialize();
  }

  attachIndex(index) {
    this.index = index || null;
    return this;
  }

  async initialize() {
    await this.policy.initialize();
    await fsp.mkdir(this.draftRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.recoveryRoot, { recursive: true, mode: 0o700 });
    const realDraft = await fsp.realpath(this.draftRoot);
    const realRecovery = await fsp.realpath(this.recoveryRoot);
    if (isInside(this.policy.realRoot, realDraft) || isInside(this.policy.realRoot, realRecovery)) {
      throw vaultError(500, 'Draft and recovery storage must be outside the Obsidian Vault.', 'UNSAFE_STATE_ROOT');
    }
    for (const relative of Object.values(this.paths)) {
      this.policy.assertAllowed(relative);
      await this.policy.assertNoSymlinks(path.dirname(relative), { allowMissing: true });
      if (this.config.autoCreateVaultPaths) {
        await fsp.mkdir(path.join(this.root, relative), { recursive: true, mode: 0o750 });
      }
      await this.policy.assertNoSymlinks(relative);
      const stat = await fsp.lstat(path.join(this.root, relative)).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw vaultError(503, `Required writable Vault directory is unavailable: ${relative}`, 'VAULT_WRITE_PATH_UNAVAILABLE');
      }
    }
    for (const template of Object.values(this.templates).filter(Boolean)) {
      this.policy.assertAllowed(template);
      await this.policy.existingFile(template, { maxBytes: 128 * 1024 });
    }
    await this.cleanupDrafts();
    return this;
  }

  async template(kind, date) {
    const configured = this.templates[kind];
    const raw = configured
      ? await fsp.readFile((await this.policy.existingFile(configured, { maxBytes: 128 * 1024 })).target, 'utf8')
      : DEFAULT_TEMPLATES[kind];
    return String(raw).replaceAll('YYYY-MM-DD', date);
  }

  async existingFile(relative) {
    const file = await this.policy.existingFile(relative, { maxBytes: 20 * 1024 * 1024 });
    return { ...file, mime: mimeTypeFor(file.relative) };
  }

  async readText(relative, maxBytes = 2 * 1024 * 1024) {
    const file = await this.policy.existingFile(relative, { maxBytes });
    const buffer = await fsp.readFile(file.target);
    if (buffer.includes(0)) throw vaultError(415, 'Vault file is not text.', 'UNSUPPORTED_VAULT_FILE');
    return buffer.toString('utf8');
  }

  async prepareDated(kind, dateInput) {
    if (!['diary', 'plan'].includes(kind)) {
      throw vaultError(400, 'Dated drafts must be diary or plan.', 'INVALID_DRAFT_KIND');
    }
    const date = parseDate(dateInput);
    const relative = `${this.paths[kind]}/${date}.md`;
    const target = path.join(this.root, relative);
    await this.policy.assertNoSymlinks(path.dirname(relative));
    const stat = await fsp.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
      throw vaultError(409, 'Draft target is not a regular file.', 'DRAFT_CONFLICT');
    }
    const current = stat
      ? await fsp.readFile((await this.policy.existingFile(relative, { maxBytes: MAX_DRAFT_BYTES })).target, 'utf8')
      : '';
    return {
      date,
      relative,
      current,
      sourceHash: stat ? sha256(Buffer.from(current)) : null,
      template: await this.template(kind, date),
    };
  }

  async chooseScratchTarget(titleInput) {
    const base = safeTitle(titleInput, `Note ${new Date().toISOString().slice(0, 10)}`);
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const title = suffix === 1 ? base : `${base}-${suffix}`;
      const relative = `${this.paths.scratch}/${title}.md`;
      const exists = await fsp.lstat(path.join(this.root, relative)).then(() => true, () => false);
      if (!exists) return { title, relative };
    }
    throw vaultError(409, 'Could not choose a unique note name.', 'DRAFT_NAME_CONFLICT');
  }

  validateAttachments(attachments) {
    const limits = this.config.limits;
    if (!Array.isArray(attachments)) return [];
    if (attachments.length > limits.attachmentCount) {
      throw vaultError(413, `At most ${limits.attachmentCount} attachments are allowed.`, 'TOO_MANY_ATTACHMENTS');
    }
    let total = 0;
    return attachments.map((attachment, index) => {
      if (!Buffer.isBuffer(attachment.buffer)) {
        throw vaultError(400, 'Attachment content is invalid.', 'INVALID_ATTACHMENT');
      }
      total += attachment.buffer.length;
      if (attachment.buffer.length > limits.attachmentBytes || total > limits.attachmentTotalBytes) {
        throw vaultError(413, 'Attachment size limit exceeded.', 'ATTACHMENT_TOO_LARGE');
      }
      return {
        name: safeAttachmentName(attachment.name, index),
        originalName: String(attachment.name || `attachment-${index + 1}`).slice(0, 160),
        type: String(attachment.type || 'application/octet-stream').slice(0, 120),
        kind: ['image', 'pdf', 'text'].includes(attachment.kind) ? attachment.kind : 'file',
        buffer: attachment.buffer,
      };
    });
  }

  async createDraft({ userId, kind, content, date, prepared, attachments = [] }) {
    await this.ready;
    if (!DRAFT_KINDS.has(kind)) throw vaultError(400, 'Draft mode is invalid.', 'INVALID_DRAFT_KIND');
    let markdown = stripFence(content);
    if (!markdown.trim()) throw vaultError(502, 'The model returned an empty draft.', 'EMPTY_DRAFT');
    if (Buffer.byteLength(markdown) > MAX_DRAFT_BYTES) {
      throw vaultError(413, 'Draft exceeds 512 KiB.', 'DRAFT_TOO_LARGE');
    }
    const normalizedAttachments = this.validateAttachments(attachments);
    const id = crypto.randomUUID();
    let title = '';
    let targetRelative;
    let sourceHash = null;
    let canonicalDate = null;
    if (kind === 'scratch') {
      const target = await this.chooseScratchTarget(firstHeading(markdown));
      ({ title, relative: targetRelative } = target);
      markdown = setTitle(markdown, title);
    } else {
      canonicalDate = parseDate(date);
      if (!prepared || prepared.date !== canonicalDate) {
        throw vaultError(409, 'Draft context has expired.', 'DRAFT_CONTEXT_INVALID');
      }
      targetRelative = prepared.relative;
      sourceHash = prepared.sourceHash;
    }
    const assetRelative = `${path.dirname(targetRelative)}/assets/${path.basename(targetRelative, '.md')}`;
    const assetDirectory = path.join(this.root, assetRelative);
    this.policy.assertAllowed(assetRelative);
    await this.policy.assertNoSymlinks(path.dirname(assetRelative), { allowMissing: true });
    const assetStat = await fsp.lstat(assetDirectory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (assetStat && (!assetStat.isDirectory() || assetStat.isSymbolicLink())) {
      throw vaultError(409, 'Attachment directory changed type.', 'DRAFT_CONFLICT');
    }
    if (assetStat) await this.policy.assertNoSymlinks(assetRelative);
    const existingNames = assetStat ? await fsp.readdir(assetDirectory) : [];
    const finalNames = uniqueNames(normalizedAttachments.map((item) => item.name), existingNames);
    const persisted = normalizedAttachments.map((attachment, index) => ({
      originalName: attachment.originalName,
      finalName: finalNames[index],
      type: attachment.type,
      kind: attachment.kind,
      bytes: attachment.buffer.length,
      tempName: `${String(index + 1).padStart(2, '0')}-${crypto.randomUUID()}.bin`,
    }));
    if (persisted.length) {
      const relativeAssetsFromNote = path.relative(path.dirname(targetRelative), assetRelative).split(path.sep).join('/');
      markdown = withAttachmentBlock(markdown, relativeAssetsFromNote, persisted);
    }
    const now = new Date();
    const metadata = {
      version: 1,
      id,
      userId,
      kind,
      title,
      date: canonicalDate,
      targetRelative,
      assetRelative,
      sourceHash,
      content: markdown,
      attachments: persisted,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + DRAFT_RETENTION_MS).toISOString(),
    };
    const directory = path.join(this.draftRoot, id);
    await fsp.mkdir(directory, { recursive: false, mode: 0o700 });
    try {
      await Promise.all(normalizedAttachments.map((attachment, index) => (
        fsp.writeFile(path.join(directory, persisted[index].tempName), attachment.buffer, { mode: 0o600, flag: 'wx' })
      )));
      await atomicJson(path.join(directory, 'draft.json'), metadata);
    } catch (error) {
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const warnings = await this.auditBestEffort({ action: 'draft_created', userId, draftId: id, kind, targetRelative });
    return { ...this.publicDraft(metadata), warnings };
  }

  draftDirectory(id) {
    if (!/^[a-f0-9-]{36}$/i.test(String(id || ''))) {
      throw vaultError(404, 'Draft was not found.', 'DRAFT_NOT_FOUND');
    }
    return path.join(this.draftRoot, id);
  }

  async readDraft(userId, id) {
    const directory = this.draftDirectory(id);
    const draft = await fsp.readFile(path.join(directory, 'draft.json'), 'utf8')
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === 'ENOENT') throw vaultError(404, 'Draft was not found.', 'DRAFT_NOT_FOUND');
        throw error;
      });
    if (draft.userId !== userId) throw vaultError(404, 'Draft was not found.', 'DRAFT_NOT_FOUND');
    if (new Date(draft.expiresAt).getTime() <= Date.now()) {
      await fsp.rm(directory, { recursive: true, force: true });
      throw vaultError(410, 'Draft expired.', 'DRAFT_EXPIRED');
    }
    return { directory, draft };
  }

  publicDraft(draft) {
    return {
      id: draft.id,
      kind: draft.kind,
      title: draft.title,
      date: draft.date,
      targetPath: draft.targetRelative,
      content: draft.content,
      attachments: draft.attachments.map(({ originalName, finalName, type, kind, bytes }) => ({
        originalName, finalName, type, kind, bytes,
      })),
      createdAt: draft.createdAt,
      expiresAt: draft.expiresAt,
    };
  }

  async getDraft(userId, id) {
    return this.publicDraft((await this.readDraft(userId, id)).draft);
  }

  async deleteDraft(userId, id) {
    const { directory, draft } = await this.readDraft(userId, id);
    await fsp.rm(directory, { recursive: true, force: true });
    const warnings = await this.auditBestEffort({ action: 'draft_deleted', userId, draftId: id, kind: draft.kind });
    return { ok: true, warnings };
  }

  async currentHash(relative) {
    const allowed = this.policy.assertAllowed(relative);
    await this.policy.assertNoSymlinks(path.dirname(allowed.relative));
    const target = allowed.target;
    const stat = await fsp.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) throw vaultError(409, 'Draft target changed type.', 'DRAFT_CONFLICT');
    const file = await this.policy.existingFile(allowed.relative, { maxBytes: MAX_DRAFT_BYTES });
    return sha256(await fsp.readFile(file.target));
  }

  async createRecovery(draft) {
    if (draft.sourceHash === null) return null;
    const source = await this.policy.existingFile(draft.targetRelative, { maxBytes: MAX_DRAFT_BYTES });
    const id = crypto.randomUUID();
    const directory = path.join(this.recoveryRoot, id);
    const noteFile = path.join(directory, 'note.md');
    await fsp.mkdir(directory, { recursive: false, mode: 0o700 });
    try {
      await fsp.copyFile(source.target, noteFile, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(noteFile, 0o600).catch(() => {});
      const backupHash = sha256(await fsp.readFile(noteFile));
      if (backupHash !== draft.sourceHash) {
        throw vaultError(409, 'The note changed while its recovery copy was created.', 'DRAFT_CONFLICT');
      }
      await atomicJson(path.join(directory, 'metadata.json'), {
        version: 1,
        id,
        targetRelative: draft.targetRelative,
        sourceHash: draft.sourceHash,
        createdAt: new Date().toISOString(),
      });
      return { id, directory };
    } catch (error) {
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async saveDraft(userId, id, changes = {}) {
    const { directory, draft } = await this.readDraft(userId, id);
    let content = stripFence(changes.content ?? draft.content);
    if (!content.trim() || Buffer.byteLength(content) > MAX_DRAFT_BYTES) {
      throw vaultError(413, 'Draft is empty or too large.', 'INVALID_DRAFT_CONTENT');
    }
    let title = draft.title;
    let targetRelative = draft.targetRelative;
    if (draft.kind === 'scratch') {
      title = safeTitle(changes.title ?? draft.title);
      if (title !== draft.title || await this.currentHash(targetRelative) !== null) {
        const target = await this.chooseScratchTarget(title);
        ({ title, relative: targetRelative } = target);
      }
      content = setTitle(content, title);
    } else if (await this.currentHash(targetRelative) !== draft.sourceHash) {
      throw vaultError(
        409,
        'The note changed after the preview was generated. Regenerate the draft before saving.',
        'DRAFT_CONFLICT',
      );
    }
    const target = path.join(this.root, targetRelative);
    const allowedRoot = path.join(this.root, this.paths[draft.kind]);
    if (!isInside(allowedRoot, target)) throw pathError(403, 'Draft target is outside the allowed write path.');
    await this.policy.assertNoSymlinks(path.dirname(targetRelative));
    const assetRelative = `${path.dirname(targetRelative)}/assets/${path.basename(targetRelative, '.md')}`;
    if (draft.attachments.length) {
      const relativeAssetsFromNote = path.relative(path.dirname(targetRelative), assetRelative).split(path.sep).join('/');
      content = withAttachmentBlock(content, relativeAssetsFromNote, draft.attachments);
    }
    const temporary = path.join(path.dirname(target), `.vaultmind-${id}.tmp`);
    const copied = [];
    let createdAssetDirectory = false;
    let recovery = null;
    await fsp.writeFile(temporary, content, { mode: 0o640, flag: 'wx' });
    try {
      if (draft.attachments.length) {
        const assetDirectory = path.join(this.root, assetRelative);
        const before = await fsp.lstat(assetDirectory).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (before?.isSymbolicLink() || (before && !before.isDirectory())) {
          throw vaultError(409, 'Attachment directory changed type.', 'DRAFT_CONFLICT');
        }
        if (!before) {
          await fsp.mkdir(assetDirectory, { recursive: true, mode: 0o750 });
          createdAssetDirectory = true;
        }
        await this.policy.assertNoSymlinks(assetRelative);
        for (const attachment of draft.attachments) {
          const destination = path.join(assetDirectory, attachment.finalName);
          await fsp.copyFile(path.join(directory, attachment.tempName), destination, fs.constants.COPYFILE_EXCL);
          copied.push(destination);
        }
      }
      if (draft.kind !== 'scratch' && await this.currentHash(targetRelative) !== draft.sourceHash) {
        throw vaultError(409, 'The note changed while saving. Regenerate the draft.', 'DRAFT_CONFLICT');
      }
      if (draft.sourceHash !== null) {
        recovery = await this.createRecovery({ ...draft, targetRelative });
        if (await this.currentHash(targetRelative) !== draft.sourceHash) {
          throw vaultError(409, 'The note changed after its recovery copy was created.', 'DRAFT_CONFLICT');
        }
      }
      if (draft.kind === 'scratch' || draft.sourceHash === null) {
        await fsp.link(temporary, target);
        await fsp.rm(temporary, { force: true }).catch(() => {});
      } else {
        await fsp.rename(temporary, target);
      }
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      await Promise.all(copied.map((filename) => fsp.rm(filename, { force: true }).catch(() => {})));
      if (createdAssetDirectory) await fsp.rmdir(path.join(this.root, assetRelative)).catch(() => {});
      if (recovery) await fsp.rm(recovery.directory, { recursive: true, force: true }).catch(() => {});
      if (error.code === 'EEXIST') {
        throw vaultError(409, 'The draft target or an attachment changed before saving.', 'DRAFT_CONFLICT');
      }
      throw error;
    }
    const warnings = [];
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {
      warnings.push('DRAFT_CLEANUP_FAILED');
    });
    const hash = sha256(Buffer.from(content));
    warnings.push(...await this.auditBestEffort({
      action: 'draft_saved', userId, draftId: id, kind: draft.kind,
      targetRelative, beforeHash: draft.sourceHash, afterHash: hash,
      attachmentCount: draft.attachments.length, recoveryId: recovery?.id || null,
    }));
    this.index?.updatePaths?.([targetRelative]).catch(() => {});
    return { ok: true, path: targetRelative, hash, title, recoveryId: recovery?.id || null, warnings };
  }

  async cleanupDrafts() {
    const entries = await fsp.readdir(this.draftRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
      const directory = path.join(this.draftRoot, entry.name);
      let expired = false;
      try {
        const metadata = JSON.parse(await fsp.readFile(path.join(directory, 'draft.json'), 'utf8'));
        expired = new Date(metadata.expiresAt).getTime() <= Date.now();
      } catch {
        const stat = await fsp.stat(directory).catch(() => null);
        expired = Boolean(stat && Date.now() - stat.mtimeMs > DRAFT_RETENTION_MS);
      }
      if (expired) await fsp.rm(directory, { recursive: true, force: true });
    }
    await this.cleanupRecoveries();
  }

  async cleanupRecoveries() {
    const retentionMs = (Number(this.config.limits.recoveryRetentionDays) || 30) * 24 * 60 * 60_000;
    const entries = await fsp.readdir(this.recoveryRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
      const directory = path.join(this.recoveryRoot, entry.name);
      const stat = await fsp.stat(directory).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > retentionMs) {
        await fsp.rm(directory, { recursive: true, force: true });
      }
    }
  }

  async audit(event) {
    await fsp.mkdir(path.dirname(this.auditFile), { recursive: true, mode: 0o700 });
    await fsp.appendFile(this.auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
  }

  async auditBestEffort(event) {
    try {
      await this.audit(event);
      return [];
    } catch {
      console.warn('[vaultmind] AUDIT_WRITE_FAILED');
      return ['AUDIT_WRITE_FAILED'];
    }
  }
}

export const vaultStoreInternals = {
  parseDate, safeTitle, stripFence, setTitle, withAttachmentBlock, sha256, atomicJson,
};
