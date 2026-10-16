# Browser Empty State Compact Style

## 背景

嵌入式浏览器在未导航时展示空置状态。原样式使用大图标和大标题字号，在右侧 pane 的高密度工作区里显得过重。

## 目标

- 浏览器空置状态 logo 使用 `size-16`，避免压过地址栏和 pane 内容层级。
- 图标使用 `foreground` 并叠加 `opacity-30`，在继承主题主色的同时降低视觉权重。
- 图标与标题之间使用 `mb-6`，保持空态紧凑但不拥挤。
- 主标题字号使用 `text-sm`，符合工作区标题级别。
- 次要说明文字固定为 `13px`，符合 Design System 的辅助文字规则。

## 范围

- 调整 `packages/ui/src/EmbeddedBrowserPaneParts.tsx` 中 `BrowserEmptyState` 的视觉样式。
- human 空白 tab 的 webview 创建时机纳入本 spec；不改变导航结果、agent guest 握手、
  远控链路和已创建 guest 的持久生命周期。

## 空置页 guest 创建边界（2026-08-17 补充）

- 用户新建且尚未确认导航的 human browser tab 只渲染空置态，不创建
  `src="about:blank"` 的 `<webview>`。Electron guest 使用独立合成表面，同步创建会在
  React 的遮罩和隐藏样式生效前绘制白色首帧。
- 地址栏草稿不触发 guest 创建；回车确认、初始 URL 或外部导航请求才触发创建。
- 未请求创建 guest 的 human 空置态直接显示 Globe 图标，不将 `isReady=false`
  解释为加载中；只有已请求创建 guest 且尚未 ready 时才显示 spinner。
- guest 创建前的 URL 继续通过 `pendingUrlRef` 排队，`dom-ready` 后由新 guest
  接管 `loadURL`。guest 创建后持续挂载，不因空置态或可见性变化重建。
- agent/browser-use tab 仍需要在首次导航前创建并上报 guest，否则 main 等待
  attach 与首次 browser command 会形成环路等待。residency restore 也保持立即挂载。

```text
human 空白 tab -> 空置态 -> 确认导航 -> 创建 guest -> dom-ready -> loadURL
agent/restore tab -> 创建 guest -> did-attach -> main 接管/恢复
```

## 验证

- 单测覆盖 human 空白 tab 初始无 webview、草稿无 webview、回车后创建并消费导航。
- 单测覆盖未创建 guest 的空置态显示 Globe 而非 spinner。
- 单测覆盖 agent tab 仍在首次导航前上报 guest。
- 正式 Electron E2E `browser-empty-state-deferred-guest.test.ts` 覆盖
  human tab 的真实生命周期：新建空 tab 时 renderer DOM 与 main `webContents` 均无 guest，
  地址栏只输入不回车仍保持空态；回车后只创建一个 guest，消费待导航 URL 并显示页面。
- 执行 `pnpm typecheck`。
- 执行 `pnpm lint`。
