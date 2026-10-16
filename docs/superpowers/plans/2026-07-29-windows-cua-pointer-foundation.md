# Windows CUA Pointer Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the five existing raw pointer tools work safely in the Windows source Helper with app scope, frontmost-PID verification, virtual-desktop coordinates, and terminal input cleanup.

**Architecture:** Keep the flat 30-tool MCP surface and the existing tool → broker → Node adapter → native addon chain. The tool layer carries the resolved `app_ref`; the Windows broker validates that identity against the unique live frontmost PID immediately before global `SendInput`; `ax_win.cc` owns virtual-desktop mapping, pointer synthesis, held-input tracking, and terminal release.

**Tech Stack:** TypeScript 5.9, Vitest 4, Node 24, N-API/node-addon-api 7, C++17, Windows UI Automation, Win32 `SendInput`, pnpm 10.

**Execution order:** First complete
`2026-07-29-windows-cua-capability-truthfulness.md`, then execute this plan.
The two plans intentionally share `src/native/ax_win.cc` and
`docs/platforms.md`; this plan must preserve the already-landed truthful
screenshot/clipboard behavior while adding pointer support.

## Global Constraints

- Work only in `C:\Users\dev\zcode-cua` and the local Windows desktop CUA integration in `C:\Users\dev\z-code`.
- Do not start, attach, or change SSH, WSL, Docker, remote workspace, mobile `/remote`, or replayable realtime paths.
- Do not add or rename MCP tools; `TOOL_NAMES`, `TOOL_REGISTRY`, `TIER_TABLE`, and the evaluator manifest remain at 30 tools.
- Keep all native Windows behavior behind the existing broker and optional native adapter ABI.
- Raw Windows pointer input must require a resolvable application scope and the unique live frontmost PID, except cleanup-only `mouse_up`.
- Preserve `possibly_sent`; never automatically replay a side-effecting action after an ambiguous transport failure.
- Use `SM_XVIRTUALSCREEN`, `SM_YVIRTUALSCREEN`, `SM_CXVIRTUALSCREEN`, `SM_CYVIRTUALSCREEN`, and `MOUSEEVENTF_VIRTUALDESK`.
- Any down/drag failure and terminal Helper shutdown must release only input state owned by this Helper.
- Keep macOS and Linux dispatch behavior unchanged.
- Add Chinese root-cause comments for every fixed bug.
- Use asynchronous IO; do not introduce shell, PowerShell, BitBlt, or external-command pointer fallbacks.
- Run `pnpm typecheck` and `pnpm lint` in both repositories before completion.

## File Map

`C:\Users\dev\zcode-cua`:

- Modify `src/tools/pointer.ts`: retain the resolved `app_ref`, validate drag endpoint scope, and send `app_ref` on pointer broker calls.
- Modify `test/pointer-tools.test.ts`: lock the tool-to-broker scope contract and drag mismatch refusal.
- Modify `src/broker/server/electronInputHandlers.ts`: apply a Windows-only strict app identity/frontmost gate to global pointer methods.
- Modify `src/broker/server/electronNativeBackend.ts`: pass `brokerInfo.platform` into the input-handler factory.
- Modify `src/broker/server/brokerServer.ts`: refuse to report clean stop when native input cleanup fails.
- Modify `src/broker/server/helperMain.ts`: propagate the native cleanup result into terminal broker shutdown.
- Create `test/windows-pointer-foreground-gate.test.ts`: focused broker tests for Windows frontmost/refusal/cleanup behavior.
- Create `test/broker-terminal-input-cleanup.test.ts`: prove cleanup failure blocks a clean stop and remains retryable.
- Modify `src/native/ax_win.cc`: virtual-desktop normalization, five pointer primitives, tracked input state, and terminal cleanup.
- Modify `src/native/types.ts`: declare the five pointer functions and `cancelPendingInputHolds`.
- Create `test/native/windows-input-dispatch.test.ts`: Windows source/ABI regression tests plus compiled-addon export checks.
- Create `scripts/windows-pointer-live-smoke.mjs`: opt-in, real source-Helper broker smoke that restores the cursor and verifies terminal cleanup.
- Modify `package.json`: add a named opt-in Windows pointer smoke command.
- Modify `docs/platforms.md`: record the implemented pointer capability and remaining WGC/UIA-worker limits.

`C:\Users\dev\z-code`:

- Modify `docs/cua/windows-source-development.md`: add rebuild, direct smoke, source desktop, and cleanup verification commands.

---

### Task 1: Preserve Pointer Application Scope on the Broker Wire

**Files:**

- Modify: `C:\Users\dev\zcode-cua\test\pointer-tools.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\tools\pointer.ts`

**Interfaces:**

- Consumes: `resolveTarget(target, { session, screenSize }) -> ResolvedTarget` where `ResolvedTarget.app_ref` is the cached app or coordinate scope.
- Produces: pointer broker params containing `app_ref`; drag emits one reconciled `app_ref` shared by both endpoints.

- [ ] **Step 1: Write failing scope-forwarding tests**

Add assertions that the element state from `primeSession()` produces:

```ts
const EXPECTED_APP_REF = {
  bundle_id: "com.example",
  pid: 1234,
  name: "Example",
  window_id: 9,
};

expect(calls[0]!.params).toMatchObject({
  point: ELEMENT_POINT,
  app_ref: EXPECTED_APP_REF,
});
```

Cover `scroll(strategy:"event")`, `mouse_move`, and `left_mouse_down`.

