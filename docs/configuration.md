# Configuration

Copy `.env.example` to `.env` for a direct Node.js deployment. Docker Compose
also reads `.env` for non-secret interpolation, but production credentials
should use the file-backed secrets overlay described in
[deployment.md](deployment.md).

The Vault root must already exist. With `VAULT_AUTO_CREATE_PATHS=true`,
Second-Mind creates only its three configured write directories inside that
root; it does not silently create a missing Vault.

## Required runtime settings

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` or `ADMIN_PASSWORD_FILE` | Administrator password, at least 12 characters |
| `SESSION_SECRET` or `SESSION_SECRET_FILE` | Independent session-signing secret, at least 32 characters |
| `VAULT_PATH` | Existing local Obsidian Vault directory |
| `LLM_PROVIDER` | `openai-compatible` or `anthropic` |
| `LLM_API_BASE` | Model provider base URL |
| `LLM_MODEL` | Provider-specific model identifier |
| `LLM_API_KEY` or `LLM_API_KEY_FILE` | Model key; it may be empty for an unauthenticated local endpoint |

Every secret setting supports a matching `_FILE` variable. A non-empty direct
value takes precedence. Secret files writable by group or others are rejected.

## Application and paths

| Variable | Default | Notes |
|---|---:|---|
| `APP_NAME` | `Second Mind` | Browser-visible application name |
| `VAULT_LABEL` | `My Obsidian Vault` | Browser-visible Vault label |
| `HOST` | `127.0.0.1` | Keep loopback unless a container/reverse proxy requires otherwise |
| `PORT` | `8787` | HTTP listen port |
| `TIMEZONE` | `UTC` | IANA zone used for diary/plan dates |
| `DATA_DIR` | `./data` | Private state; must be outside `VAULT_PATH` |
| `INDEX_DIR` | `DATA_DIR/index` | Retrieval generations |
| `DRAFT_DIR` | `DATA_DIR/drafts` | Unconfirmed drafts and staged attachments |
| `RECOVERY_DIR` | `DATA_DIR/recovery` | Verified preimages retained before replacing existing notes |
| `CONVERSATION_FILE` | `DATA_DIR/conversations.json` | Chat history |
| `AUDIT_FILE` | `DATA_DIR/audit.jsonl` | Metadata-only write audit |
| `DIARY_DIR` | `Second-Mind/Diary` | Allowed diary write root |
| `PLAN_DIR` | `Second-Mind/Plans` | Allowed plan write root |
| `SCRATCH_DIR` | `Second-Mind/Inbox` | Allowed evergreen-note write root |
| `DIARY_TEMPLATE` / `PLAN_TEMPLATE` | blank | Optional relative Markdown path inside the Vault |
| `VAULT_EXCLUDED_PATHS` | see `.env.example` | Replacement comma-separated denylist; every hidden path is denied separately regardless |

### Upgrading the write-directory defaults

The current defaults are `Second-Mind/Diary`, `Second-Mind/Plans`, and
`Second-Mind/Inbox`. Earlier releases used `VaultMind/Diary`,
`VaultMind/Plans`, and `VaultMind/Inbox`. Second-Mind does not move notes during
an upgrade. After backing up the Vault, either set all three old paths
explicitly to preserve the existing layout, or stop every application/Sync
writer and deliberately migrate the directories before adopting the new
defaults. Mixing the two choices can split old and new notes across both trees.

`TRUST_PROXY=true` trusts the first `X-Forwarded-For` value for login
throttling. Enable it only when clients cannot bypass a proxy that replaces
forwarding headers. Use `SECURE_COOKIE=true` whenever the browser connects over
HTTPS.

## Model examples

### Local Ollama from a native Node.js process

```dotenv
LLM_PROVIDER=openai-compatible
LLM_API_BASE=http://127.0.0.1:11434/v1
LLM_API_KEY=
LLM_MODEL=qwen3:8b
```

In Docker Compose, use `http://host.docker.internal:11434/v1` to reach Ollama
on the Docker host. Loopback and `host.docker.internal` HTTP endpoints are
allowed by default.

