import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('LEGACY_STATE_UNSAFE_FILE');
    return await fs.readFile(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('LEGACY_STATE_UNSAFE_DIRECTORY');
  await fs.chmod(directory, 0o700);
}

async function exclusiveFile(file, value) {
  const prior = await readFile(file);
  if (prior) {
    if (!prior.equals(Buffer.from(value))) throw new Error('LEGACY_IMPORT_CONFLICT');
    return;
  }
  await fs.writeFile(file, value, { flag: 'wx', mode: 0o600 });
}

async function atomicJson(file, value) {
  await privateDirectory(path.dirname(file));
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // Existing state is always authoritative; migration must never replace it.
    if (await readFile(file)) throw new Error('LEGACY_IMPORT_CONFLICT');
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

function textContent(message) {
  const value = message.text ?? message.content ?? '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((block) => block.text || '').filter(Boolean).join('\n');
  throw new Error('LEGACY_MESSAGE_FORMAT_UNSUPPORTED');
}

/** Additive import with atomic destination files/directories. A retry after a
 * crash reuses verified backups and completed copies. Old state is untouched. */
export async function migrateSdkState(legacy, current) {
  if (path.resolve(legacy.conversationFile) === path.resolve(current.conversationFile) ||
      path.resolve(legacy.draftDir) === path.resolve(current.draftDir)) throw new Error('LEGACY_IMPORT_PATH_CONFLICT');
  await privateDirectory(current.dataDir);
  const receiptFile = path.join(current.dataDir, 'migration-receipt.json');
  const prior = await readFile(receiptFile);
  if (prior) return JSON.parse(prior);
  const raw = await readFile(legacy.conversationFile);
  const privateBackup = path.join(current.dataDir, 'legacy-import');
  await privateDirectory(privateBackup);
  let conversationCount = 0;
  if (raw) {
    const original = JSON.parse(raw);
    if (!Array.isArray(original.conversations)) throw new Error('LEGACY_CONVERSATIONS_INVALID');
    const conversations = original.conversations.map((item) => {
      if (!item.id || !item.userId || !Array.isArray(item.messages)) throw new Error('LEGACY_CONVERSATION_INVALID');
      return {
        id: item.id, userId: item.userId, kind: item.kind, title: item.title,
        modelId: item.modelId || item.model, effortId: item.effortId || item.effort,
        webSearch: Boolean(item.webSearch), taskModeId: item.taskModeId || item.taskMode || 'normal',
        legacyBinding: { model: item.modelId || item.model, actualModel: item.actualModel || null,
          provider: item.modelProvider || null, revision: item.modelBindingRevision || null },
        sdkSessionId: null, legacyContextPending: item.kind === 'qa',
        createdAt: item.createdAt, updatedAt: item.updatedAt,
        learningReview: item.learningReview || item.researchContext?.learningReview || null,
        messages: item.messages.map((message) => ({
          ...message, text: textContent(message), createdAt: message.createdAt || message.at || item.createdAt,
        })),
      };
    });
    await exclusiveFile(path.join(privateBackup, `conversations-${hash(raw)}.json`), raw);
    const existing = await readFile(current.conversationFile);
    if (!existing) await atomicJson(current.conversationFile, { version: 1, conversations });
    else {
      const ids = new Set(JSON.parse(existing).conversations.map((item) => item.id));
      if (conversations.some((item) => !ids.has(item.id))) throw new Error('LEGACY_IMPORT_CONFLICT');
    }
    conversationCount = conversations.length;
  }
  const drafts = await fs.readdir(legacy.draftDir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  let draftCount = 0;
  await privateDirectory(current.draftDir);
  for (const entry of drafts) {
    if (!uuid.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('LEGACY_DRAFT_UNSAFE_FILE');
    const source = path.join(legacy.draftDir, entry.name);
    const metadata = await readFile(path.join(source, 'draft.json'));
    if (!metadata) continue;
    const draft = JSON.parse(metadata);
    if (draft.id !== entry.name || !draft.userId || !Array.isArray(draft.attachments)) throw new Error('LEGACY_DRAFT_INVALID');
    for (const attachment of draft.attachments) {
      if (typeof attachment.tempName !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(attachment.tempName) ||
          ['.', '..'].includes(attachment.tempName)) throw new Error('LEGACY_DRAFT_UNSAFE_FILE');
    }
    const files = await fs.readdir(source, { withFileTypes: true });
    if (files.some((file) => !file.isFile())) throw new Error('LEGACY_DRAFT_UNSAFE_FILE');
    const backup = path.join(privateBackup, 'drafts', entry.name);
    await privateDirectory(backup);
    for (const file of files) await exclusiveFile(path.join(backup, file.name), await readFile(path.join(source, file.name)));
    const target = path.join(current.draftDir, entry.name);
    const existing = await readFile(path.join(target, 'draft.json'));
    if (existing) {
      if (JSON.parse(existing).id !== draft.id) throw new Error('LEGACY_IMPORT_CONFLICT');
      draftCount++;
      continue;
    }
    const staging = path.join(current.draftDir, `.import-${crypto.randomUUID()}`);
    await privateDirectory(staging);
    try {
      for (const file of files) if (file.name !== 'draft.json') {
        await exclusiveFile(path.join(staging, file.name), await readFile(path.join(backup, file.name)));
      }
      await atomicJson(path.join(staging, 'draft.json'), { ...draft, legacyDraft: true });
      await fs.rename(staging, target);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    draftCount++;
  }
  const receipt = { version: 1, importedAt: new Date().toISOString(),
    conversations: conversationCount, drafts: draftCount, sourceHash: raw ? hash(raw) : null,
    oldStatePreserved: true };
  await atomicJson(receiptFile, receipt);
  return receipt;
}
