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

`doctor` 检查 Docker/Compose、Linux container 模式、CPU 架构、目录、数据卷、端口、磁盘用量、健康端点与 PDF sandbox 状态。标准镜像不包含 `bwrap`/`pdftotext`，因此网页 PDF 读取默认关闭；不会回退到无 sandbox 执行。确认后的 PDF 附件仍可持久化，但这不代表应用理解其内容。

`backup` 生成带 SHA-256 清单的实时副本。它不是卷与 Vault 的原子时间点快照；需要严格一致性时，应先暂停外部同步与写入。备份含凭据与私人内容，应加密保管；它不会自动包含独立同步器的账号、链接、私有卷或远端状态。

## 更新、恢复与卸载

先备份，再执行 `update`。安装器优先拉取适配架构的 GHCR 镜像，拉取失败时使用当前源码构建，并保留原实例的数据卷和配置。它不会在新镜像未就绪时自动回滚；关键部署应保留上一镜像并固定经过审查的 tag 或 digest。

当前版本不提供自动恢复。应停止本实例，在隔离目录检查备份和清单，再人工恢复 Vault、私有配置与数据卷。

卸载容器时，根据安装器显示的精确实例信息运行对应 `docker compose down`，不要带 `--volumes`。默认保留 Vault、凭据、会话、索引和备份。永久删除前必须再次核对具体配置目录和命名卷；不要对用户目录或 Vault 做递归批量删除。

## 边界

- 不安装 Windows Service，也不集成 Credential Manager。
- 使用 Linux containers；Windows containers 不受支持。
- 默认只绑定本机回环地址。远程访问应放在受审查的 HTTPS 或私有网络入口后。

继续阅读：[部署说明](deployment.md) · [配置说明](configuration.md) · [网络访问](networking.md)
