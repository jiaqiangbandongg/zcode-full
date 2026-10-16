# 草稿预热会话 runtime 换代重建 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CUA Helper 就绪触发 agent runtime 回收后，草稿态能自动重建预热会话并把图片重传到新会话，重建期间禁止发送。

**Architecture:** 复用已有的 `invalidateDraftRuntime` + `invalidationVersion` 重建通道——在 runtime 换代时递增版本号，coordinator 自动 retire 旧会话并重建。门禁抽成独立 hook（对齐 `useDraftModelReadinessGate` 范式），不往已超 max-lines 的 SessionPane 堆逻辑。附件侧把「作废」与「唤醒」两条链解耦，用 `restartEpoch` 统一唤醒。

**Tech Stack:** React 19 + zustand + vitest；`packages/ui` 为主战场。

**Spec:** `docs/superpowers/specs/2026-08-20-draft-prewarm-runtime-rebuild-design.md`

## Global Constraints

- 分支 `fix/draft-prewarm-runtime-rebuild`，基于 `feat/cua-merge-0819`。不直接提 merge 分支。
- 禁止 `--no-verify` 跳过 git hooks。
- 测试从**仓库根**跑：`pnpm exec vitest run <path> -t "<用例名>"`。从 `packages/ui` 目录跑会撞上根级 workspace 配置而失败。
- 范围只做**草稿态**（`sessionId === null`）。正式会话态（已发送后换代）是非目标，不要顺手改。
- 不修改 `packages/services` 的回收语义，不碰 `hasActiveTurnRef`。
- 重建超时上限 **5000ms**；`runtimeRebuildRetryCount` 上限 **5**；`autoRetryCount` 维持上限 **1** 不动。
- SessionPane.tsx 已 `oxlint-disable eslint(max-lines)`，新增逻辑一律抽 hook，不得在其中新增大段逻辑。

---

### Task 1: 锁死 coordinator 重建假设

整个方案建立在一个假设上：`binding.discard()` 之后递增 `invalidationVersion` 能解除 `blockedInvalidationVersion` 并重建预热会话。读码结论是 `useDraftSessionPrewarm.ts:297-302` 会在版本变化时清掉该闸，但没有测试锁住。先用测试证明它，假设不成立则整个方案要重来。

**本任务预期不需要改产品代码**——只加测试。若测试意外失败，停下来汇报，不要改测试去迁就实现。

**Files:**
- Test: `packages/ui/test/v4DraftSessionPrewarm.test.ts`（在 `describe("useDraftSessionPrewarm workspace owner")` 内追加用例）

**Interfaces:**
- Consumes: 该文件已有的 `PrewarmHarness`、`acceptedCreateAck`、`flushMicrotasks`、`installMinimalDom`、`mountedRoots`
- Produces: 无（纯测试）

- [ ] **Step 1: 写用例**

在 `packages/ui/test/v4DraftSessionPrewarm.test.ts` 的最后一个 `it(...)` 之后、`});` 收尾之前插入：

```ts
  it("discard 后递增 invalidationVersion → 解除 blocked 并重建预热会话", async () => {
    const calls: Array<{ type: string; sessionId: string | null }> = [];
    let createCount = 0;
    const dispatch = vi.fn(async (type: string, _payload: unknown, sessionId: string | null) => {
      calls.push({ type, sessionId });
      if (type === "createSession") {
        createCount += 1;
        return acceptedCreateAck(`draft-${createCount}`);
      }
      return { status: "accepted" as const };
    });
    const transportIdentity = {};
    const observed: Array<{ sessionId: string; discard(): void } | null> = [];
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const renderVersion = (invalidationVersion: number) =>
      createElement(PrewarmHarness, {
        workspaceKey: "/local/workspace",
        paneId: "workspace-main",
        invalidationVersion,
        transportIdentity,
        dispatchCommand: dispatch,
        onRender: (binding) => observed.push(binding),
      });

    await act(async () => {
      root.render(renderVersion(0));
      await flushMicrotasks();
    });
    expect(observed.at(-1)?.sessionId).toBe("draft-1");

    // 订阅失败路径：SessionPane 会调 discard()，它把当前版本标记为 blocked。
    await act(async () => {
      observed.at(-1)?.discard();
      await flushMicrotasks();
    });
    expect(observed.at(-1)).toBeNull();

    // 同版本不重建（blocked 生效）。
    await act(async () => {
      root.render(renderVersion(0));
      await flushMicrotasks();
    });
    expect(calls.filter((call) => call.type === "createSession")).toHaveLength(1);

    // 递增版本 → 解除 blocked → 重建。
    await act(async () => {
      root.render(renderVersion(1));
      await flushMicrotasks();
    });
    expect(calls.filter((call) => call.type === "createSession")).toHaveLength(2);
    expect(observed.at(-1)?.sessionId).toBe("draft-2");
  });
```

