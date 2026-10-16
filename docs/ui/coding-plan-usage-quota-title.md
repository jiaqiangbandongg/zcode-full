# Coding Plan Usage Layout

## 背景

Usage 设置页的 Coding Plan 面板会展示 5 小时、每周和 MCP 额度三张额度卡片。卡片主体展示的是剩余额度百分比和重置时间，不是总额度，因此标题和卡片名需要明确表达“剩余”或额度类型语义。

同页还会展示 Model Usage 和 Tool Usage 的时间序列。`today / 7d / 30d` 只影响这两组用量趋势，不应在视觉上覆盖 `Quota Remaining`，否则用户会误以为切换时间范围也会筛选剩余额度。

## 规格

- Model Provider 套餐卡中，5 小时、每周、工具调用与 ZCode MCP 的小标题行统一使用 `min-h-6`（最小 24px，大字号时随内容增高），文字、重置入口和 info 图标垂直居中；桌面和手机 Web 共用此高度。
- Coding Plan 用量面板在 quota 卡片组上方展示“剩余额度”主标题，并在同一标题行展示当前 Coding Plan provider。
- 标题文案必须走国际化，不直接硬编码到组件中。
- `Quota Remaining` 与 `Usage Trends` 使用比 Model Usage / Tool Usage 更强的标题层级。
- quota 卡片名称表达剩余额度周期或额度类型：5 小时剩余、每周剩余、工具调用。
- quota 卡片保持原有数据来源和计算逻辑不变，继续展示剩余百分比和重置时间。
- Model Usage 和 Tool Usage 归入同一个 `Usage Trends` 区域。
- `today / 7d / 30d` 和刷新按钮放在 `Usage Trends` 标题行，表示它们控制趋势数据。
- 顶部不再单独展示供应商区域；provider 名称或多 provider 切换入口合并到 `Quota Remaining` 标题行。
- `Quota Remaining` 优先使用 entitlement quota 快照，不依赖 `Usage Trends` 的 range snapshot。
- 打开 `Settings -> Usage -> Coding Plan` 时，页面需要主动校正当前 provider 的 entitlement quota；同页趋势数据继续在页面挂载时请求。
- `Usage Trends` 标题行的刷新按钮需要同时刷新趋势数据和当前 provider 的 entitlement quota，避免下方图表更新而 `Quota Remaining` 仍展示旧快照。
- 同一 provider 切换 `today / 7d / 30d` 时保留上一份趋势快照，避免页面内容闪空。
- 桌面端可继续多列展示；窄屏需要自动降到单列，避免三张卡片在手机 Web 端拥挤。

## 验收

- 有任意 quota 卡片可展示时，卡片组上方显示剩余额度主标题和当前 provider。
- 没有 quota 卡片时，整个 quota 区域仍不渲染。
- Model Usage 和 Tool Usage 上方显示 `Usage Trends` 主标题。
- 切换 `today / 7d / 30d` 的控件位于 `Usage Trends` 标题行，而不是页面顶部 provider 行。
- 切换 `today / 7d / 30d` 不会让 `Quota Remaining` 区域清空或闪烁。
- 进入 Coding Plan Usage 页面后，`Quota Remaining` 会绕过共享 TTL 校正一次；点击刷新按钮后，`Quota Remaining` 和趋势图一起更新。
- 英文和中文界面都显示对应的额度文案，套餐内月度 MCP 工具额度统一展示为“工具调用 / Tool calls”，不再使用“MCP 额度 / MCP quota”；独立的官方 Server MCP 日额度继续展示品牌名“ZCode MCP”。
- Usage stats 和 Model Provider 套餐卡中的 `ZCode MCP` 标题后都展示 info 图标；悬停或键盘聚焦时复用 `ControlHintTooltip` 与 `sidebar.usage.plan.zcodeMcpDescription`，确保和输入框 context 的额度说明一致。
