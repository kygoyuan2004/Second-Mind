# Second Mind architecture

Second Mind is a single-process Node.js service with server-served static assets and JSON/SSE APIs. It runs one authenticated administrator experience over one or more filesystem knowledge bases. Q&A keeps the fixed server-orchestrated retrieval and generation pipeline; Pi `0.85.1` is only the implementation behind each planned model generation. Docker Compose is the supported default deployment, but the application can also run directly under Node.js `^22.22.0` or `>=24.8.0` when the operator provides equivalent filesystem and secret isolation.

## Component map

```mermaid
flowchart TB
  UI[Browser workbench and admin UI] --> HTTP[HTTP authentication, JSON, and SSE]
  HTTP --> REG[Knowledge-base registry]
  REG --> KA[Knowledge-base A runtime]
  REG --> KB[Knowledge-base B runtime]
  KA --> IA[BM25 and optional vector index A]
  KA --> SA[Conversations, drafts, recovery, audit A]
  KB --> IB[BM25 and optional vector index B]
  KB --> SB[Conversations, drafts, recovery, audit B]
  HTTP --> RC[Global runtime configuration]
  RC --> MR[Task-scoped model router]
  RC --> WR[Task-scoped WebSearch router]
  IA --> TA[Task manager A]
  IB --> TB[Task manager B]
  TA --> MR
  TB --> MR
  TA --> IA
  TB --> IB
  TA --> WR
  TB --> WR
  WR --> RD[Safe optional page reader]
  TA --> VA[Vault store and write policy A]
  TB --> VB[Vault store and write policy B]
```

## Startup and readiness

`src/bootstrap.mjs` performs the production bootstrap:

1. Load environment defaults and file-backed authentication secrets.
2. Open or create the private runtime configuration, including a last-known-good copy.
3. Open the knowledge-base registry and validate its allowed mount boundaries.
4. When the configured mount is a parent directory and no managed registry exists, discover only immediate child directories that contain `.obsidian`, up to the 32-base limit.
5. Create one runtime context for every enabled, available knowledge base.
6. Build or open a lexical index without calling a remote provider.
7. Report ready when at least one enabled base has a usable index.

`/health/live` reports process liveness. `/health/ready` reports `200` only when initialization completed and at least one knowledge base is ready. A failed base remains visible with a bounded error code and does not stop a different healthy base from serving requests.

## Knowledge-base registry

Each registry entry contains a stable `knowledgeBaseId`, display name, allowed mount ID, relative path, enabled flag, default flag, and derived entry revision. Exactly one enabled entry is the default, at least one entry remains enabled, and the registry contains between 1 and 32 entries.

The registry rejects:

- absolute paths or traversal outside an allowed mount;
- a symbolic-link traversal or unavailable path during an update;
- a managed directory without an actual, non-symlink `.obsidian` marker;
- duplicate or nested knowledge-base roots;
- overlapping allowed mounts;
- overlap between a Vault mount and private application state.

The public API never reveals host mount paths. The administrator API exposes only mount IDs, human-readable labels, and Vault-relative paths. Updates use compare-and-swap with `expectedRevision`, require password reauthentication, and fail if an affected base has an active task.

Removing a registry entry retires its in-memory runtime but does not delete the Vault or private state on disk.

A private, mode-restricted binding ledger stores only an ID and a digest of its first canonical Vault root. The ledger is committed before a registry update and retains removed IDs, so neither delete/re-add, restart, nor an external registry refresh can bind an old semantic ID to a different Vault. Operators replacing a mount with different content at the identical host path must assign a new ID; host mount manipulation is outside the remote API trust boundary.

## Per-base runtime context

Every enabled base receives its own:

- `KnowledgeIndex` and active/previous embedding slot state;
- `VaultStore` and path-policy instance;
- conversation file;
- private drafts and temporary attachments;
- recovery copies;
- audit log;
- legacy Pi session metadata and cleanup state, when older data contains it;
- `TaskManager` and active-task namespace.

New managed bases store these under an ID-and-canonical-root-bound directory in the private data volume. A migrated legacy default base retains its earlier state locations. Opaque task, conversation, and draft IDs are resolved only inside the selected context, so using an ID with another `knowledgeBaseId` returns not found instead of crossing boundaries.

Each knowledge response carries `knowledgeBaseId`, `knowledgeBaseRevision`, and `knowledgeBaseName`. The browser also uses a selection epoch to discard responses and events that complete after the user switches bases. Switching the UI does not cancel a task already running in the previous base.

## Global runtime services

The managed Provider registry is global to the application instance. It defines model connections, enabled model bindings, the default model, independent WebSearch providers, an embedding target, and branding. Provider credentials are private server state and are represented to clients only by boolean configured fields.

