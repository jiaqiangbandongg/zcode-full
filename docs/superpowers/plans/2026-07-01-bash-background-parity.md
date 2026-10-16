# Bash Background Parity Plan Superseded

这份初版计划已被新的重构计划取代：

- `docs/superpowers/plans/2026-07-01-bash-background-refactor.md`

最终方向：

- Bash timeout auto-background 是 Bash 自有执行路径。
- 显式 `run_in_background: true` 和 timeout auto-background 复用已有 background completion / notification / runtime command queue。
- 公共 execution contract 只保留既有 `run`、`start`、`getBackgroundTask`、`cancelBackgroundTask` 边界。
- 不新增手动 background 操作入口、control tool、UI 2 秒提示或第二套 wake/notification 机制。
