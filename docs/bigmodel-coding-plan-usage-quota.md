# BigModel Coding Plan 用量配额接入

日期：2026-05-14

## 背景

ZCode 的「Plan usage」需要展示用户当前 GLM Coding Plan 的真实用量，而不是本地 session 的估算值。当前接入方式改为直接使用用户已配置的 Z.AI / BigModel provider API key 查询 BigModel quota 接口，不再依赖 Z.AI OAuth token，也不改动现有登录鉴权流程。

## 接口

```http
GET <host>/api/monitor/usage/quota/limit
authorization: <完整 API key>
```

注意：

- 国内 host 可使用 `https://bigmodel.cn` 或 `https://open.bigmodel.cn`。
- 海外 / Z.AI host 可使用 `https://api.z.ai`。
- 国内与海外接口路径、请求方式、返回结构一致；同一个 key 两个 host 都能查，主要差异是 `msg` 文案语言可能不同。
- `authorization` header 直接传完整 API key，格式为 `<id>.<secret>`。
- 不要加 `Bearer` 前缀；该接口加 `Bearer` 会鉴权失败。
- ZCode 默认优先读取当前模型供应商配置里的 `builtin:zai` API key，其次读取 `builtin:bigmodel`，再尝试 endpoint 指向 `bigmodel.cn` 或 `api.z.ai` 的自定义供应商。
- `builtin:zai` 或 endpoint 指向 `api.z.ai` 的供应商默认请求 `https://api.z.ai/api/monitor/usage/quota/limit`；其他 BigModel 供应商默认请求当前环境的 BigModel API 主域名，生产为 `https://bigmodel.cn/api/monitor/usage/quota/limit`，`ZCODE_ENV=test` 为 `https://bigmodel.cn/api/monitor/usage/quota/limit`。
- 本地调试可通过 `ZCODE_BIGMODEL_USAGE_API_KEY` 或 `BIGMODEL_USAGE_API_KEY` 覆盖。
- 接口地址可通过 `ZCODE_BIGMODEL_USAGE_QUOTA_URL` 或 `BIGMODEL_USAGE_QUOTA_URL` 覆盖。

## 返回解析

成功响应示例：

```json
{
  "code": 200,
  "msg": "操作成功",
  "data": {
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "unit": 3,
        "number": 5,
        "percentage": 1,
        "nextResetTime": 1778753640304
      },
      {
        "type": "TIME_LIMIT",
        "unit": 5,
        "number": 1,
        "usage": 100,
        "currentValue": 0,
        "remaining": 100,
        "percentage": 0,
        "nextResetTime": 1781345721976,
        "usageDetails": [
          { "modelCode": "search-prime", "usage": 0 },
          { "modelCode": "web-reader", "usage": 0 },
          { "modelCode": "zread", "usage": 0 }
        ]
      }
    ],
    "level": "lite"
  },
  "success": true
}
```

字段语义：

| 字段 | 说明 |
|---|---|
| `data.level` | GLM Coding Plan 套餐等级，例如 `lite`、`pro`、`max` |
| `unit=3` | 小时维度，`number` 表示小时数 |
| `unit=5` | 月维度，`number` 表示月数 |
| `unit=6` | 周维度，`number` 表示周数 |
| `TOKENS_LIMIT + unit=3 + number=5` | 5 小时 prompt 池 |
| `TOKENS_LIMIT + unit=6 + number=1` | 1 周 prompt 池；部分账号不会返回，前端应隐藏缺失项 |
| `TIME_LIMIT + unit=5 + number=1` | MCP / 工具类月额度池 |
| `TIME_LIMIT.remaining` | 工具类剩余额度 |
| `TIME_LIMIT.percentage` | 工具类额度已用比例 |
| `TIME_LIMIT.nextResetTime` | 工具类额度下次重置时间，毫秒时间戳 |
| `TIME_LIMIT.usageDetails` | 工具类额度的分项用量，例如联网搜索、网页读取、开源仓库 MCP |

`nextResetTime` 是可选字段。前端不能用它判断额度项是否有效；字段缺失时仅隐藏该项的重置时间。

## 套餐等级展示

前端只把接口返回的 `level` 作为当前真实套餐等级。套餐说明用于帮助用户理解，不作为接口返回值的替代来源：

