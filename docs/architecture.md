# Second-Mind architecture

Second-Mind is a single-user, self-hosted knowledge application built around one
constraint: an Obsidian Vault remains an ordinary local directory. Sync,
retrieval, generation, and write approval are separate concerns.

<p align="center">
  <a href="assets/second-mind-architecture.png">
    <img src="assets/second-mind-architecture.png" alt="Second-Mind architecture with separate grounded-read and review-before-write paths" width="100%">
  </a>
</p>

## Components

### HTTP and browser layer

`src/server.mjs` serves the static workspace and a small JSON/SSE API without a
web framework. `src/auth.mjs` owns password verification, signed sessions,
login throttling, the same-origin check, and the custom write-request header.
The browser renders generated Markdown only after DOMPurify sanitization; all
browser dependencies are served locally so the UI does not depend on a CDN.

### Retrieval layer

`src/knowledge-index.mjs` turns Markdown-aware blocks into overlapping chunks,
tokenizes English, identifiers, dates, and CJK text, and builds a BM25 index.
When embeddings are configured, it also stores dense vectors and combines the
lexical and semantic rankings with reciprocal rank fusion (RRF).

The index has two important failure modes:

- If embeddings are disabled or temporarily fail, hybrid queries degrade to
  keyword retrieval and expose the reason in diagnostics.
- Index writes use immutable generations plus a manifest. The previous valid
  generation can be loaded if the current one is corrupt or incompatible.

Chunk hashes allow unchanged vectors to be reused. Filesystem watchers provide
low-latency updates, while periodic hash reconciliation covers missed events.
The persisted index contains note excerpts and must be protected like the
Vault itself.

### Model adapters

`src/llm-client.mjs` supports OpenAI-compatible chat endpoints and Anthropic's
Messages API. `src/embedding-client.mjs` supports OpenAI-compatible embeddings
and the native DashScope embedding endpoint. Provider keys remain in server
process memory and request headers; they are never returned to the browser.

No model receives shell access, arbitrary filesystem tools, or a general web
tool. Retrieved notes and attachments are explicitly framed as untrusted data
inside the prompt.

### Safe write path

`src/vault-store.mjs` implements review-before-write:

1. Load a built-in or operator-selected template and the current target note.
2. Generate Markdown and stage it, with any attachments, outside the Vault.
3. Return the draft to the browser for review and editing.
4. On explicit confirmation, re-check the target content hash and path policy.
5. Before replacing an existing note, retain the hash-verified preimage in
   private recovery storage and check the live hash once more.
6. Atomically create or replace the note inside one of three configured write
   roots, then append a metadata-only audit event.

The same `VaultPathPolicy` protects indexing, source preview, templates, and
writes. Hidden segments, configured exclusions, traversal, and symbolic links
are denied. In particular, `.obsidian` and `.livesync` never become model
context.

### Sync boundary

Second-Mind does not implement a synchronization protocol. An operator-selected
process materializes files into `VAULT_PATH`. This keeps the retrieval and
write core independent from Obsidian Sync and leaves a clean interface for a
future, separately tested LiveSync materializer. See [sync.md](sync.md).

## Runtime state

All private application state lives below `DATA_DIR`, outside the Vault:

```text
DATA_DIR/
├── audit.jsonl
├── conversations.json
├── drafts/
├── recovery/              verified preimages, retained for a bounded period
└── index/
    ├── manifest.json
    └── generations/
```

The Vault, runtime state, provider services, sync credentials, and backups are
separate security and recovery domains. See [data-flow.md](data-flow.md) and
[security.md](security.md) for the trust-boundary analysis.

## Deliberate scope

The current release is a focused single-administrator application. It does not
claim enterprise RBAC, SSO, distributed locking, malware scanning, managed
sync, or production-quality retrieval benchmarks. Those boundaries keep the
implemented guarantees understandable and testable.
