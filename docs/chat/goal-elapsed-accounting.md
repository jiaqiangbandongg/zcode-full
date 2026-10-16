# Goal Elapsed Accounting

V4 `GoalState` 投影当前 target 的 `timeUsedSeconds` 与 `activeRunStartedAtMs`。CLI target reducer 仍是累计耗时的唯一权威来源；live delta、cold snapshot 和 desktop/web renderer 都消费相同字段。

显示公式：

```text
active elapsed = timeUsedSeconds + floor((now - activeRunStartedAtMs) / 1000)
paused/terminal elapsed = timeUsedSeconds
```

- renderer 可用 1 秒 interval 更新 `now`，但不得把 tick 写回 session、store、relay 或 main process。
- `pauseGoal` 先让 target reducer 把本次 active 区间结算进 `timeUsedSeconds`，再进入 paused；UI 随后冻结显示。
- `resumeGoal` 建立新的 `activeRunStartedAtMs`，历史累计值不清零。
- verified/failed 等终态冻结累计值，重新打开、冷恢复和手机 replayable 恢复后必须保持一致。
- `activeRunStartedAtMs` 缺失或晚于当前时间时只显示累计基值，不能产生负数或 `NaN`。

`pauseGoal` 与通用 stop 不等价：前者显式改变 target 产品态并可在没有当前 provider work 时执行；后者只终止当前运行并进入现有 queue hold/disposition 流程。