| 等级 | 每 5 小时 prompt 池 | MCP / 工具类月额度 | 并发优先级 |
|---|---:|---:|---|
| Lite | 约 120 次 | 100 次/月 | 低 |
| Pro | 约 600 次 | 1000 次/月 | 中 |
| Max | 约 2400 次 | 4000 次/月 | 高 |

这些数值可能随平台策略调整，最新说明以 Z.AI / BigModel 官方用量说明为准。

## 前端展示

Coding Plan 剩余额度在 Model Provider、侧边栏和输入框 context 面板里必须使用同一套展示口径：

- 当前套餐等级：来自 `data.level`
- 5 小时池：来自 `TOKENS_LIMIT + unit=3 + number=5` 的 `percentage` 和 `nextResetTime`
- 周池：来自 `TOKENS_LIMIT + unit=6 + number=1` 的 `percentage` 和 `nextResetTime`
- 工具调用：来自 `TIME_LIMIT + unit=5 + number=1` 的 `remaining / usage` 和 `nextResetTime`

前端只展示接口返回且能按上述 `type + unit + number` 识别的额度项。某项缺失时必须隐藏该项，不得用 `limits` 数组下标兜底展示，也不得固定渲染三张空卡。这样 Model Provider、侧边栏和 context 面板在同一份 quota 数据下显示的条目数量保持一致。

设置页「使用统计」展示：

- 工具剩余额度
- 套餐等级
- 下次重置时间
- 5 小时 prompt 池已用比例
- MCP / 工具类额度说明
- `usageDetails` 分项用量
- 本地 session 使用统计

当 Z.AI 与 BigModel 两个来源都已启用并配置 API key 时，设置页「使用统计」会展示来源切换控件。权益卡、模型用量、工具用量和刷新操作都跟随当前选中的来源读取，避免两边都配置时只隐式展示第一家 provider 的数据。

Coding Plan 的「用量统计」继续复用 `getCodingPlanUsageSnapshot` / `useCodingPlanUsageStats`
这条入口和缓存策略，但内部数据源对齐 BigModel 官方个人用量页：

| 页面区域 | 接口 | 说明 |
|---|---|---|
| 剩余额度卡 | `/api/monitor/usage/quota/limit` | 只用于 5 小时、周、MCP 月额度。`percentage` 表示已使用百分比；ZCode 的 `Usage remaining` 视图必须统一反转成剩余百分比。 |
| Token 活动 | `/api/monitor/credit-usage/activity` | 返回 365 天活动序列和累计统计。用于「Token 活动」热力图，以及累计 Tokens、峰值 Tokens、累计使用时长、连续天数等概览。 |
| 用量趋势 / 使用详情 | `/api/monitor/credit-usage/usage-detail` | 按 `usageType=MODEL/MCP` 分别返回模型与工具的积分/Token/调用序列、Cache 命中率、积分总数、日均积分。 |
| 系统健康度 | `/api/monitor/usage/model-performance-day` | 返回 Max&Pro / Lite 高峰期平均 Decode 速度，用于系统健康度折线图。 |

旧 `/api/monitor/usage/model-usage` 和 `/api/monitor/usage/tool-usage` 不再作为
Coding Plan 设置页主数据源。它们最多只能作为后端未返回新版 credit 数据时的兼容 fallback，
不能继续覆盖 Token 活动、Cache 命中率或积分统计。

Coding Plan 不跟随设置页顶部 `All / 30d / 7d` 这个 App Usage 分析维度。该维度只用于本地使用统计视图；Coding Plan 使用独立的「使用详情」范围：

| 使用详情范围 | 请求时间范围 | 服务层返回 `granularity` | 服务层返回 `x_time` |
|---|---|---|---|
| 当日 | 当天 00:00:00 至 23:59:59 | `hour` | `00:00:00` 至 `23:00:00` |
| 7日 | 最近 7 个自然日 | `day` | 连续 `YYYY-MM-DD` 日期 |
| 30日 | 最近 30 个自然日 | `day` | 连续 `YYYY-MM-DD` 日期 |
| 自定义日期 | 用户选中的自然日范围，最长 30 天 | `day` | 连续 `YYYY-MM-DD` 日期 |

