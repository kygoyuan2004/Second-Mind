# Deployment guide

Second-Mind can run as a hardened Docker Compose service or as a dedicated
systemd service. The application requires Node.js 22 or newer. A model endpoint
is required; embeddings are optional and lexical retrieval remains available
when `EMBEDDING_PROVIDER=disabled`.

This guide deliberately keeps the application on loopback by default. Read
[networking.md](networking.md) before making it reachable from another device.

## Docker Compose

The public product name is Second-Mind. Existing technical identifiers such as
the `vaultmind:local` image tag, `vaultmind-data` volume, and `VAULTMIND_*`
Compose variables are intentionally retained for upgrade compatibility. They
do not change the browser-visible product name, and renaming an existing volume
without migrating its data can make private state appear to be missing.

### 1. Prepare host directories

Choose a real Obsidian Vault outside the repository. The repository's `vault/`
directory is suitable only for a disposable demonstration.

```bash
install -d -m 0750 /srv/vaultmind/vault
install -d -m 0700 ./secrets
```

The container runs as UID/GID `1000:1000` by default. Either give that identity
read/write access to the Vault, or set `VAULTMIND_UID` and `VAULTMIND_GID` to
the Vault owner's numeric IDs. The named `vaultmind-data` volume is initialized
from an image directory owned by `1000:1000`; if you select another identity,
provision that volume for the same numeric UID/GID before starting the app.
Keeping UID 1000 and granting a narrow host ACL is usually simpler. Do not solve
permission errors with mode `0777`.

