# VaultMind：简历与面试材料

这份文档用于把项目讲清楚，而不是把项目讲大。下面的描述均对应当前
仓库已有实现；请根据自己的真实贡献删改，不要把“阅读过代码”写成
“独立实现”，也不要把路线图写成已上线能力。

## 一句话项目介绍

> VaultMind 是一个面向 Obsidian 本地 Vault 的自托管 RAG 知识工作台，
> 支持 BYOK 模型/embedding、BM25 与向量混合检索、SSE 流式问答，以及
> 日记/计划/随心记的“草稿预览—人工确认—冲突检查—安全写入”流程。

更偏 AI 应用方向的版本：

> 基于 Node.js 22 实现 provider-neutral RAG 应用：对 Markdown 做结构化
> 分块，以 BM25、dense embedding 和 RRF 完成可降级召回，将有界来源
> 注入模型上下文，并通过人工确认草稿隔离模型生成与真实知识库写入。

## 简历项目条目（可直接改写）

```text
VaultMind｜自托管 Obsidian RAG 知识工作台｜个人项目｜20XX.XX–20XX.XX
技术栈：Node.js 22 / JavaScript ESM / BM25 / Embedding / RRF / SSE /
        Docker Compose / Obsidian / Vanilla Web

• 设计并实现面向 Markdown Vault 的 RAG 链路：保留标题、行号、列表、
  表格与代码块进行重叠分块，完成中文友好 BM25、向量余弦召回与 RRF
  融合；embedding 关闭或异常时自动降级到关键词检索并返回诊断信息。
• 抽象 OpenAI-compatible 与 Anthropic 流式生成适配器，以及
  OpenAI-compatible/DashScope embedding 适配器，支持服务端 BYOK 与
  Ollama、vLLM、LM Studio 等本地兼容端点，避免 API Key 下发浏览器。
• 将 AI 写笔记设计为“Vault 外草稿—可编辑预览—显式确认—哈希冲突
  检查—已有笔记 preimage 恢复副本—二次哈希检查—白名单目录原子
  替换”，并加入路径穿越、隐藏目录与符号链接防护，降低覆盖风险。
• 完成单节点容器化与验证体系：非 root/只读根文件系统/Secret 文件/
  回环监听，配套 Node 自动化测试和 Recall@K、MRR、nDCG 合成评测脚本；
  当前 3 条 synthetic baseline 为 Recall@3=1.0000、MRR=0.8333、
  nDCG@3=0.8770（仅验证评测链路，不作为生产质量结论）。
```

如果版面只能放两条：

```text
• 实现 Obsidian 本地 Vault 的自托管 RAG：Markdown 结构化分块、中文
  BM25 + dense embedding + RRF、来源引用、SSE 流式输出，并兼容
  OpenAI-compatible/Anthropic/Ollama 等 BYOK 模型端点。
• 设计 review-before-write 安全写入协议，以 Vault 外草稿、人工确认、
  目录白名单、preimage 恢复副本和重复哈希检查保护三类笔记；使用
  Docker Compose、自动化测试套件和离线检索指标完成工程闭环。
```

### 哪些词可以写，哪些词要谨慎

可以写：

- 自托管、BYOK、provider-neutral；
- RAG、BM25、dense retrieval、cosine similarity、RRF；
- Markdown-aware chunking、增量 embedding、lexical fallback；
- SSE streaming、draft confirmation、optimistic conflict detection；
- Docker hardening、路径安全、Secret 扫描、离线检索评测。

除非你另外实现过，否则不要写：

- “多智能体协同”“ReAct Agent”“自主调用工具”——当前是固定的 grounded
  RAG/草稿流水线；
- “支持 Self-hosted LiveSync”——它只是 roadmap；
- “内置 Obsidian Sync”——Headless 是外部上游、可选且只允许本地构建；
- “企业级多租户”“RBAC”“高可用”“分布式”“海量向量库”；
- “支持图片/PDF 多模态理解”——当前只做预览或确认后的附件持久化；
- “生产级准确率 100%”——Recall=1 来自 3 条 synthetic demo；
- 未实测的 QPS、延迟、成本下降、用户数和数据规模。

## STAR 讲述模板

### S：Situation

个人知识长期保存在 Obsidian 中，但传统关键词检索难以覆盖同义表达；
直接把整个 Vault 发给模型既超出上下文，也会泄露无关内容。让模型直接
写文件又存在路径越界、覆盖已有日记、同步冲突和附件落盘风险。此外，
不同部署者可能使用云模型、本地 Ollama 或不同 embedding 服务，不能把
项目绑定到一个供应商。

### T：Task

构建一个可在常开服务器部署的单管理员 AI 知识工作台，在不修改
Obsidian 文件格式的前提下完成：

