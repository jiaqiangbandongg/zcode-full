# Browser Background Screenshot Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不切换用户当前侧栏 tab、不抢焦点和不闪烁的前提下，为后台 browser-use `<webview>` 建立可验证的截图合成表面，杜绝 Chromium 用旧 `800 × 450` surface 平铺生成 `1274 × 720` 截图。

**Architecture:** `BrowserGuestManager` 在所有 screenshot 类命令真正进入 CDP 前，通过可注入的 `BrowserScreenshotSurfaceCoordinator` 向 owner renderer 发起一次带完整 browser scope 的准备握手。renderer 将目标 inactive browser-use tab 临时放入当前侧栏内容区下方的 capture layer，等待 `<webview>` 连续两个 animation frame 尺寸稳定后 ACK；main 校验窗口、sender、request、guest id 和 viewport 后才允许 `Page.captureScreenshot`，并在真实 backend settle 后幂等 release。

**Tech Stack:** TypeScript 6、Electron 41 `<webview>`/IPC/CDP、React 19、Radix Tabs、Tailwind CSS、Vitest + Testing Library、独立 Electron compositor smoke。

## Global Constraints

- 设计事实以 `docs/superpowers/specs/2026-07-23-browser-background-screenshot-surface-design.md` 为准；先更新 `docs/testing/browser-use-codex-parity-coverage-matrix.md` 的 BCP-213，再修改实现。BCP-209 已由最新 `release/v3.5.0` 用于“显式截图绝对路径”，本修复顺延到下一个未占用编号。
- 当前工作树存在另一个 browser guest crash-recovery 任务对
  `browserGuestManager.ts`、`browserGuestManager.test.ts`、`AnimatedSidePanePanel.tsx`、
  `UnifiedBrowserView.tsx`、`BrowserViewportSurface.tsx`、`electron-webview.d.ts` 及其测试的
  未提交修改；执行前必须等待这些文件稳定并重新阅读最终 diff，禁止覆盖或回退它们。
- 不修改 `@zcode/protocol`，不新增 relay、task、stream、queue、snapshot 或 replayable 状态；prepare/ready/release 仅是 desktop main 与 owner renderer 的瞬时平台 IPC。
- workspace 身份继续使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`；消息必须同时携带 `workspaceKey`、`sessionId`、`browserId`、`browserGeneration`、`tabId`、`webContentsId` 和 `requestId`。
- prepare 默认总预算固定为 `3000ms`；main 通过 prepare payload 把实际 `timeoutMs` 传给
  renderer，renderer 的本地验证保险 deadline 为 `timeoutMs + 1000ms`。viewport 比较允许每边
  最多 `1px` 的舍入误差。
- 后台 capture layer 必须 `pointer-events: none`、`inert`、`aria-hidden=true`，不能改变 Radix Tabs 的 active value，不能调用 `.focus()`。
- UI 高频握手日志只用 `packages/ui/src/logger.ts` 的 `logger.debug`；main 只用现有 `logger.debug`，不记录图片 base64、页面正文或完整 URL。
- 截图准备失败时不得调用 `Page.captureScreenshot`；显式 screenshot 返回结构化失败，轮尾自动截图沿用现有 best-effort 跳过语义。
- capture layer 的颜色、层级和背景只复用 `DESIGN.md` 的语义 token；不得加入平台特判色、可见提示或新增文案，因此不产生新的 i18n key。
- desktop `desktop-continuous` 与 mobile `web-remote-replayable` 的现有持久图片事实不变；
  手机仍经 shared-host attachment 调 owner desktop window，不创建独立 browser runtime。
- Windows、macOS、Linux 共享同一接口；实现完成必须执行 `pnpm typecheck` 和 `pnpm lint`。

---

## File Structure

### New files

- `packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts`
  - 只负责 main 侧 prepare/ready/release 请求关联、默认 `3000ms` timeout、abort、窗口/sender/viewport 校验和幂等清理。
- `packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts`
  - 用 fake sender/send callback 覆盖协调器状态机，不启动 Electron。
- `packages/ui/src/browser-use/BrowserUseSidePaneContent.tsx`
  - 只负责 browser-use `TabsContent` 的 capture-layer 布局和交互隔离。
- `packages/ui/src/browser-use/useBrowserScreenshotSurfaceRequest.ts`
  - 只负责侧栏根层订阅 prepare/release、完整 scope 匹配和单 request 状态。
- `packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts`
  - 只负责观察当前 `<webview>`、等待两个稳定 animation frame 并发送 ready。
- `packages/ui/test/BrowserUseSidePaneContent.test.ts`
  - 证明 inactive tab 临时可合成但仍不可交互/不可聚焦，release 后恢复 hidden。
- `packages/desktop/scripts/browser-screenshot-surface-smoke.mjs`
  - 使用真实 Electron `<webview>` 和四角 sentinel 验证 background capture 后不再出现 `800 × 450` 周期重复。

### Modified files

- `docs/testing/browser-use-codex-parity-coverage-matrix.md`
  - 新增 BCP-213，固定本次修复的验收边界。
- `packages/shared/src/platform.ts`
  - 定义三个严格 payload，并扩展 `IPlatformService`。
- `packages/shared/src/channels.ts`
  - 增加三个 `PlatformChannels` 及 request/response contract。
- `packages/desktop/src/preload/index.ts`
  - 暴露 prepare/release listener 和 ready sender。
- `packages/desktop/src/renderer/src/main.tsx`
  - 把 preload bridge 注入 UI `IPlatformService`。
- `packages/desktop/src/main/desktopBrowserViewIpc.ts`
  - 只接受可信 sender window 的 ready，并把 `windowId + senderWebContentsId` 交给协调器。
- `packages/desktop/src/main/desktopMainIpcPlatform.ts`
  - 把 ready callback 传入 browser IPC 注册函数。
- `packages/desktop/src/main/index.ts`
  - 创建协调器、注入 `BrowserGuestManager`，并把 main→renderer send 与 renderer→main ready 接线。
- `packages/desktop/src/main/browserView/browserGuestManager.ts`
  - 为 screenshot/elementScreenshot 增加“读 CSS viewport → prepare → capture → release”门禁。
- `packages/desktop/test/desktopBrowserViewIpc.test.ts`
  - 覆盖 ready 的可信窗口绑定。
- `packages/desktop/test/preloadDisposer.test.ts`
  - 覆盖新 listener disposer 与 ready sender。
- `packages/desktop/test/browserGuestManager.test.ts`
  - 覆盖调用顺序、失败不 capture、成功/异常/abort release 和既有 in-flight backpressure。
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`
  - 增加一个相对定位的内容栈，并把 browser-use branch 交给新组件。
- `packages/ui/src/browser-use/UnifiedBrowserView.tsx`
  - 接收瞬时 surface request；后台准备时只恢复布局，不改变 `isVisible` 交互语义。
- `packages/ui/test/UnifiedBrowserView.test.ts`
  - 覆盖 guest id、稳定帧和 viewport 匹配门禁。
- `packages/desktop/package.json`
  - 增加显式、非默认的真实 Electron smoke 命令。

---

### Task 1: 冻结 BCP-213 与跨进程平台合同

**Files:**
- Modify: `docs/testing/browser-use-codex-parity-coverage-matrix.md:108-111`
- Modify: `packages/shared/src/platform.ts:52-68`
- Modify: `packages/shared/src/platform.ts:535-566`
- Modify: `packages/shared/src/channels.ts:202-212`
- Modify: `packages/shared/src/channels.ts:626-655`
- Modify: `packages/desktop/src/preload/index.ts:20-35`
- Modify: `packages/desktop/src/preload/index.ts:364-432`
- Modify: `packages/desktop/src/renderer/src/main.tsx:215-230`
- Test: `packages/desktop/test/preloadDisposer.test.ts`

