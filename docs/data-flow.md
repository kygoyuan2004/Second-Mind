# Data flow and privacy boundaries

Second Mind keeps Vault files and application state local unless the administrator configures a remote Provider and a user or administrator starts an operation that needs it. No remote model, search, or embedding call is required for startup, sign-in, knowledge-base management, file preview, or BM25 keyword retrieval.

## Component flow

```mermaid
flowchart LR
  U[Authenticated browser] -->|same-origin JSON and SSE| A[Second Mind]
  A --> R[Knowledge-base registry]
  R --> V1[Vault A]
  R --> V2[Vault B]
  A --> T[Task manager]
  T --> PI[Embedded Pi Agent session]
  PI --> K[Snapshot-scoped knowledge tools]
  K --> R
  PI -->|model turns and tool results| L[Selected LLM]
  PI -->|only when explicitly enabled and before Vault results| W[Scoped WebSearch]
  PI --> C[Disposable Pi JSONL branch]
  T -->|successful product commit only| C0[Canonical Pi checkpoint]
  A --> S1[Private state A]
  A --> S2[Private state B]
  A --> G[Global private Provider config]
  A -->|explicit build or semantic query| E[Embedding service]
  W -->|allowlisted safe HTTPS read| P[Public web origin]
  X[External sync process] <--> V1
  X <--> V2
```

The browser never talks directly to a model, embedding endpoint, WebSearch service, or Vault filesystem. It sends an authenticated request to Second Mind. The server fixes one user, knowledge-base revision, index snapshot, model lease, and optional WebSearch lease for the task. Within those bounds, Pi reads each tool result and chooses the next permitted action; the server validates tool arguments, paths, hashes, coverage, citations, and outbound destinations.

## Browser to application

The browser sends:

- login credentials over the deployment's HTTP or HTTPS transport;
- an explicit `knowledgeBaseId` for knowledge operations;
- prompts, selected model/effort/task mode, and the Q&A WebSearch toggle;
- optional attachments within configured limits;
- edited draft Markdown and explicit save confirmation;
- Provider keys only during an administrator replace action.

The server returns an HttpOnly signed session cookie. The browser may retain opaque per-user/per-base selection and conversation IDs, but does not retain Provider keys in localStorage, sessionStorage, URLs, or cookies.

Use HTTPS or a reviewed private tunnel for remote access. The default Compose binding is loopback only.

## Local Vault and private state

Vaults remain ordinary host directories. The application indexes allowed files, reads source previews, and writes only configured diary, plan, and scratch-note destinations after confirmation. Excluded paths such as `.obsidian`, `.trash`, `.git`, `.sync`, `.livesync`, and `node_modules` do not enter search, direct file reads, or model context.

The knowledge-base registry maps stable public IDs to roots under startup-authorized mounts. Absolute host paths are not returned through public or administrator APIs. Each base has isolated indexes, conversations, drafts, recovery copies, audit logs, and embedding slots. Global Provider configuration and registry metadata live in separate private runtime state.

Private state includes derived copies of note content and must be protected like the Vault itself:

- BM25 and vector index files;
- conversation messages and source metadata;
- canonical Pi checkpoints and disposable in-flight Pi session files;
- drafts, temporary attachments, and recovery preimages;
- audit records;
- managed Provider destinations, model names, and credentials;
- registry mount mappings.

Deleting a registry entry does not delete that state or the Vault. Installer backups include Vault, runtime data, and configuration, including secrets.

## LLM egress

An LLM is contacted only when a user creates a generation task and an enabled model is configured. Q&A uses the embedded Pi session and may make multiple bounded model turns. Depending on what the model chooses to inspect, those requests can contain:

- the current prompt;
- up to the bounded recent complete conversation turns used for continuity;
- schemas for the limited knowledge tools and the bounded results of calls the model selected;
- Vault search candidates, titles, relative paths, and original line ranges returned incrementally by those tools;
- text attachment excerpts;
- bounded WebSearch snippets or safely extracted public-page text when enabled;
- system instructions and output contracts;
- selected model and reasoning parameters.

