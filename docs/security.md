# Security model

Second Mind is a single-administrator, self-hosted service for private filesystem knowledge bases. Its controls reduce common deployment, path, secret, and model-content risks, but they do not turn an untrusted host, Docker daemon, administrator, backup operator, remote Provider, or sync engine into a trusted component.

## Assets to protect

- Every mounted Vault, including attachments and hidden configuration.
- The mapping between public knowledge-base IDs and host paths.
- Administrator credentials and signed sessions.
- LLM, WebSearch, embedding, and optional sync credentials.
- Conversations, drafts, temporary attachments, recovery preimages, and audit logs.
- BM25/vector indexes derived from note content.
- Installer state, named volumes, operational logs, and backups.

Possession of Docker daemon access, the service account, host-administrator access, or an unencrypted backup is effectively possession of these assets.

## Trust boundaries

```text
browser -> private network or HTTPS edge -> Second Mind
                                           -> allowed Vault mounts
                                           -> private runtime state
                                           -> selected LLM
                                           -> selected embedding service
                                           -> selected WebSearch/public pages
external sync process <-> Vault files <-> sync provider
```

The browser, proxy, application, host, Docker engine, each remote Provider, sync process, and backup destination are separate boundaries. A private network reduces exposure but does not merge their trust.

## Authentication and sessions

The service has one configured administrator username/password. Successful login creates an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie. Set `SECURE_COOKIE=true` whenever the browser uses HTTPS.

- Use a unique password of at least 12 characters, preferably a longer password-manager value.
- Use an independent random session secret of at least 32 characters.
- Rotate the session secret to invalidate all signed sessions immediately.
- Keep the default session lifetime unless the threat model needs a shorter value.
- Login throttling is process-local and resets on restart. Add edge throttling and monitoring for exposed deployments.
- Enable `TRUST_PROXY` only when clients cannot bypass the trusted proxy.

Every mutating API request needs `X-VaultMind-Request: 1`, and a supplied `Origin` must match `Host`. The header and `vaultmind_session` cookie are legacy compatibility identifiers. They are not a substitute for HTTPS and must not be renamed without a versioned client/proxy migration.

Do not describe the current single identity as RBAC, SSO, team sharing, or tenant isolation.

## Secret handling

Use the installers or `_FILE` environment variants. Keep secret files outside the repository, Vaults, and sync roots. Supported credential categories have separate fields and rotation boundaries:

- administrator password;
- session signing secret;
- each model connection key;
- each WebSearch provider key;
- embedding key;
- optional page-extraction/sync credentials.

Never store credentials in Git, `.env.example`, image build arguments/layers, URLs, issue text, screenshots, shell history, Vault notes, browser Web Storage, or a client-visible response. Read APIs return configured booleans only.

Managed runtime and registry files use restrictive permissions, regular-file/symbolic-link checks, atomic replacement, revision comparison, and previous or last-known-good copies. Managed runtime reads also enforce one-link safe-open checks where supported. Do not hand-edit these files during operation.

Changing a Provider destination/protocol requires replacing or clearing its key. This prevents an old credential from being silently sent to a new endpoint. Provider validation errors are bounded and redacted.

If a credential leaks, revoke it at the Provider first, replace local state, restart as needed, inspect Provider audit data and local logs, and scan complete Git history. Removing it from only the current commit is insufficient.

## Knowledge-base boundaries

The registry accepts only actual Obsidian Vault roots under startup-authorized mounts. It resolves canonical paths and rejects absolute submitted paths, traversal, symbolic-link traversal, missing or linked `.obsidian` markers, duplicate/nested bases, overlapping mounts, and overlap with private state. The API exposes relative paths and mount labels, never host mount paths.

Each base receives separate index, embedding slots, conversations, tasks, drafts, recovery copies, and audit records. Opaque task/conversation/draft IDs are resolved inside the selected base. Responses and SSE events carry base ID/revision so the browser can discard stale cross-switch results.

Registry updates require password reauthentication and compare-and-swap. They fail when an affected base has an active task. A private digest ledger permanently binds each `knowledgeBaseId` to its first canonical Vault path, including across deletion, restart, and external registry refresh. Removing an entry does not erase its files or state.

Host administrators and mount configuration remain trusted. If different Vault contents replace a directory or mount at exactly the same canonical path, register them under a new ID before use; otherwise the application cannot distinguish that host-level substitution from the original Vault and may reopen its retained private state.

At minimum, preserve these excluded paths:

```text
.obsidian,.trash,.git,.sync,.livesync,node_modules
```

`.obsidian` and sync/plugin directories may contain tokens or configuration. They are excluded consistently from indexing, search, direct reads, and model context. Do not weaken the policy to simplify a plugin setup.

## Confirmed write path

Generated note content first enters private draft storage outside every Vault. A confirmed save rechecks user ownership, selected base, destination allowlist, filename, draft expiry, symbolic links, expected target hash, and attachments. It writes a temporary file in the destination and uses atomic rename.

Before replacing an existing diary or plan, Second Mind stores and verifies a recovery preimage. Recovery copies expire according to `RECOVERY_RETENTION_DAYS`, 30 by default. There is no distributed transaction with an external sync engine, so a conflicting external write can still land near the final rename. Preserve sync conflicts and keep independent tested backups.

An audit append occurs after the filesystem commit. If it fails, the API returns an `AUDIT_WRITE_FAILED` warning rather than pretending the note failed. Treat this as an operational incident and do not blindly repeat the write.

## Model-content safety

