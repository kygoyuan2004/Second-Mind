# Vault synchronization

VaultMind operates on ordinary files in a local directory. It does not copy,
upload, or reconcile a Vault by itself. `SYNC_PROVIDER` and
`SYNC_DISPLAY_NAME` describe the operator-selected mechanism; an external
process must materialize the files.

Supported deployment states are:

| Value | Meaning |
|---|---|
| `filesystem` | No sync process is managed. VaultMind reads a local directory. |
| `obsidian-headless` | The optional sidecar or a host service runs the official Headless Sync client. |
| `external` | Another operator-managed file sync process owns synchronization. |

Never run two synchronization engines against the same local Vault. Sync is
also not a substitute for snapshots or tested backups.

## Official Obsidian Headless Sync

Obsidian provides an official command-line client that can keep a Vault in
continuous sync without the desktop app. It currently:

- is an **open beta**;
- requires Node.js 22 or newer;
- requires an active Obsidian Sync subscription;
- uses the same Sync encryption model as Obsidian clients;
- is distributed in the `obsidian-headless` npm package, whose metadata is
  marked **UNLICENSED**.

Review the current [official Headless Sync documentation](https://obsidian.md/help/sync/headless)
and upstream terms before installation. This repository does not include that
package in the main image.

### Important single-client rule

Do not run Obsidian Desktop Sync and Obsidian Headless Sync on the same device
and local Vault. Obsidian explicitly warns that this can create conflicts. The
usual topology is desktop/mobile Obsidian on personal devices and exactly one
Headless client on the server.

Back up the Vault before initial setup, changing sync modes, changing
encryption, or relinking a remote Vault.

## Optional Docker sidecar

`compose.obsidian-sync.yaml` is intentionally an operator opt-in. It builds the
upstream package locally and labels the resulting image `:local`.

**Do not push, export, attach to a release, or publish that image.** The local
Dockerfile is an installation recipe, not a sublicense for upstream code.
Change `OBSIDIAN_HEADLESS_VERSION` only after reading the upstream changelog and
testing a backup copy of the Vault.

The sidecar uses:

- the same host Vault bind mount as VaultMind;
- `vaultmind-obsidian-sync-config` for the login token;
- `vaultmind-obsidian-sync-vault-state` mounted over the server-side
  `/vault/.obsidian` directory for link, device, and encryption state;
- a non-root UID, read-only image filesystem, dropped capabilities, and a
  private `/tmp`.

Both `HOME` and `XDG_CONFIG_HOME` point inside the private configuration
volume. This contains CLI state even if an upstream beta release changes which
of those standard locations it uses; the deployment does not depend on a
specific token filename.

The application container does not mount either private Sync volume. Its path
policy also excludes `.obsidian` from indexing and file access.

### UID/GID ownership

The default `1000:1000` identity matches the ownership baked into both local
images and is the simplest path. If `VAULTMIND_UID`/`VAULTMIND_GID` are changed,
that identity must be able to write the host Vault, `vaultmind-data`, and both
private Headless volumes. Build both images first, then initialize the named
volumes before `login` or `up`. For example, for an intentionally selected
`1234:1234` identity (replace both numbers with the Vault owner's numeric IDs):

```bash
docker volume create vaultmind-data
docker volume create vaultmind-obsidian-sync-config
docker volume create vaultmind-obsidian-sync-vault-state

docker run --rm --user 0 --entrypoint chown \
  -v vaultmind-data:/state \
  vaultmind:local -R 1234:1234 /state

docker run --rm --user 0 --entrypoint chown \
  -v vaultmind-obsidian-sync-config:/config \
  -v vaultmind-obsidian-sync-vault-state:/vault/.obsidian \
  vaultmind-obsidian-sync:local -R 1234:1234 /config /vault/.obsidian
```

These commands change only the three named volumes shown. Verify their exact
names and back up any existing state before applying `chown` to a non-new
volume. Keeping container UID 1000 and granting only the required host Vault
ACL avoids this advanced setup; never use mode `0777` as a shortcut.

### One-time interactive setup

Build only the local sidecar:

```bash
docker compose \
  -f compose.yaml \
  -f compose.obsidian-sync.yaml \
  build obsidian-sync
```

Log in interactively. Omit email, password, MFA code, and encryption password
from command-line arguments so they do not enter shell history or the process
list:

```bash
docker compose \
  -f compose.yaml \
  -f compose.obsidian-sync.yaml \
  run --rm --no-deps obsidian-sync login
```

List the account's remote Vaults:

```bash
docker compose \
  -f compose.yaml \
  -f compose.obsidian-sync.yaml \
  run --rm --no-deps obsidian-sync sync-list-remote
```

Link the local server directory. Replace the example Vault and device names;
enter an end-to-end encryption password only at the prompt:

```bash
docker compose \
  -f compose.yaml \
  -f compose.obsidian-sync.yaml \
  run --rm --no-deps obsidian-sync \
  sync-setup --vault "REMOTE VAULT NAME" --path /vault \
  --device-name "vaultmind-server" --config-dir .obsidian
```

Inspect the resulting configuration before continuous operation:

```bash
docker compose \
  -f compose.yaml \
  -f compose.obsidian-sync.yaml \
  run --rm --no-deps obsidian-sync sync-status --path /vault
```

Then start the application, file-backed secrets, and continuous Sync together:

```bash
docker compose \
  -f compose.yaml \
  -f compose.secrets.yaml \
  -f compose.obsidian-sync.yaml \
  up -d --build
```

Watch for authentication, conflict, quota, and encryption errors:

```bash
docker compose logs -f obsidian-sync
```

Do not log command output to a public CI system. Sync status and errors can
contain Vault names or filesystem paths.

### Conflict behavior

VaultMind prepares diary, plan, and inbox changes as drafts. A save is rejected
when the target note changed after preview generation. This reduces accidental
overwrite risk but does not make simultaneous filesystem writers transactional.

For important edits:

1. wait for Headless Sync to become current;
2. generate and review the draft;
3. save once;
4. confirm that Headless Sync uploads the resulting change;
5. resolve any reported conflict before continuing.

Prefer the Headless client's explicit conflict-preserving strategy over a mode
that silently overwrites one side. Re-check current CLI options with
`ob sync-config --help`, because the client is still beta.

### Credentials, backup, and removal

The two named volumes contain sensitive authentication and Vault-link state.
They are not part of the Git repository and are not mounted into the app.
Restrict Docker daemon access: a Docker administrator can read every secret and
volume on the host.

Back up encryption/link state only into encrypted storage. It is also valid to
exclude the auth token from backup and deliberately perform `ob login` and
`ob sync-setup` again during disaster recovery. Document which approach you
use and test it.

To revoke local authentication, stop the sidecar and run `ob logout` with the
same config volume. Removing a named volume is destructive; verify its exact
name and maintain a recoverable backup before doing so.

## Host systemd sidecar

`deploy/systemd/obsidian-headless-sync.service.example` is a generic template
for operators who install the official CLI themselves. Render all placeholders
and run interactive `ob login` and `ob sync-setup` as the same dedicated user,
with the exact `HOME` and `XDG_CONFIG_HOME` used by the unit. Never place the
Obsidian account password, MFA code, token, or Vault encryption password in the
unit or its environment file.

Use a dedicated, mode-`0700` home/configuration directory owned by the Sync
account. The template checks only that those directories exist; it deliberately
does not assume an undocumented credential filename.

The Sync service needs read/write access to the entire Vault. The VaultMind
service should still receive write access only to its diary, plan, and inbox
directories.

## Other external filesystem sync

Set `SYNC_PROVIDER=external` when another trusted process already presents a
normal local Vault directory. The operator is responsible for atomic file
replacement, conflict preservation, hidden configuration files, permissions,
and backup. Do not point VaultMind at a network filesystem whose rename,
locking, or watcher semantics are unknown without testing reconciliation and
draft conflicts.

## Self-hosted LiveSync status

Self-hosted LiveSync support is **not implemented** in this release. There is no
CouchDB service, LiveSync credential loader, Setup URI handler, or supported
LiveSync materializer in these deployment files.

A future implementation should be a separate `SyncProvider`/materializer that:

- converts the remote database into an ordinary local Vault for the existing
  indexer;
- keeps CouchDB credentials and the Vault encryption passphrase outside the
  Vault view exposed to the application;
- uses HTTPS, least-privilege database credentials, and end-to-end encryption;
- never runs concurrently with Obsidian Sync for the same Vault;
- has integration tests for deletes, renames, conflicts, attachments, hidden
  configuration, and recovery.

The community [Self-hosted LiveSync project](https://github.com/vrtmrz/obsidian-livesync)
is useful design input, but its existence must not be presented as VaultMind
support.
