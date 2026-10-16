# Chat Find Placement

`Cmd/Ctrl+F` 打开的任务内查找框属于当前聊天区域，而不是全局窗口标题区控件。

查找框应渲染在 workspace conversation panel 的视觉边界内，位于聊天内容上方并水平居中。桌面端直接挂载在 conversation panel；手机 Web 远控通过 shell 的独立 chat overlay 插槽挂载，使浮层仍跟随聊天内容区域，但不成为聊天正文 DOM 的后代。这样桌面端在展开侧栏、Git/Browser side pane、终端分栏时仍跟随聊天列，手机端也不占用全局导航或窗口按钮区域。

查找状态仍由 `App` 统一持有，继续驱动聊天正文高亮和文件变更高亮。`TaskFindDialog` 只负责输入、范围切换和结果导航，不新增跨端 runtime 状态，也不改变 desktop continuous 与 web remote replayable 的消息链路。

查找框内的图标按钮必须提供 tooltip。结果导航按钮即使在无结果禁用时也应能展示 tooltip，避免纯图标控件含义不可见。搜索范围切换按钮的 tooltip 使用固定文案“切换搜索范围会话/文件”，按钮自身的 `aria-label` 仍表达下一次点击将切到的范围。

## 手机 Web 覆盖抽屉层级

手机 Web 打开 Git/Browser side pane 时，覆盖式抽屉会把底层聊天表面设置为 `inert` 和 `aria-hidden`。该隔离是防止遮罩下 composer、模型选择等控件继续响应点击的既有安全边界，不得为了查找功能移除或放宽。

`TaskFindDialog` 必须由 `WebRemoteControlMobileShell` 的独立 `chatOverlay` 插槽承载。该插槽与聊天表面、side pane overlay 同级，不受聊天表面的 `inert` / `aria-hidden` 继承，并使用高于抽屉遮罩的层级。切到文件变更范围后，输入框、上一个/下一个、范围切换和关闭按钮都必须继续可聚焦、可点击；切回会话范围时复用同一个组件实例和本地 query/scope 状态，不能通过在聊天树与抽屉树之间搬运组件造成重挂载。

不采用以下方案：

- 移除聊天表面的 `inert`：会恢复遮罩下控件穿透，破坏既有移动端交互隔离。
- 按查找范围把组件在聊天树与 side pane 树之间迁移：会引入 scope 外部化和组件重挂载，增加 query、焦点和导航版本丢失风险。

移动端 DOM 回归必须证明查找 overlay 位于 `inert` 聊天表面之外，并且打开 side pane 后仍保留可交互控件。桌面 pending E2E 继续证明真实会话/Git 滚动重新居中；在没有独立 mobile replayable E2E 基础设施前，不把桌面 case 表述成手机端端到端证明。

## Escape 优先级

chat placement 使用 window 冒泡阶段监听补齐 Escape 关闭语义。监听器必须先检查 `event.defaultPrevented`：活动的嵌套浮层或控件已经消费 Escape 时，查找框保持打开；只有未被处理的 Escape 才由查找框调用 `preventDefault()` 并关闭。测试必须同时覆盖已处理与未处理两条路径。

## 结果导航语义

查找状态必须区分“当前选中哪个命中”和“用户新发起了一次导航”。查询词与命中索引描述当前选择；独立、单调递增的导航请求版本描述用户是否再次要求定位。不能只用 `(query, activeIndex)` 判断是否需要滚动，因为单命中时上一个、下一个、`Enter` 和 `Shift+Enter` 都会环绕到同一个索引。

以下入口必须采用一致语义：

- 点击上一个或下一个结果。
- 在搜索输入框按 `ArrowUp`、`ArrowDown`、`Enter` 或 `Shift+Enter`。
- 会话正文与文件变更两种搜索范围。

当用户滚离当前命中后，即使目标索引没有变化，任一结果导航入口都必须重新将该命中滚到视口中央。多命中时继续按现有环绕顺序切换；零命中时按钮和键盘导航入口都保持禁用，不产生新的导航请求版本。

导航请求版本只属于 renderer 本地 UI 状态，不进入 session/task runtime、协议、snapshot、队列或持久化。会话正文与文件变更各自维护独立版本，避免切换范围时互相触发滚动。文本高亮 hook 继续保留 DOM mutation 去重，但新的用户导航版本必须突破同一 `(query, activeIndex, matchCount)` 的滚动去重。

桌面端与手机 Web 端复用同一 `TaskFindDialog` 和高亮 hook，因此交互语义保持一致；该变更不触碰 `desktop-continuous` 与 `web-remote-replayable` 的消息恢复边界。
