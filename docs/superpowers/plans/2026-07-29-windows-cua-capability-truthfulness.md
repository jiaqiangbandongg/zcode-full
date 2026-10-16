# Windows CUA Capability Truthfulness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows screenshot and clipboard reporting accurately fail closed until WGC and a native clipboard adapter are implemented.

**Architecture:** Keep the existing `NodeSystemSurface` and broker methods, but replace empty/no-op placeholder success with typed broker refusal and explicit injected capability flags. The Windows native addon reports screen capture as `unknown`, while the broker advertises screenshot/clipboard as unsupported and refuses those calls before invoking placeholder system methods.

**Tech Stack:** TypeScript 5.9, Vitest 4, N-API/node-addon-api 7, C++17, pnpm 10.

**Execution order:** Execute this plan before
`2026-07-29-windows-cua-pointer-foundation.md`. That follow-up plan also
modifies `src/native/ax_win.cc` and `docs/platforms.md` and must preserve the
truthful capability behavior established here.

## Global Constraints

- Do not implement WGC, BitBlt, PowerShell, `System.Drawing`, or external capture commands in this plan.
- Do not implement clipboard read/write in this plan; only remove false success.
- Do not change the 30-tool MCP surface.
- Do not touch SSH, WSL, Docker, remote workspace, mobile `/remote`, or replayable realtime paths.
- `get_app_state(include_screenshot=true)` may remain UIA-only with `has_image=false`.
- `read_clipboard` and `write_clipboard` must return an explicit broker error on Windows.
- `screenCaptureStatus()` must return `unknown` until a real Windows capture backend is present.
- Preserve macOS and Linux behavior.
- Add Chinese root-cause comments for the placeholder-success bug.
- Run `pnpm typecheck` and `pnpm lint` before completion.

## File Map

`C:\Users\dev\zcode-cua`:

- Modify `test/broker/windowsSystemSurface.test.ts`: require explicit clipboard refusal.
- Create `test/windows-capability-truthfulness.test.ts`: pin Windows `request_access`, screenshot, and clipboard broker behavior.
- Modify `src/broker/server/windowsSystemSurface.ts`: throw `not_authorized` for clipboard operations.
- Modify `src/broker/server/nodeSystemSurface.ts`: expose optional system-surface capability flags.
- Modify `src/broker/server/nodeAutomationAdapter.ts`: carry system-surface flags into the backend adapter.
- Modify `src/broker/server/electronNativeBackendTypes.ts`: declare optional screenshot/clipboard support flags.
- Modify `src/broker/server/electronNativeBackend.ts`: advertise and enforce the injected capability flags.
- Modify `src/native/ax_win.cc`: report screen capture `unknown`.
- Create `test/native/windows-capability-truthfulness.test.ts`: pin the native status source and compiled result.
- Modify `docs/platforms.md`: document honest unavailable status.

---

### Task 1: Remove Windows Clipboard Placeholder Success and Inject Capabilities

**Files:**

- Modify: `C:\Users\dev\zcode-cua\test\broker\windowsSystemSurface.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\windowsSystemSurface.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nodeSystemSurface.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nodeAutomationAdapter.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronNativeBackendTypes.ts`

**Interfaces:**

- Consumes: `NodeSystemSurface.readClipboardText()` and `writeClipboardText(text)`.
- Produces: both methods throw a `BrokerError` with code `not_authorized` on
  Windows; `supportsScreenCapture` and `supportsClipboard` reach
  `ElectronAutomationAdapter`.

- [ ] **Step 1: Change the clipboard test to require refusal**

Replace the placeholder assertions with:

```ts
expect(() => surface.readClipboardText()).toThrow("read_clipboard is unavailable on Windows");
expect(() => surface.writeClipboardText("secret")).toThrow(
  "write_clipboard is unavailable on Windows",
);

for (const operation of [
  () => surface.readClipboardText(),
  () => surface.writeClipboardText("secret"),
]) {
  try {
    operation();
    throw new Error("expected operation to fail");
  } catch (error) {
    expect(error).toMatchObject({ code: "not_authorized" });
  }
}
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
cd C:\Users\dev\zcode-cua
pnpm exec vitest run test/broker/windowsSystemSurface.test.ts
```

Expected: the test fails because read returns `""` and write returns without error.

- [ ] **Step 3: Implement explicit refusal**

Import:

```ts
import { notAuthorized } from "../types.js";
```

Implement:

```ts
readClipboardText: () => {
  // 根因：空字符串无法区分“真实空剪贴板”和“Windows adapter 未实现”，会让模型误判读取成功。
  throw notAuthorized(
    "read_clipboard is unavailable on Windows until the native clipboard adapter is installed.",
  );
},
writeClipboardText: () => {
  // 根因：旧 no-op 会让 write_clipboard 返回成功，但系统剪贴板从未改变。
  throw notAuthorized(
    "write_clipboard is unavailable on Windows until the native clipboard adapter is installed.",
  );
},
```

- [ ] **Step 4: Add explicit system-surface and adapter capability flags**

