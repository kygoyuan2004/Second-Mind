# Second-Mind architecture

Second-Mind consumes a local filesystem mirror of an Obsidian Vault. Sync is deliberately separated from indexing and generation.

The read path is: safe Vault gateway → Markdown chunker → Normal single-pass or Deep multi-query retrieval → BM25 and optional embeddings → RRF/evidence fusion → bounded grounded model prompt → cited answer.

The write path is: user input → model-generated Markdown → draft outside the Vault → human review → hash conflict check → write to an allow-listed folder.

Hidden directories such as `.obsidian` are excluded at the filesystem gateway so plugin configuration cannot enter search results or model context.