Images and PDFs can be stored with confirmed note drafts but are not sent as multimodal Q&A input by the current task API. Q&A accepts text attachments only.

The model does not receive credentials, host absolute paths, index vectors, the registry document, arbitrary Vault access, a shell, an MCP client, or a general fetch tool. Search hits are discovery only. Source normalization permits a Vault citation only after non-empty, hash-verified original text from that path was returned through `read_note`; merely listing or searching for a path is insufficient.

A task leases its exact model connection and revision at creation. Later configuration edits do not redirect the in-flight task. Provider failures are redacted before they reach browser errors or logs.

The Pi SDK is given an empty resource loader and no built-in shell, read, edit, write, extension, skill, prompt, or `AGENTS.md` resources. It does not inherit host Pi/Claude configuration or credentials. Normal and Deep use the same execution engine with different model-turn and tool-call ceilings; production does not fall back to the former fixed retrieval/text-generation flow when Pi binding or tool capability checks fail.

## Pi session and conversation flow

The product conversation store is authoritative. For each request, Second Mind resumes a validated canonical checkpoint or rebuilds from committed product messages, then lets Pi work in a disposable JSONL branch. Raw tool results and hidden reasoning may exist in that branch only while the task is in flight.

After source and link normalization succeeds, the application creates a new canonical JSONL containing only committed product-visible user/assistant messages and a digest of that history. The conversation is associated only with its validated basename. A failed, cancelled, timed-out, or uncommitted task removes its work/pending branch and retains the preceding checkpoint. Deleted-conversation and superseded checkpoints are reclaimed, and startup prunes unreferenced safe session files.

## Embedding egress

Embedding is optional. BM25 remains local and requires no embedding call.

Remote text leaves the host in two cases:

1. An administrator confirms `validate-and-build` for the selected knowledge base. A probe may be sent to determine vector dimensions, followed by all eligible text chunks for that base.
2. A user requests semantic or hybrid retrieval against an active remote embedding profile. The search query is sent to create its query vector.

The desired embedding configuration is global, while active and previous vector slots are isolated per base. A candidate build does not become active until it completes. Failure or cancellation keeps the previous active index. Startup never triggers the first paid build.

Embedding responses and vectors are stored in local private index state. The configured Provider may retain request data according to its own terms.

## WebSearch egress

WebSearch is off by default and is only available for eligible Q&A. Learning reviews receive no web tools. Enabling it in one conversation does not enable it for another. When enabled, Pi may call the bounded `web_search` wrapper backed by the selected Alibaba Model Studio WebSearch MCP connection or Tavily REST connection.

Each Web-enabled Pi turn starts without prior conversation text or a resumed Pi checkpoint. Only the current request is loaded before WebSearch is available. This prevents private Vault text or paths from an earlier answer from becoming a later outbound query; a context-dependent Web question must restate the needed public context. After any Vault tool result is exposed in the current task, both `web_search` and `web_read` stay closed for the remainder of that task, so URL choice and request order cannot become a post-Vault disclosure channel.

The model cites a successfully read Web source with its opaque per-task ID, not a URL. Answer text remains server-buffered while Vault citations and external source IDs are checked. The server strips generated Markdown/HTML links and alone mints the final escaped HTTPS anchors; the assistant renderer unwraps any remaining unmarked anchor, including GFM `www` and email autolinks.

All Web calls must finish before private Vault access. Both `web_search` and `web_read` are permanently denied after any Vault tool result has been exposed. This ordering prevents note text or private paths learned from the Vault from becoming a later query or URL-selection signal. Search responses are treated as untrusted evidence. The application normalizes URLs, bounds results and context, records provider/source identity and failures in the coverage ledger, and can continue with Vault-only evidence when the remote path is unavailable. Pi cannot select a different provider, inspect its credential, or issue arbitrary network requests.