For coordinate targets, use:

```ts
const SCOPED_COORD_TARGET = {
  type: "coordinate",
  x: 120,
  y: 80,
  space: "screen",
  app_ref: { pid: 1234, bundle_id: "com.example" },
};
```

and assert the same `app_ref` is present on the wire.

Add explicit override coverage:

```ts
await handler(
  "mouse_move",
  deps,
)({
  coordinate: SCOPED_COORD_TARGET,
  app_ref: { pid: 7777, bundle_id: "com.override" },
});

expect(calls[0]!.params.app_ref).toEqual({
  pid: 7777,
  bundle_id: "com.override",
});
```

Add drag coverage:

```ts
await handler(
  "left_click_drag",
  deps,
)({
  from_target: {
    type: "coordinate",
    x: 10,
    y: 20,
    space: "screen",
    app_ref: { pid: 1234, bundle_id: "com.example" },
  },
  to: {
    type: "coordinate",
    x: 30,
    y: 40,
    space: "screen",
    app_ref: { pid: 1234, bundle_id: "com.example" },
  },
});

expect(calls[0]!.params).toMatchObject({
  start: { x: 10, y: 20 },
  end: { x: 30, y: 40 },
  app_ref: { pid: 1234, bundle_id: "com.example" },
});
```

Add a mismatched-PID test that expects `isError:true` and zero broker calls.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
cd C:\Users\dev\zcode-cua
pnpm exec vitest run test/pointer-tools.test.ts
```

Expected: scope assertions fail because the current wire params omit `app_ref`; the mismatched drag currently calls the broker.

- [ ] **Step 3: Implement resolved scope propagation**

In `src/tools/pointer.ts`, replace the point-only helper with a scoped result:

```ts
interface ResolvedPointerTarget {
  point: Point;
  appRef: unknown;
  isElement: boolean;
}

