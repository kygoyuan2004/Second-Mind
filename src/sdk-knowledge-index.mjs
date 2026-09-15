import { KnowledgeIndex as OriginalIndex } from './original/knowledge-index.mjs';
import { QUERY_RETRIEVAL_INSTRUCTION } from './original/bailian-retrieval.mjs';
import { EmbeddingClient } from './embedding-client.mjs';
import { VaultPathPolicy } from './path-policy.mjs';

/** Keeps the original index, routing, tokenizer, RRF, reranker and caches.
 * The adapter connects its client and lifecycle to the retained config UI. */
export class SdkKnowledgeIndex extends OriginalIndex {
  constructor(config, options = {}) {
    const client = options.client || new EmbeddingClient(config.embedding);
    const retrieval = Object.create(client);
    retrieval.embeddingModel = client.embeddingModel || client.model || '';
    retrieval.embed = (texts, opts = {}) => client.embed(texts, {
      ...opts, ...(opts.textType === 'query' ? { instruct: QUERY_RETRIEVAL_INSTRUCTION } : {}),
    });
    super({ root: config.vaultPath, indexRoot: config.indexDir, client: retrieval,
      fetchEmbeddings: config.embedding?.provider !== 'disabled',
      watch: options.watch ?? config.retrieval?.watch,
      autoBuild: false,
    });
    this.embeddingConfig = config.embedding || { provider: 'disabled' };
    this.policy = new VaultPathPolicy(config.vaultPath);
    const initialized = this.ready;
    this.ready = initialized.then(async () => {
      await this.policy.initialize();
      if (options.autoBuild !== false) await this.rebuild();
      return this;
    });
  }

  status() {
    const status = super.status();
    return { ...status, available: Boolean(this.policy?.realRoot),
      lexicalAvailable: Boolean(this.policy?.realRoot),
      semanticAvailable: status.chunks > 0 && status.embeddedChunks === status.chunks,
      embedding: { provider: this.embeddingConfig?.provider || 'disabled',
        model: status.embeddingModel, dimensions: status.dimensions },
      watchEnabled: this.watchEnabled,
      lastError: status.lastError ? { code: status.lastError.code } : null,
    };
  }
}