**Interfaces:**
- Consumes: 既有 `BrowserViewOperationPayload`、`BrowserViewportSize`、`IPlatformService`、`PlatformChannels`。
- Produces:

```ts
export interface BrowserViewScreenshotSurfacePreparePayload
  extends BrowserViewOperationPayload {
  requestId: string;
  webContentsId: number;
  viewport: BrowserViewportSize;
  timeoutMs?: number;
}

export interface BrowserViewScreenshotSurfaceReadyPayload
  extends BrowserViewScreenshotSurfacePreparePayload {}

export type BrowserViewScreenshotSurfaceReleasePayload = Omit<
  BrowserViewScreenshotSurfacePreparePayload,
  "viewport" | "timeoutMs"
>;
```

`IPlatformService` 新增：

```ts
onBrowserViewScreenshotSurfacePrepare?(
  handler: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
): () => void;
onBrowserViewScreenshotSurfaceRelease?(
  handler: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
): () => void;
browserViewScreenshotSurfaceReady?(
  payload: BrowserViewScreenshotSurfaceReadyPayload,
): void;
```

- [ ] **Step 1: 先在覆盖矩阵写入失败前的产品合同**

在 `docs/testing/browser-use-codex-parity-coverage-matrix.md` 的 BCP-208 后加入：

```markdown
| BCP-213 | 后台 browser-use 截图合成表面 | inactive `<webview>` 截图前必须在 owner renderer 的后台 capture layer 完成当前 CSS viewport 合成；不切 tab、不抢焦点；ready 前和 prepare 失败后禁止 `Page.captureScreenshot`；成功、异常、取消和 late settle 均幂等 release；四角 sentinel 不得出现旧 `800 × 450` surface 的周期重复 | 自动化：shared/preload/main IPC + coordinator/manager/UI component；真实 Electron compositor smoke |
```

- [ ] **Step 2: 写 preload bridge 的失败测试**

在 `packages/desktop/test/preloadDisposer.test.ts` 增加：

```ts
it("browser screenshot surface bridge 转发 prepare/release，并用 send 上报 ready", async () => {
  const api = await loadPreload();
  const prepare = vi.fn();
  const release = vi.fn();
  const disposePrepare = api.onBrowserViewScreenshotSurfacePrepare(prepare) as () => void;
  const disposeRelease = api.onBrowserViewScreenshotSurfaceRelease(release) as () => void;
  const payload = {
    requestId: "shot-1",
    workspaceKey: "remote:ssh:dev:/repo",
    sessionId: "sess-1",
    browserId: "browser-1",
    browserGeneration: 3,
    tabId: "tab-1",
    webContentsId: 42,
    viewport: { width: 1274, height: 720 },
  };

  for (const handler of listeners.get(PlatformChannels.BrowserViewScreenshotSurfacePrepare) ?? []) {
    handler({}, payload);
  }
  const { viewport: _viewport, ...releasePayload } = payload;
  for (const handler of listeners.get(PlatformChannels.BrowserViewScreenshotSurfaceRelease) ?? []) {
    handler({}, releasePayload);
  }
  api.browserViewScreenshotSurfaceReady(payload);

  expect(prepare).toHaveBeenCalledWith(payload);
  expect(release).toHaveBeenCalledWith(expect.objectContaining({ requestId: "shot-1" }));
  expect(mockIpcSend).toHaveBeenCalledWith(
    PlatformChannels.BrowserViewScreenshotSurfaceReady,
    payload,
  );

  disposePrepare();
  disposeRelease();
  expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
    PlatformChannels.BrowserViewScreenshotSurfacePrepare,
    expect.any(Function),
  );
  expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
    PlatformChannels.BrowserViewScreenshotSurfaceRelease,
    expect.any(Function),
  );
});
```

- [ ] **Step 3: 运行测试，确认合同尚不存在**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/preloadDisposer.test.ts -t "browser screenshot surface bridge"
```

Expected: FAIL，错误包含 `BrowserViewScreenshotSurfacePrepare` 或 `api.onBrowserViewScreenshotSurfacePrepare is not a function`。

- [ ] **Step 4: 增加 shared payload、频道和 IPC contract**

在 `packages/shared/src/platform.ts` 紧随 `BrowserViewViewportChangedPayload` 加入本任务 `Interfaces` 中的三个类型，并在 `IPlatformService` 的 BrowserView 方法区加入三个方法。

在 `packages/shared/src/channels.ts` 增加：

```ts
/** Main → Renderer：截图前请求 owner renderer 准备后台 guest 合成表面。 */
BrowserViewScreenshotSurfacePrepare: "zcode:browser-view-screenshot-surface-prepare",
/** Renderer → Main：目标 guest 连续两个 animation frame 的 viewport 已稳定。 */
BrowserViewScreenshotSurfaceReady: "zcode:browser-view-screenshot-surface-ready",
/** Main → Renderer：截图结束或准备失败，释放临时后台合成层。 */
BrowserViewScreenshotSurfaceRelease: "zcode:browser-view-screenshot-surface-release",
```

并在 `PlatformIpcContract` 加入：

```ts
[PlatformChannels.BrowserViewScreenshotSurfacePrepare]: {
  request: BrowserViewScreenshotSurfacePreparePayload;
  response: void;
};
[PlatformChannels.BrowserViewScreenshotSurfaceReady]: {
  request: BrowserViewScreenshotSurfaceReadyPayload;
  response: void;
};
[PlatformChannels.BrowserViewScreenshotSurfaceRelease]: {
  request: BrowserViewScreenshotSurfaceReleasePayload;
  response: void;
};
```

- [ ] **Step 5: 实现 preload 和 renderer platform adapter**

在 `packages/desktop/src/preload/index.ts` 导入三个 payload type，并在 `exposeInMainWorld("zcode", …)` 中加入：

```ts
onBrowserViewScreenshotSurfacePrepare: (
  callback: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
): (() => void) => {
  const handler = (_event: unknown, payload: BrowserViewScreenshotSurfacePreparePayload) =>
    callback(payload);
  ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
  return () =>
    ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
},
onBrowserViewScreenshotSurfaceRelease: (
  callback: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
): (() => void) => {
  const handler = (_event: unknown, payload: BrowserViewScreenshotSurfaceReleasePayload) =>
    callback(payload);
  ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
  return () =>
    ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
},
browserViewScreenshotSurfaceReady: (payload: BrowserViewScreenshotSurfaceReadyPayload): void => {
  ipcRenderer.send(PlatformChannels.BrowserViewScreenshotSurfaceReady, payload);
},
```

在 `packages/desktop/src/renderer/src/main.tsx` 的 platform adapter 加入：

```ts
onBrowserViewScreenshotSurfacePrepare: (handler) =>
  window.zcode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
onBrowserViewScreenshotSurfaceRelease: (handler) =>
  window.zcode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
browserViewScreenshotSurfaceReady: (payload) =>
  window.zcode.browserViewScreenshotSurfaceReady?.(payload),
```

- [ ] **Step 6: 运行 bridge 测试和 shared/desktop typecheck**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/preloadDisposer.test.ts
pnpm exec tsc -p packages/desktop/tsconfig.json --noEmit
```

Expected: preload suite PASS；TypeScript 不再报告新频道或 `window.zcode` 方法缺失。

- [ ] **Step 7: 提交平台合同**

