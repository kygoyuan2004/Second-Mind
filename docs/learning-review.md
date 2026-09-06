# Personal learning reviews

Requests such as “总结最近一个月的学习重点” run through the same embedded Pi Agent used by other Q&A. They do not invoke the former server-orchestrated extraction pipeline. Normal and Deep differ only in their bounded Agent budgets; after every tool result, the selected model decides whether to continue the date inventory, search for related material, resolve a note reference, read more original lines, inspect coverage, or answer.

An omitted “我” does not require a subject clarification. “所有”, “全部”, and “所有的” continue the original learning-review question and reuse the time window captured on its first turn, including after restoring or forking a conversation. Public questions about machine-learning research progress remain ordinary Q&A rather than personal learning reviews.

The configured timezone defines calendar boundaries. “最近一个月” starts at local midnight one calendar month before the first request and ends at that request. “上个月” means the preceding calendar month. The server stores this exact `[start, end)` range with the conversation and overrides any different range, timezone, or scope supplied later in a tool call.

Learning reviews are Vault-only. They receive neither `web_search` nor `web_read`, even if the conversation previously enabled Web Search. The stored Web preference remains available for unrelated later questions, subject to the usual conversation-setting rules.

## Agent tools and evidence

The Agent must begin with `list_date_records`. This tool queries the immutable task snapshot for the server-fixed window and exposes the result as a paginated file-modification-time inventory. A page can contain note paths, modification times, logical record identifiers, related paths, and explicit inventory diagnostics. The model must continue with `nextOffset` until the accessible inventory is exhausted or disclose the remaining pages as a coverage gap.

File modification time is an inventory boundary, not proof of when the user learned, completed, or planned something. The Agent must read the relevant original text and distinguish what the note actually says from what can only be inferred from its modification time. Undated text must not be presented as a precisely dated activity merely because the file appears in the window.

The available Vault tools are:

- `list_vault` for bounded, paginated directory and file discovery;
- `search_text` for exact text discovery;
- `search_knowledge` for the existing keyword, semantic, or hybrid retrieval routes;
- `read_note` for hash-checked original lines or continued columns of an oversized line;
- `resolve_note_reference` for shortened or ambiguous Obsidian references;
- `list_date_records` for the fixed, paginated date inventory;
- `get_reading_coverage` for the current task's inventory, discovery, original-read, pagination, truncation, and failure ledger.

Search and inventory results are discovery aids. Only non-empty original text successfully returned by `read_note` can support a Vault citation. Important claims therefore require an original read, and long notes must be continued with `nextStartLine` or `nextStartColumn` until the relevant section is covered. A hash mismatch, serialization/output limit, empty or out-of-range read, excluded path, or changed file cannot become cited evidence.

The answer may classify an item as completed, in progress, planned, or uncertain only to the extent supported by the original note. An unchecked checkbox is evidence of a plan, but absence of a deliverable is not proof of non-completion. Reference notes can explain an activity found in a dated record, but must not silently establish its date or completion status. These are model-answering rules backed by source visibility and citation checks, not a hidden deterministic fact extractor.

## Coverage gates and limits

Before answering, every learning review must call `get_reading_coverage`. The service rejects completion if the Agent never obtained a date inventory or never inspected coverage. The gate proves that those checks occurred; it does not convert a partial inventory or partial read into complete coverage.

The ledger distinguishes, among other things:

- inventory pages covered and still missing, backend truncation, invalid entries, and incomplete metadata;
- files discovered but never read;
- exact read line intervals, partially read long lines, and fully traversed files;
- incomplete directory/reference pagination;
- hash mismatches, tool failures, bounded-result omissions, and partial web state where web tools are available for non-review Q&A.

`get_reading_coverage` does not itself read more content. The Agent must use the reported gaps to decide whether to continue within its remaining budget. The server appends a deterministic coverage section to every learning-review answer, so omitted objects and stable failure reasons remain visible even if the model's prose overlooks them. “Complete” is appropriate only when the accessible inventory pagination and all relevant original reads are complete and the ledger reports no material gap.

Normal learning reviews permit at most 64 Agent model turns and 128 knowledge-tool calls. Deep learning reviews permit at most 128 Agent model turns and 256 knowledge-tool calls. Both use the task's overall timeout, model context/output limits, bounded tool schemas, and at most two controlled retries for transient Provider failures. Pi's separate context-pressure recovery may compact and retry a recoverable length stop once; genuinely exhausting the configured output limit still fails without committing a partial answer. These are ceilings, not promises that a task will consume the full budget or achieve exhaustive coverage. Reaching a turn, tool, output, timeout, context, or Provider limit fails the task or leaves an explicit coverage limitation; it never falls back to the former extraction engine.

The task status and terminal SSE event expose Agent metrics on success and after an in-session failure, including first effective progress, first text delta, total duration, model turns, tool calls, compactions, retries, Provider-reported token usage, capability-probe work, configured limits, and the coverage ledger. Total turn/tool counters include a capability probe when one was performed, while the configured turn/tool ceilings apply only to the subsequent task Agent loop. A failure before an Agent session can be created has no session ledger. A missing Provider usage field is unavailable, not zero.

## Conversation and recovery

Product conversation history remains authoritative. Each turn runs in a disposable Pi JSONL branch under the private `DATA_DIR/pi-sessions` directory. After the answer passes source normalization, the application creates a fresh canonical checkpoint containing only committed product-visible user/assistant messages plus their history digest, then atomically associates its basename with the conversation.

Failed, cancelled, timed-out, or uncommitted work branches are removed and the preceding checkpoint remains valid. Raw note pages, search results, tool payloads, fetched web text, and hidden reasoning are not copied into the product conversation or canonical checkpoint. A missing, unsafe, corrupt, or history-mismatched checkpoint is rebuilt from committed product history rather than trusted as a resume source.

## Deployment and acceptance

Update frontend and backend together. Before restarting a deployed instance, back up and verify the exact existing `DATA_DIR`, managed Provider configuration, knowledge-base registry, conversations, drafts, sync state, and indexes. After an authorized restart, use `/health/live`, `/health/ready`, and the authenticated `/api/knowledge/status` response to verify the current build, selected knowledge base, and index. For independent working copies, follow [the manual replica procedure](sync.md#manual-working-copy-beside-a-fixed-benchmark); copying files alone does not update an already active embedding slot.

Regression tests use synthetic records, fixed clocks, mock tool-capable models, long lines, pagination, changing files, cancellation, canonical-session recovery, and snapshot isolation. Automated success is only an implementation gate. Isolated dialogue acceptance should also assess answer correctness, claim-level source support, actual file/line coverage, first effective progress, total latency, Provider-reported tokens, and every uncovered item with its reason. Keep private evaluation copies, questions, answers, note excerpts, and model transcripts outside the repository. Compare implementations against the same frozen files and reference time, and never modify a fixed benchmark or a running reference service.
