# Configuration

The Docker-first installer is the recommended configuration path. It creates file-backed authentication secrets and private instance state outside the Git checkout. After sign-in, use the administrator page for model, WebSearch, embedding, branding, and knowledge-base registry changes.

Environment configuration remains available for Compose defaults and advanced direct-Node compatibility. Do not hand-edit managed runtime JSON while the service is running.

## Minimum startup configuration

The application needs:

- an administrator password of at least 12 characters;
- an independent session secret of at least 32 characters;
- at least one readable Vault or allowed parent mount;
- a writable private data directory outside every Vault.

No LLM, WebSearch, or embedding credential is required to start. Without an LLM, sign-in, knowledge-base administration, status, file preview, and BM25 keyword search remain available. Generation returns `LLM_NOT_CONFIGURED` until an enabled model is saved.

The installers generate authentication secrets and validate path separation. For direct Node.js startup, prefer `ADMIN_PASSWORD_FILE` and `SESSION_SECRET_FILE` instead of direct environment values.

## Knowledge-base mounts and registry

Compose binds `KNOWLEDGE_BASE_HOST_PATH` to `/vaults` and sets both `VAULT_PATH` and `KNOWLEDGE_BASE_ALLOWED_ROOTS` to that container path. The host selection may be:

- one Obsidian Vault root containing `.obsidian`; or
- a parent directory whose immediate children are Obsidian Vault roots.

On first managed startup, a parent mount discovers only immediate child directories containing an actual, non-symlink `.obsidian` directory, up to 32. Nested discovery is not recursive. A direct Vault root remains a single compatible base and needs the same marker.

The administrator page can later edit entries only within mounts authorized at startup. It accepts mount IDs plus relative paths, not host absolute paths. Every managed entry must resolve to an actual Vault root, rather than another parent directory. The registry requires 1 to 32 entries, at least one enabled entry, and exactly one enabled default. A private ledger permanently binds each stable ID to its first canonical Vault path across deletion and restart; use a new ID for a different Vault.

For an advanced direct-Node deployment, `KNOWLEDGE_BASE_ALLOWED_ROOTS` is a platform path-delimited list. All roots must already exist, must not overlap, and must not overlap `DATA_DIR`. The older `VAULT_PATH` is used as the single allowed root when the new setting is absent.

## Managed Provider configuration

The administrator page stores a versioned private configuration under `DATA_DIR/runtime`. The primary and last-known-good files must be owner-controlled regular files with restrictive permissions. Writes use revision comparison, validation, atomic replacement, and directory synchronization.

The managed configuration is global to one Second Mind instance:

- up to 16 model connections;
- up to 32 model definitions;
- at most 3 enabled models;
- one default enabled model when models exist;
- one selected WebSearch provider;
- one desired embedding profile;
- application branding.

The current registered model providers are:

| Provider | Supported protocol |
|---|---|
| Alibaba Model Studio | Anthropic Messages or OpenAI Chat Completions, selected by its API Base path |
| DeepSeek | OpenAI Chat Completions |
| GLM | OpenAI Chat Completions |
| Kimi | OpenAI Chat Completions |
| Custom | OpenAI Chat Completions or Anthropic Messages |

Managed API Bases must use public HTTPS DNS names without embedded credentials, query strings, fragments, or nonstandard ports. Registered adapters own their protocol, authentication, output, and reasoning-field policies. For the Pi execution layer, Anthropic Messages maps to `anthropic-messages` and OpenAI Chat Completions maps to `openai-completions`. The Custom adapter emits protocol-common fields and does not infer vendor-specific behavior from a model name.

The workbench exposes five stable effort choices: `low`, `medium`, `high`, `xhigh`, and `max`. Each adapter maps them to supported provider-native behavior. When a target has no compatible reasoning control, the selected tier remains visible in conversation state but no invented vendor field is sent.

Changing an API Base, protocol, authentication mode, or provider requires replacing or clearing the associated key. A key is never carried silently to a new destination.

## Independent credentials

LLM connections, WebSearch providers, and the embedding service have separate credential fields and separate rotation boundaries. None falls back to another category. The optional page-extraction fallback is part of the selected WebSearch configuration and may explicitly reuse that selected search credential; this does not grant it an LLM or embedding key.

The browser submits a key only for an explicit replace action. It does not persist keys in localStorage, sessionStorage, URLs, cookies, or ordinary page state after the request. Read APIs return only `configured` or `apiKeyConfigured` flags.

Every supported legacy environment secret also accepts a `_FILE` variant. A direct value takes precedence only when it is non-empty. Secret files must be regular files. Direct POSIX files must not be writable by group or other users. Docker Desktop can synthesize broad mode bits for host files; the runtime permits that narrow case only for an exact safe filename directly under `/run/secrets` when `/proc/self/mountinfo` proves that exact mount is read-only. The host ACL still remains the installer's or manual operator's responsibility.

