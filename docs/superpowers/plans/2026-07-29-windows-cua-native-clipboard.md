# Windows CUA Native Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Windows source Helper 增加真实、异步、fail-closed 的 `CF_UNICODETEXT` 读写链路，并让 `broker_info.capabilities.clipboard` 只在 native 双导出齐全时为 `true`。

**Architecture:** `ax_win.cc` 通过两个 additive `Napi::AsyncWorker` 导出执行 Win32 clipboard 同步 API；`createNodeAutomationAdapter` 只在 `win32` 且读写双导出齐全时选用该路径，并把结构化 native outcome 映射为稳定的 broker error。`electronNativeBackend` 统一 `await` sync/async clipboard adapter，因此 macOS/Linux 现有 system surface 行为不变，旧 Windows addon 继续 fail closed。

**Tech Stack:** TypeScript 5.9、Vitest 4、Node-API / node-addon-api、C++17、Win32 Clipboard API、MSVC / node-gyp、Windows named pipe broker。

## Global Constraints

- 先改测试再改实现；每个任务都必须观察到 RED，再完成 GREEN。
- 仅修改 `C:\Users\dev\zcode-cua` 的本地 Windows source Helper 链路，以及 `C:\Users\dev\z-code` 的事实文档；不启动或修改 SSH、WSL、Docker、remote workspace、手机 `/remote`。
- Windows clipboard 必须使用 Win32 `CF_UNICODETEXT`；禁止 PowerShell、shell、外部命令和 Electron clipboard fallback。
- additive ABI 固定为 `readClipboardTextAsync(): Promise<NativeClipboardReadOutcome>` 与 `writeClipboardTextAsync(text): Promise<NativeClipboardWriteOutcome>`；任一导出缺失都必须令 Windows `supportsClipboard=false`。
- `ElectronAutomationAdapter.readClipboardText` 返回 `string | Promise<string>`；`writeClipboardText` 返回 `void | Promise<void>`；macOS/Linux 同步 system surface 保持兼容。
- 使用独立 `std::timed_mutex g_clipboardMutex`；Helper 内部锁最多等待 250ms；`OpenClipboard(nullptr)` 最多 8 次、每次间隔 10ms。
- 文本上限固定为 8 Mi 个 UTF-16 code units；读取必须由 `GlobalSize` 约束并在范围内查找第一个 NUL，禁止无界 `wcslen`。
- 写入必须在 `OpenClipboard` / `EmptyClipboard` 前完成 UTF-16 转换、`HGLOBAL` 分配与内容复制；`SetClipboardData` 成功后才把所有权交给 Windows。
- native outcome 或 broker error 不得包含 clipboard 内容、marker、token、pipe、进程路径或 Win32 原始错误文本。
- 不新增逐次 clipboard `info` 日志；若实现期确需诊断，只能使用不含内容的低频状态或开发态 `debug`，不得按文本长度或调用流量落生产日志。
- `busy` 映射 `timeout`；`too_large` 映射 `invalid_request`；`unavailable`、`invalid_data`、`write_failed` 和畸形 outcome 映射 `internal`，不得误报为权限错误。
- `write_clipboard` 保持 action / `possibly_sent` 语义；`write_failed` 不得自动重放。
- 工具名、tier、annotation、broker method 和 30-tool manifest 不变。
- live smoke 默认关闭；没有显式 opt-in 时必须在启动 Helper、读取或修改 clipboard 前以 exit code 2 退出。
- live smoke 只恢复原始纯文本，无法恢复被测试写入替换掉的 HTML、图片等附加格式；恢复失败必须非零退出并明确提示 clipboard 可能仍是测试值。
- `zcode-cua` 必须执行 focused tests、native rebuild、typecheck、lint、build、全量 test；`z-code` 必须执行 Windows source Helper integration、CUA focused suite、official plugin test、typecheck、lint。
- `z-code` 当前 Windows 全仓 `pnpm test:unit:affected` 存在已记录的非 CUA baseline；仍须执行并逐项记录，不得把非零结果改称通过。

---

## File Structure

### `C:\Users\dev\zcode-cua`

- Modify: `src/broker/server/nativeAxSource.ts` — broker-neutral raw addon clipboard outcome 与 additive ABI。
- Modify: `src/native/types.ts` — Windows raw addon 的公开 clipboard outcome 与导出类型。
- Modify: `src/broker/server/electronNativeBackendTypes.ts` — sync/Promise 兼容的 adapter clipboard seam。
- Modify: `src/broker/server/nodeAutomationAdapter.ts` — Windows 双导出 capability gate、native outcome 校验和 broker error 映射。
- Modify: `src/broker/server/electronNativeBackend.ts` — async clipboard broker handlers。
- Modify: `src/native/ax_win.cc` — `CF_UNICODETEXT` worker、锁、重试、RAII 与内存所有权。
- Create: `test/windows-native-clipboard-adapter.test.ts` — adapter 双导出、平台 fallback、所有 outcome 与泄密约束。
- Modify: `test/windows-capability-truthfulness.test.ts` — broker capability 与 async handler 真值。
- Create: `test/native/windows-clipboard.test.ts` — native source contract 与 compiled export 检查。
- Create: `scripts/windows-clipboard-live-smoke.mjs` — opt-in 真实 broker round-trip 和 finally 恢复。
- Create: `test/windows-clipboard-live-smoke.test.ts` — 默认关闭且不会越过 preflight 的回归测试。
- Modify: `package.json` — `smoke:windows:clipboard` 命令。
- Modify: `docs/platforms.md` — Windows clipboard 当前能力、边界和实机命令。
- Modify after all source tests pass: `dist/**` — 由 `pnpm build` 生成并纳入提交的发布产物。

### `C:\Users\dev\z-code`

- Modify: `docs/cua/windows-source-development.md` — source desktop 的构建、验证、风险与实机记录。

## Data and Error Flow

```text
read_clipboard
  |
  +-- backend async handler
        |
        +-- win32 + read/write native exports both present
        |     |
        |     +-- await readClipboardTextAsync()
        |           |
        |           +-- Helper timed_mutex (<=250ms)
        |           +-- OpenClipboard retry (8 x 10ms)
        |           +-- CF_UNICODETEXT + GlobalSize bounded scan
        |           +-- strict UTF-16 -> UTF-8
        |
        +-- darwin/linux -> existing system.readClipboardText()

write_clipboard
  |
  +-- backend marks action as possibly-sent and awaits adapter
        |
        +-- strict UTF-8 -> UTF-16 + preallocate HGLOBAL
        +-- Helper timed_mutex (<=250ms)
        +-- OpenClipboard retry (8 x 10ms)
        +-- EmptyClipboard -> SetClipboardData
        +-- ownership transfers only after SetClipboardData succeeds
```

