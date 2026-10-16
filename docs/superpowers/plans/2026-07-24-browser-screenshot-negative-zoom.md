# Browser Screenshot Fit Raster Surface Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Browser Use screenshots produce an untiled CSS-pixel image when a responsive viewport is visually fitted below 100% on Windows Desktop zoom `-2`.

**Architecture:** The owner renderer reports both the stable logical viewport and the actual responsive preview `surfaceScale`. While holding the existing screenshot surface lease, Desktop main uses `guest.capturePage()` for fitted viewport screenshots, normalizes the already-correct surface to CSS viewport pixels with the injected host image engine, and only then releases the lease. Clip/fullPage and non-fitted screenshots keep the existing CDP path.

**Tech Stack:** TypeScript, React, Electron `<webview>`, Chrome DevTools Protocol, Vitest, Testing Library, Electron `nativeImage`.

## Global Constraints

- Update the existing browser-use spec and coverage matrix before production code.
- Do not detect, crop, or deduplicate tiled CDP PNG data. Resizing the correct main guest surface to
  its logical CSS viewport is the explicit output normalization contract.
- Do not switch the responsive preview to `100%`, change the selected tab, steal focus, or change accessibility exposure.
- Use one cross-platform path; do not add a Windows-only branch.
- Keep `dontSetVisibleSize: true`, CSS viewport, DPR, media-query behavior, and Browser API coordinates unchanged.
- Keep screenshot surface state inside Desktop owner renderer/main; do not add relay, replayable snapshot, queue, or task stream state.
- Preserve `workspaceKey = workspaceIdentity?.trim() || workspacePath` and the complete browser/session/tab identity.
- Use UI `logger.debug` and main debug logging for high-frequency diagnostics; never log image base64 or page content.
- Every production change must follow a failing-test-first red/green cycle.
- Run `pnpm typecheck` and `pnpm lint` before completion.
- Real validation must inspect screenshot pixels; `ok=true` and PNG dimensions alone are insufficient.

> **Runtime correction (2026-07-24):** Task 3/4's original capture-only CDP metrics proposal was
> falsified by the Windows Electron smoke. `scale`, visible-size, DPR, page-scale and guest-zoom
> probes still tiled or were rejected. The implemented replacement is main
> `guest.capturePage()` plus host CSS-pixel normalization. The old task steps below are retained as
> the red-path investigation record and must not be reimplemented.

---

### Task 1: Extend the renderer ready contract with stable surface scale

**Files:**

- Modify: `packages/shared/src/platform.ts`
- Modify: `packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts`
- Test: `packages/ui/test/UnifiedBrowserView.test.ts`

**Interfaces:**

- Consumes: `BrowserViewScreenshotSurfacePreparePayload.viewport` and the responsive wrapper's `data-responsive-scale`.
- Produces:

```ts
export interface BrowserViewScreenshotSurfaceReadyPayload
  extends BrowserViewScreenshotSurfacePreparePayload {
  surfaceScale: number;
}
```

- [ ] **Step 1: Write the failing renderer test**

Update the existing negative Desktop zoom case so the responsive viewport advertises the real
Fit scale and the expected ready payload includes it:

```ts
const responsiveViewport = screen.getByTestId(TID_BROWSER_RESPONSIVE_VIEWPORT);
responsiveViewport.dataset.responsiveScale = "0.625";

flushOneAnimationFrame();
expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
flushOneAnimationFrame();
expect(h.screenshotSurfaceReady).toHaveBeenCalledWith({
  ...request,
  viewport: { width: 1280, height: 720 },
  surfaceScale: 0.625,
});
```

Add a second assertion that changing `data-responsive-scale` between the first and second frame
resets stability and requires two new equal frames:

```ts
responsiveViewport.dataset.responsiveScale = "0.5";
flushOneAnimationFrame();
responsiveViewport.dataset.responsiveScale = "0.625";
flushOneAnimationFrame();
expect(h.screenshotSurfaceReady).not.toHaveBeenCalled();
flushOneAnimationFrame();
expect(h.screenshotSurfaceReady).toHaveBeenCalledWith(
  expect.objectContaining({ surfaceScale: 0.625 }),
);
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run:

```powershell
pnpm exec vitest run packages/ui/test/UnifiedBrowserView.test.ts -t "负 Desktop zoom"
```

Expected: FAIL because the ready payload does not contain `surfaceScale`, and scale changes do not
participate in the two-frame stability check.

- [ ] **Step 3: Add the strict ready payload type**

Change the shared type to:

```ts
/** Owner renderer 确认目标 guest 的逻辑 viewport 与原生预览 surface 比例均已稳定。 */
export interface BrowserViewScreenshotSurfaceReadyPayload
  extends BrowserViewScreenshotSurfacePreparePayload {
  surfaceScale: number;
}
```

The prepare and release payloads remain unchanged.

- [ ] **Step 4: Implement stable surface scale reading**

In `useBrowserScreenshotSurfaceReady.ts`, add:

```ts
const SURFACE_SCALE_EPSILON = 0.001;

