# Windows CUA Operation Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 本机 Computer Use turn 首次开始真实桌面工具后，显示不抢焦点、鼠标穿透且不会进入截图的顶部“ZCode 正在操作电脑”提示，并在 turn/Host/runtime 终态可靠隐藏。

**Architecture:** `ZCodeAgentService` 在协议校验、seq 归一化和 live 去重之后把事件交给纯状态机 `CuaOperationTurnTracker`；仅 desktop-local Windows Host 把状态跃迁通过严格 Host→Main 消息上报。Desktop Main 按 `UtilityProcess source + workspaceKey + sessionId + turnId` 聚合活跃键，并以独立透明 `BrowserWindow` 投影 UI；状态不进入 Renderer、task snapshot、broadcast 或 mobile replayable 链路。

**Tech Stack:** TypeScript 6、Zod、Vitest 4、Electron 41 `BrowserWindow`/`screen`、Services `createServiceLogger`、现有 Host `utilityProcess` postMessage。

## Global Constraints

- 仅 Windows desktop-local 创建顶部提示；macOS、Linux、remote workspace、server、普通 Web 不创建。
- 手机 `/remote` 复用同一个 desktop-local Host 时允许显示物理 Windows 屏幕提示，但不新增手机 UI 或 replayable 事件。
- 工具身份只接受 canonical `mcp__computer-use__*` 和 official namespaced `mcp__plugin_zcode-cua_computer-use__*`，不新增 `computer_use` 链路。
- `workspaceKey = workspaceIdentity?.trim() || workspacePath`；路径 IO/展示继续使用 `workspacePath`。
- `wait`、`request_access` 不激活；`stop_computer_control` 立即清理当前 session。
- 单工具 result/error 不隐藏；`turn.completed`、`turn.failed`、`session.closed`、runtime/workspace dispose、Host exit、app quit 才收口。
- 浮层必须 `focusable: false`、`skipTaskbar: true`、`setIgnoreMouseEvents(true)`、`setContentProtection(true)`。
- 不修改 `zcode-cua` broker/native wire protocol，不新增依赖。
- 新增/修改行为先观察失败测试，再写最小实现；最终执行 `pnpm typecheck` 与 `pnpm lint`。

---

## File Structure

- Create `packages/services/src/zcode-agent/cuaOperationTurnTracker.ts`: 纯 turn/session/workspace 状态机和 reporter 类型。
- Create `packages/services/test/cuaOperationTurnTracker.test.ts`: tracker 的 canonical tool、幂等、终态和隔离测试。
- Modify `packages/services/src/zcode-agent/zcodeAgentService.ts`: 在 live 去重后接入 tracker，并在 runtime/dispose 边界清理。
- Modify `packages/services/test/zcodeAgentService.test.ts`: 真实 notification→去重→reporter 集成测试。
- Modify `packages/services/src/node.ts`: 暴露 reporter 注入点，并只允许 `desktop-local` authority 接入。
- Modify `packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`: authority gate 测试。
- Modify `packages/shared/src/channels.ts`: 新增 Host response type 常量。
- Modify `packages/shared/src/validation.ts`: 新增严格 `cua-operation-state` schema 与导出类型。
- Modify `packages/shared/test/validation.test.ts`: Host payload 接受/拒绝测试。
- Modify `packages/desktop/src/host/index.ts`: Windows local Host reporter → parentPort。
- Modify `packages/desktop/src/main/desktopHostProcess.ts`: 校验后转发状态，并在 child exit 清理 source。
- Create `packages/desktop/src/main/windowsCuaOperationIndicator.ts`: source 聚合、窗口生命周期、定位、文案和动画。
- Create `packages/desktop/test/windowsCuaOperationIndicator.test.ts`: 窗口属性、聚合、DPI/display、locale、hide/recreate 测试。
- Modify `packages/desktop/test/desktopHostProcess.test.ts`: Host message routing/exit cleanup 测试。
- Modify `packages/desktop/src/main/index.ts`: 实例化 indicator、两个 Host spawn 入口接线、locale/app quit 同步。
- Modify `apps/dev-docs/src/data/productCapabilityMap.ts`: 把 Windows turn-level indicator 标为当前能力并增加 local Host 状态边。
- Modify `apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts`: 能力图防漂移测试。
- Modify `docs/product-capability-map-office-computer-use.md`: 更新 Windows current fact、状态 owner 与链路图。