### Hosted OpenAI-compatible endpoint

```dotenv
LLM_PROVIDER=openai-compatible
LLM_API_BASE=https://api.example.com/v1
LLM_API_KEY_FILE=/run/secrets/llm_api_key
LLM_MODEL=provider-model-id
```

### Anthropic Messages API

```dotenv
LLM_PROVIDER=anthropic
LLM_API_BASE=https://api.anthropic.com
LLM_API_KEY_FILE=/run/secrets/llm_api_key
LLM_MODEL=provider-model-id
```

The project deliberately treats model IDs as operator input instead of
hard-coding a claim that a particular hosted model remains available.

## Embeddings and retrieval

`EMBEDDING_PROVIDER=disabled` gives a complete BM25-only deployment. Set it to
`openai-compatible` or `dashscope` for hybrid retrieval.

| Variable | Default | Notes |
|---|---:|---|
| `EMBEDDING_API_BASE` | local OpenAI-compatible base | Base URL when no explicit endpoint is set |
| `EMBEDDING_ENDPOINT` | blank | Full provider endpoint override |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Provider-specific identifier |
| `EMBEDDING_DIMENSIONS` | `768` | Must exactly match returned vectors |
| `EMBEDDING_BATCH_SIZE` | `16` | Documents per outbound request |
| `RAG_TOP_K` | `8` | Source files supplied to generation |
| `RAG_MAX_CONTEXT_CHARS` | `30000` | Maximum retrieved source text in one prompt |
| `DEEP_TASKS_ENABLED` | `true` | Publish provider-neutral Deep Retrieval for Q&amp;A: bounded query decomposition, up to four hybrid searches, and evidence fusion |
| `RAG_DEEP_TOP_K` | `16` | Explicit per-search and final source-file ceiling for Deep Retrieval |
| `INDEX_WATCH` | `true` | Watch known Vault directories for changes |
| `INDEX_RECONCILE_SECONDS` | `300` | Full metadata/hash reconciliation interval |

Example local hybrid setup:

```dotenv
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_BASE=http://127.0.0.1:11434/v1
EMBEDDING_API_KEY=
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
```

Changing provider, model, or dimension invalidates the active vector
generation and triggers a rebuild. Run `npm run index` to build explicitly.

Remote embedding providers receive every indexed text chunk and each semantic
query. Deep Retrieval can send several model-generated query variants.
Remote chat providers receive the user prompt, recent conversation history,
selected note excerpts, and supported text-attachment excerpts; Deep Retrieval
also uses one bounded planning request before final generation. It is not the
private predecessor's 50-turn or multi-subagent runtime. Use local endpoints
when that data must remain on the host.

## Transport policy and limits

Remote provider URLs must use HTTPS. Plain HTTP is accepted automatically only
for loopback and `host.docker.internal`; any other host requires
`ALLOW_INSECURE_PROVIDER_HTTP=true`. This switch should be limited to a trusted
private network.

Request and attachment limits are controlled by `MAX_JSON_BODY_BYTES`,
`MAX_ATTACHMENT_COUNT`, `MAX_ATTACHMENT_BYTES`, and
`MAX_ATTACHMENT_TOTAL_BYTES`. A generated Markdown draft is independently
limited to 512 KiB. `RECOVERY_RETENTION_DAYS` controls automatic preimage
retention and defaults to 30 days; backups remain necessary.

## Sync labels

`SYNC_PROVIDER` accepts `filesystem`, `obsidian-headless`, or `external`.
`SYNC_DISPLAY_NAME` is display metadata only. Neither variable starts a sync
client or grants Second-Mind any sync credential. See [sync.md](sync.md).

## Compatibility identifiers

The browser-visible product name is Second-Mind. The environment loader name
`VAULTMIND_ENV_FILE` and Compose variables `VAULTMIND_BIND_IP`,
`VAULTMIND_PORT`, `VAULTMIND_UID`, and `VAULTMIND_GID` remain supported as
legacy configuration identifiers. Existing deployments should keep them until
a separately documented migration is available; their spelling does not alter
the UI brand.
