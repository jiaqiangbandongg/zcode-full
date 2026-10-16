# 会话侧 Cron 间隔任务（`intervalUnit` / `interval`）

## 目标

聊天会话通过 `CronCreate`、`CronUpdate` 创建或修改“每 N 分钟 / 小时 / 天 / 周 / 月 / 年”的任务时，与定时任务 UI 的「自定义重复」保持同一调度语义：

- 单位支持 `minute`、`hourly`、`daily`、`weekly`、`monthly`、`yearly`。
- `interval` 必须是 **1–200 的整数**；`0`、负数、小数和大于 `200` 的值必须在 contract、协议和 service 边界拒绝。
- 真实重复语义以持久化的 `scheduleRule` 为准；`cronExpr` 只保留为合法兼容表达式，不能因 cron 字段的步长上限改变真实频率。
- `CronList`、`CronCreate`、`CronUpdate` 的返回值必须带回 `scheduleRule`，使会话卡片可以展示真实频率，而不是把兼容 cron 错读为“每小时”。

UI 自定义重复的输入范围和语义是本功能的事实来源：`docs/ui/scheduled-tasks-main-view.md`。

## 根因

标准五段 cron 对各字段的步长有上限：分钟为 59、小时为 24、日为 31、月为 12。因此以下表达式无效：

- 每 61 分钟：`*/61 * * * *`
- 每 31 小时：`49 */31 * * *`
- 每 32 天：`0 9 */32 * *`
- 每 13 个月：`0 9 15 */13 *`

若把超过上限的间隔直接写入 cron，服务层会在 `isValidCronExpr` 校验时拒绝任务；若静默改为每分钟/每小时 cron 又会错误地改变任务频率。

## 受控输入模型

Cron 工具保留 `cron`，并新增成对的可选字段：

```ts
intervalUnit: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
interval: 1..200;
```

`intervalUnit + interval` 表示 UI 的“自定义重复”语义，不能让模型直接提交内部 `scheduleRule`。

### 使用规则

1. 用户表达“每 N 个单位”时，工具必须提交 **两个** interval 字段，即使 `N` 恰好可由 cron 表达（例如每 20 小时）。这是为了与 UI 自定义重复一样按 `scheduleRule.anchorAt` 推进，而不是退化为墙钟 cron。
2. `cron` 仍必填，用来指定兼容表达式中的时间、周几、月日或月份；它必须是合法五段 cron，且只作为 `scheduleRule` 的展示/兼容 carrier。
3. carrier 不能与一次性相对延迟 `delayMinutes` / `relativeDelayMinutes` 同时使用。
4. carrier 可与既有 `recurring` / `maxRuns` 组合；它只定义“下一次如何计算”，有限次数仍由既有生命周期规则控制。
5. 未传 carrier 的普通 cron 保持旧语义，避免改变已有绝对日期、工作日或日历型任务。

### 合法兼容 cron

服务端以 `scheduleRule` 执行真实间隔；调用方只需提供不含越界步长的合法 cron：

| 真实语义 | carrier | 合法兼容 cron 示例 |
| --- | --- | --- |
| 每 200 分钟 | `minute`, `200` | `* * * * *` |
| 每 31 小时的第 49 分 | `hourly`, `31` | `49 * * * *` |
| 每 40 天 09:00 | `daily`, `40` | `0 9 * * *` |
| 每 8 周一/三/五 09:00 | `weekly`, `8` | `0 9 * * 1,3,5` |
| 每 13 个月的 15 日 09:00 | `monthly`, `13` | `0 9 15 * *` |
| 每 2 年 6 月 15 日 09:00 | `yearly`, `2` | `0 9 15 6 *` |

## 数据流

```text
CronCreate / CronUpdate
  { cron, intervalUnit, interval }
             |
             v
contract + protocol
  pair + 1..200 + recurrence invariant validation
             |
             v
Host AutomationService
  buildIntervalScheduleRule(intervalUnit, interval, cronExpr, Date.now())
             |
             +--> scheduleRule       (权威的真实调度)
             +--> cronExpr           (合法兼容/展示)
             |
             v
computeScheduleRuleNextRunAt(scheduleRule)
             |
             v
持久化 / 返回 scheduleRule
             |
             v
会话卡片 describeAutomationCardSchedule
  优先读取 scheduleRule，展示真实“每 N 单位”
```

## 多端与旧 Host 边界

本功能只扩展既有 app ↔ agent 自动化协议；desktop continuous 与手机 remote replayable 的 session 消息链路不改变。远端 workspace 仍通过其既有 host attachment 处理请求。

旧 Host 的严格 schema 不识别新字段时，不能降级成普通 cron 创建任务，因为那会把真实的 31 小时、40 天等频率错误地写成每小时/每天。此类请求必须失败并明确提示 Host 不支持 interval carrier；未使用 carrier 的旧 CronCreate/CronUpdate 继续保持兼容。

## 验证要求

1. Contract / protocol：`1`、`200` 合法；`0`、`201`、小数、缺少配对字段、与相对延迟混用均非法；有限次数任务可以携带 carrier。
2. Create 与 Update 都要覆盖完整的 contract → port → protocol → Host → service 透传链路。
3. 至少覆盖 `61/200` 分钟、`25/200` 小时、`32/200` 天、`13/200` 月、`2/200` 年；所有兼容 cron 必须能通过 cron 校验，且下次执行时间由真实 `scheduleRule` 计算。
4. Create / Update / List 的出参都能回传 `scheduleRule`，会话创建成功卡片展示真实频率。
5. 回归 UI 自定义重复的 `1–200` 约束与超出 cron 字段上限时的兼容 cron。
