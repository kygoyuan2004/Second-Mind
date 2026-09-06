# Pi Agent 迁移、部署与回滚

本文面向 Second Mind 管理员和发布维护者。它说明 Pi Agent 版本边界、已有数据如何保留，以及安装器管理的 Docker 部署和自定义 service-manager/源码部署分别如何更新。请先识别正在管理的是哪一个实例；不要在不同部署方式之间混用状态目录或重启命令。

若使用较早版本或其他实现作为行为参照，应把它的 checkout、服务和知识库视为独立的只读环境。本迁移不复制参照环境的私有路径、网关或宿主凭据，也不要求修改、停止、重启或重新部署参照环境。本文所有更新和重启命令都只适用于管理员明确识别出的目标实例。

## 当前架构边界

问答执行引擎使用嵌入式 Pi SDK 的 Agent 循环：模型收到受限工具定义，读取工具结果后自行决定继续搜索、打开原文、继续读取长文，或生成最终回答。应用仍负责身份、知识库选择、路径隔离、任务生命周期、SSE、来源展示和审计。Pi 不是一个在后台运行的 CLI 子进程。

Agent 只获得 Second Mind 注册的受限工具。普通问答 Normal 最多 12 个模型回合和 16 次 Second Mind 工具调用，Deep 最多 24 个模型回合和 32 次；这里也计入显式启用后才可能出现的受限 Web 工具。需要逐篇分页的个人学习回顾不提供 Web 工具，其预算分别放宽为 64/128 和 128/256。所有模式仍受现有服务端任务超时约束，自动重试另限制为 2 次；达到任一边界时任务明确失败或报告未覆盖项，不能假装已经完整阅读：

- `list_vault`：枚举当前知识库内的目录和文件；
- `search_text`、`search_knowledge`：搜索正文及调用当前知识库的关键词/语义/混合检索；
- `read_note`：按行和字符上限读取原文，并用 `nextStartLine` / `nextStartColumn` 继续覆盖长文；
- `resolve_note_reference`：在当前快照中解析笔记引用；
- `list_date_records`：分页获取明确 `[start,end)` 范围内的日期记录清单；学习回顾的范围、时区和 scope 由服务端固定，模型参数不能改写；
- `get_reading_coverage`：读取当前任务已经发现/实际阅读的文件、精确行区间和未覆盖原因；它本身不会增加阅读覆盖；
- `web_search`：仅在当前问答会话由用户明确启用联网且服务已配置时提供；它必须在任何 Vault 工具结果暴露前调用，首次私库访问后即与 `web_read` 一同永久关闭该任务的所有 Web 出口；每个联网回合仅向 Agent 加载当前请求，不恢复 checkpoint 或注入以往私库对话；
- `web_read`：只能在任何 Vault 工具结果暴露之前，读取同一任务中 `web_search` 已返回的精确 HTTPS URL；任意 URL 或私库访问后的读取都会被拒绝。

发现用的搜索摘要不等于原文证据。系统提示要求重要结论回到原文核验，最终来源和覆盖统计也只计算成功返回给模型的非空原文行；空文件、越界读取、序列化超限和哈希不一致都不能成为可引用来源。目录、日期清单、引用候选和长文阅读的分页缺口，以及网页截断或工具失败，都会进入覆盖账本。要求“全部/完整/盘点”的请求必须实际调用 `get_reading_coverage`；学习回顾还必须先取得日期 inventory，否则任务失败。服务端会把未覆盖对象及稳定原因附在回答后，避免模型省略缺口。所有工具都绑定创建任务时固定的用户、`knowledgeBaseId`、知识库 revision、索引快照和模型配置 revision；工具参数不能改换知识库根，也不能请求绝对路径。

问答工具没有 Shell、任意网络访问、任意文件写入或 Pi 默认的 `bash`、`write`、`edit` 工具。知识库中的扩展、skills、提示模板、`AGENTS.md` 或其他可执行配置不会自动加载。联网仍由用户在问答会话中明确选择；个人学习回顾不加载联网工具。日记、计划和随心记继续走“生成私有草稿 → 页面预览 → 用户确认 → 路径及哈希复核 → 保存”的既有流程，不由问答 Agent 直接写入。