Extend `NodeSystemSurface`:

```ts
export interface NodeSystemSurface {
  readonly supportsScreenCapture?: boolean;
  readonly supportsClipboard?: boolean;
  // existing methods remain unchanged
}
```

Return:

```ts
supportsScreenCapture: false,
supportsClipboard: false,
```

from `createWindowsNodeSystemSurface`. macOS/Linux surfaces may omit the flags;
omission preserves their existing supported behavior.

Extend `ElectronAutomationAdapter` with the same optional readonly flags. In
`createNodeAutomationAdapter`, expose:

```ts
supportsScreenCapture: system.supportsScreenCapture !== false,
supportsClipboard: system.supportsClipboard !== false,
```

Add test assertions:

```ts
expect(surface.supportsScreenCapture).toBe(false);
expect(surface.supportsClipboard).toBe(false);
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```powershell
pnpm exec vitest run test/broker/windowsSystemSurface.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run broker result-shape regressions**

Run:

```powershell
pnpm exec vitest run test/tool-return-shape.parity.test.ts test/mock-broker-e2e.test.ts
```

Expected: all selected tests pass; non-Windows mocked clipboard behavior remains unchanged.

- [ ] **Step 7: Commit the clipboard truth fix**

```powershell
git add -- src/broker/server/windowsSystemSurface.ts src/broker/server/nodeSystemSurface.ts src/broker/server/nodeAutomationAdapter.ts src/broker/server/electronNativeBackendTypes.ts test/broker/windowsSystemSurface.test.ts
git commit -m "fix(windows): reject unavailable clipboard operations"
```

---

### Task 2: Report Screen Capture as Unknown Until WGC Exists

**Files:**

- Create: `C:\Users\dev\zcode-cua\test\native\windows-capability-truthfulness.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\ax_win.cc`

**Interfaces:**

- Consumes: `AxWinNativeAddon.screenCaptureStatus()`.
- Produces: `"unknown"` on an interactive Windows desktop while capture remains unimplemented; `"denied"` only when the Helper itself is unavailable/non-interactive.

- [ ] **Step 1: Add failing source and runtime assertions**

Add:

```ts
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../../src/native/ax_win.cc", import.meta.url), "utf8");
const statusFunction = source.slice(
  source.indexOf("Napi::Value ScreenCaptureStatus"),
  source.indexOf("Napi::Value CursorPoint"),
);

describe("Windows native capability source contract", () => {
  it("does not claim WGC before an implementation exists", () => {
    expect(statusFunction).toContain('"unknown"');
    expect(statusFunction).not.toContain('? "granted" : "denied"');
  });
});
```

When the compiled Windows addon is available:

```ts
const loader = require("../../src/native/win.cjs") as {
  available: boolean;
  native: { screenCaptureStatus(): string } | null;
};
const describeIfNative = loader.available ? describe : describe.skip;

describeIfNative("compiled Windows capability status", () => {
  it("reports screen capture unknown until WGC exists", () => {
    expect(loader.native!.screenCaptureStatus()).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
pnpm exec vitest run test/native/windows-capability-truthfulness.test.ts
```

Expected: source/runtime assertion reports current `"granted"`.

- [ ] **Step 3: Implement truthful native status**

Change:

```cpp
Napi::Value ScreenCaptureStatus(const Napi::CallbackInfo& info) {
  const char* status =
      (g_uia && g_interactiveDesktop) ? "unknown" : "denied";
  return Napi::String::New(info.Env(), status);
}
```

Add a Chinese comment explaining that Windows has no TCC permission prompt, but
permission absence and implementation absence are different states; WGC has
not been installed, so `granted` would be a false capability claim.

- [ ] **Step 4: Rebuild and run the test**

Run:

```powershell
pnpm rebuild:native
pnpm exec vitest run test/native/windows-capability-truthfulness.test.ts
```

Expected: rebuild exits `0`; source and runtime status assertions pass.

- [ ] **Step 5: Commit the capture-status truth fix**

```powershell
git add -- src/native/ax_win.cc test/native/windows-capability-truthfulness.test.ts
git commit -m "fix(windows): report capture capability truthfully"
```

---

### Task 3: Prove Broker-Level Capability Behavior

**Files:**

- Create: `C:\Users\dev\zcode-cua\test\windows-capability-truthfulness.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronNativeBackend.ts`
- Modify: `C:\Users\dev\zcode-cua\docs\platforms.md`

**Interfaces:**

- Consumes: `createElectronNativeBackend` with Windows native/system adapters.
- Produces: broker capabilities with `screen:false`, `screenshot:false`, and
  `clipboard:false`; broker-level tests proving request-access status,
  screenshot failure, UIA-only app state, and clipboard refusal.

- [ ] **Step 1: Create the broker-level tests**

Create the adapter using the same required display seam as production:

