# 远程会话正在生成，侧栏任务行没有运行标志

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，补丁 08。
批次 `r3-server-20261011143037600-31012b` 的 `p0-main` 在 150.8 秒失败。

原回放使用固定 1200ms 响应，有错过运行态的可能。本次已改为显式闸门：B 首段回复输出后，
结束帧一直等待侧栏断言完成才释放。等待 30 秒期间，任务行状态始终为
`exists=true, inProject=true, active=true, error=false, running=false`。
失败录像中主区显示“工作中 31 秒”、生成指示器与停止按钮，B 行却没有运行指示器。
因此本次已排除响应提前完成、任务行不存在或归属错误。

```text
B 首段输出 → 回放闸门阻止结束 → 主区持续工作
  → B 侧栏行 active、无错误 → 30 秒内没有 running 图标
```

当前行使用 `deriveTaskLeadingIndicator` 决定 loading 图标。需核对远端 TaskActivity 到项目行的投影，
尚未将唯一根因定位到具体订阅或缓存。业务代码未改。
测试保留最终失败，但将这个非路由前置的展示差异汇总到末尾，以继续验证 A/B 四回合历史隔离和遥测；
行归属、active 或错误状态异常仍立即停止。当前批次的后半段尚未到达，后续复验另列。

补丁 09、批次 `r3-server-20261011150809016-2aeaba` 已跑完四回合和遥测，最终因两个 B 行运行标志
缺失而 FAIL（209.1 秒）。A/B 各有 2 条 agent_step 和 2 条 message_completion，远程归属及
各自历史隔离断言均已通过；B 的首发与续发两次观测都为 active=true、running=false。

证据：上述批次 `p0-main` 的运行日志和失败录像；四个真实 HTTP 回放闸门的聚焦测试已通过。