Vault notes, uploaded text, WebSearch results, and fetched pages are untrusted data and can contain prompt-injection attempts. The model receives bounded, delimited text. It does not receive a shell, arbitrary filesystem API, general browser, raw MCP client, or unrestricted fetch tool.

Server code owns retrieval, allowed tools, source identities, URL validation, and writes. Only Vault paths actually supplied as sources may become Vault citations. This limits authority but does not make model output correct or confidential. Review answers and every draft. Never execute generated commands without independent inspection.

Remote LLM and embedding services can receive selected private text. Remote search services receive generated queries. Choose Providers whose retention, training, region, contractual, logging, and incident-response terms fit the data. Use independent least-privilege keys, quotas, and spending alerts.

## Web egress and SSRF controls

WebSearch is off by default and enabled per Q&A conversation. Optional page reading accepts selected public HTTPS URLs only. It rechecks DNS/IP, the connected address, redirects, media type, byte/character bounds, timeouts, concurrency, and total pages.

Private, loopback, link-local, reserved, and otherwise non-public destinations are rejected. TLS hostname verification remains tied to the public hostname. Fetched text remains untrusted model input.

The standard image omits the sandbox tools needed for PDF extraction. PDF reading reports unavailable and does not fall back to an unsandboxed parser.

## Attachments

Q&A accepts text attachments only and may send bounded excerpts to the selected LLM. Note modes can save validated image/PDF attachments after draft confirmation. Size, filename, MIME, and extension checks are not antivirus or content disarm. Scan untrusted content before opening it in desktop software.

## Container boundary

The supplied Compose service uses:

- a non-root UID/GID;
- a read-only image filesystem;
- dropped capabilities and `no-new-privileges`;
- PID and temporary-filesystem limits;
- loopback-only host publication;
- one explicit knowledge-base bind mount;
- a separate named private-data volume;
- file-backed secrets through the required Compose secrets overlay.

These controls do not protect against a compromised Docker daemon, host administrator, kernel, or writable Vault mount. Never mount the Docker socket, SSH agent, cloud credentials, a user home, installer state, or unrelated directories into the application.

The non-root user inside the application container does not make the Docker daemon rootless. The Linux quick installer assumes conventional rootful Docker; rootless Docker and SELinux-enforcing hosts require an explicit UID/volume-ownership and bind-mount relabel design that the installer does not apply automatically.

## Installer and backup safety

Each installer instance has an independent project, volume, state directory, and secret set. The installer rejects filesystem/user-home roots, repository overlap, Vault/state overlap, and unresolved port conflicts. It does not stop unrelated processes.

`backup` includes the Vault, runtime data, deployment configuration, and credentials. SHA-256 inventories detect copied-content changes, but the backup is a live copy and does not preserve every platform ACL/xattr. Stop the exact instance and its sync engine for strict point-in-time consistency. Encrypt backups and test restore in isolation.

An independent sync engine's private volumes, account/link state, and remote state are outside this backup unless the operator captures them separately. `update` preserves the instance data volume and configuration but has no automatic image rollback; retain the previous reviewed image and test a manual recovery path.

There is no destructive uninstall command. Ordinary `docker compose down` should target the exact generated project without `--volumes`. Permanent cleanup requires a verified backup and explicit review of each named volume and directory. Never use a broad recursive deletion.

## Network security

- Keep the application on loopback by default.
- For remote use, prefer a reviewed private network or maintained HTTPS reverse proxy.
- Do not expose the application port directly to the public internet.
- Preserve the public `Host`, replace forwarding headers, and disable proxy buffering for SSE.
- Apply edge login throttling, request-size limits, access logs without sensitive bodies, and egress restrictions where possible.
- Never publish through a public-tunnel feature by accident.

See [networking.md](networking.md) for concrete proxy guidance.

## Sync boundary

Second Mind does not implement synchronization. Any Headless or external sync process needs full Vault write access and its own network credentials, making it a separate high-trust component. Never run two sync engines for one local Vault, and never treat sync as backup.

The optional Headless image is locally built, excluded from the main application image, and should not be published. It receives no model Provider credentials. Review current upstream requirements and redistribution terms before using it.

## Release and supply chain

Before release:

1. Review lockfile, action, base-image, and Provider-adapter changes.
2. Run static checks, the complete test suite, current-tree/history secret scans, and dependency audit.
3. Build only from the strict Docker context and inspect image history and environment.
4. Exercise an isolated synthetic container and real-browser tests.
5. Produce and retain provenance and an SBOM for published images.
6. Resolve high/critical findings or record a time-bounded exception.
7. Verify screenshot pixels, OCR, metadata, and all public documentation.
8. Test backup and manual restore from a clean release candidate.
9. Pin production images by immutable tag or digest.

## Monitoring and incident response

Monitor repeated login failures, unexpected restarts, registry/index failures, Provider authentication errors, WebSearch failures, sync conflicts, disk exhaustion, failed backups, and `AUDIT_WRITE_FAILED`. Logs and audits are sensitive metadata and should have access and retention limits.

If compromise or disclosure is suspected:

1. Restrict network access or stop the exact service while preserving evidence.
2. Revoke affected administrator, session, Provider, and sync credentials.
3. Inspect Git history, image layers, logs, backups, Provider audit trails, and Vault changes.
4. Restore from a verified snapshot if integrity is uncertain.
5. Rebuild indexes and images from reviewed source.
6. Document scope, timing, remediation, and any notification duties.

Use the private reporting process in [SECURITY.md](../SECURITY.md). Do not put vulnerability details, secrets, or private note content in a public issue.
