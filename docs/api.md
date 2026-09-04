# HTTP API

The browser UI and API are versioned together. This document describes the current supported web contract for operators and contributors. It is not a promise of a stable third-party SDK.

## Authentication and request verification

All knowledge and administrator routes require the signed administrator session cookie. Login, logout, and session discovery are handled without requiring an existing session. Login returns an `HttpOnly`, `SameSite=Strict` cookie. With HTTPS, configure `SECURE_COOKIE=true` so it also has the `Secure` attribute.

Every non-GET API request must include:

```http
X-VaultMind-Request: 1
Content-Type: application/json
```

`X-VaultMind-Request` and the `vaultmind_session` cookie name are compatibility wire identifiers. They do not change the visible product name. When the browser sends an `Origin`, its host must equal the request `Host`. A reverse proxy must therefore preserve the public host and replace untrusted forwarding headers.

| Method and route | Purpose |
|---|---|
| `POST /api/login` | Authenticate `{ "username": "admin", "password": "..." }` |
| `POST /api/logout` | Clear the session cookie |
| `GET /api/session` | Return authentication state, administrator identity, and feature permissions |

Authentication errors use `401`; missing request verification or a rejected origin uses `403`. Login throttling is process-local.

## Knowledge-base selection

`GET /api/knowledge/bases` returns the public registry status:

```json
{
  "revision": "registry-revision",
  "stale": false,
  "defaultKnowledgeBaseId": "research",
  "readyCount": 2,
  "enabledCount": 2,
  "knowledgeBases": [
    {
      "knowledgeBaseId": "research",
      "name": "Research",
      "enabled": true,
      "default": true,
      "revision": "entry-revision",
      "status": "ready",
      "retrieval": { "ready": true, "mode": "keyword", "documentCount": 12 }
    }
  ]
}
```

Every route under `/api/knowledge/` uses one knowledge-base context. Supply `knowledgeBaseId` as a query parameter. JSON creation/save routes may instead include it in the body. If query and body both provide different values, the server returns `KNOWLEDGE_BASE_SELECTION_CONFLICT`. Omitting it selects the current default for compatibility, but clients should always send it explicitly.

Selected-context JSON responses add:

```json
{
  "knowledgeBaseId": "research",
  "knowledgeBaseRevision": "entry-revision",
  "knowledgeBaseName": "Research"
}
```

Task events also contain the ID and revision. Task, conversation, and draft identifiers are scoped to the selected base. Supplying an identifier from another base returns not found.

## Health and retrieval

Health routes do not require authentication:

| Method and route | Purpose |
|---|---|
| `GET /health/live` | Process liveness; returns `200` while the HTTP process responds |
| `GET /health/ready` | Returns `200` when at least one enabled base is ready, otherwise `503` |

Authenticated retrieval routes:

| Method and route | Purpose |
|---|---|
| `GET /api/knowledge/status?knowledgeBaseId=ID` | Selected base, model catalog, retrieval, WebSearch, modes, and active task |
| `GET /api/knowledge/search?knowledgeBaseId=ID&q=TEXT&mode=keyword&limit=30` | Search with `keyword`, `semantic`, or `hybrid` route |
| `GET /api/knowledge/file?knowledgeBaseId=ID&path=RELATIVE_PATH` | Read an allowed Vault file |
| `HEAD /api/knowledge/file?...` | Read file metadata without the body |

Search results intentionally omit indexed chunk content, token lists, and vectors. A semantic-only request returns `503 SEMANTIC_SEARCH_UNAVAILABLE` when no active semantic index exists. Hybrid search may explicitly report a lexical fallback.

File paths are Vault-relative and pass the same excluded-path and symbolic-link policy used by indexing. Binary content may be returned as an attachment. Responses use `Cache-Control: no-store`.

## Conversations

| Method and route | Purpose |
|---|---|
| `GET /api/knowledge/conversations?knowledgeBaseId=ID` | List conversations for the selected base |
| `GET /api/knowledge/conversations/CONVERSATION_ID?knowledgeBaseId=ID` | Read one conversation with messages |
| `DELETE /api/knowledge/conversations/CONVERSATION_ID?knowledgeBaseId=ID` | Delete one idle conversation |
| `DELETE /api/knowledge/conversations?knowledgeBaseId=ID&kind=qa` | Clear idle conversations, optionally filtered by kind |

A conversation with an active task cannot be deleted. Q&A conversation settings are fixed to model binding, requested effort, and WebSearch binding. To change them, create the next task with `forkFromConversationId`; do not send both `conversationId` and `forkFromConversationId`.

## Tasks and SSE

Create a task with `POST /api/knowledge/tasks`. Example:

```json
{
  "knowledgeBaseId": "research",
  "kind": "qa",
  "prompt": "Summarize the supported evidence.",
  "taskMode": "normal",
  "model": "main",
  "effort": "medium",
  "modelCatalogRevision": "catalog-revision",
  "webSearch": false,
  "attachments": []
}
```

Supported `kind` values are `qa`, `diary`, `plan`, and `scratch`. `taskMode` is `normal` or, for Q&A when enabled, `deep`. Diary and plan requests may add a date. Attachments use `{name,type,data}` where `data` is the base64 payload without a data-URL prefix. Q&A accepts text attachments only; note modes may persist accepted image/PDF attachments with the confirmed draft. Server-configured count and byte limits always apply.

Creation returns `201` with a task ID, conversation ID, status, fixed model/WebSearch binding metadata, requested/effective effort, and knowledge-base identity. If no model is configured it returns `503 LLM_NOT_CONFIGURED`; local search remains available.

