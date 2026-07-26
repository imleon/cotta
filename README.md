# Cotta v2

Cotta v2 是一个 Web-first 的 Claude Code Project Dashboard。

## 创建项目目录

点击项目列表的 `+` 可开始新对话。首次发送消息时，可选择已有项目，或创建一个新项目目录并以它启动首条 Claude Code session。

新目录仅创建在 `COTTA_PROJECTS_ROOT` 下；未设置时默认使用当前用户的 home 目录。目录路径相对于该根目录，可使用多级路径：

```bash
COTTA_PROJECTS_ROOT=~/workspace npm run dev
# 创建 experiments/demo 会落在 ~/workspace/experiments/demo
```

`CLAUDE_CONFIG_DIR` 控制 Claude 配置和 transcript 存储，不决定新项目目录位置。

它的目标不是替代终端，而是把 Claude Code 的 project / session 工作流延伸到 Web：

- 让历史 session 更容易发现、浏览和继续
- 让 live turn 的状态和时间线更清晰
- 让长任务可以脱离终端窗口继续观察和操作
- 用官方 Agent SDK 作为事实源，避免解析私有实现细节

核心理念：

1. **Web 是延伸层，不是第二套 Claude Code**
   - 终端仍然是 Claude Code 的核心入口。
   - Web 负责可视化、继续会话、查看历史和处理运行中的状态。

2. **事实源只来自官方 API / SDK**
   - 不依赖私有 JSONL 格式作为产品契约。
   - 不维护一套和 Claude Code 分叉的项目/session 真相。

3. **Timeline 是主要产品体验**
   - 用户关心的是一次 session 发生了什么、现在卡在哪里、下一步能做什么。
   - 原始事件可以复杂，但界面应该把它们整理成可读的工作流。

4. **列表侧用 cache + version + pull**
   - 后端维护统一 summary cache。
   - SSE 只推 version，不推完整数据。
   - 前端按当前已加载窗口拉取最新列表。

5. **少做平台，先做好一个清晰工作台**
   - 不急着做复杂配置系统、权限模型或多入口编排。
   - 先把 Claude Code project/session 的发现、查看、继续、打断做好。
