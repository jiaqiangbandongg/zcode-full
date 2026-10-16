# Settings Form Layout

## 背景

设置页里的新建和编辑表单沿用轻量卡片边界，但不增加卡片背景色。圆角、边框和内边距继续提供表单分组，透明背景避免从列表进入表单时产生过重的嵌套层级，桌面和 Web 端保持一致的信息密度。

## 规范

- 表单根容器使用自然的 `space-y-*` 纵向布局，并保留 `rounded-xl border border-border p-4`
  卡片边界，但不使用 `bg-card` 背景；Subagent、MCP Server、Command、Hook 表单统一遵守此规则。
- 表单标题下方说明文字使用 `text-ui-base text-foreground-subtle`。
- 自动化的定时任务与闲时任务新建/编辑页在面包屑后统一展示内容区标题和副标题：标题使用
  `text-ui-xl font-semibold text-foreground`，副标题使用上述辅助信息样式；标题根据新建/编辑状态切换，
  不用任务名称代替页面动作标题。
- 字段 label 使用 `text-ui-base font-medium text-foreground-subtle`。
- 普通字段使用现有 `Input` / `Textarea` / `Select` 组件和 `size="lg"`。
- Subagent 表单的 Model picker 虽复用工具栏 `ModelConfigSelect`，其 trigger 必须使用
  `bg-clip-border` 覆盖 Button 基础 `bg-clip-padding`，保持与普通 Select 相同的输入背景边界。
- 多行字段统一使用设置页共享 Textarea，直接在 textarea 根节点应用
  `rounded-lg border border-input-border bg-input px-2 py-2`，不增加仅用于视觉样式的容器。
- `SelectTrigger` 不使用 `bg-clip-padding`，避免透明卡片内的选择器产生额外的背景裁切层次。
- Hook Runner 使用与 Scope、Event 一致的 `size="lg"` Select；`process` 与 `command`
  仍是互斥执行模式，并继续联动下方 Args 或 Shell/Async 字段。
- 新建/编辑资源表单复用统一操作栏：删除操作仅在编辑态出现并放在左侧；Save 与 Cancel
  放在右侧，顺序固定为 Save → Cancel。窄屏允许操作栏纵向排列，但 Save 与 Cancel
  仍保持右对齐。字段提示放在操作区上方，不占用按钮的水平起点。
- Hook 表单首行在桌面端并列展示 Scope、Event、Runner，窄屏回落为单列；Matcher 与
  Command 组成执行配置双列。Timeout、Status message、Custom JSON 收入默认折叠的
  Advanced 区域，降低首屏高度。
- Hook 列表中的 User / Workspace tabs 与新会话生效提示同排展示，提示紧跟在 tabs 右边，
  不贴容器右侧；窄屏允许换行。提示使用普通辅助文字，不增加卡片背景、边框、圆角或整块内边距。
- Hook 资源在设置侧栏、列表项和插件能力详情中统一使用 `Anchor` 图标；真正的 Webhook
  渠道仍使用 `Webhook` 图标。
- 名称和作用域需要作为同一行的主身份信息展示：名称字段保持常规表单宽度，不撑满整行；作用域使用模型设置“连接方式”同款内联 label + `SelectTrigger size="lg"` 样式贴右侧，下拉触发器按文字内容自然宽度展示；窄屏下自然折行。
- 资源表单里的短身份字段保持宽度一致，例如 MCP 服务器的“名称”和“类型”、命令的“名称”都使用 `w-48`。
- 底部主操作区右对齐，取消按钮使用 `ghost`，保存按钮使用 `default`；新建和编辑场景的主操作文案统一为“保存”，不混用“添加”或“创建”。
- 保存按钮统一在表单有效时启用：必填字段、名称格式、模型选择及 JSON 配置均参与即时有效性判断；
  保存请求进行中继续禁用，避免重复提交。具体错误信息仍由提交校验或字段交互显示。
- 技能、MCP 服务器、命令等资源列表头部的操作区优先放置“新建”按钮，再放导入、打开目录、刷新等辅助操作。
- 返回列表按钮使用带左箭头图标的 `variant="link" size="sm"`，默认 `text-foreground-subtle`，hover 为 `text-foreground` 且不显示下划线，用 `-ml-2` 抵消视觉缩进，保证文字和表单内容左边缘对齐。
- 表单/JSON 等模式切换放在标题行右侧，复用使用统计范围切换样式：`h-8 rounded-lg border border-border bg-background p-1` 外层，选中项使用 `data-active:bg-secondary data-active:text-foreground`。
- 新建 MCP 服务器的类型下拉暂时不展示 `Streamable HTTP`，原因是该传输类型还需要 Agent 侧支持后再开放。

## 当前覆盖

- 模型设置：新建模型供应商。
- MCP 服务器：新建/编辑 MCP 服务器。
- 命令：新建/编辑命令。
- Subagent：新建/编辑用户 Subagent。
- Hook：新建/编辑用户或工作区 Hook。
- 自动化：新建/编辑定时任务与闲时任务。
