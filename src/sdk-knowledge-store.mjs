import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeStore, knowledgeInternals } from './original/knowledge-store.mjs';
import { VaultStore as LegacyDraftStore } from './vault-store.mjs';

// Fresh installations have no personal templates. These neutral starter
// templates are used in memory; existing Vault templates always take priority.
const STARTER_TEMPLATES = {
  diary: '# YYYY-MM-DD 日记\n\n## 今日事项\n\n## 感悟反思\n\n## 其他\n',
  plan: '# YYYY-MM-DD 计划\n\n## 任务清单\n\n- [ ] \n\n## 备注\n',
};

export class SdkKnowledgeStore extends KnowledgeStore {
  constructor(config, legacyConfig, index) {
    super({ root: config.vaultPath, draftRoot: config.draftDir,
      auditFile: config.auditFile, index, requireStructure: false });
    this.config = config;
    this.legacyConfig = legacyConfig;
    this.recoveryRoot = path.join(config.dataDir, 'recovery');
  }

  async findDatedTarget(kind, date) {
    try { return await super.findDatedTarget(kind, date); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const { canonical } = knowledgeInternals.parseDate(date);
      return { date: canonical, relative: `${this.paths[kind]}/${canonical}.md`, exists: false };
    }
  }

  async prepareDatedDocument(kind, date) {
    const target = await this.findDatedTarget(kind, date);
    await this.assertPathNoSymlinks(this.templates[kind]);
    let template;
    try { template = await fs.readFile(path.join(this.root, this.templates[kind]), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; template = STARTER_TEMPLATES[kind]; }
    const current = target.exists ? await fs.readFile((await this.existingFile(target.relative)).target, 'utf8') : '';
    return { ...target, template: template.replaceAll('YYYY-MM-DD', target.date), current,
      sourceHash: target.exists ? crypto.createHash('sha256').update(current).digest('hex') : null };
  }

  async saveDraft(userId, id, changes = {}) {
    const { draft } = await this.readDraft(userId, id);
    if (draft.legacyDraft) {
      // Compatibility is restricted to old drafts. New generation and search
      // always use the original SDK implementation.
      this.legacyStores ||= new Map();
      if (!this.legacyStores.has(draft.kind)) {
        const legacyStore = new LegacyDraftStore({ ...this.legacyConfig,
          // Confirmation needs only this draft's original allowed directory.
          // An unrelated missing diary/plan directory must not block a scratch save.
          paths: { [draft.kind]: this.legacyConfig.paths[draft.kind] }, templates: {},
          dataDir: this.config.dataDir, draftDir: this.draftRoot,
          recoveryDir: this.recoveryRoot, auditFile: this.auditFile, autoCreateVaultPaths: false,
        }, { index: this.index });
        await legacyStore.ready;
        this.legacyStores.set(draft.kind, legacyStore);
      }
      return this.legacyStores.get(draft.kind).saveDraft(userId, id, changes);
    }
    const { clean, target } = this.resolve(draft.targetRelative);
    const allowed = this.paths[draft.kind];
    if (!allowed || !clean.startsWith(`${allowed}/`)) throw Object.assign(new Error('草稿目标不在允许写入的目录中。'), { code: 'KNOWLEDGE_WRITE_DENIED', status: 403 });
    const parent = path.dirname(clean);
    await this.assertPathNoSymlinks(parent);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    await this.assertPathNoSymlinks(parent);
    const previous = await this.existingFile(draft.targetRelative).catch((error) => {
      if (error.code === 'FILE_NOT_FOUND') return null; throw error;
    });
    if (previous) {
      const directory = path.join(this.recoveryRoot, crypto.randomUUID());
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const content = await fs.readFile(previous.target);
      await fs.writeFile(path.join(directory, 'before.md'), content, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify({
        version: 1, targetPath: draft.targetRelative, draftId: id, userId,
        createdAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(content).digest('hex'),
      }), { flag: 'wx', mode: 0o600 });
    }
    return super.saveDraft(userId, id, changes);
  }
}