- [ ] **Step 2: 跑用例**

```bash
pnpm exec vitest run packages/ui/test/v4DraftSessionPrewarm.test.ts -t "discard 后递增 invalidationVersion"
```

Expected: PASS（假设成立）。若 FAIL，**停止并汇报**——说明 `blockedInvalidationVersion` 的清除条件与读码结论不符，方案需重新设计。

- [ ] **Step 3: 提交**

```bash
git add packages/ui/test/v4DraftSessionPrewarm.test.ts
git commit -m "test(ui): 锁定 discard 后按 invalidationVersion 重建预热会话的行为"
```

---

### Task 2: 新增 useDraftRuntimeRebuildGate

runtime 换代时触发重建，并在重建期间给出 `rebuilding=true` 供发送门禁使用。抽成独立 hook 的原因：SessionPane 已超 max-lines，且 `composer/useDraftModelReadinessGate.ts` 已确立门禁 hook 的范式。

**Files:**
- Create: `packages/ui/src/v4/composer/useDraftRuntimeRebuildGate.ts`
- Test: `packages/ui/test/v4DraftRuntimeRebuildGate.test.ts`

**Interfaces:**
- Consumes: `useZCodeSessionStore`（`@/store/zcodeSessionStore.js`）的 `invalidateDraftRuntime(workspacePath, workspaceIdentity?)`；`onRuntimeRestart: (listener: () => void) => () => void`
- Produces:
  ```ts
  export const DRAFT_RUNTIME_REBUILD_TIMEOUT_MS = 5000;
  export interface DraftRuntimeRebuildGate { rebuilding: boolean }
  export function useDraftRuntimeRebuildGate(params: {
    enabled: boolean;
    workspacePath: string;
    workspaceIdentity?: string;
    prewarmSessionId: string | null;
    onRuntimeRestart?: (listener: () => void) => () => void;
    timeoutMs?: number;
  }): DraftRuntimeRebuildGate;
  ```

- [ ] **Step 1: 写失败测试**

创建 `packages/ui/test/v4DraftRuntimeRebuildGate.test.ts`：