| Method and route | Purpose |
|---|---|
| `GET /api/knowledge/tasks/TASK_ID?knowledgeBaseId=ID` | Read current task state |
| `GET /api/knowledge/tasks/TASK_ID/events?knowledgeBaseId=ID` | Subscribe to SSE events |
| `POST /api/knowledge/tasks/TASK_ID/cancel?knowledgeBaseId=ID` | Request cancellation |

SSE frames contain monotonically increasing numeric IDs. `Last-Event-ID` resumes buffered events. The server sends heartbeat comments every 20 seconds and ends the stream after terminal `done`. Current event names include:

- `state`, `session`, and `activity` for observable execution state;
- `thinking` and `diagnostic` for bounded, user-visible status, not hidden chain of thought;
- `text` and `text_replace` for answer content;
- `usage` for bounded token/cost metadata when available;
- `draft_ready` for a generated note draft;
- `task_error` followed by terminal `done` on failure;
- `done` with `completed`, `failed`, or `cancelled` status.

## Draft confirmation

| Method and route | Purpose |
|---|---|
| `GET /api/knowledge/drafts/DRAFT_ID?knowledgeBaseId=ID` | Read the editable private draft |
| `POST /api/knowledge/drafts/DRAFT_ID/save` | Confirm and save changes to the selected Vault |
| `DELETE /api/knowledge/drafts/DRAFT_ID?knowledgeBaseId=ID` | Discard a draft |

The save JSON body carries `knowledgeBaseId`, edited Markdown content, and any client fields returned by the draft contract. The server does not trust the client path blindly. It rechecks ownership, expiry, destination policy, symbolic links, target hash, attachment names, and concurrent changes.

A successful save returns the relative path plus any warnings. `AUDIT_WRITE_FAILED` can be returned as a post-commit warning when the note write succeeded but the audit append failed. Clients must not blindly repeat that save.

## Administrator knowledge-base registry

`GET /api/admin/knowledge-bases` requires the administrator session and returns public state plus allowed mount IDs/labels, relative paths, path availability, and bounded runtime status. It never returns host mount paths.

`PUT /api/admin/knowledge-bases` requires request verification and password reauthentication:

```json
{
  "adminPassword": "current-password",
  "expectedRevision": "registry-revision",
  "knowledgeBases": [
    {
      "knowledgeBaseId": "research",
      "name": "Research",
      "mountId": "vaults-1",
      "relativePath": "Research",
      "enabled": true,
      "default": true
    }
  ]
}
```

IDs are lowercase stable identifiers, and every managed path must be an actual Obsidian Vault root with a non-symlink `.obsidian` directory. The private binding ledger permanently binds each ID to the first canonical Vault path, including after deletion and restart. Re-adding the same Vault with its original ID is allowed; assigning that ID to another Vault returns `409 KNOWLEDGE_BASE_ID_REBIND_FORBIDDEN`, so use a new ID instead. Exactly one enabled base must be the default and at least one must remain enabled. A stale revision returns `409 KNOWLEDGE_BASE_REVISION_CONFLICT`. Updates affecting an active or still-admitting task return `409 KNOWLEDGE_BASE_BUSY`. Path, layout, and overlap failures return specific bounded codes and never echo a private absolute path.

## Administrator Provider configuration

The browser administrator page treats the server response as the schema source. Clients should GET before editing and preserve fields they do not change.

| Method and route | Purpose |
|---|---|
| `GET /api/admin/provider-config?knowledgeBaseId=ID` | Simplified registered model/WebSearch configuration plus selected-base embedding status |
| `POST /api/admin/provider-config/validate?knowledgeBaseId=ID` | Reauthenticate and validate a candidate without committing it |
| `PUT /api/admin/provider-config?knowledgeBaseId=ID` | Commit a validated one-time receipt, or a branding-only change |
| `GET /api/admin/runtime-config?knowledgeBaseId=ID` | Full managed configuration and selected-base embedding status |
| `PUT /api/admin/runtime-config?knowledgeBaseId=ID` | Revision-checked managed configuration update |
| `POST /api/admin/embedding-rebuild?knowledgeBaseId=ID` | `validate-and-build` or `cancel` for the selected base |

All mutations require `adminPassword` and `expectedRevision` where the returned schema provides a revision. A Provider candidate is checked before commit. The simplified validation flow issues a short-lived, one-use server-side receipt so secrets do not need to remain in browser storage. Receipts do not survive a process restart and cannot be replayed against a new revision.

Secret fields use explicit `replace`, `keep`, or `clear` actions. Responses expose only fields such as `apiKeyConfigured` or `configured`. A destination/protocol change requires replacing or clearing the credential instead of silently carrying it to another endpoint.

Embedding `validate-and-build` may probe the configured service, detect dimensions, and send all indexable text in the selected base. It returns `202` after the rebuild starts. The prior active index keeps serving until a candidate finishes and is atomically activated. Cancellation leaves the active index unchanged.

## Error contract

JSON failures use:

```json
{
  "error": "BOUNDED_MACHINE_CODE",
  "message": "Human-readable explanation"
}
```

Expected status families are `400` invalid input, `401` missing/failed authentication, `403` request/origin rejection, `404` unknown scoped resource, `409` revision or active-state conflict, `413` size limit, `422` Provider validation failure, and `503` unavailable dependency or knowledge base. Unexpected internal exceptions are replaced with a generic message. Provider response bodies, credentials, absolute Vault paths, and raw note text must not be copied into API errors or logs.
