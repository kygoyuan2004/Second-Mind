# Claude Agent SDK 迁移记录

状态：隔离迁移与核心验收已完成；Linux 安装器完整验收已完成；8788 部署通过；GitHub 发布仍在进行。基准日期：2026-09-15。

## 基准与边界

原版没有 Git 提交；已在仓库外建立源码指纹与私有源码快照。移植文件的相对路径和 SHA-256 见 [清单](original-source-manifest.json)。原版服务只作只读对照。目标项目原有未提交修改、完整 Git 目录、私有配置、运行数据和 Vault 副本均已备份；恢复说明保存在私有备份目录。

知识库采用原版 `@anthropic-ai/claude-agent-sdk@0.3.247`、提示词、任务预算、检索和交互。保留 Second Mind 的管理员配置、多知识库注册和部署能力。个人主页、网盘、通用 AI 工作台、学习计划网站及私人教程不属于迁移范围。

## 功能与依赖对照

| 原版能力 / 入口 | 原版实现 | 新实现 | 验证方法 | 当前结果 / 差异 |
| --- | --- | --- | --- | --- |
| 登录与管理员权限 | account-server.mjs、lib/user-store.mjs | src/auth.mjs、src/server.mjs | 浏览器登录、越权、敏感操作再次鉴权 | 离线权限及完整应用浏览器登录通过；目标账号与凭据保留 |
| 五种知识库模式与移动布局 | public/knowledge.html、knowledge.css、knowledge.js | 同名 public 文件 | 桌面 / 移动截图、交互对照 | 原版界面及移动端已移入；品牌、配置入口和所选库参数适配通过浏览器测试 |
| 精确 / 语义 / 混合检索 | lib/knowledge-store.mjs、knowledge-index.mjs | src/original/ 同名模块 | 相同演示资料的路由、排名、分词、缓存测试 | 原版对应自动化测试通过 |
| Embedding 与条件重排 | lib/bailian-retrieval.mjs | src/original/bailian-retrieval.mjs、运行时适配 | 请求参数、超时、缓存、降级、管理页构建 / 取消 | 原版及配置/构建激活自动化通过；真实单文件小库构建、激活、重启后语义查询与条件重排通过（1024 维 qwen3.7-text-embedding） |
| 来源引用、消歧、原文预览 | lib/source-resolver.mjs、public/knowledge-sources.js | src/original/source-resolver.mjs、同名前端 | 多同名路径、引用锚点、浏览器预览 | 原版对应自动化测试通过 |
| SDK 工具循环与流式事件 | lib/knowledge-agent.mjs | src/original/knowledge-agent.mjs | 真实 SDK 工具调用、事件与结果 | 百炼、DeepSeek 隔离真实任务通过 |
| SDK 会话恢复 | KnowledgeAgentManager、sdkSessionId | 同类与独立 SDK 状态目录 | 多轮、刷新、服务重启、切换配置 | 两家多轮通过；DeepSeek 服务重启续聊通过；旧文本经 SDK 续接与原文件保留测试通过 |
| 普通 / 深度任务 | lib/task-modes.mjs | src/original/task-modes.mjs | 20 / 50 轮、10 / 30 分钟与取消 | 原预算保留；真实 SDK 取消及触发原定时器的超时中止测试通过 |
| 条件子 Agent | lib/subagent-policy.mjs | src/original/subagent-policy.mjs | 普通模式禁止；深度最多两个只读 Agent | 原版对应自动化测试通过 |
| 学习回顾与日期 | lib/learning-review.mjs | src/original/learning-review.mjs | 固定日期、全方向覆盖、计划 / 完成区分 | 已移入基准；50 轮、30 分钟、40 次读取、24 分钟读取期 |
| 联网补充 | lib/tavily-mcp.mjs、bailian-web-search.mjs | src/original/ 对应模块与配置适配 | 真实 MCP、失败提示、关闭联网、凭据隔离 | 原版 MCP 策略、Tavily 实际 worker 离线启动通过；百炼真实 SDK 搜索两次通过；全文提取按管理员关闭设置返回明确限制 |
| 草稿生成 / 编辑 / 确认 | lib/knowledge-agent.mjs、knowledge-store.mjs | src/original/ 对应模块 | 日记 / 计划 / 随心记，确认前无写入、冲突及路径检查 | 原版对应自动化测试通过 |
| 图片 / 文本 / PDF 附件 | lib/knowledge-agent.mjs | src/original/knowledge-agent.mjs | 限额、模型能力、确认后保存 | 原版自动化及百炼真实 PDF 核对、图片颜色识别通过 |
| 语音 | lib/knowledge-transcriber.mjs、scripts/transcribe-audio.py | src/original/、src/scripts/ | 实际音频转写、超时、临时文件清理 | 只读 linux/amd64 容器内实际音频转写通过；公开固定版本模型 |
| 视频 | lib/knowledge-video.mjs、两个视频脚本 | src/original/、src/scripts/ | 上传 / URL、关键帧、转写、草稿、取消 | 同容器上传视频、关键帧、真实转写、SDK 模拟上游草稿及清理通过 |
| 完整配置页 | 目标项目 public/admin-config.* 与配置接口 | 保留并接入 SDK | Provider、密钥保留 / 清除、连接验证、保存、重载、名称 | 两家真实浏览器录入/连接/保存/重载通过；其他配置自动化覆盖 |
| 多知识库 | 目标项目 knowledge-base-registry / hub | 同模块与原版运行时 | 索引、任务、会话、草稿、引用、写入隔离 | 完整 SDK 应用双 Vault 浏览器来源、会话、草稿写入隔离通过 |
| Docker / 安装器 | 目标 Dockerfile、Compose、install.sh、install.ps1 | 同入口与 SDK / 媒体依赖适配 | 三平台真实流程及两种 Linux 容器架构 | linux/amd64 SDK 与媒体实测通过；Linux 完整安装生命周期通过；其余平台/架构待 CI，支持范围保留 |

