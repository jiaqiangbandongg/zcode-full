# 阶段 1：main 底座导航能力 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `BrowserViewManager` + `executeBrowserCommandOnView` 支持后退/前进/刷新导航命令,为后续 human 导航 IPC 与 agent 多 tab 寻址打底,纯 main 侧、可单测、不碰 UI。

**Architecture:** `back`/`forward`/`reload` 已在 `BrowserCommand` 判别联合里,但 executor 仍回 `capability_unsupported`。本阶段:扩展 `ControlledView.webContents` 抽象加 `goBack/goForward/reload`,在 executor 里实现这三条命令(尽力返回最新 state),再把 `browserViewManager.toControlledView` 接到真实 `webContents.navigationHistory`。

**Tech Stack:** TypeScript、Electron 41 `WebContentsView`/`webContents.navigationHistory`、vitest。

## Global Constraints

- 注释与文档用中文（AGENTS.md）。
- import 路径用绝对路径规范（沿用文件内既有风格）。
- 提交遵守 Conventional Commits。
- 分支：当前 `feat/browser-use-cdp`，不直接提 staging。
- executor 抛错必须结构化返回、不 throw（保证 host↔main 桥拿到结果）。
- 导航命令尽力返回最新 `state`；`goBack/goForward/reload` 是 fire-and-forget（Electron 无 promise），readState 取当前值即可，不阻塞。

---

### Task 1: executor 实现 back/forward/reload + 扩展 ControlledView

**Files:**
- Modify: `packages/desktop/src/main/browserView/browserCommandExecutor.ts`
- Test: `packages/desktop/test/browserCommandExecutor.test.ts`

**Interfaces:**
- Consumes:（无，本任务是起点）
- Produces:
  - `ControlledViewWebContents` 新增方法：`goBack(): void`、`goForward(): void`、`reload(): void`
  - executor 对 `command.method` 为 `"back"|"forward"|"reload"` 返回 `{ok:true, state}`（不再 `capability_unsupported`）

- [ ] **Step 1: 写失败测试**

在 `packages/desktop/test/browserCommandExecutor.test.ts` 的 `makeView` 里给 `webContents` 补三个 stub 方法，并加三条用例。先改 `makeView`：

```typescript
function makeView(overrides: Partial<{ cdpSend: (m: string, p?: unknown) => Promise<unknown> }> = {}): ControlledView {
  return {
    webContents: {
      loadURL: vi.fn(async () => {}),
      getURL: () => "https://example.com",
      getTitle: () => "Example",
      canGoBack: () => true,
      canGoForward: () => true,
      goBack: vi.fn(() => {}),
      goForward: vi.fn(() => {}),
      reload: vi.fn(() => {}),
    },
    cdp: {
      send: overrides.cdpSend ?? vi.fn(async () => ({ data: "iVBORw0KGgo=" })),
    },
  };
}
```

在 `describe("executeBrowserCommandOnView", ...)` 内新增：

```typescript
  it("back 调 goBack 并返回 state", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, { method: "back" });
    expect(view.webContents.goBack).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.state?.url).toBe("https://example.com");
  });

  it("forward 调 goForward 并返回 state", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, { method: "forward" });
    expect(view.webContents.goForward).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it("reload 调 reload 并返回 state", async () => {
    const view = makeView();
    const r = await executeBrowserCommandOnView(view, { method: "reload" });
    expect(view.webContents.reload).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/desktop/test/browserCommandExecutor.test.ts`
Expected: 3 条新用例 FAIL（back/forward/reload 走 default 分支返回 `ok:false` `capability_unsupported`；且 `goBack` 等 stub 未被调用）。

- [ ] **Step 3: 扩展 ControlledView 接口**

在 `browserCommandExecutor.ts` 的 `ControlledViewWebContents` 接口里补三个方法：

```typescript
export interface ControlledViewWebContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
}
```

- [ ] **Step 4: 在 executor 实现三条命令**

在 `executeBrowserCommandOnView` 的 `switch (command.method)` 里、`case "getState"` 之后加入：

