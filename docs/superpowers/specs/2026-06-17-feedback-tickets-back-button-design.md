# 我的反馈返回按钮设计

## 背景

反馈中心包含“提交反馈”和“我的反馈”两个视图。当前“我的反馈”页面右下角有“新建反馈”按钮，可以切回提交反馈页，但页面 header 区没有符合用户预期的返回按钮。用户从提交页进入“我的反馈”后，会优先在标题附近寻找返回入口。

## 目标

- 在“我的反馈”页面 header 标题左侧增加返回按钮。
- 按钮只在反馈中心当前 tab 为 `tickets` 时展示。
- 点击返回按钮后切回 `submit` tab，也就是“提交反馈”页面。
- 返回不关闭弹窗，不清空提交页已有草稿状态。
- 保留右上角关闭按钮和右下角“新建反馈”按钮现有行为。
- 支持中英文 aria-label，兼容桌面端、Web 端和手机 Web 小屏布局。

## 非目标

- 不重构反馈中心 tab 状态管理。
- 不改变工单列表加载、刷新、复制 ID、选中高亮或提交流程。
- 不新增反馈页面导航历史栈；返回按钮固定表示从“我的反馈”返回“提交反馈”。

## 设计

`packages/ui/src/feedback/FeedbackCenter.tsx` 继续作为反馈中心 Dialog 的 tab 控制层。Header 内部将标题区域拆成左侧标题组和右侧关闭按钮：

- 当 `tab === "tickets"` 时，在标题文本前渲染一个 `Button variant="ghost" size="icon-md"`。
- 按钮图标使用 `lucide-react` 的 `ArrowLeft`，符合现有图标体系。
- 点击按钮执行 `setTab("submit")`。
- aria-label 使用新增文案：
  - `feedback.center.backToSubmit`: 中文“返回提交反馈”，英文“Back to submit feedback”。
- Header 保持 `min-w-0`，标题继续 `truncate`，防止英文长文案或窄屏时和关闭按钮重叠。

视觉上按钮是低强调的 ghost icon button，和现有关闭按钮形成清晰层级：左侧返回只切换页面，右侧关闭退出弹窗。

## 测试

- 更新 `packages/ui/test/feedbackCenter.test.ts`：
  - 打开 tickets tab 时，静态渲染包含返回按钮 aria-label、`feedback.center.ticketsTitle`，并保留关闭按钮。
  - submit tab 时不渲染返回按钮。
  - 从源码或渲染断言确认返回按钮触发 `setTab("submit")` 的切换路径。
- 执行：
  - `pnpm exec vitest run packages/ui/test/feedbackCenter.test.ts`
  - `pnpm typecheck`
  - `pnpm lint`

## 风险与兼容

- 本改动只触碰 UI header，不改服务层、反馈工单接口或远控状态。
- 小屏上标题和按钮在同一行，依赖 flex + `min-w-0` 保持可压缩；关闭按钮仍固定在右侧。
- 如果用户通过右下角“新建反馈”返回 submit，行为不变。
