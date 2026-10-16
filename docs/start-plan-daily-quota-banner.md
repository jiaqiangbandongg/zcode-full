# Start Plan 额度桶提醒

## 已确认行为

- 删除 50% / 20% 提醒。按当前模型对应的每个有效额度桶独立计算 `remaining_units / total_units`；`0 < ratio <= 10%` 时可提醒。
- 活动桶与每日桶不混算百分比。日额度文案为“{model} 今日额度剩余 {percent}（{remaining} tokens）。”，一次性活动为“{model} 活动额度剩余 {percent}（{remaining} tokens）。”；其他周期使用中性“套餐额度”，不猜测周期类型。
- 同一个 `bucket_id + period_start + period_end` 只实际展示一次。记录不包含余额、模型、任务或本地日期；同桶服务多个模型也不重复。新 bucket 或新周期允许再次提醒，不要求余额先恢复到 10% 以上。
- 10% 提醒允许关闭，保留升级入口。当前展示可随余额更新，但关闭、切换任务/模型或重新挂载后不再出现；同周期余额回升后再次降到阈值也不重复。多个符合条件的桶沿用服务端顺序依次展示，已展示的桶不能挡住其他未提醒桶。
- 提醒记录保存在当前客户端的 localStorage（按周期键分别保存，不存 token 或账号明文）。跨任务及客户端重启保留；不同客户端独立记录，不承诺跨设备同步。存储不可用时降级为当前 Renderer 内存去重。展示记录的读取、登记及过期清理与桶有效性使用同一份 snapshot.serverTime（缺失时 generatedAt）；不使用设备 Date.now，也不对缓存快照额外推进时钟。关闭只结束已登记记录的展示 owner，不重新判定周期到期。
- 当前模型的所有有效桶均耗尽，才显示“{model} 可用额度已用完，可切换其他模型或升级套餐。”。不能因为活动桶耗尽而忽略仍有余额的每日桶。
- 所有有效模型桶均耗尽，显示“体验套餐可用额度已用完，请升级套餐或等待额度恢复。”。总耗尽优先于模型耗尽；服务端 1005 仍直接提示总耗尽，既有并发/限流/MCP 分支不变。全部提示不阻断发送。

## 数据与边界

`GET /api/v1/zcode-plan/billing/balance` 的 `balances[]` 已真实返回 bucket_id、user_plan_id、period_start、period_end、expires_at。Service 在现有 UsageQuotaLimit 上增补可选字段；时间统一转换为毫秒。period 文案类型从所属 plans[].entitlements[] 按 user_plan_id（旧数据缺失时 plan_id）及 entitlement_id 关联。

只读模型用量桶；已知到期或尚未生效的桶排除。有效性以 snapshot.serverTime（缺失时 generatedAt）为基准，与服务端快照一致，不猜测设备日期。字段缺失或非有限数字不得误判为 0；缺少 bucket_id/有效周期的旧快照不触发低额度一次提醒，但可依据明确的剩余值判断耗尽。周期结束和桶到期含义独立，不能再用 expires_at 替代周期身份。

## 状态归属

旧关闭键包含 remainingTokens/remainingPercent，每次余额变化都会重新弹；旧模型判断只 find 第一个桶，也会误报模型耗尽。

纯判断继续由 sessionQuotaBannerState 拥有；一次展示记录由独立的 Start Plan reminder store 拥有。原 sessionQuotaBannerDismissalStore 继续只负责其他错误的 session-scoped 关闭，不混入周期持久化。只有 Banner 实际可见才标记，隐藏页面、被其他错误遮挡或仅计算状态不消耗次数。

```text
balance -> Service 映射 bucket/周期/文案类型 -> 单桶 10% 候选
                                               |
                                      实际可见 Banner -> 保存周期已展示
                                               | 同展示实例：保留并更新余额
                                               | 新任务/关闭/重启：不重复
                                               | 新 bucket/周期：允许提醒
有效模型桶集合 -> 全部耗尽？ -> 模型/总额度耗尽（不受已提醒记录影响）
```

共享 React UI 覆盖桌面及手机 Web、中英文和明暗主题。只增补 entitlement 数据及 Renderer 展示状态，不变更 Agent 协议、队列、owner、snapshot 恢复或 host attachment。

```text
desktop continuous -> 原实时链路 -> 共享提醒 UI
mobile replayable -> 原恢复链路 -> 共享提醒 UI（本客户端记录）
```

## 验证

- 单桶 50/48/47/20/10.1 无提醒，10/9 提醒；百分比为计算值而非取整后判断。
- 3 亿活动桶与 500 万日桶独立提醒；单桶耗尽但同模型另一个桶有余额不报模型耗尽；模型与总耗尽分别保留。
- 周期去重不随余额、排列、任务或模型变化；新周期、新桶独立；实际展示/关闭/重新挂载/重启恢复及 StrictMode 验证。
- 缺失/异常数字、未知周期、过期及未生效桶不产生虚假的低额度或耗尽提示。
- 服务映射、纯状态、store 单测，浏览器真实 hook/Banner 交互覆盖桌面/手机、明暗及中英文；测试权益服务替代后端，不写真实账号数据。

### CR-01 周期尾时间基准回归

设备时钟超前/落后、或缓存快照的周期结束已被本机时间越过时，只要当前快照仍判桶有效，展示必须可登记、关闭立即生效、任务切换和 Renderer 重载不得重复。收到新周期快照后允许再次提醒。统一快照时间，不引入第二份关闭状态或超时兜底。
