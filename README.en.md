# Second Mind

[简体中文](README.md) · [Website](https://kygoyuan2004.github.io/Second-Mind/) · [Windows](docs/quickstart-windows.md) · [macOS](docs/quickstart-macos.md) · [Linux](docs/quickstart-linux.md) · [Pi Agent migration and operations](docs/pi-agent-migration.md) · [Claude Code assisted installation](docs/claude-code-install.md) · [Security](docs/security.md)

[![CI](https://github.com/kygoyuan2004/Second-Mind/actions/workflows/ci.yml/badge.svg)](https://github.com/kygoyuan2004/Second-Mind/actions/workflows/ci.yml)
[![Pages](https://github.com/kygoyuan2004/Second-Mind/actions/workflows/pages.yml/badge.svg)](https://github.com/kygoyuan2004/Second-Mind/actions/workflows/pages.yml)

Second Mind is a single-administrator, self-hosted knowledge workbench for local Obsidian Vaults. It combines keyword and optional vector retrieval, cited answers, feedback-driven research, date-bounded learning reviews, conversation continuity, and review-before-write diary, plan, and scratch-note workflows. The administrator brings the model, search, and embedding services. With no LLM configured, the app can still start, authenticate, manage knowledge bases, and perform BM25 keyword search.

![Second Mind showing a cited answer from deterministic synthetic fixture data](docs/assets/second-mind-qa.png)

> The six UI images in this README load the current production front end on an isolated loopback service and connect it to a deterministic synthetic fixture API supplied by the capture script. They do not come from a complete production service instance, read a real Vault, or call a real or paid provider.

## Open the sign-in page in three steps

Install Git, then install and start Docker. The installer asks only for a knowledge-base directory, an administrator password, and a port. It does not require Node.js or OpenSSL on the host, and it does not require hand-editing JSON.

Linux or macOS:

```bash
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
./install.sh
```

Windows PowerShell with Docker Desktop using the WSL2 backend and Linux containers:

```powershell
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer first tries `ghcr.io/kygoyuan2004/second-mind:latest` for `linux/amd64` or `linux/arm64`, then builds from the checked-out source if the pull fails. It never stops a process that owns the requested port. Choose another port instead. When setup completes, open the loopback URL printed in the terminal and sign in as `admin`.

Platform details and troubleshooting:

- [Windows 10/11](docs/quickstart-windows.md)
- [macOS on Intel or Apple Silicon](docs/quickstart-macos.md)
- [Linux on amd64 or arm64](docs/quickstart-linux.md)

## What is implemented

| Area | Current behavior |
|---|---|
| Multiple knowledge bases | Stable IDs, names, enabled/default state, bounded mounts, a workbench selector, and an administrator registry |
| Isolation | Separate indexes, conversations, drafts, recovery copies, and audit records for each base; cross-base task, conversation, and draft IDs fail |
| Retrieval | Chinese-aware BM25; optional OpenAI-compatible or DashScope embeddings; hybrid RRF; explicit fallback when semantic retrieval is unavailable |
| Answers | Embedded Pi Agent `0.85.1` chooses bounded search and original-note reads from scoped tool results; citations use concrete Vault-relative paths |
| Learning reviews | [A fixed date range, paginated date-record inventory, and batched verification](docs/learning-review.md); plans and completed work remain distinct, with actual coverage gaps reported |
| Web supplement | Explicitly enabled per conversation; Alibaba Model Studio WebSearch MCP or Tavily REST; safe page reading with Vault-only fallback |
| Conversations | Refresh recovery; child conversations when model, effort, or web settings change; Normal and Deep may switch inside one conversation |
| Writes | Diary, plan, and scratch-note generation; editable Markdown preview; explicit confirmation; path and conflict checks; recovery copies |
| Rendering | Sanitized Markdown, code blocks, tables, and inline or block KaTeX |
| Providers | Alibaba Model Studio, DeepSeek, GLM, Kimi, and Custom; at most three enabled models; keys are never returned |
| Operations | Docker Compose, health checks, `doctor`, `status`, `logs`, `update`, `backup`, and a multi-architecture GHCR workflow |

This is not a multi-tenant SaaS product or a general host agent. The embedded Pi Agent receives only user-, knowledge-base-, and snapshot-scoped knowledge tools. It has no shell or arbitrary filesystem/write access, loads no host Pi/Claude configuration or Vault extension, and receives optional web tools only after the user explicitly enables networking. The SDK ships in the npm dependency lock and Docker image; users do not install a Pi CLI.

## Current interface

| Execution trace | Provider configuration |
|---|---|
| ![Observable retrieval, verification, and generation stages](docs/assets/second-mind-execution.png) | ![Administrator page showing fictional providers, models, and configured status](docs/assets/second-mind-provider-config.png) |
| **Retrieval and generation over deterministic fixture Q&A** | **Fictional providers; no screenshot key is displayed or stored** |

| Diary preview | Plan preview |
|---|---|
| ![A diary draft supplied by the synthetic fixture API and rendered by the production front end](docs/assets/second-mind-diary.png) | ![A plan draft supplied by the synthetic fixture API and rendered by the production front end](docs/assets/second-mind-plan.png) |
| **Still outside the Vault and not yet confirmed** | **Still outside the Vault and not yet confirmed** |

![Second Mind knowledge workbench at a 360 pixel viewport](docs/assets/second-mind-mobile.png)

## How multiple knowledge bases work

The first installation may point to one Vault or to a parent containing several Vaults. Parent mode discovers only immediate child directories that contain `.obsidian`. Whether discovered or registered later, every knowledge-base root must contain an actual, non-symlink `.obsidian` directory. The administrator can then add, rename, disable, or choose a default knowledge base using paths relative to mounts authorized at startup.

Every knowledge API request is bound to a `knowledgeBaseId` and the current revision:

- Search, preview, citations, conversations, tasks, SSE, drafts, and confirmed writes use one knowledge-base context.
- A task created in base A remains in A while the browser switches to base B.
- Old responses or SSE events from A cannot update the interface after a switch to B.
- A broken or failed index does not prevent another healthy base from starting.
- Absolute paths, symbolic links, traversal, duplicate or nested Vaults, and overlap with private application state are rejected.
- Removing a registry entry does not delete notes, indexes, conversations, or drafts.

Saving the registry requires the administrator password again and the revision returned by the last read. A concurrent save, or an affected base with an active task, causes a conflict instead of an overwrite. A private binding ledger permanently binds each stable ID to its first canonical Vault path; deletion and restart do not release the ID, and redirecting it to another path is rejected.

## Browser configuration and BYOK

After signing in, the administrator page configures these independently:

1. LLM provider, API Base, models, and five application-level reasoning tiers.
2. Optional WebSearch provider and its own key.
3. Optional embedding provider, model, and its own key.

LLM, WebSearch, and embedding credentials never fall back to one another. APIs return a `configured` boolean, not the key. The browser does not put keys in localStorage, sessionStorage, URLs, or cookies. Changing a provider destination requires supplying the credential for that destination again.

Model validation and embedding builds may cost money, so they run only after explicit administrator confirmation. Saving a model must prove a real model → tool → result → model round trip; a model that only returns text is not Pi-compatible. The first Q&A after a restart also verifies a binding that has not yet been proven in that process. Startup, sign-in, configuration refresh, and BM25 retrieval do not call a paid provider. A running task keeps the model, search, and index snapshot it acquired at creation; later saves affect new tasks.

## Pi Agent, retrieval, and conversations

Normal and Deep both run the embedded Pi tool loop. The model chooses among bounded `list_vault`, `search_text`, `search_knowledge`, `read_note`, `resolve_note_reference`, `list_date_records`, and `get_reading_coverage` calls after seeing each result; Deep provides a larger bounded research budget. Search results are discovery hints. Material Vault claims require `read_note` verification against the pinned snapshot and content hash, long notes can be continued by line/column, and `get_reading_coverage` exposes exact covered ranges and remaining gaps. Unsupported conclusions must identify insufficient or uncovered evidence.

Web search is off by default and is available only to eligible Q&A. When explicitly enabled, the Agent must finish any necessary Web search and page reading before reading private Vault content. After any Vault tool returns a result, every Web search/read exit closes permanently for that task. To stop text from an earlier private turn becoming a later search query, every Web-enabled Pi turn loads only the current request into the Agent and neither resumes nor bootstraps earlier conversation text; restate any necessary public context in the current request. `web_read` accepts only an exact HTTPS URL returned by that same task's search and retains the existing DNS/IP, redirect, media type, size, timeout, and concurrency checks. Learning reviews receive no web tools. The model never receives a general MCP client, browser, or fetch tool.

Pi answer text remains buffered until the server has verified original-note citations and external links. SSE still carries session, tool, usage, and heartbeat progress, but the browser renders only terminal validated Markdown. External evidence is cited with opaque IDs; only the server mints clickable HTTPS anchors, and the assistant renderer unwraps every other generated Markdown, HTML, GFM autolink, or mail link.

The browser persists only an opaque conversation ID for the current user and knowledge base. Changing the selected model, reasoning effort, or web option makes the next message a child conversation and copies at most five complete question-and-answer turns. Product history remains authoritative. Each request uses a disposable Pi JSONL branch under `DATA_DIR/pi-sessions`; only a sanitized, product-history-matched checkpoint is attached on successful commit, while failed branches are removed. Raw pages, search snippets, and hidden reasoning are not stored as product conversation messages.

## Review before write

Diary, plan, and scratch-note content is first generated into a private draft directory outside the Vault. The user reviews the Markdown, destination path, and attachments, then explicitly confirms. The server rechecks directories, symbolic links, destination hashes, and concurrent changes before atomically replacing a file. A verified recovery copy is retained before an existing diary or plan is replaced.

Output checks, filename checks, and extension checks do not prove an attachment is safe. Do not open untrusted attachments in desktop software, and do not treat sync as backup.

## Architecture

```mermaid
flowchart LR
  B[Browser and signed-in session] --> R[Knowledge-base registry]
  R --> A[Base A context]
  R --> C[Base B context]
  A --> IA[Independent index and history]
  C --> IC[Independent index and history]
  IA --> Q[Pi Agent scoped tool loop and optional WebSearch]
  IC --> Q
  Q --> L[Task-pinned LLM lease]
  L --> O[Streamed answer or private draft]
  O --> W{User confirms write?}
  W -->|No| P[Keep previewing]
  W -->|Yes| V[Path, conflict, and atomic-write checks]
```

**This is an architecture diagram, not a product screenshot.** See [the architecture guide](docs/architecture.md) and [data-flow guide](docs/data-flow.md) for components and trust boundaries.

## Privacy and remote data boundaries

| Destination | Contacted only when | Data that can be sent |
|---|---|---|
| LLM | A user starts generation and a model is configured | The question, recent complete turns, and bounded tool definitions and results; tool results may include selected original-note and text-attachment excerpts |
| Embedding | An administrator confirms a build, or semantic retrieval uses an active vector index | Indexable text chunks or a search query |
| WebSearch | The current Q&A conversation explicitly enables it and no Vault tool has returned a result | A bounded query generated by the Agent for that task |
| Safe page reader | The same task's WebSearch returned the exact HTTPS URL | That validated URL; extracted text may then enter delimited model context |

Vaults, conversations, indexes, drafts, recovery copies, audits, and credentials stay in local storage by default. If you choose a remote provider, shared data is governed by that provider's retention, region, account, and contractual terms. Use separate, least-privilege, replaceable keys and bounded spending limits.

Self-hosted does not mean every operation is local-only. Enabling a remote LLM, embedding service, WebSearch, or page reader sends the corresponding selected content off-host. If content must never leave the host, use a browser on that host, use only compatible providers running there, disable web and remote sync, and keep backups in controlled local storage.

Compose publishes only to `127.0.0.1` by default. For remote access, use a reviewed private network or an HTTPS reverse proxy. Do not expose the application port directly to the public internet. See [security](docs/security.md) and [networking](docs/networking.md).

## Backup, update, and removal

```bash
./install.sh doctor
./install.sh status
./install.sh logs --no-follow --tail 200
./install.sh backup
./install.sh update
```

PowerShell uses the same subcommands. On a host that restricts script execution, keep the process-scoped override, for example `powershell -ExecutionPolicy Bypass -File .\install.ps1 doctor`.

Each installation has its own Compose project, private configuration directory, and data volume. `backup` copies the Vault, runtime data, and configuration and writes SHA-256 inventories. It is a live copy, not an atomic point-in-time snapshot across application and sync writes, and it does not automatically collect an independent sync engine's private volumes, account state, or remote state. Stop the instance and external sync before a strict snapshot, then test restoration in an isolated directory.

There is no automatic restore or permanent uninstall command. For ordinary removal, run `docker compose down` for the exact instance without `--volumes`, preserving the Vault, credentials, conversations, indexes, and backups. Before permanent deletion, make and verify a backup, then inspect each exact named volume and configuration directory. Never use a broad recursive deletion against a user directory or Vault.

## Known limitations

- One administrator account only. There is no multi-user authorization, tenant isolation, or external identity login.
- The application reads filesystem Vaults. Self-hosted LiveSync is not implemented. Obsidian Headless is an optional sync boundary that needs separate review.
- The standard image omits `bwrap` and `pdftotext`, so web-page PDF reading is unavailable by default and never silently falls back to unsandboxed parsing. Persisting a confirmed PDF attachment is not PDF-content understanding.
- Windows Service, macOS LaunchDaemon, Credential Manager, and Keychain integration are not implemented.
- Installer backups do not preserve every platform ACL or extended attribute and are not atomic across the app and a sync engine.
- Docker `--mount` cannot reliably represent a host path containing a comma. Spaces, non-ASCII text, and Windows drive-letter paths are covered by installer tests.
- The Linux quick installer targets a conventional rootful Docker Engine. Rootless Docker and SELinux-enforcing hosts need an administrator-designed UID mapping, volume ownership, and bind-mount relabeling; the installer does not silently alter those boundaries.
- `update` preserves data and configuration but has no automatic image rollback. Critical deployments should pin an immutable tag/digest, retain the previous image, and validate upgrades against a backup copy.
- A `knowledgeBaseId` is bound to its canonical path. If a host operator replaces that exact path with different Vault contents, use a new ID so retained private state from the former Vault cannot reopen.
- Model compatibility depends on the exact endpoint and model completing the Pi tool round-trip probe. A compatible protocol label alone is not sufficient.

## Development and tests

Automated tests use temporary directories, synthetic data, and mock providers. They do not call real paid APIs.

```bash
npm ci
npm run check
npm test
npm run security:scan
npm run security:history
npm run site:check
npm run verify
```

Release screenshots use Chrome for Testing `134.0.6998.88` as the reproducible capture baseline, not as a general browser-compatibility limit. CI verifies the official Linux archive with SHA-256 `99f05b875209cdbf7490dc431a525fd373788521fb9e8aca68c761fc5fc400e5`:

```bash
npm run docs:screenshots -- --chrome /path/to/chrome
npm run security:ocr
```

The capture tool connects only to its own isolated loopback service. It loads the production front end in a browser while an in-script deterministic synthetic fixture API supplies session, knowledge-base, task, draft, and provider state. It does not start the complete Second Mind service, read a real Vault, or call a real provider. It rejects remote requests, emits three `1440x1050`, two `1280x960`, and one `360x800` PNG at fixed viewports, strips `tEXt`, `zTXt`, `iTXt`, `tIME`, `eXIf`, and `pHYs` metadata, and requires the OCR check before publication.

Linux release gates also cover Compose configuration, image build, isolated container liveness and readiness, browser E2E, KaTeX regressions, image history and environment inspection, and screenshot OCR and metadata checks.

## Documentation

- [Pi Agent migration, deployment, and rollback](docs/pi-agent-migration.md)
- [Claude Code assisted installation](docs/claude-code-install.md)
- [Configuration and providers](docs/configuration.md)
- [HTTP API](docs/api.md)
- [Architecture](docs/architecture.md)
- [Data flow](docs/data-flow.md)
- [Deployment](docs/deployment.md)
- [Security](docs/security.md)
- [Remote access](docs/networking.md)
- [Vault sync boundary](docs/sync.md)

## License

[MIT](LICENSE)