```text
native outcome        broker code       side-effect/retry meaning
busy                  timeout           mutation 前失败；可由调用方重新决策
too_large             invalid_request   输入/结果超过固定上限
unavailable           internal          运行时不可用；不是用户权限开关
invalid_data          internal          读取数据损坏；不伪造空文本
write_failed          internal          possibly-sent；禁止自动重放
malformed outcome     internal          addon ABI 不可信；fail closed
```

---

### Task 1: Lock the additive TypeScript ABI and adapter error contract

**Files:**

- Create: `C:\Users\dev\zcode-cua\test\windows-native-clipboard-adapter.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nativeAxSource.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\types.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronNativeBackendTypes.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nodeAutomationAdapter.ts`

**Interfaces:**

- Consumes: existing `createNodeAutomationAdapter({ native, system, platform })`, `NodeSystemSurface`, `BrokerError`.
- Produces:
  - `NativeClipboardReadOutcome`
  - `NativeClipboardWriteOutcome`
  - optional `HelperNativeAddon.readClipboardTextAsync`
  - optional `HelperNativeAddon.writeClipboardTextAsync`
  - Windows adapter `supportsClipboard=true` only when both functions exist.

- [ ] **Step 1: Write the failing adapter contract tests**

Create `test/windows-native-clipboard-adapter.test.ts` with factories that cast only the raw addon seam, not the behavior under test:

```ts
import { describe, expect, it, vi } from "vitest";

import { createNodeAutomationAdapter } from "../src/broker/server/nodeAutomationAdapter.js";
import type {
  HelperNativeAddon,
  NativeClipboardReadOutcome,
  NativeClipboardWriteOutcome,
} from "../src/broker/server/nativeAxSource.js";
import type { NodeSystemSurface } from "../src/broker/server/nodeSystemSurface.js";

function nativeWithClipboard(overrides: Record<string, unknown> = {}): HelperNativeAddon {
  return {
    isTrusted: () => true,
    promptTrust: () => true,
    screenCaptureStatus: () => "unknown",
    displays: () => [{ id: 1, bounds: [0, 0, 800, 600], main: true }],
    cursorPoint: () => ({ x: 0, y: 0 }),
    readClipboardTextAsync: async () => ({ ok: true, text: "" }),
    writeClipboardTextAsync: async () => ({ ok: true }),
    ...overrides,
  } as unknown as HelperNativeAddon;
}

function systemSurface(): NodeSystemSurface {
  return {
    supportsScreenCapture: false,
    supportsClipboard: false,
    captureScreenPng: async () => null,
    captureWindowPng: async () => null,
    readClipboardText: vi.fn(() => "system-text"),
    writeClipboardText: vi.fn(),
    resolveApplicationBundleId: async () => null,
    openApplication: async () => undefined,
  };
}

describe("Windows native clipboard adapter", () => {
  it("enables clipboard only when both native async exports exist", () => {
    const both = createNodeAutomationAdapter({
      native: nativeWithClipboard(),
      system: systemSurface(),
      platform: "win32",
    });
    const readOnly = createNodeAutomationAdapter({
      native: nativeWithClipboard({ writeClipboardTextAsync: undefined }),
      system: systemSurface(),
      platform: "win32",
    });
    const writeOnly = createNodeAutomationAdapter({
      native: nativeWithClipboard({ readClipboardTextAsync: undefined }),
      system: systemSurface(),
      platform: "win32",
    });
    const neither = createNodeAutomationAdapter({
      native: nativeWithClipboard({
        readClipboardTextAsync: undefined,
        writeClipboardTextAsync: undefined,
      }),
      system: systemSurface(),
      platform: "win32",
    });

    expect(both.supportsClipboard).toBe(true);
    expect(readOnly.supportsClipboard).toBe(false);
    expect(writeOnly.supportsClipboard).toBe(false);
    expect(neither.supportsClipboard).toBe(false);
  });

  it("uses the native pair on Windows and preserves a real empty string", async () => {
    const readClipboardTextAsync = vi.fn<() => Promise<NativeClipboardReadOutcome>>(async () => ({
      ok: true,
      text: "",
    }));
    const writeClipboardTextAsync = vi.fn<(text: string) => Promise<NativeClipboardWriteOutcome>>(
      async () => ({ ok: true }),
    );
    const system = systemSurface();
    const adapter = createNodeAutomationAdapter({
      native: nativeWithClipboard({
        readClipboardTextAsync,
        writeClipboardTextAsync,
      }),
      system,
      platform: "win32",
    });

    await expect(Promise.resolve(adapter.readClipboardText())).resolves.toBe("");
    await expect(Promise.resolve(adapter.writeClipboardText("文本🙂"))).resolves.toBeUndefined();
    expect(writeClipboardTextAsync).toHaveBeenCalledWith("文本🙂");
    expect(system.readClipboardText).not.toHaveBeenCalled();
    expect(system.writeClipboardText).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux"] as const)(
    "keeps the existing %s system clipboard surface",
    async (platform) => {
      const system = systemSurface();
      const nativeRead = vi.fn(async () => ({ ok: true, text: "native" }) as const);
      const adapter = createNodeAutomationAdapter({
        native: nativeWithClipboard({ readClipboardTextAsync: nativeRead }),
        system: { ...system, supportsClipboard: true },
        platform,
      });

      expect(adapter.supportsClipboard).toBe(true);
      await expect(Promise.resolve(adapter.readClipboardText())).resolves.toBe("system-text");
      expect(nativeRead).not.toHaveBeenCalled();
    },
  );
});
```

Add table-driven cases in the same file for exact mappings:

```ts
it.each([
  [{ ok: false, error: "busy" }, "timeout"],
  [{ ok: false, error: "too_large" }, "invalid_request"],
  [{ ok: false, error: "unavailable" }, "internal"],
  [{ ok: false, error: "invalid_data" }, "internal"],
] as const)("maps read outcome %j to %s without content leakage", async (outcome, code) => {
  const adapter = createNodeAutomationAdapter({
    native: nativeWithClipboard({ readClipboardTextAsync: async () => outcome }),
    system: systemSurface(),
    platform: "win32",
  });
  await expect(Promise.resolve(adapter.readClipboardText())).rejects.toMatchObject({ code });
});

it.each([
  [{ ok: false, error: "busy" }, "timeout"],
  [{ ok: false, error: "too_large" }, "invalid_request"],
  [{ ok: false, error: "unavailable" }, "internal"],
  [{ ok: false, error: "write_failed" }, "internal"],
] as const)("maps write outcome %j to %s without content leakage", async (outcome, code) => {
  const secret = "DO-NOT-LEAK-CLIPBOARD-TEXT";
  const adapter = createNodeAutomationAdapter({
    native: nativeWithClipboard({ writeClipboardTextAsync: async () => outcome }),
    system: systemSurface(),
    platform: "win32",
  });
  try {
    await Promise.resolve(adapter.writeClipboardText(secret));
    throw new Error("expected clipboard write to fail");
  } catch (error) {
    expect(error).toMatchObject({ code });
    expect(String((error as Error).message)).not.toContain(secret);
  }
});

it("fails closed on malformed native outcomes", async () => {
  const adapter = createNodeAutomationAdapter({
    native: nativeWithClipboard({
      readClipboardTextAsync: async () => ({ ok: true, text: 42 }),
    }),
    system: systemSurface(),
    platform: "win32",
  });
  await expect(Promise.resolve(adapter.readClipboardText())).rejects.toMatchObject({
    code: "internal",
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
cd C:\Users\dev\zcode-cua
pnpm exec vitest run test/windows-native-clipboard-adapter.test.ts
```

