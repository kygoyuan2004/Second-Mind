import { createConfig } from '../src/config.mjs';
import { EmbeddingClient } from '../src/embedding-client.mjs';
import path from 'node:path';
import { SdkKnowledgeIndex as KnowledgeIndex } from '../src/sdk-knowledge-index.mjs';

const base = createConfig();
const config = { ...base, indexDir: path.join(base.dataDir, 'sdk-v1', 'index') };
const client = new EmbeddingClient(config.embedding);
const index = new KnowledgeIndex(config, { client, watch: false, autoBuild: false });
await index.ready;
const generation = await index.rebuild({ verifyHashes: true });
console.log(JSON.stringify({ ok: true, status: index.status(), generation: generation?.generation }, null, 2));
await index.close();