1. 可解释、可降级的检索增强问答；
2. 模型与 embedding 的服务端 BYOK；
3. 日记/计划/学习记录的人工确认写入；
4. 与同步进程解耦的本地文件架构；
5. 能被测试、评测和安全审计的部署闭环。

### A：Action

- 自行实现 Markdown block-aware chunker，保留 heading 和行号，对中文、
  日期、代码标识符做 tokenization；用 BM25 做词法召回，用 embedding
  与余弦相似度做 dense 召回，再用 `1 / (60 + rank)` 的 RRF 合并两个
  排名，避免直接归一化不可比的分数。
- 以 chunk hash 复用已有向量，只对变化内容调用 embedding；使用原子
  generation 与 current/previous manifest 持久化索引，并通过文件监听
  加周期 reconciliation 处理变化。
- 编写 OpenAI-compatible、Anthropic、OpenAI-compatible embedding 和
  DashScope 适配器，统一超时、取消、流式解析、维度检查和错误脱敏；
  embedding 不可用时保留 BM25 服务。
- 将 Q&A 与写入流程隔离。写入类任务先在 Vault 外生成草稿，前端提供
  Markdown 编辑/渲染预览；确认更新已有日记/计划时先保存并验证 preimage
  恢复副本，再做第二次源文件哈希检查，通过临时文件和 rename 提交；
  恢复副本默认保留 30 天；提交后追加审计事件，审计落盘失败会作为明确警告返回。
- 对隐藏目录、`.obsidian`/`.livesync`、路径穿越和符号链接建立统一文件
  网关；API 使用签名 Cookie、同源校验和自定义写请求头；容器使用
  非 root、只读根文件系统、capability drop 和回环端口。
- 建立单元/端到端测试套件，并实现 Recall@K、MRR、nDCG 的离线评测
  脚本；用合成 demo 验证流程，同时在文档中明确该数据不能代表真实
  业务质量。

### R：Result

- 得到一个可运行的单节点 MVP，覆盖知识问答、四模式前端、混合检索、
  流式响应、历史记录、来源预览和三类确认写入；
- `npm run verify` 当前通过完整测试套件及 Secret/私人路径扫描；
- synthetic demo baseline 在 `K=3` 时得到 Recall `1.0000`、MRR
  `0.8333`、nDCG `0.8770`，证明评测工具链可复现；
- embedding 服务异常时仍能返回关键词结果，而不是让整个知识库不可用；
- 模型输出不会绕过人工确认直接写入 Vault；哈希检查检测到的日记/计划
  并发修改会返回冲突，最终检查到重命名之间的竞态则依靠恢复副本与备份
  降低影响。

不要把“实现了机制”改写成“线上事故为零”或“准确率提升 X%”，除非你有
真实基线、数据集和运行记录。

## 90 秒面试口述

> 我做了一个自托管的 Obsidian RAG 项目 VaultMind。核心问题不是简单接
> 一个聊天 API，而是怎样把私有知识检索、模型适配、文件写入和同步边界
> 做成一个可靠系统。
>
> 读取侧我没有只做向量检索，而是实现了中文友好的 BM25 和可选 dense
> embedding，用 RRF 融合排名。这样专有名词、日期和代码标识符由 BM25
> 保底，同义表达由向量补充；embedding 故障时系统会显式降级。索引只对
> 变化 chunk 重算向量，并保留前后两代原子 generation。
>
> 写入侧我把模型输出放在 Vault 外的草稿区，用户预览和编辑后才允许
> 保存。更新已有笔记时会先保存已验证的旧内容恢复副本，再检查一次
> 源文件哈希并原子替换；这能缩小竞态窗口，但不是和 Sync 的分布式锁。
> 模型端支持 OpenAI-compatible、Anthropic 和本地 Ollama，key 只在服务端。
>
> 工程上我补了 Docker 安全配置、SSE、自动化测试和 Recall/MRR/nDCG
> 评测脚本。同时我会明确说明当前是单管理员单节点、LiveSync 还没实现，
> 以及合成数据指标不能代表生产效果。

## 面试高频追问与参考回答

### 1. 为什么不是只用向量检索？

向量适合同义改写，但对文件名、日期、缩写、代码符号等精确 token 未必
稳定；BM25 对这些更可靠。两者分数分布不可直接相加，所以当前采用 RRF
只融合名次。代价是需要维护两条召回链路，且当前融合权重固定。

### 2. RRF 怎么实现？为什么 `k=60`？

每个候选在每条排名中贡献 `1 / (k + rank)`，相同 chunk 的贡献相加。
当前实现采用常见的 `k=60`，降低第一名与后续名次的极端差距。它是工程
默认值，不是通过真实业务数据调出的最优参数；后续应在人工标注集上做
消融实验。

