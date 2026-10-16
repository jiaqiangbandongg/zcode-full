# Running 时的 Goal Command（当前事实）

`/goal` 使用 V4 `sendGoalCommand`。它既保留用户可见的原始命令文本，也在 CLI 内更新 goal 状态；UI 不再绕过输入 admission 直接调用旧 `session/goal`。

## 裁决

- session ready 时，`sendGoalCommand` 可以立即执行。
- active turn 存在时，命令以独立的 `sendGoalCommand` 身份进入 CLI runtime queue，不拒绝、不插队、不打断当前 turn。
- held queue 时遵循 `inputRouting.mode = choice`，由用户明确选择保留或清空既有队列后发送。
- 命令只有在 CLI 判定可消费时才执行；UI 不根据 assistant 行结束、verification marker 或本地 timer 推测 ready。
- Goal pause/resume、stop barrier 与自动续跑均由 CLI reducer/command handler 裁决。

```text
/goal input
  -> sendGoalCommand
  -> active turn?
       ├─ no  -> execute now
       └─ yes -> enqueue as goal command
  -> authoritative queue/goal projection
  -> desktop and mobile converge
```

当前实现入口：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/goal-compact.ts`。