Expected: FAIL because outcome types and `HelperNativeAddon` async methods do not exist, and the Windows adapter still delegates to the unsupported system surface.

- [ ] **Step 3: Add the exact TypeScript ABI**

In `src/broker/server/nativeAxSource.ts`, immediately before `HelperNativeAddon`:

```ts
export type NativeClipboardReadOutcome =
  | { ok: true; text: string }
  | {
      ok: false;
      error: "busy" | "unavailable" | "invalid_data" | "too_large";
    };

export type NativeClipboardWriteOutcome =
  | { ok: true }
  | {
      ok: false;
      error: "busy" | "unavailable" | "too_large" | "write_failed";
    };
```

Add to `HelperNativeAddon`:

```ts
readClipboardTextAsync?(): Promise<NativeClipboardReadOutcome>;
writeClipboardTextAsync?(text: string): Promise<NativeClipboardWriteOutcome>;
```

Mirror the structurally identical public Windows shapes in `src/native/types.ts`:

```ts
export type AxWinClipboardReadOutcome =
  | { ok: true; text: string }
  | {
      ok: false;
      error: "busy" | "unavailable" | "invalid_data" | "too_large";
    };

export type AxWinClipboardWriteOutcome =
  | { ok: true }
  | {
      ok: false;
      error: "busy" | "unavailable" | "too_large" | "write_failed";
    };
```

Add to `AxWinNativeAddon`:

```ts
readClipboardTextAsync?(): Promise<AxWinClipboardReadOutcome>;
writeClipboardTextAsync?(text: string): Promise<AxWinClipboardWriteOutcome>;
```

Change only the clipboard return shapes in `ElectronAutomationAdapter`:

```ts
readClipboardText(): string | Promise<string>;
writeClipboardText(text: string): void | Promise<void>;
```

- [ ] **Step 4: Implement the Windows-only pair gate and outcome mapping**

In `nodeAutomationAdapter.ts`, add `NativeClipboardReadOutcome` and `NativeClipboardWriteOutcome` to the existing type import from `nativeAxSource.ts`. Immediately after the existing `const platform = options.platform ?? process.platform`, wrap both optional exports, compute the pair gate, and use these exact validators:

```ts
const readClipboardTextAsync = wrapOptionalNativeMethod(native.readClipboardTextAsync);
const writeClipboardTextAsync = wrapOptionalNativeMethod(native.writeClipboardTextAsync);
const hasNativeClipboard =
  platform === "win32" &&
  typeof readClipboardTextAsync === "function" &&
  typeof writeClipboardTextAsync === "function";

function clipboardError(
  operation: "read_clipboard" | "write_clipboard",
  error: string,
): BrokerError {
  if (error === "busy") {
    return new BrokerError(
      "timeout",
      `${operation}: native clipboard was busy before mutation admission; no clipboard mutation occurred`,
    );
  }
  if (error === "too_large") {
    return new BrokerError(
      "invalid_request",
      `${operation}: clipboard text exceeds 8388608 UTF-16 code units`,
    );
  }
  if (error === "write_failed") {
    return new BrokerError(
      "internal",
      `${operation}: native clipboard write failed after admission; the action is possibly-sent and must not be retried automatically`,
    );
  }
  if (error === "invalid_data") {
    return new BrokerError("internal", `${operation}: native clipboard text was invalid`);
  }
  if (error === "unavailable") {
    return new BrokerError(
      "internal",
      `${operation}: native Windows clipboard is unavailable in this interactive session`,
    );
  }
  return new BrokerError("internal", `${operation}: native clipboard returned an invalid outcome`);
}
```

Use strict structural checks rather than truthiness:

```ts
async function readNativeClipboardText(
  read: () => Promise<NativeClipboardReadOutcome>,
): Promise<string> {
  const outcome = await read();
  if (
    outcome &&
    typeof outcome === "object" &&
    outcome.ok === true &&
    typeof outcome.text === "string"
  ) {
    return outcome.text;
  }
  if (
    outcome &&
    typeof outcome === "object" &&
    outcome.ok === false &&
    typeof outcome.error === "string"
  ) {
    throw clipboardError("read_clipboard", outcome.error);
  }
  throw clipboardError("read_clipboard", "malformed");
}

async function writeNativeClipboardText(
  write: (text: string) => Promise<NativeClipboardWriteOutcome>,
  text: string,
): Promise<void> {
  const outcome = await write(text);
  if (outcome && typeof outcome === "object" && outcome.ok === true) return;
  if (
    outcome &&
    typeof outcome === "object" &&
    outcome.ok === false &&
    typeof outcome.error === "string"
  ) {
    throw clipboardError("write_clipboard", outcome.error);
  }
  throw clipboardError("write_clipboard", "malformed");
}
```

In the returned adapter object, replace only the three clipboard fields:

```ts
supportsClipboard: hasNativeClipboard
  ? true
  : platform === "win32"
    ? false
    : system.supportsClipboard !== false,
readClipboardText: hasNativeClipboard
  ? () => readNativeClipboardText(readClipboardTextAsync!)
  : () => system.readClipboardText(),
writeClipboardText: hasNativeClipboard
  ? (text: string) => writeNativeClipboardText(writeClipboardTextAsync!, text)
  : (text: string) => system.writeClipboardText(text),
```

Add a Chinese root-cause comment above the pair gate: the old single-export/partial addon could otherwise advertise a half-working clipboard and fall through to a Windows placeholder.

- [ ] **Step 5: Run the focused test and typecheck**

Run:

```powershell
cd C:\Users\dev\zcode-cua
pnpm exec vitest run test/windows-native-clipboard-adapter.test.ts test/broker/windowsSystemSurface.test.ts
pnpm typecheck
```

Expected: both commands exit 0; Windows placeholder tests remain fail-closed without the pair, while fake dual exports pass.

- [ ] **Step 6: Commit the adapter contract**

```powershell
git add src/broker/server/nativeAxSource.ts src/native/types.ts src/broker/server/electronNativeBackendTypes.ts src/broker/server/nodeAutomationAdapter.ts test/windows-native-clipboard-adapter.test.ts
git commit -m "feat(windows): add native clipboard adapter contract"
```

