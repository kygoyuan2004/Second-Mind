# Second Mind 中文文档

[项目首页](../README.md) · [English README](../README.en.md) · [在线网站](https://kygoyuan2004.github.io/Second-Mind/)

Second Mind 是面向本地 Obsidian Vault 的单管理员、自托管知识工作台。它以本地文件和 BM25 检索为基础，可以按需接入独立的 LLM、Embedding 与 WebSearch Provider。没有配置 LLM 时，服务仍可启动、登录、管理多个知识库并执行关键词检索。

## 从这里开始

先安装并启动 Docker，然后选择对应平台：

- [Windows 10/11 快速开始](quickstart-windows.md)
- [macOS 快速开始](quickstart-macos.md)
- [Linux 快速开始](quickstart-linux.md)

安装器默认只询问知识库目录、管理员密码和端口。完成后在终端显示的 `127.0.0.1` 地址登录，再从管理员页配置可选 Provider。不要把应用端口直接暴露到公网。

## 当前能力边界

| 范围 | 当前实现 |
|---|---|
| 知识库 | 一个实例最多注册 32 个知识库；每库有稳定 ID、revision、显示名和独立运行状态 |
| 隔离 | 每库独立索引、Embedding 激活状态、会话、任务、草稿、恢复副本和审计记录 |
| 检索 | 中文感知 BM25；可选 OpenAI-compatible 或 DashScope Embedding；语义和混合 RRF |
| 生成 | Normal 与 Deep 问答；日记、计划、随心记草稿；SSE 执行过程和带 Vault 相对路径的引用 |
| 写入 | 草稿先保存在 Vault 外；用户确认后执行路径、符号链接、哈希与并发检查，再原子写入 |
| Provider | 阿里云百炼、DeepSeek、GLM、Kimi、自定义兼容服务；最多启用三个模型 |
| 联网 | 每个问答会话显式启用；百炼 WebSearch MCP 或 Tavily REST；可选安全网页读取 |
| 运维 | Docker-first 安装器、独立实例状态、健康检查、诊断、日志、更新和带 SHA-256 清单的备份 |

Second Mind 不是多租户 SaaS。模型不会获得 shell、任意文件读取或任意网络工具。应用服务端负责选择检索片段、限定 WebSearch 和网页读取、验证引用以及执行写入。

## 多知识库原则

安装时可以选择一个含 `.obsidian` 的 Vault，也可以选择包含多个 Vault 的父目录。父目录模式只自动发现下一层中含 `.obsidian` 的目录。每个自动发现或后来注册的知识库根都必须包含实际目录（不是符号链接）的 `.obsidian`。管理员之后只能在启动时授权的挂载点内，使用相对路径维护注册表。

浏览器对每个知识请求明确携带 `knowledgeBaseId`。任务创建后固定属于原知识库，切换选择器不会取消它，也不会让旧响应更新新知识库页面。跨知识库复用任务、会话或草稿 ID 会失败。某个库不可用时，其他健康库仍可服务。

注册表变更使用 revision 比较并交换，同时要求再次输入管理员密码。受影响知识库存在活动任务时不能变更。私有绑定清单把每个稳定 ID 永久绑定到首次规范化的 Vault 路径；删除注册项或重启不会释放 ID，换成另一套 Vault 时必须使用新 ID。删除注册项不会删除 Vault 或其私有运行数据。

## BYOK 与隐私

LLM、WebSearch、Embedding 凭据相互独立，不自动复用。配置 API 只返回是否已经配置，不返回 Key。浏览器不会把 Key 存入 Web Storage、URL 或 Cookie。改变 Provider 目的地址时必须重新提供对应凭据。

Vault、索引、会话、草稿、恢复副本、审计与凭据默认保留在管理员控制的主机和卷中，但“自托管”不代表所有操作始终仅在本地。启用远程 LLM、Embedding、WebSearch 或网页读取时，对应的选定内容会离开主机；要求内容绝不出站时，应只从本机浏览器访问，只使用在同一主机运行的兼容 Provider，禁用联网与远端同步，并把备份留在受控本地存储。

默认不会联系模型、搜索或 Embedding 服务。只有下列明确操作会产生远程数据流：

- 用户发起生成时，LLM 可接收问题、近期完整问答轮次、选中的笔记片段和文本附件片段；
- 管理员确认构建向量索引或执行语义查询时，Embedding 服务可接收笔记文本块或查询；
- 当前问答会话启用联网补充时，WebSearch 可接收有限查询词；
- 研究流程选择公开网页时，安全读取器可请求经过验证的 HTTPS URL，并把定界后的正文交给模型。

连接检查与 Embedding 构建可能产生费用，只会在管理员明确操作后执行。更完整说明见 [数据流与隐私边界](data-flow.md)。

## 文档地图

- [架构](architecture.md)：注册表、每库运行上下文、全局 Provider 服务和失败隔离
- [HTTP API](api.md)：认证、知识库选择、任务、SSE、草稿和管理员接口
- [配置](configuration.md)：管理员页、Provider、环境兼容项和知识库挂载
- [部署](deployment.md)：安装器、手工 Compose、更新、备份和卸载边界
- [安全](security.md)：资产、信任边界、路径策略、凭据与事件响应
- [网络访问](networking.md)：回环监听、私有网络和 HTTPS 反向代理
- [同步](sync.md)：外部文件同步与可选 Obsidian Headless 边界
- [数据流](data-flow.md)：本地状态和所有可选出站请求

## 运行门禁

仓库测试只使用临时目录、合成数据和 mock Provider，不应连接私人实例或真实付费 API。

```bash
npm ci
npm run check
npm test
npm run security:scan
npm run security:history
npm run site:check
npm run verify
```

发布门禁还应验证 Compose、隔离容器健康状态、真实浏览器流程、KaTeX、截图 OCR 与 metadata，以及镜像的 history、环境和构建上下文。

## 当前限制

- 只有一个管理员账号，没有 RBAC、SSO 或租户隔离。
- Self-hosted LiveSync 没有实现；任何同步程序都属于独立信任边界。
- 标准镜像没有 `bwrap` 和 `pdftotext`，所以 PDF 网页读取默认不可用，也不会回退到无 sandbox 解析。
- 安装器没有自动恢复和永久卸载命令，备份也不是跨应用与同步器的原子快照，且不自动包含独立同步器的私有状态。
- `update` 保留数据与配置，但没有自动镜像回滚；关键部署应固定 tag/digest、保留上一镜像并先验证备份。
- Linux 快速安装针对常规 rootful Docker；rootless Docker 与 SELinux enforcing 宿主机的 UID 映射、卷权限和 bind-mount relabel 需要管理员自行设计。
- Windows Service、macOS LaunchDaemon、Credential Manager 与 Keychain 集成没有实现。
- Docker `--mount` 不能可靠表示含逗号的宿主机路径。

## License

[MIT](../LICENSE)