### 3. 分块策略有什么取舍？

当前目标约 1500 字符、重叠约 180 字符，并尽量不拆列表、表格和代码
围栏，同时保存 heading 与行范围。chunk 太小会丢上下文，太大会降低
召回粒度并增加 embedding/LLM 成本。固定字符阈值仍较粗糙，可按 token、
文档类型或标题层级自适应。

### 4. embedding 服务挂了会怎样？

建索引或查询 embedding 出错时会记录脱敏诊断，并将 effective route
切回 keyword。BM25 index 本身仍可用。这个设计优先保证检索服务可用，
但语义召回质量会下降，监控应对 fallback 和 lastError 告警。

### 5. 为什么自己实现索引，没有直接上向量数据库？

当前目标是个人/小团队单节点，JSON generation 降低部署依赖，也便于
展示 chunk、hash、回退和评测全链路。但 BM25 当前按查询在内存计算，
数据量大时会成为瓶颈。扩展时会抽象 retrieval storage，词法侧换倒排
索引/SQLite FTS/OpenSearch，向量侧换持久化 ANN，并引入后台任务队列。

### 6. 如何防 Prompt Injection？

不能声称完全防住。现有边界是：把 Vault 片段标记为不可信数据；模型
没有 Shell、任意文件或联网工具；检索上下文有长度限制；写入必须经过
人工确认与服务端路径校验。恶意笔记仍可能影响回答，因此需要来源展示、
用户审查和敏感数据最小化。

### 7. 为什么要把草稿放在 Vault 外？

如果草稿一生成就写入 Vault，同步进程可能立即上传错误内容或附件。
Vault 外 staging 让生成失败、用户放弃和编辑过程不污染正式知识库，也
能在确认时统一做冲突检查和原子提交。

### 8. 如何处理 Obsidian 同时编辑同一篇日记？

生成前记录目标文件 hash，确认保存时再次计算；不一致则返回
`DRAFT_CONFLICT`，要求基于新内容重新生成。更新已有笔记时先把 preimage
复制到 Vault 外的私有恢复目录并校验哈希，随后再次检查 live hash 才
原子替换；恢复副本默认保留 30 天。它仍不是与 Sync 的分布式 CAS，因此
同步仍需保留冲突副本并配合独立备份。

### 9. SSE 为什么适合这里？如何恢复？

模型输出是服务器到浏览器的单向增量流，SSE 比 WebSocket 更简单，并
自带浏览器重连与 `Last-Event-ID`。任务在内存中保留有序事件，重连时
重放未收到事件。限制是服务重启会丢失活跃任务，不支持跨实例迁移。

### 10. BYOK 的安全边界是什么？

key 通过环境变量或权限受控的 `*_FILE` 读入，只用于服务端请求头，不
进入浏览器配置、请求 JSON、Vault 或索引。错误消息会截断并脱敏。仍要
承认 Docker 管理员、宿主机 root 和进程内存可以读取 key，远程 provider
也能看到被发送的私有文本。

### 11. OpenAI-compatible 是否等于支持所有厂商？

不是。当前适配器依赖 `/chat/completions` 和特定 SSE/JSON 结构；兼容
网关可能在字段、错误格式或流式事件上有差异。文档把它描述为协议适配，
不声称每个品牌/模型都经过验证，应对目标端点做 contract test。

### 12. Obsidian Headless 是项目内置的吗？

不是。VaultMind 始终读本地文件。可选 overlay 只是在本地构建官方
`obsidian-headless` 并共享 Vault。它需要 Obsidian Sync 订阅，属于外部
open-beta 上游，npm 元数据为 `UNLICENSED`，所以主镜像不打包，也不应
分发本地构建结果。

### 13. LiveSync 支持到什么程度？

当前没有支持。没有 CouchDB service、凭据处理、Setup URI 或本地
materializer。路线图方案是把 LiveSync 做成独立物化层，仍向现有索引
提供普通本地 Vault，并补删除、重命名、冲突、附件、加密和恢复测试。

### 14. 评测为什么选 Recall、MRR 和 nDCG？

Recall@K 衡量相关文档是否进入上下文候选；MRR 强调第一个相关结果的
位置；nDCG 衡量整个排序质量。当前 3 条 demo 只验证代码路径。真正调参
需要覆盖日期、专有名词、同义改写、无答案问题和权限边界的人工标注集，
并固定语料版本。

### 15. 系统最大的扩展瓶颈是什么？

