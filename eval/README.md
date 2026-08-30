# Retrieval evaluation

`demo-dataset.json` is synthetic and exists only to exercise the evaluation pipeline. Replace it with a private, human-reviewed dataset whose `relevantPaths` point to your own Vault. Do not commit private questions or note paths.

Run lexical evaluation against the included demo Vault:

```bash
VAULT_PATH=examples/demo-vault EMBEDDING_PROVIDER=disabled npm run eval -- --k 3 --min-recall 1
```

The included three-query synthetic baseline currently reports Recall@3 `1.0000`,
MRR `0.8333`, and nDCG@3 `0.8770`. These values only verify that the evaluation
pipeline is reproducible; they do not measure production retrieval quality.

The report includes Recall@K, mean reciprocal rank, and nDCG@K. When a remote
Embedding provider is enabled, evaluation sends the indexed fixture text and
queries to that provider.
