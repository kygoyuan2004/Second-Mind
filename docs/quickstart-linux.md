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

`doctor` 检查 Docker/Compose、Linux container 模式、架构、路径、卷、端口、磁盘、健康状态与 PDF sandbox 能力。仓库提供的标准镜像没有安装 `bwrap` 和 `pdftotext`，因此网页 PDF 读取默认关闭并会如实显示不可用；HTML 安全读取和确认后的 PDF 附件持久化不受此项影响，但后者不理解 PDF 内容。

`backup` 是带 SHA-256 清单的实时副本，不是原子快照。需要严格时间点一致性时，应先暂停外部 Vault 同步与写入。备份包含 Vault、运行数据和部署配置，必须按敏感数据保护；它不会自动包含独立同步器的账号、链接、私有卷或远端状态。

## 更新、恢复与卸载

### 直接运行源码的服务

使用 Node/systemd 直接运行源码时，更新文件后必须重启对应的后台服务。
后台路由在进程启动时载入，而浏览器资源会从磁盘读取；只更新源码而不重启，可能让新页面请求旧进程没有的接口。
如果登录后提示“知识库服务需要更新”，应重启部署时配置的服务，再刷新页面并点击“重新连接”。

重启前等待当前任务完成，保留原有 Vault、运行数据目录和配置。
重启后先检查 `/health/ready`，再通过正常登录的浏览器确认 `/api/knowledge/bases`、`/api/knowledge/status` 返回成功；单库源码部署也应返回一个默认知识库。
最后恢复历史会话、执行一次关键词搜索并打开来源预览，确认完整路径和唯一缩写均可读取。
对于多库部署，这些知识库请求应携带当前 `knowledgeBaseId`。

来源预览通过只读 `/api/knowledge/resolve?path=...` 定位文件，再使用 `/api/knowledge/file?path=...` 读取。
解析优先使用完整路径；缩写只在唯一匹配时自动打开，重名时由用户选择完整路径。

### 使用安装器的部署

更新前先运行 `./install.sh backup`，再执行 `./install.sh update`。更新会拉取发布镜像；若不可用，则从当前源码构建，并在原有独立数据卷上重建容器。安装器不会在新镜像未就绪时自动回滚；关键部署应保留上一镜像并固定经过审查的 tag 或 digest。

当前版本没有自动恢复命令。恢复时应先停止本实例，在隔离目录验证备份清单和内容，再由管理员恢复 Vault、私有配置及数据卷。不要在同步程序写入时覆盖 Vault。

卸载容器时使用安装器输出的精确 Compose project 与配置目录执行 `docker compose down`，不要加 `--volumes`；这样默认保留 Vault、私有配置、凭据、会话和索引。永久删除前应先备份，并分别核对精确的数据卷和配置目录；Vault 永远需要单独、明确地处理。

## 已知边界

- 这是单管理员、自托管应用，不是多租户服务。
- 不安装 systemd 服务；原生 Node/systemd 仅作为高级人工部署方式。
- Docker `--mount` 的 CSV 参数不能可靠表达包含逗号的宿主机目录名，请先选择不含逗号的父目录。
- 远程 LLM 会接收问题、所选笔记片段和近期会话；远程 Embedding 会接收索引文本和查询；只有显式启用联网搜索时才访问搜索服务。

更多内容见 [部署说明](deployment.md)、[配置说明](configuration.md)与[安全边界](security.md)。
