# V4 Chat Layout Parity

## 背景

v4 会话区已经恢复旧版 composer 外观，但消息列表与 composer 的父级布局仍和 z-code-2 不一致。z-code-2 的对话区把消息内容和底部输入区放在同一个滚动容器里：滚动条可以滚到包含输入框的最底部，消息主列与 composer 都使用同一套最大宽度。

当前 v4 的 `ConversationTimeline` 自己持有滚动容器，`ConversationComposer` 是 `SessionPane` 的兄弟节点。结果是滚动条只覆盖 timeline，composer 不属于同一个滚动上下文；同时 row 渲染没有统一的主内容最大宽度，宽屏下文本和工具输出会比旧版发散。

## 目标

- 会话态下，v4 消息区和 composer 使用同一个 vertical scroll viewport。
- composer 保持在该 viewport 内 `sticky bottom-0`，滚动到最底部时输入框底部也属于可达范围。
- composer 的底部留白由 dock 内层的透明 `padding-bottom` 承担；消息层在接近 sticky composer 时逐渐 mask 到透明，避免滚动内容直接穿过留白。会话态 `chat-composer-input-surface` 保持透明，不绘制 `background`；草稿态带 context header 的卡片仍使用 `bg-surface`。
- 消息内容、空消息提示、回到底部按钮和 composer 复用 `conversationLayout` 的统一主列布局；已绑定会话在 `conversation < 864px` 时使用 `w-full`，`864px <= conversation < 1136px` 时使用 `calc(100% - 96px)`、`max-w-4xl`，达到 `1136px` 后使用 `calc(100% - 384px)`、`max-w-6xl`；草稿使用 `max-w-2xl`。消息轮次通过 `@max-md/conversation:px-4` 响应 conversation 容器，composer dock 则始终使用 `px-4 pb-4`。
- 保留 v4 虚拟滚动、row 测高缓存、底部跟随和 `loadOlder` 语义。
- 不改变草稿态居中布局，也不改变远控 replayable / desktop continuous 的数据链路。

## 布局链路

```text
SessionPane
  ConversationHeader
  body region
    ConversationStatusPanel
    shared scroll viewport
      virtual timeline content
        centered row column: conversationLayout
        viewport-aligned bottom mask: virtual history + running live tail
      sticky bottom composer dock
        centered composer column: conversationLayout
  QueuePanel
  runtime/dialog controllers
```

## 实现约束

- `ConversationTimeline` 继续拥有虚拟列表与滚动锚定逻辑，但新增 `bottomDock` 插槽，把 composer 渲染进 timeline scroll viewport 的尾部。
- bottom dock 的底部留白属于 dock 容器自身布局，使用响应式透明 padding，不渲染仅用于间距的背景子节点。padding 必须计入 dock 实际高度，保证 Markdown 表格浮动滚动条继续按完整输入区高度避让。
- 消息 mask 只包裹 virtual history 与 running live tail，不作用于 composer、回到底部按钮或 pane focus ring。mask 的渐隐位置按 scroll viewport 与 dock 实际高度同步，不能按虚拟内容总高度定位；桌面与移动端统一使用 40px 渐隐距离。滚动条到达底部时关闭 mask，只有离开底部、消息可能从 sticky composer 下方经过时才显示渐隐。
- `SessionPane` 会话态不再在 timeline 之外渲染 composer；草稿态仍由居中容器渲染 composer。
- `ConversationTimeline` 的滚动 ref 仍是唯一 scroll element，`useVirtualizer.getScrollElement` 不变，避免多 pane 的滚动状态串扰。
- row 的外层绝对定位仍保持 `w-full`，其内部新增居中内容列，避免改变 virtualizer 的测高方式。
- `ConversationComposer` 会话态去掉自身横向 padding，宽度由外层 dock 控制；草稿态和 context header 卡片语义不变。

## 验收

- SSR 结构测试能看到会话态 composer 被渲染在 timeline scroll viewport 内，并带有共享 dock 标识。
- SSR 结构测试能看到 timeline row 内容列和 bottom dock 都使用同一组 `conversationLayout` 布局类。
- `pnpm vitest run packages/ui/test/v4SessionPaneLayoutParity.test.ts` 通过。
- `pnpm typecheck` 和 `pnpm lint` 通过，若环境中存在无关失败，提交说明必须列出。
