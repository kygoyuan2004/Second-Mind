# 桌面外壳开发与验证

`main.mjs` 管理独立的可信控制窗口和工作区 WebContentsView。原有本机页面与远程页面都没有 preload；目录选择、状态查询、模式切换等操作仅由桌面控制窗口调用。登录令牌只进入精确匹配的本机页面请求，IPC 状态不会返回令牌。连接之间使用不同的持久化浏览器会话。

开发启动要求项目指定版本的 Node.js 和已安装的 Electron。运行包清单中的桌面启动命令；`SECOND_MIND_DESKTOP_STATE_ROOT` 仅在未打包开发环境下覆盖用户数据目录，可用于隔离测试。开发时不要复用真实用户凭据或已有 Vault。

基础测试：

```sh
node --test test/desktop-shell.test.mjs
```

真实 Electron 集成测试（对应 `test:electron`）：

```sh
node --test test/desktop-shell.electron.mjs
```

Linux 需专用 X11 显示器，例如 Xvfb；当前工作环境可运行：

```sh
DISPLAY=:89 .local/toolchain/node_modules/node/bin/node --test test/desktop-shell.electron.mjs
```

测试用原生文件选择对话框替身授权临时 Vault，启动真实业务后端，验证本机免密码会话、管理员配置页、PDF Blob 框架、远程会话隔离、切换模式以及关闭到托盘。测试移除 IDE 注入的 `ELECTRON_RUN_AS_NODE`。Linux 测试通过调试器注入仅存于内存的 AES 加密替身，避免使用开发者系统密钥环；Windows 使用实际 safeStorage/DPAPI。Linux Electron 启动使用测试专用的 `--no-sandbox`，生产窗口仍开启沙箱。

截图写入 `build/desktop-*-smoke.png`。Linux 从专用 Xvfb 显示器捕获完整窗口；Windows 只捕获 Second Mind 窗口。`BrowserWindow.capturePage()` 不包含子 WebContentsView，因此整体截图使用操作系统屏幕捕获。临时知识库、状态和测试服务器在测试结束时清理。

这些检查不替代干净 Windows 10/11 机器上的安装、ACL、Job Object、DPAPI、录音权限、模型下载、升级和卸载验收。

## Windows 安装包的 SSH 验证

安装完成后，可在单独的测试目录运行同一套测试，直接启动已安装的 EXE，无需给用户机器安装 Node.js、Electron 或浏览器。测试目录保留 `test/desktop-shell.electron.mjs` 和以下纯 JavaScript 测试依赖：`node_modules/playwright`、`node_modules/playwright-core`、`node_modules/@playwright/test`，版本与项目锁文件一致。测试所需 Node.js 直接使用安装目录 `resources/runtime/node/node.exe`。

PowerShell 示例（替换安装目录和测试目录）：

```powershell
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Second Mind'
$acceptanceDir = Join-Path $env:TEMP 'SecondMindAcceptance'
Set-Location $acceptanceDir
$env:SECOND_MIND_PACKAGED_EXECUTABLE = Join-Path $installDir 'Second Mind.exe'
& (Join-Path $installDir 'resources\runtime\node\node.exe') --test test\desktop-shell.electron.mjs
```

该选项只影响测试程序，不增加生产软件调试入口。测试通过子进程的 `LOCALAPPDATA` 将应用状态隔离到临时目录，使用真实安装资源、Windows ACL、Job Object 与 DPAPI；结束后清理临时 Vault。原生目录选择在自动测试中使用明确的临时目录替身。通过 SSH 启动的 Windows 进程可能没有可捕获的交互桌面；此时测试明确记录组合窗口截图不可用，仍验证真实后端与页面行为并保存各页面截图。用户桌面显示、原生对话框操作、录音权限和重装等仍需在实际登录桌面验收。