The embedded Pi runtime is locked to the published `0.85.1` SDK packages and receives only the credential saved through Second Mind's managed configuration or legacy `_FILE` boundary. It uses an in-memory credential store and does not read or mount host `~/.pi`, `~/.claude`, Pi OAuth, Claude Code login files, global model catalogs, extensions, skills, or prompt files. No Pi CLI installation is required.

## Validation and paid operations

Provider edits are checked before commit. Model validation performs one privacy-safe, tool-free generation with a 64-token output ceiling and no automatic retry. The simplified model/WebSearch flow stores a validated candidate briefly on the server and returns a one-use receipt. Saving claims that receipt against the same administrator and revision. A restart or concurrent update invalidates it.

Validation receipts are kept only in the current process until claimed by a matching save. Production tasks always retain the fixed retrieval/text-generation pipeline and use Pi only for each planned, tool-free generation. A failed generation returns a bounded provider error and cannot fall back to an autonomous Agent path.

Connection validation contacts the selected remote service and may incur cost. Embedding `validate-and-build` can send every indexable text chunk in the selected knowledge base. The UI requires password reauthentication and an explicit confirmation before these operations.

Startup, sign-in, configuration reads, registry changes, lexical indexing, and BM25 search do not contact a paid Provider.

## Embedding and retrieval

Embedding choices are:

| Value | Behavior |
|---|---|
| `disabled` | BM25 keyword retrieval only |
| `openai-compatible` | Calls a compatible embeddings endpoint |
| `dashscope` | Calls the DashScope native text-embedding endpoint |

The desired embedding configuration is global, but the built vector index is activated separately for each knowledge base. Select the base in the administrator page before building. A build creates a candidate slot, probes/detects dimensions when required, indexes the complete eligible base, and activates only after success. The prior active slot continues serving during a build and after a failed or cancelled build.

A newly added base starts with a lexical route even when a remote embedding target was saved. Startup does not make the first remote build automatically. `semantic` search fails explicitly when no matching active vector slot exists; `hybrid` can report a lexical fallback.

Index and task environment defaults retained by the application are:

| Variable | Default | Meaning |
|---|---:|---|
| `RAG_TOP_K` | `8` | Compatibility/auxiliary retrieval bound; it does not prescribe Pi's reading sequence |
| `RAG_DEEP_TOP_K` | `16` | Compatibility/auxiliary Deep bound; Pi uses its own bounded tool arguments |
| `RAG_MAX_CONTEXT_CHARS` | `30000` | Compatibility/auxiliary context ceiling; `read_note` separately enforces page limits |
| `INDEX_WATCH` | `true` | Watch for filesystem changes |
| `INDEX_RECONCILE_SECONDS` | `300` | Full reconciliation interval |
| `DEEP_TASKS_ENABLED` | `true` | Make the larger bounded Deep retrieval/model-call budget available |

## WebSearch and page reading

WebSearch is disabled by default and can be enabled only for eligible Q&A conversations. Current managed providers are Alibaba Model Studio WebSearch MCP and Tavily REST. Each stores its own credential status; only the currently selected provider is used by a new task. Prompt wording does not create a separate learning-review execution mode.

When networking is explicitly enabled, the server runs its bounded WebSearch stage. The optional safe reader accepts only an exact public HTTPS URL returned by that same task's search. It validates DNS and connected IPs, redirects, content type, byte size, character size, timeouts, and concurrency. It is not a general browser. Lower bounds can be configured through the `WEB_READER_*` variables in `.env.example`; application hard caps cannot be raised through environment input.

`PDF_ENABLED=true` also requires `WEB_READER_ENABLED=true` and a working sandboxed PDF parser. The standard image intentionally omits `bwrap` and `pdftotext`, so PDF reading remains unavailable there. The service does not silently run an unsandboxed parser.

`WEB_SEARCH_OFFICIAL_DOMAINS` accepts comma-separated public hostnames without schemes, ports, paths, credentials, IP addresses, or wildcards. It is an evidence preference, not permission to bypass URL safety checks.

## Pi executor, research, and conversations

Production Q&A retains the server-owned pipeline selected by `QA_CONTEXTUALIZER_ENABLED` and `QA_RESEARCH_LOOP_ENABLED`. That pipeline owns query routing, local retrieval, filtering, temporal inventory, bounded web stages, evidence feedback, context construction, and output finalization. Personal period learning/work recaps use the server's deterministic fixed-snapshot review plan with the original 50 model-call, 40 read/search, and 30-minute ceilings. Pi receives no tools and executes one already-planned model generation per call. Other Normal tasks have a 20-call/10-minute ceiling and Deep tasks a 50-call/30-minute ceiling.

A running task captures its model, WebSearch, index, and configuration revisions at creation. A later admin save affects only new tasks. Changing a conversation's model, requested effort, or WebSearch setting requires a child conversation. Normal and Deep can switch within one Q&A conversation without forking.

### Pi context-window policy

