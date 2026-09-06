# Vault synchronization

Second Mind reads ordinary files from local Vault directories. It does not upload, download, merge, or reconcile a Vault itself. `SYNC_PROVIDER` and `SYNC_DISPLAY_NAME` are descriptive status fields only. An independent process must materialize any remotely synchronized files.

Supported labels are:

| Value | Meaning |
|---|---|
| `filesystem` | No sync process is managed; Second Mind reads local files |
| `obsidian-headless` | An optional sidecar or host service runs Obsidian Headless |
| `external` | Another operator-managed process owns synchronization |

Never run two sync engines against the same local Vault. Sync is not a point-in-time snapshot and is not a substitute for tested backup.

## Multi-knowledge-base boundary

Each registered knowledge base has an independent local root, index, conversation store, drafts, recovery copies, and audit log. The registry does not create one remote-sync identity per base and does not manage sync credentials.

If the application mount is a parent containing several Vaults, the operator must design and test synchronization for each child. Do not assume that a tool pointed at the parent will preserve separate Vault identity, hidden configuration, encryption, conflict, or delete semantics.

The supplied `compose.obsidian-sync.yaml` is designed for one selected Vault root per application instance. It mounts the selected host path at `/vault` and runs one continuous client. Do not apply that overlay to a multi-Vault parent as if it were multi-base orchestration. Use separate reviewed sync clients, or separate Second Mind instances, when each Vault needs an independent remote link.

## Optional Obsidian Headless boundary