At most three models may be enabled. A model binding selects a registered provider adapter and protocol. Alibaba Model Studio, DeepSeek, GLM, Kimi, and Custom adapters constrain endpoints, authentication, output limits, and reasoning mappings. Anthropic Messages maps to Pi's `anthropic-messages` API and OpenAI Chat Completions maps to `openai-completions`. Custom services receive only protocol-common fields unless the administrator explicitly selects a supported adapter.

A task acquires immutable model and WebSearch leases when it is created. Saving a new configuration changes later tasks, not a running task. Before a secret-bearing model candidate can be committed, production validation performs one short, privacy-safe, tool-free generation through the same Pi adapter. Configuration files use restrictive permissions, atomic replacement, revision checks, and last-known-good recovery.

Embedding configuration is globally selected, but vector activation is per knowledge base. An administrator explicitly validates and rebuilds the selected base into a new slot. Activation happens only after the new index succeeds. Startup never creates the first remote vector index and never silently replaces an active usable slot.

## Retrieval and generation

All bases have a lexical BM25 route. When an activated embedding slot is available, semantic and hybrid reciprocal-rank-fusion routes become available. A failed semantic dependency is reported explicitly; the server can still use lexical discovery without a vector service.

Normal and Deep use the same server-owned research pipeline with different bounded budgets. The application plans and executes query generation, lexical/semantic/hybrid search, date-record listing, source selection, context assembly, and final answer generation. Pi receives only the messages for each already-planned generation and has no tools with which to alter that flow. Search results only discover candidates; source normalization and citation checks remain application-owned.

When a user explicitly enables networking, the application may execute its bounded `web_search` and `web_read` stages. The safe reader accepts only eligible HTTPS results and retains its network controls. Personal period learning/work recaps remain Q&A but use a deterministic local-only review plan over a fixed index snapshot; the server, not Pi, schedules all inventory, date slicing, batched reads, supporting-note expansion, and evidence-state validation. Every Pi generation uses `tools=[]`, starts no `AgentSession`, and loads no shell, mutation tool, general filesystem API, arbitrary fetch, host extension, skill, prompt, `AGENTS.md`, `~/.pi`, or `~/.claude` configuration.

Only hash-verified Vault paths actually returned by `read_note` are eligible as Vault sources. The server rejects invented or merely search-discovered citations during answer normalization.

## Conversations and task state

Conversations persist complete user and assistant messages, model selection, requested and effective effort, task mode, WebSearch selection, and immutable Provider binding identities. A legacy validated Pi session filename can remain in old stored data but is not created or resumed for new work. Normal and Deep may change within the same Q&A conversation. Changing the model, effort, or WebSearch setting creates an explicit child conversation; at most five complete prior turns are copied.

The product conversation store is the only context authority for new work. TaskManager selects the bounded recent complete turns, builds each request, and commits a new assistant turn only after final normalization succeeds. Failed, cancelled, and timed-out work does not commit a partial assistant turn. Existing safe legacy JSONL checkpoints may be validated and reclaimed by compatibility cleanup, but they are never resumed as execution context and new tasks create none.

Web-enabled work retains the application pipeline's privacy boundary and does not gain a Pi session or a model-controlled outbound tool. The full product conversation remains visible and durable while the server remains responsible for what bounded context enters a generation request.

Task status, pipeline progress, usage, and completion are exposed through JSON and SSE. Generated deltas follow the existing task output path, and citation/link finalization remains server-owned. External anchors are created from successfully read source IDs by server code, and the assistant renderer unwraps any other anchor. Active task state is in memory, while committed product conversation turns are durable. An in-flight task does not automatically continue across a service-process restart. Raw search payloads, fetched pages, and hidden model reasoning are not product conversation messages.

## Confirmed write path

Diary, plan, and scratch-note generation creates a private draft outside the Vault. A save request is accepted only after the server revalidates the authenticated owner, selected knowledge base, permitted destination directory, filename, symbolic-link boundary, draft expiry, and expected target hash.

The service writes a temporary file in the destination directory and atomically renames it. Before replacing an existing diary or plan, it preserves and verifies a recovery preimage. There is no distributed transaction with an external sync process, so independent backups and conflict monitoring remain necessary.

## Deliberate scope

- One administrator identity, not RBAC or multi-tenant isolation.
- Local filesystem Vaults, not a database-backed document store.
- No model-controlled shell, general browser, or arbitrary file API.
- No automatic restore or destructive uninstall workflow.
- No implemented Self-hosted LiveSync materializer.
- Optional Obsidian Headless and any other sync engine remain separate trust boundaries.

See [data flow](data-flow.md), [security](security.md), and [deployment](deployment.md) for operational consequences.