The selected WebSearch provider has its own credential. It does not receive an LLM or embedding key. An explicitly enabled extraction fallback may reuse only the selected WebSearch credential.

## Safe selected-page reading

Optional page reading begins only when Pi calls `web_read` with the exact HTTPS URL of a candidate returned earlier by the same task's `web_search`. It is not a general URL fetcher. For each request, the reader:

- allows public `https:` URLs only;
- rejects URL credentials, fragments as authority, and unsupported ports/schemes;
- resolves DNS and rejects loopback, private, link-local, multicast, reserved, and otherwise non-public IPs;
- connects to the validated address while preserving TLS hostname verification;
- revalidates each redirect;
- bounds redirects, response bytes, decoded characters, pages, concurrency, and time;
- accepts only configured HTML/text content, plus sandboxed PDF when explicitly available.

Fetched text is untrusted and enters the Pi model context as delimited evidence. Partial bodies and failures remain visible in the coverage ledger. Page text never becomes an instruction that can widen filesystem, network, or tool permissions.

The standard image does not contain the required sandboxed PDF toolchain, so PDF reading reports unavailable instead of using an unsandboxed fallback.

## Administrator validation egress

Saving a Provider change is separate from validating it. Explicit model validation performs a real unpredictable nonce tool call and a later assistant response that consumes its result; a text-only response is not accepted as Pi-ready. WebSearch validation can make a small search request. Embedding validation can start the full-base operation described above. These actions may incur cost even if the candidate later fails.

Validation receipts are short-lived, one-use, bound to the administrator and source revision, and kept in process memory. They avoid persisting candidate keys in browser storage. Read APIs return configured booleans rather than secret values.

## Draft and write flow

```text
prompt -> optional remote generation -> private draft outside Vault
       -> browser review/edit
       -> explicit save
       -> owner, base, path, symlink, expiry, and hash checks
       -> optional verified recovery preimage
       -> temporary file and atomic rename inside the selected Vault
       -> per-base audit append
```

There is no distributed transaction with an external sync process. A content hash and final checks reduce races but cannot make two independent filesystem writers atomic. Preserve sync conflicts and maintain tested backups.

## External sync flow

Second Mind never uploads or reconciles a Vault on its own. If `SYNC_PROVIDER` labels a Headless or external sync process, that process has a separate network, account, encryption, and filesystem trust boundary. Its data flows and retention are governed by its operator and provider.

Do not run two sync engines against the same local Vault. Sync is not backup. See [sync.md](sync.md).

## Data-egress decision table

| Operation | Vault read | Vault write | Remote LLM | Remote embedding | Web/Search network |
|---|---:|---:|---:|---:|---:|
| Startup and lexical indexing | Yes | No | No | No | No |
| Sign-in or configuration GET | No | No | No | No | No |
| BM25 search and source preview | Yes | No | No | No | No |
| Semantic/hybrid query | Yes | No | No | Yes, if remote profile active | No |
| Provider validation | No | No | Selected model only | Probe for embedding action | Selected search/extractor only |
| Embedding build | Yes | No | No | Yes, eligible chunks | No |
| Q&A without web | Yes, only through scoped tools | No | Yes, bounded Pi turns and selected tool results | Maybe when Pi selects semantic/hybrid retrieval | No |
| Q&A with web | Yes, only through scoped tools | No | Yes, bounded Pi turns and selected tool/web results | Maybe when Pi selects semantic/hybrid retrieval | Yes, search must precede Vault results |
| Generate note draft | Maybe | No | Yes | Maybe for retrieval | No |
| Confirm draft | No new model context | Yes | No | No | No |
| Installer backup | Yes | No | No | No | No, except any separately running sync |

For sensitive Vaults, choose local-compatible services where appropriate, or accept that selected content leaves the host. Apply the remote Provider's retention, training, regional, contractual, logging, and access-control terms to that data.