---

### Task 1: Strict Host→Main State Contract

**Files:**

- Modify: `packages/shared/src/channels.ts`
- Modify: `packages/shared/src/validation.ts`
- Test: `packages/shared/test/validation.test.ts`

**Interfaces:**

- Produces: `HostResponseTypes.CuaOperationState`
- Produces: `hostCuaOperationStateResponseSchema`
- Produces: `HostCuaOperationStateResponse`

- [ ] **Step 1: Write the failing schema tests**

Add one acceptance test and a table of invalid payloads:

```ts
it("accepts a strict CUA operation state payload", () => {
  expect(
    hostResponseMessageSchema.safeParse({
      type: HostResponseTypes.CuaOperationState,
      active: true,
      sessionId: "sess-1",
      turnId: "turn-1",
      workspacePath: "C:\\repo",
      workspaceIdentity: "local:test",
    }).success,
  ).toBe(true);
});

it.each([{ active: "true" }, { sessionId: "" }, { turnId: "" }, { workspacePath: "" }])(
  "rejects invalid CUA operation state payload %#",
  (override) => {
    expect(
      hostResponseMessageSchema.safeParse({
        type: "cua-operation-state",
        active: true,
        sessionId: "sess-1",
        turnId: "turn-1",
        workspacePath: "C:\\repo",
        ...override,
      }).success,
    ).toBe(false);
  },
);
```

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run packages/shared/test/validation.test.ts`

Expected: FAIL because `HostResponseTypes.CuaOperationState` and the discriminated-union member do not exist.

- [ ] **Step 3: Add the minimal strict contract**

Add the response constant and schema:

```ts
CuaOperationState: "cua-operation-state",

export const hostCuaOperationStateResponseSchema = z.object({
  type: z.literal("cua-operation-state"),
  active: z.boolean(),
  sessionId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
});

export type HostCuaOperationStateResponse = z.infer<
  typeof hostCuaOperationStateResponseSchema
>;
```

Insert the schema into `hostResponseMessageSchema`.

- [ ] **Step 4: Run GREEN**

Run: `pnpm exec vitest run packages/shared/test/validation.test.ts`

Expected: PASS.

---

### Task 2: Turn-Level CUA Tracker and Services Wiring

**Files:**

- Create: `packages/services/src/zcode-agent/cuaOperationTurnTracker.ts`
- Create: `packages/services/test/cuaOperationTurnTracker.test.ts`
- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`
- Modify: `packages/services/test/zcodeAgentService.test.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`

**Interfaces:**

- Consumes: `ZCodeSessionEvent`, `ZCodeAgentWorkspaceTarget`, `resolveWorkspaceKey`
- Produces: `CuaOperationState`, `CuaOperationStateReporter`, `CuaOperationTurnTracker`
- Produces: `createCuaOperationTurnTracker({ reporter })`
- Produces: `shouldEnableCuaOperationStateReporter({ serviceAuthorityMode, hasReporter })`

- [ ] **Step 1: Write failing tracker behavior tests**

Use a real tracker with an array reporter and protocol-valid event fixtures. Cover these separate assertions:

```ts
tracker.accept(workspace, turnStarted("turn-1"));
tracker.accept(workspace, toolScheduled("turn-1", "call-1", "mcp__computer-use__left_click"));
tracker.accept(workspace, toolStarted("turn-1", "call-1"));
expect(states).toEqual([{ active: true, sessionId: "sess-1", turnId: "turn-1", workspacePath }]);

tracker.accept(workspace, toolResult("turn-1", "call-1"));
expect(states).toHaveLength(1);
tracker.accept(workspace, turnCompleted("turn-1"));
expect(states.at(-1)).toMatchObject({ active: false, turnId: "turn-1" });
```

Also test started-with-toolName fallback, duplicate CUA started, namespaced official tool, underscore rejection, ordinary MCP rejection, `wait`/`request_access`, `stop_computer_control`, new-turn replacement, failed/session.closed, missing turnId, workspaceIdentity isolation, `clearWorkspaceKey`, and `clearAll`.

- [ ] **Step 2: Run tracker RED**