## 必要工程适配

1. SDK 读取独立私有配置与状态目录；不复制宿主机 `~/.claude`。每个任务固定模型和连接配置，保存后影响后续任务。
2. 模型设置采用供应商实际支持的协议与参数；不再把所有思考等级自动映射为同一种效果。原版百炼参数优先保留。
3. 新索引和 SDK 状态不能覆盖旧数据；旧数据迁移先备份，保留回退入口。
4. 服务中的错误与诊断必须脱敏。配置读取只返回凭据是否已配置。
5. SDK 保持原版 0.3.247；HTML 清理库 DOMPurify 从原版 3.4.12 升至 3.4.15，修复 [GHSA-55q2-fjhq-7xh7](https://github.com/advisories/GHSA-55q2-fjhq-7xh7)。本次是安全补丁，不调整提示词或产品交互；重新运行渲染、引用、浏览器与完整回归。

## Provider 兼容性矩阵

| Provider | 协议依据 | 模拟完整 SDK | 真实调用 | 限制 |
| --- | --- | --- | --- | --- |
| 百炼 Qwen 3.8 Max | Anthropic Messages / x-api-key | 通过 | 配置页验证、两轮问答、深度学习回顾、日记和计划通过 | Low 与原版默认 XHigh 有实测；不推广到百炼所有模型 |
| DeepSeek 官方 | Anthropic Messages / x-api-key | 通过 | 配置页验证、两轮问答、随心记、重启续聊通过 | Low 连接与 High 核心任务实测；模型别名路由由供应商决定 |
| GLM | [官方兼容接口](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction) | 原生预设与读工具循环通过 | 未验证，没有提供凭据 | 原生思考参数没有实测，只显示模型默认 |
| Kimi | [官方 Messages 接口](https://platform.kimi.com/docs/api/messages) | 原生预设、Bearer 鉴权、读工具循环通过 | 未真实验证；发现现有旧接口凭据，扩展调用授权待确认 | K3 Low/High/Max 按文档提供，未证明真实质量或账号权限 |
| Custom | 显式选择 Anthropic Messages | 独立假定端点和凭据隔离通过 | 未验证具体第三方端点 | OpenAI Chat Completions 不兼容本 SDK 链路，明确报错 |

[DeepSeek 官方说明](https://api-docs.deepseek.com/guides/anthropic_api/)目前记载，`deepseek-v4-pro` 别名在 2026-09-14 北京时间中午后可由其服务端路由到 V4.1 Flash。实测 `/models` 仍列出 `deepseek-v4-pro`，请求也使用该 ID；这些证据不能证明背后仍是某个固定 Pro 权重版本。本应用没有替换 ID，也不把供应商路由误报为已核实模型版本。供应商文档各页可能更新不同步，应以其账户/请求证据核实。

## 验收层次与当前范围

| 层次 | 已完成 | 待完成 |
| --- | --- | --- |
| 静态 / 自动化 | 本地完整回归 393 项：391 通过、2 项按条件跳过，包含原版 47 项；Linux/macOS 完整 CI 与 Windows 可移植 CI 通过 | 发布产物最终核验 |
| 浏览器 | SDK 完整应用的登录、配置保存、刷新历史、来源预览、双库隔离与确认保存；8788 切换后桌面/窄屏回归通过 | 发布后的 Pages 站点 |
| 真实模型 | 百炼 6 个任务、DeepSeek 4 个任务，共 25 次任务 Messages 请求；另有两家基础及配置页连接检查 | 其他 Provider 凭据及实际平台验证 |
| 部署 | 私有备份、隔离应用、只读容器内 SDK 与实际音视频 | GitHub CI、镜像和 Pages 发布核验 |

真实任务 SDK 汇总用量（包含多轮和缓存）：百炼 input 1,348、cache creation 45,366、cache read 77,242、output 11,440；DeepSeek input 7,897、cache read 19,968、output 1,821。SDK 的 USD cost 字段是 SDK 估算，不是百炼或 DeepSeek 账单，故不作为实际费用报告。首轮/追问耗时分别约为百炼 11.6/3.6 秒、DeepSeek 6.5/2.0 秒。连接检查和其他后续测试另行计数，不包含在上述任务用量中。

真实任务使用公开、独立的小型演示 Vault，没有复制私人资料。它们能证明已列出的功能链路，不能证明私人全库上的回答质量或所有供应商兼容性。

## 生成结果的已知限制

- 百炼学习回顾正确排除了 8 月记录、区分三篇计划与一篇完成，并枚举读取了三份期内材料。部分来源采用正文路径及行号，未始终遵守原版的 `〔来源：路径#标题〕` 格式。
- 百炼日记和计划返回了额外解释与代码围栏；日记还把另一目录中的同日记录误当成目标说明的一部分。原版目标写入路径仍由服务器限定，未写入该模型建议路径。验收通过原有编辑器去除额外说明并确认保存，保留了原始输出证据。
- DeepSeek 随心记明确标记为未验证想法，经确认保存；标题按原版文件名规则去除了标点。模型生成内容仍需检查。
- 联网补验实际执行 Read、KnowledgeSearch、两次搜索和一次提取请求。搜索未直接给出官方深层页面，回答说明了摘要与译载来源的局限；管理员关闭全文提取时，工具明确说明不可用。原版最多保留 800 条内存流式事件，因此完整工具计数从私有 SDK 会话记录核验。
- 上述现象没有通过修改原版提示词、缩短任务或放宽预算隐藏。当前保留原版生成与人工审核行为。

## 部署平台矩阵

| 支持项 | 当前实测环境 / 结果 |
| --- | --- |
| Docker linux/amd64 | Linux x86_64，read-only 容器；实际 SDK 工具/流式、Python/Whisper/ffmpeg 视频链路通过 |
| Docker linux/arm64 | 支持保留；构建和运行验证待完成 |
| Linux amd64 / arm64 安装器 | Linux x86_64 + Docker Engine 实测：安装、管理员登录、名称配置持久化、重启、状态、日志、更新前备份和旧镜像保留、独立恢复、保留数据卸载后再次启动；中文与空格路径通过。arm64 主机安装待验 |
| macOS Intel / Apple Silicon | macos-latest 的 Node 22 完整回归和共享安装器逻辑通过；实际 Docker Desktop 安装与宿主生命周期未实测 |
| Windows 10/11 + Docker Desktop Linux 容器 | windows-latest 的 Node 22 可移植套件、PowerShell 5.1/7 语法检查通过；实际 Docker Desktop 安装与宿主生命周期未实测 |

## 数据、截图与回退

旧会话和草稿原文件不改写，SDK 使用独立 `sdk-v1` 目录及迁移收据。自动化覆盖重复导入、导入中断重试、符号链接拒绝、历史文本进入 SDK、旧草稿确认及原文件字节保持不变。未配置的历史模型仍可查看，续接给出明确的新建会话提示。

六张公开图片来自完整应用：问答与执行过程保留真实 SDK 输出；日记、计划展示原有编辑器审核后的预览；配置页不回显凭据。截图采集脚本不再提供模拟 API，使用私有 recipe、真实应用会话和真实记录。截图与原始验收日志分离，后者仅保存在服务器私有目录。

原版两项服务的 PID、启动时间保持基线。源指纹中迁移核心文件未变；独立学习计划站点的五个文件出现外部修改，属于排除范围，迁移没有覆盖或回退这些变更。目标部署后再次复核，结果一致。

2026-09-15 15:12 UTC 已切换目标 8788 服务至锁定的 linux/amd64 镜像，约 1 秒恢复就绪。配置页原域名与 knowledgeBaseId=default 入口、管理员登录、三个原有模型配置、桌面与移动布局均通过实际浏览器访问。部署后真实音频转写返回 HTTP 200，约 2.3 秒。最终复核的 648 个 Vault 文件、7 个配置文件和旧会话文件与切换前私有备份逐字节一致；SDK 导入两个旧会话，没有清空旧索引和凭据。

旧索引格式保留在原位置，新 SDK 索引先提供原版词法检索；远程 Embedding 设置保留，需要管理员显式构建后激活，启动没有执行全库付费向量重建。隔离的一文件演示库已验证真实向量构建、激活、服务重启、语义查询和条件重排。

部署前另使用生产模型配置副本（qwen3.8-max-0902 / XHigh）在公开小库完成真实 SDK 读工具问答，SDK 记录两个成功的 Messages 响应。原部署代码、依赖和私有状态均保留，回滚脚本与前后服务单元位于仓库外；回滚只切换目标实例，不回写 Vault 或删除 SDK 状态。原版两项服务仍保持原 PID 与启动时间。

GitHub 提交、CI、双架构镜像与 Pages 发布状态待后续记录。

安装器恢复使用新实例、新空目录和新数据卷，并验证三份 SHA-256 清单。配置、会话、待确认草稿及源文件完整性另有自动化覆盖。Windows/macOS 的共享 Node 初始化、路径、备份恢复与安全拒绝逻辑在对应 CI 执行；这不等于完成当地 Docker Desktop 安装实测。

应用运行在 Linux 容器中。Windows 原生 Node CI 执行可移植套件及 PowerShell 5.1/7 语法检查；依赖 POSIX 所有者、0600 权限和目录 fsync 的完整应用/SDK 测试在 Linux 与 macOS 执行，原版的三个凭据文件权限用例和真实 Tavily worker 私有文件用例也采用这一范围。没有为 Windows 原生测试放宽生产凭据保护。CI 中另修正了浏览器保存/导航及历史异步落盘的测试等待时序。

安全扫描工具已修复 worktree Git 元数据挂载与错误码误判，零提交或 Git 错误均视为失败。发布前的工作树、实际可达历史、待提交文件、生成站点与最终生产镜像全部层均通过扫描；真实凭据另做精确匹配，七张公开图片通过中英文 OCR 和 PNG 元数据检查。DOMPurify 修补后的 npm audit 为零漏洞。
