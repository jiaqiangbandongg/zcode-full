# Plan Mode Plan File Compact Continuity

## 背景

当前 ZCode 的 `ExitPlanMode` 仍通过 tool input 的 `plan` 字段承载完整 plan。若 `ExitPlanMode` 审批后很快触发 compact，summary 可能没有保留完整 plan，compact/resume 后模型无法稳定拿回已批准 plan。

## 目标

审批通过后的 `ExitPlanMode.plan` 必须同步写入 workspace root 下的确定性 plan file。compact 成功后，runtime 必须把该 plan file 的路径和完整内容作为 `plan_file_reference` model-only reminder 持久化到 compact 后历史里。

## 路径合同

plan file 路径为：

```text
${workspaceRoot}/.zcode/plans/plan-${sanitizedSessionId}.md
```

`workspaceRoot` 表示工作区根路径；不能使用可能被 Bash `cd` 改变的 `workingDirectory`。`sanitizedSessionId` 只保留 `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`，其他字符替换成 `-`，并去掉首尾 `-`。

## 写入合同

`ExitPlanMode` 在用户审批通过并应用 permission broker 返回的最终 input 后写 plan file。写入内容必须是最终 `plan` 原始字符串，不能 trim、补换行或做其他规范化；空 plan 只用于输入校验。写入使用 `FileSystemPort.writeTextFile()`，参数必须包含 `createParents: true`、`atomic: true`、`encoding: "utf8"`。写失败只影响后续 compact continuity，不阻断用户已批准的退出 plan mode。

## Compact 合同

compact 成功后，如果确定性 plan file 存在且内容非空，runtime 在 `postCompactReminderEntries` 中追加 source 为 `plan_file_reference` 的 model-only reminder，内容格式为：

```text
A plan file exists from plan mode at: ${planFilePath}

Plan contents:

${planContent}

If this plan is relevant to the current work and not already complete, continue working on it.
```

该 reminder 排在 generic read-state reminders 前面，并通过现有 `persistCompactSummary()` 与 compact summary 一起持久化；任一步持久化失败时沿用现有 compact persistence rollback。

## 非目标

- 不改变 provider-visible `ExitPlanMode` input schema。
- 不实现 runtime injected `plan` / `planFilePath`。
- 不改变 `ExitPlanMode` output shape。
- 不新增 UI 展示。
- 不把 plan file 加入 generic read-state reminder。
- 不处理用户手动删除 `.zcode/plans` 后的恢复。
- 不在本次 compact continuity 改造内实现默认 plan file retention cleanup；若后续实现，应由保留周期配置驱动并清理默认 plans 目录下的过期 `.md`，不是 `ExitPlanMode`、compact 或 session 结束时的即时删除。