Run: `pnpm exec vitest run packages/services/test/cuaOperationTurnTracker.test.ts`

Expected: FAIL because the tracker module does not exist.

- [ ] **Step 3: Implement the minimal tracker**

Implement the public API:

```ts
export interface CuaOperationState {
  active: boolean;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationStateReporter {
  onStateChanged(event: CuaOperationState): void;
}

export interface CuaOperationTurnTracker {
  accept(workspace: ZCodeAgentWorkspaceTarget, event: ZCodeSessionEvent): void;
  clearWorkspaceKey(workspaceKey: string): void;
  clearAll(): void;
}
```

The tracker stores current turn per workspace/session, scheduled tool names per tool call, and active turn records. It reports only state transitions. Tool matching is exact-prefix based:

```ts
const prefixes = ["mcp__computer-use__", "mcp__plugin_zcode-cua_computer-use__"] as const;
```

`wait` and `request_access` return without activation; `stop_computer_control` clears the session. Terminal and clear methods emit inactive before deleting records. Add Chinese comments explaining that tool results cannot end a turn and why underscore aliases are deliberately excluded.

- [ ] **Step 4: Run tracker GREEN**

Run: `pnpm exec vitest run packages/services/test/cuaOperationTurnTracker.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing authority and integration tests**

Add table assertions for:

```ts
expect(
  shouldEnableCuaOperationStateReporter({
    serviceAuthorityMode: "desktop-local",
    hasReporter: true,
  }),
).toBe(true);
expect(
  shouldEnableCuaOperationStateReporter({
    serviceAuthorityMode: "desktop-attached-remote",
    hasReporter: true,
  }),
).toBe(false);
expect(
  shouldEnableCuaOperationStateReporter({
    serviceAuthorityMode: "standalone-server",
    hasReporter: true,
  }),
).toBe(false);
```

In `zcodeAgentService.test.ts`, inject a reporter into the service fixture, deliver protocol notifications, and assert the reporter receives active then inactive only after live dedup. If the fixture cost makes this test process-isolated, keep it in the existing `zcodeAgentService.test.ts` project rather than mocking the tracker.

- [ ] **Step 6: Run integration RED**

Run: `pnpm exec vitest run packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/services/test/zcodeAgentService.test.ts`

Expected: FAIL because authority gate/options/wiring do not exist.

- [ ] **Step 7: Wire tracker after validation and live dedup**

Extend `CreateZCodeAgentServiceOptions` and `createLocalServices` options with `cuaOperationStateReporter?: CuaOperationStateReporter`. Create the tracker only when the node authority helper returns true, pass it into `createZCodeAgentService`, and call it immediately after `shouldDeliverLiveSessionEvent` succeeds:

```ts
cuaOperationTurnTracker?.accept(workspace, normalizedEvent);
emitSessionEvent(workspace, normalizedEvent.sessionId, {
  type: "session.event",
  event: normalizedEvent,
});
```

Clear by `workspaceKey` from `processManager.onRuntimeRestarted` and `disposeWorkspace`; call `clearAll()` from `disposeLocalState`. Use `createServiceLogger("cua-operation-turn")`: per-event diagnostics are `debug`, state transitions are `info`.

- [ ] **Step 8: Run integration GREEN**

Run: `pnpm exec vitest run packages/services/test/cuaOperationTurnTracker.test.ts packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/services/test/zcodeAgentService.test.ts`

Expected: PASS.

---

### Task 3: Windows Host Reporting and Main Routing

**Files:**

- Modify: `packages/desktop/src/host/index.ts`
- Modify: `packages/desktop/src/main/desktopHostProcess.ts`
- Modify: `packages/desktop/test/desktopHostProcess.test.ts`

**Interfaces:**

- Consumes: `HostResponseTypes.CuaOperationState`, `HostCuaOperationStateResponse`
- Produces dependency callbacks:

```ts
onCuaOperationStateChanged?: (
  source: ElectronUtilityProcess,
  event: HostCuaOperationStateResponse,
) => void;
onCuaOperationStateSourceExited?: (source: ElectronUtilityProcess) => void;
```

- [ ] **Step 1: Write failing routing tests**

Mock `utilityProcess.fork()` with `MockUtilityProcess`, call `spawnHostProcess`, emit a valid `cua-operation-state` message, and assert the callback receives the exact child source and payload. Emit child `exit` and assert `onCuaOperationStateSourceExited(child)` once. Emit an invalid payload and assert no callback.

- [ ] **Step 2: Run routing RED**

Run: `pnpm exec vitest run packages/desktop/test/desktopHostProcess.test.ts`

Expected: FAIL because callback dependencies and response branch do not exist.

- [ ] **Step 3: Add reporter and routing**

In Host define a reporter satisfying the `createLocalServices` option and post:

```ts
parentPort?.postMessage({
  type: HostResponseTypes.CuaOperationState,
  ...event,
});
```

Pass it only inside `InitLocal` and only when `process.platform === "win32"`. In Main, after Zod validation, route the message with the child as source. In the existing child `exit` handler, call source cleanup before deleting maps. Add Chinese comments explaining why main does not parse session events and why Host exit is an authoritative fail-hidden boundary.

- [ ] **Step 4: Run routing GREEN**

Run: `pnpm exec vitest run packages/desktop/test/desktopHostProcess.test.ts`

Expected: PASS.

---

### Task 4: Native Windows Indicator Window

**Files:**

- Create: `packages/desktop/src/main/windowsCuaOperationIndicator.ts`
- Create: `packages/desktop/test/windowsCuaOperationIndicator.test.ts`

**Interfaces:**

- Consumes: `HostCuaOperationStateResponse`, `Locale`, Electron `BrowserWindow` and `screen`
- Produces:

```ts
export interface WindowsCuaOperationIndicator {
  handleState(source: object, event: HostCuaOperationStateResponse): void;
  clearSource(source: object): void;
  refreshContent(): void;
  dispose(): void;
}

