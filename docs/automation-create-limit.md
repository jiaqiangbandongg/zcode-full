# 定时任务创建数量上限

## 产品语义

- 单个本地任务索引最多保留 `20` 条定时任务定义。
- 统计范围与管理页 `listAllAutomations()` 一致，覆盖所有项目；不是每个 workspace 各 20 条。
- `active`、`paused`、`completed`、`failed` 等全部生命周期状态都占用名额。
- 闲时任务属于独立领域，不计入定时任务的 20 条上限。
- 更新、运行、暂停和恢复已有任务不受限制；只有删除定时任务定义才释放名额。
- 手动表单、模板、会话 `CronCreate` 等所有创建入口都遵守同一上限。

## 边界与时序

UI 根据已加载的全量列表提前阻止创建并展示国际化提示；该检查只用于交互反馈，不作为最终一致性边界。
服务层创建最终由 SQLite 写事务串行检查总数，避免桌面多窗口或会话工具并发创建时同时通过旧计数。

```text
UI / CronCreate
      |
      v
AutomationService.create
      |
      v
BEGIN IMMEDIATE
      |
      +-- COUNT(all lifecycle states) >= 20 --> rollback + limit error
      |
      +-- COUNT < 20 --> INSERT --> commit
```

达到上限时不得自动清理已完成或失败任务，也不得按 workspace、状态或是否启用过滤计数。

## 会话工具失败边界

`CronCreate` 命中全局上限后属于不可由 Agent 自行恢复的产品限制，不是普通可重试工具错误：

- 本次创建不修改任何任务。
- 当前模型轮次后续尚未执行的工具调用必须取消。
- 当前用户 turn 仅允许再进行一次无工具的模型回复，用当前语言直接告知已达上限，并提示用户前往
  “自动化”手动删除任务后重试。
- 该回复阶段不得再暴露 `CronList`、`CronDelete`、`CronCreate`、Bash 或其他绕过入口。
- Agent 不得自行选择、删除或覆盖已有任务；即使当前 workspace 的 `CronList` 少于 20 条，也不能据此
  推断其他 workspace 的全局名额或执行清理。

```text
CronCreate limit error
       |
       +-- cancel remaining tool groups in this model step
       |
       +-- lock all tools for the rest of this user turn
       |
       +-- one text-only response: explain limit and manual next step
```
