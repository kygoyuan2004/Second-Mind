# Windows 构建与验证

在 Second Mind 项目根目录中执行以下命令。构建输入为当前版本的源码、锁文件和经过哈希验证的运行组件。

## 可重复构建

构建机安装 Node.js 22.22.0、Python 3.12 和 Windows .NET Framework C# 编译器（Windows 自带）。

```powershell
npm ci
npm run check
npm test
npm run desktop:build:win
```

`scripts/windows-runtime-lock.json` 固定所有运行时 ZIP、AppX、Python wheel 的 URL、版本和 SHA-256。准备脚本使用标准库下载、校验和解压，不执行第三方安装脚本。Windows 条件依赖也已锁定。`build/runtime/win-x64/manifest.json` 提供所有解压后文件的校验值。

`scripts/build-windows.mjs` 构建原生 ACL/Job Object 助手，将源码及独立 `npm ci --omit=dev --os=win32 --cpu=x64` 产物置于 `build/backend`，检查 SDK 的 Windows x64 包版本为 `0.3.247`。Electron 只把桌面外壳装入 ASAR；独立 Node、Python、FFmpeg、SDK 可执行文件和后台源码位于真实资源目录。

后台 `node_modules` 使用独立的资源复制入口，避免 electron-builder 默认过滤整棵依赖目录。`afterPack` 在生成安装器之前逐文件校验全部后台依赖；缺失依赖或内容不一致时直接终止构建。

输出目录为 `dist/windows`，包含 NSIS 安装 EXE、SHA256SUMS.txt 和使用说明。首版安装器不签名，不包含自动更新服务；版本升级使用完整新安装包。CI 工作流可手动触发，不会自动发布到外部服务。

Linux 可以执行 `python3 scripts/prepare-windows-runtime.py` 交叉准备运行时。交叉构建还需要从本仓库 C# 源码编译出的平台助手，以及 electron-builder 的 Windows/NSIS 工具。`scripts/nsis-uninstaller.mjs` 仅对 Linux 的未签名 NSIS 中间产物执行提取，并通过 `nsis-uninstaller-resources.mjs` 应用 NSIS `WriteUninstaller` 的资源补丁、验证编译器原有 CRC，避免上游 electron-builder 26.15.3 解包器遗漏图标资源造成卸载程序无法运行。该适配仅支持锁定的 builder 26.15.3 / NSIS 3.0.4.1；不修改或禁用 CRC。设置 `SECOND_MIND_NSIS_USE_WINE=1` 可使用上游默认行为，Windows 构建仍直接执行原生 `WriteUninstaller`。成功交叉打包不能代替 Windows 实机验收。

## CI 对安装产物的验证

`.github/workflows/windows-build.yml` 在 `windows-2022`（Windows Server 2022）上运行源码检查与测试，生成 NSIS EXE，再将该 EXE 静默安装到 runner 的临时目录。后续检查使用安装目录内的 Node、原生辅助程序、Python、FFmpeg 与依赖，避免只验证构建暂存目录。

- `windows-native-acceptance.mjs` 验证真实 ACL、长路径、目录链接、文件清单、原子写入与 Job Object 进程树清理。
- `windows-media-acceptance.mjs` 验证离线媒体 DLL、视频与音频命令、中文路径和取消清理；转写环节明确使用测试替身，不下载模型，也不代表真实语音识别通过。
- `test/desktop-shell.electron.mjs` 启动安装后的 Electron EXE，验证本机后端、Windows DPAPI、原生目录选择流程、多库增删、远程会话隔离与托盘行为。远程服务器为本机模拟服务；麦克风硬件和真实上游不在此自动化范围。

三组产物检查独立运行并影响 CI 结果。工作流始终上传安装器哈希、各组日志、JSON/TXT 报告和可用截图到 `SecondMind-windows-server-2022-acceptance`；只有前面步骤成功，才上传可交付安装包。服务会话可能无法截取完整可见桌面，这会记录为诊断信息，不能据此声称已验收真实交互桌面。

在另一台 Windows 测试机上，可用以下方式重复原生检查（所有生成的测试文件写入 `--work-dir`）：

```powershell
$r = 'D:\AI_Knowledge_software\installed\resources'
& "$r\runtime\node\node.exe" scripts/windows-native-acceptance.mjs --backend "$r\backend" --work-dir 'D:\AI_Knowledge_software\acceptance-native' --label 'Windows 实机安装产物'
& "$r\runtime\node\node.exe" scripts/windows-media-acceptance.mjs --resources $r --work-dir 'D:\AI_Knowledge_software\acceptance-media'
$env:SECOND_MIND_PACKAGED_EXECUTABLE = 'D:\AI_Knowledge_software\installed\Second Mind.exe'
& "$r\runtime\node\node.exe" --test test/desktop-shell.electron.mjs
```

GUI 自动化脚本从本项目测试目录启动，需要开发测试依赖；被测 EXE 及其后端使用安装包自带组件。CI runner 带有开发工具且运行 Windows Server，不能替代下方无预装环境的 Windows 10/11 验收。

某些 Windows SSH 服务会给子进程启用 `SeBackupPrivilege` 和 `SeRestorePrivilege`，导致目录读取能够绕过真实 ACL 拒绝规则。源码权限测试通过 `scripts/windows-test-user-token.ps1` 启动：它只关闭本次 PowerShell 进程及其 Node 子进程的这两个特权，验证关闭结果并记录到输出，不修改账号、本机策略或 SSH 服务。其余管理员权限仍保留，因此它不代表完整的普通用户或交互桌面验收。CI 同样使用此入口。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-test-user-token.ps1 -NodePath "$r\runtime\node\node.exe" -ProjectRoot $PWD.Path
```

包装器默认运行 `scripts/run-tests.mjs`；可通过 `-NodeArgumentsJson` 传入 JSON 字符串数组执行指定测试。编译临时文件位于测试项目的 `build/test-token-*`，运行结束后清理，并返回 Node 测试进程的退出码。

## Windows 验收清单

在无 Node/Python/Git/Docker/WSL 的 Windows 10 与 Windows 11 x64 虚拟机上分别验收，并记录系统版本、安装器 SHA-256、日期及结果：

- 当前用户安装、首次选库、启动、托盘恢复、明确退出及重装/升级的数据保留。
- 中文/空格/跨盘符 Vault、文件占用、目录链接、越界读写、多库 ID 绑定和配置保存。
- 问答与深度问答、SSE、工具调用、引用预览、关键词/语义/混合检索、草稿保存/冲突/恢复、会话恢复和取消。
- 本机与两个远程连接的认证隔离、HTTPS 证书错误、可信 HTTP、断线重连和麦克风权限。
- 图片/PDF/录音/视频上传/视频链接；首次模型下载、进度、断网重试和 CPU/int8 离线识别。
- 退出、后台崩溃、下载取消与窗口模式切换后，任务状态和后台进程树符合预期。
- 真实模型、Embedding 和联网服务使用专用测试配置，记录服务/版本与实际结果。

自动测试使用模拟服务时不计作真实上游验收。CI 的 Windows runner 不等同于干净 Windows 安装后的完整 GUI 验收；交付记录必须区分两者。