```powershell
git add docs/testing/browser-use-codex-parity-coverage-matrix.md packages/shared/src/platform.ts packages/shared/src/channels.ts packages/desktop/src/preload/index.ts packages/desktop/src/renderer/src/main.tsx packages/desktop/test/preloadDisposer.test.ts
git commit -m "feat(browser-use): add screenshot surface IPC contract"
```

Expected: commit 成功，且不包含并发 crash-recovery 任务的文件。

---

### Task 2: Main 侧截图表面协调器与可信 ready 入口

**Files:**
- Create: `packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts`
- Create: `packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts`
- Modify: `packages/desktop/src/main/desktopBrowserViewIpc.ts:1-65`
- Modify: `packages/desktop/src/main/desktopMainIpcPlatform.ts:35-90`
- Modify: `packages/desktop/test/desktopBrowserViewIpc.test.ts`

**Interfaces:**
- Consumes: Task 1 的三个 payload、Electron sender `webContents.id`、可信 `BrowserWindow.fromWebContents(event.sender)`。
- Produces:

```ts
export interface BrowserScreenshotSurfaceLease {
  webContentsId: number;
  viewport: BrowserViewportSize;
  release(): void;
}

export interface BrowserScreenshotSurfaceCoordinator {
  prepare(input: {
    requestId: string;
    windowId: number;
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    webContentsId: number;
    viewport: BrowserViewportSize;
    signal: AbortSignal;
  }): Promise<BrowserScreenshotSurfaceLease>;
}

export class DesktopBrowserScreenshotSurfaceCoordinator
  implements BrowserScreenshotSurfaceCoordinator {
  constructor(options: {
    timeoutMs?: number;
    sendPrepare(windowId: number, payload: BrowserViewScreenshotSurfacePreparePayload): boolean;
    sendRelease(windowId: number, payload: BrowserViewScreenshotSurfaceReleasePayload): void;
    log?(message: string): void;
  });
  handleReady(input: {
    windowId: number;
    senderWebContentsId: number;
    payload: BrowserViewScreenshotSurfaceReadyPayload;
  }): void;
  handleWindowDestroyed(windowId: number): void;
  dispose(): void;
}
```

`desktopBrowserViewIpc.ts` 新增：

```ts
export type ReportBrowserScreenshotSurfaceReady = (
  windowId: number,
  senderWebContentsId: number,
  payload: BrowserViewScreenshotSurfaceReadyPayload,
) => void;
```

- [ ] **Step 1: 写协调器状态机的失败测试**

创建 `packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts`，覆盖：

```ts
import { describe, expect, it, vi } from "vitest";
import { DesktopBrowserScreenshotSurfaceCoordinator } from "../src/main/browserView/browserScreenshotSurfaceCoordinator.js";

const input = {
  requestId: "shot-1",
  windowId: 7,
  workspaceKey: "remote:ssh:dev:/repo",
  sessionId: "sess-1",
  browserId: "browser-1",
  browserGeneration: 4,
  tabId: "tab-1",
  webContentsId: 42,
  viewport: { width: 1274, height: 720 },
};

describe("DesktopBrowserScreenshotSurfaceCoordinator", () => {
  it("只接受同 window/sender/request/guest 且 viewport 误差不超过 1px 的 ready", async () => {
    const sendPrepare = vi.fn(() => true);
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare,
      sendRelease,
      timeoutMs: 100,
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    coordinator.handleReady({
      windowId: 7,
      senderWebContentsId: 700,
      payload: { ...input, viewport: { width: 1275, height: 719 } },
    });

    const lease = await pending;
    expect(lease).toMatchObject({
      webContentsId: 42,
      viewport: { width: 1275, height: 719 },
    });
    lease.release();
    lease.release();
    expect(sendRelease).toHaveBeenCalledTimes(1);
  });

  it("默认 3000ms timeout 会 release，迟到 ready 不能复活请求", async () => {
    vi.useFakeTimers();
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare: () => true,
      sendRelease,
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).rejects.toThrow("timed out");
    coordinator.handleReady({
      windowId: 7,
      senderWebContentsId: 700,
      payload: input,
    });
    expect(sendRelease).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
```

还要在同文件加入三个独立 `it`：错误 sender/window 被忽略；第一次 viewport mismatch 后第二次 ready 可成功；`handleWindowDestroyed` 和 `dispose` 都拒绝 pending 并只 release 一次。

- [ ] **Step 2: 写可信 renderer ready IPC 的失败测试**

在 `packages/desktop/test/desktopBrowserViewIpc.test.ts` 增加：

```ts
it("只把可信 sender window 的 screenshot surface ready 交给协调器", async () => {
  const reportReady = vi.fn();
  const sender = { id: 700 };
  h.fromWebContents.mockReturnValue({ id: 17, isDestroyed: () => false });
  const { registerBrowserViewIpcHandlers } =
    await import("../src/main/desktopBrowserViewIpc.js");
  registerBrowserViewIpcHandlers(undefined, undefined, reportReady);
  const handler = h.listeners.get(PlatformChannels.BrowserViewScreenshotSurfaceReady);
  const payload = {
    requestId: "shot-1",
    workspaceKey: "workspace-1",
    sessionId: "sess-1",
    browserId: "browser-1",
    browserGeneration: 2,
    tabId: "tab-1",
    webContentsId: 42,
    viewport: { width: 1274, height: 720 },
  };

  handler?.({ sender }, payload);

  expect(reportReady).toHaveBeenCalledWith(17, 700, payload);
});
```

同时把该测试的 Electron mock 扩展为：

```ts
listeners: new Map<string, IpcHandler>(),
ipcMain: {
  handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
  on: vi.fn((channel: string, handler: IpcHandler) => h.listeners.set(channel, handler)),
},
```

- [ ] **Step 3: 运行两个测试，确认文件和 IPC 入口尚不存在**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts packages/desktop/test/desktopBrowserViewIpc.test.ts
```

Expected: FAIL，至少包含
`Cannot find module '../src/main/browserView/browserScreenshotSurfaceCoordinator.js'`。

- [ ] **Step 4: 实现协调器最小状态机**

创建 `packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts`。核心实现必须使用一个 `pendingByRequestId`，并统一通过 `finishError` / `finishReady` 清理 timer 和 abort listener：

```ts
import { BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS } from "@zcode/shared";

const DEFAULT_SCREENSHOT_SURFACE_TIMEOUT_MS =
  BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS;
const VIEWPORT_TOLERANCE_PX = 1;

function sameViewport(
  expected: BrowserViewportSize,
  actual: BrowserViewportSize,
): boolean {
  return (
    Math.abs(expected.width - actual.width) <= VIEWPORT_TOLERANCE_PX &&
    Math.abs(expected.height - actual.height) <= VIEWPORT_TOLERANCE_PX
  );
}

