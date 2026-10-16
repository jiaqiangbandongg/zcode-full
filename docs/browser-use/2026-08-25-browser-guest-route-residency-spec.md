# Browser Use Guest 跨主视图常驻规格（最小化延期）

> 状态：当前迭代已实现（最小化场景延期）
> 决策日期：2026-08-25
> 适用范围：Desktop `desktop-continuous` 的 Browser / Browser Use `<webview>` Guest。
> 非适用范围：手机 `web-remote-replayable`、relay 中的 task/session 恢复、独立后台浏览器窗口。

## 1. 背景与运行时根因

工单 `ZCT-2092076135526567936` 的 CDP teardown 修复后，定时任务在“自动化”主视图执行 Browser Use
仍会失败：

```text
browser-use newTab
  -> renderer 收到 BrowserViewReady 并登记 iab tab
  -> 10 秒内没有 browserViewAttachGuest
  -> waitForGuest timeout
  -> browser guest not attached (webview not ready)
```

运行时复现中，保持在自动化页时两次 `newTab` 均等待 10 秒超时；切换到执行会话的对话页后，旧 tab
立即创建 `<webview>`、上报 `attachGuest`，随后 navigate / screenshot 成功。根因不是 main 没有创建 Guest，
而是 `WorkspaceShellLayout` 只在对话主视图分支渲染 `AnimatedSidePanePanel`；自动化主视图只渲染
`AutomationsSection`。因此 renderer 虽然持有 Browser Use tab shell，却没有可承载 Guest 的 DOM。

已有 `shouldMountSidePaneContent()` 合同已经规定：Browser / Browser Use tab 即使面板收起也要保持
`<webview>` 挂载。当前缺口发生在更外层——整个 Side Pane 组件被主视图路由卸载，使该合同没有执行机会。

## 2. 当前迭代范围与用户确认的产品边界

- 当前迭代只保证 ZCode 窗口存在且未最小化时，chat、自动化、插件、Repo Wiki 等主视图都能操作 Browser Use。
- 主窗口最小化到 macOS Dock 后的已有 Guest/冷启动行为不在当前迭代验收范围，后续单独处理。
- 在自动化页点“立即运行”或由定时器触发时，不要求用户先进入执行会话的对话页。
- 本次不新增“不可缩小透明窗口”或任何独立后台 BrowserWindow。
- 自动化页、插件页、Repo Wiki 等非对话主视图不展示 Side Pane；后台 Guest 不抢焦点、不改变主视图。
- 截图 prepare 期间不展开物理 Side Pane；由 Browser Use tab 在现有窗口内创建固定尺寸的低透明合成层，保持 Guest 有 compositor surface，同时不参与右侧布局，用户不应看到 tab 栏闪现。
- 完整退出 ZCode 仍结束所有 Guest；本次不新增跨进程持久化或重启恢复。

## 3. 目标与非目标

### 3.1 目标

1. `AnimatedSidePanePanel` 在 Desktop 工作区壳层内跨 `workspaceMainView` 常驻。
2. 对话主视图继续按 `isSidePaneOpen` 展开/收起；非对话主视图强制折叠但不卸载 Browser Guest。
3. 自动化页收到 `BrowserViewReady` 后能创建 `<webview>` 并在 main 的 10 秒期限内完成 attach。
4. 对话页 → 自动化页 → 对话页不触发 Browser Guest teardown、换代或页面重载。
5. 截图 prepare 到达非 chat 主视图时，保持物理 Side Pane 折叠，由 tab 自己的固定尺寸合成层提供真实 compositor surface；请求释放后移除该合成层。

### 3.2 非目标

- 不创建透明窗口、离屏窗口或第二套 Browser runtime。
- 不修改 BrowserCommand / ZCode Protocol，不新增 task snapshot、queue 或 replay 字段。
- 不让自动化页显示 Side Pane，也不把后台任务自动切到前台。
- 不绕过 32-tab residency 预算、session/workspace ownership 或 CDP teardown handshake。
- 不承诺应用完整退出后恢复 Browser tab、URL、history 或 page state。

## 4. 状态与事件链路

### 4.1 修复前

```text
workspaceMainView = automations
        |
        +--> AutomationsSection（已挂载）
        |
        X--> AnimatedSidePanePanel（路由分支未渲染）
                   |
BrowserViewReady --X--> 无 <webview> 可创建
                   |
                   +--> main waitForGuest 10s timeout
```