```typescript
      case "back": {
        view.webContents.goBack();
        return done({ ok: true, state: readState(view.webContents) });
      }
      case "forward": {
        view.webContents.goForward();
        return done({ ok: true, state: readState(view.webContents) });
      }
      case "reload": {
        view.webContents.reload();
        return done({ ok: true, state: readState(view.webContents) });
      }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run packages/desktop/test/browserCommandExecutor.test.ts`
Expected: PASS（原有用例 + 3 条新用例全绿）。

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/src/main/browserView/browserCommandExecutor.ts packages/desktop/test/browserCommandExecutor.test.ts
git commit -m "feat(browser-use): implement back/forward/reload commands in executor (阶段1)"
```

---

### Task 2: browserViewManager.toControlledView 接线真实导航

**Files:**
- Modify: `packages/desktop/src/main/browserView/browserViewManager.ts`
- Test: `packages/desktop/test/browserViewManagerDisplay.test.ts`（验证 toControlledView 映射，若该测试用 fake WebContentsView）

**Interfaces:**
- Consumes: Task 1 的 `ControlledViewWebContents.goBack/goForward/reload`
- Produces: `toControlledView` 返回的 `webContents` 现在把 `goBack/goForward/reload` 映射到真实 `wc.navigationHistory.goBack()`/`goForward()` 与 `wc.reload()`

- [ ] **Step 1: 接线 toControlledView**

在 `browserViewManager.ts` 的 `toControlledView` 里，给返回对象的 `webContents` 补三个方法（`wc` 为 `managed.view.webContents`）：

```typescript
  private toControlledView(managed: ManagedView): ControlledView {
    const wc = managed.view.webContents;
    return {
      webContents: {
        loadURL: (url) => wc.loadURL(url),
        getURL: () => wc.getURL(),
        getTitle: () => wc.getTitle(),
        canGoBack: () => wc.navigationHistory.canGoBack(),
        canGoForward: () => wc.navigationHistory.canGoForward(),
        goBack: () => wc.navigationHistory.goBack(),
        goForward: () => wc.navigationHistory.goForward(),
        reload: () => wc.reload(),
      },
      cdp: {
        send: (method, params) => wc.debugger.sendCommand(method, params),
      },
    };
  }
```

- [ ] **Step 2: typecheck 确认无类型错**

Run: `npx tsc --noEmit -p packages/desktop/tsconfig.main.json 2>&1 | grep -E "browserViewManager|browserCommandExecutor"`
Expected: 无输出（我的两个文件零类型错）。

- [ ] **Step 3: 跑 manager 与 executor 测试确认无回归**

Run: `npx vitest run packages/desktop/test/browserViewManagerDisplay.test.ts packages/desktop/test/browserCommandExecutor.test.ts`
Expected: PASS（全绿）。

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/main/browserView/browserViewManager.ts
git commit -m "feat(browser-use): wire toControlledView goBack/forward/reload to navigationHistory (阶段1)"
```

---

## Self-Review

**1. Spec 覆盖**：本 plan 只覆盖 spec 第 10 节阶段 1 中"导航命令(back/forward/reload)"这一可单测子集。阶段 1 还含"新导航 IPC + human 导航方法",涉及 renderer/preload/main handler 联调，非纯单测——拆到阶段 1b 的独立 plan（转 UI 时再写），避免本 plan 混入 UI 连接。navigate 已实现、devtools/executeJavaScript 归入 element-picker 阶段(阶段 3)。

**2. 占位扫描**：无 TBD/TODO；每步含完整代码与命令。

**3. 类型一致性**：`goBack/goForward/reload` 三处签名一致（接口声明 = executor 调用 = manager 映射 = 测试 stub），返回 `void`。`readState`/`done` 沿用文件内既有函数，未新造名字。

---

## Execution Handoff

阶段 1 计划已保存至 `docs/browser-use/2026-07-07-phase1-webcontentsview-navigation-plan.md`。两种执行方式：

1. **Subagent-Driven（推荐）**——每个 task 派新 subagent、task 间复核、快速迭代
2. **Inline Execution**——本会话内批量执行、检查点复核

选哪种？
