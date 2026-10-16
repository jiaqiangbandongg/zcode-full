# Web Remote Control Task Snapshot In-Flight Dedupe

## 背景
手机远控首屏恢复时，多个 UI hook 会并发调用 `zcodeTaskService.getTaskSnapshot(...)`。
在大任务场景下，这会让 host 连续返回多份超大 snapshot，并通过 relay 重复发送大包。

## 改动
在 `packages/ui/src/hooks/useZCodeTaskService.ts` 为 `getTaskSnapshot` 增加并发去重：
- 维度：`workspacePath + workspaceIdentity + taskId + messageLimit + byteBudget + toolLimit + clientMode`
- 行为：同 key 的并发请求复用同一个 Promise，只发起一次 RPC
- 生命周期：请求完成后立即从 in-flight map 清理

`clientMode` 必须参与 key。桌面 `desktop-continuous` 和手机 `web-remote-replayable` 的 snapshot 恢复语义不同：手机端可能带运行态恢复、active prompt 拼接、replayable command 状态和字节预算；桌面端保持 full continuous 旧语义。旧调用未传 `clientMode` 时按 `desktop-continuous` 处理。

## 作用
- 减少同一时刻重复的 `getTaskSnapshot` RPC
- 直接减少远控 relay 的重复大消息发送
- 保持现有接口不变，对调用方透明
