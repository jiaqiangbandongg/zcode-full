# 工具结果结算

登记既有 `settleToolResults` 边界，保留原方法路径与调用方式。契约复用方法类型，不增加执行器、状态副本或持久化步骤。

```text
整批执行结果 → 同步写入两份 Runtime 历史 → 原有异步持久化与恢复锚点
```

- Runtime 仍是历史唯一所有者；调用方传入原 callID、工具声明和结果，不再次执行工具。
- DeferredToolCall 的包装标记随目标结果保存；模型投影与冷恢复继续使用原链路。
- 持久化失败不能留下仅有调用、没有结果的进程内历史；取消沿用现有整批收尾规则。
- 本次登记不改变桌面 continuous 或手机 replayable 投递。

运行时回归位于 `tests/runtime-tool-result-settlement.test.ts` 和 `tests/runtime-streaming-tool-part-identity.test.ts`。