`LLM_CONTEXT_WINDOW` is the deployment-wide context-window declaration used by Pi and defaults to `1000000` tokens, matching the original Qwen 1M binding. It applies to both managed Provider configurations and legacy direct-Node bindings because the current managed model registry does not store or probe a separate verified context window for each model. The packaged default is defined in [`src/pi-context-policy.mjs`](../src/pi-context-policy.mjs).

The value registers the model capacity for each Pi request. Context selection and trimming remain in the application pipeline. Pi starts no AgentSession compaction and performs no autonomous context-overflow retry.

This is an operator capacity claim, not a request parameter that enlarges a remote model. The one-shot connection check does not verify a one-million-token prompt. Set the value no higher than the smallest real context window of every enabled model that may receive a task. Values must be integers from `4096` through `2000000`.

For Compose, set the override in the project `.env` or the installed instance's environment file and rerun `docker compose up -d`; `docker compose restart` alone does not reload changed Compose environment values. For direct Node.js or systemd, set it in the service environment or `EnvironmentFile` and restart the service. Wait for active tasks before doing either because process restart or container recreation aborts unfinished work. Tasks created after the service starts again use the new value; merely editing an environment file cannot mutate an already-created task lease.

## Paths and write policy

Important direct-Node path settings are:

| Variable | Default | Purpose |
|---|---|---|
| `VAULT_PATH` | `./vault` | Legacy single Vault root |
| `DATA_DIR` | `./data` | Private runtime state, always outside Vaults |
| Legacy Pi session directory | `${DATA_DIR}/pi-sessions` | Read-only compatibility/cleanup for older checkpoints; new tasks create none |
| `DIARY_DIR` | `Second-Mind/Diary` | Allowed diary destination inside each Vault |
| `PLAN_DIR` | `Second-Mind/Plans` | Allowed plan destination inside each Vault |
| `SCRATCH_DIR` | `Second-Mind/Inbox` | Allowed scratch destination inside each Vault |
| `VAULT_EXCLUDED_PATHS` | `.obsidian,.trash,.git,.sync,.livesync,node_modules` | Paths excluded from indexing and direct access |
| `RECOVERY_RETENTION_DAYS` | `30` | Recovery-copy retention |

Write destinations and optional templates must be normalized relative paths. Do not put `DATA_DIR`, credentials, installer state, or backups inside a Vault or an allowed Vault parent. Legacy Pi session data remains private and may be cleaned up, but new tasks do not create or attach Pi checkpoints.

## Authentication, transport, and limits

| Variable | Default | Guidance |
|---|---:|---|
| `ADMIN_USERNAME` | `admin` | The single administrator username |
| `SESSION_TTL_SECONDS` | `43200` | Signed session lifetime |
| `SECURE_COOKIE` | `false` | Set `true` behind HTTPS |
| `TRUST_PROXY` | `false` | Enable only when direct access is prevented by a trusted proxy |
| `HOST` | `127.0.0.1` | Direct-Node listen address |
| `PORT` | `8787` | Direct-Node listen port |
| `TIMEZONE` | `UTC` | Valid IANA time zone used for date workflows |

Compose listens inside the container on `0.0.0.0:8787` but publishes to `VAULTMIND_BIND_IP=127.0.0.1` and `VAULTMIND_PORT=8787` by default.

Request and attachment limits are configured by `MAX_JSON_BODY_BYTES`, `MAX_ATTACHMENT_COUNT`, `MAX_ATTACHMENT_BYTES`, and `MAX_ATTACHMENT_TOTAL_BYTES`. Defaults are listed in `.env.example`. Q&A accepts text attachments only. Filename and MIME checks are not malware scanning.

## Legacy environment model settings

`LLM_PROVIDER`, `LLM_API_BASE`, `LLM_API_KEY`, `LLM_MODEL`, and their embedding/WebSearch peers remain for direct-Node migration and first bootstrap. Managed schema version 2 becomes authoritative after bootstrap. `LLM_CONTEXT_WINDOW` is different: it remains a deployment-wide Pi policy for managed and legacy models. New Docker installations should configure Provider identities and credentials in the administrator page.

`ALLOW_INSECURE_PROVIDER_HTTP` applies only to compatible legacy clients and must be used only for a trusted local/private endpoint. The managed Provider registry requires public HTTPS destinations.

The `VAULTMIND_*` Compose variables, `vaultmind_session` cookie, and `X-VaultMind-Request` header remain compatibility identifiers. Renaming them would break existing volumes, sessions, scripts, or proxy rules; they do not control visible branding.

See [.env.example](../.env.example) for runtime defaults and common host settings. The required Compose secrets overlay maps host files through `ADMIN_PASSWORD_SECRET_PATH`, `SESSION_SECRET_SECRET_PATH`, `LLM_API_KEY_SECRET_PATH`, `EMBEDDING_API_KEY_SECRET_PATH`, `WEB_SEARCH_API_KEY_SECRET_PATH`, and `BAILIAN_RESPONSES_FALLBACK_API_KEY_SECRET_PATH`; keep those mappings in a private installer-generated or operator-owned env file. See [security](security.md) for trust boundaries and [API](api.md) for revision and secret-action contracts.