### 4.2 修复后

```text
Desktop workspace shell
        |
        +--> ResizablePanelGroup（跨主视图常驻）
                |
                +--> conversation-column
                |       +--> chat / automations / plugin-store / repo-wiki
                |
                +--> AnimatedSidePanePanel（跨主视图常驻）
                        |
                        +--> chat：按 isSidePaneOpen 可见
                        +--> 非 chat：折叠、不可交互，但 Browser Guest 保持挂载
                                      |
BrowserViewReady --------------------> <webview> -> attachGuest -> CDP ready
```

### 4.3 最小化生命周期（后续专项，不作为本次验收）

```text
主窗口 minimize
      |
      +--> renderer / Side Pane Host 不销毁
      |       |
      |       +--> 已 attach Guest 保持同一 generation
      |       +--> CDP/DOM/navigation 继续走原 BrowserGuestManager
      |
      +--> screenshot
              +--> 复用 bounded screenshot activity lease
              +--> 成功/失败/取消后释放

主窗口 close / app quit
      +--> 沿用既有 teardown 与进程内生命周期，不做后台窗口接管
```

## 5. Impact Brief

### 5.1 变更分类

| 项         | 结论                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| 改动层级   | `presentation` + Desktop Guest `recovery/lifecycle`                     |
| 用户入口   | 自动化主视图“立即运行”、定时触发、对话页 Browser Use                    |
| 权威状态   | logical tab/Guest 在 Desktop main；renderer 只承载并 attach `<webview>` |
| 提交副作用 | 无新的业务提交；只改变 Side Pane Host 的挂载位置和可见性 gating         |
| 持久化     | 不新增；完整重启仍为空                                                  |

### 5.2 UI Surface Matrix

| 场景               | UI 入口                     | 共享实现                                       | 可见性 owner     | Guest owner                   | 模式边界                         | 必须隔离                               |
| ------------------ | --------------------------- | ---------------------------------------------- | ---------------- | ----------------------------- | -------------------------------- | -------------------------------------- |
| 对话页 Browser Use | `WorkspaceShellLayout` chat | `AnimatedSidePanePanel` / `UnifiedBrowserView` | `isSidePaneOpen` | Desktop `BrowserGuestManager` | Desktop local/remote shared host | session、workspaceKey、remoteSessionId |
| 自动化立即运行     | `AutomationsSection`        | 同一常驻 Side Pane Host                        | 主视图强制隐藏   | 同上                          | Desktop only                     | 不抢焦点、不切会话                     |
| 定时后台运行       | Automation service 派生会话 | 同一常驻 Side Pane Host                        | 主视图强制隐藏   | 同上                          | Desktop continuous               | 不进入手机 replayable snapshot         |
| 手机 `/remote`     | Mobile shell                | 无 Electron `<webview>`                        | 既有移动抽屉     | shared-host attachment        | `web-remote-replayable`          | 不新建 Browser runtime                 |

### 5.3 影响关系

| 级别           | From                            | 关系         | To                           | 原因                              |
| -------------- | ------------------------------- | ------------ | ---------------------------- | --------------------------------- |
| must-inspect   | `WorkspaceShellLayout`          | 跨主视图保留 | `AnimatedSidePanePanel`      | 当前卸载点和直接根因              |
| must-inspect   | `AnimatedSidePanePanel`         | 后台挂载     | `BrowserUseSidePaneContent`  | tab 到 `<webview>` 的真实承载链路 |
| should-inspect | `useAnimatedResizablePanel`     | 折叠但不卸载 | Side Pane panel              | 非对话页不能占用可见宽度          |
| invariant-only | Browser tab residency           | 保留         | 32-tab/teardown/scope        | 不能因常驻绕过回收与隔离          |
| invariant-only | Web remote                      | 不变         | replayable/shared-host       | 不新增手机 Guest 或恢复状态       |
| evidence-only  | UI layout tests + Electron logs | 证明         | attach/navigation/screenshot | 静态结构和运行时证据互补          |

### 5.4 图谱漂移

现有功能图已声明 Browser tab 在面板折叠、切换对话后保持挂载，但没有声明自动化主视图可以在不展示
Side Pane 时触发后台 Browser Use。实现前把该已确认关系补到 `zcode-feature-graph.yaml`。

## 6. 实现合同

### 6.1 工作区壳层