function releaseOnce(callback: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    callback();
  };
}
```

`prepare` 必须：

1. 先注册 pending，再调用 `sendPrepare`，防止同步 fake ready 丢失；
2. `sendPrepare=false`、timeout、abort、window destroyed、dispose 都调用同一个幂等 release；
3. abort 错误消息固定为 `browser screenshot surface preparation cancelled`；
4. timeout 错误消息格式固定为
   `browser screenshot surface preparation timed out after ${timeoutMs}ms`，其中数值取 coordinator
   当前实际 `timeoutMs`，默认消息为
   `browser screenshot surface preparation timed out after 3000ms`；
5. viewport mismatch 只记 debug 并继续等待同 request 的下一次 ready，不提前 release。

`handleReady` 必须逐项比较：

```ts
entry.windowId === input.windowId
entry.senderWebContentsId === undefined || entry.senderWebContentsId === input.senderWebContentsId
entry.payload.requestId === input.payload.requestId
entry.payload.workspaceKey === input.payload.workspaceKey
entry.payload.sessionId === input.payload.sessionId
entry.payload.browserId === input.payload.browserId
entry.payload.browserGeneration === input.payload.browserGeneration
entry.payload.tabId === input.payload.tabId
entry.payload.webContentsId === input.payload.webContentsId
sameViewport(entry.payload.viewport, input.payload.viewport)
```

第一次可信 ready 将 `senderWebContentsId` 冻结为当前 sender；后续来自其他 renderer 的 ready 必须忽略。

- [ ] **Step 5: 注册可信 ready IPC 并传入 platform handler**

在 `packages/desktop/src/main/desktopBrowserViewIpc.ts`：

```ts
ipcMain.on(
  PlatformChannels.BrowserViewScreenshotSurfaceReady,
  (event, payload: BrowserViewScreenshotSurfaceReadyPayload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    reportBrowserScreenshotSurfaceReady?.(win.id, event.sender.id, payload);
  },
);
```

把 `reportBrowserScreenshotSurfaceReady` 作为 `registerBrowserViewIpcHandlers` 和 `registerDesktopBrowserIpcHandlers` 的第三个可选参数。

在 `packages/desktop/src/main/desktopMainIpcPlatform.ts` 的 options 加入同名 callback，并传给 `registerDesktopBrowserIpcHandlers`。

- [ ] **Step 6: 运行协调器与 IPC 测试**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts packages/desktop/test/desktopBrowserViewIpc.test.ts
```

Expected: 两个 suite 全部 PASS；fake timer 测试退出时没有未处理 rejection。

- [ ] **Step 7: 提交协调器**

```powershell
git add packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts packages/desktop/src/main/desktopBrowserViewIpc.ts packages/desktop/src/main/desktopMainIpcPlatform.ts packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts packages/desktop/test/desktopBrowserViewIpc.test.ts
git commit -m "feat(browser-use): coordinate screenshot surfaces"
```

---

### Task 3: BrowserGuestManager 截图前门禁

**Files:**
- Modify: `packages/desktop/src/main/browserView/browserGuestManager.ts:18-115`
- Modify: `packages/desktop/src/main/browserView/browserGuestManager.ts:220-252`
- Modify: `packages/desktop/src/main/browserView/browserGuestManager.ts:808-860`
- Modify: `packages/desktop/src/main/index.ts:237-285`
- Modify: `packages/desktop/src/main/index.ts:1726-1745`
- Test: `packages/desktop/test/browserGuestManager.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `BrowserScreenshotSurfaceCoordinator` 和 `BrowserScreenshotSurfaceLease`。
- Produces: `BrowserGuestManager` constructor 第七个可选依赖：

```ts
constructor(
  log?: (msg: string) => void,
  attachTimeoutMs?: number,
  onCloseTabRequested?: (
    tabId: string,
    owner?: BrowserGuestExecutionContext,
  ) => void,
  onOpenTabRequested?: (
    tabId: string,
    owner: BrowserGuestExecutionContext,
  ) => void,
  onVisibilityChanged?: (
    visible: boolean,
    owner: BrowserGuestExecutionContext,
    tabId?: string,
  ) => void,
  onViewportChanged?: (
    viewport: BrowserViewportSize | null,
    owner: BrowserGuestExecutionContext,
    tabId: string,
  ) => void,
  screenshotSurfaceCoordinator?: BrowserScreenshotSurfaceCoordinator,
)
```

`GuestWebContents` 新增只读 `id: number`。

- [ ] **Step 1: 为 guest fake 增加真实 id，并写调用顺序失败测试**

把 `makeGuest` 改为 `makeGuest(id: number, spy: GuestSpy)`，返回对象首字段加入 `id`；`registerGuest` 改为 `makeGuest(id, spy)`。

在 `packages/desktop/test/browserGuestManager.test.ts` 加入：

```ts
it("background screenshot 必须 prepare ready 后才进入 CDP，并在 settle 后 release", async () => {
  registerGuest(209);
  const order: string[] = [];
  const release = vi.fn(() => order.push("release"));
  const coordinator = {
    prepare: vi.fn(async (input: {
      webContentsId: number;
      viewport: { width: number; height: number };
    }) => {
      order.push("prepare");
      expect(input.webContentsId).toBe(209);
      expect(input.viewport).toEqual({ width: 800, height: 600 });
      return {
        webContentsId: 209,
        viewport: { width: 800, height: 600 },
        release,
      };
    }),
  };
  const guest = guestRegistry.get(209)!;
  const sendCommand = guest.debugger.sendCommand;
  guest.debugger.sendCommand = async (method, params) => {
    if (method === "Page.captureScreenshot") order.push("capture");
    return sendCommand(method, params);
  };
  const mgr = new BrowserGuestManager(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    coordinator,
  );
  mgr.attachGuest("tab-209", 209);

  await expect(mgr.execute("tab-209", { method: "screenshot" })).resolves.toMatchObject({
    ok: true,
    image: { base64: "PNGDATA" },
  });

  expect(order).toEqual(["prepare", "capture", "release"]);
});
```

测试还要用 `expect.objectContaining` 断言 coordinator 收到 legacy context 的
`requestId`、`windowId=0`、`tabId="tab-209"` 和 `signal: expect.any(AbortSignal)`。

- [ ] **Step 2: 写 prepare failure/abort/guest replacement 的失败测试**

新增三个 `it`：

```ts
it("prepare 失败时返回 backend_unavailable 且不调用 Page.captureScreenshot", async () => {
  const { spy } = registerGuest(210);
  const coordinator = {
    prepare: vi.fn(async () => {
      throw new Error("surface unavailable");
    }),
  };
  const mgr = new BrowserGuestManager(
    undefined, undefined, undefined, undefined, undefined, undefined, coordinator,
  );
  mgr.attachGuest("tab-210", 210);
  await expect(mgr.execute("tab-210", { method: "screenshot" })).resolves.toMatchObject({
    ok: false,
    error: { code: "backend_unavailable", sideEffect: "none" },
  });
  expect(spy.cdpCalls.some((call) => call.method === "Page.captureScreenshot")).toBe(false);
});

it("prepare 期间 abort 返回 cancelled，协调器收到同一 signal", async () => {
  registerGuest(211);
  let observedSignal: AbortSignal | undefined;
  const coordinator = {
    prepare: vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    ),
  };
  const mgr = new BrowserGuestManager(
    undefined, undefined, undefined, undefined, undefined, undefined, coordinator,
  );
  mgr.attachGuest("tab-211", 211);
  const controller = new AbortController();
  const pending = mgr.execute("tab-211", { method: "screenshot" }, controller.signal);
  await vi.waitFor(() => expect(observedSignal).toBeDefined());
  controller.abort();
  await expect(pending).resolves.toMatchObject({
    ok: false,
    error: { code: "cancelled", sideEffect: "none" },
  });
});
```

guest replacement 测试在 `prepare` pending 时重新 `attachGuest(tabId, newId)`，再 resolve 旧 lease；期望旧 lease `release` 一次，且两个 guest 都没有 `Page.captureScreenshot`。

- [ ] **Step 3: 运行 manager screenshot tests，确认尚未调用 coordinator**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/browserGuestManager.test.ts -t "screenshot|prepare"
```

Expected: 新测试 FAIL，顺序里缺少 `prepare`，或 constructor 不接受 coordinator。

- [ ] **Step 4: 把 screenshot backend 包进 prepare 生命周期**