```ts
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_RUNTIME_REBUILD_TIMEOUT_MS,
  useDraftRuntimeRebuildGate,
  type DraftRuntimeRebuildGate,
} from "@/v4/composer/useDraftRuntimeRebuildGate.js";

const mocks = vi.hoisted(() => ({
  invalidateDraftRuntime: vi.fn(),
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: {
    getState: () => ({ invalidateDraftRuntime: mocks.invalidateDraftRuntime }),
  },
}));

interface ProbeOptions {
  enabled: boolean;
  prewarmSessionId: string | null;
  onRuntimeRestart?: (listener: () => void) => () => void;
}

let latest: DraftRuntimeRebuildGate | null = null;

function Probe(options: ProbeOptions) {
  latest = useDraftRuntimeRebuildGate({
    enabled: options.enabled,
    onRuntimeRestart: options.onRuntimeRestart,
    prewarmSessionId: options.prewarmSessionId,
    workspaceIdentity: undefined,
    workspacePath: "/workspace",
  });
  return null;
}

function installMinimalDom(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

function renderProbe(options: ProbeOptions) {
  const root = createRoot(installMinimalDom());
  act(() => root.render(createElement(Probe, options)));
  return {
    rerender(next: ProbeOptions) {
      act(() => root.render(createElement(Probe, next)));
    },
    root,
  };
}

/** 捕获 hook 注册的 restart 监听器，供测试主动触发。 */
function createRestartHook() {
  const listeners = new Set<() => void>();
  return {
    fire() {
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

beforeEach(() => {
  latest = null;
  mocks.invalidateDraftRuntime.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDraftRuntimeRebuildGate", () => {
  it("草稿态换代 → 触发 invalidateDraftRuntime 并进入 rebuilding", () => {
    const restart = createRestartHook();
    renderProbe({ enabled: true, onRuntimeRestart: restart.subscribe, prewarmSessionId: "draft-1" });

    expect(latest?.rebuilding).toBe(false);
    act(() => restart.fire());

    expect(mocks.invalidateDraftRuntime).toHaveBeenCalledWith("/workspace", undefined);
    expect(latest?.rebuilding).toBe(true);
  });

  it("新预热会话到达 → 解除 rebuilding", () => {
    const restart = createRestartHook();
    const probe = renderProbe({
      enabled: true,
      onRuntimeRestart: restart.subscribe,
      prewarmSessionId: "draft-1",
    });
    act(() => restart.fire());
    expect(latest?.rebuilding).toBe(true);

    probe.rerender({
      enabled: true,
      onRuntimeRestart: restart.subscribe,
      prewarmSessionId: "draft-2",
    });

    expect(latest?.rebuilding).toBe(false);
  });

  it("超时未重建 → 解除 rebuilding 回落无预热发送", () => {
    const restart = createRestartHook();
    renderProbe({ enabled: true, onRuntimeRestart: restart.subscribe, prewarmSessionId: "draft-1" });
    act(() => restart.fire());
    expect(latest?.rebuilding).toBe(true);

    act(() => {
      vi.advanceTimersByTime(DRAFT_RUNTIME_REBUILD_TIMEOUT_MS);
    });

    expect(latest?.rebuilding).toBe(false);
  });

  it("非草稿态换代 → 不触发 invalidate，不禁用发送", () => {
    const restart = createRestartHook();
    renderProbe({
      enabled: false,
      onRuntimeRestart: restart.subscribe,
      prewarmSessionId: null,
    });
    act(() => restart.fire());

    expect(mocks.invalidateDraftRuntime).not.toHaveBeenCalled();
    expect(latest?.rebuilding).toBe(false);
  });

  it("重建中再次换代 → 计时器重置，不提前解除", () => {
    const restart = createRestartHook();
    renderProbe({ enabled: true, onRuntimeRestart: restart.subscribe, prewarmSessionId: "draft-1" });
    act(() => restart.fire());

    act(() => {
      vi.advanceTimersByTime(DRAFT_RUNTIME_REBUILD_TIMEOUT_MS - 1000);
      restart.fire();
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(latest?.rebuilding).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run packages/ui/test/v4DraftRuntimeRebuildGate.test.ts
```

Expected: FAIL —— 无法解析 `@/v4/composer/useDraftRuntimeRebuildGate.js`。

- [ ] **Step 3: 实现 hook**

创建 `packages/ui/src/v4/composer/useDraftRuntimeRebuildGate.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * 重建上限：实测 agent start→ready 约 550-650ms，createSession 再数百 ms，
 * 5s 有充分余量。超时只解除门禁，不取消重建——迟到的 binding 仍会正常生效。
 */
export const DRAFT_RUNTIME_REBUILD_TIMEOUT_MS = 5000;

export interface DraftRuntimeRebuildGate {
  /** 预热会话正在重建；true 时必须禁止发送，避免附件还挂在已消失的会话上。 */
  rebuilding: boolean;
}

/**
 * CUA Helper 就绪等原因会回收 agent runtime（workspace-dispose），把草稿态尚未持久化的
 * 预热会话一并冲掉。此 hook 在换代时递增 draftRuntimeInvalidationVersion 触发重建，
 * 并在重建窗口内给出 rebuilding=true 供发送门禁使用。
 */
export function useDraftRuntimeRebuildGate(params: {
  /** 仅草稿态（sessionId === null）启用；正式会话由 CLI cold-session-resume 负责。 */
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 当前预热会话 id；变为新的非空值即视为重建完成。 */
  prewarmSessionId: string | null;
  onRuntimeRestart?: (listener: () => void) => () => void;
  timeoutMs?: number;
}): DraftRuntimeRebuildGate {
  const {
    enabled,
    onRuntimeRestart,
    prewarmSessionId,
    timeoutMs = DRAFT_RUNTIME_REBUILD_TIMEOUT_MS,
    workspaceIdentity,
    workspacePath,
  } = params;
  const [rebuilding, setRebuilding] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 换代时的预热会话 id；用于判定「新的会话已到达」。 */
  const pendingFromRef = useRef<string | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(() => {
      if (!enabled) return;
      pendingFromRef.current = prewarmSessionId;
      setRebuilding(true);
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // 超时只解除门禁：重建仍在进行，迟到的 binding 会照常更新 effectiveSessionId。
        setRebuilding(false);
      }, timeoutMs);
      useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
    });
  }, [
    clearTimer,
    enabled,
    onRuntimeRestart,
    prewarmSessionId,
    timeoutMs,
    workspaceIdentity,
    workspacePath,
  ]);

  useEffect(() => {
    if (!rebuilding) return;
    if (prewarmSessionId === null || prewarmSessionId === pendingFromRef.current) return;
    clearTimer();
    pendingFromRef.current = null;
    setRebuilding(false);
  }, [clearTimer, prewarmSessionId, rebuilding]);

  return { rebuilding };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm exec vitest run packages/ui/test/v4DraftRuntimeRebuildGate.test.ts
```