---

### Task 2: Make broker handlers await clipboard work and report truthful capability

**Files:**

- Modify: `C:\Users\dev\zcode-cua\test\windows-capability-truthfulness.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronNativeBackend.ts`

**Interfaces:**

- Consumes: Task 1 adapter methods returning sync values or Promises.
- Produces: `read_clipboard` and `write_clipboard` handlers that always await completion before returning.

- [ ] **Step 1: Add failing async broker tests**

Extend the test helper to accept `supportsClipboard`, `readClipboardText`, and `writeClipboardText` overrides. Add:

```ts
it("awaits native clipboard read/write and advertises the complete pair", async () => {
  let resolveWrite: (() => void) | undefined;
  const writePending = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  const readClipboardText = vi.fn(async () => "");
  const writeClipboardText = vi.fn(() => writePending);
  const backend = createElectronNativeBackend({
    adapter: {
      supportsScreenCapture: false,
      supportsClipboard: true,
      isTrustedAccessibilityClient: () => true,
      getScreenMediaAccessStatus: () => "unknown",
      getPrimaryDisplay: () => DISPLAY,
      getAllDisplays: () => [DISPLAY],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      captureScreenPng: async () => null,
      readClipboardText,
      writeClipboardText,
    },
    brokerInfo: {
      bundle_id: "dev.zcode.cua.helper",
      display_name: "ZCode Computer Use",
      permission_mode: "product",
      version: "0.0.0-test",
      platform: "win32",
    },
  });

  const info = (await backend.broker_info({})) as {
    capabilities: { clipboard: boolean };
  };
  expect(info.capabilities.clipboard).toBe(true);
  await expect(backend.read_clipboard({})).resolves.toBe("");

  let settled = false;
  const write = Promise.resolve(backend.write_clipboard({ text: "marker" })).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  resolveWrite!();
  await expect(write).resolves.toBeUndefined();
  expect(writeClipboardText).toHaveBeenCalledWith("marker");
});
```

Retain the existing test proving `supportsClipboard=false` rejects before adapter dispatch. Do not change tool counts, tiers or annotations.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
cd C:\Users\dev\zcode-cua
pnpm exec vitest run test/windows-capability-truthfulness.test.ts
```

Expected: the write Promise resolves too early because the current handler does not await `adapter.writeClipboardText`.

- [ ] **Step 3: Convert both broker handlers to async**

Replace the handlers with:

```ts
read_clipboard: async () => {
  if (!supportsClipboard) {
    throw notAuthorized(
      "read_clipboard is unavailable in this ZCode Computer Use build.",
    );
  }
  return await adapter.readClipboardText();
},
write_clipboard: async (params) => {
  if (!supportsClipboard) {
    throw notAuthorized(
      "write_clipboard is unavailable in this ZCode Computer Use build.",
    );
  }
  const text = typeof params.text === "string" ? params.text : "";
  await adapter.writeClipboardText(text);
  return null;
},
```

Keep capability derivation `adapter.supportsClipboard !== false` unchanged; Task 1 is now the source of Windows capability truth.

- [ ] **Step 4: Run broker, tool-surface and type gates**

```powershell
cd C:\Users\dev\zcode-cua
pnpm exec vitest run test/windows-capability-truthfulness.test.ts test/windows-native-clipboard-adapter.test.ts test/annotations.test.ts test/broker/types.brokerMethods.test.ts test/broker/types.readOnlyMethods.test.ts
pnpm typecheck
```

Expected: exit 0; the manifest remains 30 tools, `read_clipboard` remains read-only, and `write_clipboard` remains an action.

- [ ] **Step 5: Commit the async broker boundary**

```powershell
git add src/broker/server/electronNativeBackend.ts test/windows-capability-truthfulness.test.ts
git commit -m "feat(windows): await native clipboard operations"
```

---

### Task 3: Implement bounded Win32 `CF_UNICODETEXT` workers

**Files:**

- Create: `C:\Users\dev\zcode-cua\test\native\windows-clipboard.test.ts`
- Modify: `C:\Users\dev\zcode-cua\src\native\ax_win.cc`

**Interfaces:**

- Consumes: Task 1 outcome strings and raw addon function names.
- Produces:
  - `readClipboardTextAsync(): Promise<{ok:true,text:string}|{ok:false,error:string}>`
  - `writeClipboardTextAsync(text): Promise<{ok:true}|{ok:false,error:string}>`

- [ ] **Step 1: Write native source and compiled-export RED tests**

Create `test/native/windows-clipboard.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../../src/native/ax_win.cc", import.meta.url), "utf8");
const readStart = source.indexOf("void ExecuteReadClipboard");
const readEnd = source.indexOf("class ClipboardReadWorker", readStart);
const readSection = source.slice(readStart, readEnd);

describe("Windows native clipboard source contract", () => {
  it("uses independent bounded worker synchronization", () => {
    expect(source).toContain("std::timed_mutex g_clipboardMutex");
    expect(source).toContain("std::chrono::milliseconds(250)");
    expect(source).toContain("kClipboardOpenAttempts = 8");
    expect(source).toContain("kClipboardOpenRetryDelayMs = 10");
    expect(source).toContain("class ClipboardReadWorker : public Napi::AsyncWorker");
    expect(source).toContain("class ClipboardWriteWorker : public Napi::AsyncWorker");
    expect(source).not.toContain("execFile");
    expect(source).not.toContain("PowerShell");
  });

  it("bounds read memory and closes every opened clipboard", () => {
    expect(source).toContain("class ClipboardCloseGuard");
    expect(source).toContain("GlobalSize");
    expect(source).toContain("kMaxClipboardUtf16CodeUnits = 8 * 1024 * 1024");
    expect(source).toContain("CF_UNICODETEXT");
    expect(readStart).toBeGreaterThanOrEqual(0);
    expect(readEnd).toBeGreaterThan(readStart);
    expect(readSection).not.toContain("wcslen");
  });

  it("allocates before mutation and transfers HGLOBAL ownership only on success", () => {
    const writeStart = source.indexOf("void ExecuteWriteClipboard");
    const writeEnd = source.indexOf("class ClipboardWriteWorker", writeStart);
    const writeSection = source.slice(writeStart, writeEnd);
    expect(writeSection.indexOf("GlobalAlloc")).toBeLessThan(writeSection.indexOf("OpenClipboard"));
    expect(writeSection.indexOf("GlobalLock")).toBeLessThan(writeSection.indexOf("EmptyClipboard"));
    expect(writeSection).toContain("SetClipboardData(CF_UNICODETEXT");
    expect(writeSection).toContain("memory.release()");
  });

  it("exports only the additive async clipboard pair", () => {
    expect(source).toContain(
      'exports.Set("readClipboardTextAsync", Napi::Function::New(env, ReadClipboardTextAsync))',
    );
    expect(source).toContain(
      'exports.Set("writeClipboardTextAsync", Napi::Function::New(env, WriteClipboardTextAsync))',
    );
    expect(source).not.toContain('exports.Set("readClipboardText",');
    expect(source).not.toContain('exports.Set("writeClipboardText",');
  });
});