```ts
const DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 1,
};
const captureScreenPng = vi.fn(async () => null);
const requestScreenCaptureAccess = vi.fn(() => false);
const adapter = {
  supportsScreenCapture: false,
  supportsClipboard: false,
  isTrustedAccessibilityClient: () => true,
  getScreenMediaAccessStatus: () => "unknown",
  requestScreenCaptureAccess,
  getPrimaryDisplay: () => DISPLAY,
  getAllDisplays: () => [DISPLAY],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  captureScreenPng,
  readClipboardText: () => {
    throw notAuthorized("read_clipboard is unavailable on Windows");
  },
  writeClipboardText: () => {
    throw notAuthorized("write_clipboard is unavailable on Windows");
  },
} satisfies ElectronAutomationAdapter;

const axSource = {
  listApplications: vi.fn(async () => []),
  captureApp: vi.fn(async () => ({
    app: {
      pid: 4321,
      bundle_id: "C:\\Apps\\Target.exe",
      name: "Target",
      active: true,
    },
    window: {
      title: "Target",
      bounds: [0, 0, 800, 600],
      window_id: 42,
      main: true,
      focused: true,
    },
    elements: [],
    screenshot: null,
  })),
} as unknown as AxReadOnlySource;

const backend = createElectronNativeBackend({
  adapter,
  axSource,
  brokerInfo: {
    bundle_id: "dev.zcode.cua.helper",
    display_name: "ZCode Computer Use",
    permission_mode: "product",
    version: "0.0.0-test",
    platform: "win32",
  },
});
```

Test:

- `backend.broker_info({}).capabilities` reports screen, screenshot, and clipboard false;
- `backend.request_access({ capabilities:["screenshot"] })` returns
  `screen_recording.status_after === "unknown"` without calling a capture or
  prompt adapter;
- that request reports screen capture as implementation-unavailable, does not
  tell the user to grant Windows screen-recording permission, and does not set
  `permission_guide.all_required_granted=true`;
- `backend.screenshot({})` rejects with `not_authorized`, returns no image
  payload, and never calls `captureScreenPng`;
- `read_clipboard` rejects with `not_authorized`;
- `write_clipboard` rejects with `not_authorized`;
- `capture_app` with `include_screenshot:true` still returns the fake UIA
  snapshot with `screenshot:null`;
- no test calls a macOS command or PowerShell.

- [ ] **Step 2: Run the new test and verify behavior**

Run:

```powershell
pnpm exec vitest run test/windows-capability-truthfulness.test.ts
```

Expected: capability assertions fail because `broker_info` currently hard-codes
screen/screenshot/clipboard true and `screenshot` reaches `captureScreenPng`.

- [ ] **Step 3: Advertise and enforce injected capabilities**

In `createElectronNativeBackend`, derive:

```ts
const supportsScreenCapture = adapter.supportsScreenCapture !== false;
const supportsClipboard = adapter.supportsClipboard !== false;
```

Set:

```ts
capabilities: {
  screen: supportsScreenCapture,
  screenshot: supportsScreenCapture,
  clipboard: supportsClipboard,
  // retain every other existing field unchanged
}
```

At the start of `screenshot`:

```ts
if (!supportsScreenCapture) {
  throw notAuthorized("screenshot is unavailable in this Windows Computer Use Helper build.");
}
```

In `request_access`, when `supportsScreenCapture` is false, keep both screen
statuses at the adapter's truthful `unknown` value and skip
`requestScreenCaptureAccess`, `captureScreenPng`, window probes, and settings
deep links. An unsupported implementation is not a permission state and must
not trigger an onboarding side effect. In that branch:

- `screen_recording.action_required` explicitly says the current Helper build
  does not implement Windows screen capture;
- `permission_guide.missing` does not pretend there is a Windows privacy pane
  the user can fix;
- `permission_guide.all_required_granted` remains `false`;
- `permission_guide.message` reports implementation unavailability rather
  than permission denial.

At the start of `read_clipboard` and `write_clipboard`, apply the matching
`supportsClipboard` refusal before adapter dispatch. Keep omitted flags
backward-compatible as supported.

- [ ] **Step 4: Run the broker-level test and verify GREEN**

Run:

```powershell
pnpm exec vitest run test/windows-capability-truthfulness.test.ts
```

Expected: all cases pass and `captureScreenPng` has zero calls.

- [ ] **Step 5: Run all zcode-cua gates**

Run:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: every command exits `0`.

- [ ] **Step 6: Update Windows platform documentation**

In `docs/platforms.md`, state:

- screen capture status is `unknown` until WGC lands;
- `screenshot` fails explicitly;
- `get_app_state` remains UIA-only without pixels;
- clipboard read/write fail with unavailable instead of empty/no-op success;
- WGC and native clipboard remain separate follow-up milestones.

- [ ] **Step 7: Commit tests, backend, and documentation**

```powershell
git add -- src/broker/server/electronNativeBackend.ts test/windows-capability-truthfulness.test.ts docs/platforms.md
git commit -m "test(windows): lock capability truthfulness"
```

- [ ] **Step 8: Confirm a clean working tree**

Run:

```powershell
git status --short
```

Expected: no output.
