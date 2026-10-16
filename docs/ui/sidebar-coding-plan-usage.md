# Sidebar Coding Plan Usage

## 背景

Workspace sidebar footer 的剩余额度入口靠近当前 workspace，应表达“当前模型连接方式会消耗的那一份 Coding Plan 额度”，而不是账号级总览。

## 规则

- sidebar 剩余额度只显示一份来源，不在 footer 菜单里切换多个个人 / 团队来源。
- 当前 workspace 连接方式是个人 Coding Plan 时，查询并展示个人 Coding Plan 剩余额度；无权益时不显示入口。
- 当前 workspace 连接方式是 BigModel Team Plan 时，查询并展示该团队项目剩余额度；无权益或缺少团队项目上下文时不显示入口。
- 当前 workspace 连接方式是 API Key、Start Plan、普通自定义 provider 或 native provider 时，不显示 Coding Plan 剩余额度。
- 账号里其他来源有权益不能触发 sidebar 入口回退展示；例如当前连接个人 Coding Plan 但个人无权益、Team 有权益时，sidebar 不显示，避免误导用户以为当前发送消耗 Team 额度。

## Header

- 面板 header 左侧显示 Coding Plan 标题。
- 面板 header 中归属标签紧跟在 Coding Plan 标题后：
  - 个人 Coding Plan：`Individual` / `个人`
  - Team Plan：`Team` / `团队`
- 标签只表达额度归属，不提供切换能力。
- Team Plan 来源名称统一展示为 `BigModel - <组织名称>`；缺少 `organizationName` 时不生成 Team Plan usage source，避免继续显示通用的 `BigModel - Coding Plan` 或空白来源。

## 输入框 Usage 浮层

- 浮层保持紧凑的一至三列额度布局。
- 浮层优先展示额度名称、剩余百分比和进度条。重置时间通过 JavaScript 测量当前列宽：完整“百分比 · 时间”能容纳时显示，超出时只隐藏时间。
- 字体或浮层尺寸变化后通过 `ResizeObserver` 重新测量，避免大字号下日期换行挤压额度列；完整时间信息始终保留在设置页「使用统计」。

## Sidebar profile badge

- sidebar 头像旁边的小徽标是账号级 Coding Plan 徽标，不再跟随当前 workspace 连接方式。
- 账号有个人 Coding Plan 时显示个人套餐 level，例如 `Pro` / `Max`。
- 账号没有个人 Coding Plan 但有 Team Plan 时，统一显示 `Team` / `团队`。
- 账号同时有个人 Coding Plan 和 Team Plan 时，优先显示个人套餐 level。
- sidebar 头像菜单中的 `使用统计` 入口位于升级入口上方，打开设置页「使用统计」并优先落到编程套餐来源。

## Settings usage Coding Plan

- 设置页「使用统计」是账号级统计视图，不再跟随当前 workspace 连接方式。
- 顶部 tab 展开账号下所有可用统计来源：`应用用量`、个人 `个人套餐`、以及每个 Team Plan 组织名称。
- 账号有个人 Coding Plan 时展示个人 `个人套餐` tab；账号有多个个人 Coding Plan 来源时可按 provider 名称区分。
- 账号有 Team Plan 时，每个团队项目独立展示为一个 tab，tab 文案只显示 `organizationName`，不做 project、id 或 product 兜底。
- 点击个人 Coding Plan tab 时，只展示该个人来源的额度和用量统计。
- 点击 Team Plan 项目 tab 时，只展示该团队项目的额度和用量统计，请求必须带 `organizationId` / `projectId`。
- 当前连接方式是 API Key、Start Plan、普通自定义 provider 或 native provider 时，不影响使用统计页展示账号已有 Coding Plan 来源。

## 实现约束

- 当前连接方式以 workspace 的 `selectedSupplierKey` 为准。
- BigModel Team Plan 仍复用 `builtin:bigmodel-coding-plan` provider；具体团队项目来自 `modelProviderFamilySelectedKeys.bigmodel` 中的 `team-plan:*` selected key。
- Team Plan quota 查询必须带 `organizationId` / `projectId`，让服务层复制并使用团队项目 API Key。
