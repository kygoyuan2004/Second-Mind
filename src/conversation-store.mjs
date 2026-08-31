import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

async function atomicJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await fsp.rename(temporary, filename);
    await fsp.chmod(filename, 0o600).catch(() => {});
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function conversationError(message, code = 'CONVERSATION_NOT_FOUND') {
  const error = new Error(message);
  error.status = code === 'CONVERSATION_BUSY' ? 409 : 404;
  error.code = code;
  return error;
}

export class ConversationStore {
  constructor(filename) {
    this.filename = path.resolve(filename);
    this.conversations = new Map();
    this.writeChain = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    await fsp.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filename, 'utf8'));
      for (const conversation of parsed?.conversations || []) {
        if (conversation?.id && conversation?.userId && Array.isArray(conversation.messages)) {
          this.conversations.set(conversation.id, conversation);
        }
      }
      await fsp.chmod(this.filename, 0o600).catch(() => {});
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  save() {
    const snapshot = {
      version: 1,
      conversations: structuredClone([...this.conversations.values()]),
    };
    const write = () => atomicJson(this.filename, snapshot);
    this.writeChain = this.writeChain.then(write, write);
    return this.writeChain;
  }

  list(userId) {
    return [...this.conversations.values()]
      .filter((item) => item.userId === userId)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map((item) => this.public(item));
  }

  public(conversation) {
    return {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      model: conversation.model,
      taskMode: conversation.kind === 'qa' ? conversation.taskMode || 'normal' : 'normal',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  get(userId, id) {
    const conversation = this.conversations.get(String(id));
    if (!conversation || conversation.userId !== userId) {
      throw conversationError('Conversation was not found.');
    }
    return conversation;
  }

  create(userId, kind, metadata = {}) {
    const now = new Date().toISOString();
    const conversation = {
      version: 1,
      id: crypto.randomUUID(),
      userId,
      kind,
      title: metadata.title || 'New conversation',
      model: metadata.model || '',
      taskMode: kind === 'qa' ? metadata.taskMode || 'normal' : 'normal',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  rollback(userId, id, snapshot = null) {
    const current = this.conversations.get(String(id));
    if (!current || current.userId !== userId) return;
    if (snapshot) this.conversations.set(current.id, structuredClone(snapshot));
    else this.conversations.delete(current.id);
  }

  async delete(userId, id, options = {}) {
    if (options.isBusy?.(id)) throw conversationError('Conversation has an active task.', 'CONVERSATION_BUSY');
    const conversation = this.get(userId, id);
    const checkpoint = structuredClone(conversation);
    this.conversations.delete(conversation.id);
    try {
      await this.save();
    } catch (error) {
      this.conversations.set(checkpoint.id, checkpoint);
      throw error;
    }
    return { ok: true };
  }

  async clear(userId, kind, options = {}) {
    const allowed = new Set(['qa', 'diary', 'plan', 'scratch']);
    if (!allowed.has(kind)) {
      const error = new Error('Conversation kind is invalid.');
      error.status = 400;
      error.code = 'INVALID_CONVERSATION_KIND';
      throw error;
    }
    const matches = [...this.conversations.values()].filter((item) => item.userId === userId && item.kind === kind);
    if (matches.some((item) => options.isBusy?.(item.id))) {
      throw conversationError('A matching conversation has an active task.', 'CONVERSATION_BUSY');
    }
    const checkpoints = matches.map((item) => structuredClone(item));
    for (const item of matches) this.conversations.delete(item.id);
    try {
      await this.save();
    } catch (error) {
      for (const checkpoint of checkpoints) this.conversations.set(checkpoint.id, checkpoint);
      throw error;
    }
    return { ok: true, deletedCount: matches.length };
  }
}

export const conversationStoreInternals = { atomicJson };
