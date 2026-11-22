# Windows 运行时第三方组件

版本、下载 URL 和 SHA-256 详见安装目录 `resources/runtime-lock.json`。JavaScript 依赖明细在 `resources/backend/third-party-dependencies.json`，每个依赖的原始许可和说明保留在相应包目录。以下链接指向组件原始项目及许可材料。

| 组件 | 版本 | 原始项目及许可 |
| --- | --- | --- |
| Node.js | 22.22.0 | [nodejs.org](https://nodejs.org/en/about/previous-releases)，MIT 及其第三方许可，`runtime/node/LICENSE` |
| CPython Windows embedded | 3.12.10 | [python.org](https://www.python.org/downloads/release/python-31210/)，PSF，`runtime/python/LICENSE.txt` |
| FFmpeg essentials | 8.1.2 | [Gyan 构建](https://www.gyan.dev/ffmpeg/builds/)、[FFmpeg 源码](https://ffmpeg.org/releases/)，保留 `runtime/ffmpeg` 中 GPL 及构建说明 |
| Microsoft Visual C++ Runtime | 14.0 Desktop x64 AppX | [微软组件下载](https://learn.microsoft.com/en-us/troubleshoot/developer/visualstudio/cpp/libraries/c-runtime-packages-desktop-bridge)，原始 AppX 文件材料保留于 `runtime/vclibs` |
| faster-whisper | 1.2.1 | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)，MIT |
| CTranslate2 | 4.8.1 | [OpenNMT/CTranslate2](https://github.com/OpenNMT/CTranslate2)，MIT 及随包运行库许可 |
| PyAV | 18.1.0 | [PyAV](https://github.com/PyAV-Org/PyAV)，BSD，FFmpeg 库按其随包许可 |
| huggingface-hub | 1.28.0 | [huggingface_hub](https://github.com/huggingface/huggingface_hub)，Apache-2.0 |
| yt-dlp | 2026.8.19 | [yt-dlp](https://github.com/yt-dlp/yt-dlp)，Unlicense 及随包依赖许可 |
| yt-dlp-ejs | 0.8.0 | [yt-dlp/ejs](https://github.com/yt-dlp/ejs)，Unlicense、MIT、ISC；使用内置 Node 处理网站 JavaScript challenge |
| Claude Agent SDK | 0.3.247 | [Anthropic SDK](https://github.com/anthropics/claude-agent-sdk-typescript)，以随包 README 的许可条款为准 |
| small 语音模型 | revision `536b0662742c02347bc0e980a01041f333bce120` | [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small)，MIT，首次使用另行下载 |

其余 Python wheel 的 `.dist-info` 许可材料完整保留在 `runtime/python/Lib/site-packages`。Electron 运行目录自带 `LICENSE.electron.txt` 与 Chromium 的 `LICENSES.chromium.html`。独立组件的许可不因桌面应用的许可声明而改变；外部分发时需随相应组件满足其许可的源码及通知要求。