interface StableScreenshotSurface {
  surfaceScale: number;
  viewport: BrowserViewportSize;
}

function readSurfaceScale(webview: ElectronWebviewTag): number {
  const responsiveViewport = webview.closest<HTMLElement>("[data-responsive-scale]");
  const value = Number(responsiveViewport?.dataset.responsiveScale);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function sameSurface(
  left: StableScreenshotSurface,
  right: StableScreenshotSurface,
): boolean {
  return (
    withinOnePixel(left.viewport, right.viewport) &&
    Math.abs(left.surfaceScale - right.surfaceScale) <= SURFACE_SCALE_EPSILON
  );
}
```

Replace the viewport-only first-frame state with:

```ts
let firstFrame: StableScreenshotSurface | null = null;
```

Inside `verify`, build and compare the complete surface:

```ts
const viewport = readSurfaceViewport(webview, request.viewport);
if (!viewport || !withinOnePixel(viewport, request.viewport)) return;
const current = { viewport, surfaceScale: readSurfaceScale(webview) };
if (!firstFrame || !sameSurface(firstFrame, current)) {
  firstFrame = current;
  verify();
  return;
}
reported = true;
platform.browserViewScreenshotSurfaceReady?.({
  ...request,
  viewport: current.viewport,
  surfaceScale: current.surfaceScale,
});
```

Keep the guest-id check, `ResizeObserver`, `dom-ready`, cancellation, and Chinese bug comment.

- [ ] **Step 5: Run renderer tests and verify GREEN**

Run:

```powershell
pnpm exec vitest run packages/ui/test/UnifiedBrowserView.test.ts
```

Expected: PASS, including normal mode fallback `surfaceScale: 1`, delayed guest identity, resize
instability, cleanup, and negative zoom.

- [ ] **Step 6: Commit the renderer contract**

```powershell
git add -- packages/shared/src/platform.ts packages/ui/src/browser-use/useBrowserScreenshotSurfaceReady.ts packages/ui/test/UnifiedBrowserView.test.ts
git commit -m "fix(browser-use): report screenshot surface scale"
```

---

### Task 2: Carry validated surface scale through the Desktop coordinator lease

**Files:**

- Modify: `packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts`
- Test: `packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts`
- Test: `packages/desktop/test/preloadDisposer.test.ts`
- Test: `packages/desktop/test/desktopBrowserViewIpc.test.ts`

**Interfaces:**

- Consumes: `BrowserViewScreenshotSurfaceReadyPayload.surfaceScale`.
- Produces:

```ts
export interface BrowserScreenshotSurfaceLease {
  surfaceScale: number;
  webContentsId: number;
  viewport: BrowserViewportSize;
  release(): void;
}
```

- [ ] **Step 1: Write failing coordinator tests**

Add `surfaceScale: 0.625` to valid ready payloads and assert the lease returns it:

```ts
coordinator.handleReady({
  windowId: 7,
  senderWebContentsId: 700,
  payload: {
    ...input,
    viewport: { width: 1275, height: 719 },
    surfaceScale: 0.625,
  },
});

await expect(pending).resolves.toMatchObject({
  surfaceScale: 0.625,
  webContentsId: 42,
  viewport: { width: 1275, height: 719 },
});
```

Add a timeout test that sends `0`, `NaN`, and `Infinity`; none may resolve the request:

```ts
for (const surfaceScale of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
  coordinator.handleReady({
    windowId: 7,
    senderWebContentsId: 700,
    payload: { ...input, surfaceScale },
  });
}
expect(sendRelease).not.toHaveBeenCalled();
```

Then send `{ ...input, surfaceScale: 1 }` and verify the original pending request resolves.

- [ ] **Step 2: Run coordinator tests and verify RED**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts
```

Expected: FAIL because the lease has no `surfaceScale` and invalid values are not rejected.

- [ ] **Step 3: Validate and persist ready surface scale**

Add to `PreparationGroup`:

```ts
readySurfaceScale?: number;
```

In `handleReady`, reject invalid values before `finishGroupReady`:

```ts
if (
  !Number.isFinite(input.payload.surfaceScale) ||
  input.payload.surfaceScale <= 0
) {
  this.options.log?.("[browser-screenshot-surface] ignored ready with invalid surface scale");
  return;
}
```

Change the ready transition and lease:

```ts
private finishGroupReady(
  group: PreparationGroup,
  viewport: BrowserViewportSize,
  surfaceScale: number,
): void {
  group.ready = true;
  group.readyViewport = viewport;
  group.readySurfaceScale = surfaceScale;
  // existing request resolution remains unchanged
}
```

```ts
return {
  surfaceScale: group.readySurfaceScale ?? 1,
  webContentsId: group.payload.webContentsId,
  viewport: group.readyViewport ?? group.payload.viewport,
  release: releaseOnce(() => {
    group.leaseCount -= 1;
    if (group.leaseCount === 0) this.settleGroup(group);
  }),
};
```

- [ ] **Step 4: Update bridge fixtures without changing transport behavior**

Update ready payload fixtures in preload and IPC tests to include:

```ts
surfaceScale: 1,
```

The bridge must still forward the payload unchanged and accept only the trusted sender window.

- [ ] **Step 5: Run coordinator and bridge tests and verify GREEN**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts packages/desktop/test/preloadDisposer.test.ts packages/desktop/test/desktopBrowserViewIpc.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the coordinator contract**

```powershell
git add -- packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts packages/desktop/test/preloadDisposer.test.ts packages/desktop/test/desktopBrowserViewIpc.test.ts
git commit -m "fix(browser-use): validate screenshot surface scale"
```

---

### Task 3: Apply and restore capture-only guest metrics around screenshots

**Files:**

- Modify: `packages/desktop/src/main/browserView/browserGuestManager.ts`
- Test: `packages/desktop/test/browserGuestManager.test.ts`

**Interfaces:**

- Consumes: `BrowserScreenshotSurfaceLease.surfaceScale`.
- Produces:

```ts
function resolveScreenshotMetricsScale(
  desktopZoomFactor: number | undefined,
  surfaceScale: number,
): number;
```

- [ ] **Step 1: Make screenshot coordinator fixtures return scale**

Update `createReadyScreenshotSurfaceCoordinator` and local coordinator fakes:

```ts
return {
  surfaceScale: 1,
  webContentsId: input.webContentsId,
  viewport: input.viewport,
  release,
};
```

For the new raster test, return `surfaceScale: 0.625`.

- [ ] **Step 2: Write the failing apply/capture/restore order test**

Create an agent viewport, clear setup calls, execute a screenshot, and assert the CDP order:

```ts
await mgr.updateViewportFromRenderer(
  "tab-209",
  { width: 1280, height: 720 },
  0,
  Math.pow(1.1, -2),
);
spy.cdpCalls.length = 0;

await expect(mgr.execute("tab-209", { method: "screenshot" })).resolves.toMatchObject({
  ok: true,
});

const relevant = spy.cdpCalls.filter(({ method }) =>
  [
    "Emulation.setDeviceMetricsOverride",
    "Page.captureScreenshot",
  ].includes(method),
);
expect(relevant).toEqual([
  {
    method: "Emulation.setDeviceMetricsOverride",
    params: expect.objectContaining({
      width: 1280,
      height: 720,
      dontSetVisibleSize: true,
      scale: 1.6,
    }),
  },
  { method: "Page.captureScreenshot", params: expect.any(Object) },
  {
    method: "Emulation.setDeviceMetricsOverride",
    params: expect.not.objectContaining({ scale: expect.anything() }),
  },
]);
expect(release).toHaveBeenCalledOnce();
```

Also assert `guest.executeJavaScript` receives a bounded two-animation-frame compositor wait
between the apply and capture operations.

- [ ] **Step 3: Run the order test and verify RED**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/browserGuestManager.test.ts -t "capture-only"
```

Expected: FAIL because screenshot currently goes directly from lease acquisition to
`Page.captureScreenshot`.

- [ ] **Step 4: Add scale resolution and metrics builder support**

Add:

```ts
const SCREENSHOT_COMPOSITOR_STABLE_SCRIPT =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

function resolveScreenshotMetricsScale(
  desktopZoomFactor: number | undefined,
  surfaceScale: number,
): number {
  const baseScale = normalizeDesktopZoomMetricsScale(desktopZoomFactor);
  if (!Number.isFinite(surfaceScale) || surfaceScale <= 0 || surfaceScale >= 1) {
    return baseScale;
  }
  return baseScale / surfaceScale;
}
```

Refactor the metrics builder to accept an explicit scale while leaving normal calls unchanged:

```ts
function buildViewportMetricsOverride(
  viewport: BrowserViewportSize,
  metricsScale = 1,
): Record<string, unknown> {
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
    dontSetVisibleSize: true,
    ...(metricsScale > 1 ? { scale: metricsScale } : {}),
  };
}
```

Existing viewport set/fallback calls pass
`normalizeDesktopZoomMetricsScale(tab.desktopZoomFactor)`.

- [ ] **Step 5: Serialize temporary metrics, screenshot, restore, and release**

Inside `executeScreenshotWithPreparedSurface`, retain the lease until restoration completes and
run capture inside one `enqueueViewportMutation` callback:

```ts
let result: BrowserCommandResult | undefined;
let restoreError: unknown;
const viewport = await this.readTabViewport(tab);
lease = await this.screenshotSurfaceCoordinator.prepare(/* existing identity */);
const normalMetricsScale = normalizeDesktopZoomMetricsScale(tab.desktopZoomFactor);
const captureMetricsScale = resolveScreenshotMetricsScale(
  tab.desktopZoomFactor,
  lease.surfaceScale,
);
const requiresTemporaryMetrics =
  Boolean(tab.viewportOverride || tab.backgroundViewportFallback) &&
  captureMetricsScale > normalMetricsScale + 0.001;

