# ARMS RUM user.id 注入登录账号 userId 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端登录账号 `userId` 注入 ARMS RUM 的 `user.id`，未登录时回填 `device_mid`，并随登录/登出/切号动态同步。

**Architecture:** 新增一个职责单一的主进程模块 `armsUserIdentity.ts`，通过依赖注入（`loadUserId`、`deviceMid`、`setUser`）解析「当前应上报的 user.id」并带去重写入 `armsRum.setConfig("user", { id })`。在 `index.ts` 主进程接三个触发点：ARMS init 后首次、登录 IPC 回调旁路、窗口聚焦兜底。只改主进程一处即覆盖主+渲染（autoInject 下传 user.id）。

**Tech Stack:** TypeScript、Electron 主进程、`@arms/rum-electron`、vitest。

## Global Constraints

- ARMS SDK 仅在 electron 主进程 init；OAuth 登出 hook 在 fork 出的 host 子进程，主进程收不到其事件——动态同步只能靠主进程可达信号（init 后、登录 IPC、window focus）。
- `armsRum.setConfig("user", { id })` 是运行时更新入口；`user.id` 经 autoInject 自动下传 renderer，**不改 renderer/web**。
- 不改动 host 子进程、自研 telemetry core、三处 `setConfig("properties", { device_mid })`。
- 根 `pnpm typecheck` 不覆盖 desktop main，需对 `packages/desktop` 单独 tsc 验证。
- 单测里 `@arms/rum-electron` 已被 `vitest.config.ts` alias 到 `armsRumElectronStub`；但本模块通过注入 `setUser` 依赖测试，不直接依赖 SDK mock。
- 复用现有变量：`index.ts:229` 的 `createTelemetryUserIdLoader(appTelemetryCredentialService)`、`index.ts:353` 的 `deviceMid`。

---

### Task 1: armsUserIdentity 模块 + 单测

**Files:**
- Create: `packages/desktop/src/main/armsUserIdentity.ts`
- Test: `packages/desktop/test/armsUserIdentity.test.ts`

**Interfaces:**
- Consumes: 无（纯依赖注入）。
- Produces:
  - `interface ArmsUserIdentitySyncDeps { loadUserId: () => Promise<string>; deviceMid: string; setUser: (user: { id: string }) => void; }`
  - `interface ArmsUserIdentitySync { refresh: () => Promise<void>; }`
  - `function createArmsUserIdentitySync(deps: ArmsUserIdentitySyncDeps): ArmsUserIdentitySync`

- [ ] **Step 1: Write the failing test**

创建 `packages/desktop/test/armsUserIdentity.test.ts`：

