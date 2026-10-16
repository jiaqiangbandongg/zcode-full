# Windows CUA WGC Visual Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows source Helper 通过 WGC 完成显示器截图、遮挡窗口截图、`get_app_state` 附图以及 `state_image` / `screenshot` 坐标闭环。

**Architecture:** 在现有 `ax_native.node` 中增加独立的 C++/WinRT + D3D11 + WIC 单帧捕获模块，通过三个成组 additive N-API 导出暴露 Promise ABI。TypeScript 以一个 Windows-only bridge 校验 capability/outcome；显示器截图进入现有 backend，窗口截图注入 `createAxWinReadOnlySource`，实际截图 bounds 贯穿 broker、state cache 和视觉坐标映射。

**Tech Stack:** TypeScript 5.9、Vitest 4、Node-API / node-addon-api、C++17、C++/WinRT、Windows Graphics Capture、D3D11、WIC、MSVC / node-gyp、Sharp、Windows named-pipe broker。

## Global Constraints

- 先写测试并观察 RED，再写最小实现并观察 GREEN；每个任务独立提交。
- 只修改 `C:\Users\dev\zcode-cua` 的本地 Windows source Helper 和 `C:\Users\dev\z-code` 的事实/计划文档；不启动或修改 SSH、WSL、Docker、remote workspace、手机 `/remote`。
- 复用现有 C++ addon，不新增 Rust sidecar、常驻进程或 Electron 依赖。
- 像素来源只能是 WGC；禁止 BitBlt、PrintWindow、PowerShell 截图、外部截图命令、Electron `desktopCapturer` 和私有二进制 fallback。
- source 开发接受 Windows 系统默认 WGC 捕获边框，不申请或绕过受限无边框 capability。
- 本计划不做安装包、签名、manifest、商店 identity 或 x64/arm64 预编译发布物；这些留到 source runtime 验证后的产品闭环。
- additive ABI 固定为 `isScreenCaptureSupported()`、`captureMonitorPngAsync(bounds)`、`captureWindowPngVerifiedAsync(windowId,pid,expectedCanonicalBundleId,expectedBounds?)`；三个导出必须成组存在。
- native success 固定返回 `{ok:true,format:"png",data,width,height,bounds}`；failure 只返回固定 error code，不泄漏 HRESULT 文本、窗口标题、可执行路径、图像内容、token 或 pipe。
- 捕获必须在 `Napi::AsyncWorker` 中执行；C++/WinRT 异常在 worker 内捕获，不能越过 N-API。
- 使用独立 `std::timed_mutex`；admission 最多 250ms；第一帧最多 2000ms；最大单边 16384；最大总像素 33554432；最大 PNG 128 MiB。
- D3D11 首选 hardware，失败可用 WARP；仍必须走 WGC。帧池使用 `CreateFreeThreaded`，只复制 `ContentSize`。
- HWND 捕获前后必须复核 `IsWindow`、PID、canonical exe、完整性级别、`IsIconic` 和 `GetWindowRect`；变化返回 `target_changed`，不能拼接 UIA tree 与不同观察时刻的图像。
- 非交互 desktop、锁屏（LockApp/Winlogon）、安全桌面、高完整性目标和最小化窗口 fail closed。
- `bounds` 是已复核的桌面物理坐标范围；`width/height` 是 PNG 像素尺寸。二者不一致时显式缩放，禁止假设 1:1。
- 复用现有 `state_id` 和最新 visual-frame；不新增 `screenshotId`，不修改 30-tool surface、tier 或 annotation。
- Windows 完整三导出 + runtime support 才能 `supportsScreenCapture=true`；旧/半实现/malformed addon fail closed。
- `invalid_target` / `target_changed` 使 app observation 失败并要求 reobserve；其余 transient window capture failure 保留 UIA tree，但 `screenshot=null`、`screenshot_error` 非空且不得建立 `state_image` target。
- macOS/Linux 现有截图路径保持兼容；Windows SystemSurface 继续是无截图 fallback。
- 默认测试不得启动 GUI 或读取屏幕；live smoke 必须显式 opt-in，且在启动 Helper/fixture 前验证普通已解锁桌面。
- live smoke 只能控制自己启动的 fixture 进程，`finally` 恢复/关闭所有资源；输出不得包含截图、marker、窗口标题、路径、token 或 pipe。
- 必须执行 zcode-cua focused/full tests、native rebuild、build、typecheck、lint；ZCode 执行 source Helper integration、CUA focused tests、official plugin test、typecheck、lint。
- ZCode 当前 `pnpm test:unit:affected` 的非 CUA baseline 仍要重跑并逐项记录，不能把非零结果称为通过。

---

## File Structure

### `C:\Users\dev\zcode-cua`

