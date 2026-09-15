# Second Mind

Ask your Obsidian notes, review your learning, and turn ideas into records you approve.

[中文](README.md) · [Project site](https://kygoyuan2004.github.io/Second-Mind/en/) · [Configuration](docs/configuration.md) · [Migration and validation](docs/claude-sdk-migration.md)

![Real SDK answer with sources from public demonstration notes](docs/assets/second-mind-qa.png)

Second Mind is a self-hosted knowledge workspace for one administrator. Claude Agent SDK runs the actual search, read, tool, and conversation loop. Diaries, plans, scratch notes, and video notes remain drafts until you review and confirm them.

## Install

Install Git and Docker first. Use Docker Engine with Compose v2 on Linux, or Docker Desktop with Linux containers on Windows and macOS.

```bash
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
./install.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer configures your Vault directory, port, and administrator password. The host does not need Node.js. Add a model connection in Settings after signing in. Local keyword search works without model credentials.

[Windows 10/11](docs/quickstart-windows.md) · [macOS Intel / Apple Silicon](docs/quickstart-macos.md) · [Linux amd64 / arm64](docs/quickstart-linux.md) · [Docker and backups](docs/deployment.md)

See the [validation matrix](docs/claude-sdk-migration.md) for the distinction between supported platforms and environments actually tested.

## Features

| Workflow | Behavior |
| --- | --- |
| Questions and sources | Keyword, semantic, or hybrid search; original reads; clickable source previews |
| Normal / Deep | 20 turns over 10 minutes, or 50 turns over 30 minutes with up to two conditional read-only subagents |
| Learning reviews | Fixed date ranges, an inventory before reading, evidence of completion versus plans, and coverage reporting |
| Writing | Editable Markdown drafts, explicit confirmation, concurrent-change detection, and recovery copies before replacing notes |
| Attachments and media | Images and PDF for Qwen 3.8 Max; local speech transcription and video frames/transcripts |
| Multiple Vaults | Separate indexes, sessions, tasks, drafts, citations, and write destinations |
| Settings | Connections, default model, native effort levels, web search, embedding builds, branding, and Vault registry |
| Conversations | Reopen history after a refresh; SDK resume after restart; start a new conversation when model, effort, or web settings change |

## Actual application screenshots

These screenshots use independent public demonstration notes and real Qwen 3.8 Max tasks through Bailian. Diary and plan previews show edits that remove extra model explanations through the existing editor. Review remains necessary before saving.

| Tool execution | Provider settings |
| --- | --- |
| ![Actual search and read events](docs/assets/second-mind-execution.png) | ![Server-side provider configuration without exposed keys](docs/assets/second-mind-provider-config.png) |

| Diary preview | Plan preview |
| --- | --- |
| ![Edited diary awaiting confirmation](docs/assets/second-mind-diary.png) | ![Edited plan awaiting confirmation](docs/assets/second-mind-plan.png) |

## Runtime and privacy

The original `@anthropic-ai/claude-agent-sdk@0.3.247` is pinned. Bailian and DeepSeek have passed isolated real SDK core checks; results for other providers are listed separately. Configured model IDs are preserved. Provider-side alias routing is outside the application's control.

Each task pins its connection and credential. Real provider keys stay in the application server; SDK subprocesses receive a temporary local transport token. The SDK uses private state and does not read host `~/.claude` settings. External models receive questions, attachments, and selected note excerpts; remote embedding services receive indexed text. [Data flow](docs/data-flow.md) · [Security](docs/security.md)

The previous executor is archived under `archive/pi/`, outside production imports, dependencies, and image context. Migration preserves original conversation and draft files while creating separate SDK state.

## Development

Use Node.js 22.22+ or 24.8+. Docker includes the media runtime.

```bash
npm ci
npm run check
npm test
npm run site:check
```

[Architecture](docs/architecture.md) · [API](docs/api.md) · [Learning reviews](docs/learning-review.md) · [Deployment](docs/deployment.md) · [Sync](docs/sync.md)

MIT License. Designed for one trusted administrator; no multi-tenant permissions or cross-Vault federated retrieval.