- Desktop 主内容始终由同一个 `workspace-body-layout` 承载。
- `conversation-column` 内根据 `workspaceMainView` 选择 chat / automations / plugin-store / repo-wiki。
- `AnimatedSidePanePanel` 始终是该 layout 的稳定 sibling；主视图切换不得改变其 React identity。
- `useAnimatedResizablePanel.open` 只在 chat 且用户打开 Side Pane 时为真；非 chat 始终折叠，截图期间不改变面板布局。
- 非 chat 的截图 prepare 期间，目标 TabsContent 在现有窗口内以 viewport 尺寸 fixed 承载层渲染，使用
  `opacity: 0.001` 保留 Chromium compositor surface，同时不参与 Side Pane 布局，避免自动化页出现 tab 栏或白屏闪烁。
- 非对话主视图期间 logical `isSidePaneOpen` 不清空；返回 chat 后恢复用户原来的展开意图。

### 6.2 Guest 挂载

- `shouldMountSidePaneContent(false, tabs)` 遇到 Browser / Browser Use tab 仍返回 true。
- 已 mounted 的 `<webview>` 不因主视图切换卸载；Inactive/截图合成的既有规则不变。
- 新 `BrowserViewReady` 在自动化页进入 side pane state 后，下一次 render 必须创建对应
  `UnifiedBrowserView`，并通过可信 IPC sender 上报 `attachGuest`。
- 截图 prepare 被 renderer 接收后，tab registry 允许在 attach/restore 期间更新
  `browserGeneration`；请求继续按稳定的 `tabId + workspace/session/browser` 路由，最终 stale
  校验仍由 main coordinator 执行。
- 不新增单例全局 Guest；一个 logical tab 仍对应自己的 stable tabId、scope 与 guest generation。

### 6.3 截图与最小化延期

- 不设置主窗口永久 `backgroundThrottling=false`，也不新增透明窗口。
- 当前仍复用 owner renderer + target Guest 的截图 activity lease；最小化后的首次创建与截图结果留待后续规格。

## 7. 验收与剪枝

| Case    | Setup                                                     | Action                           | 断言                                                                             | 状态     |
| ------- | --------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- | -------- |
| BCP-227 | 保持自动化主视图，存在可立即运行的 Browser Use automation | 点击“立即运行”且不切到对话页     | `BrowserViewReady -> attachGuest -> newTab ok`；自动化页仍可见，Side Pane 不露出 | accepted |
| BCP-228 | chat 已有 attached Guest                                  | chat → automations → chat        | `<webview>` identity/guest generation/URL 不变；无 teardown/rebind               | accepted |
| BCP-229 | 已有 attached Guest，主窗口最小化                         | 后台执行 navigate/DOM/screenshot | 当前迭代不验收，延期到最小化专项                                                 | deferred |
| BCP-230 | 无 Guest，主窗口先最小化                                  | 后台首次 `newTab` 并截图         | 当前迭代不验收，延期到最小化专项                                                 | deferred |

剪枝：主题、语言、模型/provider 不改变 Guest attach 语义，由结构单测和一个真实 Desktop 代表；手机
`/remote` 没有 Electron `<webview>`，只验证不新增该路径，不与四个 Desktop case 做笛卡尔积。

## 8. 测试与运行时证据

1. UI SSR/component 回归：自动化主视图仍渲染唯一的 `AnimatedSidePanePanel`，但可见性为 false；
   `workspace-body-layout` 与 `conversation-column` 保持稳定。
2. 既有 `workspaceSidePane` / `BrowserUseSidePaneContent` / `UnifiedBrowserView` 测试继续验证隐藏挂载、
   session/workspace scope 和 Guest attach。
3. macOS dev 真实回归：
   - 保持自动化页点“立即运行”，观察 `newTab -> attachGuest -> screenshot` 在窗口内完成；
     generation 在 attach 后更新时，截图仍在约 1.3 秒内完成；
   - 切回对话确认页面与 Guest identity 保留；
   - 最小化 Case BCP-229/230 不作为本次通过条件，保留为后续专项。
4. 必跑：受影响 UI tests、`pnpm typecheck`、`pnpm lint`。

## 9. 完成条件

- BCP-227/228 自动化与 dev 运行时证据通过。
- BCP-229/230 明确标记 deferred，不阻塞当前迭代。
- 自动化主视图没有 Side Pane 可见回归，chat 返回后可恢复原展开意图。
- Desktop continuous、mobile replayable、workspace identity、32-tab residency 与 CDP teardown 合同不变。