Obsidian publishes a command-line sync client. Its requirements, commands, licensing, and support status can change. Review the current [official Headless Sync documentation](https://obsidian.md/help/sync/headless), package metadata, account requirements, encryption behavior, and terms immediately before deployment.

This repository intentionally:

- excludes the package from the main Second Mind image;
- provides only a local-build Docker recipe and optional Compose overlay;
- marks the resulting image local and configures `pull_policy: never`;
- keeps Headless authentication/link state in volumes not mounted by the application;
- gives the sync sidecar no LLM, WebSearch, or embedding credentials;
- documents that the locally built sidecar image must not be pushed or attached to a release.

The sidecar still has network access and full read/write access to the selected Vault because synchronization requires both. Treat it as a high-trust component.

## Single-client and backup rules

Before linking a remote Vault, changing encryption, changing sync products, or relinking a device:

1. stop other sync clients for the same local directory;
2. create and verify an independent backup;
3. test with a copy of non-sensitive data;
4. confirm the remote/local direction and conflict policy;
5. start exactly one server-side continuous client;
6. monitor authentication, quota, encryption, conflict, and delete behavior.

Do not run desktop and Headless clients concurrently against the same local directory. Different personal devices may use the same remote service, but each local Vault directory should have one responsible sync engine.

## Local sidecar setup

The examples below reflect the repository's current wrapper. Confirm them against the official CLI before using a real account.

Build only the local sidecar:

```bash
docker compose \
  -f compose.yaml \
  -f compose.obsidian-sync.yaml \
  build obsidian-sync
```

Run interactive commands without placing account passwords, MFA codes, tokens, or encryption passwords in command arguments:

```bash
docker compose \
  -f compose.yaml \
  -f compose.obsidian-sync.yaml \
  run --rm --no-deps obsidian-sync login

docker compose \
  -f compose.yaml \
  -f compose.obsidian-sync.yaml \
  run --rm --no-deps obsidian-sync sync-list-remote
```

Use the official documentation and `ob --help` to link the selected `/vault` directory, choose a device name, configure encryption interactively, inspect status, and set conflict behavior. Do not guess flags from an older guide.

After the Vault is linked and a backup is available, start the application, file-backed secrets, and sidecar:

```bash
docker compose \
  -f compose.yaml \
  -f compose.secrets.yaml \
  -f compose.obsidian-sync.yaml \
  up -d --build
```

Inspect status without copying output into public logs:

```bash
docker compose \
  -f compose.yaml \
  -f compose.obsidian-sync.yaml \
  logs --follow obsidian-sync
```

Status and errors may contain account, device, remote Vault, or filesystem identifiers.

## Sidecar state and permissions

The optional overlay uses:

- the selected host Vault bind mounted read/write at `/vault`;
- `obsidian-sync-config` for the CLI home/config state;
- `obsidian-sync-vault-state` mounted at `/vault/.obsidian` for server-side link/device state;
- the configured non-root UID/GID;
- a read-only image filesystem, dropped capabilities, and private `/tmp`.

Because the `.obsidian` mount shadows that directory only inside the sidecar, server-side link state stays out of the application view and host Vault configuration. The application independently excludes `.obsidian` from indexing and reads.

The default container identity is `1000:1000`. A custom identity must be able to write the selected Vault and both private sidecar volumes. Prefer targeted ownership/ACL changes. Never grant world-writable mode or recursively change an unverified user directory.

Docker administrators can read the sidecar volumes and Vault. Restrict Docker access accordingly.

## Write conflicts

Second Mind prepares note changes in private draft storage and compares the target hash again at confirmation. Existing diary/plan replacement also creates a recovery preimage. These checks detect many concurrent edits, but there is no distributed transaction with a sync client.

For an important save:

1. wait for sync to become current;
2. generate and inspect the draft;
3. confirm one write;
4. wait for the sync client to upload it;
5. resolve any preserved conflict before continuing.

Prefer conflict-preserving behavior. Test how the chosen sync engine handles atomic renames, rapid edits, attachments, deletes, and hidden directories.

## Backup and removal

The Second Mind installer backup copies the selected Vault/Vault parent, application runtime data, deployment configuration, and application credentials. It does not automatically include every independent sync volume or remote recovery mechanism.

For point-in-time consistency, stop both the exact application instance and its sync clients before backup. Decide separately whether to back up sync authentication/link state into encrypted storage or to reauthenticate/relink during disaster recovery. Test that choice.

To revoke one sidecar, stop it and use the current official logout/unlink procedure with the same private volumes. Removing a named volume is destructive. Verify its exact Compose project and volume name, make a recoverable backup, and ensure no other instance uses it.

## Host service option

`deploy/systemd/obsidian-headless-sync.service.example` is a manual template for an operator-installed CLI. Replace every placeholder and use a dedicated service user plus mode-`0700` home/config directories. Run interactive login and link operations as that same identity with the same `HOME` and `XDG_CONFIG_HOME`.

Never put an account password, MFA value, access token, or Vault encryption password in the unit or environment file. The sync service needs full Vault write access; a native Second Mind service should still be restricted to its configured write directories where the host sandbox supports that policy.

## Other filesystem sync

Use `SYNC_PROVIDER=external` when another trusted process presents ordinary local files. The operator owns:

- authentication and encryption;
- path and permission design;
- atomic-replace and watcher compatibility;
- conflict, delete, and rename preservation;
- hidden configuration handling;
- network egress and logging;
- snapshots and restore tests.

Do not use an untested network filesystem whose rename, consistency, locking, inode, or notification semantics differ from a local filesystem.

## Self-hosted LiveSync status

Self-hosted LiveSync is not implemented. The repository has no CouchDB service, LiveSync credential loader, Setup URI handler, or supported materializer that turns its database into the ordinary per-base filesystem contract.

Adding it would require a separate reviewed materializer with isolated credentials, encryption handling, conflict/delete/attachment tests, and a prohibition on concurrent sync engines for the same Vault. The existence of a community project must not be presented as Second Mind support.

## Manual working copy beside a fixed benchmark

Use an independent working copy when the application needs current notes while a benchmark directory must stay frozen. `scripts/sync-vault-copy.mjs` is an offline, manually invoked source-to-copy publisher. It does not run Obsidian, a sync engine, a timer, or an embedding provider. It copies all ordinary files, including hidden ordinary files and attachments, and preserves file modification times. Hidden sync configuration is only copied as inert data; do not start another sync client on the copy. Any symbolic link, special file, read failure, or source change detected during staging stops publication.

Choose three disjoint directories: the read-only source Vault, a **new** working-copy path, and a private replica state directory outside all Vaults. Keep the fixed benchmark separate. Stop the Second Mind instance and every other writer of the working copy before each invocation; the publication replaces the complete target directory, so open filesystem watchers must also be restarted.

```bash
node scripts/sync-vault-copy.mjs \
  --source /srv/notes/source-vault \
  --target /srv/notes/working-copy \
  --state-dir /srv/second-mind/data/replica

node scripts/sync-vault-copy.mjs \
  --state-dir /srv/second-mind/data/replica --status
```

The first copy requires an absent target. Subsequent invocations require the same source, target, and state directory. Each update stages and hashes the complete source, checks the source a second time, verifies staged content, and checks that the target has not changed locally. Source additions, edits and deletions are published together. If the copy contains a locally added, modified or deleted file, **the whole update stops** with `REPLICA_LOCAL_CONFLICT` and relative paths; it never silently discards application-authored notes. Back up and reconcile those local changes explicitly before retrying. A successful replacement preserves the previous copy in a sibling `.working-copy.replica-recovery-*` directory outside the active Vault. Keep that directory until the new copy and index pass acceptance checks.

The private `vault-replica.json` manifest contains the source and target binding, per-file SHA-256 values, original modification times, the published version and last successful update time. `--status` returns only the public version, time, file count and index status. Application integrations must call `inspectVaultReplica({ stateDir, targetRoot: currentKnowledgeBaseRoot })`: a different target returns an unconfigured status with no version or timestamp, so a globally configured state directory cannot leak one knowledge base's replica status into another. Handle unreadable or invalid state as unavailable sync information without failing the knowledge-base status endpoint. A stopped or failed copy leaves the previous successful version unchanged. An abrupt process stop can leave `vault-replica.lock` and `vault-replica-pending.json`; keep the application stopped, inspect the private journal, and restore the journal's recovery directory and matching manifest backup before clearing these recovery markers. Do not delete markers and rerun without reconciling the target and manifest.

### Switch the application and rebuild its active index

Set `SYNC_REPLICA_STATE_DIR` to the matching private `--state-dir`. The authenticated knowledge status endpoint and page footer then show the last successful full copy time and whether that copy still needs indexing. A filesystem connection or a successful file copy alone is not evidence that retrieval is current. Refreshes are manual; this option does not install a timer or start an Obsidian client.

Back up the exact instance's runtime data, deployment settings, index slots, active embedding manifest and conversations before changing its Vault root. In a direct single-Vault deployment, retain the conversation/data paths and model configuration, then change only the private Vault setting to the working copy. Historical citations use relative paths and remain available. Pending drafts still compare their source hash before saving and can require regeneration when their source changed.

Managed multiple-Vault deployments bind each `knowledgeBaseId` to its original canonical root. They must add a new knowledge-base ID and explicitly migrate the intended conversation state; do not remove the binding ledger to reuse an ID for a different root.

An active embedding slot is selected by `embedding-active.json`, which may point outside the ordinary `INDEX_DIR`. **`npm run index` currently rebuilds the configured base `INDEX_DIR`; it does not resolve the active slot manifest.** Merely restarting an activated slot also does not guarantee an immediate full rebuild. Resolve the active profile through `resolveActiveEmbedding`, open its returned `indexDir` against the new working-copy root, and explicitly await `index.rebuild({ verifyHashes: true })`, or use the existing managed validate/build/activate workflow. The former reuses unchanged file vectors; a fresh managed candidate may embed all files. Do not rebuild the wrong index and then mark the replica ready.

Before opening the application to traffic, compare its actual root and indexed paths against the published copy, confirm its generation, and test recent note reads, search and restored conversation citations. Then acknowledge the **exact** published version and verified generation:

```bash
node scripts/sync-vault-copy.mjs \
  --state-dir /srv/second-mind/data/replica \
  --version PUBLISHED_SHA256_VERSION \
  --index-generation VERIFIED_INDEX_GENERATION
```

Until this acknowledgement, the copy reports `indexPending: true`. A version mismatch refuses acknowledgement. This workflow is manual; the last successful update time is a snapshot time and must not be presented as live synchronization.