- Create `src/native/windowsScreenCapture.ts` — Windows 三导出成组 gate、outcome runtime validation、固定错误类型。
- Modify `src/native/types.ts` — Windows screen capture outcome、success DTO 与 additive native methods。
- Modify `src/broker/server/nativeAxSource.ts` — raw Helper addon 的 additive Windows ABI，以及 `screenshot_bounds` / `screenshot_error` broker-neutral字段。
- Modify `src/broker/server/nodeAutomationAdapter.ts` — Windows monitor capture、capability/status 和 native error → broker error 映射。
- Modify `src/native/win.ts` — async `captureApp` 附加 verified WGC window PNG，并区分 identity failure 与 transient failure。
- Modify `src/broker/server/platformAxSource.ts` — 将 Windows bridge callback 注入 `createAxWinReadOnlySource`。
- Modify `src/broker/server/axReadOnly.ts` — 透传 `screenshot_bounds` / `screenshot_error`。
- Modify `src/targeting/types.ts` — state image 的独立 `image_bounds`。
- Modify `src/targeting/snapshot.ts` — 摄取 `screenshot_bounds`。
- Modify `src/targeting/resolver.ts` — `state_image` 使用 `image_bounds ?? window.bounds`。
- Modify `src/broker/server/electronNativeBackend.ts` — screenshot reply 附加当前 selected-display bounds。
- Modify `src/backend/broker-client.ts` — 保留 additive screenshot bounds。
- Modify `src/tools/observation.ts` — visual-frame 使用 broker 返回的 selected-display bounds/origin，并展示 `screenshot_error`。
- Create `src/native/screen_capture_win.h` — WGC N-API entrypoint 和 shutdown seam。
- Create `src/native/screen_capture_win.cc` — WGC target validation、D3D11 single-frame、WIC PNG、worker/outcome。
- Modify `src/native/ax_win.cc` — 引用 WGC module、状态、exports、terminal shutdown。
- Modify `binding.gyp` — Windows source、C++ exceptions 和 D3D/WIC/WinRT libraries。
- Create `test/windows-native-screen-capture-adapter.test.ts` — bridge、adapter capability、outcome 和平台隔离。
- Create `test/windows-app-state-screen-capture.test.ts` — Windows source 附图、错误与 bounds。
- Modify `test/windows-capability-truthfulness.test.ts` — 新能力真值与 broker screenshot。
- Modify `test/observation-tools.test.ts` — selected-display origin。
- Modify `test/targeting-resolver.test.ts` — `screenshot_bounds` → state image mapping。
- Create `test/native/windows-wgc-screen-capture.test.ts` — native source contract 和 compiled ABI。
- Create `scripts/fixtures/windows-capture-smoke-window.ps1` — 只供 opt-in smoke 使用的受控 WPF target/occluder。
- Create `scripts/windows-screen-capture-live-smoke.mjs` — 显示器、遮挡 HWND、app state、state-image、最小化与 clean exit。
- Create `test/windows-screen-capture-live-smoke.test.ts` — 默认关闭和 preflight 证据。
- Modify `package.json` — `smoke:windows:screen-capture`。
- Modify `docs/platforms.md` — Windows WGC 当前能力和限制。
- Regenerate `dist/**` only through `pnpm build`.

### `C:\Users\dev\z-code`

- Modify `docs/cua/windows-source-development.md` — source 构建、自动门禁、live smoke 与已知风险。

## Data and Error Flow

```text
screenshot
  |
  +--> backend selected display bounds
         |
         +--> WindowsScreenCaptureBridge.captureMonitor(bounds)
                |
                +--> native WGC AsyncWorker
                +--> PNG + width/height + verified bounds
         |
         +--> broker reply {format,data,bounds}
                |
                +--> visual-frame
                       pointer = bounds width/height
                       origin  = bounds x/y

get_app_state(include_screenshot=true)
  |
  +--> UIA snapshot {pid, exe, hwnd, window bounds}
         |
         +--> WindowsScreenCaptureBridge.captureWindow(...)
                |
                +--> pre-validate identity/bounds
                +--> WGC first frame
                +--> post-validate identity/bounds
         |
         +--> {screenshot,screenshot_bounds}
                |
                +--> state_id
                       |
                       +--> state_image:
                              image pixel -> screenshot_bounds -> screen point
```

```text
native error             app-state behavior                    screenshot behavior
invalid_target           fail observation / reobserve          explicit broker error
target_changed           fail observation / reobserve          explicit broker error
unsupported              capability false                      not_authorized
unavailable              screenshot=null + warning             internal
busy / timeout           screenshot=null + warning             timeout
device_lost              screenshot=null + warning             retryable internal
too_large                screenshot=null + warning             invalid_request
capture/encode_failed    screenshot=null + warning             sanitized internal
malformed / rejection    screenshot=null + warning             sanitized internal
```

---

### Task 1: Add the typed Windows screen-capture bridge

**Files:**

- Create: `C:\Users\dev\zcode-cua\src\native\windowsScreenCapture.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\types.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nativeAxSource.ts`
- Test: `C:\Users\dev\zcode-cua\test\windows-native-screen-capture-adapter.test.ts`

**Interfaces:**

- Produces `AxWinScreenCaptureOutcome`, `WindowsScreenCaptureError`, `createWindowsScreenCaptureBridge(native)`.
- `bridge.available` is true only when all three exports are functions and `isScreenCaptureSupported() === true`.
- `bridge.captureMonitor(bounds)` and `bridge.captureWindow(...)` return validated success DTOs or throw fixed-code `WindowsScreenCaptureError`.

- [ ] **Step 1: Write failing bridge tests**

Create fakes for complete, partial, malformed and rejecting addons. Pin these assertions:

```ts
expect(createWindowsScreenCaptureBridge(complete).available).toBe(true);
expect(
  createWindowsScreenCaptureBridge({
    ...complete,
    captureWindowPngVerifiedAsync: undefined,
  }).available,
).toBe(false);

await expect(bridge.captureMonitor([-1920, 0, 1920, 1080])).resolves.toMatchObject({
  format: "png",
  width: 1920,
  height: 1080,
  bounds: [-1920, 0, 1920, 1080],
});

await expect(malformed.captureMonitor([0, 0, 1, 1])).rejects.toMatchObject({
  name: "WindowsScreenCaptureError",
  code: "capture_failed",
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
pnpm exec vitest run test/windows-native-screen-capture-adapter.test.ts
```

Expected: FAIL because `windowsScreenCapture.ts` and the three native methods do not exist.

- [ ] **Step 3: Add exact native DTOs**

Add to `src/native/types.ts` and mirror the methods on `HelperNativeAddon`:

