# Chat Input Context Coding Plan Usage

## 背景

聊天输入框的 context usage 浮层可以同时展示当前任务上下文用量、Start Plan 当日余额和 Coding Plan 剩余额度。侧边栏 footer 不再展示 Usage Remaining，避免和 Usage 页、输入框 context 形成重复入口。

输入框浮层不同：它贴近当前消息发送模型，展示的 Coding Plan 剩余额度必须跟随用户当前选中的模型 provider，不能因为账号里存在另一家 Coding Plan 权益就显示出来。

## 规则

- 当前选中模型 provider 是 `builtin:zai-coding-plan` 时，context usage 浮层可以展示 Z.ai Coding Plan 剩余额度。
- 当前选中模型 provider 是 `builtin:bigmodel-coding-plan` 时，context usage 浮层可以展示 BigModel Coding Plan 剩余额度。
- 当前 BigModel family 连接方式选中 `team-plan:builtin:bigmodel-coding-plan:*` 时，context usage 浮层必须展示该 Team Plan 团队项目的剩余额度；个人 Coding Plan 无权益不能导致 Team Plan 浮层入口消失。
- 当前选中模型 provider 是 Start Plan、普通 API Key、自定义 provider 或其他非 Coding Plan provider 时，不展示 paid Coding Plan 剩余额度。
- Start Plan 继续使用独立的 Start Plan balance 面板，不复用 paid Coding Plan 的 quota 展示。
- 侧边栏 footer 只保留升级/续费入口和账号旁的套餐 badge；剩余额度详情从 Usage 页或输入框 context 查看。

## 实现约束

- context usage 的 Coding Plan provider 从当前模型值或 custom supplier key 解析。
- 解析结果只接受 paid Coding Plan provider id；不把 Start Plan 映射回同品牌 paid Coding Plan。
- BigModel Team Plan 不是新的 provider id；它复用 `builtin:bigmodel-coding-plan` 模型目录，但用 `modelProviderFamilySelectedKeys.bigmodel` 中的 team source key 表达具体团队项目。
- Team Plan 的 quota 查询必须带上对应 `organizationId` / `projectId`，让服务层复制并使用团队项目 API Key；不能只用 `builtin:bigmodel-coding-plan` 的个人/default 上下文。
- 传给 context panel 的 provider 和 entitlement 必须过滤到当前模型对应的 paid Coding Plan provider 或 Team Plan source，避免 `resolveCodingPlanUsageRemainingState` 自动回落到另一家有权益的 provider。

## 额度浮层布局

- context usage 浮层固定使用 `w-80`（320px），不能因官方 Server MCP 额度出现而扩宽。
- 5 小时、Weekly、Tool calls 与官方 Server MCP 共用最多三列的额度网格：主额度少于三张时，MCP 补入同一行，并按总卡片数使用一至三列；主额度已有三张时，MCP 在下一行横跨三列。
- MCP 与主额度同排时使用相同的纵向卡片结构：标题与 info 图标、剩余百分比与重置日期、进度条；横跨整行时按 `ZCode MCP → 剩余百分比 · 重置日期 → 进度条` 的紧凑横向顺序排列。
- MCP 行的百分比与进度条继续使用“剩余”口径；进度条复用图表色板的暖黄色 `--color-usage-chart-5`，不再单独维护 MCP 颜色变量。日期空间不足时允许截断，进度条优先保留可读宽度。
- 主额度已有 3 张时，MCP 贯穿行的进度条宽度必须等于上方单张卡片的进度条宽度，按 `(100% - 16px) / 3` 与 `gap-2` 栅格口径一致。
- MCP 贯穿行不使用独立背景容器；通过顶部 `border-border` 分隔线与上方三项额度区分。同排卡片不增加分隔线，保持与相邻额度相同的网格节奏。
- `ZCode MCP` 名称与上方“5 小时 / 每周”标题保持一致，使用 `text-foreground-subtle` 且不额外加粗；不使用金色渐变或流光，黄色只保留在进度条上。
- `ZCode MCP` 名称后紧跟 info 图标；鼠标悬停或键盘聚焦时，通过统一的 `ControlHintTooltip` 显示“ZCode 预置插件 MCP 每日合计额度”。说明文案必须支持中英文国际化，图标不得挤压右侧剩余量与进度条。
- 桌面端和手机 Web 端共用同一紧凑布局，不增加仅针对单端的宽度分支。
