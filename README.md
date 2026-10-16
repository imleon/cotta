# Cotta：把 Claude Code 搬进 Web 和 Lark

Cotta 是一个运行在本地的服务，它把终端里 Claude Code 的工作内容搬进浏览器和飞书。离开终端，你依然可以浏览历史、翻看每个 Turn、继续对话，让 Claude Code 的工作不因为你离开电脑或远程终端而中断。

Cotta 以 Claude Code 作为底层运行时，Session 仍是 Claude Code 原生的，终端和 Cotta 可以混用，在一边开始，在另一边继续。所有数据和运行时都在你本机，登录只放行你指定的一个 GitHub 账号。

## 产品功能

- **与 CLI 共享 session：** 在终端开始的任务，可以在 Cotta 里浏览和接续，反过来也一样。
- **Timeline：** 按 Turn 流式呈现消息，工具调用、思考、Plan 可展开；主 Agent 与 Subagent 轨迹分开。
- **Composer：** 支持文本和图片，可切换模型、Effort、Permission，运行中随时打断；权限确认和提问直接在 Timeline 里处理。
- **飞书：** 在卡片里浏览 session、翻看 Turn、发消息续聊，权限确认也在卡片内完成。
- **搜索与 Share：** 跨 Project 全文搜索 session；把 Turn 生成公开链接或导出 Markdown、长图。
- **工作区：** 文件浏览、Git Diff、内置 Terminal、Token 用量统计。

## 安装使用

需要 Linux 或 macOS、Node.js >= 22.13，以及本机已能正常使用的 Claude Code CLI（订阅账户或第三方模型网关均可）。

```bash
npm i -g https://github.com/imleon/cotta/releases/download/v0.1.1-alpha.1/cotta-0.1.1-alpha.1.tgz
cotta start
```

首次启动时输入唯一允许登录的 **GitHub 用户名**（不是邮箱）。然后访问 `http://localhost:3000`，通过 GitHub Device Flow 授权登录。

```bash
cotta status      # 查看状态
cotta stop        # 停止
cotta restart     # 重启
cotta start -f    # 前台运行
cotta uninstall   # 停止服务、删除 ~/.cotta 数据并卸载
```

监听地址和端口可通过 `HOST`、`PORT` 环境变量设置。