```ts
export type AxWinScreenCaptureErrorCode =
  | "unsupported"
  | "unavailable"
  | "busy"
  | "timeout"
  | "invalid_target"
  | "target_changed"
  | "too_large"
  | "device_lost"
  | "capture_failed"
  | "encode_failed";

export type AxWinScreenCaptureOutcome =
  | {
      ok: true;
      format: "png";
      data: Uint8Array;
      width: number;
      height: number;
      bounds: [number, number, number, number];
    }
  | { ok: false; error: AxWinScreenCaptureErrorCode };

isScreenCaptureSupported?(): boolean;
captureMonitorPngAsync?(
  bounds: [number, number, number, number],
): Promise<AxWinScreenCaptureOutcome>;
captureWindowPngVerifiedAsync?(
  windowId: number,
  pid: number,
  expectedCanonicalBundleId: string,
  expectedBounds?: [number, number, number, number],
): Promise<AxWinScreenCaptureOutcome>;
```

- [ ] **Step 4: Implement strict runtime validation**

`createWindowsScreenCaptureBridge` must:

```ts
const hasCompleteAbi =
  typeof native.isScreenCaptureSupported === "function" &&
  typeof native.captureMonitorPngAsync === "function" &&
  typeof native.captureWindowPngVerifiedAsync === "function";

const available = hasCompleteAbi && safeSupported(native) === true;
```

Success validation must require PNG signature-bearing non-empty `Uint8Array`, positive safe integer dimensions, finite four-number bounds, and exact `"png"` format. Failure validation accepts only the ten fixed codes. Synchronous throw, Promise rejection and malformed outcome become `WindowsScreenCaptureError("capture_failed")`; no original message is retained.

- [ ] **Step 5: Run bridge tests and typecheck**

Run:

```powershell
pnpm exec vitest run test/windows-native-screen-capture-adapter.test.ts
pnpm typecheck
```

Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```powershell
git add -- src/native/types.ts src/native/windowsScreenCapture.ts src/broker/server/nativeAxSource.ts test/windows-native-screen-capture-adapter.test.ts
git commit -m "feat(windows): define native screen capture bridge"
```

---

### Task 2: Route selected-display screenshot through the native bridge

**Files:**

- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nodeAutomationAdapter.ts`
- Modify: `C:\Users\dev\zcode-cua\test\windows-native-screen-capture-adapter.test.ts`
- Modify: `C:\Users\dev\zcode-cua\test\windows-capability-truthfulness.test.ts`
- Modify: `C:\Users\dev\zcode-cua\test\broker\windowsSystemSurface.test.ts`

**Interfaces:**

- Consumes `createWindowsScreenCaptureBridge`.
- Produces truthful `ElectronAutomationAdapter.supportsScreenCapture`, status and `captureScreenPng(area)`.

- [ ] **Step 1: Add RED adapter tests**

Assert:

```ts
expect(adapter.supportsScreenCapture).toBe(true);
expect(adapter.getScreenMediaAccessStatus()).toBe("granted");
await expect(
  adapter.captureScreenPng({
    x: -1920,
    y: 0,
    width: 1920,
    height: 1080,
  }),
).resolves.toEqual(PNG_BYTES);
expect(native.captureMonitorPngAsync).toHaveBeenCalledWith([-1920, 0, 1920, 1080]);
```

Also pin:

- partial ABI → false and no native dispatch;
- `busy` → `BrokerError.code === "timeout"`;
- `too_large` → `invalid_request`;
- `unsupported` → `not_authorized`;
- other fixed/malformed errors → sanitized `internal`;
- darwin/linux still use `system.captureScreenPng`.

- [ ] **Step 2: Run and observe RED**

```powershell
pnpm exec vitest run test/windows-native-screen-capture-adapter.test.ts test/windows-capability-truthfulness.test.ts test/broker/windowsSystemSurface.test.ts
```

Expected: new Windows capability and dispatch assertions fail.

- [ ] **Step 3: Implement Windows-only adapter branch**

Inside `createNodeAutomationAdapter`:

```ts
const windowsCapture =
  platform === "win32"
    ? createWindowsScreenCaptureBridge(native as unknown as AxWinNativeAddon)
    : null;

const supportsScreenCapture =
  platform === "win32"
    ? windowsCapture?.available === true
    : system.supportsScreenCapture !== false;