For example, after building `vaultmind:local`, an operator intentionally using
numeric identity `1234:1234` can initialize the application volume before the
first `up` (replace the example IDs with the Vault owner's IDs):

```bash
docker volume create vaultmind-data
docker run --rm --user 0 --entrypoint chown \
  -v vaultmind-data:/state \
  vaultmind:local -R 1234:1234 /state
```

If the optional Headless sidecar is enabled, its two private named volumes must
be provisioned for that same identity too; follow the UID/GID section in
[sync.md](sync.md) before interactive login.

Create four local secret files. The provider files may be empty when a local
endpoint does not require authentication.

```bash
umask 077
openssl rand -base64 24 > ./secrets/admin_password
openssl rand -hex 32 > ./secrets/session_secret
install -m 0600 /dev/null ./secrets/llm_api_key
install -m 0600 /dev/null ./secrets/embedding_api_key
```

Write provider keys with a local editor that does not create world-readable
backup files. Never paste a secret into `compose.yaml`, a command-line option,
an issue, or a screenshot.

### 2. Set non-secret Compose values

Docker Compose reads a repository-local `.env` for interpolation. Keep secrets
in the files above; use `.env` only for values such as these:

```dotenv
VAULT_HOST_PATH=/srv/vaultmind/vault
VAULTMIND_BIND_IP=127.0.0.1
VAULTMIND_PORT=8787
TIMEZONE=Asia/Shanghai

LLM_PROVIDER=openai-compatible
LLM_API_BASE=http://host.docker.internal:11434/v1
LLM_MODEL=qwen3:8b

EMBEDDING_PROVIDER=disabled
```

`host.docker.internal` is mapped to the Docker host on Linux by the Compose
file. For a remote provider, use an `https://` endpoint and keep
`ALLOW_INSECURE_PROVIDER_HTTP=false`. Plain HTTP for a provider on a separate
host or Docker service requires an explicit opt-in and a trusted private
network.

### 3. Build and start

Use the secrets overlay for normal deployments:

```bash
docker compose \
  -f compose.yaml \
  -f compose.secrets.yaml \
  up -d --build
```

The base Compose file also accepts `ADMIN_PASSWORD`, `SESSION_SECRET`,
`LLM_API_KEY`, and `EMBEDDING_API_KEY` from the process environment for a short
local test. File-backed secrets are preferred. Startup fails closed when the
administrator password is shorter than 12 characters or the session secret is
shorter than 32 characters.

Check health without opening a public port:

```bash
docker compose ps
curl --fail http://127.0.0.1:8787/health/live
curl --fail http://127.0.0.1:8787/health/ready
```

`live` verifies the HTTP process. `ready` also verifies that retrieval has
initialized; a large Vault can remain in `starting` state while its first index
is built.

The runtime container:

- runs as a non-root UID;
- drops every Linux capability and enables `no-new-privileges`;
- uses a read-only root filesystem and a small, non-executable `/tmp`;
- writes application state only to the `vaultmind-data` volume;
- bind-mounts the selected Vault and publishes port 8787 on `127.0.0.1` only.

Application policy restricts writes to `DIARY_DIR`, `PLAN_DIR`, and
`SCRATCH_DIR`. The Docker bind mount itself is read/write, so the host account
and its backups remain part of the security boundary.

### 4. Upgrade and roll back

Back up first, then rebuild from a reviewed revision:

```bash
docker compose pull --ignore-buildable
docker compose \
  -f compose.yaml \
  -f compose.secrets.yaml \
  up -d --build --remove-orphans
```

The current defaults write new notes below `Second-Mind/Diary`,
`Second-Mind/Plans`, and `Second-Mind/Inbox`. An older deployment that used the
former defaults must choose one explicit upgrade path after taking a backup:

- keep using the old locations by setting `DIARY_DIR=VaultMind/Diary`,
  `PLAN_DIR=VaultMind/Plans`, and `SCRATCH_DIR=VaultMind/Inbox`; or
- stop Second-Mind and every Sync writer, move or merge the old directories
  into `Second-Mind/`, update configuration, verify ownership and conflicts,
  and only then restart the services.

Second-Mind never migrates Vault notes automatically. Do not leave this choice
implicit, because doing so can split old and newly generated notes across both
directory trees.

Pin the Node base image by digest and review dependency changes for a
reproducible production deployment. Keep the previous application image until
the new image passes both health checks and a test query.

## Persistent data and backup

Treat these locations as separate backup sets:

| Data | Default location | Backup requirement |
|---|---|---|
| Obsidian notes and attachments | Host path in `VAULT_HOST_PATH` | Required |
| Conversations, drafts, recovery preimages, audit log, index | `vaultmind-data` volume | Required except a disposable/rebuildable index |
| Deployment secrets | Local `secrets/` or a secret manager | Required, encrypted |
| Obsidian Headless credentials/state | Optional named volumes documented in [sync.md](sync.md) | Protect or recreate deliberately |

Sync is not a backup. Keep versioned snapshots on storage independent from the
host and from the Sync provider. For the cleanest point-in-time snapshot, stop
the application and optional Sync sidecar, snapshot the Vault and data volume,
then restart them. Periodically restore into an isolated directory and verify
that notes, attachments, conversations, and authentication all work.

The index can be rebuilt from the Vault, but conversations, drafts, and audit
records cannot. Decide retention and backup policy accordingly.

### Recovering a replaced note

A successful update of an existing diary or plan returns a `recoveryId`. The
corresponding directory contains `metadata.json` (original relative path and
hash) and `note.md` (the verified preimage). Recovery copies expire after
`RECOVERY_RETENTION_DAYS` and do not replace normal backups.

For Docker Compose, copy a candidate out without changing the volume:

```bash
docker compose cp app:/app/data/recovery/RECOVERY_ID/metadata.json ./recovery-metadata.json
docker compose cp app:/app/data/recovery/RECOVERY_ID/note.md ./recovered-note.md
sha256sum ./recovered-note.md
```

For a native deployment, read the same two files below `RECOVERY_DIR`. Verify
that the checksum equals `sourceHash` in the metadata. Before restoring, stop
Second-Mind and the Sync materializer, make a separate copy of the current target
note, and inspect both versions. Then place the selected version at the exact
`targetRelative` path recorded in metadata and restart Sync followed by
Second-Mind. Never restore blindly while a sync engine is writing the Vault.

## systemd deployment

The files in `deploy/systemd/` are templates, not install scripts. Replace every
`@PLACEHOLDER@`; a remaining placeholder is a deployment error. Use absolute
paths without whitespace for path placeholders so systemd can parse its
space-separated path directives without deployment-specific escaping.

Recommended layout:

```text
/opt/vaultmind/                    application, root-owned and read-only
/var/lib/vaultmind/                runtime state, service-owned
/etc/vaultmind/vaultmind.env       non-secret environment, mode 0600
/etc/vaultmind/secrets/            individual service-readable secret files
/srv/vaultmind/vault/              Vault shared with the selected sync process
```

These filesystem and service names are legacy deployment identifiers retained
so an upgrade can reuse established units, permissions, backups, and paths.
They may be changed deliberately for a new installation, but all rendered
systemd placeholders and operational commands must then use the same names.

Keep the environment file root-owned at mode `0600`. Secret files must also be
readable by the unprivileged service: use root ownership, the dedicated service
group, and mode `0640`, or service ownership and mode `0600`. They must never be
group/other writable. Create the referenced LLM and embedding key files even
when a local provider needs no key; an empty, correctly permissioned file is
valid.

Create a dedicated unprivileged service account. Pre-create the configured
diary, plan, and scratch directories and grant the service account write access
only to them. The example unit exposes the rest of the Vault read-only through
systemd's mount namespace and sets `VAULT_AUTO_CREATE_PATHS=false`.

Install production dependencies as an administrator in `/opt/vaultmind`, run
the static vendor sync during deployment, then make the tree non-writable by
the service account. Install the rendered unit in `/etc/systemd/system/` and
validate it before enabling:

```bash
sudo systemd-analyze verify /etc/systemd/system/vaultmind.service
sudo systemctl daemon-reload
sudo systemctl enable --now vaultmind.service
sudo systemctl status vaultmind.service
```

Keep `HOST=127.0.0.1`. Put Caddy, Nginx, or Tailscale Serve in front of the
service rather than changing the application to listen on every interface.

## Configuration reference

All paths below are resolved relative to the project root unless they are
absolute.

### Core, authentication, and state

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME` | `Second Mind` | Display name |
| `VAULT_LABEL` | `My Obsidian Vault` | Non-secret Vault label shown in the UI |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Application listener |
| `TIMEZONE` | `UTC` | IANA time zone used for dated notes |
| `TRUST_PROXY` | `false` | Trust the first `X-Forwarded-For` value; enable only behind an exclusive trusted proxy |
| `ADMIN_USERNAME` | `admin` | Single administrator username |
| `ADMIN_PASSWORD` or `_FILE` | required | Administrator password, minimum 12 characters |
| `SESSION_SECRET` or `_FILE` | required | Session-signing secret, minimum 32 characters |
| `SESSION_TTL_SECONDS` | `43200` | Session lifetime, 300–2,592,000 seconds |
| `SECURE_COOKIE` | `false` | Add the cookie `Secure` attribute; required behind HTTPS |
| `DATA_DIR` | `./data` | Private mutable state root |
| `INDEX_DIR` | `DATA_DIR/index` | Retrieval index |
| `DRAFT_DIR` | `DATA_DIR/drafts` | Unconfirmed drafts and temporary attachments |
| `RECOVERY_DIR` | `DATA_DIR/recovery` | Hash-verified preimages of replaced notes |
| `CONVERSATION_FILE` | `DATA_DIR/conversations.json` | Conversation history |
| `AUDIT_FILE` | `DATA_DIR/audit.jsonl` | Security and write audit events |
| `PUBLIC_DIR` | `./public` | Static web assets |

### Vault

| Variable | Default | Purpose |
|---|---|---|
| `VAULT_PATH` | `./vault` | Local filesystem Vault root |
| `VAULT_AUTO_CREATE_PATHS` | `true` | Create the three writable note directories inside an existing Vault root |
| `DIARY_DIR` | `Second-Mind/Diary` | Diary write allowlist |
| `PLAN_DIR` | `Second-Mind/Plans` | Plan write allowlist |
| `SCRATCH_DIR` | `Second-Mind/Inbox` | Inbox/scratch write allowlist |
| `DIARY_TEMPLATE` / `PLAN_TEMPLATE` | empty | Optional relative template files inside the Vault |
| `VAULT_EXCLUDED_PATHS` | hidden/config directories | Comma-separated directory denylist; retain `.obsidian` and `.livesync` |

### Model and embeddings

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `openai-compatible` | `openai-compatible` or `anthropic` |
| `LLM_API_BASE` | local OpenAI-compatible URL | Provider base URL |
| `LLM_API_KEY` or `_FILE` | empty | Provider credential |
| `LLM_MODEL` | provider-dependent | Model identifier |
| `LLM_TIMEOUT_MS` | `120000` | Request timeout |
| `LLM_MAX_OUTPUT_TOKENS` | `3000` | Maximum generated tokens |
| `LLM_TEMPERATURE` | `0.2` | Sampling temperature, 0–2 |
| `EMBEDDING_PROVIDER` | `disabled` | `disabled`, `openai-compatible`, or `dashscope` |
| `EMBEDDING_API_BASE` / `EMBEDDING_ENDPOINT` | provider-dependent | Base URL or full override |
| `EMBEDDING_API_KEY` or `_FILE` | LLM key fallback | Separate least-privilege key is recommended |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model identifier |
| `EMBEDDING_DIMENSIONS` | `768` | Must exactly match provider output |
| `EMBEDDING_BATCH_SIZE` | `16` | Documents per embedding request |
| `EMBEDDING_TIMEOUT_MS` | `30000` | Embedding request timeout |
| `ALLOW_INSECURE_PROVIDER_HTTP` | `false` | Explicitly allow non-loopback provider HTTP |

Changing the embedding model or dimensions requires rebuilding the index.

### Retrieval, limits, and sync label

| Variable | Default | Purpose |
|---|---|---|
| `RAG_TOP_K` | `8` | Retrieved passages supplied to the model |
| `RAG_MAX_CONTEXT_CHARS` | `30000` | Maximum retrieved context size |
| `DEEP_TASKS_ENABLED` | `true` | Publish provider-neutral Deep Retrieval for Q&A |
| `RAG_DEEP_TOP_K` | `16` | Per-search and final source-file ceiling for Deep Retrieval |
| `INDEX_WATCH` | `true` | Watch the Vault for changes |
| `INDEX_RECONCILE_SECONDS` | `300` | Full reconciliation interval |
| `MAX_JSON_BODY_BYTES` | `25165824` | Maximum JSON request body |
| `MAX_ATTACHMENT_COUNT` | `8` | Attachments per task |
| `MAX_ATTACHMENT_BYTES` | `5242880` | Bytes per attachment |
| `MAX_ATTACHMENT_TOTAL_BYTES` | `15728640` | Aggregate attachment bytes |
| `RECOVERY_RETENTION_DAYS` | `30` | Retention for verified note preimages |
| `SYNC_PROVIDER` | `filesystem` | `filesystem`, `obsidian-headless`, or `external`; this is status/configuration, not an embedded client |
| `SYNC_DISPLAY_NAME` | provider-dependent | Human-readable sync label |

Read [data-flow.md](data-flow.md) before selecting a remote provider.
