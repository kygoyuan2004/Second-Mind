# 使用 Claude Code 辅助安装 Second Mind

Claude Code 可以帮助普通用户在项目 checkout 中调用已有安装和诊断脚本，但它不是 Second Mind 的后台执行引擎，也不是服务凭据来源。后台问答使用随项目/镜像交付的 Pi SDK；安装 Second Mind 不要求安装 Pi CLI。

## 信任边界

把 Claude Code 限定在当前 Second Mind 仓库和项目脚本：

- Linux/macOS 只调用 `./install.sh`；Windows 只调用 `install.ps1`；
- 诊断使用脚本已有的 `doctor`、`status` 和 `logs` 子命令；
- 更新和备份使用已有的 `update`、`backup` 子命令；
- 不让 Claude Code 读取或复制 `~/.claude`、`~/.pi`、浏览器存储、Docker secret 内容、管理员密码、Provider Key 或私人笔记；
- 不把 Claude Code 登录/OAuth 文件挂载进容器，也不把它们转换成服务 Key；
- 不要求 Claude Code 手写 Compose override、修改 installer state、运行 `down --volumes`，或猜测现有 `DATA_DIR`；
- 不让它操作任何不相关或只作参照的 checkout、生产/只读知识库、固定评测或复核副本。

Claude Code 自身通常拥有宽泛的终端能力；上述限制是安装会话的操作约束，不是安全 sandbox。执行前查看它准备运行的命令。管理员密码应由用户直接输入安装器提示，LLM、Embedding 和 WebSearch 凭据应在安装完成后由用户登录网页配置。不要把秘密写进聊天 prompt、命令参数、仓库 `.env`、终端录屏或 issue。

## 安装前准备

1. 安装并启动 Docker Engine/Desktop 和 Docker Compose v2，确保使用 Linux containers。
2. clone Second Mind，并让 Claude Code 的工作目录停留在该仓库根目录。
3. 准备一个工作 Vault 或包含多个工作 Vault 的父目录。不要把只读原始库当成日记/计划的写入目标。
4. 确认 installer state、`DATA_DIR` 和备份位置在所有 Vault 之外。
5. 如果机器上已经有 Second Mind，先识别它由项目安装器还是外置 launcher 管理；不要直接再运行一次默认安装。

可以把下面这段作为 Claude Code 安装任务，路径由用户自己选择和确认：

> 仅在当前 Second Mind 仓库内工作。先运行项目安装器的只读/诊断能力，展示将调用的命令；不要读取任何笔记正文、Key、密码、`~/.claude` 或 `~/.pi`。不要修改 Compose、installer state 或现有数据路径，不要运行删除卷的命令。Linux/macOS 只使用 `./install.sh`，Windows 只使用 `install.ps1`。遇到密码或 Provider 凭据时停下，让我直接在安装器或网页中输入。安装后用项目脚本检查 status 和脱敏日志，并检查 live/ready 健康端点。

## Linux / macOS

首次安装由用户确认 Vault 路径、端口并直接输入管理员密码：

```bash
./install.sh
```

诊断：

```bash
./install.sh doctor
./install.sh status
./install.sh logs --no-follow --tail 200
```

`doctor` 不应停止端口占用者；发现冲突时应让用户选择其他端口。安装完成后，用户通过终端显示的地址登录网页，再配置模型、独立 WebSearch Key 和 Embedding。Claude Code 不需要看到这些值。

## Windows PowerShell

在仓库根目录使用进程级 execution-policy bypass，不修改系统级策略：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

诊断：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 doctor
powershell -ExecutionPolicy Bypass -File .\install.ps1 status
powershell -ExecutionPolicy Bypass -File .\install.ps1 logs --no-follow --tail 200
```

若 Docker Desktop 不在 Linux containers / WSL2 backend，先由用户在 Docker Desktop 修正；不要让 Claude Code 关闭其他容器或服务来“释放”环境。

## 更新、备份和健康检查

先备份，再更新：

```bash
./install.sh backup
./install.sh update
./install.sh status
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 backup
powershell -ExecutionPolicy Bypass -File .\install.ps1 update
powershell -ExecutionPolicy Bypass -File .\install.ps1 status
```

更新必须复用同一 installer instance、Compose project、命名卷和私有配置目录。让 Claude Code 报告命令退出码和脱敏错误即可；不要让它展开备份里的会话、Key 或笔记。项目脚本会检查 `/health/live` 和 `/health/ready`，也可由用户对实际绑定地址再次请求这两个端点。网页端还应人工确认登录、知识库、历史会话、索引/同步状态、草稿恢复和模型“已配置”状态未丢失。

回滚不是 `git reset --hard` 或删除卷。更新前记录旧镜像 digest/commit；失败后固定回旧镜像或使用保留的旧 release worktree，并复用原数据卷。若数据格式已发生不可逆迁移，应在隔离位置核验更新前备份，再由管理员明确切换恢复路径。详细步骤见 [Pi Agent 迁移、部署与回滚](pi-agent-migration.md)。

## 自定义或外置部署

既有实例可能由仓库外 launcher、用户级服务或其他进程管理器启动，并使用单独的 `DATA_DIR` 与受管配置。此类部署不是项目安装器创建的 Compose 实例，安装器也无法推断它的真实路径、服务名或数据所有权。应从管理员的私有运维记录中核验这些信息，不要把具体名称、绝对路径或配置内容粘贴到 Claude Code prompt、公共文档或 issue。

Claude Code 可以在用户授权后只读核对目标 unit 和健康状态，但在完成专门备份及迁移验收前，不得替用户运行 `install.sh init`、重启 unit、改写 launcher，或创建空卷后宣称数据已迁移。需要重启时必须由用户明确确认目标正是待更新实例；绝不操作名称相近或不相关的服务。

## 完成标准

安装脚本退出成功和自动测试通过只是基础条件。交付时还应记录：

- `health/live`、`health/ready` 和正常网页登录结果；
- 现有用户、知识库、会话/分叉、模型配置、草稿、同步和索引是否保留；
- 一次隔离问答的来源依据、实际读取覆盖、首次有效进度、总耗时和 Token 用量；
- 未覆盖内容、Provider 工具调用能力及失败原因。

不要预先声称 Pi 比 Claude SDK 更快。评测只能在隔离副本运行；线上或参照代码与服务、生产/只读知识库以及固定评测副本保持只读且不参与安装。