Expected: 5 passed。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/v4/composer/useDraftRuntimeRebuildGate.ts packages/ui/test/v4DraftRuntimeRebuildGate.test.ts
git commit -m "feat(ui): 新增草稿预热会话换代重建门禁 hook"
```

---

### Task 3: 接入 SessionPane 与文案

把 Task 2 的 hook 挂到 SessionPane，并把 `rebuilding` 并入 composer 的 `disabled`。

**Files:**
- Modify: `packages/ui/src/v4/SessionPane.tsx`（`:1483` 附近挂 hook，`:3494` 的 `disabled` 加条件）
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`

**Interfaces:**
- Consumes: Task 2 的 `useDraftRuntimeRebuildGate`；SessionPane 已有的 `onRuntimeRestart`（props，`:446`）、`prewarmSessionId`（`:1483`）、`sessionId`、`workspacePath`、`workspaceIdentity`
- Produces: 无新导出

- [ ] **Step 1: 加文案**

`packages/ui/src/i18n/locales/zh-CN.ts` 中，在 `"chat.attachments.upload.runtimeRestarted"` 那一行**之后**插入：

```ts
  "chat.composer.draftRuntimeRebuilding": "会话正在重建，请稍候",
```

`packages/ui/src/i18n/locales/en-US.ts` 中，在对应的 `"chat.attachments.upload.runtimeRestarted"` 之后插入：

```ts
  "chat.composer.draftRuntimeRebuilding": "Rebuilding session, please wait",
```

- [ ] **Step 2: 挂 hook**

`packages/ui/src/v4/SessionPane.tsx`，在 `const prewarmSessionId = prewarmBinding?.sessionId ?? null;`（`:1483`）之后插入：

```tsx
  // runtime 换代（CUA Helper 就绪、liveness 恢复等触发 workspace-dispose）会冲掉草稿态
  // 尚未持久化的预热会话；重建期间禁止发送，避免附件挂在已消失的会话上。
  const { rebuilding: draftRuntimeRebuilding } = useDraftRuntimeRebuildGate({
    enabled: sessionId === null,
    onRuntimeRestart,
    prewarmSessionId,
    workspaceIdentity,
    workspacePath,
  });
```

并在文件顶部 import 区加入：

```ts
import { useDraftRuntimeRebuildGate } from "@/v4/composer/useDraftRuntimeRebuildGate.js";
```

- [ ] **Step 3: 接入 disabled**

`packages/ui/src/v4/SessionPane.tsx:3494`，把

```tsx
      disabled={connecting || queueEditActiveForCurrentComposer || quotaBanner.state.blocksSubmit}
```

改为

```tsx
      disabled={
        connecting ||
        draftRuntimeRebuilding ||
        queueEditActiveForCurrentComposer ||
        quotaBanner.state.blocksSubmit
      }
```

- [ ] **Step 4: 跑既有 SessionPane 测试确认无回归**

```bash
pnpm exec vitest run packages/ui/test/v4SessionPaneComposerContinuity.test.ts packages/ui/test/v4SessionPaneLayoutParity.test.ts packages/ui/test/v4SessionPaneReadOnly.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 5: typecheck**

```bash
pnpm exec tsc -p packages/ui/tsconfig.json --noEmit
```

Expected: 无输出（该命令在改动前已验证为干净通过，任何输出都是本任务引入的）。

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src/v4/SessionPane.tsx packages/ui/src/i18n/locales/zh-CN.ts packages/ui/src/i18n/locales/en-US.ts
git commit -m "feat(ui): 重建预热会话期间禁用发送"
```

