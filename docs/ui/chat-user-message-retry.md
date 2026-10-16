# Retry Turn（当前事实）

Retry 入口位于 assistant turn actions，发送 V4
`retryTurn { target: { rowId, entityId } }`，信封同时携带 `baseRevision/baseLogEpoch`。
CLI 统一 resolver 负责解析 canonical input intent、裁决 CAS 并生成新的权威 turn；UI 不执行旧 rewind + resend 组合操作。

User row 本身提供 edit/copy。编辑使用 `editUserQuery`，与 retry 是不同命令和产品语义。