```

For Windows, `getScreenMediaAccessStatus` returns `"granted"` only when the bridge is available; otherwise native `"denied"` is preserved and all other cases are `"unknown"`. `captureScreenPng(area)` chooses the supplied area or current primary display bounds, awaits `captureMonitor`, and returns only its `data`. Do not call `WindowsNodeSystemSurface.captureScreenPng`.

- [ ] **Step 4: Implement fixed broker error mapping**

Add `screenCaptureError(operation, code)`:

```ts
busy | timeout       -> BrokerError("timeout")
too_large            -> BrokerError("invalid_request")
unsupported          -> BrokerError("not_authorized")
invalid_target |
target_changed       -> BrokerError("element_unavailable")
unavailable |
device_lost |
capture_failed |
encode_failed        -> BrokerError("internal")
```

Messages may name the operation and fixed code only.

- [ ] **Step 5: Run focused tests and typecheck**

```powershell
pnpm exec vitest run test/windows-native-screen-capture-adapter.test.ts test/windows-capability-truthfulness.test.ts test/broker/windowsSystemSurface.test.ts
pnpm typecheck
```

Expected: PASS; Windows SystemSurface remains false while complete native adapter is true.

- [ ] **Step 6: Commit**

```powershell
git add -- src/broker/server/nodeAutomationAdapter.ts test/windows-native-screen-capture-adapter.test.ts test/windows-capability-truthfulness.test.ts test/broker/windowsSystemSurface.test.ts
git commit -m "feat(windows): route monitor capture through native WGC"
```

---

### Task 3: Attach verified WGC images to Windows app state

**Files:**

- Modify: `C:\Users\dev\zcode-cua\src\native\win.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\platformAxSource.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\axReadOnly.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\ax-types.ts`
- Modify: `C:\Users\dev\zcode-cua\src\targeting\types.ts`
- Modify: `C:\Users\dev\zcode-cua\src\targeting\snapshot.ts`
- Modify: `C:\Users\dev\zcode-cua\src\targeting\resolver.ts`
- Test: `C:\Users\dev\zcode-cua\test\windows-app-state-screen-capture.test.ts`
- Modify: `C:\Users\dev\zcode-cua\test\targeting-resolver.test.ts`

**Interfaces:**

- `createAxWinReadOnlySource(native, {captureWindowPngVerified})`.
- `AxRawSnapshot.screenshot_bounds?: Bounds`.
- `AxRawSnapshot.screenshot_error?: string`.
- `AppState.image_bounds?: Bounds`.

- [ ] **Step 1: Write RED source/state tests**

Test a native UIA snapshot with HWND 42, pid 4321, exe path and bounds. Assert:

```ts
const result = await source.captureApp({ pid: 4321, window_id: 42 }, { includeScreenshot: true });
expect(captureWindowPngVerified).toHaveBeenCalledWith({
  windowId: 42,
  pid: 4321,
  expectedCanonicalBundleId: "C:\\Apps\\Target.exe",
  expectedBounds: [100, 80, 800, 600],
});
expect(result).toMatchObject({
  screenshot: { format: "png" },
  screenshot_bounds: [102, 82, 796, 596],
});
```

Also assert:

- `includeScreenshot:false` never invokes WGC;
- missing HWND/PID/exe returns UIA tree with no image;
- `invalid_target` / `target_changed` rejects the whole observation;
- `busy` / `timeout` / `device_lost` / capture/encode failure returns UIA tree, `screenshot:null`, fixed `screenshot_error`;
- image bytes become base64 exactly once;
- resolver maps state-image corners through `image_bounds`, not `window.bounds`.

- [ ] **Step 2: Run and verify RED**

```powershell
pnpm exec vitest run test/windows-app-state-screen-capture.test.ts test/targeting-resolver.test.ts
```

Expected: FAIL because the callback and image bounds fields do not exist.

- [ ] **Step 3: Extend raw snapshot and state contracts**

Add:

```ts
interface AxRawSnapshot {
  screenshot?: AxImagePayload | null;
  screenshot_bounds?: [number, number, number, number];
  screenshot_error?: string;
}

interface AppState {
  image_bounds?: Bounds;
}
```

`ingestCaptureAppResult` validates `screenshot_bounds` with `asBounds` only when a nonblank decodable image exists. `resolveStateImageCoordinate` uses:

```ts
const [wx, wy, ww, wh] = state.image_bounds ?? state.window.bounds;
```

- [ ] **Step 4: Make the Windows source capture path async**

The source captures UIA first, then invokes the injected callback using the exact snapshot identity:

```ts
captureApp: async (appRef, options) => {
  const snap = native.captureApp(pid, requestedWindowId);
  const adapted = adaptSnapshot(snap);
  if (options?.includeScreenshot === false) return adapted;
  const captured = await options.captureWindowPngVerified?.({
    windowId: snap.window.window_id,
    pid: snap.app.pid,
    expectedCanonicalBundleId: snap.app.bundle_id,
    expectedBounds: snap.window.bounds,
  });
  return {
    ...adapted,
    screenshot: {
      format: "png",
      data: Buffer.from(captured.data).toString("base64"),
    },
    screenshot_bounds: captured.bounds,
  };
};
```

Catch only `WindowsScreenCaptureError`. Re-throw `invalid_target` and `target_changed` as `elementUnavailable`; return fixed `screenshot_error` for transient codes. Never catch UIA errors or arbitrary programmer errors.

- [ ] **Step 5: Inject the bridge and surface warnings**

`selectPlatformAxSource` creates a Windows bridge and passes `captureWindow` only when available. `axReadOnly` copies `screenshot_bounds` and `screenshot_error` into the broker response. `mapRawCaptureAppResult` adds a text block:

```text
[screenshot_error] Windows window pixels were unavailable (<fixed-code>).
The accessibility tree is still valid; call get_app_state again before using state_image coordinates.
```

It must not echo arbitrary native messages.

- [ ] **Step 6: Run focused tests and typecheck**

```powershell
pnpm exec vitest run test/windows-app-state-screen-capture.test.ts test/targeting-resolver.test.ts test/observation-tools.test.ts test/native/capture-app-window-id.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add -- src/native/win.ts src/broker/server/platformAxSource.ts src/broker/server/axReadOnly.ts src/broker/ax-types.ts src/targeting/types.ts src/targeting/snapshot.ts src/targeting/resolver.ts src/tools/observation.ts test/windows-app-state-screen-capture.test.ts test/targeting-resolver.test.ts test/observation-tools.test.ts
git commit -m "feat(windows): attach verified window images to app state"
```

---

### Task 4: Preserve selected-display bounds in screenshot visual frames

**Files:**

- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronNativeBackend.ts`
- Modify: `C:\Users\dev\zcode-cua\src\backend\broker-client.ts`
- Modify: `C:\Users\dev\zcode-cua\src\tools\observation.ts`
- Modify: `C:\Users\dev\zcode-cua\test\observation-tools.test.ts`
- Modify: `C:\Users\dev\zcode-cua\test\targeting-screenshot-space.test.ts`
- Modify: `C:\Users\dev\zcode-cua\test\windows-capability-truthfulness.test.ts`

**Interfaces:**

