# Browser Guest Crash Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser 与 browser-use tab 在 Electron guest 被异常终止后，保持稳定 tab 身份和对话归属，以最近有效 URL 原位恢复并重新接入 CDP。

**Architecture:** 正常对话切换继续保留原 `<webview>`。`UnifiedBrowserView` 监听 guest `render-process-gone`，仅对 killed/crashed/oom/memory-eviction 等可恢复原因递增 guest generation，让 `BrowserViewportSurface` 替换失效节点；最近非 `about:blank` URL 保存在 renderer workspaceKey 隔离内存中，新 guest `dom-ready` 后用同一 browserKey/tabId 上报新的 webContentsId 并恢复 URL。main 的旧 guest 监听清理改为 best-effort，避免已销毁 session 阻断替代 guest attach；relay 与 ZCode session protocol 不新增状态。

**Tech Stack:** React 19、Electron `<webview>`、TypeScript、Vitest + Testing Library。

## Global Constraints

- 普通 A → B → A 切换不得重建、刷新或卸载仍存活的 `<webview>`。
- 用户显式关闭 tab/窗口与 ZCode 进程退出不得自动恢复。
- desktop `desktop-continuous` 只使用 renderer/main 既有 attach 链路；手机 `web-remote-replayable` 不新增 snapshot 或 runtime。
- URL 隔离 key 使用 `workspaceIdentity?.trim() || workspacePath`，实际 tab URL 再按稳定 side-pane tab id 分桶。
- UI 日志统一使用 `packages/ui/src/logger.ts`；异常退出为低频 lifecycle `warn`，普通事件不新增生产 info 流量。
- 修改 UI 前遵守根目录 `DESIGN.md`；本修复不新增视觉样式或文案。
- 每个生产行为先写失败测试并观察预期失败；完成后执行 `pnpm typecheck` 与 `pnpm lint`。

---

### Task 1: Electron webview 异常退出类型与失败回归

**Files:**
- Modify: `packages/ui/src/electron-webview.d.ts`
- Modify: `packages/ui/test/UnifiedBrowserView.test.ts`

**Interfaces:**
- Produces: `ElectronWebviewRenderProcessGoneEvent`，包含 `details.reason` 与 `details.exitCode`。
- Consumes: Electron 本地文档 `docs/electron/docs/api/webview-tag.md` 与 `structures/render-process-gone-details.md`。

- [x] **Step 1: 写可恢复退出的失败测试**

在 `UnifiedBrowserView.test.ts` 创建已经导航到 `https://example.com/restorable` 的隐藏 tab，向原 webview
派发 `{ reason: "killed", exitCode: 1 }` 的 `render-process-gone`；断言节点被替换，新节点
`dom-ready` 后用相同 browserKey、sessionId 和新的 webContentsId attach，并 load 最近 URL。

- [x] **Step 2: 写不可恢复原因的失败测试**

派发 `launch-failed`；断言节点不被替换，避免无限恢复循环。

- [x] **Step 3: 运行测试确认 RED**

Run: `.\node_modules\.bin\vitest.CMD run packages/ui/test/UnifiedBrowserView.test.ts`

Expected: 新用例 FAIL，因为 Electron webview 类型和 `UnifiedBrowserView` 尚未处理
`render-process-gone`。

### Task 2: 最小 guest replacement 与 URL 恢复

**Files:**
- Modify: `packages/ui/src/browser-use/UnifiedBrowserView.tsx`
- Modify: `packages/ui/src/browser-use/BrowserViewportSurface.tsx`
- Modify: `packages/ui/src/embeddedBrowserHelpers.ts`

**Interfaces:**
- Produces: `isRecoverableBrowserGuestExitReason(reason: string): boolean`。
- Produces: `BrowserViewportSurface` 的 `webviewGeneration: number` 参数，作为 `<webview>` React key。
- Consumes: `UnifiedBrowserView` 既有 `browserKey`、`initialUrl`、`onUrlChange`、`browserViewAttachGuest`。

- [x] **Step 1: 实现退出原因门禁**

只允许 `abnormal-exit`、`killed`、`crashed`、`oom`、`memory-eviction` 进入恢复；
`clean-exit`、`launch-failed`、`integrity-failure` 不自动重建。此类 guest 从未成功出画面时，renderer
必须显示带 `reason/exitCode` 的失败态和用户触发的单次重试入口；不能只写入没有渲染消费者的错误
字段，让用户看到静默灰屏。手动重试可以递增 guest generation 并恢复最近 URL，但不得改成后台自动
循环重建。失败态仍允许编辑地址栏；提交合法新 URL 必须等价于一次由用户触发的重建：立即退出失败态、
递增 guest generation，并在新 guest `dom-ready` 后导航到刚提交的 URL，不能只把 URL 排队后继续停留
在失败态。无效 URL 必须保留失败态，不得触发重建。

