# Security model

Second-Mind is designed for a single trusted administrator operating a private
knowledge service. It narrows filesystem writes and requires draft
confirmation, but it is not a multi-tenant document platform, an internet edge
gateway, a malware scanner, or a sandbox for arbitrary model-generated code.

Read this document together with [networking.md](networking.md) and
[data-flow.md](data-flow.md).

## Assets to protect

- the complete Vault, including deleted/conflicted copies and attachments;
- administrator credentials and signed session cookies;
- model, embedding, and Sync credentials;
- conversation history, generated drafts, temporary attachments, and audit
  records;
- the local retrieval index, which is derived from private note content;
- Obsidian account, remote Vault, device-link, and encryption state;
- backups and operational logs.

Possession of Docker daemon access, the service Unix account, the host root
account, or an unencrypted backup is equivalent to possession of these assets.

## Trust boundaries

```text
Browser -> HTTPS/VPN edge -> Second-Mind -> Vault and private state
                                      -> model provider
                                      -> embedding provider
Sync sidecar <-> Obsidian Sync cloud -> shared Vault files
```

The browser, reverse proxy, application, model provider, embedding provider,
Sync provider, host administrator, and backup operator are distinct trust
boundaries. A private network reduces exposure but does not make every
component equally trusted.

## Authentication and sessions

Second-Mind uses a configured administrator username/password and an HMAC-signed,
HttpOnly, SameSite=Strict session cookie.

The cookie name `vaultmind_session` and mutating-request header
`X-VaultMind-Request` are legacy wire identifiers retained so existing browser
sessions, reverse-proxy rules, and clients are not silently broken. They do not
represent the public product name and must not be renamed without a versioned
compatibility plan.

- Use a unique randomly generated administrator password of at least 12
  characters; a password manager-generated value should be longer.
- Use an independent random session secret of at least 32 characters.
- Set `SECURE_COOKIE=true` whenever the browser uses HTTPS.
- Keep the default short session lifetime unless the threat model justifies a
  longer one.
- Login throttling is in process memory. A restart clears it, and it is not a
  substitute for edge rate limiting or monitoring.
- Rotate the session secret whenever immediate invalidation of all existing
  sessions is required. Changing only the password does not necessarily revoke
  an already signed session.

The current application has one administrative identity. Do not represent it
as enterprise RBAC, SSO, or multi-user isolation.

## Secrets

Every supported credential can be loaded from a file by appending `_FILE` to
the variable name. Prefer:

- Docker Compose secrets or a runtime secret manager;
- root-owned/service-readable files outside the Git checkout for systemd;
- separate least-privilege keys for LLM and embedding APIs;
- interactive Obsidian login and encryption prompts.

Never store secrets in:

- Git, `.env.example`, Compose YAML, Docker build arguments, or image layers;
- browser local storage or a client-visible configuration endpoint;
- URLs, issue reports, CI logs, screenshots, shell history, or model prompts;
- the Obsidian Vault or its synced configuration folders.

The application rejects secret files writable by group or others. Use mode
`0600` where possible. Docker Compose's mounted secret may be readable inside
the container according to runtime semantics; it remains isolated from the
image and repository, but a Docker administrator can still read it.

Rotate a leaked key at its provider first, update the secret store, restart the
service, and inspect logs/audit records for abuse. Deleting a value from the
latest Git commit is insufficient if it ever entered history.

## Vault filesystem boundary

Vault paths are normalized, resolved inside the configured root, checked for
symbolic links, and filtered by an excluded-path policy. Keep these exclusions
at minimum:

```text
.obsidian,.trash,.git,.sync,.livesync,node_modules
```

`.obsidian` and `.livesync` can contain plugin configuration and credentials.
They must be denied consistently from indexing, search results, direct file
reads, and model context. Do not weaken the denylist to make a plugin easier to
configure.

The application prepares writes in private draft storage and commits them only
after explicit confirmation. Diary, plan, and inbox directories are the only
application write targets. A content hash detects many concurrent edits
between preview and save. Before replacing an existing note, Second-Mind stores
a verified preimage under `RECOVERY_DIR`, checks the live hash again, and then
uses an atomic rename. The preimage is retained for
`RECOVERY_RETENTION_DAYS` (30 by default). There is still no distributed
transaction with a Sync engine, so an external write can land in the final
check-to-rename window. Preserve Sync conflicts, monitor recovery retention,
and maintain independent backups.