const loader = require("../../src/native/win.cjs") as {
  available: boolean;
  native: Record<string, unknown> | null;
};
const describeIfNative = loader.available ? describe : describe.skip;

describeIfNative("compiled Windows clipboard ABI", () => {
  it("exports the async pair without touching the live clipboard", () => {
    expect(typeof loader.native!.readClipboardTextAsync).toBe("function");
    expect(typeof loader.native!.writeClipboardTextAsync).toBe("function");
  });
});
```

- [ ] **Step 2: Run source test and verify RED**

```powershell
cd C:\Users\dev\zcode-cua
pnpm exec vitest run test/native/windows-clipboard.test.ts
```

Expected: source assertions fail because the workers, constants and exports do not exist.

- [ ] **Step 3: Add Win32 clipboard primitives**

Add `<algorithm>`, `<chrono>`, `<memory>`, `<thread>` and `<vector>` if not already present. Near the existing global input state, add:

```cpp
constexpr size_t kMaxClipboardUtf16CodeUnits = 8 * 1024 * 1024;
constexpr int kClipboardOpenAttempts = 8;
constexpr DWORD kClipboardOpenRetryDelayMs = 10;
std::timed_mutex g_clipboardMutex;

class ClipboardCloseGuard {
 public:
  ClipboardCloseGuard() : opened_(false) {}
  ClipboardCloseGuard(const ClipboardCloseGuard&) = delete;
  ClipboardCloseGuard& operator=(const ClipboardCloseGuard&) = delete;
  ~ClipboardCloseGuard() {
    if (opened_) CloseClipboard();
  }
  void MarkOpened() { opened_ = true; }

 private:
  bool opened_;
};

struct GlobalMemoryDeleter {
  void operator()(void* memory) const {
    if (memory) GlobalFree(static_cast<HGLOBAL>(memory));
  }
};
using OwnedGlobalMemory = std::unique_ptr<void, GlobalMemoryDeleter>;

bool OpenClipboardBounded(ClipboardCloseGuard* guard) {
  for (int attempt = 0; attempt < kClipboardOpenAttempts; ++attempt) {
    if (OpenClipboard(nullptr)) {
      guard->MarkOpened();
      return true;
    }
    if (attempt + 1 < kClipboardOpenAttempts) {
      Sleep(kClipboardOpenRetryDelayMs);
    }
  }
  return false;
}
```

Use a local enum whose string conversion is exhaustive:

```cpp
enum class ClipboardError {
  kNone,
  kBusy,
  kUnavailable,
  kInvalidData,
  kTooLarge,
  kWriteFailed,
};

const char* ClipboardErrorText(ClipboardError error) {
  switch (error) {
    case ClipboardError::kBusy: return "busy";
    case ClipboardError::kUnavailable: return "unavailable";
    case ClipboardError::kInvalidData: return "invalid_data";
    case ClipboardError::kTooLarge: return "too_large";
    case ClipboardError::kWriteFailed: return "write_failed";
    case ClipboardError::kNone: return "";
  }
  return "unavailable";
}
```

- [ ] **Step 4: Implement strict conversions and the bounded read operation**

Implement conversion helpers with `WC_ERR_INVALID_CHARS` / `MB_ERR_INVALID_CHARS`; neither helper may touch N-API values:

```cpp
bool Utf16ToUtf8(const wchar_t* text, size_t length, std::string* out) {
  if (length == 0) {
    out->clear();
    return true;
  }
  if (length > static_cast<size_t>(INT_MAX)) return false;
  int size = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, text, static_cast<int>(length),
      nullptr, 0, nullptr, nullptr);
  if (size <= 0) return false;
  out->resize(static_cast<size_t>(size));
  return WideCharToMultiByte(
             CP_UTF8, WC_ERR_INVALID_CHARS, text, static_cast<int>(length),
             out->data(), size, nullptr, nullptr) == size;
}

bool Utf8ToUtf16(const std::string& text, std::wstring* out) {
  if (text.empty()) {
    out->clear();
    return true;
  }
  if (text.size() > static_cast<size_t>(INT_MAX)) return false;
  int size = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()),
      nullptr, 0);
  if (size <= 0) return false;
  out->resize(static_cast<size_t>(size));
  return MultiByteToWideChar(
             CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
             static_cast<int>(text.size()), out->data(), size) == size;
}
```

The read worker execution must follow this order:

```cpp
void ExecuteReadClipboard(
    ClipboardError* error,
    std::string* text) {
  std::unique_lock<std::timed_mutex> lock(
      g_clipboardMutex, std::defer_lock);
  if (!lock.try_lock_for(std::chrono::milliseconds(250))) {
    *error = ClipboardError::kBusy;
    return;
  }
  ClipboardCloseGuard close_guard;
  if (!OpenClipboardBounded(&close_guard)) {
    *error = ClipboardError::kUnavailable;
    return;
  }
  if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) {
    text->clear();
    return;
  }
  HANDLE handle = GetClipboardData(CF_UNICODETEXT);
  if (!handle) {
    *error = ClipboardError::kInvalidData;
    return;
  }
  SIZE_T bytes = GlobalSize(handle);
  if (
      bytes < sizeof(wchar_t) ||
      bytes % sizeof(wchar_t) != 0) {
    *error = ClipboardError::kInvalidData;
    return;
  }
  const wchar_t* data = static_cast<const wchar_t*>(GlobalLock(handle));
  if (!data) {
    *error = ClipboardError::kInvalidData;
    return;
  }
  const size_t capacity = bytes / sizeof(wchar_t);
  const size_t scan_limit = std::min(
      capacity, kMaxClipboardUtf16CodeUnits + 1);
  size_t length = 0;
  while (length < scan_limit && data[length] != L'\0') ++length;
  if (length == scan_limit) {
    GlobalUnlock(handle);
    *error = capacity > kMaxClipboardUtf16CodeUnits
        ? ClipboardError::kTooLarge
        : ClipboardError::kInvalidData;
    return;
  }
  if (length > kMaxClipboardUtf16CodeUnits) {
    GlobalUnlock(handle);
    *error = ClipboardError::kTooLarge;
    return;
  }
  const bool converted = Utf16ToUtf8(data, length, text);
  GlobalUnlock(handle);
  if (!converted) *error = ClipboardError::kInvalidData;
}
```

Use these outcome constructors and worker:

```cpp
Napi::Object ClipboardReadOutcomeObject(
    Napi::Env env,
    ClipboardError error,
    const std::string& text) {
  Napi::Object outcome = Napi::Object::New(env);
  const bool ok = error == ClipboardError::kNone;
  outcome.Set("ok", Napi::Boolean::New(env, ok));
  if (ok) {
    outcome.Set("text", Napi::String::New(env, text));
  } else {
    outcome.Set("error", Napi::String::New(env, ClipboardErrorText(error)));
  }
  return outcome;
}