在 `browserGuestManager.ts` 导入接口，给 `GuestWebContents` 增加 `id`，并新增私有方法：

```ts
private async executeScreenshotWithPreparedSurface(
  context: InternalExecutionContext,
  tab: ManagedTab,
  guest: GuestWebContents,
  command: BrowserCommand,
  running: RunningRequest,
  startedAt: number,
): Promise<BrowserCommandResult> {
  let lease: BrowserScreenshotSurfaceLease | undefined;
  try {
    if (!this.screenshotSurfaceCoordinator) {
      throw new Error("browser screenshot surface coordinator is unavailable");
    }
    const viewport = await this.readTabViewport(tab);
    lease = await this.screenshotSurfaceCoordinator.prepare({
      requestId: context.requestId,
      windowId: context.windowId,
      workspaceKey: context.workspaceKey,
      sessionId: context.sessionId,
      browserId: context.browserId,
      browserGeneration: context.browserGeneration,
      tabId: tab.tabId,
      webContentsId: guest.id,
      viewport,
      signal: running.controller.signal,
    });
    if (
      running.controller.signal.aborted ||
      tab.guest !== guest ||
      guest.isDestroyed() ||
      lease.webContentsId !== guest.id
    ) {
      throw new Error("browser guest changed while preparing screenshot surface");
    }
    running.dispatched = true;
    return await executeBrowserCommandOnView(this.toControlledView(guest), command, {
      signal: running.controller.signal,
    });
  } catch (error) {
    const cancelled = running.controller.signal.aborted;
    return {
      ok: false,
      error: {
        code: cancelled ? "cancelled" : "backend_unavailable",
        message: cancelled
          ? "browser screenshot surface preparation cancelled"
          : error instanceof Error
            ? error.message
            : String(error),
        sideEffect: "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    lease?.release();
  }
}
```

Bugfix 中文注释放在该方法上方，明确说明：inactive `display:none` 令 Electron 保留旧 compositor surface，CDP 会按新 viewport 平铺旧 surface，因此必须在 capture 前等待 renderer ACK，不能靠图片裁剪兜底。

在原 screenshot 分支中：

```ts
const execution = screenshotCommand
  ? this.executeScreenshotWithPreparedSurface(
      context,
      tab,
      guest,
      command,
      running,
      startedAt,
    )
  : executeBrowserCommandOnView(this.toControlledView(guest), command, {
      signal: running.controller.signal,
    });
if (!screenshotCommand) running.dispatched = true;
```

`inFlightScreenshots` 继续跟踪这个包含 prepare + CDP + release 的真实 `execution`，外层 `raceBackendExecution` 不得在 cancel 时提前删除它。

- [ ] **Step 5: 更新既有 screenshot/backpressure 测试 fake**

给现有“显式 screenshot”和“截图取消后保留底层 in-flight”测试注入：

```ts
function createReadyScreenshotSurfaceCoordinator() {
  return {
    prepare: vi.fn(async (input: { webContentsId: number; viewport: BrowserViewportSize }) => ({
      webContentsId: input.webContentsId,
      viewport: input.viewport,
      release: vi.fn(),
    })),
  };
}
```

backpressure 测试额外断言：第一次 outer abort 后 lease 尚未 release；底层 `Page.captureScreenshot` resolve 后才 release；第二次 capture 仍被拒绝；late settle 后第三次恢复。

- [ ] **Step 6: 在 desktop main 创建并注入真实协调器**

在 `packages/desktop/src/main/index.ts` 的 `BrowserGuestManager` 之前创建：

```ts
const browserScreenshotSurfaceCoordinator =
  new DesktopBrowserScreenshotSurfaceCoordinator({
    sendPrepare: (windowId, payload) => {
      const win = BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) return false;
      win.webContents.send(PlatformChannels.BrowserViewScreenshotSurfacePrepare, payload);
      return true;
    },
    sendRelease: (windowId, payload) => {
      const win = BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) return;
      win.webContents.send(PlatformChannels.BrowserViewScreenshotSurfaceRelease, payload);
    },
    log: (message) => logger.debug(message),
  });
```

作为 `BrowserGuestManager` 第七个参数传入。在 `registerPlatformIpcHandlers` options 加入：

```ts
reportBrowserScreenshotSurfaceReady: (windowId, senderWebContentsId, payload) =>
  browserScreenshotSurfaceCoordinator.handleReady({
    windowId,
    senderWebContentsId,
    payload,
  }),
```

在窗口销毁的既有生命周期出口调用 `handleWindowDestroyed(win.id)`；在 app quit 的统一清理出口调用 `dispose()`，不得为此新增第二套窗口生命周期监听。

