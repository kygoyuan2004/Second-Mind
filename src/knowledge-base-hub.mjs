import { markPublicMessage } from './public-errors.mjs';

export class KnowledgeBaseHubError extends Error {
  constructor(message, code = 'KNOWLEDGE_BASE_UNAVAILABLE', status = 503, cause) {
    super(message, { cause });
    this.name = 'KnowledgeBaseHubError';
    this.code = code;
    this.status = status;
    markPublicMessage(this);
  }
}

function safeCode(error, fallback = 'KNOWLEDGE_BASE_INITIALIZATION_FAILED') {
  const code = String(error?.code || fallback);
  return /^[A-Z][A-Z0-9_]{0,95}$/u.test(code) ? code : fallback;
}

function recordStatus(record) {
  const entry = record.entry;
  const status = record.context?.index?.status?.() || {};
  const available = Boolean(record.context && status.available === true);
  return Object.freeze({
    knowledgeBaseId: entry.knowledgeBaseId,
    name: entry.name,
    enabled: entry.enabled,
    default: entry.default,
    revision: entry.revision,
    status: !entry.enabled ? 'disabled' : available ? 'ready' : record.initializing ? 'starting' : 'failed',
    retrieval: {
      ready: available,
      mode: status.semanticAvailable ? 'hybrid' : status.lexicalAvailable ? 'keyword' : 'unavailable',
      documentCount: Math.max(0, Number(status.files) || 0),
    },
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  });
}

function affectedKnowledgeBaseIds(current, submitted) {
  const currentEntries = Array.isArray(current?.knowledgeBases) ? current.knowledgeBases : [];
  const submittedEntries = Array.isArray(submitted) ? submitted : [];
  const currentById = new Map(currentEntries.map((entry) => [String(entry.knowledgeBaseId || ''), entry]));
  const submittedById = new Map(submittedEntries.map((entry) => [String(entry?.knowledgeBaseId || ''), entry]));
  const affected = new Set();
  for (const entry of currentEntries) {
    const next = submittedById.get(entry.knowledgeBaseId);
    if (!next || ['name', 'mountId', 'relativePath', 'enabled'].some((field) => (
      String(next[field] ?? '') !== String(entry[field] ?? '')
    ))) affected.add(entry.knowledgeBaseId);
  }
  for (const entry of submittedEntries) {
    const id = String(entry?.knowledgeBaseId || '');
    if (id && !currentById.has(id)) affected.add(id);
  }
  return affected;
}

export class KnowledgeBaseHub {
  constructor(options = {}) {
    if (!options.registry || typeof options.createContext !== 'function') {
      throw new KnowledgeBaseHubError(
        'Knowledge-base hub requires a registry and context factory.',
        'INVALID_KNOWLEDGE_BASE_HUB',
        500,
      );
    }
    this.registry = options.registry;
    this.createContext = options.createContext;
    this.records = new Map();
    this.revision = '';
    this.syncChain = Promise.resolve();
    this.blockedIds = new Map();
    this.closing = false;
    this.ready = this.#enqueue(() => this.#sync());
  }

