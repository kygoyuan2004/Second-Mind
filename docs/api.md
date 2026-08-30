# HTTP API

The API is intended for the bundled same-origin browser, not as a stable public
SDK. All responses containing private state use `Cache-Control: no-store`.

## Authentication and request guard

`POST /api/login` accepts:

```json
{ "username": "admin", "password": "..." }
```

Successful authentication sets an HMAC-signed, `HttpOnly`, `SameSite=Strict`
cookie. `GET /api/session` returns the current public session and
`POST /api/logout` clears it.

Every non-GET/HEAD API request must include:

```http
X-VaultMind-Request: 1
```

If a browser sends an `Origin`, its host must equal the request `Host`.
Production HTTPS deployments must also set `SECURE_COOKIE=true`.

Errors use this shape:

```json
{ "error": "STABLE_ERROR_CODE", "message": "Human-readable explanation" }
```

## Status and retrieval

| Method and path | Result |
|---|---|
| `GET /health/live` | Process liveness; no authentication |
| `GET /health/ready` | Retrieval initialization status; no authentication |
| `GET /api/knowledge/status` | Public runtime capabilities, model labels, sync label, limits, active task, and index diagnostics |
| `GET /api/knowledge/search?q=...&mode=keyword&limit=30` | File-deduplicated search results; mode is `keyword`, `semantic`, or `hybrid` |
| `GET /api/knowledge/file?path=...` | A path-policy-approved Vault file for source preview |

Search results expose the relative path, best heading/line range, snippet,
score, and matched terms. Raw indexed chunk content and vectors are removed at
the HTTP boundary. An explicitly requested semantic search returns `503
SEMANTIC_SEARCH_UNAVAILABLE` rather than silently pretending it was semantic.
Hybrid task retrieval can degrade to lexical candidates and reports the reason
in diagnostics.

## Conversations

| Method and path | Result |
|---|---|
| `GET /api/knowledge/conversations` | Conversation summaries for the administrator |
| `GET /api/knowledge/conversations/:id` | Summary and messages |
| `DELETE /api/knowledge/conversations/:id` | Delete one idle conversation |
| `DELETE /api/knowledge/conversations?kind=qa` | Delete all idle conversations of one mode |

Valid kinds are `qa`, `diary`, `plan`, and `scratch`. Conversation deletion
never deletes Vault files.

## Tasks and SSE

Create a task with `POST /api/knowledge/tasks`:

```json
{
  "kind": "qa",
  "prompt": "How does the project combine rankings?",
  "conversationId": "optional-existing-id",
  "date": "2026-08-30",
  "attachments": [
    { "name": "notes.txt", "type": "text/plain", "data": "base64..." }
  ]
}
```

`date` is required by diary and plan flows. Q&A accepts text attachments only;
note modes can stage other permitted attachments for explicit save. A
successful response contains `taskId` and `conversationId`.

Subscribe at `GET /api/knowledge/tasks/:id/events`. This is a standard
`text/event-stream`; reconnect with `Last-Event-ID` to replay the in-memory
backlog. Event names are:

- `state` and `session` for lifecycle/model metadata;
- `activity` and `thinking` for retrieval/generation progress;
- `text` for incremental model output;
- `draft_ready` for an uncommitted note preview;
- `task_error` for a failed task;
- `done` with `completed`, `failed`, or `cancelled` status.

`POST /api/knowledge/tasks/:id/cancel` aborts an active provider request.
`GET /api/knowledge/tasks/:id` returns the current public task state. The
current single-administrator release allows one active task at a time.

## Draft confirmation

Drafts remain in private application state and do not modify the Vault until a
save request succeeds.

| Method and path | Result |
|---|---|
| `GET /api/knowledge/drafts/:id` | Reload a non-expired draft |
| `DELETE /api/knowledge/drafts/:id` | Discard it |
| `POST /api/knowledge/drafts/:id/save` | Confirm edited `content` and optional scratch `title` |

The save endpoint revalidates ownership, expiry, content size, path policy,
symbolic links, write allowlist, and the target hash captured at preview time.
Drafts expire after 24 hours. A concurrent Obsidian edit detected by these hash
checks produces `409 DRAFT_CONFLICT`; a final check-to-rename race with an
external Sync writer still exists.

When an existing note is replaced, the success payload includes a
`recoveryId`. Its verified preimage is stored under private recovery state for
the configured retention period. This recovery copy narrows the impact of the
unavoidable final filesystem race with an external Sync writer; it is not a
distributed transaction or a substitute for backups.

Successful draft create/delete/save responses can include a `warnings` array.
`AUDIT_WRITE_FAILED` means the requested draft or Vault operation completed,
but its metadata audit event could not be appended; the UI reports this as a
post-commit warning so the operator is not misled into repeating the write.
`DRAFT_CLEANUP_FAILED` means a confirmed note was written but expired draft
state still needs operator cleanup.

`POST /api/knowledge/transcribe` intentionally returns `503
TRANSCRIPTION_UNAVAILABLE`; voice input in the bundled UI uses the browser's
optional speech-recognition capability.
