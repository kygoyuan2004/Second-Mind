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

标准镜像在 Linux container 中运行，但没有内置可验证的 `bwrap` 与 `pdftotext` 组合，因此网页 PDF 读取默认关闭。`doctor` 会显示真实能力，不会静默执行无 sandbox 的 PDF 解析。确认后的 PDF 附件仍可持久化，但这不代表应用理解其内容。

## 更新、恢复与卸载

更新前先备份。`update` 保留数据和配置，但不会在新镜像未就绪时自动回滚；关键部署应保留上一镜像并固定经过审查的 tag 或 digest。`backup` 是带内容哈希清单的实时复制；需要严格一致性时先暂停外部同步。它不会自动包含独立同步器的账号、链接、私有卷或远端状态。当前版本的恢复是人工流程：停止本实例，在隔离位置核对备份，再恢复 Vault、配置和数据卷。

卸载容器时，用安装器显示的精确实例配置运行 `docker compose down`，不要使用 `--volumes`。这样保留 Vault、凭据、会话、索引和备份。永久清理必须先列出并二次核对具体配置目录和命名卷；不要把 Vault 目录包含在批量删除中。

## 边界

- 不安装 LaunchDaemon，也不集成 macOS Keychain。
- 应用默认只监听 `127.0.0.1`；不要为了远程访问直接公开端口。
- 远程模型和 Embedding 服务会接收完成其功能所需的选定内容，详见[安全边界](security.md)。

继续阅读：[部署说明](deployment.md) · [配置说明](configuration.md) · [网络访问](networking.md)
