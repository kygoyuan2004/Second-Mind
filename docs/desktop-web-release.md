# Desktop and Docker Web validation

This release uses one application backend and UI with Claude Agent SDK 0.3.247. Windows packages use an NSIS per-user installer. Linux x86_64 packages include a private Node, Python, FFmpeg and media dependencies built from the same Docker runtime. A Linux desktop session and an unlocked Secret Service keyring are required to persist a desktop credential. The speech model downloads on first use. An existing Qwen ASR installation can be selected on a GPU server with the absolute paths in `KNOWLEDGE_ASR_PYTHON` and `KNOWLEDGE_ASR_MODEL_DIR`. Set `KNOWLEDGE_ASR_ALIGNER_DIR` for timestamped video when its location differs from the model's sibling directory.

Use the desktop setup for a local Vault or a separate HTTPS server connection. Use the Docker setup to host the web workspace. Select a knowledge base before generating a draft. The plan editor previews dated items with explicit start and end times. Confirmation writes the Markdown and records the scheduled entries with a retry receipt. The daily view checks per-event revisions before saving edits.

| Check | Environment and observed result |
|---|---|
| Models | Real SDK checks on an isolated Linux server using public notes. Bailian, DeepSeek, Kimi and a custom connection to DeepSeek each produced two consecutive answers. Private credentials were entered in the application settings and retained across a restart. |
| Search and evidence | A DeepSeek learning review linked back to the highlighted original paragraph. A separate question used the configured Tavily connection. |
| Plan | Two reviewed items were saved to the demonstration Vault and opened in the daily schedule. Automated API checks also exercised repeat confirmation, receipt replay after restart, stale edits and knowledge-base selection. |
| Linux desktop | Packaged x86_64 desktop launched the local backend, opened a Chinese Vault path and switched to isolated remote connections. Installer and distribution-specific evidence is listed in release notes. |
| Windows desktop | Windows x64 installer built. A Windows Server CI result and any Windows 10/11 client results must be identified separately in release notes. |
| Docker Web | The Linux image builds from an allowlisted context. Host OS, architecture and runtime checks must be reported individually. |

Desktop and Web installations keep their state outside the selected Vault. Preserve both the Vault and the application state when making backups. Keep your previous installer and the backup made before upgrading. The Windows uninstall flow normally preserves user data. Linux package removal leaves the Vault and per-user desktop state in place. Previous migration reports describe the versions identified in those reports.
