# Pi 执行层迁移、部署与回滚

本文说明 Second Mind 将 Claude Code 模型调用层替换为 Pi SDK 时的边界。参照实例、参照源码和参照知识库始终只读；更新、测试和重启只能针对已明确识别的迁移实例。

## 行为边界

Pi 只是单次生成执行器，不是新的任务编排器。应用继续负责：

- 检索路由、查询改写、本地筛选、时间范围和索引快照；
- Normal/Deep 的既有查询数量、批处理、并发与反馈核验；
- 对话裁剪、模型输入构造、引用/外链核验和 SSE 输出；
- 任务取消、超时、草稿预览、确认写入、审计与错误清洗。

每次已经排定的模型调用通过 Pi `ModelRuntime.streamSimple` 执行，并固定满足：

- `tools=[]`，不创建 `AgentSession`，不读取 Pi/Claude 的用户配置；
- `maxRetries=0`，不自动继续、不自动压缩、不根据模型输出追加回合；
- 模型、Provider、API Base、凭据、思考强度、输出上限和超时来自任务创建时固定的租约；
- Provider 返回截断时向既有上层流水线报告 `LLM_OUTPUT_TRUNCATED`，是否执行唯一一次既定续写仍由应用原有逻辑决定。

Normal 的服务端总时限为 10 分钟、最多 20 次既定模型调用；Deep 为 30 分钟、最多 50 次。个人时段学习/工作回顾仍是 Q&A，但由服务端确定性调查编排器接管：固定日期范围、快照枚举、日期片段抽取、分批读取、关联笔记追踪和状态校验均不由 Pi 决定。该编排器沿用原版 50 次模型调用、40 次读取/搜索和 30 分钟总时限，不存在隐藏任务类型或 64/128、128/256 的 Agent/工具路径。

旧版本的 Pi Agent 模块和 JSONL 字段只可用于向后兼容的读取或安全清理；生产 `TaskManager` 没有到这些执行入口的引用。旧工具能力探针固定 fail-closed，连接检查改为一次 64 Token 上限的无工具生成，成功码为 `PI_GENERATION_VERIFIED`。

## 版本与模型适配

项目锁定以下 npm 版本，不依赖浮动分支或宿主 Pi CLI：

| 依赖 | 版本 | 当前用途 |
|---|---:|---|
| `@earendil-works/pi-agent-core` | `0.85.1` | 锁定依赖集合中的兼容组件；不运行 Agent 循环 |
| `@earendil-works/pi-ai` | `0.85.1` | Anthropic/OpenAI-compatible 流式模型协议 |
| `@earendil-works/pi-coding-agent` | `0.85.1` | `ModelRuntime` 注册与单次生成；不创建会话或工具 |

Anthropic Messages 映射到 `anthropic-messages`，OpenAI Chat Completions 映射到 `openai-completions`。认证、请求 profile、思考字段、Kimi temperature 抑制、输出 Token 上限和固定 DNS/传输策略仍由应用适配层控制。Embedding 与 WebSearch 使用各自独立配置和凭据。

`LLM_CONTEXT_WINDOW` 默认 `1000000` Token，与原版 `qwen3.8-max[1M]` 绑定一致；允许范围为 `4096..2000000`。它只是部署对 Provider 容量的声明，不能扩大远端模型能力；连接检查也不验证长上下文。应用的既有上下文构造负责在调用前控制输入，Pi 不进行 Agent 压缩或压缩后重试。

## 状态与隐私

产品会话、分叉和可见消息仍以 `CONVERSATION_FILE` 为准。新任务不创建 Pi JSONL checkpoint，也不把隐藏推理写入产品会话。旧 `${DATA_DIR}/pi-sessions` 内容可按已有路径校验规则清理，但不得恢复为执行上下文。

Provider Key 只进入任务固定的私有绑定和应用已有的固定传输；API 只返回配置状态。服务不读取 `~/.pi`、`~/.claude`、OAuth 登录文件、Vault 内扩展、skills、提示模板或 `AGENTS.md`。Pi 没有 Shell、文件、浏览器、WebSearch 或 MCP 工具。

## 验收

发布前至少执行：

```bash
npm ci
npm run check
npm test
```

回归必须证明：

1. 生产 `TaskManager` 不导入或实例化 `PiAgentRuntime`，也不调用 `piAgent.runQa/runDraft`；
2. 单次执行上下文的工具数组为空，请求一次完成，Pi 重试为零；
3. 多种自然表达进入确定性学习回顾；事件日期覆盖 mtime，关联知识笔记可追踪，计划不能升级为完成，“所有”继承首轮区间；
4. 学习回顾的 50/40/30 分钟预算及 Normal/Deep 的 20/50 调用、10/30 分钟上限生效；
5. 所有 Pi 调用均为 `tools=[]`、`maxRetries=0`，生产调用图不进入 `PiAgentRuntime`；
6. exact/semantic 路由、条件重排、12/20 结果数、短追问上下文、引用清洗、SSE 和草稿确认继续通过；
7. 原版知识页基础样式、渲染器、图片与公共依赖资源哈希一致；HTML/交互脚本明确保留迁移版的模型管理、知识库切换和改名功能，附加样式单独维护，不再用整页哈希要求删除这些功能；不引入 Yuan Drive/Home 页面。参照源码无变化，参照服务 PID 与启动时间不变。

单元测试只能证明结构和确定性 fixture。真实回答质量还应在经授权的隔离数据上比较；不同知识库内容、Provider 模型或运行配置会导致答案差异，不能被描述成“执行器以外完全相同”。

## 更新与回滚

安装器管理的实例继续使用：

```bash
./install.sh doctor
./install.sh update
./install.sh status
```

外置 systemd/launcher 部署必须先从私有运维记录核对准确 unit、源码目录、`DATA_DIR`、环境文件和监听端口。等待活动任务结束并备份目标状态后，只重启迁移目标；不得操作名称相近的参照 unit。

重启后检查：

```bash
curl -fsS http://<target-host>:<target-port>/health/live
curl -fsS http://<target-host>:<target-port>/health/ready
```

随后登录验证知识库 revision、索引、会话、Normal/Deep、联网开关、SSE、草稿预览和确认写入。若失败，切回预先保留的旧 release/镜像并只重启同一个目标 unit；不要使用 `git reset --hard` 覆盖未提交工作，不要删除数据卷，也不要把只读参照实例纳入回滚。
