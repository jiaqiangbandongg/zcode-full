# 设置页侧栏布局

设置页使用桌面化左右分栏结构，并统一收敛到 [DESIGN.md](../../DESIGN.md#color-palette) 中的语义 token：

- 外层容器使用 `bg-background + border-border`，形成独立设置工作区。
- 左侧导航使用 `bg-sidebar`，承载返回按钮、分组导航和当前分组说明。
- 左侧导航需要响应窗口宽度：`lg` 及以上保持 264px 文本侧栏，即 256px 内容宽度加 8px 安全余量；低于 `lg` 时收敛为 64px 图标侧栏，隐藏可视文本并通过 tooltip 暴露返回、分组和引导入口标题，避免窄窗口挤压右侧设置内容。
- 右侧内容区保持 `bg-background`，标题与设置内容分离，正文宽度收敛到中等阅读列。
- 设置项卡片统一使用 `bg-card + border-border`，行内分隔线统一使用 `border-border`。
- 交互控件优先使用 `bg-input / border-input-border / bg-hover / bg-selected`，避免页面局部再拼新的中性色值。
- 通用 `Card` 基类也同步收敛到 `bg-card + border-card-border + text-foreground`，避免页面组件重复手写卡片轮廓语义。

## 导航分组

设置入口保持原有路由语义，但按用户任务拆成三个可见分组：

- 基础设置：常规、界面、模型设置、浏览器。
- Agent 能力：插件、技能、子智能体、MCP 服务器、命令、钩子。插件作为 Agent 扩展能力的统一入口放在组首，命令和钩子与其他 Agent 配置保持相邻。
- 数据与统计：索引库、使用统计。

分组标题属于导航结构，不是可点击入口。宽侧栏显示本地化标题；低于 `lg` 收敛为 64px 图标栏时隐藏可视标题，并用弱分隔线保留组边界。每组使用独立的无障碍 group 名称，组内入口继续保留 tooltip、`aria-current` 和原有 test id。引导入口不归入设置分组，继续放在分组列表之后。

分组只影响 desktop / web 共用设置页的导航视觉和语义结构，不改变设置分区 id、最近访问分区、显式跳转意图、内容路由或持久化。手机 `/remote` 当前没有设置页入口，因此不新增移动端专属交互；窄窗口仅验证响应式图标栏表现。

当前入口职责如下：

- 常规：管理界面主题和语言。
- Models：使用 Lucide `Package` 图标。
- 插件：使用 Lucide `Blocks` 图标，与设置页中的插件默认图标保持一致。
- MCP：使用 Lucide `Server` 图标。
- 代码预览：管理代码块主题、行号、自动换行和字号，并保留浅色 / 深色双预览。
- 模型供应商：管理 ZCode Agent 使用的模型供应商、凭据与可用模型。
- 技能：管理项目级与用户级技能。
- MCP 服务器：管理通用与 ZCode Agent 使用的 MCP 配置。
- 命令：管理不同 Agent CLI 的 `.md` 命令文件。
- 钩子：管理任务生命周期钩子。
- 索引：管理 workspace 索引相关能力。
- 浏览器：管理 Browser Use 官方插件开关、Chrome 数据一次性导入和内置浏览器数据清理。
- 用量：查看应用与编程套餐用量。

历史窗口里残留的已隐藏分区跳转意图会回落到可见的默认分区，避免打开空白设置页。

## 阻塞交互隔离

设置页打开后，它是当前窗口唯一可交互的主表面。底层 workspace 为了保留会话订阅、草稿、终端和布局状态继续挂载，但必须同时标记为 `aria-hidden` 和 `inert`；仅使用透明度与 `pointer-events` 隐藏不够，因为权限卡片的自动聚焦仍可能把焦点从设置表单抢走。

```text
CLI pending interaction
  -> conversation snapshot 继续更新
  -> 被设置页覆盖的 workspace（mounted + aria-hidden + inert）
       |-> 不聚焦 Permission / AskUserQuestion
       |-> 不接收键盘或指针交互
       `-> 任务徽标 / 系统通知仍可提示

用户显式返回工作区或点击任务通知
  -> settings layer 关闭
  -> workspace 移除 inert
  -> 在原 task 的 bottom dock 展示待处理交互
```

| 当前表面 | 后台事件 | 期望结果 |
| --- | --- | --- |
| 设置页 | 普通权限请求 | 设置页、表单值和当前焦点保持不变；请求继续留在原 task |
| 设置页 | `AskUserQuestion` | 与普通权限使用同一表面隔离规则；不强制切回会话 |
| 设置页 | 请求完成或自动结束 | 只更新后台 task 投影；设置页不切换 |
| workspace | 权限或问答仍 pending | 按既有 bottom dock 交互展示并允许响应 |

该边界只约束 renderer 表面和焦点所有权，不修改 `pendingInteractions`、请求倒计时、权限响应、任务通知、desktop `desktop-continuous` 或手机 `web-remote-replayable` 的协议与恢复语义。手机 `/remote` 没有桌面设置覆盖层时继续使用现有移动端交互，不从本 case 推导新的远控行为。

这次调整只修改 UI 结构与视觉层级，不改动底层设置状态、持久化方式，以及 desktop / web 共用的设置逻辑。