Audit append failures occur after some filesystem operations have already
committed. Second-Mind therefore returns an explicit `AUDIT_WRITE_FAILED`
post-commit warning instead of returning a misleading generic failure that
could encourage a duplicate save. Treat that warning as an operational alert,
repair `AUDIT_FILE` storage, and record the incident separately.

For systemd, expose the Vault read-only and reopen only the three configured
write directories. For Docker, the shared bind mount is read/write at the
kernel level; application path policy is therefore the final write boundary.
Use a dedicated host UID and filesystem ACLs, and never mount an entire home
directory.

## Model-content safety

Vault notes and uploaded text are untrusted data. They can contain instructions
intended to manipulate a model. Second-Mind sends text to a generation API but
does not grant that model a shell, arbitrary filesystem tools, or general web
tools. Preserve that architecture.

Model output can still be wrong, disclose supplied context, or produce unsafe
links/content. Review every generated draft before saving. Never execute code
or commands from a generated answer without independent inspection.

Remote model and embedding providers receive private data. Select providers
whose retention, training, regional, contractual, and incident-response terms
match the data. Use local providers for data that must not leave the server.

## Attachments

Text attachment excerpts can be sent to the LLM. Image and PDF attachments in
note modes are persisted with a confirmed draft but are not an antivirus or
content-disarm pipeline. Size and filename validation do not prove that a file
is harmless. Scan untrusted files before opening them in desktop software and
keep endpoint applications patched.

## Container hardening

The supplied Compose service uses a non-root UID, a read-only root filesystem,
all-capability drop, `no-new-privileges`, PID limit, private temporary storage,
loopback-only host publication, and a separate persistent data volume.

These controls do not defend against a compromised Docker daemon, malicious
host administrator, vulnerable kernel, or overly permissive Vault bind mount.
Do not mount `/var/run/docker.sock`, SSH agent sockets, cloud instance
credentials, or unrelated host directories into the container.

The optional Obsidian Headless image is locally built and must not be published.
It has network access and full Vault write access because synchronization
requires both. It receives no model API secrets.

## systemd hardening

The example unit uses a dedicated user, empty capability sets,
`NoNewPrivileges`, a private `/tmp`, kernel/control-group protections, a strict
system view, a restricted address-family set, read-only application code, and
write allowlists.

Render and verify the unit on the target distribution. systemd features differ
between releases. Never fall back to running the application as root merely
because a hardening directive or permission is misconfigured.

## Network security

- Keep the application listener on loopback.
- Prefer Tailscale Serve for private remote access; never enable Funnel for this
  service.
- For cloud access, terminate maintained TLS in Caddy or Nginx and expose only
  443 (plus 80 for ACME/redirect when needed).
- Replace, rather than append to, client-supplied forwarding headers.
- Enable `TRUST_PROXY` only when direct access is impossible.
- Do not log request bodies, cookies, authorization headers, or URL secrets.
- Apply provider egress restrictions when the platform supports them.

## Supply-chain and release security

Before each release:

1. review lockfile and base-image changes;
2. run tests, static checks, secret scanning, and dependency vulnerability
   scanning;
3. generate an SBOM and retain build provenance;
4. patch high/critical vulnerabilities or document a time-bounded exception;
5. verify third-party licenses and preserve required notices;
6. scan the complete Git history, not only the working tree;
7. build from a clean checkout and test backup/restore;
8. pin published images by immutable tag or digest.

The optional `obsidian-headless` package is open beta and marked UNLICENSED.
The main image intentionally excludes it. Do not publish an image containing it
without explicit upstream redistribution rights.

## Operational monitoring

Alert on repeated login failures, unexpected restarts, provider authentication
errors, Sync conflicts, index failures, disk exhaustion, and backup failures.
Audit records are sensitive metadata and require retention limits. Avoid
putting raw note text or secrets in alerts.

## Incident response checklist

1. Restrict network access or stop the service while preserving evidence.
2. Revoke affected model, embedding, Sync, and administrator credentials.
3. Rotate the session secret to invalidate sessions.
4. Inspect Git history, container layers, logs, backups, and provider audit
   trails for the leaked material.
5. Restore from a known-good snapshot if Vault integrity is uncertain.
6. Rebuild images and indexes from reviewed source rather than trusting a
   potentially modified host.
7. Document scope, timeline, remediation, and notification obligations.

Report suspected vulnerabilities privately through the repository's published
security contact rather than a public issue.