- Broker screenshot result becomes additive `{format,data,bounds:[x,y,w,h]}`.
- Old Helper replies without bounds keep the current primary-display fallback.

- [ ] **Step 1: Add RED negative-origin tests**

Set display 2 to `[-1920,0,1920,1080]`, call `set_display({index:2})`, then assert backend screenshot returns that bounds. Feed the reply to the MCP screenshot handler and assert:

```ts
expect(getDefaultSession().getVisualFrame()).toMatchObject({
  pointer: { width: 1920, height: 1080 },
  origin: { x: -1920, y: 0 },
});
expect(visualFrameToScreen(frame, frame.agent.width - 1, frame.agent.height - 1)).toEqual({
  x: -1,
  y: 1079,
});
```

- [ ] **Step 2: Run and observe RED**

```powershell
pnpm exec vitest run test/observation-tools.test.ts test/targeting-screenshot-space.test.ts test/windows-capability-truthfulness.test.ts
```

Expected: backend/client discard bounds and handler records origin `(0,0)`.

- [ ] **Step 3: Carry additive bounds end to end**

Backend:

```ts
const selected = displaySelection.current();
const png = await adapter.captureScreenPng(selected.bounds);
return {
  format: "png",
  data: toBase64(png),
  bounds: [selected.bounds.x, selected.bounds.y, selected.bounds.width, selected.bounds.height],
};
```

Client validates finite positive bounds when present and preserves them. Handler uses bounds width/height as `pointer` and x/y as `origin`; only absent/invalid legacy bounds call `fetchMainDisplaySize` and use `(0,0)`.

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
pnpm exec vitest run test/observation-tools.test.ts test/targeting-screenshot-space.test.ts test/windows-capability-truthfulness.test.ts
pnpm typecheck
```

Expected: PASS, including legacy no-bounds reply.

- [ ] **Step 5: Commit**

```powershell
git add -- src/broker/server/electronNativeBackend.ts src/backend/broker-client.ts src/tools/observation.ts test/observation-tools.test.ts test/targeting-screenshot-space.test.ts test/windows-capability-truthfulness.test.ts
git commit -m "fix(cua): preserve selected display screenshot origin"
```

---

### Task 5: Implement native WGC single-frame capture

**Files:**

- Create: `C:\Users\dev\zcode-cua\src\native\screen_capture_win.h`
- Create: `C:\Users\dev\zcode-cua\src\native\screen_capture_win.cc`
- Modify: `C:\Users\dev\zcode-cua\src\native\ax_win.cc`
- Modify: `C:\Users\dev\zcode-cua\binding.gyp`
- Test: `C:\Users\dev\zcode-cua\test\native\windows-wgc-screen-capture.test.ts`
- Modify: `C:\Users\dev\zcode-cua\test\native\windows-capability-truthfulness.test.ts`

**Interfaces:**

- Header exports `IsScreenCaptureSupportedNow`, the three N-API callbacks, and `BeginScreenCaptureShutdown`.
- Native worker always resolves a structured outcome; invalid input never crashes or leaks raw errors.

- [ ] **Step 1: Write RED native source/ABI tests**

Read the new source/header/binding as UTF-8 and pin:

```ts
expect(binding).toContain('"src/native/screen_capture_win.cc"');
expect(binding).toContain('"d3d11.lib"');
expect(binding).toContain('"windowscodecs.lib"');
expect(binding).toContain('"runtimeobject.lib"');
expect(source).toContain("IGraphicsCaptureItemInterop");
expect(source).toContain("CreateForMonitor");
expect(source).toContain("CreateForWindow");
expect(source).toContain("CreateFreeThreaded");
expect(source).toContain("D3D11_CPU_ACCESS_READ");
expect(source).toContain("GUID_ContainerFormatPng");
expect(source).toContain("std::timed_mutex");
expect(source).toContain("milliseconds(250)");
expect(source).toContain("milliseconds(2000)");
expect(source).not.toContain("BitBlt");
expect(source).not.toContain("PrintWindow");
```

Compiled checks require the three functions and verify invalid bounds/HWND resolve `{ok:false}` without throwing.

- [ ] **Step 2: Run source tests and observe RED**

```powershell
pnpm exec vitest run test/native/windows-wgc-screen-capture.test.ts test/native/windows-capability-truthfulness.test.ts
```

Expected: FAIL because the native module and exports do not exist.

- [ ] **Step 3: Add build inputs**

Windows `binding.gyp`:

```text
sources += src/native/screen_capture_win.cc
libraries += d3d11.lib, dxgi.lib, runtimeobject.lib, windowscodecs.lib, WindowsApp.lib
VCCLCompilerTool.ExceptionHandling = 1
```

Keep `NAPI_DISABLE_CPP_EXCEPTIONS`, `/utf-8`, C++17 and all existing libraries. `/EHsc` is required only so C++/WinRT exceptions can be caught inside the worker.

- [ ] **Step 4: Implement target validation and support probe**

`IsScreenCaptureSupportedNow` must require:

- interactive input desktop named `default`;
- foreground process not `LockApp.exe`, `LogonUI.exe` or `winlogon.exe`;
- `GraphicsCaptureSession::IsSupported()`;
- activation factory query for `IGraphicsCaptureItemInterop`.

Monitor resolution enumerates displays and requires exact `RECT` equality. Window validation runs before and after capture and returns only:

```cpp
struct VerifiedWindow {
  HWND hwnd;
  DWORD pid;
  std::wstring executable;
  RECT bounds;
};
```

It rejects self PID, elevated PID, invalid/minimized/zero-area window and expected identity/bounds mismatch.

- [ ] **Step 5: Implement the D3D/WGC frame path**

Exact lifecycle:

```text
CoInitializeEx(COINIT_MULTITHREADED)
try_lock_for(250ms)
D3D11CreateDevice(HARDWARE, BGRA)
  -> retry D3D_DRIVER_TYPE_WARP
