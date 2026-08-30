# VaultMind architecture

VaultMind consumes a local filesystem mirror of an Obsidian Vault. Sync is deliberately separated from indexing and generation.

The read path is: safe Vault gateway → Markdown chunker → BM25 and optional embeddings → RRF → grounded model prompt → cited answer.

The write path is: user input → model-generated Markdown → draft outside the Vault → human review → hash conflict check → write to an allow-listed folder.

Hidden directories such as `.obsidian` are excluded at the filesystem gateway so plugin configuration cannot enter search results or model context.