---

### Task 4: 附件作废与唤醒解耦

`useComposerAttachments.ts:461` 的换代回调读 `targetsRef.current`——渲染期写入的旧值，换代时它仍持有已失效的 sessionId，于是拿旧 id 入队，正是生产日志里那次 `sessionNotFound` 的成因。改为「一律置 `waitingSession`，由 `restartEpoch` 统一唤醒」。

**Files:**
- Modify: `packages/ui/src/v4/composer/useComposerAttachments.ts`（`:437-451` 唤醒 effect、`:461-515` 换代回调）
- Test: `packages/ui/test/useComposerAttachmentsUpload.test.ts`

**Interfaces:**
- Consumes: 该文件已有的 `enqueueUpload`、`updateItem`、`readComposerAttachmentScope`
- Produces: 无新导出（`restartEpoch` 是 hook 内部 state）

- [ ] **Step 1: 写失败测试**

在 `packages/ui/test/useComposerAttachmentsUpload.test.ts` 末尾的 `describe` 内追加：

```ts
  it("换代后不拿旧 sessionId 入队，等新会话到达再重传", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const restartListeners = new Set<() => void>();
    const onRuntimeRestart = (listener: () => void) => {
      restartListeners.add(listener);
      return () => restartListeners.delete(listener);
    };
    const probe = renderProbe({
      attachmentSessionId: "draft-1",
      localDesktop: true,
      onRuntimeRestart,
      scopeId: "rebuild-requeue",
    });
    await addPaths(["/tmp/a.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));

    act(() => {
      for (const listener of [...restartListeners]) listener();
    });

    // 换代后必须是 waitingSession——不能带着已失效的 draft-1 去入队。
    expect(latestApi?.attachments[0]?.uploadStatus).toBe("waitingSession");
    expect(latestApi?.attachments[0]?.attachmentRef).toBeUndefined();

    probe.rerender({
      attachmentSessionId: "draft-2",
      localDesktop: true,
      onRuntimeRestart,
      scopeId: "rebuild-requeue",
    });

    await vi.waitFor(() =>
      expect(latestApi?.attachments[0]?.uploadStatus).not.toBe("waitingSession"),
    );
    probe.root.unmount();
  });

  it("sessionId 未变的换代也能被 restartEpoch 唤醒，不永久卡在 waitingSession", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const restartListeners = new Set<() => void>();
    const onRuntimeRestart = (listener: () => void) => {
      restartListeners.add(listener);
      return () => restartListeners.delete(listener);
    };
    const probe = renderProbe({
      attachmentSessionId: "session-1",
      localDesktop: true,
      onRuntimeRestart,
      scopeId: "rebuild-same-session",
    });
    await addPaths(["/tmp/b.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));

    act(() => {
      for (const listener of [...restartListeners]) listener();
    });

    // sessionId 不变，:441 的 effect 不会因依赖变化重跑；restartEpoch 必须补上唤醒。
    await vi.waitFor(() =>
      expect(latestApi?.attachments[0]?.uploadStatus).not.toBe("waitingSession"),
    );
    probe.root.unmount();
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run packages/ui/test/useComposerAttachmentsUpload.test.ts -t "换代后不拿旧 sessionId 入队"
```

Expected: FAIL —— 当前实现会带着旧 sessionId 走 `queued`。

- [ ] **Step 3: 加 restartEpoch 并改唤醒 effect**

在 `packages/ui/src/v4/composer/useComposerAttachments.ts` 的 `const [attachmentError, setAttachmentError] = useState<string | null>(null);`（`:186`）之后插入：

```ts
  /** runtime 换代计数：换代后 sessionId 可能不变，仅靠它做依赖会漏掉唤醒。 */
  const [restartEpoch, setRestartEpoch] = useState(0);
```

把 `:437-451` 的唤醒 effect 依赖数组由

```ts
  }, [
    attachmentSessionId,
    enqueueUpload,
    remoteSessionId,
    scopeKey,
    updateItem,
    workspaceIdentity,
  ]);
```

改为

```ts
  }, [
    attachmentSessionId,
    enqueueUpload,
    remoteSessionId,
    restartEpoch,
    scopeKey,
    updateItem,
    workspaceIdentity,
  ]);
```

