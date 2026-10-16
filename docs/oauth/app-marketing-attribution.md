# App 营销归因与埋点

## 目标

ZCode Desktop 从统一 OAuth 回调接收官网营销归因，并在所有发往
`/api/v1/event/report` 的 App 业务埋点中固定携带顶层字符串字段
`marketing_params`。

## 回调协议

统一回调 `zcode://oauth/callback` 支持：

- `channel_id`
- `utm_source`
- `utm_campaign`

三个营销参数允许部分存在，空白值不保存。App 不接收或维护营销归因过期时间。

## 生命周期

```text
startOAuth
  -> pending(state, phase="awaiting-attribution-or-code")
       ├─ 首次纯归因回调
       │    -> 保存归因
       │    -> pending(state, phase="awaiting-code-after-attribution")
       │         ├─ 重复纯归因回调 -> 拒绝，不重复写入
       │         └─ 最终授权码回调 -> 清理 pending -> token 交换
       ├─ 直接收到最终授权码回调 -> 清理 pending -> token 交换
       ├─ 再次 startOAuth -> 清理旧 pending -> 创建新 state
       └─ 5 分钟超时 -> 清理 pending

本地归因记录
  -> telemetry 上报读取
       ├─ 读取成功 -> marketing_params={...}
       └─ 读取失败 -> 单次受控告警 + marketing_params={}，继续上报
```

- 新的有效推广回调整体覆盖旧值。
- 纯归因回调是最终授权前的中转阶段，同一个 OAuth state 最多接受一次；它不会消费最终授权码回调。
- 重复纯归因回调不得重复写入归因，也不得延长 pending state 的 5 分钟生命周期。
- 重新发起 OAuth 会取消旧 state；归因后的最终授权只允许在同一未超时 state 上继续。
- 已保存的归因不会因时间自动失效，直到新的归因覆盖或本地凭据被清理。
- 兼容本分支早期短暂使用过的 `{ params, expiresAt }` 存储结构，读取时忽略
  `expiresAt`，仅保留三个营销字段。

## 埋点契约

所有经 `TelemetryCore` 上报到 `/api/v1/event/report` 的事件，包括
`app_launch`、`app_daily_active` 和 renderer 业务事件，均携带：

```json
{
  "marketing_params": "{\"channel_id\":\"douyin\",\"utm_source\":\"wechat\",\"utm_campaign\":\"summer_sale_2026\"}"
}
```

无归因时仍保留字段：

```json
{
  "marketing_params": "{}"
}
```

ARMS 崩溃、性能、资源和网络观测不属于 `/api/v1/event/report` 业务埋点，
不携带营销归因。

归因凭据读取是 telemetry 的附加上下文，不是上报前置条件。读取异常时仍发送原事件，
`marketing_params` 使用空对象；同一个 `TelemetryCore` 生命周期只通过 service logger 记录一次固定脱敏告警，
不附带原始 Error、stack、本机路径或凭据后端详情，避免高频事件刷屏和扩大隐私暴露面。

## 审核修复覆盖

| Case ID       | Setup                      | Action                      | Assertions                                               |
| ------------- | -------------------------- | --------------------------- | -------------------------------------------------------- |
| OAuth-ATTR-01 | pending state 尚未接收归因 | 投递纯归因回调              | 保存一次并进入 `phase="awaiting-code-after-attribution"` |
| OAuth-ATTR-02 | 同一 state 已接收归因      | 重复投递纯归因回调          | 拒绝且不覆盖首次归因                                     |
| OAuth-ATTR-03 | 同一 state 已接收归因      | 投递最终授权码              | 清理 pending 并完成登录                                  |
| OAuth-ATTR-04 | 旧 state 已接收归因        | 再次 `startOAuth`           | 旧 state 失效，新 state 可继续                           |
| OAuth-ATTR-05 | 同一 state 已接收归因      | 等待超过 5 分钟后投递授权码 | 以 state 过期拒绝                                        |
| OAuth-ATTR-06 | 归因凭据读取失败           | telemetry 上报              | 使用 `{}` 继续发送，并仅告警一次                         |

## 存储边界

归因以 `oauth:login_attribution` 为 key，通过 CredentialService 加密保存到 App
全局凭据存储。它不按 provider、窗口或 workspace 隔离，本地与远程 workspace
窗口共享同一份 App 归因。
