# Coding Plan Plan Card Renew Time

## 背景

Model Settings 的 Coding Plan 已购买态 plan card 会展示 5h、1w、MCP 三个剩余额度卡片，但没有展示各额度桶的 renew/reset 时间。Sidebar 的“剩余额度”面板已经通过 `UsageQuotaLimit.nextResetTime` 展示同一类时间，导致同一份额度信息在两个入口口径不一致。

## 目标

- Coding Plan plan card 的 5h、1w、MCP 剩余额度卡片需要展示 renew 时间。
- renew 时间展示在剩余百分比右侧，和百分比同一行，避免在进度条下方额外增加一行信息。
- 时间来源使用对应 `UsageQuotaLimit.nextResetTime`，不从订阅续费时间或过期时间推导。
- 格式复用 sidebar 剩余额度：
  - 5h 使用 dateTime，今天内只显示时间，否则显示月日和时间。
  - 1w 使用 date。
  - MCP 使用 date。
- 未返回 `nextResetTime` 或时间非法时，不展示 renew 时间占位。

## 非目标

- 不改变导航侧状态卡片的字段结构。
- 不改变 Start Plan 模型余额卡片。
- 不新增服务端字段或协议字段。

## 验收

- 已购买 Coding Plan 详情页中，5h、1w、MCP 三张用量卡在有 `nextResetTime` 时显示对应 renew 时间。
- renew 时间位于百分比右侧；小屏或长语言环境下允许在同一 flex 行内截断，不撑开卡片。
- 展示格式与 sidebar 剩余额度一致。
- `pnpm typecheck` 与 `pnpm lint` 通过。
