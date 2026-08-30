import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/config.mjs';
import { EmbeddingClient } from '../src/embedding-client.mjs';
import { KnowledgeIndex } from '../src/knowledge-index.mjs';

function argumentsMap(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const next = argv[index + 1];
    values[key.slice(2)] = next && !next.startsWith('--') ? argv[++index] : true;
  }
  return values;
}

function validateDataset(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('Evaluation dataset must be a non-empty JSON array.');
  const ids = new Set();
  return value.map((item, index) => {
    const id = String(item?.id || '').trim();
    const query = String(item?.query || '').trim();
    const relevantPaths = [...new Set((item?.relevantPaths || []).map(String).filter(Boolean))];
    if (!id || ids.has(id) || !query || !relevantPaths.length) {
      throw new Error(`Evaluation item ${index + 1} needs a unique id, query, and relevantPaths.`);
    }
    ids.add(id);
    return { id, query, relevantPaths };
  });
}

function ndcg(paths, relevant, k) {
  let dcg = 0;
  for (let index = 0; index < Math.min(paths.length, k); index += 1) {
    if (relevant.has(paths[index])) dcg += 1 / Math.log2(index + 2);
  }
  let ideal = 0;
  for (let index = 0; index < Math.min(relevant.size, k); index += 1) ideal += 1 / Math.log2(index + 2);
  return ideal ? dcg / ideal : 0;
}

const options = argumentsMap(process.argv.slice(2));
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const datasetFile = path.resolve(String(options.dataset || path.join(projectRoot, 'eval', 'demo-dataset.json')));
const dataset = validateDataset(JSON.parse(await fsp.readFile(datasetFile, 'utf8')));
const base = createConfig();
const config = {
  ...base,
  vaultPath: path.resolve(String(options.vault || base.vaultPath)),
  indexDir: path.resolve(String(options.index || base.indexDir)),
  retrieval: { ...base.retrieval, watch: false },
};
const client = new EmbeddingClient(config.embedding);
const index = new KnowledgeIndex(config, { client, watch: false, autoBuild: false });
await index.ready;
await index.rebuild();

const k = Math.max(1, Math.min(30, Number(options.k) || 10));
const records = [];
for (const item of dataset) {
  const result = await index.search(item.query, { route: 'hybrid', limit: k });
  const paths = result.results.map((entry) => entry.path);
  const relevant = new Set(item.relevantPaths);
  const hits = paths.filter((entry) => relevant.has(entry));
  const first = paths.findIndex((entry) => relevant.has(entry));
  records.push({
    id: item.id,
    query: item.query,
    recallAtK: hits.length / relevant.size,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    ndcgAtK: ndcg(paths, relevant, k),
    returnedPaths: paths,
  });
}
const average = (key) => records.reduce((sum, item) => sum + item[key], 0) / records.length;
const report = {
  generatedAt: new Date().toISOString(),
  dataset: path.basename(datasetFile),
  questions: records.length,
  k,
  mode: index.status().semanticAvailable ? 'hybrid' : 'keyword',
  metrics: {
    recallAtK: Number(average('recallAtK').toFixed(4)),
    meanReciprocalRank: Number(average('reciprocalRank').toFixed(4)),
    ndcgAtK: Number(average('ndcgAtK').toFixed(4)),
  },
  records,
};
console.log(JSON.stringify(report, null, 2));
await index.close();

const minimum = options['min-recall'] === undefined ? null : Number(options['min-recall']);
if (minimum !== null && (!Number.isFinite(minimum) || report.metrics.recallAtK < minimum)) {
  process.exitCode = 1;
}