  #enqueue(callback) {
    const operation = this.syncChain.then(callback, callback);
    this.syncChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #closeRecord(record) {
    if (!record?.context) return;
    await Promise.resolve(record.context.close?.() || record.context.manager?.close?.()).catch(() => {});
  }

  #block(ids) {
    for (const id of ids) this.blockedIds.set(id, (this.blockedIds.get(id) || 0) + 1);
  }

  #unblock(ids) {
    for (const id of ids) {
      const remaining = (this.blockedIds.get(id) || 0) - 1;
      if (remaining > 0) this.blockedIds.set(id, remaining);
      else this.blockedIds.delete(id);
    }
  }

  #matchingRecord(entry) {
    const record = this.records.get(entry.knowledgeBaseId);
    if (
      !record || record.entry.revision !== entry.revision ||
      record.entry.enabled !== entry.enabled
    ) return null;
    return record;
  }

  async #open(entry) {
    const record = { entry, context: null, initializing: entry.enabled, errorCode: '' };
    if (!entry.enabled) return record;
    if (entry.unavailableCode) {
      record.initializing = false;
      record.errorCode = safeCode({ code: entry.unavailableCode });
      return record;
    }
    try {
      const context = await this.createContext(entry);
      if (!context?.manager || !context?.index || !context?.store || !context?.conversations) {
        throw new KnowledgeBaseHubError(
          'Knowledge-base context factory returned an incomplete context.',
          'INVALID_KNOWLEDGE_BASE_CONTEXT',
          500,
        );
      }
      await context.manager.ready;
      record.context = context;
    } catch (error) {
      record.errorCode = safeCode(error);
    } finally {
      record.initializing = false;
    }
    return record;
  }

  async #sync() {
    if (this.closing) throw new KnowledgeBaseHubError(
      'Knowledge-base hub is closing.', 'KNOWLEDGE_BASE_HUB_CLOSING', 503,
    );
    await this.registry.ready;
    await this.registry.refresh?.();
    const snapshot = this.registry.runtimeSnapshot();
    if (snapshot.revision === this.revision) return this.publicStatus();

    const changedIds = new Set();
    for (const entry of snapshot.knowledgeBases) {
      if (!this.#matchingRecord(entry)) changedIds.add(entry.knowledgeBaseId);
    }
    for (const id of this.records.keys()) {
      if (!snapshot.knowledgeBases.some((entry) => entry.knowledgeBaseId === id)) changedIds.add(id);
    }
    this.#block(changedIds);
    try {
      if (this.hasActiveTasks(changedIds)) {
        throw new KnowledgeBaseHubError(
          'A selected knowledge base has an active task. Wait for it to finish before changing the registry.',
          'KNOWLEDGE_BASE_BUSY',
          409,
        );
      }

      const next = new Map();
      const opening = [];
      for (const entry of snapshot.knowledgeBases) {
        const current = this.#matchingRecord(entry);
        if (current) {
          current.entry = entry;
          next.set(entry.knowledgeBaseId, current);
          continue;
        }
        opening.push(this.#open(entry).then((record) => next.set(entry.knowledgeBaseId, record)));
      }
      await Promise.all(opening);
      const retired = [...this.records.entries()]
        .filter(([id, record]) => next.get(id) !== record)
        .map(([, record]) => this.#closeRecord(record));
      await Promise.all(retired);
      this.records = next;
      this.revision = snapshot.revision;
      return this.publicStatus();
    } finally {
      this.#unblock(changedIds);
    }
  }

  async refresh() {
    return this.#enqueue(() => this.#sync());
  }

  async updateRegistry(input, options = {}) {
    return this.#enqueue(async () => {
      const affected = affectedKnowledgeBaseIds(
        this.registry.administrativeSnapshot(),
        input?.knowledgeBases,
      );
      this.#block(affected);
      try {
        if (this.hasActiveTasks(affected)) {
          throw new KnowledgeBaseHubError(
            'A selected knowledge base has an active task. Wait for it to finish before changing the registry.',
            'KNOWLEDGE_BASE_BUSY',
            409,
          );
        }
        const updated = await this.registry.update(input, options);
        await this.#sync();
        return updated;
      } finally {
        this.#unblock(affected);
      }
    });
  }

  resolve(id = '') {
    const entry = this.registry.resolve(id);
    if (this.blockedIds.has(entry.knowledgeBaseId)) {
      throw new KnowledgeBaseHubError(
        'The selected knowledge base is changing. Retry after the registry update finishes.',
        'KNOWLEDGE_BASE_BUSY',
        409,
      );
    }
    const record = this.#matchingRecord(entry);
    if (!record?.context) {
      throw new KnowledgeBaseHubError(
        'The selected knowledge base is unavailable.',
        record?.errorCode || 'KNOWLEDGE_BASE_UNAVAILABLE',
        503,
      );
    }
    return record.context;
  }

  record(id = '') {
    const entry = this.registry.resolve(id, { allowDisabled: true });
    if (this.blockedIds.has(entry.knowledgeBaseId)) return null;
    return this.#matchingRecord(entry);
  }

  async createTask(id, userId, body) {
    const entry = this.registry.resolve(id);
    if (this.blockedIds.has(entry.knowledgeBaseId)) {
      throw new KnowledgeBaseHubError(
        'The selected knowledge base is changing. Retry after the registry update finishes.',
        'KNOWLEDGE_BASE_BUSY',
        409,
      );
    }
    const record = this.#matchingRecord(entry);
    if (!record?.context) {
      throw new KnowledgeBaseHubError(
        'The selected knowledge base is unavailable.',
        record?.errorCode || 'KNOWLEDGE_BASE_UNAVAILABLE',
        503,
      );
    }
    record.admissions = (record.admissions || 0) + 1;
    try {
      const result = await record.context.manager.createTask(userId, body);
      return { context: record.context, result };
    } finally {
      record.admissions -= 1;
    }
  }

  publicStatus() {
    const registry = this.registry.publicSnapshot();
    const knowledgeBases = registry.knowledgeBases.map((entry) => {
      const current = this.#matchingRecord(entry);
      const record = current || {
        entry,
        context: null,
        initializing: entry.enabled,
        errorCode: '',
      };
      return recordStatus(record);
    });
    const readyCount = knowledgeBases.filter((entry) => entry.status === 'ready').length;
    return Object.freeze({
      revision: registry.revision,
      stale: registry.stale,
      defaultKnowledgeBaseId: registry.defaultKnowledgeBaseId,
      knowledgeBases: Object.freeze(knowledgeBases),
      readyCount,
      enabledCount: knowledgeBases.filter((entry) => entry.enabled).length,
    });
  }

  hasActiveTasks(ids = null) {
    const selected = ids ? new Set(ids) : null;
    for (const [id, record] of this.records) {
      if (selected && !selected.has(id)) continue;
      if ((record.admissions || 0) > 0) return true;
      const tasks = record.context?.manager?.tasks;
      if (tasks && [...tasks.values()].some((task) => !['completed', 'failed', 'cancelled'].includes(task.status))) {
        return true;
      }
    }
    return false;
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    await this.syncChain.catch(() => {});
    await Promise.all([...this.records.values()].map((record) => this.#closeRecord(record)));
    this.records.clear();
  }
}

export const knowledgeBaseHubInternals = Object.freeze({
  affectedKnowledgeBaseIds,
  safeCode,
  recordStatus,
});
