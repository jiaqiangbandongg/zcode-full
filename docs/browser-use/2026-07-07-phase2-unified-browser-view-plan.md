# Phase 2 — Unified Browser View (去 webview) 实现计划

> 编写日期：2026-07-07 · 分支：`feat/browser-use-cdp`（**不切分支**）
> 规范：bite-sized TDD（每步先给测试/可测点，再给完整实现代码）。

---

## Goal

在 renderer 侧新增一个**统一浏览器视图**组件 `UnifiedBrowserView`（chrome 工具栏 + 占位 div，真正的网页像素由 main 的 `WebContentsView` 覆盖在占位 div 之上）。让**人类导航**（地址栏回车、后退、前进、刷新、开 DevTools）经由**新增的直连 IPC** 打到 main → `browserViewManager.execute(win, key, command)`；同时 main 监听受控 `webContents` 的导航/标题/加载事件，经 IPC 推回 renderer，驱动 chrome 的地址栏文本与按钮禁用态。

本阶段与旧 `webview` 方案**完全并存**：不替换 `AnimatedSidePanePanel` 的分支、不删 `webview`、不动 agent 命令链路（agent 仍走 host→main→`execute`）、不合并任何 tab 类型。Phase 2 只交付「可被临时入口挂载并驱动的」`UnifiedBrowserView` + 其 IPC 双向面，正式接线到 tab 留到后续阶段。

## Architecture

```
┌─────────────────────────── renderer (packages/ui) ───────────────────────────┐
│  UnifiedBrowserView.tsx                                                        │
│   ├─ BrowserToolbar (地址栏 + back/forward/reload/devtools 按钮)               │
│   ├─ 占位 div (上报 bounds/visible，复用 BrowserUseViewPane 范式)              │
│   ├─ 地址栏回车 → normalizeBrowserUrl → platform.browserViewNavigate           │
│   ├─ 按钮 → platform.browserViewGoBack / GoForward / Reload / OpenDevTools     │
│   └─ platform.onBrowserViewState(cb) → setState → 驱动地址栏文本 & 按钮禁用态  │
└───────────────┬───────────────────────────────────────▲───────────────────────┘
                │ ipcRenderer.invoke (导航)               │ ipcRenderer.on (状态推送)
   preload (contextBridge)                                │
                │                                         │
┌───────────────▼─────────────────────────────────────────────────────── main ─┐
│  desktopMainIpcPlatform.ts  ipcMain.handle(BrowserViewNavigate/GoBack/...)     │
│     → options.browserViewExecute(win, key, {method, ...})                      │
│  main/index.ts  browserViewExecute = (win,key,cmd)=>mgr.execute(win,key,cmd)   │
│                 browserViewOpenDevTools = (win,key)=>mgr.openDevTools(win,key)  │
│                                                                                 │
│  BrowserViewManager.ensureView() 首次为 view 挂事件监听：                       │
│     did-navigate / did-navigate-in-page / page-title-updated /                 │
│     did-start-loading / did-stop-loading                                       │
│       → buildBrowserViewStatePayload(key, wc)                                   │
│       → win.webContents.send(BrowserViewState, payload)                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **导航方向**：renderer → preload `invoke` → `ipcMain.handle` → `browserViewManager.execute(win, key, command)`（human 与 agent 共用同一 `execute` 出口，无第二套控制路径）。
- **状态方向**：main `webContents` 事件 → `win.webContents.send(BrowserViewState, payload)` → preload `ipcRenderer.on` → `platform.onBrowserViewState` → 组件 `setState`。
- **key 语义**：沿用 `BrowserViewManager` 现有 map key（P0 = sessionId）。Phase 2 组件用 `browserKey` 作为该 key，状态 payload 的 `tabId` 字段即回填该 key（本阶段不引入独立 tab id 体系，避免合并 tab 类型）。

## Tech Stack

- Electron `WebContentsView` + CDP（已由 `BrowserViewManager` 封装）。
- 共享类型 / Zod：`@zcode/shared`（`packages/shared/src/browser-use/*`）。
- renderer：React + `usePlatform` hook + `packages/ui/src/logger.ts`。
- 测试：Vitest（纯逻辑/schema/payload builder）+ jsdom + `@testing-library/react`（组件）。

## Global Constraints

1. **中文注释**：所有新增代码块的注释用中文。
2. **绝对路径 import**：新增文件之间引用沿用仓库既有别名（`@zcode/shared`、renderer 的 `@/…`），不写脆弱相对深路径。
3. **Conventional Commits**：每个 task 一条 commit，`feat(browser-use): …` / `test(browser-use): …`。
4. **分支**：留在 `feat/browser-use-cdp`，**绝不**新建/切换分支，绝不提交到 `staging`。
5. **renderer 日志**：一律 `import { logger } from "@/logger.js"`（`packages/ui/src/logger.ts`），禁止 `console.*`。
6. **页面内容不可信**：`url`/`title` 等来自受控页面的字段视为不可信输入——仅用于展示，不拼接进任何执行路径；地址栏输入必过 `normalizeBrowserUrl`。
7. **类型验证盲区**：根 `pnpm typecheck` **不含** desktop 的 renderer/main/preload tsconfig。凡改到 `packages/desktop/src/{main,preload,renderer}` 或 `packages/ui`，必须**单独** `tsc -p` 对应工程验证（见每步 verify）。
8. **不改产品行为**：不动 `AnimatedSidePanePanel` 分支、不删 `webview`、不改 agent 命令链、不合并 tab 类型。

---

## Task 1 — 导航 IPC 面（renderer → main → `execute`）

**目标**：新增 5 个导航 channel（`Navigate/GoBack/GoForward/Reload/OpenDevTools`）贯通 shared 常量 → shared Platform 类型 → preload → renderer platform impl → `desktopMainIpcPlatform` handler → `main/index.ts` wiring 到 `browserViewManager.execute(win, key, {method})`。

**可单测点**：导航请求 schema + 「url → BrowserCommand」纯映射函数；其余（preload/handler/wiring）靠单独 `tsc` typecheck。

> 锚点说明：`browserViewSetBounds` 已端到端存在（`BrowserUseViewPane.tsx` 调 `platform.browserViewSetBounds`；`desktopMainIpcPlatform.ts` handle `PlatformChannels.BrowserViewSetBounds` → `options.setBrowserViewBounds`）。以下所有新增均**紧挨 `browserViewSetBounds` 的同一批位置**插入，保证层次对齐。

### Step 1.1 — shared：新增 channel 常量

文件：`PlatformChannels` 常量所在文件（`browserViewSetBounds`/`BrowserViewSetBounds` 定义处，`packages/shared/src/…`）。在 `BrowserViewSetVisible` 之后追加（字符串值沿用同对象内 `BrowserViewSetBounds`/`BrowserViewSetVisible` 的既有命名风格，保持前缀一致）：

```ts
  // browser-use Phase 2：human 导航直连 main（与 agent 共用 execute 出口）。
  BrowserViewNavigate: "browser-view:navigate",
  BrowserViewGoBack: "browser-view:go-back",
  BrowserViewGoForward: "browser-view:go-forward",
  BrowserViewReload: "browser-view:reload",
  BrowserViewOpenDevTools: "browser-view:open-devtools",
  // main → renderer 状态推送（Task 2 使用，此处一并登记）。
  BrowserViewState: "browser-view:state",
```

### Step 1.2 — shared：导航请求 schema + url→command 纯映射（先写测试）

新增文件 `packages/shared/src/browser-use/viewNavigation.ts`：

```ts
import { z } from "zod";
import type { BrowserCommand } from "./commands.js";

/** human 导航（地址栏回车）IPC 入参：受控视图 key + 目标 url。 */
export const browserViewNavigateRequestSchema = z
  .object({
    key: z.string().min(1),
    url: z.string().min(1),
  })
  .strict();
