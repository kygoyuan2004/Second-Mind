# Second Mind

让自己的 Obsidian 笔记参与问答、学习回顾和日常记录。

[English](README.en.md) · [项目展示](https://kygoyuan2004.github.io/Second-Mind/) · [安装](#安装) · [配置](docs/configuration.md) · [迁移与验收](docs/claude-sdk-migration.md)

![真实 SDK 问答与来源，使用公开演示资料](docs/assets/second-mind-qa.png)

Second Mind 是单管理员、自托管知识工作台。Claude Agent SDK 负责真实的检索、读取、工具循环和多轮会话；日记、计划、随心记与视频笔记先生成草稿，编辑并确认后才写入 Vault。

## 安装

准备 Git 和 Docker。Linux 使用 Docker Engine 与 Compose v2；Windows、macOS 使用 Docker Desktop 的 Linux 容器。

```bash
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
./install.sh
```

Windows PowerShell：

```powershell
git clone https://github.com/kygoyuan2004/Second-Mind.git
cd Second-Mind
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装器配置 Vault 目录、端口和管理员密码。宿主机不需要 Node.js。首次启动后，在配置管理中添加模型连接；未配置模型时仍可登录和进行本地关键词检索。

[Windows 10/11](docs/quickstart-windows.md) · [macOS Intel / Apple Silicon](docs/quickstart-macos.md) · [Linux amd64 / arm64](docs/quickstart-linux.md) · [Docker 与备份](docs/deployment.md)

支持矩阵与实测范围见[验收记录](docs/claude-sdk-migration.md)。支持声明与平台实测结果分别记录。

## 可以做什么

| 场景 | 实际行为 |
| --- | --- |
| 问答与来源 | 关键词、语义或混合检索，按需读取原文，点击引用预览笔记 |
| 普通 / 深度 | 普通最多 20 轮、10 分钟；深度最多 50 轮、30 分钟，按条件使用最多两个只读子 Agent |
| 学习回顾 | 固定日期范围，先枚举再读原文，区分计划、进行中和已完成，报告覆盖缺口 |
| 日记 / 计划 / 随心记 | 生成 Markdown，预览和编辑后确认保存；并发修改检查及覆盖前恢复副本 |
| 图片 / PDF / 音视频 | Qwen 3.8 Max 支持图片和 PDF；语音转写、视频关键帧和转写在容器中处理 |
| 多知识库 | 独立索引、会话、任务、草稿、引用与写入；从页面切换 |
| 配置管理 | 模型、默认模型、原生思考等级、联网、Embedding、索引构建、名称和知识库注册 |
| 会话 | 刷新后从历史列表重新打开；重启可续接 SDK 会话；模型、思考等级或联网设置变化时新建对话 |

## 实际使用截图

以下截图使用独立公开演示库，来自完整应用及真实百炼 Qwen 3.8 Max SDK 任务。日记、计划展示通过原有编辑器去除模型额外说明后的预览。它们不包含私人知识库，也不代表未经审核即可保存模型输出。

| 执行过程 | 配置管理 |
| --- | --- |
| ![真实检索和读取工具事件](docs/assets/second-mind-execution.png) | ![管理员配置真实服务，凭据不回显](docs/assets/second-mind-provider-config.png) |

| 日记草稿 | 计划草稿 |
| --- | --- |
| ![编辑后的日记预览与确认入口](docs/assets/second-mind-diary.png) | ![编辑后的计划预览与确认入口](docs/assets/second-mind-plan.png) |

## 模型与数据边界

固定使用原版 `@anthropic-ai/claude-agent-sdk@0.3.247`。百炼与 DeepSeek 已通过隔离真实 SDK 核心验证；其他 Provider 的状态单独列于[兼容性矩阵](docs/claude-sdk-migration.md)。模型 ID 原样保存；供应商自己的别名路由不能由本应用保证。

服务端按任务固定连接和凭据。真实 Key 不交给浏览器或 SDK 子进程；SDK 使用独立私有状态目录，不读取宿主机的 `~/.claude`。模型仍会收到问题、附件和工具返回的笔记片段，远程 Embedding 会收到索引文本；自托管不等于模型处理全部留在本机。[数据流](docs/data-flow.md) · [安全边界](docs/security.md)

旧执行器及其文档、测试归档在 `archive/pi/`，不在生产导入图、npm 依赖或镜像构建上下文中。升级保留旧会话、草稿和原始状态，新 SDK 状态使用独立目录。

## 开发与文档

本地源码运行需要 Node.js 22.22+（或 24.8+），音视频建议通过 Docker 验证。

```bash
npm ci
npm run check
npm test
npm run site:check
```

- [架构与源码映射](docs/architecture.md)
- [配置与保存生效规则](docs/configuration.md)
- [HTTP / SSE 接口](docs/api.md)
- [学习回顾](docs/learning-review.md)
- [迁移差异、验证范围与限制](docs/claude-sdk-migration.md)
- [部署与回滚](docs/deployment.md)
- [同步方式](docs/sync.md)

MIT License。当前面向一个可信管理员，不提供多租户权限或跨库联合检索。