服务层会按返回的 `x_time` 对齐模型和工具 series；monitor 缺少某个时间桶时补 0，前端图表只按 `x_time` 的 index 消费数据，不再自行推断时间轴。

「使用详情」图表必须按 BigModel 官方个人用量页拆成两级 tab：

| 一级 tab | 二级 tab | 图表口径 | 数据来源 |
|---|---|---|---|
| 积分消耗 | 模型 | 模型积分消耗 | `usageType=MODEL` 的 `totalCreditsUsage`，缺失时合并 cached / uncached / output credits |
| 积分消耗 | 工具 | 工具积分消耗 | `usageType=MCP` 的 `creditsUsage` |
| 用量消耗 | 模型 | Token 用量 | `usageType=MODEL` 的 `totalTokensUsage`，缺失时合并 cached / uncached / output tokens |
| 用量消耗 | 工具 | 调用次数 | `usageType=MCP` 的 `mcpCallCount` / `usageCount` |

「使用详情」图表形态对齐 BigModel 官方个人用量页：

- 使用柱状图，不使用折线图。
- 模型维度的柱子按 cached input / uncached input / output 三段堆叠；模型名称仍作为图例开关，不把“缓存 / 未缓存 / 输出”当成独立模型。
- 工具维度没有 cached / uncached / output 拆分，按工具系列直接渲染柱状图。

图表上方展示图例：

- 「消耗总量」为当前可见系列的合计，点击后恢复显示全部系列。
- 每个模型 / 工具分项显示名称和当前口径合计，点击可隐藏或显示该系列。
- 当只剩一个系列可见时，不能再隐藏最后一个系列。
- 当范围内无数据时显示空态，不渲染空图。

「使用详情」KPI 来自当前二级 tab 对应接口返回的 `summary`，展示：

- Cache 命中率
- 积分总数
- 日均积分
- 如果接口返回 `trend`，在卡片标题旁展示涨跌百分比。

`credit-usage/activity` 不受 `当日 / 7日 / 30日` 范围影响，固定读取最近 365 个自然日，
由前端在同一份 52 周网格上切换：

| Token 活动 tab | 单元格口径 | Hover 文案 |
|---|---|---|
| 每日 | 当日 Token 与消息/调用轮次 | `{date}\n{tokens} tokens · {turns} 轮消息` |
| 每周 | 单列 7 天合计，第一行为周日 | `{date} 当周\n{tokens} tokens · {turns} 轮消息` |
| 累计 | 截至该周的累计值，hover 仍高亮整列 | `截至 {date} 当周累计\n{tokens} tokens · {turns} 轮消息` |

「系统健康度」使用独立范围，不跟随「使用详情」：

| 系统健康度范围 | 请求时间范围 | 页面展示 |
|---|---|---|
| 近7天 | 最近 7 个自然日 | 默认选中 |
| 近30天 | 最近 30 个自然日 | 用户手动切换 |

系统健康度折线图展示两条 series：

- `proMaxDecodeSpeed`：Max&Pro 高峰期平均 Decode 速度
- `liteDecodeSpeed`：Lite 高峰期平均 Decode 速度
- y 轴单位为 `tokens/s`
- tooltip 按官方页面展示每条 series 的 `tokens/s` 数值。

所有日期边界按调用端传入的 `timeZone` 生成。Desktop 本地、Web、手机远控都通过同一个
UsageStatsService 依赖注入入口读取，服务层不得使用 host 默认时区替代请求时区。

## 错误处理

- 未配置 Z.AI / BigModel API key：展示“未找到可查询 quota 的 API key”。
- 接口返回“当前用户不存在 coding plan”：展示“暂无有效 Coding Plan”。
- 其他错误：展示接口错误信息，允许用户手动刷新。

## 架构边界

- UI 层只通过 `useUsageEntitlement` hook 获取数据。
- 服务层通过 `BigModelUsageQuotaProvider` 访问 BigModel quota 接口。
- API key 来源仍然走现有模型供应商配置服务，不改 Z.AI OAuth 登录、退出、刷新或用户鉴权逻辑。
- Desktop 本地流程和远程 workspace 流程都通过依赖注入传入同一个 usage stats service，避免 UI 直接访问本地文件或 credential。