export type BrowserViewNavigateRequest = z.infer<
  typeof browserViewNavigateRequestSchema
>;

/** 仅带 key 的导航类 IPC 入参（back/forward/reload/openDevTools 共用）。 */
export const browserViewKeyRequestSchema = z
  .object({ key: z.string().min(1) })
  .strict();
export type BrowserViewKeyRequest = z.infer<typeof browserViewKeyRequestSchema>;

/** 地址栏导航 → BrowserCommand 纯映射（与 agent 共用同一命令联合，无第二套语义）。 */
export function toNavigateCommand(url: string): BrowserCommand {
  return { method: "navigate", url };
}
```

在该 `browser-use` 目录的 barrel（`index.ts`，与 `commands.ts` 同级、被 `@zcode/shared` 再导出处）追加：

```ts
export * from "./viewNavigation.js";
```

新增测试 `packages/shared/src/browser-use/viewNavigation.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  browserViewNavigateRequestSchema,
  browserViewKeyRequestSchema,
  toNavigateCommand,
} from "./viewNavigation.js";

describe("browserViewNavigateRequestSchema", () => {
  it("接受合法的 key+url", () => {
    const parsed = browserViewNavigateRequestSchema.parse({
      key: "session-1",
      url: "https://example.com",
    });
    expect(parsed).toEqual({ key: "session-1", url: "https://example.com" });
  });

  it("拒绝空 url", () => {
    expect(() =>
      browserViewNavigateRequestSchema.parse({ key: "s", url: "" }),
    ).toThrow();
  });

  it("拒绝多余字段（strict）", () => {
    expect(() =>
      browserViewNavigateRequestSchema.parse({
        key: "s",
        url: "https://x",
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("browserViewKeyRequestSchema", () => {
  it("接受仅 key", () => {
    expect(browserViewKeyRequestSchema.parse({ key: "s" })).toEqual({
      key: "s",
    });
  });
  it("拒绝空 key", () => {
    expect(() => browserViewKeyRequestSchema.parse({ key: "" })).toThrow();
  });
});

describe("toNavigateCommand", () => {
  it("映射为 navigate BrowserCommand", () => {
    expect(toNavigateCommand("https://example.com")).toEqual({
      method: "navigate",
      url: "https://example.com",
    });
  });
});
```

**verify**：`pnpm --filter @zcode/shared test viewNavigation`（红→绿）；`pnpm --filter @zcode/shared typecheck`。

### Step 1.3 — shared Platform 类型：新增导航方法（紧挨 `browserViewSetBounds`）

在声明 `browserViewSetBounds?` / `browserViewSetVisible?` 的 Platform 接口里追加：

```ts
  /** browser-use Phase 2：human 导航（地址栏回车）。 */
  browserViewNavigate?: (
    payload: BrowserViewNavigateRequest,
  ) => Promise<void>;
  browserViewGoBack?: (payload: BrowserViewKeyRequest) => Promise<void>;
  browserViewGoForward?: (payload: BrowserViewKeyRequest) => Promise<void>;
  browserViewReload?: (payload: BrowserViewKeyRequest) => Promise<void>;
  browserViewOpenDevTools?: (payload: BrowserViewKeyRequest) => Promise<void>;
```

并确保该文件顶部 `import` 处引入类型（若该文件从 `@zcode/shared` 内部导入，则加）：

```ts
import type {
  BrowserViewNavigateRequest,
  BrowserViewKeyRequest,
} from "@zcode/shared";
```

### Step 1.4 — preload：暴露导航 invoke（紧挨 `browserViewSetBounds`）

在 preload 里 `browserViewSetBounds` 的暴露对象内追加：

```ts
  browserViewNavigate: (payload: BrowserViewNavigateRequest) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewNavigate, payload),
  browserViewGoBack: (payload: BrowserViewKeyRequest) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewGoBack, payload),
  browserViewGoForward: (payload: BrowserViewKeyRequest) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewGoForward, payload),
  browserViewReload: (payload: BrowserViewKeyRequest) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewReload, payload),
  browserViewOpenDevTools: (payload: BrowserViewKeyRequest) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewOpenDevTools, payload),
```

### Step 1.5 — renderer platform impl（`main.tsx`）：转发到 preload（紧挨 `browserViewSetBounds`）

在 renderer 构造 platform 对象处（`browserViewSetBounds` 转发的同一对象，`packages/desktop/src/renderer/main.tsx`）追加，桥接全局名沿用 `browserViewSetBounds` 用的同一个（下例以 `window.zcodePlatform` 表示，改成本文件里 `browserViewSetBounds` 实际引用的那个全局）：

```ts
  browserViewNavigate: (payload) =>
    window.zcodePlatform.browserViewNavigate(payload),
  browserViewGoBack: (payload) => window.zcodePlatform.browserViewGoBack(payload),
  browserViewGoForward: (payload) =>
    window.zcodePlatform.browserViewGoForward(payload),
  browserViewReload: (payload) => window.zcodePlatform.browserViewReload(payload),
  browserViewOpenDevTools: (payload) =>
    window.zcodePlatform.browserViewOpenDevTools(payload),
```

### Step 1.6 — main：`ipcMain.handle` 导航 handler（紧挨 `BrowserViewSetBounds` handler）

在 `desktopMainIpcPlatform.ts` 的 `registerPlatformIpcHandlers` options 里，在 `setBrowserViewVisible?` 之后追加类型：

```ts
  /** browser-use Phase 2：human 导航打到 browserViewManager.execute。 */
  browserViewExecute?: (
    win: BrowserWindow,
    key: string,
    command: BrowserCommand,
  ) => void | Promise<unknown>;
  browserViewOpenDevTools?: (win: BrowserWindow, key: string) => void;
```

顶部 `@zcode/shared` 具名导入处补 `BrowserCommand`、`toNavigateCommand`、`browserViewNavigateRequestSchema`、`browserViewKeyRequestSchema`：

```ts
  type BrowserCommand,
  toNavigateCommand,
  browserViewNavigateRequestSchema,
  browserViewKeyRequestSchema,
```

在 `PlatformChannels.BrowserViewSetVisible` 的 `ipcMain.handle` 之后追加 5 个 handler（复用现有 `BrowserWindow.fromWebContents(event.sender)` 守卫范式）：

```ts
  // browser-use Phase 2：human 导航直连 main → execute（back/forward/reload 用 key-only）。
  ipcMain.handle(PlatformChannels.BrowserViewNavigate, (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const { key, url } = browserViewNavigateRequestSchema.parse(payload);
    return options.browserViewExecute?.(win, key, toNavigateCommand(url));
  });
  ipcMain.handle(PlatformChannels.BrowserViewGoBack, (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const { key } = browserViewKeyRequestSchema.parse(payload);
    return options.browserViewExecute?.(win, key, { method: "back" });
  });
  ipcMain.handle(PlatformChannels.BrowserViewGoForward, (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const { key } = browserViewKeyRequestSchema.parse(payload);
    return options.browserViewExecute?.(win, key, { method: "forward" });
  });
  ipcMain.handle(PlatformChannels.BrowserViewReload, (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const { key } = browserViewKeyRequestSchema.parse(payload);
    return options.browserViewExecute?.(win, key, { method: "reload" });
  });
  ipcMain.handle(PlatformChannels.BrowserViewOpenDevTools, (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const { key } = browserViewKeyRequestSchema.parse(payload);
    options.browserViewOpenDevTools?.(win, key);
  });
```

### Step 1.7 — main：`BrowserViewManager.openDevTools` + `main/index.ts` wiring

`openDevTools` 不在 `BrowserCommand` 联合内（不改 shared 命令面/不动 agent），故给 manager 加一个薄方法。在 `browserViewManager.ts` 的 `setVisible` 之后追加：

```ts
  /** 打开受控 view 的开发者工具（human-only；不进 BrowserCommand 联合，避免污染 agent 命令面）。 */
  openDevTools(win: BrowserWindow, key: string): void {
    const managed = this.ensureView(win, key);
    try {
      managed.view.webContents.openDevTools({ mode: "detach" });
    } catch {
      // 已打开/被占用等——忽略。
    }
  }
```

在 `main/index.ts` 里 `registerPlatformIpcHandlers({ … setBrowserViewBounds, setBrowserViewVisible … })` 的同一 options 对象追加（`browserViewManager` 即现有实例名，按本文件实际变量名对齐）：

```ts
    browserViewExecute: (win, key, command) =>
      browserViewManager.execute(win, key, command),
    browserViewOpenDevTools: (win, key) =>
      browserViewManager.openDevTools(win, key),
```

**verify（Task 1 整体）**：
- `pnpm --filter @zcode/shared test viewNavigation && pnpm --filter @zcode/shared typecheck`
- 单独 typecheck 三工程（根 typecheck 不含）：
  - `pnpm --filter @zcode/desktop exec tsc -p src/main/tsconfig.json --noEmit`
  - `pnpm --filter @zcode/desktop exec tsc -p src/preload/tsconfig.json --noEmit`
  - `pnpm --filter @zcode/desktop exec tsc -p src/renderer/tsconfig.json --noEmit`
  - `pnpm --filter @zcode/ui typecheck`
  （各 tsconfig 路径以仓库实际为准；目的是覆盖 renderer/main/preload。）

commit：`feat(browser-use): add human navigation IPC surface for unified browser view (Phase 2 Task 1)`

---

## Task 2 — 状态推送（main `webContents` 事件 → renderer）

**目标**：main 监听受控 `webContents` 的导航/标题/加载事件，构造 `{tabId,url,title,canGoBack,canGoForward,isLoading}` payload，`win.webContents.send(BrowserViewState, payload)`；renderer 侧 `platform.onBrowserViewState` 订阅。

**可单测点**：payload 构造函数 `buildBrowserViewStatePayload` 抽成纯函数单测；监听接线靠 typecheck + Task 4 运行时验证。

### Step 2.1 — shared：state payload schema（先写测试）

在 `packages/shared/src/browser-use/viewNavigation.ts` 追加（与导航面同文件，barrel 已导出）：

```ts
/** main → renderer 推送的受控视图状态（driven chrome：地址栏文本 + 按钮禁用态）。 */
export const browserViewStateSchema = z
  .object({
    /** 受控视图 key（Phase 2 = BrowserViewManager map key = sessionId）。 */
    tabId: z.string().min(1),
    url: z.string(),
    title: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    isLoading: z.boolean(),
  })
  .strict();
export type BrowserViewState = z.infer<typeof browserViewStateSchema>;

/** 受控 webContents 中构造 state 所需的最小只读面（便于单测注入假对象）。 */
export interface BrowserViewStateSource {
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
}

/** 纯函数：从只读面构造 state payload（页面 url/title 不可信——仅展示，不参与执行）。 */
export function buildBrowserViewStatePayload(
  tabId: string,
  source: BrowserViewStateSource,
): BrowserViewState {
  return {
    tabId,
    url: source.getURL(),
    title: source.getTitle(),
    canGoBack: source.canGoBack(),
    canGoForward: source.canGoForward(),
    isLoading: source.isLoading(),
  };
}
```

在 `viewNavigation.test.ts` 追加：

```ts
import {
  browserViewStateSchema,
  buildBrowserViewStatePayload,
} from "./viewNavigation.js";

describe("buildBrowserViewStatePayload", () => {
  const source = {
    getURL: () => "https://example.com/a",
    getTitle: () => "示例",
    canGoBack: () => true,
    canGoForward: () => false,
    isLoading: () => true,
  };

  it("从只读面构造合法 payload", () => {
    const payload = buildBrowserViewStatePayload("session-1", source);
    expect(payload).toEqual({
      tabId: "session-1",
      url: "https://example.com/a",
      title: "示例",
      canGoBack: true,
      canGoForward: false,
      isLoading: true,
    });
    expect(() => browserViewStateSchema.parse(payload)).not.toThrow();
  });
});
```

**verify**：`pnpm --filter @zcode/shared test viewNavigation`（新增用例红→绿）。

### Step 2.2 — main：`BrowserViewManager.ensureView` 挂 webContents 监听 → send

在 `browserViewManager.ts`：

顶部 import 追加（`buildBrowserViewStatePayload` + `PlatformChannels`；`PlatformChannels` 从 `@zcode/shared` 取）：

```ts
import {
  buildBrowserViewStatePayload,
  PlatformChannels,
  type BrowserCommand,
  type BrowserCommandResult,
} from "@zcode/shared";
```

`ManagedView` 接口加一个「已接线」标记，避免重复挂监听：

```ts
interface ManagedView {
  view: WebContentsView;
  attached: boolean;
  cdpAttached: boolean;
  lastBounds?: { x: number; y: number; width: number; height: number };
  visible: boolean;
  /** 是否已挂 webContents 状态监听（Phase 2 状态推送），保证只挂一次。 */
  stateWired: boolean;
}
```

`ensureView` 里创建 `managed` 处初始化新字段：

```ts
      managed = {
        view,
        attached: false,
        cdpAttached: false,
        visible: false,
        stateWired: false,
      };
```

在 `ensureView` 的 `if (!managed.cdpAttached) { … }` 之后、`return managed;` 之前追加接线：

```ts
    // Phase 2：首次为该 view 挂状态监听 → 每次导航/标题/加载变化推送 BrowserViewState。
    // 页面 url/title 不可信，仅用于 renderer 展示。
    if (!managed.stateWired) {
      const wc = managed.view.webContents;
      const emit = () => {
        if (win.isDestroyed()) return;
        try {
          const payload = buildBrowserViewStatePayload(key, {
            getURL: () => wc.getURL(),
            getTitle: () => wc.getTitle(),
            canGoBack: () => wc.navigationHistory.canGoBack(),
            canGoForward: () => wc.navigationHistory.canGoForward(),
            isLoading: () => wc.isLoading(),
          });
          win.webContents.send(PlatformChannels.BrowserViewState, payload);
          this.log?.(
            `[browser-use] state key=${key} url=${payload.url} loading=${payload.isLoading}`,
          );
        } catch {
          // webContents 已关闭等——忽略本次推送。
        }
      };
      wc.on("did-navigate", emit);
      wc.on("did-navigate-in-page", emit);
      wc.on("page-title-updated", emit);
      wc.on("did-start-loading", emit);
      wc.on("did-stop-loading", emit);
      managed.stateWired = true;
    }
```

> 说明：监听里用 `key` 作为 payload 的 `tabId`（Phase 2 语义），与 map key 一致。

### Step 2.3 — shared Platform 类型 + preload + renderer：`onBrowserViewState` 订阅

shared Platform 接口追加（紧挨 Task 1 的导航方法）：

```ts
  /** 订阅 main 推送的受控视图状态；返回取消订阅函数。 */
  onBrowserViewState?: (
    listener: (state: BrowserViewState) => void,
  ) => () => void;
```

顶部类型 import 补 `BrowserViewState`。

preload 暴露（紧挨 Task 1 的导航 invoke）：

```ts
  onBrowserViewState: (listener: (state: BrowserViewState) => void) => {
    const handler = (_event: unknown, state: BrowserViewState) => listener(state);
    ipcRenderer.on(PlatformChannels.BrowserViewState, handler);
    return () => {
      ipcRenderer.removeListener(PlatformChannels.BrowserViewState, handler);
    };
  },
```

renderer platform impl（`main.tsx`）转发：

```ts
  onBrowserViewState: (listener) =>
    window.zcodePlatform.onBrowserViewState(listener),
```

**verify（Task 2 整体）**：
- `pnpm --filter @zcode/shared test viewNavigation`
- 三工程单独 typecheck（同 Task 1 verify 列表）。

commit：`feat(browser-use): push controlled view state from main to renderer (Phase 2 Task 2)`

---

## Task 3 — `UnifiedBrowserView` 组件（chrome + 占位 + 双向联动）

**目标**：新增 `packages/ui/src/browser-use/UnifiedBrowserView.tsx`。复用 `BrowserUseViewPane` 的占位 bounds/visible 上报范式，复用 `embeddedBrowserHelpers` 的 `normalizeBrowserUrl` 与 `EmbeddedBrowserPaneParts` 的 `BrowserToolbar`/`BrowserEmptyState`；地址栏回车调 `browserViewNavigate`，按钮调对应 IPC，`onBrowserViewState` 驱动 chrome。配 jsdom + testing-library 组件测试。

**可单测点**：组件测试（地址栏回车触发 navigate IPC、状态推送更新按钮禁用态）。

### Step 3.0 — 确认复用件签名（实现前先看，不写代码）

打开 `packages/ui/src/browser-use/EmbeddedBrowserPaneParts.tsx` 与 `embeddedBrowserHelpers.ts`，确认三者导出与 props：
- `normalizeBrowserUrl(input: string): string`（纯函数）。
- `BrowserToolbar` 的实际 props（地址值、onChange/onSubmit、canGoBack/canGoForward/isLoading、back/forward/reload/devtools 回调）。
- `BrowserEmptyState` 的实际 props。

下方 Step 3.1 的 JSX 按「导航面契约」编写；若 `BrowserToolbar`/`BrowserEmptyState` 的实际 prop 名与契约不符，以实际导出为准微调（这是本计划**唯一**未经直读确认的签名点）。`normalizeBrowserUrl` 为纯函数，风险最低，直接复用。

### Step 3.1 — 组件实现

新增 `packages/ui/src/browser-use/UnifiedBrowserView.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserViewState } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import {
  BrowserToolbar,
  BrowserEmptyState,
} from "./EmbeddedBrowserPaneParts.js";
import { normalizeBrowserUrl } from "./embeddedBrowserHelpers.js";
import { rectToViewBounds, sameBounds, type ViewBounds } from "./browserViewBounds.js";

/**
 * UnifiedBrowserView —— 「去 webview」统一浏览器视图（Phase 2）。
 *
 * chrome（地址栏 + 导航按钮）在 renderer；真正网页像素由 main 的 WebContentsView
 * 覆盖在下方占位 div 之上。human 导航直连 main→execute；main 回推状态驱动 chrome。
 * 与旧 webview 并存，本阶段仅供临时入口挂载验证，不接入正式 tab。
 */
export function UnifiedBrowserView({
  browserKey,
  isVisible,
}: {
  /** 受控视图 key（= BrowserViewManager map key）。 */
  browserKey: string;
  /** pane 是否可见（激活 + 展开）。 */
  isVisible: boolean;
}): React.JSX.Element {
  const platform = usePlatform();
  const ref = useRef<HTMLDivElement | null>(null);
  const lastBoundsRef = useRef<ViewBounds | null>(null);
  const rafRef = useRef<number | null>(null);

  // 地址栏输入（受控）与来自 main 的最新状态。
  const [address, setAddress] = useState("");
  const [state, setState] = useState<BrowserViewState | null>(null);

  // ---- 占位 bounds/visible 上报（复用 BrowserUseViewPane 范式）----
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const report = () => {
      rafRef.current = null;
      const el2 = ref.current;
      if (!el2) return;
      const bounds = rectToViewBounds(el2.getBoundingClientRect());
      if (bounds.width <= 0 || bounds.height <= 0) return;
      if (sameBounds(lastBoundsRef.current, bounds)) return;
      lastBoundsRef.current = bounds;
      void platform.browserViewSetBounds?.({ key: browserKey, rect: bounds }).catch((error) => {
        logger.debug("[browser-use] UnifiedBrowserView setBounds 上报失败", error);
      });
    };
    const scheduleReport = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(report);
    };

    const observer = new ResizeObserver(scheduleReport);
    observer.observe(el);
    window.addEventListener("resize", scheduleReport);
    scheduleReport();
    void platform.browserViewSetVisible?.({ key: browserKey, visible: isVisible });

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleReport);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      void platform.browserViewSetVisible?.({ key: browserKey, visible: false });
    };
  }, [browserKey, isVisible, platform]);

  useEffect(() => {
    void platform.browserViewSetVisible?.({ key: browserKey, visible: isVisible });
  }, [browserKey, isVisible, platform]);

  // ---- 订阅 main 状态推送，驱动地址栏文本与按钮禁用态 ----
  useEffect(() => {
    const unsubscribe = platform.onBrowserViewState?.((next) => {
      if (next.tabId !== browserKey) return;
      setState(next);
      // 页面 url 不可信：仅回填地址栏展示，不参与任何执行路径。
      setAddress(next.url);
    });
    return () => unsubscribe?.();
  }, [browserKey, platform]);

  // ---- 导航动作 ----
  const submitAddress = useCallback(() => {
    const url = normalizeBrowserUrl(address);
    if (!url) return;
    void platform.browserViewNavigate?.({ key: browserKey, url }).catch((error) => {
      logger.debug("[browser-use] navigate 失败", error);
    });
  }, [address, browserKey, platform]);

  const goBack = useCallback(() => {
    void platform.browserViewGoBack?.({ key: browserKey });
  }, [browserKey, platform]);
  const goForward = useCallback(() => {
    void platform.browserViewGoForward?.({ key: browserKey });
  }, [browserKey, platform]);
  const reload = useCallback(() => {
    void platform.browserViewReload?.({ key: browserKey });
  }, [browserKey, platform]);
  const openDevTools = useCallback(() => {
    void platform.browserViewOpenDevTools?.({ key: browserKey });
  }, [browserKey, platform]);

  const hasPage = Boolean(state?.url);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* chrome：地址栏 + 导航按钮。props 契约见 Step 3.0，按 BrowserToolbar 实际导出对齐。 */}
      <BrowserToolbar
        address={address}
        onAddressChange={setAddress}
        onSubmit={submitAddress}
        canGoBack={state?.canGoBack ?? false}
        canGoForward={state?.canGoForward ?? false}
        isLoading={state?.isLoading ?? false}
        onBack={goBack}
        onForward={goForward}
        onReload={reload}
        onOpenDevTools={openDevTools}
      />
      {/* 占位容器：真正网页像素由 main 的 WebContentsView 覆盖在此之上。 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={ref}
          className="h-full min-h-0 w-full bg-surface"
          data-unified-browser-view={browserKey}
        />
        {/* 无页面时叠加空态（不遮挡；WebContentsView 未显示时可见）。 */}
        {!hasPage ? (
          <div className="pointer-events-none absolute inset-0">
            <BrowserEmptyState />
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

### Step 3.2 — 组件测试（jsdom + testing-library）

新增 `packages/ui/src/browser-use/UnifiedBrowserView.test.tsx`（若 `@zcode/ui` 现有 vitest 未启 jsdom，则在其 vitest 配置为该文件启用 `environment: "jsdom"`，或文件头加 `// @vitest-environment jsdom`）：

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BrowserViewState } from "@zcode/shared";
import { UnifiedBrowserView } from "./UnifiedBrowserView.js";

// 捕获注入的 onBrowserViewState 回调，用于手动触发状态推送。
let stateListener: ((s: BrowserViewState) => void) | null = null;
const navigate = vi.fn().mockResolvedValue(undefined);

const platform = {
  browserViewSetBounds: vi.fn().mockResolvedValue(undefined),
  browserViewSetVisible: vi.fn().mockResolvedValue(undefined),
  browserViewNavigate: navigate,
  browserViewGoBack: vi.fn().mockResolvedValue(undefined),
  browserViewGoForward: vi.fn().mockResolvedValue(undefined),
  browserViewReload: vi.fn().mockResolvedValue(undefined),
  browserViewOpenDevTools: vi.fn().mockResolvedValue(undefined),
  onBrowserViewState: (l: (s: BrowserViewState) => void) => {
    stateListener = l;
    return () => {
      stateListener = null;
    };
  },
};

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => platform,
}));
// ResizeObserver 在 jsdom 缺失，补桩。
beforeEach(() => {
  stateListener = null;
  navigate.mockClear();
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("UnifiedBrowserView", () => {
  it("地址栏回车触发 browserViewNavigate（url 经 normalize）", () => {
    render(<UnifiedBrowserView browserKey="session-1" isVisible />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledTimes(1);
    const arg = navigate.mock.calls[0][0];
    expect(arg.key).toBe("session-1");
    expect(arg.url).toContain("example.com"); // normalizeBrowserUrl 补全 scheme
  });

  it("状态推送更新按钮禁用态", () => {
    render(<UnifiedBrowserView browserKey="session-1" isVisible />);
    // 初始：canGoBack 未知 → 后退禁用。
    const back = screen.getByRole("button", { name: /back|后退/i });
    expect(back).toBeDisabled();
    // 推送 canGoBack:true → 后退可用；且只认匹配 tabId 的推送。
    stateListener?.({
      tabId: "session-1",
      url: "https://example.com",
      title: "t",
      canGoBack: true,
      canGoForward: false,
      isLoading: false,
    });
    expect(back).not.toBeDisabled();
    stateListener?.({
      tabId: "other",
      url: "https://x",
      title: "x",
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    });
    expect(back).not.toBeDisabled(); // 非本 key 的推送被忽略
  });
});
```

> 测试断言依赖 `BrowserToolbar` 渲染出 `role="textbox"` 地址栏与可辨识的后退 `button`（disabled 反映 `canGoBack`）。若 Step 3.0 发现 prop/可访问名不同，同步微调选择器与传参——测试意图（回车触发 navigate、推送驱动禁用态）不变。

**verify（Task 3 整体）**：
- `pnpm --filter @zcode/ui test UnifiedBrowserView`（红→绿）。
- `pnpm --filter @zcode/ui typecheck`。

commit：`feat(browser-use): add UnifiedBrowserView component with chrome/state binding (Phase 2 Task 3)`

---

## Task 4 — 运行时验证清单（不写代码）

Phase 2 不接线到正式 tab，用**临时入口/开关**挂载 `UnifiedBrowserView` 驱动验证。以下为手动验证清单（本 task 只执行、不改产品代码，验证入口用完即撤或以 dev-only 开关隔离）。

**临时挂载方式（择一）**：
- 在某个 dev-only 面板/路由临时渲染 `<UnifiedBrowserView browserKey="<任一活动 sessionId>" isVisible />`；或
- 在现有 side-pane 加一个仅 dev 可见的开关，切到 `UnifiedBrowserView`（不改动 `AnimatedSidePanePanel` 的既有 webview 分支，仅并列新增分支）。

**启动**：按 MEMORY「桌面版 dev 启动」（pnpm 10.33.2 + `ELECTRON_MIRROR` 国内镜像）起 desktop dev。

**验证项**：
1. **显示对齐**：挂载后网页像素（WebContentsView）精确覆盖占位 div，随 side-pane 展开/窗口 resize 跟随（bounds 上报生效）；切走/卸载后网页隐藏，页面状态保留。
2. **地址栏导航**：地址栏输入 `example.com` 回车 → 页面跳转；地址栏文本被 main 回推的 `url` 更新为规范化后的地址（含 scheme）。
3. **后退/前进**：多页导航后点后退/前进 → 页面切换，且按钮禁用态与 `canGoBack/canGoForward` 一致（无历史时禁用）。
4. **刷新**：点刷新 → 页面重载；`isLoading` 期间 chrome 呈加载态、加载完成复位。
5. **DevTools**：点开发者工具 → 受控 view 的 DevTools 以 detach 模式打开。
6. **状态推送时序**：`did-start-loading`/`did-stop-loading`/`page-title-updated`/`did-navigate(-in-page)` 均能触发 chrome 更新（观察 main logger `[browser-use] state …` 与 renderer 按钮态同步）。
7. **并存无回归**：旧 `webview` 面板路径与 agent 命令链（host→main→execute）不受影响——agent 触发的导航仍工作，且不会与 human 导航互相干扰（共用 `execute` 出口）。
8. **key 隔离**：非本 `browserKey` 的状态推送被组件忽略（不误更新他 tab 的 chrome）。

验证通过后，撤除临时入口/关闭 dev 开关，保持「与旧 webview 并存、未接正式 tab」的 Phase 2 边界。

commit（如有临时入口需保留为 dev-only 开关）：`chore(browser-use): dev-only mount switch for UnifiedBrowserView runtime check (Phase 2 Task 4)`；若临时入口用完即撤则无需 commit。

---

## Self-Review

**Spec 覆盖**：
- 新增 renderer 组件 `UnifiedBrowserView`（chrome + 占位 div，WebContentsView 覆盖）✓（Task 3）
- human 导航走新增 IPC 直连 main → `browserViewManager.execute(win, key, command)` ✓（Task 1；`toNavigateCommand` + `{method:"back"/"forward"/"reload"}`；OpenDevTools 走独立 `openDevTools` 薄方法，因其不在 `BrowserCommand` 联合内，避免污染 agent 命令面）
- main 监听 `did-navigate`/`did-navigate-in-page`/`page-title-updated`/`did-start-loading`/`did-stop-loading` → 推 `BrowserViewState` ✓（Task 2）
- 与旧 webview 并存：不替换 `AnimatedSidePanePanel` 分支、不删 webview、不动 agent、不合并 tab 类型 ✓（Global Constraint 8 + Task 4 临时入口隔离）
- 5 个导航 channel + 状态 channel、platform 类型、preload、renderer impl、handler、wiring 齐备 ✓

**占位扫描**：全文无 `TBD`/`占位符`/「类似上文」；每个代码步骤给完整可编译代码。**唯一**未经直读确认的签名点已显式标注（Step 3.0：`BrowserToolbar`/`BrowserEmptyState` 的 prop 名），并要求实现前先确认、以实际导出对齐——这是计划级别的正常「确认签名」步骤，不是代码占位。

**类型一致性**：
- `execute(win, key, command: BrowserCommand)` 签名与 `browserViewManager.ts` 现读一致；`{method:"navigate"|"back"|"forward"|"reload"}` 均在 `commands.ts` 的判别联合内 ✓
- `setBounds`/`setVisible` 与 `browserViewSetBounds`/`browserViewSetVisible` 端到端范式对齐（`BrowserUseViewPane.tsx` + `desktopMainIpcPlatform.ts`）✓
- handler 复用 `BrowserWindow.fromWebContents(event.sender)` + `win.isDestroyed()` 守卫 ✓
- 新增 schema 均 `.strict()`，与 `commands.ts`/`browserCommandContextSchema` 风格一致 ✓
- 三工程（desktop main/preload/renderer）+ `@zcode/ui` 均列出单独 `tsc`/typecheck（根 typecheck 不含）✓