- [ ] **Step 7: 运行 manager、IPC 和 executor 回归**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/browserGuestManager.test.ts packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts packages/desktop/test/desktopBrowserViewIpc.test.ts packages/desktop/test/browserCommandExecutor.test.ts
```

Expected: 全部 PASS；既有 screenshot、clip、fullPage、elementScreenshot 和 in-flight backpressure 断言不变。

- [ ] **Step 8: 提交 main 门禁**

```powershell
git add packages/desktop/src/main/browserView/browserGuestManager.ts packages/desktop/src/main/index.ts packages/desktop/test/browserGuestManager.test.ts
git commit -m "fix(browser-use): gate screenshots on compositor readiness"
```

---

### Task 4: Renderer 后台 capture layer 与稳定帧 ACK

**Files:**
- Create: `packages/ui/src/browser-use/BrowserUseSidePaneContent.tsx`
- Create: `packages/ui/src/browser-use/useBrowserScreenshotSurfaceRequest.ts`
- Create: `packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts`
- Create: `packages/ui/test/BrowserUseSidePaneContent.test.ts`
- Modify: `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:910-1160`
- Modify: `packages/ui/src/browser-use/UnifiedBrowserView.tsx:1-70`
- Modify: `packages/ui/src/browser-use/UnifiedBrowserView.tsx:560-640`
- Modify: `packages/ui/test/UnifiedBrowserView.test.ts`

**Interfaces:**
- Consumes: Task 1 的 prepare/release payload；现有 `BrowserUseSidePaneTab`、`UnifiedBrowserView`、Radix `TabsContent`。
- Produces:

```ts
export interface BrowserUseSidePaneContentProps {
  tab: BrowserUseSidePaneTab;
  isPanelVisible: boolean;
  isSelected: boolean;
  screenshotSurfaceRequest: BrowserViewScreenshotSurfacePreparePayload | null;
  initialUrl?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  onUrlChange(url: string): void;
  onPageMetadataChange(metadata: BrowserSidePaneMetadata): void;
}
```

`UnifiedBrowserView` 新增：

```ts
screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
```

`useBrowserScreenshotSurfaceRequest`：

```ts
export function useBrowserScreenshotSurfaceRequest(
  tabs: readonly WorkspaceSidePaneTab[],
): BrowserViewScreenshotSurfacePreparePayload | null;
```

`useBrowserScreenshotSurfaceReady`：

```ts
export function useBrowserScreenshotSurfaceReady(options: {
  request: BrowserViewScreenshotSurfacePreparePayload | null;
  webview: ElectronWebviewTag | null;
}): void;
```

- [ ] **Step 1: 写 capture-layer 状态的失败组件测试**

创建 `packages/ui/test/BrowserUseSidePaneContent.test.ts`（`@vitest-environment jsdom`，用 `createElement` 而非 JSX）。mock `usePlatform`、`UnifiedBrowserView`，保存 prepare/release listeners，然后：

```ts
it("inactive browser-use prepare 时进入底层 capture layer，但不改变 active tab 或焦点", () => {
  const userInput = document.createElement("input");
  document.body.append(userInput);
  userInput.focus();
  const browserUseTab: BrowserUseSidePaneTab = {
    id: "browser-use:tab-1",
    type: "browser-use",
    ownerTaskId: "sess-1",
    workspaceKey: "workspace-1",
    sessionId: "sess-1",
    tabId: "tab-1",
    browserId: "browser-1",
    browserGeneration: 2,
  };
  const view = render(
    createElement(
      Tabs,
      { value: "active-tab" },
      createElement(TabsContent, { value: "active-tab" }, "active"),
      createElement(BrowserUseSidePaneContent, {
        tab: browserUseTab,
        isPanelVisible: true,
        isSelected: false,
        screenshotSurfaceRequest: preparePayload,
        workspacePath: "C:\\repo",
        onUrlChange: vi.fn(),
        onPageMetadataChange: vi.fn(),
      }),
    ),
  );

  const content = view.container.querySelector(
    '[data-browser-screenshot-surface-state="preparing"]',
  );
  expect(content).not.toBeNull();
  expect(content).toHaveClass("absolute", "inset-0", "pointer-events-none");
  expect(content).not.toHaveClass("hidden");
  expect(content).toHaveAttribute("inert");
  expect(content).toHaveAttribute("aria-hidden", "true");
  expect(document.activeElement).toBe(userInput);
  expect(view.container.querySelector('[data-state="active"]')).toHaveTextContent("active");

  view.rerender(
    createElement(
      Tabs,
      { value: "active-tab" },
      createElement(TabsContent, { value: "active-tab" }, "active"),
      createElement(BrowserUseSidePaneContent, {
        tab: browserUseTab,
        isPanelVisible: true,
        isSelected: false,
        screenshotSurfaceRequest: null,
        workspacePath: "C:\\repo",
        onUrlChange: vi.fn(),
        onPageMetadataChange: vi.fn(),
      }),
    ),
  );
  expect(
    view.container.querySelector('[data-browser-use-tab-id="tab-1"]'),
  ).toHaveClass("hidden");
});
```

同文件用 hook harness 覆盖 `useBrowserScreenshotSurfaceRequest`：workspace/session/browser/
generation/tab 任一不匹配时返回 `null`；旧 request 的 release 不能清掉新 request；不同
request 仍 active 时不能覆盖；当前对话没有 visible tab 时 prepare 仍会进入根层状态。

- [ ] **Step 2: 写稳定两帧和 guest id 门禁失败测试**

在 `packages/ui/test/UnifiedBrowserView.test.ts` 的 hoisted platform 加：

```ts
const screenshotSurfaceReady = vi.fn();
browserViewScreenshotSurfaceReady: screenshotSurfaceReady,
```

使用可手动推进的 RAF queue，并让 fake webview：

```ts
Object.defineProperties(el, {
  offsetWidth: { configurable: true, value: 1274 },
  offsetHeight: { configurable: true, value: 720 },
});
vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 1274,
  bottom: 720,
  width: 1274,
  height: 720,
  toJSON: () => ({}),
});
```

新增测试：

```ts
it("后台 surface 连续两个稳定 frame 后才 ready，并回传当前 guest id", () => {
  const request = createScreenshotSurfaceRequest({ webContentsId: 42 });
  render(createViewElement("tab-1", "sess-1", undefined, false, undefined, request));
  const webview = stubWebview(screen.getByTestId(TID_BROWSER_WEBVIEW));
  fireDomReady(webview);
  FakeResizeObserver.instances.at(-1)?.emit(1274, 720);

  flushOneAnimationFrame();
  expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
  flushOneAnimationFrame();
  expect(h.screenshotSurfaceReady).toHaveBeenCalledWith({
    ...request,
    viewport: { width: 1274, height: 720 },
  });
});
```

再加三个 case：`getWebContentsId() !== request.webContentsId` 不 ready；第一帧 `1274×719`、第二帧 `1274×720` 时继续等下一组稳定帧；request 清除/unmount 后取消 observer 和 pending RAF。

- [ ] **Step 3: 运行两个 UI 测试，确认组件/hook 尚不存在**

Run:

```powershell
pnpm exec vitest run packages/ui/test/BrowserUseSidePaneContent.test.ts packages/ui/test/UnifiedBrowserView.test.ts
```

Expected: FAIL，包含
`Cannot find module '@/browser-use/BrowserUseSidePaneContent.js'` 或新 prop/ready 未生效。

- [ ] **Step 4: 实现稳定帧 hook**

创建 `packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts`。尺寸读取必须同时兼容自然 viewport 和已有 responsive transform：

```ts
function roundViewport(width: number, height: number): BrowserViewportSize | null {
  const viewport = { width: Math.round(width), height: Math.round(height) };
  return viewport.width > 0 && viewport.height > 0 ? viewport : null;
}

function withinOnePixel(left: BrowserViewportSize, right: BrowserViewportSize): boolean {
  return (
    Math.abs(left.width - right.width) <= 1 &&
    Math.abs(left.height - right.height) <= 1
  );
}

function readSurfaceViewport(
  webview: ElectronWebviewTag,
  expected: BrowserViewportSize,
): BrowserViewportSize | null {
  const rect = webview.getBoundingClientRect();
  const transformed = roundViewport(rect.width, rect.height);
  const layout = roundViewport(webview.offsetWidth, webview.offsetHeight);
  if (transformed && withinOnePixel(transformed, expected)) return transformed;
  if (layout && withinOnePixel(layout, expected)) return layout;
  return transformed ?? layout;
}
```

effect 流程固定为：

```ts
useEffect(() => {
  if (!request || !webview) return;
  if (safeWebviewCall(() => webview.getWebContentsId(), 0) !== request.webContentsId) return;

  let disposed = false;
  let firstFrame: BrowserViewportSize | null = null;
  let rafId = 0;
  const verify = () => {
    rafId = window.requestAnimationFrame(() => {
      const current = readSurfaceViewport(webview, request.viewport);
      if (!current || !withinOnePixel(current, request.viewport)) return;
      if (!firstFrame || !withinOnePixel(firstFrame, current)) {
        firstFrame = current;
        verify();
        return;
      }
      if (disposed) return;
      platform.browserViewScreenshotSurfaceReady?.({ ...request, viewport: current });
    });
  };
  const observer = new ResizeObserver(() => {
    firstFrame = null;
    window.cancelAnimationFrame(rafId);
    verify();
  });
  observer.observe(webview);
  verify();
  return () => {
    disposed = true;
    observer.disconnect();
    window.cancelAnimationFrame(rafId);
  };
}, [platform, request, webview]);
```

最终实现把 `safeWebviewCall` 作为显式 import，并用 `logger.debug` 记录 mismatch/ready；禁止记录 URL。上述递归必须在 mismatch 时保持 observer 活跃，后续 resize 可重新触发，不得无限 RAF 自旋。

- [ ] **Step 5: 在侧栏根层实现完整 scope request 状态机**

创建 `packages/ui/src/browser-use/useBrowserScreenshotSurfaceRequest.ts`：

```ts
export function findScreenshotSurfaceTab(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return tabs.find(
    (tab): tab is BrowserUseSidePaneTab =>
      tab.type === "browser-use" && matchesTab(tab, payload),
  );
}

