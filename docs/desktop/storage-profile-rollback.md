# Desktop storage profile 回滚

## 决策

回滚 `2a9e692862` 引入、`8e3a2ded32` 调整的 Desktop storage profile 隔离，
以及 `59548dc60a` 为该隔离补充的 Local Host → Agent CLI 路径覆盖。

回滚后恢复以下历史语义：

- Desktop、Host 和 bundled Agent 的默认用户数据目录统一为 `~/.zcode`。
- 不再根据源码开发、Stable 或 Preview 选择 `.zcode-dev`、`.zcode-beta` 等目录。
- 设置页的 `dataBaseDir` 仍只通过既有 `ZCODE_DATA_BASE_DIR` 传给 Host，用于 App 数据迁移。
- Host 不向子进程注入 `ZCODE_STORAGE_PROFILE`、`ZCODE_STORAGE_DIR` 或 `ZCODE_HOME`。
- 用户级 session、plugins、agents、commands、skills、logs 和 rollout 继续沿用既有
  `~/.zcode` 数据，避免升级后表现为历史数据丢失。
- workspace 内的 `.zcode/*` 路径保持不变。

## 根因

storage profile 把 App 自定义数据根作为精确 `ZCODE_STORAGE_DIR` 注入 Host，随后该环境
被 CLI 资源扫描和 Agent 子进程继承。用户原有资源仍位于 `~/.zcode`，因此运行时出现
session、插件、子智能体和命令同时缺失。3.7.2 只在 Agent spawn 边界覆盖 CLI 根，造成
Host/UI 与 Agent 分别读取两套目录，不能完整恢复历史数据。

回滚实现还必须同时清理所有已删除 storage profile 模块的 import，并让保留的 E2E 路径
helper 明确返回隔离 HOME 下的 `.zcode`。只恢复调用点而遗留 `zcode-storage-root` 的静态
引用，会导致 bundled Agent CLI 在 TypeScript 构建阶段失败；删除 E2E helper 的旧导出却
保留调用方，则会让仓库 typecheck 失败。

## 验收

| Case | 条件 | 期望 |
| --- | --- | --- |
| STORAGE-ROLLBACK-001 | 任意 Desktop 运行形态启动 Host | 不注入 storage profile、精确 storage root 或 `ZCODE_HOME` |
| STORAGE-ROLLBACK-002 | 用户配置 App 自定义 `dataBaseDir` | App 数据按既有逻辑迁移；CLI 用户资源仍从 `~/.zcode` 读取 |
| STORAGE-ROLLBACK-003 | Stable/Preview/源码开发访问同一用户资源 | session、plugins、agents、commands、skills 均沿用 `~/.zcode` |
| STORAGE-ROLLBACK-004 | 打开含 `.zcode` 配置的 workspace | 项目级 agents、commands、skills 路径不变 |
| STORAGE-ROLLBACK-005 | 构建 bundled Agent CLI 并执行仓库 typecheck | adapters 不再引用已删除的 storage profile 模块；E2E helper 固定解析隔离 HOME 下的 `.zcode`；两项检查均通过 |
