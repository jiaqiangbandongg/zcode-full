# 发送消息时的当前模型判定链路

更新日期：2026-07-15

> **历史链路审计，已被 Provider Refactor 取代。** 本文中的 workspace Provider Registry 推送、
> `runtimeModel` fallback 和 App/CLI 双目录不再是当前实现。当前模型由目标 Environment 的
> Model Selection、Registry 与 ModelFactory 解析。当前设计见
> `docs/working-memory/provider-refactor/design/`。

V4 `sendText` 不携带“本次使用哪个模型”的第二份 UI 决策。模型属于 session config；发送只在配置
命令之后进入同一 CLI session。这样 toolbar、队列和 runtime 不会分别保存互相覆盖的模型值。

## 总链路

```text
toolbar config action ─┐
                      ├─> configCommandBarrier（线性化用户操作）
composer sendText ─────┘
  -> V4 command ACK/admission
  -> 当前 session runtime config
  -> prompt turn
  -> ModelSelected/rows/snapshot 投影
```

## 已有 session

已有 session 发送时：

1. `SessionPane.dispatchSendText` 把发送动作放进 `configCommandBarrier`。
2. 在它之前入队的模型、thought、mode 和 follow-up 命令必须先完成。
3. `sendText` payload 只携带文本、已 ready 的附件引用，以及 held queue 的显式 disposition。
4. CLI 按当前 `inputRouting` 裁决立即开始、guide、enqueue 或要求 choice；模型仍取 session runtime
   当前 config。
5. ACK 只证明 admission 结果；最终 UI 以 conversation projection 收口。

因此“切模型 → 发送”使用新模型；“发送 → 切模型”不能反向改写已经 admitted 的 turn。这里保证的是同一
renderer 操作顺序，不把 desktop continuous 与 web remote replayable 合并成全局客户端 FIFO。

## 草稿首发

草稿没有正式 session，模型必须随创建建立：

- 预热 session 已存在：首发前再次把 `draftConfigRef` 对齐到预热 runtime，再 `sendText`。
- 无预热：`createSession.config` 携带 provider/model/thought/mode/followupMode；无附件时可与
  `firstInput` 原子提交。
- 首发成功后 draft pane 原地绑定返回的 sessionId；后续只读 snapshot config。

具体见 `docs/chat/new-task-model-resolution-chain.md`。

## Busy 与队列

V4 queue 在 CLI command core 内裁决，不再存在旧 renderer-local conversation queue：

- `inputRouting.mode=enqueue` 时，accepted input 进入 session 权威队列；command 不复制模型。
- `inputRouting.mode=choice` 时，普通输入必须携带 `heldQueueDisposition`，否则 UI 要求确认。
- queued input 真正执行时使用当时已经线性化并写入 session 的 runtime config。
- stop/held/auto-drain 的产品语义由 snapshot 与 CLI queue handler 决定，relay/main 不保存队列。

这意味着切模型可以影响尚未开始的队列项。项目目前没有“每条 queued prompt 固定入队时模型”的产品语义，
文档和测试不得作此假设。

## Provider 恢复和失败

模型配置命令如果返回 `provider.notInRegistry`，UI 先同步该 workspace 的 provider registry，再解析
`runtimeModel` 并只重试一次。恢复仍失败时不会继续发送一个看似使用新模型的 prompt；发送屏障会把失败
暴露给调用方。配置 noop 则可继续，因为 runtime 已经处于目标值。

## 当前代码入口

- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/configCommandBarrier.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/prompt-turn.ts`