export interface WindowsCuaOperationIndicatorWindow {
  readonly webContents: Pick<BrowserWindow["webContents"], "executeJavaScript">;
  destroy(): void;
  hide(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  on(event: "closed", listener: () => void): this;
  setBounds(bounds: Rectangle): void;
  setContentProtection(enable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  showInactive(): void;
}

export function createWindowsCuaOperationIndicator(options: {
  platform?: NodeJS.Platform;
  getLocale: () => Locale;
  logger: { warn(...args: unknown[]): void; debug(...args: unknown[]): void };
  createWindow?: (options: BrowserWindowConstructorOptions) => WindowsCuaOperationIndicatorWindow;
  getCursorScreenPoint?: () => Point;
  getDisplayNearestPoint?: (point: Point) => Pick<Display, "workArea">;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}): WindowsCuaOperationIndicator;
```

- [ ] **Step 1: Write failing indicator tests**

Use injected fake window/screen dependencies and fake timers. Assert separately:

1. non-Windows is a no-op;
2. first active creates with `alwaysOnTop`, `focusable: false`, `frame: false`, `resizable: false`, `show: false`, `skipTaskbar: true`, `transparent: true`;
3. creation calls `setIgnoreMouseEvents(true)` and `setContentProtection(true)`;
4. repeated active is idempotent;
5. two sources/turns remain visible until the final inactive/clearSource;
6. position is `workArea.x + (workArea.width - width) / 2`, `workArea.y + 12`;
7. zh-CN and en-US render exact approved copy;
8. inactive executes exit state, waits 120ms, then hides;
9. active during exit cancels hide;
10. unexpected `closed` schedules one reconcile when active;
11. `loadURL` failure only warns and never throws into CUA state handling;
12. `dispose` destroys and prevents recreation.

- [ ] **Step 2: Run indicator RED**

Run: `pnpm exec vitest run packages/desktop/test/windowsCuaOperationIndicator.test.ts`

Expected: FAIL because the indicator module does not exist.

- [ ] **Step 3: Implement minimal window projection**

Create one lazy `BrowserWindow`. The generated data URL contains a CSP, semantic light/dark colors through `prefers-color-scheme`, 40px compact pill, three-dot animation, 140ms enter/120ms exit, and `prefers-reduced-motion`. Use a base64 data URL so Chinese copy and CSP do not depend on URL escaping.

The active key is:

```ts
const workspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
const turnKey = `${workspaceKey}\0${event.sessionId}\0${event.turnId}`;
```

Store it under the source object. `showInactive()` is called only after `loadURL()` resolves and the aggregate set is still non-empty. Failures log `warn` and never reject into CUA execution. `clearSource` removes all keys for that child. `closed` preserves aggregate state and schedules one reconcile. `setContentProtection(true)` is mandatory to exclude Windows capture.

- [ ] **Step 4: Run indicator GREEN**

Run: `pnpm exec vitest run packages/desktop/test/windowsCuaOperationIndicator.test.ts`

Expected: PASS.

---

### Task 5: Main Composition, Locale/App Quit, and Capability Truth

**Files:**

- Modify: `packages/desktop/src/main/index.ts`
- Modify: `apps/dev-docs/src/data/productCapabilityMap.ts`
- Modify: `apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts`
- Modify: `docs/product-capability-map-office-computer-use.md`

**Interfaces:**

- Consumes: `createWindowsCuaOperationIndicator`
- Connects both `spawnHostProcess` dependency sites to the same singleton.

- [ ] **Step 1: Write failing capability graph assertions**

Assert the `computer-use-task-ux` node scope contains `Windows 顶部 turn 级操作提示`, owner is `Desktop Main native projection + Renderer tool projection`, and a state edge exists from `local-host` to `computer-use-task-ux` labelled `Windows CUA turn 状态`.

- [ ] **Step 2: Run capability RED**

Run: `pnpm exec vitest run apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts`

Expected: FAIL because node/edge still describe only generic tool projection.

- [ ] **Step 3: Compose Main and update docs**

Instantiate once beside the Host maps:

```ts
const windowsCuaOperationIndicator = createWindowsCuaOperationIndicator({
  platform: process.platform,
  getLocale: () => currentApplicationLocale,
  logger,
});
```

At both Host spawn dependency objects wire `handleState` and `clearSource`. In `applyApplicationLocale`, call `refreshContent()` after updating locale. At the beginning of `prepareAppQuit`, call `dispose()` so the prompt disappears before waiting for Host cleanup.

Update the capability node/edge and current-fact document. Preserve the statement that pause/takeover/live video remain planned, and document this exact state chain:

```text
validated live session event
        -> desktop-local Host turn tracker
        -> strict Host→Main cua-operation-state
        -> capture-excluded Windows BrowserWindow
```

- [ ] **Step 4: Run composed focused suite**

Run:

```powershell
pnpm exec vitest run packages/shared/test/validation.test.ts packages/services/test/cuaOperationTurnTracker.test.ts packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/services/test/zcodeAgentService.test.ts packages/desktop/test/desktopHostProcess.test.ts packages/desktop/test/windowsCuaOperationIndicator.test.ts apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts
```

Expected: PASS with zero failed tests and no unhandled errors.

---

### Task 6: Repository Verification and Commit

**Files:**

- Review all paths listed above.

- [ ] **Step 1: Run formatting/diff hygiene checks**

Run: `git diff --check`

Expected: exit 0.

- [ ] **Step 2: Run affected unit tests**

Run: `pnpm test:unit:affected`

Expected: exit 0. If a pre-existing unrelated Windows baseline fails, record exact file/test names; any new CUA/shared/desktop/dev-docs failure blocks completion.

- [ ] **Step 3: Run required typecheck**

Run: `pnpm typecheck`

Expected: exit 0.

- [ ] **Step 4: Run required lint**

Run: `pnpm lint`

Expected: exit 0.

- [ ] **Step 5: Review final diff against spec**

Run:

```powershell
git status --short
git diff --stat
git diff -- packages/shared packages/services packages/desktop apps/dev-docs docs/product-capability-map-office-computer-use.md
```

Confirm every acceptance criterion in `docs/superpowers/specs/2026-08-04-windows-cua-operation-indicator-design.md` has code or test evidence, and confirm no `computer_use` producer/detector was added.

- [ ] **Step 6: Commit implementation**

Run:

```powershell
git add -- packages/shared packages/services packages/desktop apps/dev-docs docs/product-capability-map-office-computer-use.md docs/superpowers/plans/2026-08-04-windows-cua-operation-indicator.md
git diff --cached --check
git commit -m "feat(cua): show Windows operation indicator"
```

Expected: one Conventional Commit, no push.
