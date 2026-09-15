# Security boundaries

Second Mind is a self-hosted application for one trusted administrator. Use a controlled host and private network, or configure TLS and access control before exposing it. An application permission boundary is not an operating-system sandbox.

## Authentication and credentials

Knowledge and administration APIs require signed administrator sessions. Cookies are HttpOnly and SameSite=Strict; use `SECURE_COOKIE=true` behind HTTPS. State-changing API calls require request-verification headers and reject conflicting origins. Sensitive configuration mutations reauthenticate the password and enforce revision checks. Throttling and validation receipts are process-local.

Provider keys stay in private server configuration. GET responses expose configured status only. Endpoint/protocol changes require replacing or clearing the key. The browser removes entered keys after staging and stores no provider credentials in localStorage, URLs, or cookies. A session cookie is an authentication credential and must also remain private.

Each SDK task uses an authenticated loopback transport. The real key is attached only by the application server to a pinned HTTPS upstream request; redirects and non-public destinations are rejected. The SDK subprocess receives a random local token, isolated HOME/config state, `settingSources: []`, and an environment allowlist. It does not use host Claude login files. Tavily uses a private credential file so its key does not appear in SDK-serialized process arguments.

## Vaults and tools

Private state must stay outside indexed Vault roots. Registration validates canonical roots, stable IDs, overlap, path traversal, and symbolic links. Each knowledge base owns its index, task IDs, conversation IDs, drafts, SDK state, recovery copies and audit files. Cross-base identifiers do not authorize access.

The SDK has Read, Glob, Grep and selected read-only MCP tools; it has no Bash, Write or Edit tools. Hooks reject root escape and symbolic-link traversal. Deep mode can create only the original bounded read-only subagents. These controls do not protect against an administrator who can replace application code, modify the host, or directly read private state. Keep secrets outside Vaults and treat file contents as potentially adversarial.

## Writes and migration

Generation writes drafts outside the Vault. Confirmation rechecks ownership, expiration, allowed destination, symlinks, concurrent edits, and attachments. Replacing a note creates a private preimage recovery copy. A failed audit append after a successful commit must not trigger a blind retry.

Old conversation and draft files remain untouched during additive SDK migration. Imported state and receipts are separate. Legacy draft saving uses only the old write compatibility path, never the old executor. Backups contain credentials and private content; protect permissions and verify restoration independently.

## External services

Models receive user content and tool-returned note excerpts. Remote embedding builds may transmit all eligible text in the selected Vault. Web queries and extracted pages go to their configured providers. Learning reviews skip networking. Speech models may download public weights on first use, and URL video imports contact source hosts. Read [data flow](data-flow.md) before enabling services.

Model output is untrusted. The UI sanitizes Markdown and requires review before writing. Correct citation formatting and factual accuracy are not guaranteed by SDK compatibility.

## Containers and release

The image runs without root by default, drops capabilities, uses a read-only root filesystem, and persists application state separately from Vault mounts. Media and SDK temporary state need writable private storage. Match mounted directory ownership to the container UID/GID. Docker Desktop file ACLs differ from native Linux; see platform guidance.

The Docker context is an explicit runtime allowlist. Historical code, test credentials, private backups, acceptance logs, and real API keys do not belong in images or Pages. Before publication, scan the working tree, staged diff, outgoing history, built site, image metadata/layers, and screenshot OCR/metadata. A clean scan is evidence for the scanned artifacts, not proof against every possible leak.

See [deployment](deployment.md), [configuration](configuration.md), and the dated [validation scope](claude-sdk-migration.md).