CreateDirect3D11DeviceFromDXGIDevice
CreateForMonitor / CreateForWindow
Direct3D11CaptureFramePool::CreateFreeThreaded(..., B8G8R8A8, 2, item.Size())
FrameArrived + Closed signals
StartCapture
wait_until(now + 2000ms)
TryGetNextFrame
copy ContentSize to staging D3D11_TEXTURE2D
Map(D3D11_MAP_READ)
WIC PNG encoder -> IStream/HGLOBAL -> bounded vector
Unmap + session.Close + pool.Close + release
post-validate target
CoUninitialize when owned
```

All cleanup uses RAII. Check the terminal shutdown flag before session creation and after frame receipt.

- [ ] **Step 6: Implement worker/outcome/export glue**

`ScreenCaptureWorker` owns copied primitives only; no N-API values are read in `Execute`. `OnOK` creates either:

```cpp
{ ok: true, format: "png", data: Buffer, width, height, bounds }
```

or:

```cpp
{ ok: false, error: "<fixed code>" }
```

`ax_win.cc`:

```cpp
exports.Set("isScreenCaptureSupported",
            Napi::Function::New(env, IsScreenCaptureSupported));
exports.Set("captureMonitorPngAsync",
            Napi::Function::New(env, CaptureMonitorPngAsync));
exports.Set("captureWindowPngVerifiedAsync",
            Napi::Function::New(env, CaptureWindowPngVerifiedAsync));
