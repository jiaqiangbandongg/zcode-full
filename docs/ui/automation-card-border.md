# 自动化 Card 描边规范

## 目标

自动化主视图的内容 Card 必须与首页 Card 使用同一层级的语义描边，避免 Zai Dark 下因 `border-surface` 或 inset shadow 过浅而无法识别卡片边界。

## 视觉契约

- 首页闲时模板卡、自动化真实任务卡、闲时任务卡、定时与闲时模板卡、无任务空态和无工作区提示统一使用 `border-card-border`。
- Card 背景、圆角、间距与交互状态保持原有契约，本次仅收敛描边语义。
- 输入框、菜单、弹窗和表格分隔线继续使用各自的语义边框，不随 Card 一起替换。
- 桌面端和 Web 端共用相同样式；Zai Light 与 Zai Dark 均不得使用硬编码颜色。
- 新建定时任务与新建闲时任务详情页右上角的“创建任务”按钮统一使用共享 `Button` 的
  `variant="default" size="lg"`，不传入额外 `className`；自动化首页入口保持其独立样式。
- “创建定时任务”的文字与下拉分段也复用共享 `Button` 的 default variant；业务层只保留分段布局，
  结构参考 Changes Summary 的 Open 分段按钮：`DropdownMenu` 包裹整个圆角容器，主按钮与下拉 Trigger
  作为同级控件，不添加外层边框或额外分隔线，菜单从组合按钮右缘 `align="end"` 展开。
- 自动化首页右上角与空态的创建入口统一为 28px 高的 `default` 尺寸；刷新使用
  `outline/icon`，分段下拉使用 `icon-md`，使刷新与创建操作等高并保持主次层级。

## 回归边界

- 禁止恢复 `border-surface` 作为自动化内容 Card 的描边。
- 禁止使用 `shadow-[inset_0_0_0_1px_var(--color-surface)]` 模拟闲时任务卡描边。
- `AutomationHistoryEmptyState` 使用 `rounded-xl border border-dashed border-card-border`，保证定时与闲时详情页的“还没有运行记录”空态一致。
