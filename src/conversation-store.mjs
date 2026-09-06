import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { markPublicMessage } from './public-errors.mjs';
import { normalizeLearningReview } from './learning-review.mjs';

const STORE_VERSION = 2;
const MAX_FORK_TURNS = 5;
const MAX_RESEARCH_ITEMS = 20;

function boundedText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function boundedStringList(value, { maxItems = 20, maxLength = 240 } = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    const text = boundedText(item, maxLength);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

function normalizedHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

function normalizeVerifiedClaim(value) {
  if (typeof value === 'string') {
    const text = boundedText(value, 1_000);
    return text ? { text } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = boundedText(value.text ?? value.claim ?? value.statement, 1_000);
  if (!text) return null;
  const claim = { text };
  const id = boundedText(value.id, 120);
  const evidenceType = boundedText(value.evidenceType, 40);
  const effectiveAt = boundedText(value.effectiveAt, 80);
  const observedAt = boundedText(value.observedAt, 80);
  const asOf = boundedText(value.asOf, 80);
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : boundedText(value.confidence, 24);
  const sourceIds = boundedStringList(value.sourceIds, { maxItems: 20, maxLength: 120 });
  if (id) claim.id = id;
  if (sourceIds.length) claim.sourceIds = sourceIds;
  if (evidenceType) claim.evidenceType = evidenceType;
  if (typeof value.direct === 'boolean') claim.direct = value.direct;
  if (confidence !== '') claim.confidence = confidence;
  if (effectiveAt) claim.effectiveAt = effectiveAt;
  if (observedAt) claim.observedAt = observedAt;
  if (asOf) claim.asOf = asOf;
  return claim;
}

function normalizeCitedSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = {};
  const id = boundedText(value.id ?? value.sourceId, 120);
  const kind = boundedText(value.kind, 24);
  const title = boundedText(value.title, 500);
  const url = normalizedHttpsUrl(value.url);
  const vaultPath = boundedText(value.path ?? value.vaultPath, 1_000);
  const provider = boundedText(value.source ?? value.provider, 160);
  const publishedAt = boundedText(value.publishedAt, 80);
  const effectiveAt = boundedText(value.effectiveAt, 80);
  if (!id && !url && !vaultPath) return null;
  if (id) source.id = id;
  if (kind) source.kind = kind;
  if (title) source.title = title;
  if (url) source.url = url;
  if (vaultPath) source.path = vaultPath;
  if (provider) source.source = provider;
  if (publishedAt) source.publishedAt = publishedAt;
  if (effectiveAt) source.effectiveAt = effectiveAt;
  return source;
}

function normalizePendingClarification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (boundedText(value.kind, 40) !== 'context_switch') return null;
  const proposedInput = value.proposedState;
  if (!proposedInput || typeof proposedInput !== 'object' || Array.isArray(proposedInput)) return null;
  const subjectInput = proposedInput.subject && typeof proposedInput.subject === 'object' &&
    !Array.isArray(proposedInput.subject) ? proposedInput.subject : {};
  const intentInput = proposedInput.intent && typeof proposedInput.intent === 'object' &&
    !Array.isArray(proposedInput.intent) ? proposedInput.intent : {};
  const temporalInput = proposedInput.temporal && typeof proposedInput.temporal === 'object' &&
    !Array.isArray(proposedInput.temporal) ? proposedInput.temporal : {};
  const proposedState = {
    standaloneQuestion: boundedText(proposedInput.standaloneQuestion, 4_000),
    subject: {
      name: boundedText(subjectInput.name, 240),
      type: boundedText(subjectInput.type, 80),
      aliases: boundedStringList(subjectInput.aliases, { maxItems: 20, maxLength: 240 }),
    },
    requiredAnchors: boundedStringList(
      proposedInput.requiredAnchors,
      { maxItems: 20, maxLength: 240 },
    ),
    intent: {
      label: boundedText(intentInput.label, 240),
      terms: boundedStringList(intentInput.terms, { maxItems: 20, maxLength: 240 }),
    },
    temporal: {
      mode: boundedText(temporalInput.mode, 40),
      asOf: boundedText(temporalInput.asOf, 80) || null,
    },
  };
  if (!proposedState.standaloneQuestion) return null;
  return {
    kind: 'context_switch',
    proposedState,
    createdAt: boundedText(value.createdAt, 80) || null,
  };
}

function normalizeResearchContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const subjectInput = value.subject && typeof value.subject === 'object' && !Array.isArray(value.subject)
    ? value.subject
    : {};
  const intentInput = value.intent && typeof value.intent === 'object' && !Array.isArray(value.intent)
    ? value.intent
    : {};
  const temporalInput = value.temporal && typeof value.temporal === 'object' && !Array.isArray(value.temporal)
    ? value.temporal
    : {};
  const subject = {
    name: boundedText(subjectInput.name, 240),
    type: boundedText(subjectInput.type, 80),
    aliases: boundedStringList(subjectInput.aliases, { maxItems: 20, maxLength: 240 }),
  };
  const intent = {
    label: boundedText(intentInput.label, 240),
    terms: boundedStringList(intentInput.terms, { maxItems: 20, maxLength: 240 }),
  };
  const temporal = {
    mode: boundedText(temporalInput.mode, 40),
    asOf: boundedText(temporalInput.asOf, 80) || null,
  };
  const claimsInput = value.verifiedClaims ?? value.claims ?? value.facts;
  const sourcesInput = value.citedSources ?? value.finalSources ?? value.sources;
  const verifiedClaims = (Array.isArray(claimsInput) ? claimsInput : [])
    .map(normalizeVerifiedClaim)
    .filter(Boolean)
    .slice(0, MAX_RESEARCH_ITEMS);
  const citedSources = (Array.isArray(sourcesInput) ? sourcesInput : [])
    .map(normalizeCitedSource)
    .filter(Boolean)
    .slice(0, MAX_RESEARCH_ITEMS);
  const pendingClarification = normalizePendingClarification(value.pendingClarification);
  const learningReview = normalizeLearningReview(value.learningReview);
  const context = {
    subject,
    requiredAnchors: boundedStringList(value.requiredAnchors, { maxItems: 20, maxLength: 240 }),
    intent,
    temporal,
    lastStandaloneQuestion: boundedText(value.lastStandaloneQuestion, 4_000),
    verifiedClaims,
    citedSources,
  };
  if (pendingClarification) context.pendingClarification = pendingClarification;
  if (learningReview) context.learningReview = learningReview;
  const hasContent = subject.name || subject.type || subject.aliases.length
    || context.requiredAnchors.length || intent.label || intent.terms.length
    || temporal.mode || temporal.asOf || context.lastStandaloneQuestion
    || verifiedClaims.length || citedSources.length || pendingClarification || learningReview;
  return hasContent ? context : null;
}

function recentCompleteTurns(messages, limit = MAX_FORK_TURNS) {
  const pairs = [];
  let pendingUser = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'user') {
      pendingUser = message;
    } else if (message?.role === 'assistant' && pendingUser) {
      pairs.push([pendingUser, message]);
      pendingUser = null;
    }
  }
  return structuredClone(pairs.slice(-Math.max(0, limit)).flat());
}