class ClipboardReadWorker : public Napi::AsyncWorker {
 public:
  explicit ClipboardReadWorker(Napi::Env env)
      : Napi::AsyncWorker(env, "ClipboardReadWorker"),
        error_(ClipboardError::kNone),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    ExecuteReadClipboard(&error_, &text_);
  }

  void OnOK() override {
    deferred_.Resolve(ClipboardReadOutcomeObject(Env(), error_, text_));
  }

  void OnError(const Napi::Error& /*error*/) override {
    deferred_.Resolve(ClipboardReadOutcomeObject(
        Env(), ClipboardError::kUnavailable, std::string()));
  }

  Napi::Promise Promise() const { return deferred_.Promise(); }

 private:
  ClipboardError error_;
  std::string text_;
  Napi::Promise::Deferred deferred_;
};
```

`OnError()` intentionally resolves `unavailable` and never exposes a native exception message.

- [ ] **Step 5: Implement preallocated write ownership and async entry points**

The write execution must copy and allocate before `OpenClipboard`:

```cpp
void ExecuteWriteClipboard(
    const std::string& input,
    ClipboardError* error) {
  std::wstring text;
  if (!Utf8ToUtf16(input, &text)) {
    *error = ClipboardError::kWriteFailed;
    return;
  }
  if (text.size() > kMaxClipboardUtf16CodeUnits) {
    *error = ClipboardError::kTooLarge;
    return;
  }
  const size_t units_with_nul = text.size() + 1;
  if (units_with_nul > SIZE_MAX / sizeof(wchar_t)) {
    *error = ClipboardError::kTooLarge;
    return;
  }
  OwnedGlobalMemory memory(
      GlobalAlloc(GMEM_MOVEABLE, units_with_nul * sizeof(wchar_t)));
  if (!memory) {
    *error = ClipboardError::kUnavailable;
    return;
  }
  void* destination = GlobalLock(static_cast<HGLOBAL>(memory.get()));
  if (!destination) {
    *error = ClipboardError::kUnavailable;
    return;
  }
  memcpy(destination, text.c_str(), units_with_nul * sizeof(wchar_t));
  GlobalUnlock(static_cast<HGLOBAL>(memory.get()));

  std::unique_lock<std::timed_mutex> lock(
      g_clipboardMutex, std::defer_lock);
  if (!lock.try_lock_for(std::chrono::milliseconds(250))) {
    *error = ClipboardError::kBusy;
    return;
  }
  ClipboardCloseGuard close_guard;
  if (!OpenClipboardBounded(&close_guard)) {
    *error = ClipboardError::kUnavailable;
    return;
  }
  if (!EmptyClipboard()) {
    *error = ClipboardError::kWriteFailed;
    return;
  }
  if (!SetClipboardData(
          CF_UNICODETEXT,
          static_cast<HGLOBAL>(memory.get()))) {
    *error = ClipboardError::kWriteFailed;
    return;
  }
  memory.release();
}
```

Use the write outcome and worker below; it stores a copied `std::string`, never a `Napi::String`:

```cpp
Napi::Object ClipboardWriteOutcomeObject(
    Napi::Env env,
    ClipboardError error) {
  Napi::Object outcome = Napi::Object::New(env);
  const bool ok = error == ClipboardError::kNone;
  outcome.Set("ok", Napi::Boolean::New(env, ok));
  if (!ok) {
    outcome.Set("error", Napi::String::New(env, ClipboardErrorText(error)));
  }
  return outcome;
}

class ClipboardWriteWorker : public Napi::AsyncWorker {
 public:
  ClipboardWriteWorker(Napi::Env env, std::string input)
      : Napi::AsyncWorker(env, "ClipboardWriteWorker"),
        input_(std::move(input)),
        error_(ClipboardError::kNone),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    ExecuteWriteClipboard(input_, &error_);
  }

  void OnOK() override {
    deferred_.Resolve(ClipboardWriteOutcomeObject(Env(), error_));
  }

  void OnError(const Napi::Error& /*error*/) override {
    deferred_.Resolve(ClipboardWriteOutcomeObject(
        Env(), ClipboardError::kUnavailable));
  }

  Napi::Promise Promise() const { return deferred_.Promise(); }

 private:
  std::string input_;
  ClipboardError error_;
  Napi::Promise::Deferred deferred_;
};
```

Add non-throwing allocation-failure helpers and the N-API entry points:

```cpp
Napi::Promise ResolvedClipboardReadFailure(
    Napi::Env env,
    ClipboardError error) {
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  deferred.Resolve(ClipboardReadOutcomeObject(env, error, std::string()));
  return deferred.Promise();
}

Napi::Promise ResolvedClipboardWriteFailure(
    Napi::Env env,
    ClipboardError error) {
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  deferred.Resolve(ClipboardWriteOutcomeObject(env, error));
  return deferred.Promise();
}

Napi::Value ReadClipboardTextAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* worker = new (std::nothrow) ClipboardReadWorker(env);
  if (!worker) {
    return ResolvedClipboardReadFailure(
        env, ClipboardError::kUnavailable);
  }
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

Napi::Value WriteClipboardTextAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsString()) {
    Napi::TypeError::New(
        env, "writeClipboardTextAsync(text) expects one string")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string input = info[0].As<Napi::String>().Utf8Value();
  auto* worker = new (std::nothrow) ClipboardWriteWorker(
      env, std::move(input));
  if (!worker) {
    return ResolvedClipboardWriteFailure(
        env, ClipboardError::kUnavailable);
  }
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}
```

Register:

```cpp
exports.Set(
    "readClipboardTextAsync",
    Napi::Function::New(env, ReadClipboardTextAsync));
exports.Set(
    "writeClipboardTextAsync",
    Napi::Function::New(env, WriteClipboardTextAsync));
