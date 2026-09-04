# Deployment guide

The supported default is a Docker-first, loopback-only deployment created by `install.sh` or `install.ps1`. The installer runs its shared Node.js 22 initialization logic inside Docker, so the host needs Docker and Git but not Node.js, OpenSSL, or hand-written runtime JSON.

## Installer quick start

Install and start Docker first.

Linux or macOS:

```bash
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
./install.sh
```

Windows PowerShell with Docker Desktop, WSL2 backend, and Linux containers:

```powershell
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The interactive installer asks for:

1. one Vault or a parent containing immediate-child Vaults;
2. an administrator password of at least 12 characters;
3. a loopback port, default `8787`.

It validates Docker/Compose, path accessibility, separation from private state, runtime-volume ownership, port availability, and readiness. It never stops the process or container that already owns a port.

The application image defaults to `ghcr.io/kygoyuan2004/second-mind:latest`. Setup first pulls the image matching the Docker engine's `linux/amd64` or `linux/arm64` platform. If no pullable image is available, it builds from the current checkout.

Platform-specific details:

- [Linux](quickstart-linux.md)
- [macOS](quickstart-macos.md)
- [Windows](quickstart-windows.md)

The Linux quick path assumes a conventional rootful Docker Engine. The installer does not configure rootless user/UID mappings, named-volume ownership for those mappings, or SELinux bind-mount relabeling. Rootless or SELinux-enforcing deployments need an administrator-designed and tested permission policy.

## Installer state and multiple instances

Each installation receives a random `second-mind-*` instance ID, its own Compose project, named runtime-data volume, secret files, generated `.env`, Compose overlay, and backup directory. Defaults are:

| Host | Private configuration root |
|---|---|
| Linux | `$XDG_CONFIG_HOME/second-mind`, or `~/.config/second-mind` |
| macOS | `~/Library/Application Support/Second Mind` |
| Windows | `%LOCALAPPDATA%\Second Mind` |

Set `SECOND_MIND_CONFIG_HOME` before the first command to select another dedicated directory. It must not be a filesystem root, user-profile root, Git checkout, Vault, or a directory containing/contained by the Vault. The installer writes a marker and rejects a nonempty unrelated directory.

Unix permissions are restricted where supported. The PowerShell wrapper replaces inherited ACL entries with access for the current user, Local System, and local Administrators. Docker administrators and host administrators can still read volumes and secrets.

Running `init` again reuses the selected instance and refuses to replace its Vault or administrator secret. Use `--new-instance` to create another isolated instance. Use `--instance second-mind-ID` on an operations command to select an existing instance explicitly.

For automation, provide the password to the host wrapper through the process environment rather than a command-line argument:

```bash
SECOND_MIND_ADMIN_PASSWORD="$INJECTED_SECRET" \
  ./install.sh init --non-interactive --vault /path/to/vault-parent --port 8787
