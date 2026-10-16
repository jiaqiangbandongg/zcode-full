# Browser View 权威事件订阅与可见性解耦

## 背景

工单 ZCT-2089607799244095488（3.8.0 Windows）反馈「打不开侧边栏 bua」。main 日志显示同一
会话内三次 `newTab` 全部在 10 秒 attach 窗口超时：

```text
14:55:09.535 newTab -> 14:55:19.540 waitForGuest timeout ok=false (10004ms)
14:55:29.891 newTab -> 14:55:39.892 waitForGuest timeout ok=false (9999ms)
14:55:50.514 newTab -> 14:56:00.525 waitForGuest timeout ok=false (10011ms)
```

同时段 `list`、`listUserTabs`、`browserVisibilityGet`、`browserVisibilitySet` 全部成功，无 renderer
崩溃、无 error 级日志，且全份日志没有任何 `attachGuest` 记录（含 skip / rejected）——renderer 从未
把 guest 的 `webContentsId` 上报回 main，即渲染端没有创建 webview。

三次 `newTab` 都紧邻 `system.listIntegratedTerminalShells`（只有 `SettingsPage` 会调用），配套出现
`getStaticTeamProducts`、`getEnterprisePricing`、`file-watcher.unwatch`，说明故障期间设置页处于激活
状态。用户已复现：跑 Browser Use 对话时切到设置页即触发。

## 根因

`isWorkspaceVisible` 同时承担了两种语义：

- 展示语义：这个视图现在给不给用户看。
- 订阅语义：要不要接收 main 的权威事件。

`RootWorkspaceContent` 传入 `isWorkspaceVisible={!isSettingsTabActive}`，而 `useAppPanels` 把四个
Browser View 事件订阅挂在该标志上。设置页一打开，effect cleanup 取消订阅，main 侧
`onOpenTabRequested` 发出的 `BrowserViewReady` 没有接收方，`waitForGuest` 干等 10 秒后判定失败，
`newTab` 分支随即 `closeTabDurably(tab)` 把 tab 删除。用户退出设置页时侧边栏里已无任何 browser
tab，主观表现就是「打不开侧边栏」。

main 是 browser tab 生命周期的唯一权威，renderer 只是被动接收方。用可见性关闭订阅，等于让
权威事件在设置页期间进入黑洞，属于设计缺陷而非偶发 bug。

## 目标语义

- 订阅 main 权威事件与视图可见性无关：设置页覆盖期间订阅常驻。
- 是否抢焦点仍由既有 `shouldReveal`（workspace / remoteSession / ownerTaskId scope 匹配）决定，不新增
  pending reveal 状态。
- 设置页期间 agent 可以正常新建、导航、操作 iab tab；tab 与网页内容在退出设置页后原样保留。
- 设置页是覆盖层，App 与 side pane 不卸载，因此「保留内容」不需要额外的状态保存或恢复逻辑。
- 能力语义保持为门槛：`isDesktop`、`supportsEmbeddedBrowser` 继续参与判断。

## 事件链路

```text
修复前（设置页激活 -> isWorkspaceVisible=false）

  main（tab 生命周期权威）                    renderer
  --------------------------                  --------
  newTab
   +- ensureGuest
   |   +- onOpenTabRequested
   |       +- send BrowserViewReady ---X--->  订阅已 cleanup，事件丢弃
   +- waitForGuest (10s)
       +- timeout -> ok=false
           +- closeTabDurably --------------> tab 被删除
                                              退出设置页后侧边栏无 browser tab

修复后

  newTab
   +- ensureGuest
   |   +- send BrowserViewReady ----------->  订阅常驻
   |                                          +- applyBrowserUseSidePaneEvent
   |                                          |   +- 挂载 tab（无条件）
   |                                          |   +- shouldReveal 由 scope 决定
   |                                          +- <webview> 创建并 attach
   +- waitForGuest <------ browserViewAttachGuest
       +- attachGuest -> resolveWaiters ok=true
```

## 实现约束

- `packages/ui/src/hooks/useAppPanels.ts` 四处 effect 去掉 `!isWorkspaceVisible` 判断：
  `onOpenBrowserUrl`、`onBrowserViewReady`、`onBrowserViewOperation`、`onBrowserViewVisibility`。
  四者都是 main 权威转发，缺一处就会各自漏事件：ready 漏则 attach 超时并删 tab，visibility 漏则
  `browserVisibilitySet` 返回 ok 但界面不动，operation 漏则 tab 操作指示状态不同步，
  `onOpenBrowserUrl` 漏则页面内 `target=_blank` 被静默吞掉。
- `isWorkspaceVisible` 仍在 hook 入参类型中，但 hook 不消费它。展示语义由 `App.tsx` 自己的消费点
  承担，入参本身不服务任何运行时语义，保留的唯一理由是回归护栏：单测靠传 `false` 表达“设置页
  覆盖中”，一旦可见性被重新写回订阅条件，四条用例会立即失败。删掉入参就等于删掉这层保护。
- `App.tsx` 其余消费点不改：`useGitAutoRefresh` 的 `enabled`、`getCloseActiveContextSidePaneTab`、
  `runWorkspaceVisibleCommand`、`useWorkspaceMainViewSettingsExit` 用的都是「用户意图 / 性能」语义。
- 不引入 pending reveal、不缓存事件重放：既有 `shouldReveal` 已经表达焦点语义，重放会与 main
  authority 争夺 tab 生命周期。
- 隐藏或 0 宽 pane 首次 `tabs.new()` 仍能 attach，只会拿到 0×0 viewport，由
  `browserGuestManager` 的 `applyBackgroundViewportFallback` 兜底，本次不改该路径。

## 验收

- `isWorkspaceVisible: false` 时 `BrowserViewReady` 仍挂载 tab，scope 匹配时展开并激活。
- `isWorkspaceVisible` 由 `true` 切到 `false` 后订阅不断开。
- `isWorkspaceVisible: false` 时 visibility 事件仍能切换 active tab。
- `isWorkspaceVisible: false` 时页面内 `target=_blank` 仍能开右侧 browser tab。
- 单测覆盖以上四条：`packages/ui/test/useAppPanelsBrowserViewLifecycle.test.ts`。

## 运行时验证记录（2026-08-18，macOS dev）

在设置页保持打开的状态下让 agent 执行「用内置浏览器打开 https://example.com」，main 与 renderer
日志：

```text
18:12:38.983 [main]     browser-use execute start method=newTab
18:12:38.984 [renderer] [App] 展开并激活 browser-use tab tabId=iab-tab:2...
18:12:39.088 [main]     browser-use attachGuest tabId=iab-tab:2994a9a5... windowId=1 cdp=true
18:12:39.090 [main]     browser-use execute done method=newTab ok=true elapsedMs=107
18:12:39.221 [main]     browser-use execute done method=navigate ok=true
18:12:40.046 [main]     browser-use execute done method=playwright ok=true
18:12:42.712 [main]     browser-use execute done method=screenshot ok=true
```

`newTab` 107ms 完成（修复前为 10004ms 超时后删 tab），且设置页覆盖期间 navigate / playwright /
screenshot 全部成功，说明 guest 拿到的不是不可用的 0×0 状态。退出设置页后 webview 仍存在、
可见尺寸 385×216，侧栏 tab 标题同步为 `Example Domain`，内容完整保留。