function hydrateConversation(value) {
  const conversation = {
    version: STORE_VERSION,
    id: String(value.id),
    userId: String(value.userId),
    kind: boundedText(value.kind, 32) || 'qa',
    title: boundedText(value.title, 500) || 'New conversation',
    model: boundedText(value.model, 240),
    actualModel: boundedText(value.actualModel, 500),
    modelProvider: boundedText(value.modelProvider, 120),
    modelBindingRevision: boundedText(value.modelBindingRevision, 160),
    effort: boundedText(value.effort, 80) || 'default',
    taskMode: value.kind === 'qa' ? boundedText(value.taskMode, 40) || 'normal' : 'normal',
    webSearch: value.kind === 'qa' && value.webSearch === true,
    webSearchProvider: value.kind === 'qa' && value.webSearch === true
      ? boundedText(value.webSearchProvider, 80)
      : '',
    webSearchBindingRevision: value.kind === 'qa' && value.webSearch === true
      ? boundedText(value.webSearchBindingRevision, 160)
      : '',
    messages: structuredClone(value.messages),
    createdAt: boundedText(value.createdAt, 80) || new Date().toISOString(),
    updatedAt: boundedText(value.updatedAt, 80) || boundedText(value.createdAt, 80) || new Date().toISOString(),
  };
  const knowledgeBaseId = boundedText(value.knowledgeBaseId, 64);
  const knowledgeBaseRevision = boundedText(value.knowledgeBaseRevision, 120);
  const parentConversationId = boundedText(value.parentConversationId, 120);
  const forkedAt = boundedText(value.forkedAt, 80);
  const researchContext = normalizeResearchContext(value.researchContext);
  const effectiveEffort = boundedText(value.effectiveEffort, 80);
  if (parentConversationId) conversation.parentConversationId = parentConversationId;
  if (forkedAt) conversation.forkedAt = forkedAt;
  if (researchContext) conversation.researchContext = researchContext;
  if (effectiveEffort) conversation.effectiveEffort = effectiveEffort;
  if (knowledgeBaseId) conversation.knowledgeBaseId = knowledgeBaseId;
  if (knowledgeBaseRevision) conversation.knowledgeBaseRevision = knowledgeBaseRevision;
  return conversation;
}

function serializedConversation(value) {
  return hydrateConversation({ ...value, messages: Array.isArray(value.messages) ? value.messages : [] });
}