当前是单进程，BM25 查询会遍历并 tokenization 内存 chunk，索引和会话
是本地 JSON，任务与限流是内存状态。因此主要瓶颈是大语料检索复杂度、
索引文件体积和不可横向扩展。演进方向是存储/检索适配层、后台队列、
外部状态和可恢复任务，而不是直接增加更多 Agent。

### 16. 为什么没有使用 LangChain/LlamaIndex？

当前链路较短，直接实现能明确展示 provider payload、SSE、RRF、fallback
和文件安全边界，也减少运行依赖。代价是需要自己维护协议兼容与评测。
如果以后出现复杂 workflow 或大量 connector，再评估框架收益，而不是
为了技术栈标签引入。

### 17. Docker 安全配置能保证安全吗？

不能。非 root、只读根、drop capability 和回环监听降低容器攻击面，
但 Docker daemon、宿主机内核、Vault bind mount、备份和 Secret 仍是
高权限边界。公网部署还需要 TLS 反向代理、防火墙、日志/告警和密钥轮换。

### 18. 如果让你继续做一个月，优先级是什么？

先建立真实匿名化评测集和可观测性，量化检索质量与 fallback；其次抽象
可扩展索引存储和持久化任务；再实现一个独立同步 materializer 的完整
冲突/恢复测试。多用户与 LiveSync 都应先完成威胁模型，而不是先加 UI。

## 代码证据映射

| 简历陈述 | 可检查的实现/测试 |
|---|---|
| BM25、向量、RRF、降级、原子 generation | [`../src/knowledge-index.mjs`](../src/knowledge-index.mjs)、[`../test/knowledge-index.test.mjs`](../test/knowledge-index.test.mjs) |
| OpenAI-compatible / Anthropic | [`../src/llm-client.mjs`](../src/llm-client.mjs)、[`../test/llm-client.test.mjs`](../test/llm-client.test.mjs) |
| OpenAI-compatible / DashScope embedding | [`../src/embedding-client.mjs`](../src/embedding-client.mjs)、[`../test/embedding-client.test.mjs`](../test/embedding-client.test.mjs) |
| SSE Q&A 与草稿流程 | [`../src/task-manager.mjs`](../src/task-manager.mjs)、[`../test/server.test.mjs`](../test/server.test.mjs) |
| 草稿确认、并发冲突、附件 | [`../src/vault-store.mjs`](../src/vault-store.mjs)、[`../test/vault-store.test.mjs`](../test/vault-store.test.mjs) |
| 路径与隐藏目录安全 | [`../src/path-policy.mjs`](../src/path-policy.mjs) |
| 会话、同源与写请求保护 | [`../src/auth.mjs`](../src/auth.mjs)、[`../test/auth.test.mjs`](../test/auth.test.mjs) |
| Docker hardening 与 Secret | [`../compose.yaml`](../compose.yaml)、[`../compose.secrets.yaml`](../compose.secrets.yaml) |
| 检索评测 | [`../scripts/evaluate-retrieval.mjs`](../scripts/evaluate-retrieval.mjs)、[`../eval/README.md`](../eval/README.md) |
| Headless 外部可选边界 | [`sync.md`](sync.md)、[`../compose.obsidian-sync.yaml`](../compose.obsidian-sync.yaml) |
| LiveSync 未实现声明 | [`sync.md`](sync.md#self-hosted-livesync-status) |

## 面试演示建议

准备一个完全虚构、可公开的 demo Vault，不要展示真实日记或 API Key。

1. 展示关键词命中精确术语，再展示语义查询；
2. 展开来源预览，说明路径如何进入 grounded context；
3. 发起 Q&A，展示 SSE 流式文本与引用；
4. 生成日记草稿，证明确认前目标文件不存在；
5. 在另一个终端修改目标文件，演示确认保存返回冲突；
6. 展示 `.obsidian` 文件无法搜索/读取；
7. 执行 `npm run verify` 和 synthetic eval；
8. 主动说明单节点、LiveSync、OCR/多模态等限制。

演示前务必检查浏览器历史、终端历史、日志、截图、环境变量和 Vault 中
不存在隐私或凭据。

## 投递前自检

- [ ] GitHub README 的所有命令在干净环境跑过；
- [ ] `npm run verify` 通过；
- [ ] `docker compose ... config --quiet` 三种组合均通过；
- [ ] 仓库和 Git 历史没有 `.env`、Vault、索引、聊天、日志或 Secret；
- [ ] 简历只写自己能现场解释到代码和测试的部分；
- [ ] synthetic 指标明确标注数据规模和局限；
- [ ] Obsidian Headless 写明“外部、可选、本地构建、不可随意分发”；
- [ ] LiveSync 写明“roadmap / not implemented”；
- [ ] 演示数据完全虚构，链接不会暴露私人域名、IP 或用户名。
