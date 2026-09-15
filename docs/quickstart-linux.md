# Linux 快速开始

> English summary: install Docker Engine with Compose v2, clone the repository, and run `./install.sh`. The installer asks only for a Vault or Vault-parent directory, an administrator password, and a local port.

## 前置条件

- 64 位 Linux，`amd64` 或 `arm64`
- Docker Engine 与 `docker compose` v2
- Git
- 一个可读写的 Obsidian Vault，或包含多个 Vault 的父目录
- 当前用户可以访问 Docker daemon
- 常规 rootful Docker Engine；rootless Docker 和 SELinux enforcing 主机需要管理员自行处理 UID 映射、卷权限与 bind-mount relabel，当前快速安装器不自动配置

安装器不会停止现有进程或容器。默认只在 `127.0.0.1` 发布端口；若 `8787` 已占用，会要求选择其他端口。

## 三条命令

```bash
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
./install.sh
```

按提示输入：

1. 单个 Vault，或包含多个 Vault 的父目录；
2. 至少 12 个字符的管理员密码；
3. 本机端口，直接回车使用 `8787`。

安装器优先拉取 `ghcr.io/kygoyuan2004/second-mind:latest` 的对应架构镜像；无法拉取时会从当前检出的源码构建。密码与随机会话密钥保存在安装器的私有配置目录，不写入仓库或 Compose 环境变量。

完成后打开终端显示的 `http://127.0.0.1:端口`，使用账号 `admin` 登录。LLM、WebSearch 与 Embedding 在管理员网页中分别配置；未配置 LLM 时仍可登录、管理知识库并使用关键词检索。

## 多知识库

- 选择单个 Obsidian Vault 根目录时，首次启动会保留单库兼容模式；该根必须包含实际目录（不是符号链接）的 `.obsidian`。
- 选择父目录时，首次启动只会发现其下一层中包含实际 `.obsidian` 目录的 Vault，并为每个目录创建独立知识库。
- 登录后可在工作台切换，也可在管理员页使用已授权挂载点内的相对路径维护注册表。

每个稳定 ID 会永久绑定到首次规范化的 Vault 路径，即使删除注册项或重启也不会释放。另一套 Vault 必须使用新 ID；不要依靠在相同宿主机路径替换内容来复用旧 ID。

服务端状态、索引、会话、草稿、恢复副本与审计记录按知识库隔离；网页和 API 不显示宿主机绝对路径。

## 运维命令

```bash
./install.sh doctor
./install.sh status
./install.sh logs --no-follow --tail 200
./install.sh backup
./install.sh update
```

`doctor` 检查 Docker、目录、数据卷、端口、健康状态与媒体依赖。图片和 PDF 附件通过支持该能力的模型与 Agent SDK 读取；语音和视频依赖容器中的 Python、FFmpeg 和语音模型，首次使用需要下载模型。

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