```

`ScreenCaptureStatus` returns granted only when `IsScreenCaptureSupportedNow()`; `CancelPendingInputHolds` also calls `BeginScreenCaptureShutdown()`.

- [ ] **Step 7: Rebuild and run compiled tests**

```powershell
pnpm rebuild:native
pnpm exec vitest run test/native/windows-wgc-screen-capture.test.ts test/native/windows-capability-truthfulness.test.ts
```

Expected: node-gyp exit 0; compiled export and invalid-target tests PASS.

- [ ] **Step 8: Run all focused visual tests**

```powershell
pnpm exec vitest run test/windows-native-screen-capture-adapter.test.ts test/windows-app-state-screen-capture.test.ts test/windows-capability-truthfulness.test.ts test/observation-tools.test.ts test/targeting-resolver.test.ts test/targeting-screenshot-space.test.ts test/native/windows-wgc-screen-capture.test.ts test/native/windows-capability-truthfulness.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add -- binding.gyp src/native/screen_capture_win.h src/native/screen_capture_win.cc src/native/ax_win.cc test/native/windows-wgc-screen-capture.test.ts test/native/windows-capability-truthfulness.test.ts
git commit -m "feat(windows): implement WGC visual capture"
```

---

### Task 6: Add an autonomous opt-in live acceptance

**Files:**

- Create: `C:\Users\dev\zcode-cua\scripts\fixtures\windows-capture-smoke-window.ps1`
- Create: `C:\Users\dev\zcode-cua\scripts\windows-screen-capture-live-smoke.mjs`
- Create: `C:\Users\dev\zcode-cua\test\windows-screen-capture-live-smoke.test.ts`
- Modify: `C:\Users\dev\zcode-cua\package.json`

**Interfaces:**

- Env gate: `ZCODE_CUA_WINDOWS_SCREEN_CAPTURE_LIVE=1`.
- Fixture writes only PID/HWND/bounds to a caller-created private temp file and exits on a private close signal.
- Smoke controls only its two fixture processes.

- [ ] **Step 1: Write RED guard tests**

Spawn the smoke without opt-in and assert exit code 2, no Helper/fixture marker, and message naming only the opt-in variable. Add a test-only preflight override to simulate lockscreen and assert it exits before spawning anything.

- [ ] **Step 2: Run and observe RED**

```powershell
pnpm exec vitest run test/windows-screen-capture-live-smoke.test.ts
```

Expected: FAIL because the smoke does not exist.

- [ ] **Step 3: Implement the WPF fixture**

The target mode renders a deterministic green/magenta checkerboard plus one safe button; occluder mode renders opaque blue. Both use caller-provided geometry and title-independent private handshake files. Do not read clipboard, user windows or user documents.

- [ ] **Step 4: Implement live preflight and cleanup**

Before any spawn:

```text
win32
AND opt-in == 1
AND dist/windows-helper.js exists
AND build/Release/ax_native.node exists
AND current input desktop == default
AND foreground pid exists
AND foreground exe not LockApp/LogonUI/winlogon
```

Use random temp paths and a random broker token. In `finally`, signal and terminate only the fixture/helper PIDs created by this run, remove private temp files, and verify the Helper PID is gone.

- [ ] **Step 5: Implement acceptance sequence**

The smoke must automatically prove:

1. `broker_info.capabilities.screen === true` and `screenshot === true`;
2. selected monitor screenshot is a valid nonblank PNG with matching bounds;
3. target fixture direct HWND capture is valid;
4. opaque occluder fully covers the target by geometry;
5. occluded target capture remains perceptually equivalent to the unoccluded target and distinct from occluder;
6. `capture_app(include_screenshot=true)` returns image/bounds;
7. official MCP `get_app_state` 返回 `state_id` 后，`left_click(space:"state_image")` 的安全按钮点击只改变 fixture-owned state；
8. minimized target returns fixed failure;
9. Helper and fixtures exit cleanly.

Only booleans, dimensions, fixed result codes and process-exit facts may be printed.

- [ ] **Step 6: Add package command and run guard test**

```json
"smoke:windows:screen-capture": "node scripts/windows-screen-capture-live-smoke.mjs"
```

Run:

```powershell
pnpm exec vitest run test/windows-screen-capture-live-smoke.test.ts
```

Expected: PASS; without opt-in no GUI process starts.

- [ ] **Step 7: Attempt live smoke**

```powershell
$env:ZCODE_CUA_WINDOWS_SCREEN_CAPTURE_LIVE='1'
pnpm smoke:windows:screen-capture
Remove-Item Env:ZCODE_CUA_WINDOWS_SCREEN_CAPTURE_LIVE
```

Expected on ordinary unlocked desktop: exit 0 and every fixed acceptance boolean true. On LockApp/noninteractive desktop: exit 2 before Helper/fixture startup; record as environment-blocked, not passed.

- [ ] **Step 8: Commit**

```powershell
git add -- package.json scripts/fixtures/windows-capture-smoke-window.ps1 scripts/windows-screen-capture-live-smoke.mjs test/windows-screen-capture-live-smoke.test.ts
git commit -m "test(windows): add WGC live acceptance"
```

---

### Task 7: Update source-development facts and generated artifacts

**Files:**

- Modify: `C:\Users\dev\zcode-cua\docs\platforms.md`
- Modify: `C:\Users\dev\z-code\docs\cua\windows-source-development.md`
- Regenerate: `C:\Users\dev\zcode-cua\dist\**`

- [ ] **Step 1: Update platform facts**

Document implemented WGC monitor/window/app-state paths, default system border, SDR/HDR limitation, minimized fail-closed, native ABI, opt-in command and source-only status. Explicitly retain remote/mobile/packaging as out of scope.

- [ ] **Step 2: Build generated artifacts**

```powershell
pnpm build
```

Expected: exit 0; `dist/windows-helper.js` contains the new TypeScript path while native source remains in package files.

- [ ] **Step 3: Verify docs contain no stale “WGC unimplemented” claim**

```powershell
rg -n "WGC|screen capture|screenshot|截图|未实现|pending" docs README.md
```

Expected: remaining pending claims refer only to packaging/HDR/border or other explicit non-goals.

- [ ] **Step 4: Commit each repository**

In `zcode-cua`:

```powershell
git add -- docs/platforms.md dist
git commit -m "docs(windows): record WGC visual support"
```

In `z-code`:

```powershell
git add -- docs/cua/windows-source-development.md
git commit -m "docs(cua): record Windows WGC source flow"
```

---

### Task 8: Run the complete verification and completion audit

**Files:**

- No planned source edits. Any failure follows `superpowers:systematic-debugging`; do not patch by guess.

- [x] **Step 1: Run zcode-cua focused verification**

```powershell
pnpm exec vitest run test/windows-native-screen-capture-adapter.test.ts test/windows-app-state-screen-capture.test.ts test/windows-capability-truthfulness.test.ts test/observation-tools.test.ts test/targeting-resolver.test.ts test/targeting-screenshot-space.test.ts test/native/windows-wgc-screen-capture.test.ts test/native/windows-capability-truthfulness.test.ts test/windows-screen-capture-live-smoke.test.ts
pnpm rebuild:native
pnpm build
pnpm typecheck
pnpm lint
```

Expected: every command exit 0.

- [x] **Step 2: Run zcode-cua full suite**

```powershell
pnpm test
```

Expected: exit 0; platform/live skips are explicit.

- [x] **Step 3: Run ZCode integration gates**

Use the existing source-helper environment and execute:

```powershell
pnpm exec vitest run packages/services/test/cuaPermissionBroker.server.win32.test.ts packages/services/test/cuaPermissionBrokerNodeHelper.test.ts packages/services/test/cuaPermissionBroker.platformAxSource.test.ts packages/services/test/cuaPermissionBroker.electronBackend.test.ts
pnpm --filter @zcode/zcode-cua-plugin test
pnpm typecheck
pnpm lint
pnpm test:unit:affected
```

Expected: focused/plugin/typecheck/lint exit 0. Record `test:unit:affected` exact failures; only previously evidenced non-CUA baseline may remain.

- [x] **Step 4: Retry all autonomous live acceptances**

On an ordinary unlocked desktop:

```powershell
$env:ZCODE_CUA_WINDOWS_SCREEN_CAPTURE_LIVE='1'
$env:ZCODE_CUA_WINDOWS_POINTER_LIVE='1'
$env:ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE='1'
pnpm smoke:windows:screen-capture
pnpm smoke:windows:pointer
pnpm smoke:windows:clipboard
```

Remove all three environment variables in `finally`. Expected: exit 0; clipboard restores original text; pointer and visual tests mutate only spawned fixtures; no Helper orphan.

- [x] **Step 5: Audit the actual Windows 30-tool surface**

For every broker capability/tool family, collect current evidence:

```text
observation: list_apps, list_windows, get_app_state, screenshot, zoom,
             list_displays, switch_display, cursor_position
