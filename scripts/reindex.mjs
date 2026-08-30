import { createConfig } from '../src/config.mjs';
import { EmbeddingClient } from '../src/embedding-client.mjs';
import { KnowledgeIndex } from '../src/knowledge-index.mjs';

const config = createConfig();
const client = new EmbeddingClient(config.embedding);
const index = new KnowledgeIndex(config, { client, watch: false, autoBuild: false });
await index.ready;
const generation = await index.rebuild({ verifyHashes: true });
console.log(JSON.stringify({ ok: true, status: index.status(), generation: generation?.generation }, null, 2));
await index.close();