```

The wrapper pipes that value to the short-lived initializer over standard input; it is not added to Docker arguments or the container environment. This example shows the interface, not a recommendation to place a real password in shell history, a checked-in file, or a shared host environment. Prefer a CI secret store or interactive prompt.

## Single Vault and parent discovery

The selected host directory is mounted at `/vaults` inside the application container.

- If the selected root contains an actual, non-symlink `.obsidian` directory, the application keeps a single compatible knowledge base.
- Otherwise, first startup discovers only immediate child directories containing an actual, non-symlink `.obsidian` directory.
- It does not recurse through grandchildren.
- Later registry edits are limited to paths relative to the authorized mount.

Every later managed entry must itself be an Obsidian Vault root, not another parent directory. Its stable ID is permanently bound in private state to the first canonical Vault path, including across deletion and restart. Reuse the original ID only for that same path; use a new ID for a different Vault, including when different contents replace a mount at the identical host path.

The mount must be readable and writable by the configured container UID/GID because confirmed diary, plan, scratch-note, and attachment saves write into a Vault. The installer performs a temporary write probe and removes it immediately. Do not solve permission failures with mode `0777` or by mounting an entire home directory.

Docker `--mount` uses comma-separated syntax and cannot reliably encode a host path containing a comma. Choose a parent path without commas. Spaces, non-ASCII names, and Windows drive-letter paths are preserved by the shared installer logic and covered by tests.

## Day-to-day operations

Unix:

```bash
./install.sh doctor
./install.sh status
./install.sh logs --no-follow --tail 200
./install.sh backup
./install.sh update
```

PowerShell uses the same subcommands, for example:

```powershell
.\install.ps1 doctor
.\install.ps1 status
.\install.ps1 logs --no-follow --tail 200
.\install.ps1 backup
.\install.ps1 update
```

`doctor` checks the Docker client/engine and Compose, Linux-container mode, rendered configuration, knowledge-base access, runtime volume, selected port, Docker disk usage, and, when running, liveness/readiness and PDF sandbox capability.

`status` displays Compose state and checks the live and ready endpoints. `logs` follows by default; `--no-follow` returns a bounded tail and `--tail N` accepts 1 to 10000 lines.

`update` validates the same boundaries, pulls the configured image or builds the current checkout, recreates the exact instance without changing its data volume, and waits up to two minutes for readiness. It does not automatically roll back an image when readiness fails. Make and verify a backup first, retain the previous reviewed image, and review release notes and schema compatibility before changing an image tag or source revision.

## Backup semantics

`backup` creates a timestamped directory inside that instance's private configuration root. It contains:

- the selected Vault or Vault parent tree;
- the complete application data volume, including every per-base index and history;
- generated instance metadata and Compose configuration;
- authentication and Provider secret files;
- SHA-256 inventories for the copied Vault and runtime-data trees;
- a manifest marked complete only after every component succeeds.

The backup does not automatically include private volumes, account/link state, or remote state owned by an independent sync engine. Design and test that recovery path separately.

Symbolic links are copied as links rather than followed. Backups contain private notes, derived indexes, conversations, audit metadata, and credentials. Encrypt them, restrict access, and keep an independent copy.

The command performs a live file-by-file copy. It is not an atomic snapshot across application writes and an external sync process. For a strict point-in-time backup, stop the exact application instance and pause its sync process first. Then create the backup, verify the manifest and inventories, and restart deliberately.

The installer does not currently preserve every platform ACL or extended attribute.

## Restore

There is no automatic restore command. A safe manual procedure is:

1. Stop the exact target instance and any sync process that can write the Vault.
2. Copy the backup to a separate verification directory.
3. Require a complete manifest and verify inventory hashes and expected paths.
4. Inspect configuration and Provider destinations before restoring credentials.
5. Restore the Vault, private configuration, and runtime data to a new isolated instance or volume.
6. Start on a different loopback port and test sign-in, base selection, search, conversations, and drafts.
7. Only then decide whether to replace the original deployment.

Do not restore private state into a Vault, merge two knowledge-base state directories, or let external sync run during the copy.

## Removal

There is no destructive uninstall command. To remove running containers while preserving data, run `docker compose down` using the exact project name, generated env file, repository Compose files, and generated instance overlay. Do not add `--volumes`.

The operation preserves:

- the host Vault or parent directory;
- the named runtime-data volume;
- installer configuration and secret files;
- installer-created backups.

Before permanent deletion, make and verify a backup. List and inspect the exact named volume and the exact instance configuration directory, then remove only those targets. Never use a wildcard or broad recursive delete against a user profile, config root, repository root, or Vault.

## Manual Compose deployment

Advanced operators may run the Compose files without the installer. They become responsible for all checks the installer normally performs.

1. Choose a dedicated Vault/Vault-parent path and a private data volume.
2. Create independent files for `admin_password`, `session_secret`, `llm_api_key`, `embedding_api_key`, `web_search_api_key`, and `responses_api_key`. Empty optional Provider files are valid; authentication files are not.
3. Restrict the secret files and keep them outside the checkout.
4. Set `KNOWLEDGE_BASE_HOST_PATH`, bind IP, port, UID/GID, and the six host-file mappings—`ADMIN_PASSWORD_SECRET_PATH`, `SESSION_SECRET_SECRET_PATH`, `LLM_API_KEY_SECRET_PATH`, `EMBEDDING_API_KEY_SECRET_PATH`, `WEB_SEARCH_API_KEY_SECRET_PATH`, and `BAILIAN_RESPONSES_FALLBACK_API_KEY_SECRET_PATH`—in a private env file.
5. Render and review configuration before starting.

```bash
docker compose --env-file /secure/path/instance.env \
  -f compose.yaml -f compose.secrets.yaml config --quiet

docker compose --env-file /secure/path/instance.env \
  -f compose.yaml -f compose.secrets.yaml up -d
```

Compose defaults to a non-root runtime user, read-only root filesystem, dropped capabilities, `no-new-privileges`, PID limit, private `/tmp`, loopback publication, health check, one bind mount, and one named data volume. These controls do not protect against a compromised Docker daemon, host administrator, kernel, or overly broad host mount.

Use a unique `COMPOSE_PROJECT_NAME` for each manual instance and verify the project-scoped volume name before startup. Do not share one runtime volume between instances.

## Native Node.js and systemd

Node.js `^22.22.0` or `>=24.8.0` is required. Native operation is an advanced manual path. It must reproduce authentication secret permissions, data/Vault separation, service-user ownership, loopback binding, process supervision, and backup behavior.

The files under `deploy/systemd/` are legacy single-base templates, not installer output. They still start the compatibility entry point and require every placeholder to be reviewed. They do not create the Docker-first multi-instance layout, configure the managed Provider UI, or implement backup/update/restore. Use `src/bootstrap.mjs` for the unified managed bootstrap when designing a new native service.

Do not run as root to bypass a permission problem. Validate the rendered unit with the target systemd release because supported sandbox directives differ.

## Image and release handling

The main application image contains only runtime source, browser assets, and production dependencies. It does not include installer configuration, Vaults, secrets, backups, deployment examples, or the optional sync package. CI is expected to publish `linux/amd64` and `linux/arm64` with provenance and an SBOM.

For repeatable production rollouts, pin an immutable release tag or digest rather than `latest`, retain the previous reviewed image, and test migration plus manual restore on a copy. The current installer has no automatic rollback command.

See [configuration](configuration.md), [networking](networking.md), [security](security.md), and [sync](sync.md) before enabling remote access or external synchronization.
