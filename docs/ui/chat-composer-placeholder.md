# Chat Composer Placeholder

聊天输入框 placeholder 现在按任务状态和终端宽度分流：

- 空闲态，无历史消息（桌面端）：`Ask ZCode anything, @ for files, folders, or whiteboards, / for commands or agents, $ for skills, # for related conversations`
- 空闲态，无历史消息（手机 Web 远控）：`Ask ZCode anything…`
- 空闲态，有历史消息：`Ask for follow-up changes`
- 处理任务中：`Keep typing to queue follow-up changes`

设计约束：

- 新任务占位文案只在消息列表为空时显示
- 历史任务只要已经有消息且当前不在处理，就显示 follow-up 文案
- `submitting`、`creating`、`restoring`、`streaming` 统一视为处理态，避免任务启动瞬间 placeholder 闪回
- 处理态不锁定输入，只改变 placeholder，明确告诉用户可以继续输入并进入队列
- 手机 Web 远控的新任务文案保持精简，完整的 `@` / `/` / `$` / `#` 能力提示由输入框下方动作入口承载
- 手机 Web 远控的 placeholder 最多展示两行，作为国际化文案扩展的布局防护；不能覆盖下方工具栏
- 桌面端继续显示完整能力提示，不受手机端精简规则影响
- 文案通过 i18n 配置，当前提供 `en-US` / `zh-CN`