function resolvePointerTarget(
  target: unknown,
  options?: { screenSize?: ScreenSize },
): ResolvedPointerTarget | CallToolResult {
  try {
    const resolved = resolveTarget(target, {
      session: getDefaultSession(),
      ...(options?.screenSize ? { screenSize: () => options.screenSize! } : {}),
    });
    if (!resolved.point) {
      return toolError(
        "target did not resolve to a screen point; use an on-screen coordinate target.",
      );
    }
    return {
      point: resolved.point,
      appRef: resolved.app_ref ?? null,
      isElement: resolved.isElement,
    };
  } catch (error) {
    if (error instanceof TargetResolveError) return toolError(error.message);
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function selectedPointerAppRef(explicitAppRef: unknown, resolvedAppRef: unknown): unknown {
  return explicitAppRef ?? resolvedAppRef ?? null;
}
```

Use a stable identity key for drag endpoint comparison:

```ts
function pointerAppRefKey(value: unknown): string | null {
  if (typeof value === "string") {
    const identity = value.trim().toLocaleLowerCase();
    return identity ? `identity:${identity}` : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0) {
    return `pid:${record.pid}`;
  }
  const bundleId =
    typeof record.bundle_id === "string" ? record.bundle_id.trim().toLocaleLowerCase() : "";
  if (bundleId) return `identity:${bundleId}`;
  const name = typeof record.name === "string" ? record.name.trim().toLocaleLowerCase() : "";
  return name ? `name:${name}` : null;
}
```

For drag, select explicit `args.app_ref` first. Without an explicit scope, both
endpoints must expose the same non-null key; one missing key or two different
keys means the tool cannot prove a single target application:

```ts
const startKey = pointerAppRefKey(start.appRef);
const endKey = pointerAppRefKey(end.appRef);
if (!args.app_ref && (!startKey || !endKey || startKey !== endKey)) {
  return toolError(
    "left_click_drag refused because from_target and to do not prove the same application scope.",
  );
}
const appRef = args.app_ref ?? start.appRef;
```

Forward `app_ref` for `scroll`, `drag`, `move_to`, and `mouse_down`. Do not add it to cleanup-only `mouse_up`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
pnpm exec vitest run test/pointer-tools.test.ts
```

Expected: all tests in the file pass; the five new scope cases pass and cross-app drag makes zero broker calls.

- [ ] **Step 5: Run schema and resolver regressions**

Run:

```powershell
pnpm exec vitest run test/schemas-tools.test.ts test/targeting-resolver.test.ts test/targeting-screenshot-space.test.ts
```

Expected: all selected files pass; no tool schema or coordinate mapping changes.

- [ ] **Step 6: Commit the tool-layer contract**

```powershell
git add -- src/tools/pointer.ts test/pointer-tools.test.ts
git commit -m "fix(pointer): preserve application scope"
```

---

### Task 2: Enforce the Windows Frontmost-PID Gate

**Files:**

- Create: `C:\Users\dev\zcode-cua\test\windows-pointer-foreground-gate.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronInputHandlers.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronNativeBackend.ts`

**Interfaces:**

- Consumes: broker params `{ app_ref, point/start/end, ... }` from Task 1.
- Produces: `createElectronInputHandlers({ adapter, axSource, platform })`; Windows global pointer actions dispatch only when `app_ref` resolves to the unique active PID.

- [ ] **Step 1: Create failing Windows gate tests**

Create a focused test with:

```ts
const target = {
  pid: 4321,
  name: "Target",
  bundle_id: "C:\\Apps\\Target.exe",
  active: true,
};
const other = {
  pid: 9999,
  name: "Other",
  bundle_id: "C:\\Apps\\Other.exe",
  active: false,
};

const axSource = {
  listApplications: vi.fn(async () => [target, other]),
  applicationInfo: vi.fn(async (appRef: { pid?: number }) =>
    appRef.pid === target.pid ? target : null,
  ),
} as unknown as AxReadOnlySource;
```

Create an adapter whose `moveTo`, `scrollAt`, `drag`, `mouseDown`, and
`mouseUp` are spies returning `true`, and whose `isFocusStealPrevented`
returns `false`.

Call:

```ts
const handlers = createElectronInputHandlers({
  adapter,
  axSource,
  platform: "win32",
});
```

Test all of:

- scoped move/scroll/drag/down dispatch when target is the unique active PID;
- missing `app_ref` rejects before native dispatch;
- unresolved `app_ref` rejects before native dispatch;
- a different active PID rejects before native dispatch;
- two active applications reject before native dispatch;
- `listApplications()` failure rejects before native dispatch;
- `mouse_up` succeeds for the session holder after the active PID changes;
- `platform:"darwin"` keeps the existing non-Windows fallback behavior.

Use `await expect(...).rejects.toMatchObject({ code: "element_unavailable" })`
for Windows identity failures.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
pnpm exec vitest run test/windows-pointer-foreground-gate.test.ts
```

Expected: TypeScript/runtime failure because `platform` is not accepted and Windows pointer actions do not inspect `app_ref`.

- [ ] **Step 3: Generalize the existing click frontmost helper**

Change:

```ts
async function assertExpectedPidIsFrontmost(
  axSource: AxReadOnlySource | undefined,
  expectedPid: number,
  point: { x: number; y: number },
): Promise<void>;
```

to:

```ts
async function assertExpectedPidIsFrontmost(
  axSource: AxReadOnlySource | undefined,
  expectedPid: number,
  method: string,
  point?: { x: number; y: number },
): Promise<void>;
```

Use `${method}` in every error and include the point only when provided. Update
the existing raw-click call site to pass `"click"`.

- [ ] **Step 4: Add strict Windows pointer identity resolution**

Extend the factory:

```ts
export function createElectronInputHandlers(options: {
  adapter: ElectronAutomationAdapter;
  axSource: AxReadOnlySource | undefined;
  allowAxHitTestClick?: boolean;
  platform?: NodeJS.Platform;
});
```

Set:

```ts
const platform = options.platform ?? process.platform;
```

Add:

```ts
async function resolveWindowsPointerIdentity(
  axSource: AxReadOnlySource | undefined,
  appRefValue: unknown,
  method: string,
): Promise<{ pid: number; bundleId: string }> {
  const identity = await tryResolvePointerAppPid(axSource, appRefValue, method);
  if (!identity) {
    throw elementUnavailable(
      `${method}: Windows global pointer input requires a live, unique app_ref; refresh get_app_state and retry.`,
    );
  }
  await assertExpectedPidIsFrontmost(axSource, identity.pid, method);
  return identity;
}
```

For `move_to`, `scroll`, `drag`, and `mouse_down`, when
`platform === "win32"`:

1. await `resolveWindowsPointerIdentity(...)`;
2. run the existing global native method;
3. never use the soft “resolve failure → unchecked global fallback” path.

Leave `mouse_up` holder validation and cleanup dispatch unchanged.

- [ ] **Step 5: Pass the backend platform into the handler factory**

In `electronNativeBackend.ts`:

```ts
...createElectronInputHandlers({
  adapter,
  axSource,
  allowAxHitTestClick: true,
  platform: brokerInfo.platform,
}),
```

- [ ] **Step 6: Run focused broker tests and verify GREEN**

Run:

```powershell
pnpm exec vitest run test/windows-pointer-foreground-gate.test.ts test/click-owner-pid-verify.test.ts
```

Expected: all tests pass; existing click owner-PID behavior remains green.

- [ ] **Step 7: Run input-handler regression files**

Run:

```powershell
pnpm exec vitest run test/handler-clamp-behavior.test.ts test/tool-return-shape.parity.test.ts test/f3-resolver-integration.test.ts
```

Expected: all selected files pass.

- [ ] **Step 8: Commit the broker gate**

```powershell
git add -- src/broker/server/electronInputHandlers.ts src/broker/server/electronNativeBackend.ts test/windows-pointer-foreground-gate.test.ts
git commit -m "fix(windows): gate pointer input by foreground app"
```

---

### Task 3: Correct Virtual-Desktop Coordinate Mapping

**Files:**

- Create: `C:\Users\dev\zcode-cua\test\native\windows-input-dispatch.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\ax_win.cc`

**Interfaces:**

- Consumes: finite screen coordinates in the same coordinate space as UIA bounds and `GetCursorPos`.
- Produces: a pure bounds-injected normalization function,
  `bool PixelToVirtualAbsolute(double x, double y, LONG* ax, LONG* ay)`,
  compile-time edge-case proofs, and virtual-desktop `INPUT` events.

- [ ] **Step 1: Write failing native source-contract tests**

Read `src/native/ax_win.cc` as UTF-8 and assert:

```ts
expect(source).toContain("SM_XVIRTUALSCREEN");
expect(source).toContain("SM_YVIRTUALSCREEN");
expect(source).toContain("SM_CXVIRTUALSCREEN");
expect(source).toContain("SM_CYVIRTUALSCREEN");
expect(source).toContain("MOUSEEVENTF_VIRTUALDESK");
expect(source).toContain("bool PixelToVirtualAbsolute");
expect(source).not.toContain("GetSystemMetrics(SM_CXSCREEN)");
expect(source).not.toContain("GetSystemMetrics(SM_CYSCREEN)");
expect(source).not.toContain("cx = 1920");
expect(source).not.toContain("cy = 1080");
expect(source).toContain("NormalizeVirtualDesktopPoint");
expect(source).toContain("static_assert");
```

Assert `SendClickAt` checks the conversion result before `SendInputs`. Also
assert the source contains compile-time cases for:

- a negative-coordinate secondary-display origin;
- both virtual-desktop edges mapping to `0` and `65535`;
- an out-of-bounds point returning `ok=false`;
- width or height `<=1` returning `ok=false`.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
pnpm exec vitest run test/native/windows-input-dispatch.test.ts
```

Expected: failures show the current primary-monitor constants and missing virtual-desktop flags.

- [ ] **Step 3: Implement fail-closed virtual-desktop conversion**

Split bounds-independent arithmetic from the Win32 metrics read:

```cpp
struct VirtualDesktopBounds {
  LONG left;
  LONG top;
  LONG width;
  LONG height;
};

bool ReadVirtualDesktopBounds(VirtualDesktopBounds* out) {
  if (!out) return false;
  const int left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const int top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (width <= 1 || height <= 1) return false;
  *out = {left, top, width, height};
  return true;
}

struct NormalizedVirtualDesktopPoint {
  bool ok;
  LONG x;
  LONG y;
};

constexpr NormalizedVirtualDesktopPoint NormalizeVirtualDesktopPoint(
    double x, double y, VirtualDesktopBounds desktop) {
  if (desktop.width <= 1 || desktop.height <= 1) return {false, 0, 0};
  const double right =
      static_cast<double>(desktop.left) + desktop.width - 1;
  const double bottom =
      static_cast<double>(desktop.top) + desktop.height - 1;
  if (x < desktop.left || x > right || y < desktop.top || y > bottom) {
    return {false, 0, 0};
  }
  const double normalizedX =
      ((x - desktop.left) * 65535.0) / (desktop.width - 1);
  const double normalizedY =
      ((y - desktop.top) * 65535.0) / (desktop.height - 1);
  return {
      true,
      static_cast<LONG>(normalizedX + 0.5),
      static_cast<LONG>(normalizedY + 0.5),
  };
}

bool PixelToVirtualAbsolute(double x, double y, LONG* ax, LONG* ay) {
  if (!ax || !ay || !std::isfinite(x) || !std::isfinite(y)) return false;
  VirtualDesktopBounds desktop{};
  if (!ReadVirtualDesktopBounds(&desktop)) return false;
  const auto normalized = NormalizeVirtualDesktopPoint(x, y, desktop);
  if (!normalized.ok) return false;
  *ax = normalized.x;
  *ay = normalized.y;
  return true;
}
```

Add `static_assert` cases immediately after the pure function. Use explicit
topologies and exact expected values, for example a
`{-1920, 0, 3840, 1080}` desktop maps `(-1920, 0)` to `(0, 0)` and
`(1919, 1079)` to `(65535, 65535)`. Add separate assertions for out-of-range
and degenerate dimensions. These assertions compile with the production
function and therefore cannot drift from the code used by `SendInput`.

Update mouse `INPUT` flags to include:

```cpp
MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
```

for absolute move and any absolute click/drag packets. Reject invalid conversion
before constructing an input vector.

- [ ] **Step 4: Run the source-contract test and verify GREEN**

Run:

```powershell
pnpm exec vitest run test/native/windows-input-dispatch.test.ts
```

Expected: all virtual-desktop source assertions pass.

- [ ] **Step 5: Rebuild the native addon**

Run:

```powershell
pnpm rebuild:native
Test-Path .\build\Release\ax_native.node
```

Expected: native rebuild exits `0`; `Test-Path` prints `True`.

- [ ] **Step 6: Run existing Windows native identity tests**

Run:

```powershell
pnpm exec vitest run test/windows-open-application-identity.test.ts test/native/control-type-to-kind.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit virtual-desktop support**

```powershell
git add -- src/native/ax_win.cc test/native/windows-input-dispatch.test.ts
git commit -m "fix(windows): use virtual desktop pointer coordinates"
```

---

### Task 4: Implement the Five Windows Pointer Primitives

**Files:**

- Modify: `C:\Users\dev\zcode-cua\test\native\windows-input-dispatch.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\types.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\ax_win.cc`

**Interfaces:**

- Consumes: existing `ElectronAutomationAdapter` optional method names already wrapped by `createNodeAutomationAdapter`.
- Produces: native exports `moveTo`, `scrollAt`, `drag`, `mouseDown`, and `mouseUp`, each returning `boolean`.

- [ ] **Step 1: Extend the native tests for missing exports and safety structure**

Add source assertions for:

```ts
for (const name of ["moveTo", "scrollAt", "drag", "mouseDown", "mouseUp"]) {
  expect(source).toContain(`exports.Set("${name}", Napi::Function::New(env,`);
}
expect(source).toContain("MOUSEEVENTF_WHEEL");
expect(source).toContain("MOUSEEVENTF_HWHEEL");
expect(source).toContain("WHEEL_DELTA");
expect(source).toContain("if (downPosted)");
expect(source).toContain("SendMouseButtonUp");
```

At the top of the test file, create an ESM-compatible loader:

```ts
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
```

On Windows with a compiled addon:

```ts
const { available, native } = require("../../src/native/win.cjs");
for (const name of ["moveTo", "scrollAt", "drag", "mouseDown", "mouseUp"]) {
  expect(typeof native[name]).toBe("function");
}
```

Skip only the runtime-export block when the compiled addon is unavailable; never skip the source-contract block.

- [ ] **Step 2: Run the native test and verify RED**

Run:

```powershell
pnpm exec vitest run test/native/windows-input-dispatch.test.ts
```

Expected: the five export and implementation assertions fail.

- [ ] **Step 3: Extend the TypeScript native contract**

In `AxWinNativeAddon`, add:

```ts
moveTo?(x: number, y: number): boolean;
scrollAt?(x: number, y: number, delta: number, direction: string): boolean;
drag?(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  button: string,
): boolean;
mouseDown?(button: string): boolean;
mouseUp?(button: string): boolean;
```

- [ ] **Step 4: Implement reusable mouse packet helpers**

In `ax_win.cc`, add:

```cpp
bool ResolveMouseButton(
    const std::string& button, DWORD* downFlag, DWORD* upFlag) {
  if (!downFlag || !upFlag) return false;
  if (button == "left") {
    *downFlag = MOUSEEVENTF_LEFTDOWN;
    *upFlag = MOUSEEVENTF_LEFTUP;
    return true;
  }
  if (button == "right") {
    *downFlag = MOUSEEVENTF_RIGHTDOWN;
    *upFlag = MOUSEEVENTF_RIGHTUP;
    return true;
  }
  if (button == "middle") {
    *downFlag = MOUSEEVENTF_MIDDLEDOWN;
    *upFlag = MOUSEEVENTF_MIDDLEUP;
    return true;
  }
  return false;
}

bool SendAbsoluteMove(double x, double y) {
  LONG ax = 0;
  LONG ay = 0;
  if (!PixelToVirtualAbsolute(x, y, &ax, &ay)) return false;
  INPUT input{};
  input.type = INPUT_MOUSE;
  input.mi.dx = ax;
  input.mi.dy = ay;
  input.mi.dwFlags =
      MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  return SendInputs(&input, 1);
}
```

Use the same button resolver from the existing click function.

- [ ] **Step 5: Implement move and scroll**

`MoveTo` validates two finite numbers and calls `SendAbsoluteMove`.

`ScrollAt` validates point, integer `delta` in `[0,100]`, and one of
`up/down/left/right`; it moves first, then:

```cpp
if (delta == 0) return true;
INPUT input{};
input.type = INPUT_MOUSE;
if (direction == "up" || direction == "down") {
  input.mi.dwFlags = MOUSEEVENTF_WHEEL;
  input.mi.mouseData = static_cast<DWORD>(
      static_cast<LONG>(direction == "up" ? delta * WHEEL_DELTA
                                           : -delta * WHEEL_DELTA));
} else {
  input.mi.dwFlags = MOUSEEVENTF_HWHEEL;
  input.mi.mouseData = static_cast<DWORD>(
      static_cast<LONG>(direction == "right" ? delta * WHEEL_DELTA
                                              : -delta * WHEEL_DELTA));
}
return SendInputs(&input, 1);
```

- [ ] **Step 6: Implement down, up, and drag with guaranteed pair release**

`MouseDown` and `MouseUp` validate the button and send exactly one matching packet.

`Drag`:

1. validates finite endpoints and a known button;
2. moves to the start;
3. sends down and sets `downPosted=true`;
4. emits exactly 12 bounded interpolated absolute moves;
5. always calls `SendMouseButtonUp` after a successful down;
6. returns true only when every required packet and the final up succeeded.

Use:

```cpp
bool ok = SendAbsoluteMove(fromX, fromY);
bool downPosted = false;
if (ok) {
  ok = SendMouseButtonDown(button);
  downPosted = ok;
}
for (int step = 1; ok && step <= 12; ++step) {
  const double ratio = static_cast<double>(step) / 12.0;
  ok = SendAbsoluteMove(
      fromX + ((toX - fromX) * ratio),
      fromY + ((toY - fromY) * ratio));
}
bool released = true;
if (downPosted) released = SendMouseButtonUp(button);
return ok && released;
```

- [ ] **Step 7: Export the functions**

Add:

```cpp
exports.Set("moveTo", Napi::Function::New(env, MoveTo));
exports.Set("scrollAt", Napi::Function::New(env, ScrollAt));
exports.Set("drag", Napi::Function::New(env, Drag));
exports.Set("mouseDown", Napi::Function::New(env, MouseDown));
exports.Set("mouseUp", Napi::Function::New(env, MouseUp));
```

- [ ] **Step 8: Rebuild and run the native tests**

Run:

```powershell
pnpm rebuild:native
pnpm exec vitest run test/native/windows-input-dispatch.test.ts
```

Expected: rebuild exits `0`; source and compiled-addon export tests pass.

- [ ] **Step 9: Run Node adapter tests**

Run:

```powershell
pnpm exec vitest run test/native/input-dispatch.test.ts test/broker/windowsSystemSurface.test.ts
```

Expected: existing platform-neutral adapter tests pass.

- [ ] **Step 10: Commit the pointer primitives**

```powershell
git add -- src/native/ax_win.cc src/native/types.ts test/native/windows-input-dispatch.test.ts
git commit -m "feat(windows): add raw pointer primitives"
```

---

### Task 5: Track and Release Helper-Owned Input State

**Files:**

- Modify: `C:\Users\dev\zcode-cua\test\native\windows-input-dispatch.test.ts`
- Create: `C:\Users\dev\zcode-cua\test\broker-terminal-input-cleanup.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\types.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\ax_win.cc`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\brokerServer.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\helperMain.ts`

**Interfaces:**

- Consumes: `helperMain.ts` already invokes optional `native.cancelPendingInputHolds()` after terminal stop is committed.
- Produces: `cancelPendingInputHolds(): boolean`; an irreversible terminal
  latch, interruptible hold wait, tracked key/button release, and a broker
  stop that rejects instead of claiming clean shutdown when cleanup fails.

- [ ] **Step 1: Add failing lifecycle assertions**

Assert the Windows source contains:

```ts
expect(source).toContain("std::atomic<bool> g_terminalInputShutdown");
expect(source).toContain("std::mutex g_inputStateMutex");
expect(source).toContain("std::mutex g_inputSequenceMutex");
expect(source).toContain("std::condition_variable g_inputStateCv");
expect(source).toContain("std::set<WORD> g_pressedKeys");
expect(source).toContain("std::set<DWORD> g_pressedMouseUpFlags");
expect(source).toContain("Napi::Value CancelPendingInputHolds");
expect(source).toContain(
  'exports.Set("cancelPendingInputHolds", Napi::Function::New(env, CancelPendingInputHolds))',
);
expect(source).toContain("g_terminalInputShutdown.store(true)");
expect(source).toContain("g_inputStateCv.notify_all()");
expect(source).toContain("ReleaseTrackedInputState");
```

Assert `MouseDown`, `KeyDownGlobal`, and `HoldKeyGlobalAsync` check the terminal
latch before sending input, and `MouseUp` clears tracked state only after an up
packet succeeds.

Create a broker lifecycle test with a random test socket/named pipe and a
minimal fake backend. The first `onTerminalStopCommitted` call returns
`false`; assert `server.stop()` rejects with a stable
`native input cleanup failed` message and the server does not claim a clean
stop. Then make the hook return `true` and assert a second `server.stop()`
finishes, so a transient release failure remains retryable.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
pnpm exec vitest run test/native/windows-input-dispatch.test.ts test/broker-terminal-input-cleanup.test.ts
```

Expected: native lifecycle assertions fail because Windows does not export
terminal input cleanup, and broker stop currently swallows the terminal hook
failure.

- [ ] **Step 3: Add tracked state and a terminal latch**

Add:

```cpp
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <set>

std::atomic<bool> g_terminalInputShutdown{false};
std::mutex g_inputStateMutex;
std::mutex g_inputSequenceMutex;
std::condition_variable g_inputStateCv;
std::set<WORD> g_pressedKeys;
std::set<DWORD> g_pressedMouseUpFlags;
```

Add helper functions that hold `g_inputStateMutex` across each stateful
`SendInput` call and its registry update. This closes the race where terminal
cleanup could run after a down packet was sent but before it was registered.
Register a key/button only after the corresponding down packet succeeds, and
unregister only after the corresponding up packet succeeds. Track
`MOUSEEVENTF_LEFTUP`, `MOUSEEVENTF_RIGHTUP`, and
`MOUSEEVENTF_MIDDLEUP`, not just the currently model-facing left button.
Use `g_inputSequenceMutex` with `std::try_to_lock` around complete
click/chord/hold/drag sequences. Concurrent sequences fail closed instead of
interleaving their down/up packets; terminal cleanup never takes this mutex,
so it can still wake and release a worker holding it.

- [ ] **Step 4: Implement terminal release**

Implement an interruptible wait and retry-preserving release:

```cpp
bool WaitForInputHold(int durationMs) {
  const int bounded = std::max(0, std::min(durationMs, 30000));
  std::unique_lock<std::mutex> lock(g_inputStateMutex);
  if (g_terminalInputShutdown.load(std::memory_order_acquire)) return false;
  const bool interrupted = g_inputStateCv.wait_for(
      lock,
      std::chrono::milliseconds(bounded),
      []() {
        return g_terminalInputShutdown.load(std::memory_order_acquire);
      });
  return !interrupted;
}

bool ReleaseTrackedInputState() {
  std::lock_guard<std::mutex> lock(g_inputStateMutex);
  const std::set<WORD> keys = g_pressedKeys;
  const std::set<DWORD> mouseUpFlags = g_pressedMouseUpFlags;
  bool ok = true;
  for (auto it = keys.rbegin(); it != keys.rend(); ++it) {
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = *it;
    input.ki.dwFlags = KEYEVENTF_KEYUP;
    if (SendInputs(&input, 1)) {
      g_pressedKeys.erase(*it);
    } else {
      ok = false;
    }
  }
  for (DWORD upFlag : mouseUpFlags) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dwFlags = upFlag;
    if (SendInputs(&input, 1)) {
      g_pressedMouseUpFlags.erase(upFlag);
    } else {
      ok = false;
    }
  }
  return ok;
}

Napi::Value CancelPendingInputHolds(const Napi::CallbackInfo& info) {
  {
    std::lock_guard<std::mutex> lock(g_inputStateMutex);
    g_terminalInputShutdown.store(true, std::memory_order_release);
  }
  g_inputStateCv.notify_all();
  return Napi::Boolean::New(info.Env(), ReleaseTrackedInputState());
}
```

Do not clear a failed release from the registry: a later stop attempt must be
able to retry it. Guard new down/hold calls with the terminal latch. Cleanup up
remains callable from `ReleaseTrackedInputState`.

- [ ] **Step 5: Integrate existing key paths**

Update `KeyDownGlobal` to register each successfully pressed key. Update
`KeyUpGlobal` to unregister only keys whose up packet was sent successfully.
Refactor `SendChordPress`, modifier handling in `SendClickAt`, and
`SendChordHold` to use the same tracked down/up helpers, so a partial
`SendInput` does not leave a modifier or mouse button outside the registry.
Every local sequence releases successfully posted downs in reverse order.

Replace `SendChordHold`'s `sleep_for` with `WaitForInputHold`. For
`HoldKeyGlobalAsync`, retain the existing worker API, reject before queueing
when terminal shutdown is set, and recheck inside `Execute()` before the first
down event. Terminal stop must notify the condition variable so a 30-second
hold releases and settles without waiting for its original duration.

- [ ] **Step 6: Propagate native cleanup failure through broker stop**

Change the broker hook contract to:

```ts
onTerminalStopCommitted?: () => boolean | void;
```

Call the hook before setting `terminalStopCommitted=true`. A returned `false`
or thrown error must reject `stop()` with a stable cleanup-failure error and
leave the hook eligible for a later retry; it must not close the listener and
report a clean stop.

In `helperMain.ts`, make `beginTerminalInputShutdown` return
`options.native.cancelPendingInputHolds?.() !== false`. On a thrown native
error, log a redacted `error`-level lifecycle diagnostic and return `false`;
do not swallow it as a successful stop.

- [ ] **Step 7: Extend the TypeScript contract and native export**

Add:

```ts
cancelPendingInputHolds?(): boolean;
```

to `AxWinNativeAddon`, and export `CancelPendingInputHolds` from `Init`.

- [ ] **Step 8: Rebuild and run lifecycle tests**

Run:

```powershell
pnpm rebuild:native
pnpm exec vitest run test/native/windows-input-dispatch.test.ts test/broker-terminal-input-cleanup.test.ts test/windowsDevHelperMain.test.ts test/helperMain-cancel-sentinel.test.ts
```

Expected: all selected files pass, the compiled addon exposes the cleanup
function, a terminal hold wakes promptly, and cleanup failure prevents a clean
broker stop.

- [ ] **Step 9: Run broker stop and orphan-cleanup tests**

Run:

```powershell
pnpm exec vitest run test/lifecycle.parity.test.ts test/standalone/helper-launch/cleanup.test.ts test/standalone/helper-launch/orchestrator.test.ts
```

Expected: all selected files pass.

- [ ] **Step 10: Commit terminal input cleanup**

```powershell
git add -- src/native/ax_win.cc src/native/types.ts src/broker/server/brokerServer.ts src/broker/server/helperMain.ts test/native/windows-input-dispatch.test.ts test/broker-terminal-input-cleanup.test.ts
git commit -m "fix(windows): release held input on helper stop"
```

---

### Task 6: Add an Opt-In Windows Pointer Live Smoke

**Files:**

- Create: `C:\Users\dev\zcode-cua\scripts\windows-pointer-live-smoke.mjs`
- Modify: `C:\Users\dev\zcode-cua\package.json`

**Interfaces:**

- Consumes: compiled `build/Release/ax_native.node`,
  `dist/windows-helper.js`, a random authenticated named pipe, and the real
  Windows interactive desktop.
- Produces: a bounded, opt-in real Helper/broker smoke with JSON summary and
  exact cursor restoration; exit `0` only when scoped move, broker shutdown,
  and cleanup evidence succeed.

- [ ] **Step 1: Create a failing test command**

Add:

```json
"smoke:windows:pointer": "node scripts/windows-pointer-live-smoke.mjs"
```

Run it before creating the script.

- [ ] **Step 2: Verify the command is RED**

Run:

```powershell
pnpm smoke:windows:pointer
```

Expected: exit non-zero with module-not-found for `scripts/windows-pointer-live-smoke.mjs`.

- [ ] **Step 3: Implement strict preflight and cursor restoration**

The script must:

1. exit `2` unless `process.platform === "win32"`;
2. exit `2` unless `ZCODE_CUA_WINDOWS_POINTER_LIVE === "1"`;
3. create a cryptographically random named pipe and bearer token;
4. spawn `dist/windows-helper.js` with
   `--socket <pipe> --parent-pid <current pid>` and the token only in the
   child environment; use the existing IPC ready/shutdown protocol;
5. call the authenticated broker's `broker_info`, `list_applications`,
   `list_displays`, and `cursor_position` methods;
6. require exactly one live `active=true` application and use its exact
   `{pid,bundle_id,name}` as `app_ref`;
7. select a target 24 logical pixels toward the center of the display
   containing the original cursor;
8. call broker `move_to`, poll broker `cursor_position` for at most 500 ms,
   and call `scroll` with `amount:0` to prove the wheel ABI/gate without
   changing application content;
9. restore the exact original point through the same scoped broker path in
   `finally` and verify it within two physical pixels;
10. start a broker `hold_key` request with a five-second duration, wait at most
    100 ms for worker admission, send the Helper shutdown control message, and
    require exit code `0` within 1.5 seconds; the action result may reject
    because shutdown interrupted it, but the Helper must not wait five seconds;
11. enforce a total deadline, terminate only the spawned child PID on timeout,
    and print one JSON object containing only booleans, platform, and
    coordinate deltas—no pipe, token, environment, active-app identity, or
    process command line.

Use:

```js
const summary = {
  platform: process.platform,
  helperReady,
  moveAccepted,
  zeroScrollAccepted,
  observedWithinTolerance,
  restoredWithinTolerance,
  holdPreemptedWithinDeadline,
  cleanHelperExit,
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
```

- [ ] **Step 4: Run the opt-in real desktop smoke**

Run:

```powershell
$env:ZCODE_CUA_WINDOWS_POINTER_LIVE='1'
pnpm smoke:windows:pointer
Remove-Item Env:ZCODE_CUA_WINDOWS_POINTER_LIVE
```

Expected: exit `0`; JSON has `moveAccepted`, `observedWithinTolerance`,
`zeroScrollAccepted`, `restoredWithinTolerance`,
`holdPreemptedWithinDeadline`, and `cleanHelperExit` all `true`.

- [ ] **Step 5: Run without opt-in and verify fail-closed**

Run:

```powershell
pnpm smoke:windows:pointer
```

Expected: exit `2` with a concise opt-in requirement; no cursor movement.

- [ ] **Step 6: Commit the live smoke**

```powershell
git add -- scripts/windows-pointer-live-smoke.mjs package.json
git commit -m "test(windows): add pointer live smoke"
```

---

### Task 7: Verify the Official Source Helper and Update Runbooks

**Files:**

- Modify: `C:\Users\dev\zcode-cua\docs\platforms.md`
- Modify: `C:\Users\dev\z-code\docs\cua\windows-source-development.md`

**Interfaces:**

- Consumes: all commits from Tasks 1–6.
- Produces: current capability documentation, direct real-Helper evidence, and repository-wide gate results.

- [ ] **Step 1: Build the complete source Helper**

Run:

```powershell
cd C:\Users\dev\zcode-cua
pnpm rebuild:native
pnpm build
Test-Path .\build\Release\ax_native.node
Test-Path .\dist\windows-helper.js
```

Expected: both commands exit `0`; both `Test-Path` calls print `True`.

- [ ] **Step 2: Run the direct source-Helper integration**

Run:

```powershell
cd C:\Users\dev\z-code
$env:ZCODE_CUA_DEV_ROOT='C:\Users\dev\zcode-cua'
pnpm exec vitest run packages/services/test/windowsCuaDevHelper.integration.test.ts
Remove-Item Env:ZCODE_CUA_DEV_ROOT
```

Expected: the real child, named pipe, health, `broker_info`, official plugin
credentials, and clean stop integration pass.

- [ ] **Step 3: Run the real scoped Helper/broker pointer smoke**

Run:

```powershell
cd C:\Users\dev\zcode-cua
$env:ZCODE_CUA_WINDOWS_POINTER_LIVE='1'
pnpm smoke:windows:pointer
Remove-Item Env:ZCODE_CUA_WINDOWS_POINTER_LIVE
```

Expected: JSON reports scoped move, zero-scroll dispatch, cursor restore,
interruptible hold preemption, and clean Helper shutdown success.

- [ ] **Step 4: Run all zcode-cua gates**

Run:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: every command exits `0`.

- [ ] **Step 5: Run focused ZCode CUA gates**

Run:

```powershell
cd C:\Users\dev\z-code
pnpm exec vitest run packages/services/test/cua
pnpm --filter @zcode/zcode-cua-plugin test
pnpm typecheck
pnpm lint
```

Expected: every command exits `0`; lint may retain only previously documented warnings.

- [ ] **Step 6: Run the affected full repository gate**

Run:

```powershell
pnpm test:unit:affected
```

Expected: exit `0`. If the existing Windows baseline still fails, retain the
full output, confirm no failure is in a CUA file, and compare the exact failure
set with the clean baseline before describing the result.

- [ ] **Step 7: Update platform and source-development documentation**

In `docs/platforms.md`, move the five pointer operations from “Phase 2 pending”
to “implemented in the Windows source Helper”; keep WGC, clipboard implementation,
and UIA worker isolation explicitly pending.

In `docs/cua/windows-source-development.md`, add:

```powershell
cd C:\Users\dev\zcode-cua
pnpm rebuild:native
pnpm build
$env:ZCODE_CUA_WINDOWS_POINTER_LIVE='1'
pnpm smoke:windows:pointer
Remove-Item Env:ZCODE_CUA_WINDOWS_POINTER_LIVE
```

Document:

- app-scoped pointer actions require the target to be the unique frontmost PID;
- negative secondary-display coordinates use virtual-desktop mapping;
- `left_mouse_up` is cleanup-only and may release after focus changes;
- WGC, clipboard implementation, and UIA worker isolation remain unavailable;
- the smoke restores the original cursor and is disabled without explicit opt-in.

- [ ] **Step 8: Commit zcode-cua documentation**

```powershell
cd C:\Users\dev\zcode-cua
git add -- docs/platforms.md
git commit -m "docs(windows): record pointer source support"
```

- [ ] **Step 9: Commit z-code runbook documentation**

```powershell
cd C:\Users\dev\z-code
git add -- docs/cua/windows-source-development.md
git commit -m "docs(cua): add Windows pointer source smoke"
```

- [ ] **Step 10: Confirm both working trees are clean**

Run:

```powershell
git -C C:\Users\dev\zcode-cua status --short
git -C C:\Users\dev\z-code status --short
```

Expected: both commands print nothing.