回答文本在原文引用、阅读覆盖和外链核验完成前一直保留在服务端。Pi 的 lifecycle、工具、用量和心跳事件仍通过 SSE 到达页面，但原始 `text_delta` 不会被当作 Markdown 提前渲染。外部证据用工具返回的不透明 `web_N` 标记引用；服务端仅为成功读取的来源生成转义后的 HTTPS 链接，浏览器会拆除其他 Markdown、HTML、GFM 自动链接和邮箱链接。

## 精确版本锁

本迁移锁定发布到 npm registry 的 `0.85.1`，不引用 GitHub `main`、分支、commit tarball 或浮动 dist-tag：

| 直接依赖 | 锁定值 | 用途 |
|---|---:|---|
| `@earendil-works/pi-agent-core` | `0.85.1` | 工具循环、状态和流式生命周期事件 |
| `@earendil-works/pi-ai` | `0.85.1` | 模型协议和流式请求层 |
| `@earendil-works/pi-coding-agent` | `0.85.1` | 可嵌入的会话、上下文压缩及恢复能力；不启用其 CLI 默认工具或资源加载器 |

三个发布包的 metadata 均指向 [earendil-works/pi](https://github.com/earendil-works/pi) 中对应的 SDK package，并要求 Node.js `>=22.19.0`；项目自身更严格的 Node engine 约束满足该下限。`package.json` 使用无 `^`/`~` 的精确值，`package-lock.json` 固定 tarball、完整性散列和传递依赖。生产构建必须使用 `npm ci`；升级 Pi 时三个包应作为一个兼容集合评审和更新，不能只修改其中一个，也不能以 `npm update` 结果直接替换生产 lockfile。

普通用户不需要全局安装 Pi CLI、Claude Code 或 Node.js。Docker 镜像在构建阶段通过 lockfile 安装 SDK 运行模块；源码部署同样由项目自己的 npm 依赖提供。即使依赖包包含 CLI 入口，Second Mind 也不会通过用户的 Pi CLI 配置启动服务。

可在隔离 checkout 中核对锁定结果：

```bash
npm ci
npm ls --depth=0 \
  @earendil-works/pi-agent-core \
  @earendil-works/pi-ai \
  @earendil-works/pi-coding-agent
```

## 模型兼容矩阵

“Provider 已注册”只表示 Second Mind 知道如何构造该协议的请求，不表示任意兼容端点或任意模型都支持工具调用。Anthropic Messages 映射到 Pi 的 `anthropic-messages` API，OpenAI Chat Completions 映射到 Pi 的 `openai-completions` API。生产问答必须同时满足：协议匹配、流式响应可解析、工具调用及工具结果回传通过能力检查。检查最多允许 1 次 nonce 工具调用和 2 个助手回合，整个循环最长 120 秒且不自动重试；重复调用或第三回合会立即中止。检查失败时应拒绝启动 Pi 问答任务并给出能力错误，不能退回旧的固定检索/文本生成流水线。

| 网页 Provider | 协议适配 | 认证方式 | Pi 问答资格 |
|---|---|---|---|
| 阿里云百炼 | Anthropic Messages（`/apps/anthropic`） | `x-api-key` | 仅限所选实际模型通过原生工具调用探测 |
| 阿里云百炼 | OpenAI Chat Completions（`/compatible-mode/v1`） | Bearer | 仅限所选实际模型通过原生工具调用探测 |
| DeepSeek 官网 | OpenAI Chat Completions | Bearer | 仅限所选实际模型和端点通过原生工具调用探测 |
| GLM / 智谱官网 | OpenAI Chat Completions | Bearer | 仅限所选实际模型和端点通过原生工具调用探测 |
| Kimi / Moonshot 官网 | OpenAI Chat Completions | Bearer | 仅限所选实际模型和端点通过原生工具调用探测；思考字段仍按已注册模型族处理，固定采样模型不发送 `temperature` |
| Custom | OpenAI Chat Completions 或 Anthropic Messages | Bearer、`x-api-key` 或显式无认证 | 条件支持；必须探测，且不按模型名猜测供应商专有字段 |

当前网页模型注册表不把 OpenAI Responses、Google、Bedrock 或 Pi 的订阅/OAuth 登录当作 Second Mind 生产协议。Embedding 和 WebSearch 仍是独立配置与独立凭据，不是第二套问答执行引擎。网页注册表尚未保存经 Provider 证明的上下文窗口时，Pi 按保守的 64K 窗口安排压缩，不把“兼容接口”默认当作 128K。连接检查可能产生少量 Provider 费用；管理员应在保存前阅读页面确认信息。

生产连接检查不是“让模型回答一句文本”：它生成一次性 challenge，要求模型调用受限 nonce 工具，并要求后续模型回合逐字消费不可预知的工具结果。只有完整的 model → tool → result → model 往返才返回 `PI_TOOL_CALL_VERIFIED`。从旧版本导入且尚未执行这一检查的模型应由管理员在网页重新验证，不能仅凭以前的普通文本连接成功记录判定 Pi-ready。

模型、API Base、Key 和思考强度继续在登录后的管理员页面配置。API 只返回“已配置”状态而不回显 Key。服务不得从宿主机的 `~/.pi`、`~/.claude`、Pi OAuth、Claude Code 登录文件或无关环境配置发现模型或凭据；Docker 安装也不得挂载这些目录。直接 Node 部署只能使用 Second Mind 的受管配置或文档列出的 `_FILE` secret 入口。

## 私有状态和数据保留

`DATA_DIR` 必须位于所有 Vault 和允许的 Vault 父目录之外，并由服务账号独占写入。Docker 安装固定为容器内 `/app/data`，对应 installer 创建并保留的命名卷。直接 Node 的默认值是仓库外配置的 `DATA_DIR`。

Pi session 根目录默认且在当前部署中固定为 `${DATA_DIR}/pi-sessions`。内部 `config.pi.sessionDir` 仅供显式嵌入/测试覆盖，当前没有新增面向管理员的环境变量；普通部署不得把它改回用户 home 下的 Pi 默认目录。

| 数据 | 默认/受管位置 | 更新要求 |
|---|---|---|
| 网页历史会话与分叉 | `CONVERSATION_FILE`，默认 `$DATA_DIR/conversations.json` | 原文件原地保留，不清空或导入到宿主 Pi 会话目录 |
| Pi 会话/恢复元数据 | `${DATA_DIR}/pi-sessions/*.jsonl` | 目录 `0700`、文件 `0600`（POSIX）；网页会话只保存校验后的文件 basename，不得写入 `~/.pi` |
| 管理员模型和搜索配置 | `$DATA_DIR/runtime/` | 保留 primary、last-known-good、revision 和现有 Key 状态 |
| 索引 | `INDEX_DIR`，默认 `$DATA_DIR/index/` | 保留活动 slot、快照 revision 和内容哈希；失败重建不能替换健康 slot |
| 草稿与恢复副本 | `$DATA_DIR/drafts/`、`$DATA_DIR/recovery/` | 更新后仍可预览、确认或恢复 |
| 审计 | `AUDIT_FILE`，默认 `$DATA_DIR/audit.jsonl` | 不提交 Git，不暴露笔记或凭据 |

现有产品会话记录仍是网页历史、分叉和展示的权威数据。每个请求先从上次已提交 checkpoint 派生一个一次性工作 JSONL；Pi 可以在该分支内记录工具循环并执行上下文压缩，但绝不直接追加权威 checkpoint。回答经过来源清洗后，应用只用产品中可见的 user/assistant 消息生成带历史摘要哈希的 canonical JSONL，并把该 basename 与产品会话原子关联。产品保存失败、取消、超时或生成失败时删除工作/待提交文件，继续保留上一 checkpoint；这样下一轮不会看到网页历史中不存在的失败轮次或未清洗回答。成功提交后移除被替代文件，删除/清空会话也回收不再引用的 JSONL，启动时会清理安全会话目录中未被任何产品会话引用的合法孤立文件。

Pi checkpoint 不能绕过既有会话归属检查，也不保存当前轮原始工具 payload 或隐藏推理。下一次消息仅在 canonical marker 的历史摘要与已提交产品消息完全匹配时恢复；文件缺失、权限不安全、内容损坏或摘要不一致时，应用发出警告并从产品历史重建。浏览器断线不自动取消仍在服务进程中的任务，取消则传递到 Pi。进程退出时尚未完成的当前任务不会自动接着执行，也不会被当成已完成。

### 自定义或外置部署的特别警告

有些既有实例由仓库外 launcher、用户级服务或其他进程管理器启动，并直接加载一个源码 checkout。它们不是 `install.sh` 创建的 Compose 实例，项目安装器也无法推断其持久数据、受管配置、launcher 或服务单元位置。管理员必须从该实例已有的私有运维记录中核实这些位置；具体服务名和绝对路径不应写入公共文档、聊天或工单。Pi 会话必须继续位于该实例实际 `${DATA_DIR}/pi-sessions`，不能回落到 Pi 的用户级默认目录。

在显式切换部署方式之前，必须保留实际数据目录、受管配置、外置 launcher、服务定义、当前工作副本、会话、身份、模型配置、同步信息和索引。不要运行新的 `init` 后把空命名卷误认成原数据，也不要让安装器默认路径覆盖现有状态。仅仅拉取或修改 checkout 不会替换已在内存中运行的模块，但外置 launcher 下次重启可能加载 checkout 的新代码；因此任何后台重启都必须排在备份、路径核验和隔离验收之后。

## Docker 与受限运行环境

推荐入口保持不变：

```bash
./install.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装器优先拉取项目镜像，失败时从 checkout 构建；两条路径都把 Pi SDK 放入镜像，不要求额外安装 CLI。Compose 继续以配置的非 root UID/GID 运行，启用只读容器根文件系统、`cap_drop: ALL`、`no-new-privileges` 和受限私有 `/tmp`。持久写入只应落到 `/app/data` 卷以及现有产品明确允许的确认写入目标。Pi 会话不得依赖镜像层、当前工作目录或用户 home 可写。

发布前至少核对：

```bash
docker compose config --quiet
docker inspect "$(docker compose ps -q app)" \
  --format 'user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}}'
docker compose exec -T app node -e \
  "const fs=require('node:fs'); fs.accessSync('/app/data', fs.constants.W_OK)"
```

`user` 不得为 root，`readonly` 应为 `true`，`/app/data` 应可写。Shell 仅用于管理员诊断；它没有暴露给模型。作为参照、评测来源或备份的只读知识库不得直接作为可写工作 Vault 挂载；需要测试写入时，应使用经过证明不重叠的专用工作副本。

## 更新操作手册

### 1. 更新前记录和备份

1. 识别实例类型、当前 Git commit 或镜像 digest、监听地址、健康状态、实际 `DATA_DIR`、受管配置路径、知识库工作副本和同步器边界。不要根据默认路径猜测。
2. 等待活动任务结束或由用户取消。需要一致时间点时，先按同步文档安全暂停目标实例的外部写入者；不要停止、重启或重新部署任何不相关或仅作参照的实例。
3. 对安装器实例运行 `./install.sh backup`，PowerShell 使用 `install.ps1 backup`。该备份包含 Vault、运行数据和 installer 配置并生成 SHA-256 清单，但它是实时复制，外部同步仍需单独协调。
4. 对自定义或外置部署使用其既有、经管理员确认的备份机制，覆盖实际 `DATA_DIR`、受管配置、launcher 和服务定义。项目安装器不知道这些位置，不能用一个新 Compose 卷代替该备份。具体路径和备份内容不得提交到 Git。
5. 在隔离位置验证备份清单和可读性，并记录回滚所需的旧代码或镜像标识。不要用只读参照库或固定评测副本充当备份。

### 2. 更新和后台重启

安装器管理的 Linux/macOS 实例：

```bash
./install.sh doctor
./install.sh update
./install.sh status
```

Windows 使用相同子命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 doctor
powershell -ExecutionPolicy Bypass -File .\install.ps1 update
powershell -ExecutionPolicy Bypass -File .\install.ps1 status
```

`update` 使用原 Compose project 和数据卷执行后台替换，不应创建新的实例 ID。不要执行 `docker compose down --volumes`。

对于自定义 service-manager 部署，只有在上述备份及路径检查通过、并由管理员从私有运维记录确认目标 unit 后，才可执行。下面的值是占位符，必须先替换为已经核验的用户级 unit：

```bash
SECOND_MIND_UNIT='replace-with-verified-user-unit.service'
systemctl --user restart "$SECOND_MIND_UNIT"
systemctl --user status "$SECOND_MIND_UNIT" --no-pager
```

不得对名称相近或不相关的 unit 操作，也不得把此命令写进通用 Docker 更新脚本。若当前服务仍健康而迁移检查未完成，保持运行，不做试探性重启。

### 3. 健康和数据核验

先检查无认证健康端点，再用正常登录的网页验证私有功能：

```bash
curl -fsS http://<实际绑定地址>:<端口>/health/live
curl -fsS http://<实际绑定地址>:<端口>/health/ready
./install.sh logs --no-follow --tail 200   # 仅用于安装器实例
```

`live` 和 `ready` 都必须成功；随后确认原管理员身份仍能登录、多知识库清单和默认库不变、历史会话及分叉可见、索引状态/同步状态未重置、草稿可恢复、模型只显示 Key 已配置状态。用一个无敏感内容的隔离问题观察首次进度、工具调用、继续读取、来源弹窗、取消和断线重连。不要在日志或工单中粘贴 Key、完整 prompt、笔记正文或私有绝对路径。

### 4. 回滚

如果健康或数据核验失败，停止继续验收并保留失败日志的脱敏副本：

- 安装器实例：把 Compose image 固定回更新前记录的不可变 tag/digest，再对同一个 project 执行后台 `up -d`；不要删除命名卷。
- 源码/外置 launcher：切回事先保留的旧 release worktree 或旧 commit，再只重启已经核验的目标 unit。不要用 `git reset --hard` 覆盖未提交修改。
- 若新版本已经执行不向后兼容的数据迁移，不要让旧代码直接打开新状态。先在隔离目录核验更新前的完整备份，再以明确的新路径恢复数据和配置。
- 回滚后重新检查两个健康端点、登录、知识库 revision、会话、草稿、索引和同步状态。只读参照知识库和不相关服务始终不参与回滚。

## 验收与评测边界

自动测试通过只是代码门槛，不代表回答质量合格。任务状态中的 Agent 指标包括 `engine`、`piVersion`、`durationMs`、`firstEffectiveProgressMs`、`firstTextDeltaMs`、模型回合数、工具调用数、压缩/重试次数、Provider 报告的 Token 用量和覆盖账本；会话已经建立后的受控失败也保留这些脱敏指标。若本次执行了能力探测，总回合/工具计数包含探测工作，而旁边的 Agent 上限只约束随后正式任务的循环。真实对话验收至少同时记录：回答正确性、逐条结论的来源依据、实际读取的文件/行覆盖、首次有效进度时间、总耗时、输入/输出/缓存 Token，以及未覆盖内容和原因。Provider 未返回某类 usage 时应标为不可用，不能推算成零。不得预设 Pi 一定比 Claude SDK 或旧流程更快。

可使用经授权且已脱敏的材料设计隔离验收，但不得提交私人题目、答案、笔记片段或运行输出。新增测试必须使用独立工作目录、独立索引、独立会话和 mock 或专用凭据；不得写入以下对象：

- 任何线上或仅作参照的 checkout 及其运行进程；
- 原始、生产或明确标记为只读的知识库；
- 固定的基准、复核或回归评测副本；
- 备份、同步目标、真实运行状态和 Provider 凭据。

优先比较已有验收记录。若必须新增参照对照，应使用经过证明不重叠的只读适配器和隔离输出，不能重启、停止、部署或修改参照实例。

## 尚未覆盖和发布门槛

- 兼容端点的工具调用差异只能按“具体 API Base + 具体模型”实测，Provider 名称不能代替能力证明。
- 标准镜像仍不提供网页 PDF 解析所需的 sandbox 工具；这与 Pi Agent 无关。
- rootless Docker、SELinux relabel、Windows Service、macOS LaunchDaemon 和平台原生凭据库仍需要部署者单独设计。
- 安装器没有自动镜像回滚或自动恢复命令；每次更新前仍需记录不可变镜像/commit 并验证备份。
- 活动任务不会跨服务进程自动续跑；进程故障后从最后一次成功提交的网页会话和 canonical Pi JSONL 恢复。崩溃瞬间遗留的工作 JSONL 不会被恢复，并在下次启动时自动回收。
- 生产对话质量、长上下文压缩后的事实保持性、已提交会话恢复和各 Provider 的 Token 计量必须在隔离环境留下验收结果；未实际执行的项目应明确标为未验证，不能由单元测试推断通过。

安全和一般配置边界另见 [安全](security.md)、[配置与 Provider](configuration.md)、[部署](deployment.md) 和 [同步](sync.md)。