```typescript
import { describe, expect, it, vi } from "vitest";
import { createArmsUserIdentitySync } from "../src/main/armsUserIdentity.js";

const DEVICE_MID = "device-mid-abc";

describe("armsUserIdentity", () => {
  it("未登录时回填 device_mid 作为 user.id", async () => {
    const setUser = vi.fn();
    const sync = createArmsUserIdentitySync({
      loadUserId: async () => "",
      deviceMid: DEVICE_MID,
      setUser,
    });
    await sync.refresh();
    expect(setUser).toHaveBeenCalledTimes(1);
    expect(setUser).toHaveBeenCalledWith({ id: DEVICE_MID });
  });

  it("已登录时用账号 id 作为 user.id", async () => {
    const setUser = vi.fn();
    const sync = createArmsUserIdentitySync({
      loadUserId: async () => "acc-123",
      deviceMid: DEVICE_MID,
      setUser,
    });
    await sync.refresh();
    expect(setUser).toHaveBeenCalledWith({ id: "acc-123" });
  });

  it("id 未变化时去重，不重复 setUser", async () => {
    const setUser = vi.fn();
    const sync = createArmsUserIdentitySync({
      loadUserId: async () => "acc-123",
      deviceMid: DEVICE_MID,
      setUser,
    });
    await sync.refresh();
    await sync.refresh();
    expect(setUser).toHaveBeenCalledTimes(1);
  });

  it("登录后登出，回填 device_mid 并再次写入", async () => {
    const setUser = vi.fn();
    let current = "acc-123";
    const sync = createArmsUserIdentitySync({
      loadUserId: async () => current,
      deviceMid: DEVICE_MID,
      setUser,
    });
    await sync.refresh();
    current = "";
    await sync.refresh();
    expect(setUser).toHaveBeenCalledTimes(2);
    expect(setUser).toHaveBeenLastCalledWith({ id: DEVICE_MID });
  });

  it("loadUserId 抛错时按未登录处理，落 device_mid 且不抛", async () => {
    const setUser = vi.fn();
    const sync = createArmsUserIdentitySync({
      loadUserId: async () => {
        throw new Error("cred read failed");
      },
      deviceMid: DEVICE_MID,
      setUser,
    });
    await expect(sync.refresh()).resolves.toBeUndefined();
    expect(setUser).toHaveBeenCalledWith({ id: DEVICE_MID });
  });

  it("并发 refresh 不把旧值写回（末次值生效）", async () => {
    const setUser = vi.fn();
    const values = ["acc-1", "acc-2"];
    let i = 0;
    const sync = createArmsUserIdentitySync({
      loadUserId: async () => {
        const v = values[i] ?? "acc-2";
        i += 1;
        await new Promise((r) => setTimeout(r, v === "acc-1" ? 20 : 0));
        return v;
      },
      deviceMid: DEVICE_MID,
      setUser,
    });
    await Promise.all([sync.refresh(), sync.refresh()]);
    // 最终写入的 user.id 必须是 acc-2（末次），不能被慢的 acc-1 覆盖
    const lastCall = setUser.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual({ id: "acc-2" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/desktop/test/armsUserIdentity.test.ts`
Expected: FAIL — 无法解析 `../src/main/armsUserIdentity.js` / `createArmsUserIdentitySync is not a function`。

- [ ] **Step 3: Write minimal implementation**

创建 `packages/desktop/src/main/armsUserIdentity.ts`：

```typescript
export interface ArmsUserIdentitySyncDeps {
  /** 读当前登录账号 id；未登录返回空串 */
  loadUserId: () => Promise<string>;
  /** 未登录兜底用的设备维度 id */
  deviceMid: string;
  /** 写入 ARMS user 配置（默认包装 armsRum.setConfig("user", ...)） */
  setUser: (user: { id: string }) => void;
}

export interface ArmsUserIdentitySync {
  /** 解析当前应上报的 user.id 并在变化时写入 ARMS（带去重、并发末次生效） */
  refresh: () => Promise<void>;
}

/**
 * 主进程 ARMS RUM 用户身份同步：登录账号 id 优先，未登录回填 device_mid。
 * 注入式依赖，便于单测；并发 refresh 以「末次解析值」为准，避免慢请求把旧值写回。
 */
export function createArmsUserIdentitySync(
  deps: ArmsUserIdentitySyncDeps,
): ArmsUserIdentitySync {
  let lastWrittenId: string | null = null;
  // 并发序号：refresh 解析完成后只有「最新一次」允许写入
  let latestTicket = 0;

  async function refresh(): Promise<void> {
    const ticket = ++latestTicket;
    let resolvedId: string;
    try {
      resolvedId = (await deps.loadUserId()) || deps.deviceMid;
    } catch {
      // 读凭据失败按未登录处理，保证 user.id 始终非空
      resolvedId = deps.deviceMid;
    }

    // 有更晚的 refresh 已发起，放弃本次写入，避免旧值覆盖新值
    if (ticket !== latestTicket) {
      return;
    }
    if (resolvedId === lastWrittenId) {
      return;
    }
    lastWrittenId = resolvedId;
    deps.setUser({ id: resolvedId });
  }

  return { refresh };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/desktop/test/armsUserIdentity.test.ts`