await this.enqueueViewportMutation(tab, async () => {
  try {
    if (requiresTemporaryMetrics) {
      await guest.debugger.sendCommand(
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(viewport, captureMetricsScale),
      );
      await guest.executeJavaScript(SCREENSHOT_COMPOSITOR_STABLE_SCRIPT, true);
    }
    if (
      running.controller.signal.aborted ||
      tab.guest !== guest ||
      guest.isDestroyed() ||
      lease?.webContentsId !== guest.id
    ) {
      throw new Error("browser guest changed while preparing screenshot raster");
    }
    running.dispatched = true;
    result = await executeBrowserCommandOnView(
      this.toControlledView(
        guest,
        Boolean(tab.viewportOverride || tab.backgroundViewportFallback),
      ),
      command,
      { signal: running.controller.signal },
    );
  } finally {
    if (requiresTemporaryMetrics && tab.guest === guest && !guest.isDestroyed()) {
      try {
        await guest.debugger.sendCommand(
          "Emulation.setDeviceMetricsOverride",
          buildViewportMetricsOverride(viewport, normalMetricsScale),
        );
      } catch (error) {
        restoreError = error;
      }
    }
  }
});
```

After the mutation:

```ts
if (restoreError) {
  throw new Error(
    `browser screenshot metrics restore failed: ${
      restoreError instanceof Error ? restoreError.message : String(restoreError)
    }`,
  );
}
if (!result) throw new Error("browser screenshot did not produce a result");
return result;
```

Keep the outer structured cancellation/backend error conversion and `lease?.release()` in its
existing `finally`. Add a Chinese comment explaining that logical viewport readiness without
capture raster scale caused Windows to tile the Fit surface.

- [ ] **Step 6: Write the failing restore-error test**

Wrap the guest CDP fake so the second metrics call throws:

```ts
let metricsCalls = 0;
guest.debugger.sendCommand = async (method, params) => {
  if (method === "Emulation.setDeviceMetricsOverride") {
    metricsCalls += 1;
    if (metricsCalls === 2) throw new Error("restore failed");
  }
  return sendCommand(method, params);
};

