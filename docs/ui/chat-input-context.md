# Chat Input Context

> **当前状态**：本文已按 V4 composer 接线校准。上下文用量来自 V4 conversation snapshot，
> 不再读取 legacy task runtime/store。

## 目标

把聊天输入栏底部的上下文用量，从静态文本改成 AI Elements 的 `Context` compound component。

## 当前实现

- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
  - 把 snapshot 的 `usage.contextWindow.usedTokens` / `maxTokens` / cache / breakdown 转成输入栏展示模型
  - 复用 `packages/ui/src/chat-input-toolbar/contextUsage.tsx` 的 `ChatContextUsage`
  - 复用已加载的 Z.ai / BigModel Coding Plan entitlement，不在 context 菜单里重复发起 quota 请求
  - Coding Plan `Usage Remaining` 复用 paid Coding Plan 的 entitlement/state 解析工具，但展示入口只保留在输入框 context 和 Usage 页
  - footer badge 与输入框 context 的 Coding Plan entitlement 使用同一套 provider/apiKey 指纹缓存，并对齐 paid plan 查询参数，避免同源额度拆成两份缓存
  - 使用 `ContextTrigger` 作为上下文入口
  - 使用 `ContextContentBody` 展示上下文窗口占用、breakdown、cache hit rate，以及 Coding Plan `Usage Remaining`
  - cache hit rate 只有在主轮累计命中率大于等于 78% 时展示；低于 78% 的值不在紧凑 context 面板中显示
  - 输入框 context 内的 Coding Plan 用量独立渲染，不复用 sidebar 菜单面板 UI
- `packages/ui/src/components/ai-elements/context.tsx`
  - 增加了 0 上限保护，避免进度百分比出现无效值
  - 改为跟随当前环境 locale 格式化百分比、compact 数字和货币