```

Add Chinese comments explaining:

- 根因：Win32 clipboard API 同步且可能被其他进程短暂占用，不能阻塞 broker/N-API 线程。
- 根因：`SetClipboardData` 成功后 Windows 接管 `HGLOBAL`，更早路径仍由 worker 释放，防止 double free 或泄漏。
- 根因：无界 `wcslen` 会越过恶意/损坏 clipboard block，必须以 `GlobalSize` 为上界。

- [ ] **Step 6: Rebuild and verify source plus compiled ABI**

```powershell
cd C:\Users\dev\zcode-cua
pnpm rebuild:native
pnpm exec vitest run test/native/windows-clipboard.test.ts test/windows-native-clipboard-adapter.test.ts test/windows-capability-truthfulness.test.ts
pnpm typecheck
```

Expected: rebuild exit 0; compiled addon exports both functions; tests do not call either function against the live clipboard.

- [ ] **Step 7: Commit the native implementation**

```powershell
git add src/native/ax_win.cc test/native/windows-clipboard.test.ts
git commit -m "feat(windows): implement native text clipboard"
```

---

### Task 4: Add an opt-in real broker clipboard round-trip

**Files:**

- Create: `C:\Users\dev\zcode-cua\scripts\windows-clipboard-live-smoke.mjs`
- Create: `C:\Users\dev\zcode-cua\test\windows-clipboard-live-smoke.test.ts`
- Modify: `C:\Users\dev\zcode-cua\package.json`

**Interfaces:**

- Consumes: `dist/windows-helper.js`, `build/Release/ax_native.node`, `PermissionBrokerClient`, real Windows named pipe.
- Produces: `pnpm smoke:windows:clipboard`.

- [ ] **Step 1: Write the disabled-by-default RED test**

Create `test/windows-clipboard-live-smoke.test.ts`:

```ts
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptUrl = new URL("../scripts/windows-clipboard-live-smoke.mjs", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const source = readFileSync(scriptUrl, "utf8");

describe("Windows clipboard live smoke guard", () => {
  it("checks explicit opt-in before invoking the live run", () => {
    const guard = source.indexOf('process.env[OPT_IN_ENV] !== "1"');
    const invocation = source.indexOf("await runLiveSmoke()");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(invocation).toBeGreaterThan(guard);
  });

  it("exits 2 without opt-in", async () => {
    try {
      await execFileAsync(process.execPath, [scriptPath], {
        env: {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.PATH,
        },
      });
      throw new Error("expected disabled smoke to exit non-zero");
    } catch (error) {
      expect(error).toMatchObject({ code: 2 });
      expect(String((error as { stderr?: string }).stderr)).toMatch(/disabled|requires win32/i);
    }
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
cd C:\Users\dev\zcode-cua
pnpm exec vitest run test/windows-clipboard-live-smoke.test.ts
```

Expected: FAIL because the smoke script does not exist.

- [ ] **Step 3: Implement the live smoke with unconditional restoration**

Base lifecycle, random pipe/token, ready verification and clean shutdown on `windows-pointer-live-smoke.mjs`, but use this exact summary surface:

```js
const OPT_IN_ENV = "ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE";
const summary = {
  platform: process.platform,
  helperReady: false,
  clipboardCapability: false,
  originalRead: false,
  markerWritten: false,
  markerReadBack: false,
  originalRestored: false,
  restorationVerified: false,
  cleanHelperExit: false,
};
```

The live operation body must be:

```js
let originalText;
let markerWritten = false;
try {
  failureStage = "broker-info";
  const brokerInfo = await client.call("broker_info", {});
  summary.clipboardCapability = brokerInfo?.capabilities?.clipboard === true;
  if (!summary.clipboardCapability) {
    throw new Error("native clipboard capability is unavailable");
  }

  failureStage = "read-original";
  originalText = await client.call("read_clipboard", {});
  if (typeof originalText !== "string") {
    throw new Error("original clipboard text was not a string");
  }
  summary.originalRead = true;

  const marker = `zcode-cua-clipboard-smoke-${randomBytes(16).toString("hex")}`;
  failureStage = "write-marker";
  await client.call("write_clipboard", { text: marker });
  markerWritten = true;
  summary.markerWritten = true;

  failureStage = "read-marker";
  const observed = await client.call("read_clipboard", {});
  summary.markerReadBack = observed === marker;
  if (!summary.markerReadBack) {
    throw new Error("clipboard marker did not round-trip");
  }
} finally {
  if (summary.originalRead && typeof originalText === "string") {
    failureStage = "restore-original";
    await client.call("write_clipboard", { text: originalText });
    summary.originalRestored = true;
    const restored = await client.call("read_clipboard", {});
    summary.restorationVerified = restored === originalText;
    if (!summary.restorationVerified) {
      throw new Error("clipboard restoration could not be verified");
    }
  } else if (markerWritten) {
    throw new Error("clipboard marker may remain because the original text was unavailable");
  }
}
```

The outermost `finally` must always request Helper shutdown and verify exit code 0. The final stdout must be only `JSON.stringify(summary)`; stderr may contain the failure stage but not the original text, marker, token or pipe. If restoration fails, stderr must include: `clipboard may still contain the smoke marker`.

Before calling `runLiveSmoke()`:

```js
if (process.platform !== "win32") {
  failPreflight("Windows clipboard live smoke requires win32.");
} else if (process.env[OPT_IN_ENV] !== "1") {
  failPreflight(`Windows clipboard live smoke is disabled; set ${OPT_IN_ENV}=1 to opt in.`);
} else {
  await runLiveSmoke();
}
```

Add to `package.json`:

```json
"smoke:windows:clipboard": "node scripts/windows-clipboard-live-smoke.mjs"
```

- [ ] **Step 4: Verify the default path cannot touch the clipboard**

```powershell
cd C:\Users\dev\zcode-cua
Remove-Item Env:ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE -ErrorAction SilentlyContinue
pnpm exec vitest run test/windows-clipboard-live-smoke.test.ts
pnpm smoke:windows:clipboard
```

Expected: Vitest exits 0; direct smoke exits 2 before Helper startup and prints only the opt-in instruction.

- [ ] **Step 5: Run the explicit live smoke once**

Warn the user immediately before this step that pure-text replacement drops any existing non-text clipboard formats. Then run:

```powershell
cd C:\Users\dev\zcode-cua
pnpm build
$env:ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE='1'
pnpm smoke:windows:clipboard
Remove-Item Env:ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE
```

Expected JSON booleans: every field except `platform` is `true`; exit 0; original pure text is restored and re-read exactly. If any field is false, stop feature completion, preserve a redacted failure-stage record, and do not claim live acceptance.

- [ ] **Step 6: Commit the smoke**

```powershell
git add scripts/windows-clipboard-live-smoke.mjs test/windows-clipboard-live-smoke.test.ts package.json
git commit -m "test(windows): add clipboard live smoke"
```

---

### Task 5: Update platform truth and source-development runbook

**Files:**

- Modify: `C:\Users\dev\zcode-cua\docs\platforms.md`
- Modify: `C:\Users\dev\z-code\docs\cua\windows-source-development.md`

**Interfaces:**

- Consumes: verified outcomes from Tasks 1–4.
- Produces: current facts for developers and future product closure.

- [ ] **Step 1: Update `zcode-cua/docs/platforms.md`**

Move native clipboard out of “未实现能力”. Record:

```text
Windows source Helper 通过 ax_native.node 的 additive async ABI 读写
CF_UNICODETEXT。只有 readClipboardTextAsync 与 writeClipboardTextAsync
同时存在时 broker_info.capabilities.clipboard 才为 true；旧 addon 或任一
导出缺失时继续 false。Helper 使用独立 timed mutex 和有界
OpenClipboard 重试，单次文本上限为 8 Mi UTF-16 code units。
```

Document outcome mapping, no shell/Electron fallback, pure-text replacement semantics, and the exact opt-in command. Keep WGC and UIA worker isolation listed as pending.

- [ ] **Step 2: Update `z-code/docs/cua/windows-source-development.md`**

Add source build and live verification:

```powershell
cd C:\Users\dev\zcode-cua
pnpm rebuild:native
pnpm build
$env:ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE='1'
pnpm smoke:windows:clipboard
Remove-Item Env:ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE
```

Record these boundaries:

- local desktop continuous source Helper only;
- no SSH/WSL/Docker/remote/mobile changes;
- no dependency on pointer foreground gate;
- Session 0/non-interactive startup still fail closed;
- lock screen does not authorize pointer input, even though the same logged-in session may expose clipboard;
- live smoke replaces all clipboard formats with pure text during the test and restores only pure text;
- product packaging/signing remains a later closure.

Add the actual machine/date/build/test results from Task 4 without recording text, token or pipe.

- [ ] **Step 3: Review docs against runtime facts**

Run:

```powershell
rg -n "clipboard|CF_UNICODETEXT|PowerShell|WGC|UIA worker|remote|smoke:windows:clipboard" C:\Users\dev\zcode-cua\docs\platforms.md C:\Users\dev\z-code\docs\cua\windows-source-development.md
```

Expected: native clipboard is described as implemented only for Windows source Helper; WGC/UIA worker/product packaging remain pending; no remote claim is broadened.

- [ ] **Step 4: Commit docs in their owning repositories**

```powershell
cd C:\Users\dev\zcode-cua
git add docs/platforms.md
git commit -m "docs(windows): record native clipboard support"

cd C:\Users\dev\z-code
git add docs/cua/windows-source-development.md
git commit -m "docs(cua): record Windows clipboard source flow"
```

---

### Task 6: Regenerate artifacts and run proportionate regression gates

**Files:**

- Modify by generator: `C:\Users\dev\zcode-cua\dist\**`
- Verify only: both worktrees and all files from Tasks 1–5.

**Interfaces:**

- Consumes: all prior task commits.
- Produces: shippable source-development artifacts plus an evidence-backed gate report.

- [ ] **Step 1: Run all `zcode-cua` focused gates**

```powershell
cd C:\Users\dev\zcode-cua
pnpm rebuild:native
pnpm exec vitest run test/windows-native-clipboard-adapter.test.ts test/windows-capability-truthfulness.test.ts test/native/windows-clipboard.test.ts test/windows-clipboard-live-smoke.test.ts test/broker/windowsSystemSurface.test.ts test/annotations.test.ts test/broker/types.brokerMethods.test.ts test/broker/types.readOnlyMethods.test.ts
pnpm typecheck
pnpm lint
```

Expected: all commands exit 0; lint may print only the already-known warning baseline, with zero errors.

- [ ] **Step 2: Build and run the full `zcode-cua` suite**

```powershell
cd C:\Users\dev\zcode-cua
pnpm build
pnpm test
```

Expected: exit 0. Record exact passed、skipped 和待处理数量 from this run instead of copying old counts.

- [ ] **Step 3: Verify the source ZCode integration without remote paths**

```powershell
cd C:\Users\dev\z-code
$env:ZCODE_CUA_DEV_ROOT='C:\Users\dev\zcode-cua'
pnpm exec vitest run packages/services/test/windowsCuaDevHelper.integration.test.ts
pnpm exec vitest run packages/services/test/cua
pnpm --filter @zcode/zcode-cua-plugin test
Remove-Item Env:ZCODE_CUA_DEV_ROOT
pnpm typecheck
pnpm lint
```

Expected: Helper integration, CUA focused suite, official plugin, typecheck and lint exit 0. Confirm no SSH/WSL/Docker/remote/mobile process was started.

- [ ] **Step 4: Execute and classify the full ZCode affected-unit baseline**

```powershell
cd C:\Users\dev\z-code
pnpm test:unit:affected
```

Expected: capture exact exit code and failing file/test names. Any CUA, Helper lifecycle, broker, clipboard, process leak or new type/lint failure blocks completion. Previously documented unrelated Windows baseline failures may be reported separately but may not be labelled “passed”.

- [ ] **Step 5: Check generated changes and process hygiene**

```powershell
cd C:\Users\dev\zcode-cua
git status --short
git diff --check

cd C:\Users\dev\z-code
git status --short
git diff --check

Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -match 'windows-helper\.js|__zcode-plugin-host'
  } |
  Select-Object ProcessId, ParentProcessId, Name
```

Expected: `git diff --check` exits 0; only generated `zcode-cua/dist/**` changes remain; no orphan Helper/plugin-host process remains. Do not terminate unrelated user processes.

- [ ] **Step 6: Commit generated artifacts**

```powershell
cd C:\Users\dev\zcode-cua
git add dist
git commit -m "build(windows): regenerate clipboard artifacts"
```

- [ ] **Step 7: Final clean-tree and commit audit**

```powershell
cd C:\Users\dev\zcode-cua
git status --short --branch
git log -5 --oneline

cd C:\Users\dev\z-code
git status --short --branch
git log -3 --oneline
```

Expected: both worktrees clean. Final report must distinguish:

- source unit/build gates;
- real clipboard live round-trip and restoration;
- ZCode source Helper integration;
- known non-CUA full-suite baseline;
- still-pending WGC, UIA worker isolation, product packaging/signing;
- still-pending pointer live acceptance if the foreground remains `LockApp`.

## Self-Review Checklist

- [x] Spec coverage: every ABI, timing, size, ownership, capability, error, logging, lifecycle, platform and smoke requirement maps to a task above.
- [x] Placeholder scan: the plan contains no deferred implementation marker; every code-changing step names exact files, interfaces, commands and expected results.
- [x] Type consistency: `NativeClipboardReadOutcome` / `NativeClipboardWriteOutcome`, async export names and broker handler names are identical across Tasks 1–4.
- [x] Platform boundary: Windows native pair selection is isolated in `createNodeAutomationAdapter`; macOS/Linux system surface and remote/mobile architecture are unchanged.
- [x] Safety boundary: default smoke exits before Helper startup; live smoke restores in `finally`; no clipboard contents enter output.
- [x] Product truth: 30 tools remain unchanged; WGC/UIA worker/product closure remain explicitly pending.