await expect(mgr.execute("tab-restore", { method: "screenshot" })).resolves.toMatchObject({
  ok: false,
  error: {
    code: "backend_unavailable",
    message: expect.stringContaining("metrics restore failed"),
  },
});
expect(release).toHaveBeenCalledOnce();
```

- [ ] **Step 7: Run manager tests and verify GREEN**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/browserGuestManager.test.ts
```

Expected: PASS. Existing prepare/capture/release, cancellation, timeout, backpressure, viewport
mutation, reattach, clip, fullPage, and screenshot-quality cases must remain green.

- [ ] **Step 8: Commit capture-only metrics**

```powershell
git add -- packages/desktop/src/main/browserView/browserGuestManager.ts packages/desktop/test/browserGuestManager.test.ts
git commit -m "fix(browser-use): scale screenshot capture raster"
```

---

### Task 4: Prove the Electron mechanism against an 800 × 450 Fit surface

**Files:**

- Modify: `packages/desktop/scripts/browser-screenshot-surface-smoke.mjs`
- Test: `packages/desktop/scripts/browser-screenshot-surface-smoke.mjs`

**Interfaces:**

- Consumes: Electron guest CDP `Emulation.setDeviceMetricsOverride` and
  `Page.captureScreenshot(fromSurface=true)`.
- Produces the existing one-line success JSON with `1280 × 720`, distinct corners, and no
  `800 × 450` periodic repeat.