- [ ] **Step 4: 改换代回调，不再用陈旧 sessionId 入队**

把 `:497-511` 的

```ts
          updateItem(targetScopeKey, item.id, (current) => ({
            ...current,
            uploadStatus: target?.sessionId ? "queued" : "waitingSession",
            uploadProgress: 0,
            uploadError: intl.formatMessage({
              id: "chat.attachments.upload.runtimeRestarted",
            }),
            uploadErrorKind: "runtimeRestarted",
            attachmentRef: undefined,
            staged: false,
            adopted: false,
            showComplete: false,
            autoRetryCount: current.autoRetryCount + 1,
          }));
          if (target?.sessionId) enqueueUpload(targetScopeKey, item.id);
```

改为

```ts
          // 换代后 targetsRef 里的 sessionId 必然陈旧（渲染期写入），拿它入队会直撞
          // sessionNotFound。一律降到 waitingSession，由 restartEpoch 驱动的唤醒 effect
          // 在新会话到达后统一入队。
          updateItem(targetScopeKey, item.id, (current) => ({
            ...current,
            uploadStatus: "waitingSession",
            uploadProgress: 0,
            uploadError: intl.formatMessage({
              id: "chat.attachments.upload.runtimeRestarted",
            }),
            uploadErrorKind: "runtimeRestarted",
            attachmentRef: undefined,
            staged: false,
            adopted: false,
            showComplete: false,
            autoRetryCount: current.autoRetryCount + 1,
          }));
```

并在该回调的 `for` 循环结束、`}` 收尾之前（即 `:513` 的 `}` 之后、`});` 之前）加入：

```ts
      setRestartEpoch((current) => current + 1);
```

关于 spec 里「同一 `restartEpoch` 内不重复重传」这条：它由 `restartEpoch` 的单调递增天然保证——每次换代 `onRuntimeRestart` 只 fire 一次，`restartEpoch` 只 +1，唤醒 effect 只跑一次。不单独构造用例，因为要断言它需要在 `localDesktop` 模式下观测内部 enqueue 次数，测试成本高于其保护价值。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm exec vitest run packages/ui/test/useComposerAttachmentsUpload.test.ts
```

Expected: 全部 PASS（含既有用例，注意 `:499` 行为变化可能影响既有断言；若既有用例失败，检查它断言的是否正是「换代后直接 queued」这一被本任务推翻的行为，是则同步更新该断言并在 commit message 说明）。

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src/v4/composer/useComposerAttachments.ts packages/ui/test/useComposerAttachmentsUpload.test.ts
git commit -m "fix(ui): 换代后附件不再用陈旧 sessionId 入队，改由 restartEpoch 唤醒"
```

---

### Task 5: 换代重传独立计数

`:481` 的 `autoRetryCount >= 1` 会让一次换代烧掉用户可见的上传重试配额。dev 实测同一 workspace 已到 `runtimeGeneration=4`（3 次换代），合并计数会在正常使用中误报失败。拆成两个计数器。

