# Data flow and privacy

Self-hosting controls storage and credentials. It does not make an external model local.

| Action | Local processing | Possible external data |
| --- | --- | --- |
| Login, settings read, registry changes | Authentication and private configuration | None from the application |
| Keyword indexing/search | Vault reads, tokenizer, lexical index | None |
| Q&A or writing | Original task preparation and SDK tools | User input, accepted attachments, selected note excerpts, conversation context |
| Semantic index build | Chunking and candidate index | All eligible chunks in the selected Vault to the embedding provider |
| Semantic query / rerank | Local candidate merge and ranking cache | Query and eligible candidate text to configured retrieval services |
| Web supplement | Original SDK MCP tool calls | Search queries; selected result URLs to search/extract services |
| Speech/video | Python transcription, ffmpeg frames | First-use public model download; video URLs to their hosts; selected frames/transcript to the model |
| Draft preview / save | Private draft, administrator edits, constrained Vault write | No additional model call for save |
| Independent synchronization | Separate sync process | Determined by that tool's account and destination |

## Credentials

The administrator submits credentials through authenticated, reauthenticated configuration mutations. GET responses return configured status, never a saved key. Keys do not enter browser storage or URLs. Changes to endpoint/protocol require replacing or clearing the corresponding credential.

Each SDK task receives a random credential for its local transport. The application server attaches the real key only to the configured upstream HTTPS request. SDK HOME/config/session directories are private and separated by knowledge base and binding. Host `~/.claude` is not loaded. The Tavily MCP worker reads its credential from a task-private file, avoiding SDK-serialized command arguments.

## Content boundaries

Read-only tools can return note content from the selected Vault to the model. The prompt treats notes, attachments, and web pages as untrusted data. Tool permissions and root checks enforce the access boundary; prompt wording alone is insufficient. Keep secrets outside the Vault and private runtime state outside indexed directories.

Learning reviews skip web tools. Other Q&A tasks receive web tools only when explicitly enabled and configured. The original agent chooses when they are useful. There is no old Pi rule that permanently closes web access after the first local read.

Private backups contain credentials and conversation data. Do not publish backup archives, raw SDK sessions, runtime logs, or acceptance answers. Public screenshots must use a separate demonstration Vault. See [security](security.md).