function matchesTab(
  tab: BrowserUseSidePaneTab,
  payload: BrowserViewScreenshotSurfacePreparePayload,
): boolean {
  return (
    tab.workspaceKey === payload.workspaceKey &&
    tab.sessionId === payload.sessionId &&
    tab.browserId === payload.browserId &&
    tab.browserGeneration === payload.browserGeneration &&
    tab.tabId === payload.tabId
  );
}
```

hook 使用 `usePlatform()` 订阅 prepare/release，并用一个 local state 保存当前 request。
prepare 仅在 `findScreenshotSurfaceTab(tabs, payload)` 命中时设置 request；若已有不同
`requestId` 正在准备，保留旧 request 并 debug 记录冲突。release 必须 full scope 匹配且
`requestId` 相同才清除。

创建 `BrowserUseSidePaneContent.tsx`。组件不订阅 IPC，只消费侧栏根层已匹配的
`screenshotSurfaceRequest` 并渲染：

```tsx
<TabsContent
  value={tab.id}
  forceMount
  aria-hidden={!isSelected}
  inert={!isSelected ? true : undefined}
  data-browser-use-tab-id={tab.tabId}
  data-browser-screenshot-surface-state={
    screenshotSurfaceRequest ? "preparing" : undefined
  }
  className={cn(
    "h-full min-h-0 bg-background",
    isSelected
      ? "relative z-10 flex"
      : screenshotSurfaceRequest
        ? "pointer-events-none absolute inset-0 z-0 flex overflow-hidden"
        : "hidden",
  )}
>
  <UnifiedBrowserView
    browserKey={tab.tabId}
    isVisible={isPanelVisible && isSelected}
    screenshotSurfaceRequest={screenshotSurfaceRequest}
    initialUrl={initialUrl}
    workspacePath={workspacePath}
    workspaceIdentity={workspaceIdentity}
    sessionId={tab.sessionId}
    browserUseOperationUntil={tab.browserUseOperationUntil}
    browserResizeBaselineVersion={tab.browserUseResizeBaselineVersion}
    onUrlChange={onUrlChange}
    onPageMetadataChange={onPageMetadataChange}
  />
</TabsContent>
```

- [ ] **Step 6: 把侧栏内容改为显式 stacking context**

在 `AnimatedSidePanePanel.tsx` 的 `tabs`/`visibleTabs` 后调用：

```ts
const screenshotSurfaceRequest = useBrowserScreenshotSurfaceRequest(tabs);
const screenshotSurfaceTab = screenshotSurfaceRequest
  ? findScreenshotSurfaceTab(tabs, screenshotSurfaceRequest)
  : undefined;
```

原来“当前对话没有 visible tab 就隐藏 Tabs”的条件改为：

```tsx
<div
  className={cn(
    "h-full min-h-0",
    visibleTabs.length === 0 && !screenshotSurfaceRequest && "hidden",
  )}
>
```

这样 A 的 browser-use tab 在 B 没有 visible tab 时仍能完成后台合成，但
`visibleActiveTabId` 保持空字符串，不能把 A 激活到 B。

让 `Tabs` 保持：

```tsx
className="relative h-full gap-0"
```

把 `TabsList` 后的所有内容包进：

```tsx
<div className="relative min-h-0 flex-1 isolate">
  {sidePaneTabContents}
</div>
```

其中 `sidePaneTabContents` 在 return 前由当前 `AnimatedSidePanePanel.tsx:1017-1160` 的
`tabs.map` 完整表达式抽出。map callback 开头只加入下面这个 early return：

```tsx
if (tab.type === "browser-use") {
  return (
    <BrowserUseSidePaneContent
      key={tab.id}
      tab={tab}
      isPanelVisible={isVisible}
      isSelected={tab.id === visibleActiveTabId}
      screenshotSurfaceRequest={
        screenshotSurfaceTab?.id === tab.id ? screenshotSurfaceRequest : null
      }
      initialUrl={browserRestoreUrls[tab.id]}
      workspacePath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      onUrlChange={(url) => onBrowserUrlChange(tab.id, url)}
      onPageMetadataChange={(metadata) => onBrowserPageMetadataChange(tab.id, metadata)}
    />
  );
}
```

随后直接返回原 generic `TabsContent` switch，并删除其中已不可达的 browser-use branch；
其它 tab 分支保持原源码，不引入第二份 registry 或新的渲染抽象。

非 browser-use `TabsContent` 统一为：

```tsx
className="relative z-10 h-full min-h-0 data-[state=inactive]:hidden"
```

`tab.type === "browser-use"` 在 generic `TabsContent` 之外提前分支，渲染
`BrowserUseSidePaneContent`；只有 `screenshotSurfaceTab?.id === tab.id` 时才把
`screenshotSurfaceRequest` 传入，否则传 `null`。删除原 generic switch 中的
browser-use branch。活动内容的 `z-10 bg-background` 必须覆盖 capture layer，禁止新增
透明度或动画。

- [ ] **Step 7: 让 UnifiedBrowserView 后台准备时只恢复布局**

在 `UnifiedBrowserView` 调用：

```ts
useBrowserScreenshotSurfaceReady({
  request: screenshotSurfaceRequest ?? null,
  webview,
});
const shouldComposeSurface = Boolean(screenshotSurfaceRequest);
```

根节点改为：

```tsx
<div
  aria-hidden={!isVisible}
  className={cn(
    isVisible || shouldComposeSurface ? "flex" : "hidden",
    "h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
  )}