- `packages/ui/src/CodingPlanUsageRemainingPanel.tsx`
  - 承载 Usage 页/输入框 context 复用的剩余额度数字行展示与 provider 切换
  - 导出 entitlement/state 解析工具供输入框 context 复用数据语义
  - 输入框 context 菜单中的 Coding Plan 三条额度进度条按顺序使用 usage chart 蓝、绿、紫，即 `--color-usage-chart-1` / `--color-usage-chart-2` / `--color-usage-chart-3`
  - 输入框 context 菜单中的 Coding Plan 额度进度条使用设置页 Start Plan 的紧凑高度，使用 `h-1.5`
  - 输入框 context 菜单中的 Coding Plan 进度条文字上下排列：subtle label、`percent · reset`，其中百分比使用 mono，重置时间使用 `text-ui-xs` 且不使用 mono
  - 输入框 context 菜单中的 Coding Plan 用量按实际可展示额度数自适应列数：1 条显示 1 列，2 条显示 2 列，3 条显示 3 列；单条内部保持 label、剩余百分比、进度条上下排列的紧凑结构
  - 输入框 context 菜单中的 Coding Plan 区块跟随 body 内边距，不再使用 footer 式外扩边距和上边框分隔
  - 输入框 context 菜单中的 Coding Plan 标题行复用 `Context window` 的紧凑标题样式，不再使用独立 header 分隔层
  - 输入框 context 菜单中的 Start Plan `Today's balance` 独立渲染，不复用设置页 `StartPlanBalanceCard` 或 Coding Plan 面板组件；布局参考 Coding Plan 的紧凑标题、meter 和分隔节奏
  - 输入框 context 菜单中的 Start Plan `Today's balance` 只在当前模型属于 Start Plan provider 时展示，标题右侧提供 `Upgrade` 按钮直达对应 Start Plan provider 的套餐升级入口
  - 输入框 context 菜单中的 Start Plan `Upgrade` 按钮参考设置页 Start Plan 升级按钮：活动折扣时使用 gradient 圆角胶囊样式，并展示折扣 badge
  - 输入框 context 菜单中的 Start Plan `Today's balance` 展示剩余百分比、renew 时间和进度条，其中 renew 时间优先来自 `subscription.details[0].renewTime`，兜底使用余额项的 `nextResetTime`；今天只显示时间，格式为 `99% · 23:02`，非今天显示日期和时间，格式为 `99% · Jun 15 23:02`；不展示已用量、剩余量或总量文案，进度条高度使用 `h-1.5`，进度条保持 `success` 绿色
  - 输入框 context 菜单中的 Start Plan 余额按实际可展示模型额度数自适应列数：1 条显示 1 列，2 条显示 2 列，3 条显示 3 列；单条内部保持模型 label、剩余百分比、进度条上下排列的紧凑结构
  - `Context windows` 与 `Coding Plan` 两个 section 标题统一使用 `text-ui-base`
  - `Context windows` 标题右侧的 used / total 摘要使用本地化紧凑 token 单位；英文使用大写 `K` / `M` / `B`，中文使用 `万` / `亿`
  - `Context windows` 进度分段色阶以 Coding Plan 蓝色 `--color-usage-chart-1` 为基准，按占比顺序逐级变浅
  - 输入框 context 菜单中的 Coding Plan 详情入口显示为 link 风格的 `More` 文案加右箭头
  - 输入框 context 菜单中的 Coding Plan `More` 入口点击时先关闭 context 面板，再打开 usage 详情，避免跳转后浮层残留
  - 输入框 context 菜单中的 Coding Plan 只有前面已展示 `Context windows` 用量区块时，才显示上分隔线和顶部间距
  - Coding Plan 出现可用重置机会时，context 触发器复用项目统一的 `ControlHintTooltip` 及其默认 offset，并启用封装内的 `standalone` Provider 边界以支持独立 SSR/测试渲染；Tooltip 立即常驻显示礼物图标与 `{count} 次重置额度`；用户 hover、focus 或 tap 打开 context 面板后，本窗口收起首次提醒；业务层只控制展示状态与富内容，不直接组合底层 Tooltip primitives
  - 同一机会最早到期时间进入最后 3 分钟时，Tooltip 再次常驻显示闹钟图标与实时倒计时 `重置额度过期 {time}`；如果首次提醒尚未收起，则原地切换为临期提醒
  - 礼物图标使用主题语义成功色，临期闹钟使用主题语义警告色；临期文案中的倒计时 `{time}` 使用固定 `h-3.5`（14px）、`text-ui-xs px-1.5`、浅 warning 背景、warning 文字和 `tabular-nums` 的紧凑 pill 样式；闹钟持续左右摆动，`prefers-reduced-motion` 下静止；临期提醒被查看后同一机会不再重复，机会失效、额度已满或过期时立即收起
  - Context 圆形触发按钮独立表达当前机会状态：存在有效机会且剩余时间大于 3 分钟时只使用 success 前景色、不增加状态背景，进入最后 3 分钟后切换为淡 warning 背景与 warning 前景色；用户关闭 Tooltip 不清除按钮状态色，机会失效或过期后恢复默认色
  - context 触发器 Tooltip 同时只展示一种状态，优先级为「正在重置/已重置」>「临期机会」>「首次机会」；Tooltip 仅提醒，重置操作仍在 context 面板完成
  - 初次与临期机会 Tooltip 右侧均提供圆形关闭按钮；关闭只标记当前阶段已读，不打开 context 面板、不影响机会本身；已读状态由当前 renderer 窗口共享，因此切换会话或会话组件重新挂载后，同一 `sourceKey + earliestExpiresAt` 机会的同一阶段不会再次显示；该状态不落盘、不跨窗口，新过期时间仍按新机会提醒；按钮复用共享 `Button` 的 `icon-xs` 尺寸并覆盖为 `rounded-full`，不使用负 margin，使用 `关闭提醒` / `Dismiss reminder` 无障碍标签
  - 临期提醒中闹钟与文案保持 `gap-1.5`，倒计时文案组与关闭按钮使用 `gap-0`，避免右侧出现多余空隙
  - 机会提醒内容沿用模型 Tooltip 的 `text-ui-sm` 字号；由于圆形关闭按钮固定为 `20px`，提醒 Tooltip 使用 `bg-background py-0.5 pr-0.5`，使整体尺寸与模型 Tooltip 对齐并使用页面背景色
- `packages/ui/src/i18n/locales/en-US.ts`
- `packages/ui/src/i18n/locales/zh-CN.ts`
  - 补充了 hover card 的说明文案

## 结果

- 输入栏底部仍保留简洁的 context 入口
- 用户悬停后可以看到更完整的上下文解释与当前 Coding Plan 剩余额度
- 组件形式与 `elements.ai-sdk` 的 context 文档保持一致