async function atomicJson(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fsp.rename(temporary, filename);
    await fsp.chmod(filename, 0o600).catch(() => {});
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function conversationError(message, code = 'CONVERSATION_NOT_FOUND') {
  const error = new Error(message);
  error.status = ['CONVERSATION_BUSY', 'CONVERSATION_WRITE_CONFLICT'].includes(code) ? 409 : 404;
  error.code = code;
  return markPublicMessage(error);
}

export class ConversationStore {
  constructor(filename) {
    this.filename = path.resolve(filename);
    this.conversations = new Map();
    this.writeChain = Promise.resolve();
    this.mutationChain = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    await fsp.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filename, 'utf8'));
      for (const conversation of parsed?.conversations || []) {
        if (conversation?.id && conversation?.userId && Array.isArray(conversation.messages)) {
          const hydrated = hydrateConversation(conversation);
          this.conversations.set(hydrated.id, hydrated);
        }
      }
      await fsp.chmod(this.filename, 0o600).catch(() => {});
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  save(snapshotSource = this.conversations) {
    // Capture at the transaction boundary. Capturing later, when a queued write
    // starts, can accidentally persist another request's not-yet-committed map
    // mutation and makes that request's rollback ineffective on disk.
    const values = snapshotSource instanceof Map
      ? [...snapshotSource.values()]
      : Array.isArray(snapshotSource) ? snapshotSource : [...this.conversations.values()];
    const snapshot = {
      version: STORE_VERSION,
      conversations: values.map(serializedConversation),
    };
    const write = () => atomicJson(this.filename, snapshot);
    this.writeChain = this.writeChain.then(write, write);
    return this.writeChain;
  }

  withMutation(callback) {
    const run = () => callback();
    const result = this.mutationChain.then(run, run);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return result;
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
      ...(conversation.knowledgeBaseId ? {
        knowledgeBaseId: conversation.knowledgeBaseId,
        knowledgeBaseRevision: conversation.knowledgeBaseRevision || null,
      } : {}),
      kind: conversation.kind,
      title: conversation.title,
      model: conversation.model,
      actualModel: conversation.actualModel || null,
      modelProvider: conversation.modelProvider || null,
      modelBindingRevision: conversation.modelBindingRevision || null,
      effort: conversation.effort || 'default',
      taskMode: conversation.kind === 'qa' ? conversation.taskMode || 'normal' : 'normal',
      webSearch: conversation.kind === 'qa' && conversation.webSearch === true,
      webSearchProvider: conversation.webSearchProvider || null,
      webSearchBindingRevision: conversation.webSearchBindingRevision || null,
      parentConversationId: conversation.parentConversationId || null,
      forkedAt: conversation.forkedAt || null,
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

  prepare(userId, kind, metadata = {}) {
    const now = new Date().toISOString();
    const conversation = {
      version: STORE_VERSION,
      id: crypto.randomUUID(),
      userId,
      kind,
      title: metadata.title || 'New conversation',
      model: metadata.model || '',
      actualModel: boundedText(metadata.actualModel, 500),
      modelProvider: boundedText(metadata.modelProvider, 120),
      modelBindingRevision: boundedText(metadata.modelBindingRevision, 160),
      effort: metadata.effort || 'default',
      taskMode: kind === 'qa' ? metadata.taskMode || 'normal' : 'normal',
      webSearch: kind === 'qa' && metadata.webSearch === true,
      webSearchProvider: kind === 'qa' && metadata.webSearch === true
        ? boundedText(metadata.webSearchProvider, 80)
        : '',
      webSearchBindingRevision: kind === 'qa' && metadata.webSearch === true
        ? boundedText(metadata.webSearchBindingRevision, 160)
        : '',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    const knowledgeBaseId = boundedText(metadata.knowledgeBaseId, 64);
    const knowledgeBaseRevision = boundedText(metadata.knowledgeBaseRevision, 120);
    const researchContext = normalizeResearchContext(metadata.researchContext);
    const effectiveEffort = boundedText(metadata.effectiveEffort, 80);
    if (researchContext) conversation.researchContext = researchContext;
    if (effectiveEffort) conversation.effectiveEffort = effectiveEffort;
    if (knowledgeBaseId) conversation.knowledgeBaseId = knowledgeBaseId;
    if (knowledgeBaseRevision) conversation.knowledgeBaseRevision = knowledgeBaseRevision;
    return conversation;
  }

  create(userId, kind, metadata = {}) {
    const conversation = this.prepare(userId, kind, metadata);
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  prepareFork(userId, parentId, metadata = {}) {
    const parent = this.get(userId, parentId);
    const now = new Date().toISOString();
    const child = {
      version: STORE_VERSION,
      id: crypto.randomUUID(),
      userId,
      kind: parent.kind,
      title: boundedText(metadata.title, 500) || parent.title || 'New conversation',
      model: boundedText(metadata.model, 240) || parent.model || '',
      actualModel: boundedText(metadata.actualModel, 500) || parent.actualModel || '',
      modelProvider: boundedText(metadata.modelProvider, 120) || parent.modelProvider || '',
      modelBindingRevision: boundedText(metadata.modelBindingRevision, 160)
        || parent.modelBindingRevision || '',
      effort: boundedText(metadata.effort, 80) || parent.effort || 'default',
      taskMode: parent.kind === 'qa'
        ? boundedText(metadata.taskMode, 40) || parent.taskMode || 'normal'
        : 'normal',
      webSearch: parent.kind === 'qa'
        && (Object.hasOwn(metadata, 'webSearch') ? metadata.webSearch === true : parent.webSearch === true),
      webSearchProvider: parent.kind === 'qa'
        ? boundedText(metadata.webSearchProvider, 80) || parent.webSearchProvider || ''
        : '',
      webSearchBindingRevision: parent.kind === 'qa'
        ? boundedText(metadata.webSearchBindingRevision, 160) || parent.webSearchBindingRevision || ''
        : '',
      messages: recentCompleteTurns(parent.messages),
      parentConversationId: parent.id,
      forkedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const knowledgeBaseId = boundedText(metadata.knowledgeBaseId || parent.knowledgeBaseId, 64);
    const knowledgeBaseRevision = boundedText(
      metadata.knowledgeBaseRevision || parent.knowledgeBaseRevision,
      120,
    );
    const researchContext = normalizeResearchContext(parent.researchContext);
    const effectiveEffort = boundedText(metadata.effectiveEffort, 80)
      || parent.effectiveEffort || '';
    if (!child.webSearch) {
      child.webSearchProvider = '';
      child.webSearchBindingRevision = '';
    }
    if (researchContext) child.researchContext = structuredClone(researchContext);
    if (effectiveEffort) child.effectiveEffort = effectiveEffort;
    if (knowledgeBaseId) child.knowledgeBaseId = knowledgeBaseId;
    if (knowledgeBaseRevision) child.knowledgeBaseRevision = knowledgeBaseRevision;
    return child;
  }

  createFork(userId, parentId, metadata = {}) {
    const child = this.prepareFork(userId, parentId, metadata);
    this.conversations.set(child.id, child);
    return child;
  }

  async commitNew(userId, value) {
    return this.withMutation(async () => {
      const conversation = hydrateConversation(value);
      if (conversation.userId !== userId || this.conversations.has(conversation.id)) {
        throw conversationError('Conversation state changed before it could be committed.', 'CONVERSATION_WRITE_CONFLICT');
      }
      const next = new Map(this.conversations);
      next.set(conversation.id, conversation);
      // Make the new conversation visible only after its complete snapshot is
      // durable. A concurrent list/get can therefore never observe a child
      // which later disappears because persistence failed.
      await this.save(next);
      this.conversations = next;
      return conversation;
    });
  }

  async commitExisting(userId, id, value, options = {}) {
    return this.withMutation(async () => {
      const current = this.get(userId, id);
      if (
        options.expectedUpdatedAt &&
        String(current.updatedAt) !== String(options.expectedUpdatedAt)
      ) {
        throw conversationError(
          'Conversation state changed before it could be committed.',
          'CONVERSATION_WRITE_CONFLICT',
        );
      }
      const next = hydrateConversation({ ...value, id: current.id, userId: current.userId });
      const committed = new Map(this.conversations);
      committed.set(current.id, next);
      await this.save(committed);
      this.conversations = committed;
      return next;
    });
  }

  async fork(userId, parentId, metadata = {}) {
    await this.ready;
    return this.commitNew(userId, this.prepareFork(userId, parentId, metadata));
  }

  setResearchContext(userId, id, value) {
    const conversation = this.get(userId, id);
    const researchContext = normalizeResearchContext(value);
    if (researchContext) conversation.researchContext = researchContext;
    else delete conversation.researchContext;
    return researchContext ? structuredClone(researchContext) : null;
  }

  getResearchContext(userId, id) {
    const conversation = this.get(userId, id);
    const researchContext = normalizeResearchContext(conversation.researchContext);
    return researchContext ? structuredClone(researchContext) : null;
  }

  rollback(userId, id, snapshot = null) {
    const current = this.conversations.get(String(id));
    if (!current || current.userId !== userId) return;
    if (snapshot) this.conversations.set(current.id, structuredClone(snapshot));
    else this.conversations.delete(current.id);
  }

  async delete(userId, id, options = {}) {
    return this.withMutation(async () => {
      if (options.isBusy?.(id)) throw conversationError('Conversation has an active task.', 'CONVERSATION_BUSY');
      const conversation = this.get(userId, id);
      const next = new Map(this.conversations);
      next.delete(conversation.id);
      await this.save(next);
      this.conversations = next;
      return { ok: true };
    });
  }

  async clear(userId, kind, options = {}) {
    return this.withMutation(async () => {
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
      const next = new Map(this.conversations);
      for (const item of matches) next.delete(item.id);
      await this.save(next);
      this.conversations = next;
      return { ok: true, deletedCount: matches.length };
    });
  }
}

export const conversationStoreInternals = {
  atomicJson,
  normalizeResearchContext,
  recentCompleteTurns,
  serializedConversation,
};