- [ ] **Step 1: Change the smoke fixture to reproduce the product geometry**

Use:

```js
const VIEWPORT = { width: 1280, height: 720 };
const INITIAL_SURFACE = { width: 800, height: 450 };
const SURFACE_SCALE = INITIAL_SURFACE.width / VIEWPORT.width;
```

Keep the host capture layer at `800 × 450`, set Desktop zoom level `-2`, and give the guest a
logical `1280 × 720` viewport with `dontSetVisibleSize: true`.

- [ ] **Step 2: Run the smoke without capture correction and verify RED**

Temporarily execute the baseline branch before applying capture scale:

```powershell
$env:ZCODE_SCREENSHOT_SMOKE_SCALE_FACTOR='1.25'
pnpm --filter @zcode/desktop test:browser-screenshot-surface-smoke
```

Expected: non-zero exit with `stale tiled surface detected` or a corner sentinel mismatch.

- [ ] **Step 3: Apply the capture-only scale in the smoke**

Before capture, send:

```js
await guest.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
  width: VIEWPORT.width,
  height: VIEWPORT.height,
  deviceScaleFactor: 1,
  mobile: false,
  dontSetVisibleSize: true,
  scale: 1 / SURFACE_SCALE,
});
await guest.executeJavaScript(
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  true,
);
```

Capture, validate, and restore the normal metrics override in `finally`.

- [ ] **Step 4: Run the corrected smoke and verify GREEN**

Run:

```powershell
$env:ZCODE_SCREENSHOT_SMOKE_SCALE_FACTOR='1.25'
pnpm --filter @zcode/desktop test:browser-screenshot-surface-smoke
Remove-Item Env:ZCODE_SCREENSHOT_SMOKE_SCALE_FACTOR
```

Expected stdout:

```json
{"width":1280,"height":720,"periodicRepeat":false,"corners":"distinct"}
```

- [ ] **Step 5: Commit the native smoke**

```powershell
git add -- packages/desktop/scripts/browser-screenshot-surface-smoke.mjs
git commit -m "test(browser-use): cover fitted screenshot raster"
```

---

### Task 5: Verify the full product and correct the runtime evidence

**Files:**

- Modify: `docs/browser-use/2026-07-15-responsive-browser-viewport-spec.md`
- Modify: `docs/testing/browser-use-codex-parity-coverage-matrix.md`

**Interfaces:**

- Consumes: Tasks 1-4.
- Produces: final automated/runtime evidence and a restarted dev desktop.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
pnpm exec vitest run packages/ui/test/UnifiedBrowserView.test.ts packages/desktop/test/browserScreenshotSurfaceCoordinator.test.ts packages/desktop/test/preloadDisposer.test.ts packages/desktop/test/desktopBrowserViewIpc.test.ts packages/desktop/test/browserGuestManager.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run mechanical repository checks**

Run:

```powershell
pnpm typecheck
pnpm lint
```

Expected: both exit `0`.

- [ ] **Step 3: Restart the dev desktop**

Stop only the dev processes launched from
`C:\Users\dev\z-code\.worktrees\fix-browser-screenshot-negative-zoom`, verify their resolved
paths, and restart the existing dev command with hidden helper windows. Confirm the Electron main
process is alive and CDP port `9229` responds.

- [ ] **Step 4: Run a real Browser Use screenshot**

At Desktop zoom `-2`, ask the real model to open `https://example.com` and execute exactly one
explicit:

```js
nodeRepl.emitImage(await tab.screenshot());
```

Record the explicit request id and the automatic turn-tail request id separately.

- [ ] **Step 5: Inspect screenshot content**

Decode the displayed tool-result PNG and assert:

```text
IHDR = 1280 × 720
horizontal 800px shift is not an exact/near-exact match
vertical 450px shift is not an exact/near-exact match
Example Domain appears once at the expected viewport position
```

Display the image for manual visual inspection. Do not accept only backend `ok=true`.

- [ ] **Step 6: Update runtime evidence**

Change RBV-043 and BCP-213 from `fix pending` to the exact test/smoke/product result. Include
Windows display scale, Desktop zoom, output dimensions, periodic-match measurements, and the
remaining macOS/Linux CI risk.

- [ ] **Step 7: Run final diff and status checks**

Run:

```powershell
git diff --check
git status --short
```

Expected: only intended docs/source/test files plus the known untracked dev log files.

- [ ] **Step 8: Commit final evidence**

```powershell
git add -- docs/browser-use/2026-07-15-responsive-browser-viewport-spec.md docs/testing/browser-use-codex-parity-coverage-matrix.md
git commit -m "docs(browser-use): verify fitted screenshot raster"
```