>
```

`isVisible` 仍是所有 active/report/focus/操作语义的唯一来源；`shouldComposeSurface` 只影响布局，不能传给 `reportBrowserGuest(true)`、element picker、toolbar focus 或 side-pane active state。

在该根节点旁加入中文 bug 注释，说明 inactive `display:none` 会保留旧 Electron surface，临时 `flex` 只为截图合成，交互隔离由外层 `inert + pointer-events-none + aria-hidden` 保证。

- [ ] **Step 8: 运行 UI 组件与侧栏回归测试**

Run:

```powershell
pnpm exec vitest run packages/ui/test/BrowserUseSidePaneContent.test.ts packages/ui/test/UnifiedBrowserView.test.ts packages/ui/test/animatedSidePanePanelLayout.test.ts packages/ui/test/workspaceSidePane.test.ts packages/ui/test/sidePaneToggleEmptyState.test.ts
```

Expected: 全部 PASS；现有 crash recovery、responsive viewport、后台 mount、对话切换不抢焦点断言保持通过。

- [ ] **Step 9: 提交 renderer capture layer**

```powershell
git add packages/ui/src/browser-use/BrowserUseSidePaneContent.tsx packages/ui/src/browser-use/useBrowserScreenshotSurfaceRequest.ts packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts packages/ui/src/app-shell/AnimatedSidePanePanel.tsx packages/ui/src/browser-use/UnifiedBrowserView.tsx packages/ui/test/BrowserUseSidePaneContent.test.ts packages/ui/test/UnifiedBrowserView.test.ts
git commit -m "fix(browser-use): compose inactive tabs before screenshots"
```

---

### Task 5: 真实 Electron compositor 回归烟测

**Files:**
- Create: `packages/desktop/scripts/browser-screenshot-surface-smoke.mjs`
- Modify: `packages/desktop/package.json:8-30`

**Interfaces:**
- Consumes: Electron 41 `app`、`BrowserWindow`、`<webview>`、guest `webContents.debugger`、`nativeImage`。
- Produces: package script `test:browser-screenshot-surface-smoke`；成功时 stdout 只打印：

```json
{"width":1274,"height":720,"periodicRepeat":false,"corners":"distinct"}
```

- [ ] **Step 1: 创建真实 Electron smoke 脚本**

`packages/desktop/scripts/browser-screenshot-surface-smoke.mjs` 必须：

1. 创建启用 `webviewTag` 的测试 `BrowserWindow`，窗口内容区为 `1274 × 720`；窗口用 `showInactive()` 参与真实 compositor 合成但不抢焦点，并可放置到测试用屏幕边缘，不能使用 `show: false` 绕过真实合成；
2. host HTML 包含一个先以 `800 × 450` 显示的 `<webview>` 和一个不透明 active cover；
3. guest HTML 使用四个固定 `96 × 96` sentinel：左上红、右上绿、左下蓝、右下黄，背景用坐标渐变，确保 `x+800/y+450` 不可能合法相等；
4. guest `dom-ready` 后先等待一帧形成 `800 × 450` 历史 surface；
5. 将 webview 放进 `position:absolute; inset:0; z-index:0; width:1274px; height:720px; pointer-events:none` 的 capture layer，active cover 保持 `z-index:1`；
6. 连续等待两个 `requestAnimationFrame`，确认 `getBoundingClientRect()` 为 `1274 × 720`；
7. 对 guest 执行 `Page.captureScreenshot({format:"png",fromSurface:true})`；
8. 用 `nativeImage.createFromBuffer` 验证 PNG 尺寸和四角 RGBA；逐像素抽样检查 `(x,y)` 与 `(x+800,y)`、`(x,y+450)` 不能形成高比例相等；
9. `finally` detach debugger、destroy window、`app.quit()`。

周期检测实现固定为：

```js
function periodicMatchRatio(bitmap, width, height, stride, dx, dy) {
  let compared = 0;
  let equal = 0;
  for (let y = 0; y + dy < height; y += stride) {
    for (let x = 0; x + dx < width; x += stride) {
      const a = (y * width + x) * 4;
      const b = ((y + dy) * width + x + dx) * 4;
      compared += 1;
      if (
        bitmap[a] === bitmap[b] &&
        bitmap[a + 1] === bitmap[b + 1] &&
        bitmap[a + 2] === bitmap[b + 2]
      ) {
        equal += 1;
      }
    }
  }
  return compared === 0 ? 0 : equal / compared;
}
```

分别检测 `(dx=800,dy=0)` 与 `(dx=0,dy=450)`，任一 ratio `>= 0.95` 即失败。

- [ ] **Step 2: 增加显式 smoke 命令**

在 `packages/desktop/package.json` scripts 加入：

```json
"test:browser-screenshot-surface-smoke": "electron scripts/browser-screenshot-surface-smoke.mjs"
```

该脚本不得挂到默认 `test:unit`，因为它需要真实 GUI/compositor。

- [ ] **Step 3: 运行真实 Electron smoke**

Run:

```powershell
pnpm --filter @zcode/desktop test:browser-screenshot-surface-smoke
```

Expected:

```text
{"width":1274,"height":720,"periodicRepeat":false,"corners":"distinct"}
```

Windows 125%、150%、160% 显示缩放至少选两档重复运行；每次输出相同，进程退出码为 0，用户当前侧栏焦点不被测试窗口长期占用。

- [ ] **Step 4: 提交真实合成证据**

```powershell
git add packages/desktop/scripts/browser-screenshot-surface-smoke.mjs packages/desktop/package.json
git commit -m "test(browser-use): cover background screenshot compositor"
```

---

### Task 6: 全链路运行时复验、静态门禁与最终提交

**Files:**
- Modify only if evidence requires: files already listed in Tasks 1-5
- Verify: `docs/superpowers/specs/2026-07-23-browser-background-screenshot-surface-design.md`
- Verify: `docs/testing/browser-use-codex-parity-coverage-matrix.md`

**Interfaces:**
- Consumes: Tasks 1-5 的完整实现和 smoke 命令。
- Produces: 用户场景的运行时证据、全仓 typecheck/lint、干净且可审计的最终 commit chain。

- [ ] **Step 1: 对照原始失败尺寸执行 ZCode 运行时复验**

启动当前桌面开发构建：

```powershell
pnpm dev:desktop:prod
```

使用内置浏览器打开本地四角 sentinel 页面，使 browser-use tab 最后一次可见尺寸为 `800 × 450`；切到其他侧栏 tab，把侧栏内容区调到 `1274 × 720`，再发起同一 tab 的显式 screenshot。通过现有 Browser API 返回的 PNG 验证：

```text
PNG width=1274
PNG height=720
horizontal periodic match at dx=800 < 0.95
vertical periodic match at dy=450 < 0.95
current side-pane active tab unchanged
document.activeElement unchanged
```

同时观察 debug 日志顺序必须是：

```text
prepare -> renderer ready -> Page.captureScreenshot -> release
```

日志中不得出现图片 base64、网页正文或完整 URL。

- [ ] **Step 2: 验证失败门禁**

保持目标 browser-use tab inactive，临时在 DevTools 中阻止 renderer ready 回传，执行一次显式 screenshot。预期：

```text
3000ms 后返回 backend_unavailable/timeout 结构化失败
Page.captureScreenshot 调用数为 0
release 只发送一次
当前侧栏 tab、焦点、网页滚动位置不变
```

恢复 ready 后再次截图应成功；不能残留 pending request 或永久 capture layer。

- [ ] **Step 3: 运行 focused test 集合**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/preloadDisposer.test.ts packages/desktop/test/desktopBrowserViewIpc.test.ts packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts packages/desktop/test/browserGuestManager.test.ts packages/desktop/test/browserCommandExecutor.test.ts packages/ui/test/BrowserUseSidePaneContent.test.ts packages/ui/test/UnifiedBrowserView.test.ts packages/ui/test/animatedSidePanePanelLayout.test.ts packages/ui/test/workspaceSidePane.test.ts packages/ui/test/sidePaneToggleEmptyState.test.ts
```

Expected: 全部 PASS，无 skipped 新用例、无 unhandled rejection、无 React `act(...)` 警告。

- [ ] **Step 4: 执行仓库强制静态门禁**

Run:

```powershell
pnpm typecheck
pnpm lint
```

Expected: 两条命令退出码均为 0。

- [ ] **Step 5: 审计 diff 和边界**

Run:

```powershell
git diff --check
git status --short
git log --oneline -8
```

Expected:

- `git diff --check` 无输出；
- 工作树不包含本任务未提交文件；
- commit chain 至少包含 platform contract、coordinator、manager gate、renderer capture layer、Electron smoke 五个 Conventional Commits；
- 没有修改 `packages/shared/src/zcode-protocol/index.ts`、relay、remote snapshot、task queue 或 conversation persistence。

- [ ] **Step 6: 如复验产生必要小修，单独提交**

只有运行时证据证明需要修正时才执行；先从 `git diff --name-only` 逐项复制本任务实际
文件名到 `git add`，例如若只修正协调器和其测试：

```powershell
git add packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts
git commit -m "fix(browser-use): finalize background screenshot surface"
```

提交前再次运行 Step 3、Step 4；禁止把并发任务或用户已有修改带入 commit。

---

## Completion Evidence

完成实现后交付说明必须包含：

- 根因：inactive `display:none` 导致 Electron guest 继续持有旧 compositor surface，CDP 按新 viewport 平铺旧 surface。
- 修复边界：owner renderer capture-layer ACK；没有切换 tab、没有裁图/拉伸、没有改 conversation fact。
- 自动化：focused Vitest、真实 Electron `1274 × 720` 四角 sentinel、`800/450` 周期检测。
- 静态门禁：`pnpm typecheck`、`pnpm lint`。
- 多端说明：desktop continuous 主链路只新增瞬时 IPC；mobile replayable 继续读取成功持久化图片事实，未引入新的恢复状态。
- 未完整实机验证的平台/DPI（若有）必须明确列为剩余风险，不得笼统写“已兼容全部平台”。
