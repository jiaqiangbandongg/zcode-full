# Legacy Session Restore Skill

## 背景

旧版 ZCode session 记录已备份到 `~/.zcode-bak/v2/sessions`，当前新版 ZCode 已改用 `~/.zcode/cli/db/db.sqlite` 作为真实 session/message/part 存储，并用 `~/.zcode/v2/tasks-index.sqlite` 作为 app 侧任务列表索引。恢复历史任务时，用户需要先选择旧 agent，再选择要恢复的 workspace，最后选择具体对话。

## 目标

- 新增 workspace skill `restore-legacy-sessions`，用于指导 Agent 做旧 session 恢复前的选择和验证。
- 提供只读扫描脚本，按 agent、workspace、conversation 三层列出候选。
- 每个候选显示旧 snapshot 状态、新 CLI DB 状态、task-index 状态，避免重复导入。
- skill 默认只做 dry-run/规划；真正写库前必须先确认目标范围和回滚备份。

## 非目标

- 不重新启动任何旧 runtime。
- 不把旧 task stream/queue/owner 状态迁入 relay 或 main process。
- 不在扫描脚本里写入 `db.sqlite` 或 `tasks-index.sqlite`。

## 数据映射

- 旧源：`~/.zcode-bak/v2/sessions/{workspaceHash}/{legacyTaskId}.json`
- 新 session 首选旧快照中的稳定 session id；缺失时回退到旧 task id。
- 旧 snapshot ID：`meta.taskId`
- workspace 隔离键：`workspaceIdentity?.trim() || workspacePath`
- CLI DB 命中：`session.id = restoredTaskId`
- task-index 命中：`tasks.task_id = restoredTaskId and tasks.workspace_path = workspacePath`
- 恢复后的运行时 provider 统一写入 `glm`。旧 snapshot 里的 `meta.provider` 只表示历史来源，不写入 task-index `provider` 或 CLI message `providerID`。
- 旧版 session 恢复不写 task-index `migration_source`，也不写 `meta_json.migrationSource`。该字段当前只用于 Claude Code 原生导入的 `claudeCode` 专线，避免新增 `legacy-session` 这类未建模语义。
- task-index `meta_json.taskId` 必须等于 `restoredTaskId`，不能保留旧 snapshot 的 `meta.taskId`，否则 UI 读 meta 时会拿到 legacy task id。
- CLI DB 必须同时写 `message` 和 `part`。详情页从 `part` 表还原可见正文和工具调用顺序，只有 `message.data.content` 会导致任务可打开但历史区空白。

## Skill 工作流

默认只扫描备份源 `~/.zcode-bak/v2/sessions`，目的地仍是当前 `~/.zcode/cli/db/db.sqlite` 与 `~/.zcode/v2/tasks-index.sqlite`。需要检查原目录时，必须显式传入 `--legacy-dir ~/.zcode/v2/sessions`。

1. 扫描 agent：
   `node .agents/skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs agents`
2. 用户选择 agent 后扫描 workspace：
   `node .agents/skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs workspaces --agent glm`
3. 用户选择 workspace 后扫描对话：
   `node .agents/skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs conversations --agent glm --workspace /path/to/workspace`
4. 对选中的 conversation 做 dry-run 分类：
   - `ready`：CLI DB 和 task-index 都已存在。
   - `needs-cli-db`：task-index 已有，但 CLI DB 缺 session，需要从旧 snapshot 重建真实 session。
   - `needs-task-index`：CLI DB 已有，但 task-index 缺索引，需要补索引。
   - `needs-full-import`：两边都缺，需要完整导入。
5. 确认要恢复单个对话后执行恢复脚本：
   `node .agents/skills/restore-legacy-sessions/scripts/restore-conversation.mjs --snapshot ~/.zcode-bak/v2/sessions/<workspaceHash>/<legacyTaskId>.json`

## 安全约束

- 写库前必须备份两个数据库：`tasks-index.sqlite` 和 `db.sqlite`。
- 重复运行必须幂等：已存在的真实 session 不覆盖用户后续对话。
- task-index 更新必须保留已有 `pinned`、`archived`、`deleted`、`title_overridden`。
- task-index 冲突更新时必须清空旧恢复流程误写的 `migration_source`，并保持 `provider = "glm"`。
- CLI DB 恢复必须为每条 legacy message 写入至少一个 `text` part；assistant message 还要保留能映射的 tool part，并补上上一条 user message 的 `parentID`。
- UI / remote 恢复相关实现不得把 `web-remote-replayable` 恢复语义扩散到桌面 `desktop-continuous` 主链路。

## 验证

- 扫描脚本在默认路径下能输出 agent、workspace、conversation 三层列表。
- JSON 输出可被 `jq` 解析。
- skill 结构通过 `quick_validate.py`。
- 修改完成后执行 `pnpm typecheck` 和 `pnpm lint`。
