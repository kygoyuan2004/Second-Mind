## 下载与部署

| 使用方式 | 文件或入口 | 验证范围 |
| --- | --- | --- |
| Windows 桌面 | `windows-x64-setup.exe` | Windows 11 家庭版 x64 实机运行候选安装包中的程序，覆盖中文路径、本地与远程连接和文件权限。Windows Server 2022 CI 对安装器执行安装、升级和卸载。Windows 10 x64 待实机验证。 |
| Linux 桌面 | `linux-x86_64.AppImage` 或 `linux-amd64.deb` | Ubuntu x86_64 桌面启动、系统密钥环、本地 Vault 和远程连接。Debian 环境安装、重装和卸载。 |
| Docker Web | [安装说明](https://github.com/kygoyuan2004/Second-Mind/blob/v0.2.0/docs/deployment.md) | Linux amd64 安装器完成升级、备份、独立恢复和重启。镜像工作流验证 amd64 和 arm64。Windows 和 macOS 的 Docker Desktop 生命周期待实机验证。 |

下载后可用 `SHA256SUMS.txt` 核对文件。Windows 安装器未签名。桌面版自带 Node、Python 和 FFmpeg。Linux 保存桌面凭据需要已解锁的系统密钥环。应用状态和 Vault 均需纳入备份。

## 本版功能

- 本地和服务器上的 Vault 可以保留开发工具创建的缓存。遇到 `.cache`、`.git` 或 `node_modules` 时，SDK 在独立临时目录读取当前笔记，任务结束后清理。
- 从搜索结果或回答引用打开笔记，并定位到命中的段落。学习回顾按日期整理证据，区分已完成的事项和待确认的计划。
- 在计划草稿中预览、选择或修改事项。确认后写入 Markdown 和对应日期的每日安排。重复确认复用保存记录，每个知识库分别管理日程。
- 配置页支持百炼、DeepSeek、Kimi 和自定义 Anthropic Messages 接口，保留 GLM 配置。页面显示实际请求地址，支持连接检查及默认模型切换。Tavily 单独配置。四种连接已用公开演示笔记完成两轮真实问答，自定义项使用 DeepSeek 官方接口。
- Windows、Linux 与 Docker 网页版共享同一套配置和知识库界面。使用 `/admin-config.html?knowledgeBaseId=default` 可进入默认库的配置管理。

[查看真实运行截图与平台验收说明](https://github.com/kygoyuan2004/Second-Mind/blob/v0.2.0/docs/desktop-web-release.md)
