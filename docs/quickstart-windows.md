# Windows 10/11 快速开始

> English summary: run Docker Desktop with the WSL2 backend and Linux containers, clone the repository, and launch `install.ps1` from PowerShell.

## 前置条件

- Windows 10/11 x64 或 ARM64
- Docker Desktop，启用 WSL2 backend 与 Linux containers
- Git
- 一个可读写的 Obsidian Vault，或包含多个 Vault 的父目录

确认 Docker Desktop 已启动：

```powershell
docker version
docker compose version
```

## 三条命令

```powershell
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装器只询问知识库目录、至少 12 个字符的管理员密码和本机端口。Windows 盘符、空格和中文路径会被保留；目录名不要包含逗号，因为 Docker `--mount` 的 CSV 参数无法可靠表达这类路径。

安装器使用 Docker 中的共享 Node 22 初始化逻辑，宿主机不需要安装 Node.js、OpenSSL 或执行 `chmod`。它会验证配置目录是专用目录，再限制 Windows ACL；密码不会出现在 Docker 命令参数或 `.env` 中。

完成后打开终端显示的 `http://127.0.0.1:端口`，使用账号 `admin` 登录。模型、联网搜索与 Embedding 均在管理员网页中配置；三个服务的凭据彼此独立。

## 多知识库

- 选择一个 Vault 根目录时，应用保留单库兼容状态；该根必须包含实际目录（不是符号链接）的 `.obsidian`。
- 选择包含多个 Vault 的父目录时，首次启动只发现下一层中带实际 `.obsidian` 目录的 Vault。
- 工作台选择器绑定搜索、引用、会话、任务和草稿；运行中的任务继续固定在创建它的知识库。

每个稳定 ID 会永久绑定到首次规范化的 Vault 路径，删除注册项或重启不会释放。另一套 Vault 必须使用新 ID；不要在相同宿主机路径替换内容后继续使用旧 ID。

## 运维命令

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 doctor
powershell -ExecutionPolicy Bypass -File .\install.ps1 status
powershell -ExecutionPolicy Bypass -File .\install.ps1 logs --no-follow --tail 200
powershell -ExecutionPolicy Bypass -File .\install.ps1 backup
powershell -ExecutionPolicy Bypass -File .\install.ps1 update
```

`doctor` 检查 Docker、目录、数据卷、端口、健康状态与媒体依赖。图片和 PDF 附件通过支持该能力的模型与 Agent SDK 读取；语音和视频依赖容器中的 Python、FFmpeg 和语音模型，首次使用需要下载模型。

## 更新、重启、恢复与卸载

```powershell
.\install.ps1 update
.\install.ps1 restart
.\install.ps1 backup
.\install.ps1 restore --instance SOURCE_INSTANCE_ID --backup BACKUP_DIRECTORY_NAME --vault "C:\Notes\恢复 Vault" --port 8789 --non-interactive
.\install.ps1 uninstall
```

- `update` 先备份并保留旧镜像，再更新选中的实例。凭据和数据卷保留；失败会明确报错，不会静默回退数据。
- `restart` 使用本地镜像重新创建并启动容器。
- `backup` 含配置、凭据、运行数据和 Vault，以及三份 SHA-256 清单。它是实时复制，需要严格一致性时先暂停写入与同步；不含独立同步器的账号和远端状态。
- `restore` 要求新的空目录和不同端口，校验备份后创建独立实例。原实例、原卷和笔记保留；使用备份时的管理员密码登录核验。
- `uninstall` 只移除选中实例的容器和网络，保留 Vault、凭据、数据卷、配置和备份。随后可用 `restart` 再启动。

多个实例时使用 `--instance INSTANCE_ID`。恢复失败时保留原实例和恢复现场，不要把两套运行数据合并。

镜像回退、恢复限制及完整命令见 [部署说明](deployment.md)。平台和架构的实测结果见 [迁移验收报告](claude-sdk-migration.md)；支持范围不等于已经完成该平台 Docker Desktop 实测。

默认只绑定本机回环地址。继续阅读：[配置说明](configuration.md) · [网络访问](networking.md) · [同步边界](sync.md)。
