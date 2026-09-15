# Configuration

Use `admin-config.html?knowledgeBaseId=default` after signing in. The query parameter selects the knowledge base for index operations and return links. Model connections and branding are managed centrally; each Vault has separate runtime state and index activation.

## Startup

Minimum: `VAULT_PATH`, a private `DATA_DIR`, `ADMIN_PASSWORD_FILE`, and `SESSION_SECRET_FILE`. Installer-generated files and Docker secrets avoid putting values in command arguments. `HOST`, `PORT`, `SECURE_COOKIE`, and `KNOWLEDGE_BASE_ALLOWED_ROOTS` control the listener and mount boundary. See the reviewed examples and [deployment guide](deployment.md).

Do not mount a host `.claude` directory. The application creates private SDK HOME/config/session directories and uses `settingSources: []`. The model runtime is the pinned Claude Agent SDK, not a separately installed CLI or a host login.

## Models and credentials

The page retains provider, API Base, authentication, model ID, display name, default model, effort, key replacement/preservation/clear, connection checks, save/reload, and branding. It supports up to three enabled models.

The final runtime requires native Anthropic Messages. Existing OpenAI Chat Completions configurations remain visible but fail explicitly with `SDK_PROTOCOL_UNSUPPORTED` until the operator selects a verified native endpoint and revalidates the credential. No one-shot or Pi fallback is used.

| Provider | Native endpoint / status |
| --- | --- |
| Bailian | `https://dashscope.aliyuncs.com/apps/anthropic`; Qwen 3.8 Max real SDK checks passed |
| DeepSeek official | `https://api.deepseek.com/anthropic`; configured `deepseek-v4-pro` real SDK checks passed; provider alias routing caveat below |
| GLM / Kimi | Retained configuration entries; see current protocol and verification status in the migration matrix |
| Custom | A verified public HTTPS Anthropic Messages endpoint; capability and credentials must be checked individually |

Model IDs are preserved exactly. The SDK removes its own `[1M]` context suffix from the wire name and retains corresponding SDK context behavior. It is not an application model substitution.

Qwen 3.8 Max exposes its original Low, Medium and XHigh levels. DeepSeek exposes Low, High and Max. Unknown capabilities use model default. Explicit administrator effort mappings are reported when used. An accepted request proves transport compatibility, not a measured improvement in reasoning quality.

DeepSeek's [Anthropic compatibility document](https://api-docs.deepseek.com/guides/anthropic_api/) describes provider-side model alias routing and ignored compatibility fields. In particular, its documented routing for `deepseek-v4-pro` can change behind the same API identifier. The application records the configured/wire identifier and does not claim to establish the underlying model revision. [Effort support](https://api-docs.deepseek.com/guides/thinking_mode/) is limited to native supported values; token-budget hints are not advertised as enforced DeepSeek reasoning budgets.

## Save and validation

Connection checks run a tool-free query through the actual SDK with a two-turn, 90-second bound. An HTTP provider failure aborts validation instead of automatically retrying. It can incur cost. A successful candidate produces a short-lived, one-use server-side receipt tied to the administrator and configuration revision. The browser drops key fields after submission. Save commits that exact candidate; restart or concurrent edits invalidate receipts.

An active task keeps its connection snapshot. Subsequent tasks use saved changes. Existing SDK sessions may resume after key rotation for the same binding, but endpoint/model/search-binding changes require a new conversation. Model, effort and networking changes in the original UI start a new conversation. Removed model entries do not erase history.

## Embedding

`disabled`, `openai-compatible`, and `dashscope` providers are retained. Desired configuration is shared, but each knowledge base builds and activates its own index. The prior active index remains usable during build, cancellation, or failure. A fresh SDK index needs an explicit build; old Pi vectors are not silently relabeled as the new index.

Building may send every eligible text chunk in the selected Vault. The administrator page supports credential checks, dimension detection, progress, cancellation and activation. Without a usable semantic index, keyword search remains available and hybrid retrieval reports its lexical route. The original tokenizer, chunking, cache and ranking implementation is used. Embedding timeout/batch defaults remain 12 seconds / 20 items; reranking keeps the original 20-second timeout.

## Web, speech and video

Web search is disabled by default. Bailian and Tavily credentials are independent from the model credential. Tavily runs the pinned original `tavily-mcp@0.2.22` through a private credential-file launcher; Bailian implements matching SDK MCP tools with the retained managed provider client. Personal learning reviews skip networking.

The Docker image supplies Python, faster-whisper, yt-dlp, ffmpeg and ffprobe. `KNOWLEDGE_SPEECH_MODEL` can point to a predownloaded model directory; the default small model needs network access on first use. Media HOME/cache is private per Vault. Native source deployments can override `KNOWLEDGE_SPEECH_PYTHON`, `KNOWLEDGE_VIDEO_PYTHON`, `KNOWLEDGE_VIDEO_YT_DLP`, and relevant ffmpeg paths.

The original task budgets and prompt/context behavior are fixed in `src/original/`. Old Pi context-window, research-round, and time-window settings do not control the new SDK loop.
