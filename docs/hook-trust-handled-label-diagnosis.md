# 历史诊断：Hook 原位置异常出现「已处理」（已修复）

> 状态：**已修复**（2026-08-20）；本文保留修复前根因与当前落点，避免重复修复
> 关联：workspace hook trust v2（squash `59c750020f0`）；hook 会话 UI 删除后的遗留问题

## 现象

HookTrust 的会话内 UI 删除后，hook 执行原本出现的位置（会话流里）出现一个孤立的
「已处理」折叠头，点开无任何内容。不应出现。

## 修复前根因链路

```
CLI core (apps/zcode-cli/packages/core/src/hooks/)
  configured-runner.ts: workspace hook sourceKind="project"
  display-metadata.ts: clientVisible = sourceKind !== "internal" ⇒ true
  runner.ts 软门禁: 未信任 hook 不执行，但发 HookRunBlocked 事件
    （durationMs:0, outcome:"blocked"；成功执行的 hook 发 Started/Completed）
        │
        ▼
Bootstrap 投影 (apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts,
onHookRunLifecycle)
  onHookRunLifecycle: HookRunBlocked/Completed ⇒ hookInvocation row
  （state:"completed"，row.appended 进会话 rows）
  ⚠ 这是为将来 hook UI 适配预留的数据链路，按设计工作
        │
        ▼
UI 分组 (packages/ui/src/v4/conversationTurnWorkSegments.ts:73)
  isAssistantWorkRow = kind !== "turnHeader" && kind !== "userInput"
  ⇒ hookInvocation row 被算进 workRows
        │
        ▼
UI 渲染
  ConversationRowView 无 hookInvocation 渲染分支（hook UI 已删）⇒ row 不可见
  resolveConversationTurnWorkStatus: workRows.length > 0 ⇒ hasWork=true
  ⇒ 空内容折叠段 ⇒ 兜底文案「已处理」(chat.history.worked，
    packages/ui/src/v4/ConversationTurnGroup.tsx:413)
```

## 历史定性

协议层（`workspace/hooks/trustGrant`、hookInvocation row schema、投影）均按设计工作，
**投影层从未删除该数据类型**——`hookInvocation` row 是为将来 hook UI 适配预留的链路。
当时那版 hook 执行状态 UI（`HookInvocationRow.tsx` / `ToolHookInvocationGroup.tsx` /
`hookInvocationPresentation.ts` 等）只存在于 `origin/feat/desktop-hook-execution-status`
分支（未通过评审），没有 Renderer consumer。问题出在：投影持续产出
`hookInvocation` row，UI 无渲染分支（row 不可见），但分组层
`isAssistantWorkRow` 白名单未同步——三者叠加使不可见 row 仍参与 work 计数与分段，
产生无内容的「已处理」段。成功执行的 hook 与被软门禁拦截的 hook 均会触发（不只 blocked）。

## 当前修复状态

```text
HookInvocationRow
  ├─ 不进入 assistant work / flow items /「已处理」折叠
  └─ ConversationTurnRenderUnit.hookInvocations
       -> ConversationHookDetailsAction
       -> turn footer Anchor + 只读详情 Popover
```

- `conversationTurnWorkSegments.ts` 与 `conversationTurnFlowItems.ts` 已把
  `hookInvocation` 排除，不再参与 work 计数或生成空折叠段。
- `ConversationHookDetailsAction` 已成为 Renderer consumer：只在存在
  `didExecute=true` 的 client-visible execution 时显示 turn footer Anchor。
- admission-only `HookRunBlocked` 不显示为“运行过”；实际 started execution
  仍保留安全摘要，desktop/web 复用同一 Renderer 路径。
- focused tests 已覆盖 hook-only turn 无空 work、混合 turn 的 work 统计、无正文终态
  Hook action，以及详情 Popover。

当前事实规格见 `docs/chat/conversation-hook-turn-summary.md`。历史中的
`session-hooks:<sessionId>` synthetic turn 已禁止；startup/resume SessionStart 会归入下一条
权威真实 product turn。