Expected: PASS（6 个用例全过）。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/armsUserIdentity.ts packages/desktop/test/armsUserIdentity.test.ts
git commit -m "feat(desktop): armsUserIdentity 解析并去重写入 ARMS user.id"
```

---

### Task 2: index.ts 接线（首次 + focus 兜底）

**Files:**
- Modify: `packages/desktop/src/main/index.ts`（import 区；`deviceMid` 定义后构造 sync；`syncAppTelemetryInteractiveState` 内追加 refresh；`await armsInitPromise` 后首次 refresh）

**Interfaces:**
- Consumes: Task 1 的 `createArmsUserIdentitySync`；现有 `createTelemetryUserIdLoader(appTelemetryCredentialService)`、`deviceMid`、`armsRum`（`appARMSBootstrap` 用的是 `@arms/rum-electron` 默认导出）。
- Produces: 模块级 `armsUserIdentitySync`（供 Task 3 在 IPC 回调旁路调用）。

- [ ] **Step 1: 确认 armsRum 在 index.ts 的可用性**

Run: `grep -nE "^import armsRum|from \"@arms/rum-electron\"" packages/desktop/src/main/index.ts`
Expected: 若无输出，则 index.ts 尚未直接 import armsRum，需在 Step 2 添加 `import armsRum from "@arms/rum-electron";`（默认导出，与 `appARMSBootstrap.ts:1` 一致）。

- [ ] **Step 2: 添加 import 与构造 sync**

在 `packages/desktop/src/main/index.ts` 顶部 import 区添加（若 Step 1 显示已存在 armsRum import 则跳过该行）：

```typescript
import armsRum from "@arms/rum-electron";
import { createArmsUserIdentitySync } from "./armsUserIdentity.js";
```

在 `const deviceMid = createHash(...).slice(0, 32);`（约 `index.ts:353-356`）之后新增：

```typescript
const armsUserIdentitySync = createArmsUserIdentitySync({
  loadUserId: createTelemetryUserIdLoader(appTelemetryCredentialService),
  deviceMid,
  setUser: (user) => armsRum.setConfig("user", user),
});
```

- [ ] **Step 3: focus handler 内追加兜底刷新**

把 `syncAppTelemetryInteractiveState`（`index.ts:241-247`）改为：

```typescript
function syncAppTelemetryInteractiveState(): void {
  appTelemetryRuntime.setInteractive(
    BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.isVisible() && win.isFocused(),
    ),
  );
  // 登出/切号发生在 host 子进程，主进程无即时信号；窗口聚焦时兜底刷新 ARMS user.id
  void armsUserIdentitySync.refresh();
}
```

- [ ] **Step 4: ARMS init 后首次 refresh**

在 `await armsInitPromise;`（`index.ts:1221`）之后、`configureDesktopStabilityTelemetry({` 之前新增：

```typescript
  // ARMS init 完成后首次写入 user.id（通常未登录 → 落 device_mid）
  void armsUserIdentitySync.refresh();
```

- [ ] **Step 5: typecheck**

Run: `cd packages/desktop && pnpm exec tsc -p tsconfig.main.json --noEmit`
（若该 tsconfig 名不存在，先 `ls packages/desktop/tsconfig*.json` 选覆盖 `src/main` 的那个；desktop main 走 node 侧 tsconfig。）
Expected: 无报错。

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/index.ts
git commit -m "feat(desktop): ARMS init 后与窗口聚焦时同步 user.id"
```

---

### Task 3: 登录回调即时刷新（IPC 旁路）

**Files:**
- Modify: `packages/desktop/src/main/desktopMainIpcRemote.ts`（`registerRemoteIpcHandlers` options 增加可选回调；`OAuthCallbackHandled` 监听内触发）
- Modify: `packages/desktop/src/main/index.ts`（调用处传入回调）

**Interfaces:**
- Consumes: Task 2 的 `armsUserIdentitySync.refresh`。
- Produces: `registerRemoteIpcHandlers` options 新增 `onOAuthCallbackHandledSideEffect?: () => void`。

- [ ] **Step 1: options 类型增加可选回调**

在 `desktopMainIpcRemote.ts` 的 `registerRemoteIpcHandlers(options: { ... })` 类型中，`appTelemetryRuntime` 字段之后新增一行：

```typescript
  /** OAuth 回调处理完成后的额外副作用（如刷新 ARMS user.id）；不影响既有 runtime 流程 */
  onOAuthCallbackHandledSideEffect?: () => void;
```

- [ ] **Step 2: 监听内触发副作用**

把 `OAuthCallbackHandled` 监听（`desktopMainIpcRemote.ts:157-159`）改为：

```typescript
  ipcMain.on(PlatformChannels.OAuthCallbackHandled, (event) => {
    options.appTelemetryRuntime.onOAuthCallbackHandled({ rendererId: event.sender.id });
    options.onOAuthCallbackHandledSideEffect?.();
  });
```

- [ ] **Step 3: 调用处传入回调**

在 `index.ts` 的 `registerRemoteIpcHandlers({ ... })` 调用（`index.ts:1199`）里，`appTelemetryRuntime,` 之后新增一行：

```typescript
    onOAuthCallbackHandledSideEffect: () => {
      void armsUserIdentitySync.refresh();
    },
```

- [ ] **Step 4: typecheck**

Run: `cd packages/desktop && pnpm exec tsc -p tsconfig.main.json --noEmit`
Expected: 无报错。

- [ ] **Step 5: 跑既有 IPC/telemetry 相关测试确认未回归**

Run: `pnpm vitest run packages/desktop/test/armsUserIdentity.test.ts packages/desktop/test/desktopNetworkTelemetry.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/main/desktopMainIpcRemote.ts packages/desktop/src/main/index.ts
git commit -m "feat(desktop): 登录回调完成后即时刷新 ARMS user.id"
```

---

### Task 4: 全量验证

**Files:** 无改动（仅验证）。

- [ ] **Step 1: 跑新模块单测**

Run: `pnpm vitest run packages/desktop/test/armsUserIdentity.test.ts`
Expected: PASS。

- [ ] **Step 2: desktop main typecheck**

Run: `cd packages/desktop && pnpm exec tsc -p tsconfig.main.json --noEmit`
Expected: 无报错。

- [ ] **Step 3: 根 typecheck（确认未破坏共享类型）**

Run: `pnpm typecheck`
Expected: 无报错。

- [ ] **Step 4:（可选）冒烟说明**

dev 启动后，ARMS 后台对一个已登录会话应能看到 `user.id` = 账号 id；未登录会话为 `device_mid`。无自动化断言，记录为手动验证项。

---

## Self-Review

**1. Spec coverage：**
- 新模块 `armsUserIdentity.ts` + 去重 → Task 1 ✓
- 三触发点（init 后 / focus 兜底 / 登录 IPC 旁路）→ Task 2（init+focus）、Task 3（IPC）✓
- 未登录回填 device_mid、异常兜底 → Task 1 测试与实现 ✓
- 只改主进程、不动 host/property/renderer/web → 改动文件仅 `armsUserIdentity.ts`/`index.ts`/`desktopMainIpcRemote.ts` ✓
- 单测 5 项场景 → Task 1 覆盖（含并发末次生效，超出 spec 但符合实现的并发约束）✓
- 验证（desktop 单独 tsc + vitest）→ Task 4 ✓

**2. Placeholder scan：** 无 TBD/TODO；tsconfig 名给了 `ls` 回退确认步骤（Task 2 Step 5），非占位符而是显式分支。armsRum import 用 Step 1 grep 决定是否新增，非占位。

**3. Type consistency：** `createArmsUserIdentitySync` / `ArmsUserIdentitySyncDeps`（`loadUserId`/`deviceMid`/`setUser`）/ `ArmsUserIdentitySync.refresh` 在 Task 1 定义，Task 2/3 一致引用；`onOAuthCallbackHandledSideEffect` 在 Task 3 Step 1 定义、Step 3 使用，名称一致。