**Files:**
- Modify: `packages/ui/src/store/composerAttachmentUploadStore.ts`（`ComposerAttachmentUploadItem` 加字段）
- Modify: `packages/ui/src/v4/composer/useComposerAttachments.ts`（`:481` 判定、`:509` 递增、`:556`/`:842`/`:896` 三处初始化）
- Test: `packages/ui/test/useComposerAttachmentsUpload.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `restartEpoch`
- Produces: `ComposerAttachmentUploadItem.runtimeRebuildRetryCount: number`

- [ ] **Step 1: 写失败测试**

在 `packages/ui/test/useComposerAttachmentsUpload.test.ts` 末尾追加：

```ts
  it("连续 5 次换代仍重传，第 6 次才判失败，且不消耗 autoRetryCount", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const restartListeners = new Set<() => void>();
    const onRuntimeRestart = (listener: () => void) => {
      restartListeners.add(listener);
      return () => restartListeners.delete(listener);
    };
    const probe = renderProbe({
      attachmentSessionId: "draft-1",
      localDesktop: true,
      onRuntimeRestart,
      scopeId: "rebuild-quota",
    });
    await addPaths(["/tmp/c.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));

    for (let round = 0; round < 5; round += 1) {
      act(() => {
        for (const listener of [...restartListeners]) listener();
      });
      expect(latestApi?.attachments[0]?.uploadStatus).toBe("waitingSession");
      expect(latestApi?.attachments[0]?.autoRetryCount).toBe(0);
    }

    act(() => {
      for (const listener of [...restartListeners]) listener();
    });
    expect(latestApi?.attachments[0]?.uploadStatus).toBe("failed");
    probe.root.unmount();
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run packages/ui/test/useComposerAttachmentsUpload.test.ts -t "连续 5 次换代仍重传"
```

Expected: FAIL —— 当前第 2 次换代就会因 `autoRetryCount >= 1` 判 failed。

- [ ] **Step 3: 加字段**

`packages/ui/src/store/composerAttachmentUploadStore.ts`，在 `autoRetryCount: number;`（`:25`）之后插入：

```ts
  /** 因 runtime 换代触发的重传次数；与上传失败重试分开计，避免换代烧掉用户可见配额。 */
  runtimeRebuildRetryCount: number;
```

- [ ] **Step 4: 改判定与初始化**

`packages/ui/src/v4/composer/useComposerAttachments.ts`：

把 `:481` 的 `if (item.autoRetryCount >= 1) {` 改为

```ts
          if (item.runtimeRebuildRetryCount >= COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT) {
```

把 Task 4 中改过的那段里的 `autoRetryCount: current.autoRetryCount + 1,` 改为

```ts
            runtimeRebuildRetryCount: current.runtimeRebuildRetryCount + 1,
```

在文件中 `export const ATTACHMENT_UPLOAD_CHUNK_BYTES` 之类的常量声明区附近（`COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS` 定义处旁）加入：

```ts
/** 换代重传兜底上限：dev 实测同一 workspace 可到 generation 4，取 5 留余量。 */
export const COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT = 5;
```

三处 item 初始化（`:556`、`:842`、`:896`，均为 `autoRetryCount: 0,`）各自补上：

```ts
        runtimeRebuildRetryCount: 0,
```

- [ ] **Step 5: 跑全量 ui 附件测试**

```bash
pnpm exec vitest run packages/ui/test/useComposerAttachmentsUpload.test.ts packages/ui/test/chatAttachments.test.ts packages/ui/test/v4ConversationComposerAttachmentProgress.test.ts
```

Expected: 全部 PASS。若有既有用例构造了 `ComposerAttachmentUploadItem` 字面量，补上 `runtimeRebuildRetryCount: 0`。

- [ ] **Step 6: typecheck 并提交**

```bash
pnpm exec tsc -p packages/ui/tsconfig.json --noEmit
git add packages/ui/src/store/composerAttachmentUploadStore.ts packages/ui/src/v4/composer/useComposerAttachments.ts packages/ui/test/useComposerAttachmentsUpload.test.ts
git commit -m "fix(ui): 换代重传独立计数，不再烧掉上传失败重试配额"
```

---

## 收尾验证

- [ ] 跑一遍受影响范围的单测

```bash
pnpm exec vitest run packages/ui/test/v4DraftSessionPrewarm.test.ts packages/ui/test/v4DraftRuntimeRebuildGate.test.ts packages/ui/test/useComposerAttachmentsUpload.test.ts packages/ui/test/v4SessionPaneComposerContinuity.test.ts
```

- [ ] dev 端到端手工验证（单测覆盖不到真实换代时序）

```bash
ZCODE_CUA_DEV_MODE=1 pnpm run dev:desktop
```

冷启动后立刻在草稿态粘贴一张截图（**必须是粘贴，不能拖本地文件**——本地文件走 `localZeroCopy` 不上传，复现不出问题），等 `cua helper ready` 日志出现。预期：发送按钮短暂置灰并显示「会话正在重建，请稍候」，随后自动恢复，图片重新上传完成，点发送不再报 `sessionNotFound`。

- [ ] 确认日志中不再出现 `fault.subscribe.sessionNotFound`

---

## 已知风险

- 本方案**不消除回收本身**，用户仍会经历一次会话换代与一次重传，只是能自愈。
- 正式会话态（已发送后换代）不在范围内，仍会失败——由 CLI `cold-session-resume` 负责，而它对未持久化的会话会返回 `notFound`。这是独立的后续项。
- Task 3 的 SessionPane 改动没有直接单测覆盖（该组件 3787 行，测试成本高），依赖 Task 2 的 hook 测试 + 收尾的手工验证。
