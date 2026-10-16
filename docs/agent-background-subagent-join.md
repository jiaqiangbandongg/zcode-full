# Background Agent Join 历史说明

本文档记录的是 2026-06 期间的旧临时方案：把 background subagent 重新收敛成“当前 main turn 内等待并 join”的行为。

该方案已经废弃，不再作为实现目标。新的执行计划见：

- `apps/zcode-cli/docs/design/v2/tool/07-subagent-background-plan.md`

## 废弃原因

- 当前目标不是让 main turn 等待 background subagent 完成后再结束，而是允许 main turn 先正常结束。
- background local_agent 完成后，应通过 `<task-notification>` 自动唤醒 main agent 继续处理结果。
- 旧方案明确排除了 idle wake，和当前目标相反。
- 继续沿用旧方案会掩盖 fake running / fake notified 这类真实 lifecycle 问题。

## 当前约束

- `Agent` / profile-backed subagent 体系继续复用。
- 如果现有体系内修复需要到处打补丁或维护多套状态机，允许升级为完整重构；但必须先写清触发原因、替代边界和回归测试。
- 不新增手动 background agent 管理入口。
- 不自动提交。
