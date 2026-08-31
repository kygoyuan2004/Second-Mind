# Data flow and privacy boundaries

Second-Mind combines a browser, a local filesystem Vault, private application
state, and operator-selected model services. Deployment does not make a remote
provider private: understand each flow before using real notes.

## Component flow

```text
Browser
  | HTTPS (question, note input, attachments; streamed answer/draft)
  v
Trusted reverse proxy or Tailscale Serve
  | loopback HTTP
  v
Second-Mind application
  |-- read allowed Markdown/text ------> retrieval index in DATA_DIR
  |-- confirmed writes ---------------> diary/plan/inbox in VAULT_PATH
  |-- conversations/drafts/audit -----> private DATA_DIR volume
  |-- document chunks + queries ------> embedding endpoint (optional)
  `-- prompts + selected context ------> LLM endpoint

Optional Obsidian Headless sidecar
  |-- read/write local VAULT_PATH
  `-- encrypted Sync traffic <--------> Obsidian Sync service
```

The reverse proxy transports application traffic; it does not perform
retrieval or model inference. `SYNC_PROVIDER` is a status/configuration value,
not an embedded Sync client. Files appear in the Vault through an optional
external process.

## Browser to application

After login, the browser sends questions, diary/plan/inbox input, selected
dates, and optional attachments to Second-Mind. Answers and draft events stream
back over server-sent events. The browser receives source paths and retrieved
content needed for the interface.

Use HTTPS for every non-loopback browser connection. The proxy may observe
plaintext after TLS termination, so it and its access-log policy are trusted.
Do not enable request-body, cookie, or authorization-header logging.

## Vault and local application state

The application scans allowed text files under `VAULT_PATH`. The default
excluded-path policy denies `.obsidian`, `.trash`, `.git`, `.sync`,
`.livesync`, and `node_modules`; retain at least those exclusions. The index
stores note paths, chunk text, metadata, and—when enabled—embedding vectors in
`INDEX_DIR`. A vector is derived data, not anonymized data.

`DATA_DIR` also contains:

- conversation history, including user questions and model responses;
- pending drafts and temporary attachment copies;
- an audit log containing write/security event metadata;
- index generations and retrieval metadata.

All of these are confidential. The index can be rebuilt, but conversations,
drafts, and audit records cannot. Back up and retain them according to the
sensitivity of the underlying Vault, not as harmless cache files.

Vault writes follow a preview-and-confirm flow. Diary, plan, and inbox paths
are the only supported write destinations. A confirmed note-mode draft copies
its attachments from private draft storage into that note's asset directory.
Deleting a conversation does not delete notes already committed to the Vault,
provider-side records, backups, or remote Sync copies.

## Embedding provider egress

When `EMBEDDING_PROVIDER=disabled`, retrieval is lexical and no embedding API
is called. When embeddings are enabled, Second-Mind sends:

- chunks of indexed documents during initial and incremental indexing; and
- the user's search/question text when generating a query vector.

Provider-neutral Deep Retrieval can additionally send up to three
model-generated query variants to the embedding endpoint. Normal Q&amp;A sends
one query.

The provider returns vectors, which are stored in the local index. Provider
requests can therefore expose much more of the Vault than the few passages
shown in one answer. Review the provider's retention, training, regional, and
abuse-monitoring terms. Use a separate least-privilege API key and HTTPS.

## LLM provider egress

For a knowledge question, the LLM request contains the system instructions,
the question, up to ten recent conversation messages, retrieved note excerpts
within `RAG_MAX_CONTEXT_CHARS`, source paths, and text attachment excerpts.
Provider-neutral Deep Retrieval first sends the question and bounded recent
context in a separate query-planning request, then sends the fused source
context for the final answer. It is a bounded retrieval strategy, not the
private predecessor's 50-turn or multi-subagent runtime. Only observable search
queries and progress are displayed; hidden chain-of-thought is neither
requested nor exposed.

For a diary, plan, or inbox draft, the request contains the user input and may
contain the configured template, current note content, and text attachment
excerpts. The generated Markdown returns to Second-Mind and remains a private
draft until the user explicitly saves it.

Image and PDF bytes are not supplied to the current text-only LLM request.
They can be retained in private draft storage and, after confirmation, written
to the Vault as attachments. They still require malware scanning and safe
viewer handling; the application does not sanitize their binary content.

Model output is untrusted. It may reproduce context or contain unsafe advice,
links, or Markdown. The model has no shell or arbitrary filesystem tool in this
architecture, and operators should not add one without a new threat model.

## Local model path

With an operator-controlled OpenAI-compatible LLM and embedding service, set
the endpoints to loopback (`host.docker.internal` from Compose) or to a tightly
restricted private service. In that topology, model request content stays on
the operator-controlled host/network rather than being sent to a commercial
model API.

This does not make the entire deployment offline. Obsidian Headless still
communicates with Obsidian Sync when enabled, package/image builds may contact
registries, and backups or monitoring can create their own egress. Verify with
firewall and DNS logs instead of relying only on configuration labels.

Keep `ALLOW_INSECURE_PROVIDER_HTTP=false`. Loopback and
`host.docker.internal` HTTP are accepted for local inference. For a separate
host, prefer authenticated HTTPS; an explicit plain-HTTP opt-in should be
limited to a trusted, firewalled private network.

## Obsidian Sync flow

The optional Headless sidecar has read/write access to the whole Vault and
connects to the Obsidian Sync service. Its login and remote-Vault link state
live in private named volumes that the application does not mount. Second-Mind
can still observe ordinary note files after the sidecar materializes them.

Obsidian Headless is an open beta and its npm package is marked UNLICENSED.
The main application image does not contain it. Operators build the optional
sidecar locally and must not publish that resulting image. Do not run Desktop
Sync and Headless Sync against the same local Vault on the same device. Sync
is not a backup; take versioned, independently stored snapshots.

## LiveSync boundary

Self-hosted LiveSync is an architectural placeholder only and is **not
implemented**. No supplied service connects to CouchDB, consumes a Setup URI,
or loads LiveSync credentials. A future materializer must keep database and
encryption credentials outside the application-visible Vault and must not run
alongside another Sync engine for the same Vault.

## Deployment decision table

| Configuration | Note text leaves the application host? | Other important egress |
|---|---|---|
| Local LLM, embeddings disabled, no Sync | No during normal use | Package updates, backups, or monitoring only if configured |
| Local LLM and local embeddings, no Sync | No during normal use | Same operational exceptions |
| Remote LLM, embeddings disabled | Selected context, history, prompts, and text attachment excerpts go to the LLM | Provider metadata |
| Remote embeddings | Document chunks and queries go to the embedding provider | Remote LLM flow also applies if configured |
| Obsidian Headless enabled | Vault contents synchronize through Obsidian Sync | Model flows remain independent |

Before production use, document which row applies, who administers each trust
boundary, provider retention settings, backup destinations, and the procedure
for deleting or rotating each class of data and credential.
