# Cotta v2

Cotta v2 是一个 Web-first 的 Claude Code Project Dashboard。

## 数据库恢复

Cotta 默认把派生 SQLite read model 保存在当前工作目录的 `data/cotta.sqlite`；可用 `COTTA_DB_PATH` 指定其他路径。Cotta 启动时会自动执行受支持的事务化数据库升级。遇到不受支持的 schema 时，先根据错误中的当前版本和目标版本编写并执行一次性、事务化迁移；不要删除数据库。

只有确认数据库已经损坏、无法迁移，并且接受丢失其中不可重建的数据时，才停止 Cotta，删除实际数据库文件及同目录下对应的 `-wal`、`-shm` 文件，再重启：

```bash
rm -f data/cotta.sqlite data/cotta.sqlite-wal data/cotta.sqlite-shm
npm run dev
```

重启会从 Claude Code transcript 和仍存在的源文件重新扫描可恢复的 Project、session、raw Timeline、Turn metadata、task 与 subagent 信息，但会永久丢失 Web/global preferences、auth session、pin、session turn-option override、context usage，以及尚未写入 transcript 的 live-only cache。此操作不会删除 Claude Code transcript；若设置了 `COTTA_DB_PATH`，请替换命令中的默认路径。

它的目标不是替代终端，而是把 Claude Code 的 project / session 工作流延伸到 Web：

- 让历史 session 更容易发现、浏览和继续
- 让 live turn 的状态和时间线更清晰
- 让长任务可以脱离终端窗口继续观察和操作
- 遵循 Claude Code 的真实数据边界：Agent SDK 负责 command 与 live event，transcript JSONL 负责持久化的 session 历史

核心理念：

1. **Web 是延伸层，不是第二套 Claude Code**
   - 终端仍然是 Claude Code 的核心入口。
   - Web 负责可视化、继续会话、查看历史和处理运行中的状态。

2. **事实源遵循 Claude Code 的真实数据边界**
   - Agent SDK 负责 command 执行和 live event；Claude Code transcript JSONL 负责持久化的 session 历史事实。
   - JSONL 是必须显式管理的私有格式依赖，但其原始结构不是 Cotta 对外承诺的稳定产品契约。
   - SQLite、cache 和前端状态只是派生读模型；不维护一套和 Claude Code 分叉的项目/session 真相。

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
