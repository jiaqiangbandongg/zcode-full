# Session 管理分支同步上游

2026-09-14：用户批准直接在 `feat/session-manage` 合并
`feat/multi-device-remote-3-real-ssh-feature`（`243b87c2c0`），不创建 worktree。
本分支迁移的 ID 和定义后移，上游迁移必须先执行。

## 迁移契约

```text
CLI schema_migration:
  0001..0019 -> 0020_provider_model_selection -> 0021_official_glm_selection
    -> 0022_backfilled_session_reasoning -> 0023_session_soft_delete_outcome

Host:
  tasks_schema_migration: 0001_adopt_task_schema -> 0002_provider_selection
    -> 0003_official_glm_selection -> 0004_project_execution_scopes
  schema_migration: 0005_projects
```

保留上游历史 SQL、checksum 输入与 journal 形状。本分支旧 ID
`0020_session_soft_delete_outcome`、`0001_projects` 是新 ID 的历史别名：
验证旧 checksum 后沿用已完成结果，不重新执行转换；旧记录保留供旧代码识别。
新库仍先执行上游步骤，再执行本分支步骤。别名只用于本次开发分支的 ID 后移，
不允许借此忽略 checksum 变化。任何一步失败均不得开放业务写者。

`touchedTables` 声明每条迁移可能修改的表，备份和逐表边界测试共同使用；
缺失、空或非法声明在执行 SQL 前拒绝。上游 CLI 0020 声明
`message/part/session_entry`，0021、0022 声明 `session_entry`，0023 声明 `session`。
Host 任务迁移也沿用共享 runner 的表级备份和按数据库路径的串行 admission，
维持 `tasks_schema_migration` 的既有 checksum 与列，不把项目列插入冻结的历史 schema。
备份恢复使用各自 journal，不能恢复了业务数据却保留“迁移已完成”的记录。

CLI 继续独占会话事实、正文、软删除和结果，Host 继续独占项目归属与组织态。
两套 Host journal 只是兼容历史记账，不产生业务状态双写。
Host 0004 把本分支已有的 automation/off-peak 项目执行目录列移到上游任务迁移之后，
保证独立 Repo 可用；不创建项目或分配归属。0005 仍由带 settings 的 TaskIndexRepo 执行。

## 合并必须保留的行为

- 项目树及真实 roots 配置目录仍是当前设计；不恢复旧 Group/workspace 侧栏。
- 项目入口由 Host 持久化，tabs 只负责导航；settings 不反向复活已移除入口。
- 远端握手保留本分支的成员提交与取消检查，并整合上游 RPC dispose、
  握手期间关闭校验、按连接身份收口 close、发布点统一 reconnect 与稳定 Source identity。
- 共享协议同时注册项目 workspace 准备消息和资源快照消息。
- 草稿同时保存 projectId 与 initializeFromNewTask；user scope 配置使用 base host。
- storage-migrate 专用入口不依赖 provider 刷新或工具 runtime 准备。

```text
握手 -> 成员/取消/close 校验 -> 唯一 Source owner 发布 -> services 换代
           | 失败                       | 重连
           v                            v
     回收未发布连接              只通知一次有效发布

desktop-continuous -> 同一 Host/CLI 直接实时流
web-remote-replayable -> shared-host attachment -> snapshot/gap 恢复
```

## 验证场景

1. CLI 共同旧库、本分支已升级库、上游已升级库、新库都按新顺序完成；
   旧 ID 只转换记账、正文/软删除/结果保留，重复执行不改变数据。
2. Host 上游任务 schema 先于项目 schema，已有项目 ID/归属/顺序不重建；
   新旧 journal 共存、旧 checksum 不变，自动化与闲时字段可读写。
3. 缺 touchedTables、checksum 不匹配、迁移失败时不修改业务表；
   表级备份覆盖实际写表，恢复清理正确 journal。
4. 保留并运行两边已有的握手取消、手动重连、多 profile/同路径隔离、
   项目入口移除及桌面/手机交互 E2E；只迁移旧定位符，不删除场景。
5. 执行 schema 门禁、架构检查、typecheck、lint 与受影响测试。
   真实数据库操作、推送和 MR 不在此次授权范围内。

执行结果与环境限制见下方记录。

WCP01 随当前项目设计验证：通过 UI 新建带 root 的本地项目并删除，断言数据库软删除；
完整重启时即使存在同目录的旧 settings 快照，也不得再次导入或复活项目。
VP28 同时检查两套 Host journal，确认上游及执行目录迁移先于项目迁移完成。

## 合并验证记录

- 原分支 HEAD：`00d7538a0e44d79c4dbe5ddc4e5c609233eb8057`；合入目标固定为 `243b87c2c01ea4da6b5b6b6bdd71c4fab8e54528`。
- 合并前已建立保护分支。直接在当前分支解决 37 个文本冲突。
- 上游 22 条 CLI 迁移、3 条 Host 迁移的历史 checksum 全部相同；本分支 CLI 改号迁移的 SQL/checksum 相同，项目迁移保持冻结 checksum 测试。
- SQLite/Repo/草稿等最终专项：8 文件 193 项通过；项目及归属专项：21 文件 166 项通过。包含旧 ID 升级不重跑、checksum 拒绝、事务回滚、并发迁移、两套 journal 的备份恢复。
- 远控握手、WebSocket、窗口 Registry、Main attachment：4 文件共 147 项通过。合并新增的 WSL 模拟用例修正了跨 describe 的窗口夹具污染，按新 attachment ACK 等待。
- CLI 存储/模型迁移/冷恢复：9 文件共 163 项通过。协议用例在与构建并行时触及默认 5 秒超时；临时计时定位 subscribe/fork 耗时后，移除诊断，按原超时单独运行 12 项全部通过，未放宽产品或测试超时。
- UI 恢复、配置路由、workspace identity、草稿专项通过；新恢复只持久化 lastActiveWorkspace，不让旧设置复活导航。
- 桌面 E2E（隔离 HOME、mock replay）：VP28 与 WCP01 两个 spec 均通过；验证迁移顺序、首次排序、项目删除及完整重启。报告位于 `packages/desktop/.e2e-artifacts/desktop-e2e-20260914-040830-608/summary.md`。
- `storage-migrate` 专用入口 3 项通过，包含独立进程首次升级、幂等重启与 checksum 拒绝。
- `pnpm typecheck`、CLI 生产代码 typecheck、`pnpm lint`、`pnpm db:schema:check`、`pnpm architecture:check --changed`、`pnpm test:architecture` 通过。架构新增违规为 0；lint 为 0 errors，保留仓库现有 warnings。

相对上游检查本分支差异无空白错误；上游带入的 document-skills 两处文件末尾空行及文档模板三处尾空格保留。

本次未连接真实 SSH/WSL/Docker 设备进行端到端联调，未执行全仓全部测试或完整 feature-boundary codegraph 扫描；远控结论限于上述模拟协议回归。没有启动真实数据目录上的应用升级，没有修改用户数据库，也没有推送或创建 MR。
