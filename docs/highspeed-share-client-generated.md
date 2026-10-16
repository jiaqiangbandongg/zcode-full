# Highspeed 客户端分享卡片

## 约束

- 加速卡到期后，客户端直接基于已持久化的 token/TPS 统计发布左下角分享卡，不再调用服务端 `share` 接口。
- 会话内和左下角入口打开同一张分享弹框；弹框保留 Copy image 操作。
- Copy image 只生成统计区域的 SVG 图片，不包含弹框底部文案或按钮。
- 分享地址、share id 及对应 mock 已从 Highspeed 分享链路移除。

## 20/80 时间估算口径

- 普通模型总耗时按工具耗时 20% 与模型推理耗时 80% 组成。
- Highspeed 只缩短模型推理部分，工具耗时保持不变；模型推理加速倍率使用卡级 `highspeedTps / regularTps`。
- 对每条消息，以实际 Highspeed 执行耗时 `H` 反推普通模型耗时：`N = H / (0.2 + 0.8 / modelSpeedup)`。
- 节省时间为 `max(N - H, 0)`；同一张卡的多条串行消息分别计算后累加，避免卡级 TPS 直接反推总耗时造成偏差。

## CLI 持久化真实耗时

- CLI 在 turn 终态从模型请求和工具生命周期事件聚合 `modelDurationMs`、`toolDurationMs`，并将两者及未归类的 `otherDurationMs` 一并写入 user transcript 的 `highspeed` 元数据；这些字段是可选的，兼容旧消息。
- 分享统计优先使用这组持久化真实拆分：工具耗时保持不变，模型耗时按 `highspeedTps / regularTps` 倍率还原普通模型耗时；普通版总耗时 = 工具耗时 + 其他耗时 + 普通模型耗时。
- 如果旧消息没有真实拆分字段，继续使用上面的 20/80 估算，避免历史卡片因 schema 升级而失效。
- 工具并行执行按时间区间并集计算，避免并行工具被重复累加；模型重试请求按每次请求的实际 duration 累计。