pointer:     click variants, move, scroll, drag, mouse down/up
keyboard:    type, press, key down/up, hold
elements:    press, focus, set_value, select_text, perform_action
system:      clipboard read/write, open_application, access/readiness
```

Mark each as proved, contradicted, missing or only indirectly covered. Do not mark the goal complete while any required Windows local operation lacks source, automated test and ordinary-desktop runtime evidence.

- [x] **Step 6: Final status**

If all requirements and live evidence pass, update the persistent goal to complete. If only the desktop is locked, leave the goal active and report the exact pending live acceptance without redefining implementation completion.

---

### Task 9: Close the Windows 30-tool runtime-evidence gaps

The Task 8 audit found that every public tool has source and automated coverage,
but several local Windows operations still have only indirect ordinary-desktop
evidence. Add one opt-in acceptance that exercises the official MCP handlers
against a fixture-owned WPF window; reuse the dedicated visual, pointer and
clipboard smokes as independent evidence instead of controlling user apps or
files.

**Files:**

- Create: `C:\Users\dev\zcode-cua\scripts\fixtures\windows-tool-surface-smoke-window.ps1`
- Create: `C:\Users\dev\zcode-cua\scripts\windows-tool-surface-live-smoke.mjs`
- Create: `C:\Users\dev\zcode-cua\test\windows-tool-surface-live-smoke.test.ts`
- Modify: `C:\Users\dev\zcode-cua\package.json`
- Modify: `C:\Users\dev\zcode-cua\docs\platforms.md`
- Modify: `C:\Users\dev\z-code\docs\cua\windows-source-development.md`

**State and event chain:**

```text
opt-in parent
  |
  +--> fixture-owned WPF window
  |      +--> UIA elements: text box + action button
  |      +--> pointer/key event counters
  |      `--> private JSON state + close signal
  |
  +--> source windows-helper.js
  |      `--> named pipe -> Windows native UIA / SendInput / WGC
  |
  `--> official buildServer + in-memory MCP client
         |
         +--> observation/runtime tool results
         +--> element tokens from one get_app_state
         `--> pointer/keyboard/semantic actions
                    |
                    `--> fixture event/state change -> bounded verification
```

The smoke must keep the desktop-local boundary: no SSH, WSL, Docker, remote
workspace, phone `/remote`, user documents, or uncontrolled process cleanup.
It may move the pointer only inside its own window, must restore the original
cursor and clipboard text, release any held input in `finally`, close only
children it spawned, and print only booleans/counts/fixed status codes.

- [x] **Step 1: Write RED guard tests**

Lock:

- explicit `ZCODE_CUA_WINDOWS_TOOL_SURFACE_LIVE=1` before any child spawn;
- simulated locked-desktop exit `2` before any child spawn;
- fixed total/per-operation deadlines;
- private fixture paths and owned-child cleanup;
- all 30 canonical tool names are accounted for by direct invocation or an
  explicitly named companion live smoke;
- clipboard and cursor restoration are mandatory success fields.

- [x] **Step 2: Implement the WPF fixture**

Expose deterministic UIA names and bounds for:

- an editable text box whose value and selection are written to private state;
- an invoke-capable button whose semantic and raw click effects are counted;
- a pointer pad that records move, left/right/middle down/up, click count,
  wheel delta and drag distance;
- preview key down/up counters.

The fixture must use PMv2 DPI awareness before creating its first HWND and
write physical PID/HWND/bounds in its private handshake.

- [x] **Step 3: Implement the official MCP acceptance**

Call every previously indirect public operation through `buildServer`:

- observation: `list_apps`, PID-form `open_application`, `list_windows`,
  `get_app_state`, `screenshot`, `zoom`, `list_displays`, `switch_display`,
  `cursor_position`;
- pointer: all five click profiles, non-zero `scroll`, `left_click_drag`,
  `mouse_move`, `left_mouse_down`, `left_mouse_up`;
- keyboard/semantic: `type`, `set_value`, `select_text`, `key`, `hold_key`,
  `perform_action`;
- runtime: `request_access`, bounded `wait`, `stop_computer_control`.

The dedicated clipboard smoke remains authoritative for
`read_clipboard`/`write_clipboard`, and the dedicated visual smoke remains the
authoritative `state_image`/WGC/minimized-window proof. The new smoke records
those companion commands as required evidence and fails if its own official
MCP invocation set plus the two companion tool names do not equal the canonical
30-tool manifest.

- [x] **Step 4: Run live acceptance and companion smokes**

```powershell
$env:ZCODE_CUA_WINDOWS_TOOL_SURFACE_LIVE='1'
pnpm smoke:windows:tool-surface
Remove-Item Env:ZCODE_CUA_WINDOWS_TOOL_SURFACE_LIVE
```

Then rerun screen capture, pointer and clipboard live smokes with their existing
opt-ins. Expected: every boolean true; clipboard/cursor restored; no Helper or
fixture orphan.

- [x] **Step 5: Update the evidence matrix and commit**

Record one row per canonical tool with source, automated and ordinary-desktop
runtime evidence. Do not replace explicit missing evidence with group-level
claims. Commit the acceptance and documentation before rerunning Task 8's full
repository gates.

**Completion evidence (2026-07-29):**

- source native rebuild/build/typecheck/lint all exited `0`; focused Windows
  verification was 16 files / 158 tests, and the full suite was 122 passed /
  6 skipped files with 2105 passed / 67 skipped / 18 todo tests;
- screen capture acceptance passed three consecutive post-fix runs, including
  selected-display bounds, occluded WGC pixels, `state_image` event input,
  minimized-window fail-closed, cursor restoration and clean child exit;
- pointer, text-only clipboard and 30-tool surface acceptances all exited `0`;
  clipboard text and cursor were restored, and no owned Helper/fixture remained;
- ZCode focused integration was 4 files / 175 passed / 1 skipped; the official
  plugin package's 6 tests, root typecheck and lint all exited `0`;
- `pnpm test:unit:affected` remained a documented non-CUA repository baseline:
  13 failed files / 20 failed tests, 940 passed files / 8132 passed tests.
  None of the failing files were CUA source or CUA tests.

Both PowerShell fixtures must retain a UTF-8 BOM. Windows PowerShell 5.1 otherwise
decodes UTF-8-without-BOM Chinese comments through the legacy ANSI code page;
with LF input, a multibyte tail can swallow the following newline and turn the
next statement into part of the comment. Dispatcher callbacks also use explicit
script-scope HWND/window/timer state because StrictMode event delegates do not
provide a reliable local-variable closure boundary.