外部 `navigationRequest` 也是一次受信任的显式导航意图：当 guest 已处于上述失败态时，必须与地址栏
导航一样重建 guest 并消费目标 URL。请求回执不得在仅写入 `pendingUrlRef` 后发出；必须等到新 guest
`dom-ready` 接管排队 URL，且 `loadURL` 成功或明确失败后再回执，避免上层提前清除尚未执行的导航意图。

- [x] **Step 2: 实现最近 URL 与 guest generation**

在正常导航/状态同步时记录最近非 `about:blank` URL。可恢复退出时将该 URL 排入
`pendingUrlRef`，清理 guest attach/load 去重状态，递增 generation 并保留 tab 元数据。

- [x] **Step 3: 让 surface 只替换失效 webview**

将 generation 用作 `<webview>` key；普通 prop/render/对话切换保持 generation 不变。

- [x] **Step 4: 新 guest 重新 attach 与导航**

新节点 `dom-ready` 后继续调用既有 `browserViewAttachGuest({ key: browserKey, ... })`，
然后消费 pending URL。新增中文注释记录旧实现只保留 DOM、未覆盖 Chromium guest 被终止的根因。

- [x] **Step 5: 运行测试确认 GREEN**

Run: `.\node_modules\.bin\vitest.CMD run packages/ui/test/UnifiedBrowserView.test.ts`

Expected: 全部通过，且可恢复/不可恢复分支都有断言。

### Task 3: browser-use URL 进入 workspace 隔离内存

**Files:**
- Modify: `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`
- Modify: `packages/ui/test/UnifiedBrowserView.test.ts`

**Interfaces:**
- Consumes: `browserRestoreUrls: Record<sidePaneTabId, string>` 与
  `onBrowserUrlChange(sidePaneTabId, url)`。
- Produces: browser-use `UnifiedBrowserView` 的 `initialUrl` / `onUrlChange` wiring。

- [x] **Step 1: 补 browser-use URL 回传断言**

组件导航事件更新 URL 时断言 `onUrlChange` 收到非空 URL；恢复新 guest 时使用同一 URL。

- [x] **Step 2: 接入 browser-use tab**

对 `tab.type === "browser-use"` 使用 `tab.id` 读写 `browserRestoreUrls`，与 human Browser
保持相同隔离层，不改变 main/protocol。

- [x] **Step 3: 运行相关 UI 回归**

Run:
`.\node_modules\.bin\vitest.CMD run packages/ui/test/UnifiedBrowserView.test.ts packages/ui/test/workspaceSidePane.test.ts packages/ui/test/taskSidePaneMemory.test.ts`

Expected: 三个文件全部通过。

### Task 3.5: main 进程替代 guest 绑定竞态

**Files:**
- Modify: `packages/desktop/src/main/browserView/browserGuestManager.ts`
- Modify: `packages/desktop/test/browserGuestManager.test.ts`

- [x] **Step 1: 用真实 crash 日志定位 IPC attach 中断**

第一轮 `Page.crash` smoke 证明页面与 URL 已恢复，但 `tab.downloadCleanup` 对已销毁 session 调用
`removeListener` 时抛出 `Object has been destroyed`，使新 guest 的 CDP attach 提前失败。

- [x] **Step 2: 先补失败测试，再让旧监听清理降级**

测试模拟旧 session 清理抛错，断言同 tab key 的替代 guest 仍能 attach；实现用 `try/finally` 保证
清理引用释放并继续后续解绑/重绑。

- [x] **Step 3: 复跑真实 Electron crash**

第二轮 smoke 中 guest 2 → 3、原 URL 恢复；main 记录清理降级后继续
`attachGuest ... cdp=true`，不再出现 IPC handler error。

### Task 4: 证据、矩阵与仓库门禁

**Files:**
- Modify: `docs/testing/browser-use-codex-parity-coverage-matrix.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`

**Interfaces:**
- Consumes: BCP-207/208、J07 与实际测试结果。

- [x] **Step 1: 更新覆盖状态**

将 component/main unit 已证明的部分从 planned 改为自动化路径，并记录真实 Electron
`Page.crash`、同工作区 A → B → A 的 smoke 结果。

- [x] **Step 2: 运行类型与 lint 门禁**

Run: `pnpm typecheck`

Expected: exit 0。

Run: `pnpm lint`

Expected: exit 0；仓库既有 warnings 单独记录。

- [x] **Step 3: 检查 diff 与提交**

只暂存本计划列出的文件，排除 `packages/desktop/.codex-*` 用户复现产物。

Run: `git diff --check`

Expected: exit 0。

Commit: `fix(ui): recover crashed browser guests`
