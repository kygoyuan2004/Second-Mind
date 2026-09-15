# macOS 快速开始

> English summary: use Docker Desktop on Intel or Apple Silicon, clone the repository, then run `./install.sh`. No host Node.js, OpenSSL, or manual JSON edit is required.

## 前置条件

- macOS，Intel `amd64` 或 Apple Silicon `arm64`
- 已启动 Docker Desktop，且 `docker compose version` 可用
- Git
- 一个可读写的 Obsidian Vault，或包含多个 Vault 的父目录

## 三条命令

```bash
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
./install.sh
```

安装器只询问知识库目录、至少 12 个字符的管理员密码和本机端口。它默认使用多架构 GHCR 镜像，并在拉取失败时从当前源码构建。路径可以包含空格和中文；由于 Docker `--mount` 的参数格式限制，不要选择名称含逗号的目录。

完成后打开终端显示的本机 URL，以 `admin` 登录，再在管理员网页中分别添加 LLM、WebSearch 和 Embedding Provider。API Key 只提交给服务端，保存后不会由 API 或网页回显。

## 单库与多库

- 直接选择 Vault 根目录：使用单库兼容模式；该根必须包含实际目录（不是符号链接）的 `.obsidian`。
- 选择父目录：首次启动只发现下一层中带实际 `.obsidian` 目录的 Vault。
- 每个知识库拥有独立索引、会话、草稿、恢复副本和审计记录；切换不会把正在运行的任务迁移到另一库。

每个稳定 ID 会永久绑定到首次规范化的 Vault 路径，删除注册项或重启不会释放。另一套 Vault 必须使用新 ID；不要在相同宿主机路径替换内容后继续使用旧 ID。

## 日常命令

```bash
./install.sh doctor
./install.sh status
./install.sh logs --no-follow --tail 200
./install.sh backup
./install.sh update
```

安装配置默认位于 `~/Library/Application Support/Second Mind`，每个实例有独立 Compose project、配置目录和数据卷。不要将这里的凭据或备份提交到 Git。

标准镜像在 Linux container 中运行，但没有内置可验证的 `bwrap` 与 `pdftotext` 组合，因此网页 PDF 读取默认关闭。`doctor` 检查 Docker、目录、数据卷、端口、健康状态与媒体依赖。图片和 PDF 附件通过支持该能力的模型与 Agent SDK 读取；语音和视频依赖容器中的 Python、FFmpeg 和语音模型，首次使用需要下载模型。

## 更新、重启、恢复与卸载

```bash
./install.sh update
./install.sh restart
./install.sh backup
./install.sh restore --instance SOURCE_INSTANCE_ID --backup BACKUP_DIRECTORY_NAME --vault "/path/to/恢复 Vault" --port 8789 --non-interactive
./install.sh uninstall
```

- `update` 先备份并保留旧镜像，再更新选中的实例。凭据和数据卷保留；失败会明确报错，不会静默回退数据。
- `restart` 使用本地镜像重新创建并启动容器。
- `backup` 含配置、凭据、运行数据和 Vault，以及三份 SHA-256 清单。它是实时复制，需要严格一致性时先暂停写入与同步；不含独立同步器的账号和远端状态。
- `restore` 要求新的空目录和不同端口，校验备份后创建独立实例。原实例、原卷和笔记保留；使用备份时的管理员密码登录核验。
- `uninstall` 只移除选中实例的容器和网络，保留 Vault、凭据、数据卷、配置和备份。随后可用 `restart` 再启动。

多个实例时使用 `--instance INSTANCE_ID`。恢复失败时保留原实例和恢复现场，不要把两套运行数据合并。

镜像回退、恢复限制及完整命令见 [部署说明](deployment.md)。平台和架构的实测结果见 [迁移验收报告](claude-sdk-migration.md)；支持范围不等于已经完成该平台 Docker Desktop 实测。

默认只绑定本机回环地址。继续阅读：[配置说明](configuration.md) · [网络访问](networking.md) · [同步边界](sync.md)。
