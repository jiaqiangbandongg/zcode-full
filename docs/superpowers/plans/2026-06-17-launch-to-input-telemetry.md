# 启动到能输入分阶段耗时埋点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端「进程创建 → 用户能输入」的启动链路拆成 7 段独立耗时，经 ARMS 上报，替换仅测 renderer 渲染段的 `perf_ui_first_screen`。

**Architecture:** main 进程在四个时刻记 epoch 毫秒标记（锚点 `process.getCreationTime()` + 三个 `Date.now()`），经主窗口 loadURL 的 query string 注入 renderer；renderer 再记三个时刻（bundle 执行 / React commit / 启动门禁清除），在门禁清除那一刻统一算出 7 段差值并各发一条 ARMS 事件。序列化/解析/计算逻辑集中在纯函数里以便单测。

**Tech Stack:** TypeScript、Electron（main/preload/renderer）、React、Vitest。复用现有 `reportArmsCustomEvent` → IPC → `armsRum.sendCustom` 链路。

## Global Constraints

- 事件 `group` 统一为 `"ui_perf"`（常量 `UI_PERF_ARMS_GROUP`，已存在，复用）。
- 所有 `value` 经 `Math.max(0, Math.round(...))` 钳为非负整数 ms。
- 埋点失败绝不阻塞启动主流程：所有上报内部 try/catch，仅 `logger.warn`。
- 总时长 `> LAUNCH_TO_INPUT_SANITY_MAX_MS`（300000）整批丢弃，不上报。
- 锚点缺失（`getCreationTime()` 返回 null / query 未解析出 marks）整批跳过。
- 未登录（WelcomeScreen）的启动不上报总链路（前提「能输入」不成立）。
- 每个 renderer 进程冷启动仅上报一次。
- loadURL query 参数名前缀常量 `LAUNCH_MARKS_QUERY_KEY = "zcodeLaunchMarks"`。
- 测试运行：单测用 `pnpm exec vitest run <file>`；类型检查 `pnpm typecheck`。

---

### Task 1: 共享 launch marks 序列化/解析（`@zcode/shared`）

**Files:**
- Create: `packages/shared/src/launchMarks.ts`
- Modify: `packages/shared/src/index.ts:111`（在 `collectTelemetryRendererContext` 导出后追加）
- Test: `packages/shared/test/launchMarks.test.ts`

**Interfaces:**
- Produces:
  - `interface LaunchMarks { createdAt: number; mainStart: number; appReady: number; loadUrl: number }`
  - `const LAUNCH_MARKS_QUERY_KEY = "zcodeLaunchMarks"`
  - `serializeLaunchMarks(marks: LaunchMarks): string` — 返回 URL-safe 字符串（JSON）
  - `parseLaunchMarks(raw: string | null | undefined): LaunchMarks | null` — 非法/缺字段返回 null

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/launchMarks.test.ts
import { describe, expect, it } from "vitest";
import {
  LAUNCH_MARKS_QUERY_KEY,
  parseLaunchMarks,
  serializeLaunchMarks,
} from "../src/launchMarks.js";

describe("launchMarks", () => {
  const marks = { createdAt: 1000, mainStart: 1100, appReady: 1300, loadUrl: 1500 };

  it("round-trips through serialize/parse", () => {
    expect(parseLaunchMarks(serializeLaunchMarks(marks))).toEqual(marks);
  });

  it("query key 常量稳定", () => {
    expect(LAUNCH_MARKS_QUERY_KEY).toBe("zcodeLaunchMarks");
  });

  it("非法输入返回 null", () => {
    expect(parseLaunchMarks(null)).toBeNull();
    expect(parseLaunchMarks(undefined)).toBeNull();
    expect(parseLaunchMarks("not-json")).toBeNull();
    expect(parseLaunchMarks(JSON.stringify({ createdAt: 1 }))).toBeNull();
  });

  it("字段非数字返回 null", () => {
    expect(
      parseLaunchMarks(JSON.stringify({ createdAt: "x", mainStart: 1, appReady: 1, loadUrl: 1 })),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/shared/test/launchMarks.test.ts`
Expected: FAIL（`Cannot find module ../src/launchMarks.js`）

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/launchMarks.ts

/** main 进程采集的四个启动时刻（epoch 毫秒）。renderer 据此计算分阶段耗时。 */
export interface LaunchMarks {
  /** process.getCreationTime()：进程创建（锚点 T0） */
  createdAt: number;
  /** main/index.ts 模块顶部 Date.now()（T1） */
  mainStart: number;
  /** app.whenReady 回调入口 Date.now()（T2） */
  appReady: number;
  /** 主窗口 loadWindow 内 loadURL 前 Date.now()（T3） */
  loadUrl: number;
}

/** 主窗口 loadURL query string 中携带 launch marks 的参数名 */
export const LAUNCH_MARKS_QUERY_KEY = "zcodeLaunchMarks";

export function serializeLaunchMarks(marks: LaunchMarks): string {
  return JSON.stringify(marks);
}

export function parseLaunchMarks(raw: string | null | undefined): LaunchMarks | null {
  if (raw == null || raw === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys: (keyof LaunchMarks)[] = ["createdAt", "mainStart", "appReady", "loadUrl"];
  const result = {} as LaunchMarks;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    result[key] = value;
  }
  return result;
}
```

- [ ] **Step 4: Add barrel export**

`packages/shared/src/index.ts`，在第 111 行 `export { collectTelemetryRendererContext } from "./telemetry.js";` 之后追加：

```ts
export type { LaunchMarks } from "./launchMarks.js";
export {
  LAUNCH_MARKS_QUERY_KEY,
  parseLaunchMarks,
  serializeLaunchMarks,
} from "./launchMarks.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run packages/shared/test/launchMarks.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/launchMarks.ts packages/shared/src/index.ts packages/shared/test/launchMarks.test.ts
git commit -m "feat(shared): launch marks 序列化/解析"
```

---

### Task 2: 7 段上报与计算逻辑（`uiPerfArmsTelemetry.ts`），废弃 first_screen

**Files:**
- Modify: `packages/ui/src/lib/uiPerfArmsTelemetry.ts`
- Modify: `packages/ui/src/index.ts:84`
- Test: `packages/ui/test/uiPerfArmsTelemetry.test.ts`

**Interfaces:**
- Consumes: `LaunchMarks` from `@zcode/shared`（Task 1）
- Produces:
  - 常量 `LAUNCH_TO_INPUT_SANITY_MAX_MS = 300000`
  - 事件名常量：`UI_PERF_EVENT_LAUNCH_TO_INPUT="perf_ui_launch_to_input"`、`UI_PERF_EVENT_LAUNCH_ELECTRON_INIT="perf_ui_launch_electron_init_ms"`、`UI_PERF_EVENT_LAUNCH_APP_READY="perf_ui_launch_app_ready_ms"`、`UI_PERF_EVENT_LAUNCH_WINDOW="perf_ui_launch_window_ms"`、`UI_PERF_EVENT_LAUNCH_RENDERER_LOAD="perf_ui_launch_renderer_load_ms"`、`UI_PERF_EVENT_LAUNCH_REACT_COMMIT="perf_ui_launch_react_commit_ms"`、`UI_PERF_EVENT_LAUNCH_STARTUP_GATE="perf_ui_launch_startup_gate_ms"`
  - `interface LaunchToInputTimings { marks: LaunchMarks; rendererStart: number; reactCommit: number; inputReady: number; sessionId: string }`
  - `reportUiLaunchToInput(timings: LaunchToInputTimings): void` — 计算 7 段、做哨兵校验、发 ≤7 条
- Removes: `UI_PERF_EVENT_FIRST_SCREEN`、`reportUiFirstScreen`、`pendingFirstScreenPayload` 及 `setUiPerfArmsReporter` 内补发分支

- [ ] **Step 1: Rewrite the test file**

完整替换 `packages/ui/test/uiPerfArmsTelemetry.test.ts`（删除 first_screen / 暂存补发用例，新增 launch 用例；first_token / message_complete / stream_stall 用例原样保留）：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArmsCustomEventPayload } from "@zcode/shared";
import {
  LAUNCH_TO_INPUT_SANITY_MAX_MS,
  STREAM_STALL_REPORT_THRESHOLD_MS,
  UI_PERF_ARMS_GROUP,
  UI_PERF_EVENT_LAUNCH_ELECTRON_INIT,
  UI_PERF_EVENT_LAUNCH_REACT_COMMIT,
  UI_PERF_EVENT_LAUNCH_STARTUP_GATE,
  UI_PERF_EVENT_LAUNCH_TO_INPUT,
  clearStreamStallTracking,
  clearUiPerfArmsReporterForTest,
  recordStreamChunkArrival,
  reportUiFirstToken,
  reportUiLaunchToInput,
  reportUiMessageComplete,
  setUiPerfArmsReporter,
} from "@/lib/uiPerfArmsTelemetry.js";

function makeReporter() {
  const calls: ArmsCustomEventPayload[] = [];
  return {
    calls,
    reportArmsCustomEvent: vi.fn(async (payload: ArmsCustomEventPayload) => {
      calls.push(payload);
    }),
  };
}

function makeTimings(overrides?: Partial<{ createdAt: number; mainStart: number; appReady: number; loadUrl: number; rendererStart: number; reactCommit: number; inputReady: number }>) {
  const base = {
    createdAt: 1000,
    mainStart: 1600, // electron_init = 600
    appReady: 1780, // app_ready = 180
    loadUrl: 2020, // window = 240
    rendererStart: 2930, // renderer_load = 910
    reactCommit: 3005, // react_commit = 75
    inputReady: 3820, // startup_gate = 815, total = 2820
    ...overrides,
  };
  return {
    marks: {
      createdAt: base.createdAt,
      mainStart: base.mainStart,
      appReady: base.appReady,
      loadUrl: base.loadUrl,
    },
    rendererStart: base.rendererStart,
    reactCommit: base.reactCommit,
    inputReady: base.inputReady,
    sessionId: "sess-1",
  };
}

afterEach(() => {
  clearUiPerfArmsReporterForTest();
  vi.restoreAllMocks();
});

describe("uiPerfArmsTelemetry: 通用", () => {
  it("未注入 reporter 时静默不抛错", () => {
    expect(() => reportUiLaunchToInput(makeTimings())).not.toThrow();
  });

  it("reportUiFirstToken 带 model/talk_id/message_id", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiFirstToken({ ttftMs: 800, model: "glm-4", talkId: "t1", messageId: "m1" });
    expect(reporter.calls[0]).toMatchObject({
      name: "perf_ui_first_token",
      group: UI_PERF_ARMS_GROUP,
      value: 800,
      properties: { model: "glm-4", talk_id: "t1", message_id: "m1" },
    });
  });

  it("reportUiMessageComplete 带 result", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiMessageComplete({ durationMs: 5000, result: "success", talkId: "t1", messageId: "m1" });
    expect(reporter.calls[0]).toMatchObject({
      name: "perf_ui_message_complete",
      group: UI_PERF_ARMS_GROUP,
      value: 5000,
      properties: { result: "success", talk_id: "t1", message_id: "m1" },
    });
  });

  it("reporter 抛错被吞掉不向上传播", () => {
    const reporter = {
      reportArmsCustomEvent: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    setUiPerfArmsReporter(reporter);
    expect(() => reportUiLaunchToInput(makeTimings())).not.toThrow();
  });
});

describe("reportUiLaunchToInput: 7 段", () => {
  it("发 7 条，各段 value 正确，total = inputReady - createdAt", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiLaunchToInput(makeTimings());
    expect(reporter.calls).toHaveLength(7);
    const byName = new Map(reporter.calls.map((c) => [c.name, c]));
    expect(byName.get(UI_PERF_EVENT_LAUNCH_TO_INPUT)).toMatchObject({
      group: UI_PERF_ARMS_GROUP,
      value: 2820,
      properties: { session_id: "sess-1" },
    });
    expect(byName.get(UI_PERF_EVENT_LAUNCH_ELECTRON_INIT)?.value).toBe(600);
    expect(byName.get(UI_PERF_EVENT_LAUNCH_REACT_COMMIT)?.value).toBe(75);
    expect(byName.get(UI_PERF_EVENT_LAUNCH_STARTUP_GATE)?.value).toBe(815);
  });

  it("某段为负（时钟回拨）→ 该段钳为 0，其余正常", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    // appReady 早于 mainStart：app_ready 段为负
    reportUiLaunchToInput(makeTimings({ appReady: 1500, mainStart: 1600 }));
    const byName = new Map(reporter.calls.map((c) => [c.name, c]));
    expect(byName.get("perf_ui_launch_app_ready_ms")?.value).toBe(0);
  });

  it("总时长超哨兵阈值 → 整批不发", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiLaunchToInput(makeTimings({ inputReady: 1000 + LAUNCH_TO_INPUT_SANITY_MAX_MS + 1 }));
    expect(reporter.calls).toHaveLength(0);
  });
});

describe("stream stall", () => {
  it("首个 chunk 不上报(无前序)", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordStreamChunkArrival("t1", { now: 1000 });
    expect(reporter.calls).toHaveLength(0);
  });

  it("间隔未超阈值不上报", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordStreamChunkArrival("t1", { now: 1000 });
    recordStreamChunkArrival("t1", { now: 1000 + STREAM_STALL_REPORT_THRESHOLD_MS });
    expect(reporter.calls).toHaveLength(0);
  });

  it("间隔超阈值上报真实时长", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordStreamChunkArrival("t1", { now: 1000 });
    recordStreamChunkArrival("t1", {
      now: 1000 + STREAM_STALL_REPORT_THRESHOLD_MS + 500,
      waitingTool: true,
    });
    expect(reporter.calls).toHaveLength(1);
    expect(reporter.calls[0]).toMatchObject({
      name: "perf_ui_stream_stall",
      value: STREAM_STALL_REPORT_THRESHOLD_MS + 500,
      properties: { waiting_tool: true, talk_id: "t1" },
    });
  });

  it("clearStreamStallTracking 后重置(下一个 chunk 视为首个)", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordStreamChunkArrival("t1", { now: 1000 });
    clearStreamStallTracking("t1");
    recordStreamChunkArrival("t1", { now: 100000 });
    expect(reporter.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/ui/test/uiPerfArmsTelemetry.test.ts`
Expected: FAIL（`reportUiLaunchToInput` / 新常量未导出）

- [ ] **Step 3: Edit `uiPerfArmsTelemetry.ts` — 删除 first_screen，新增 launch**

3a. 顶部 import 增加 `LaunchMarks` 类型：

```ts
import type { ArmsCustomEventPayload, IPlatformService, LaunchMarks } from "@zcode/shared";
```

3b. 删除第 6 行 `export const UI_PERF_EVENT_FIRST_SCREEN = "perf_ui_first_screen";`，替换为新事件名 + 哨兵常量：

```ts
export const UI_PERF_EVENT_LAUNCH_TO_INPUT = "perf_ui_launch_to_input";
export const UI_PERF_EVENT_LAUNCH_ELECTRON_INIT = "perf_ui_launch_electron_init_ms";
export const UI_PERF_EVENT_LAUNCH_APP_READY = "perf_ui_launch_app_ready_ms";
export const UI_PERF_EVENT_LAUNCH_WINDOW = "perf_ui_launch_window_ms";
export const UI_PERF_EVENT_LAUNCH_RENDERER_LOAD = "perf_ui_launch_renderer_load_ms";
export const UI_PERF_EVENT_LAUNCH_REACT_COMMIT = "perf_ui_launch_react_commit_ms";
export const UI_PERF_EVENT_LAUNCH_STARTUP_GATE = "perf_ui_launch_startup_gate_ms";

// 总时长超过该值视为时钟异常/挂起，整批丢弃，避免污染分布。
export const LAUNCH_TO_INPUT_SANITY_MAX_MS = 300000;
```

3c. 删除 `pendingFirstScreenPayload` 声明（第 20-23 行注释 + `let pendingFirstScreenPayload ...`），并把 `setUiPerfArmsReporter` 简化为：

```ts
export function setUiPerfArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}
```

3d. `clearUiPerfArmsReporterForTest` 删除 `pendingFirstScreenPayload = null;` 一行（保留 `armsReporter = null;` 与 `lastChunkAtByTask.clear();`）。

3e. 删除整个 `reportUiFirstScreen` 函数（第 54-67 行），替换为：

```ts
interface LaunchToInputTimings {
  marks: LaunchMarks;
  /** renderer/src/main.tsx 模块顶部 Date.now()（T4） */
  rendererStart: number;
  /** zcode-react-startup-ready 触发时 Date.now()（T5） */
  reactCommit: number;
  /** 启动门禁清除、输入框可用时 Date.now()（T6） */
  inputReady: number;
  /** 同一次启动的关联键 */
  sessionId: string;
}

function clampMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

export function reportUiLaunchToInput(timings: LaunchToInputTimings): void {
  const { marks, rendererStart, reactCommit, inputReady, sessionId } = timings;
  const total = inputReady - marks.createdAt;
  // 哨兵:异常总时长(时钟跳变/进程挂起)整批丢弃。
  if (total < 0 || total > LAUNCH_TO_INPUT_SANITY_MAX_MS) {
    logger.warn("[ui-perf] launch_to_input 总时长异常,丢弃", { total });
    return;
  }
  const properties = { session_id: sessionId };
  const stages: { name: string; ms: number }[] = [
    { name: UI_PERF_EVENT_LAUNCH_TO_INPUT, ms: total },
    { name: UI_PERF_EVENT_LAUNCH_ELECTRON_INIT, ms: marks.mainStart - marks.createdAt },
    { name: UI_PERF_EVENT_LAUNCH_APP_READY, ms: marks.appReady - marks.mainStart },
    { name: UI_PERF_EVENT_LAUNCH_WINDOW, ms: marks.loadUrl - marks.appReady },
    { name: UI_PERF_EVENT_LAUNCH_RENDERER_LOAD, ms: rendererStart - marks.loadUrl },
    { name: UI_PERF_EVENT_LAUNCH_REACT_COMMIT, ms: reactCommit - rendererStart },
    { name: UI_PERF_EVENT_LAUNCH_STARTUP_GATE, ms: inputReady - reactCommit },
  ];
  for (const stage of stages) {
    emit({ name: stage.name, group: UI_PERF_ARMS_GROUP, value: clampMs(stage.ms), properties });
  }
}
```

- [ ] **Step 4: Update barrel export**

`packages/ui/src/index.ts:84`，把
```ts
export { reportUiFirstScreen } from "./lib/uiPerfArmsTelemetry.js";
```
替换为：
```ts
export { reportUiLaunchToInput } from "./lib/uiPerfArmsTelemetry.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run packages/ui/test/uiPerfArmsTelemetry.test.ts`
Expected: PASS（通用 4 + launch 3 + stall 4 = 11 个用例）

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/uiPerfArmsTelemetry.ts packages/ui/src/index.ts packages/ui/test/uiPerfArmsTelemetry.test.ts
git commit -m "feat(ui): 启动到能输入 7 段上报,废弃 perf_ui_first_screen"
```

---

### Task 3: main 进程采集 T0–T3 并经 loadURL query 注入

**Files:**
- Modify: `packages/desktop/src/main/index.ts`（顶部记 T1；whenReady 回调记 T2；导出 getter）
- Modify: `packages/desktop/src/main/desktopHostProcess.ts:86-112`（loadWindow 内记 T3、拼 query）

**Interfaces:**
- Consumes: `serializeLaunchMarks`, `LAUNCH_MARKS_QUERY_KEY`, `LaunchMarks` from `@zcode/shared`（Task 1）
- Produces: `getMainLaunchPartialMarks(): { createdAt: number; mainStart: number; appReady: number }`（供 loadWindow 调用）

> 说明：`additionalArguments` 在 `BrowserWindow` 构造时固定，而 T3 在更晚的 `loadWindow` 才产生，故四个 marks 统一走 loadURL query（renderer 单点读取）。此任务无独立单测（Electron 主进程时序难纯函数化），靠 Task 1 的序列化单测 + Task 6 本地验证覆盖。

- [ ] **Step 1: `index.ts` 顶部记 T1、声明 T0/T2 状态**

在 `packages/desktop/src/main/index.ts` 模块顶部 import 区之后、其它初始化之前，加入：

```ts
import { serializeLaunchMarks, type LaunchMarks } from "@zcode/shared";

// 启动计时(epoch ms):T0 进程创建 / T1 main JS / T2 whenReady。T3 在 loadWindow 记。
const launchCreatedAt = process.getCreationTime() ?? Date.now();
const launchMainStart = Date.now();
let launchAppReady = 0;

export function getMainLaunchPartialMarks(): Omit<LaunchMarks, "loadUrl"> {
  return { createdAt: launchCreatedAt, mainStart: launchMainStart, appReady: launchAppReady };
}
```

（若文件已 import `@zcode/shared` 的其它符号，合并到同一 import；`serializeLaunchMarks` 实际在 desktopHostProcess 用，这里仅需 `LaunchMarks` 类型——按需保留类型导入。）

- [ ] **Step 2: whenReady 回调入口记 T2**

`index.ts:981` `app.whenReady().then(async () => {` 之后第一行加入：

```ts
  launchAppReady = Date.now();
```

- [ ] **Step 3: `loadWindow` 内记 T3 并拼入 query**

`packages/desktop/src/main/desktopHostProcess.ts`，顶部 import 加：

```ts
import {
  LAUNCH_MARKS_QUERY_KEY,
  serializeLaunchMarks,
} from "@zcode/shared";
import { getMainLaunchPartialMarks } from "./index.js";
```

在 `loadWindow` 内构造 `query` 对象处（第 91-99 行的 `Object.fromEntries(...)` 之后、`if (process.env["ELECTRON_RENDERER_URL"])` 之前）插入，仅主窗口 `index` 注入：

```ts
  if (page === "index") {
    const partial = getMainLaunchPartialMarks();
    query[LAUNCH_MARKS_QUERY_KEY] = serializeLaunchMarks({
      ...partial,
      loadUrl: Date.now(), // T3
    });
  }
```

> 注意：`query` 当前被 `.filter(...)` 收窄成 `Record<string,string>`，`query[KEY] = string` 合法。`loadFile` 分支已透传 `query`，`loadURL` 分支已遍历 `query` 设 searchParams，两条加载路径都会带上。

- [ ] **Step 4: 验证类型与构建**

Run: `pnpm typecheck`
Expected: PASS（无类型错误）。若出现 `index.ts` ↔ `desktopHostProcess.ts` 循环 import 告警：保持 `getMainLaunchPartialMarks` 为函数（惰性读取模块级变量），ESM 下函数调用时变量已初始化，循环可接受；如 tsc 仍报错，将三个 launch 变量与 getter 抽到新文件 `packages/desktop/src/main/launchMarks.ts` 再分别 import。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/index.ts packages/desktop/src/main/desktopHostProcess.ts
git commit -m "feat(desktop): main 采集 T0-T3 经 loadURL query 注入"
```

---

### Task 4: renderer 读取 marks、记 T4/T5，移除旧 first_screen 调用

**Files:**
- Modify: `packages/desktop/src/renderer/src/main.tsx`

**Interfaces:**
- Consumes: `parseLaunchMarks`, `LAUNCH_MARKS_QUERY_KEY`, `LaunchMarks` from `@zcode/shared`
- Produces:
  - `window.__ZCODE_LAUNCH_MARKS__: LaunchMarks | null`（从 location query 解析，模块层一次）
  - `window.__ZCODE_RENDERER_START__: number`（T4，模块顶部 Date.now()）
  - `window.__ZCODE_REACT_COMMIT_AT__: number`（T5，startup-ready 时写入）

- [ ] **Step 1: 模块顶部记 T4、解析 marks**

`packages/desktop/src/renderer/src/main.tsx`，import 区把 `reportUiFirstScreen` 从 `@zcode/ui` 移除；从 `@zcode/shared` 增加 `parseLaunchMarks, LAUNCH_MARKS_QUERY_KEY, type LaunchMarks`。在 `startPerformanceTimelineCleanup();`（第 26 行）之前加入：

```ts
// T4:renderer bundle 开始执行。同时从 loadURL query 解析 main 注入的 T0-T3。
const rendererStartedAt = Date.now();
const launchMarks: LaunchMarks | null = parseLaunchMarks(
  new URLSearchParams(window.location.search).get(LAUNCH_MARKS_QUERY_KEY),
);
(window as Window & {
  __ZCODE_RENDERER_START__?: number;
  __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null;
}).__ZCODE_RENDERER_START__ = rendererStartedAt;
(window as Window & { __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null }).__ZCODE_LAUNCH_MARKS__ =
  launchMarks;
```

- [ ] **Step 2: 删除旧 first_screen 计时块**

删除第 28-40 行整块（`uiFirstScreenStartedAt` 声明 + `window.addEventListener("zcode-react-startup-ready", ... reportUiFirstScreen ...)`）。

- [ ] **Step 3: `StartupReadyNotifier` 内记 T5**

`StartupReadyNotifier`（第 235-243 行）的 `useEffect` 改为派发事件前先记 T5：

```ts
function StartupReadyNotifier() {
  useEffect(() => {
    // T5:React 首次 commit。供启动分阶段耗时计算 react_commit 段。
    (window as Window & { __ZCODE_REACT_COMMIT_AT__?: number }).__ZCODE_REACT_COMMIT_AT__ =
      Date.now();
    // Bugfix: HTML 启动壳的弹出动画结束时，React 首屏可能还没 commit，直接移除壳会露出空白。
    window.dispatchEvent(new Event("zcode-react-startup-ready"));
  }, []);

  return null;
}
```

- [ ] **Step 4: 验证类型**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/src/main.tsx
git commit -m "feat(desktop): renderer 解析 launch marks 并记 T4/T5"
```

---

### Task 5: Root 监听门禁清除记 T6 并触发上报

**Files:**
- Modify: `packages/ui/src/Root.tsx`
- Test: `packages/ui/test/rootLaunchReport.test.ts`（纯函数 `buildLaunchToInputTimings` 单测）
- Create: `packages/ui/src/lib/launchToInputReport.ts`（纯函数封装，便于单测）

**Interfaces:**
- Consumes: `reportUiLaunchToInput`、`LaunchMarks`（Task 2）
- Produces:
  - `shouldReportLaunchToInput(state: { isStartupRenderBlocked: boolean; welcomeScreenOpen: boolean; alreadyReported: boolean }): boolean`
  - `readRendererLaunchTimings(): { marks: LaunchMarks | null; rendererStart: number; reactCommit: number } | null`（从 window 读 T4/T5/marks）

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/test/rootLaunchReport.test.ts
import { describe, expect, it } from "vitest";
import { shouldReportLaunchToInput } from "@/lib/launchToInputReport.js";

describe("shouldReportLaunchToInput", () => {
  it("门禁已清除、非 welcome、未上报过 → 上报", () => {
    expect(
      shouldReportLaunchToInput({
        isStartupRenderBlocked: false,
        welcomeScreenOpen: false,
        alreadyReported: false,
      }),
    ).toBe(true);
  });

  it("门禁仍阻塞 → 不上报", () => {
    expect(
      shouldReportLaunchToInput({
        isStartupRenderBlocked: true,
        welcomeScreenOpen: false,
        alreadyReported: false,
      }),
    ).toBe(false);
  });

  it("WelcomeScreen 打开(未登录,无输入框) → 不上报", () => {
    expect(
      shouldReportLaunchToInput({
        isStartupRenderBlocked: false,
        welcomeScreenOpen: true,
        alreadyReported: false,
      }),
    ).toBe(false);
  });

  it("已上报过 → 不重复", () => {
    expect(
      shouldReportLaunchToInput({
        isStartupRenderBlocked: false,
        welcomeScreenOpen: false,
        alreadyReported: true,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/ui/test/rootLaunchReport.test.ts`
Expected: FAIL（`Cannot find module .../launchToInputReport.js`）

- [ ] **Step 3: Write `launchToInputReport.ts`**

```ts
// packages/ui/src/lib/launchToInputReport.ts
import type { LaunchMarks } from "@zcode/shared";

export function shouldReportLaunchToInput(state: {
  isStartupRenderBlocked: boolean;
  welcomeScreenOpen: boolean;
  alreadyReported: boolean;
}): boolean {
  // 门禁清除 = RootStartupLoading 退场、输入框挂载;welcome 时虽门禁清除但显示登录页、无输入框,不算"能输入"。
  return (
    !state.alreadyReported && !state.isStartupRenderBlocked && !state.welcomeScreenOpen
  );
}

export function readRendererLaunchTimings(): {
  marks: LaunchMarks | null;
  rendererStart: number;
  reactCommit: number;
} | null {
  const w = window as Window & {
    __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null;
    __ZCODE_RENDERER_START__?: number;
    __ZCODE_REACT_COMMIT_AT__?: number;
  };
  const rendererStart = w.__ZCODE_RENDERER_START__;
  const reactCommit = w.__ZCODE_REACT_COMMIT_AT__;
  if (typeof rendererStart !== "number" || typeof reactCommit !== "number") {
    return null;
  }
  return { marks: w.__ZCODE_LAUNCH_MARKS__ ?? null, rendererStart, reactCommit };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/ui/test/rootLaunchReport.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: Wire into `Root.tsx`**

5a. import 区加入：

```ts
import { reportUiLaunchToInput } from "@/lib/uiPerfArmsTelemetry.js";
import {
  readRendererLaunchTimings,
  shouldReportLaunchToInput,
} from "@/lib/launchToInputReport.js";
import { useRef } from "react"; // 若已 import react hooks，合并
```

5b. 在 `isStartupRenderBlocked` 计算（第 547 行）之后加入 effect。`sessionId` 用 marks.createdAt 派生（同进程稳定且唯一）：

```ts
  const launchReportedRef = useRef(false);
  useEffect(() => {
    if (
      !shouldReportLaunchToInput({
        isStartupRenderBlocked,
        welcomeScreenOpen: Boolean(welcomeScreenOpenReason),
        alreadyReported: launchReportedRef.current,
      })
    ) {
      return;
    }
    launchReportedRef.current = true;
    const timings = readRendererLaunchTimings();
    if (!timings || !timings.marks) {
      return; // 锚点缺失(非桌面/未注入 marks),整批跳过
    }
    reportUiLaunchToInput({
      marks: timings.marks,
      rendererStart: timings.rendererStart,
      reactCommit: timings.reactCommit,
      inputReady: Date.now(), // T6
      sessionId: `launch-${timings.marks.createdAt}`,
    });
  }, [isStartupRenderBlocked, welcomeScreenOpenReason]);
```

- [ ] **Step 6: Run full ui telemetry + report tests**

Run: `pnpm exec vitest run packages/ui/test/uiPerfArmsTelemetry.test.ts packages/ui/test/rootLaunchReport.test.ts`
Expected: PASS

- [ ] **Step 7: Typecheck + Commit**

Run: `pnpm typecheck`
Expected: PASS

```bash
git add packages/ui/src/Root.tsx packages/ui/src/lib/launchToInputReport.ts packages/ui/test/rootLaunchReport.test.ts
git commit -m "feat(ui): 启动门禁清除时上报 launch_to_input"
```

---

### Task 6: 更新监控文档与本地验证

**Files:**
- Modify: `docs/monitoring/performance-monitoring.md:169-182`

- [ ] **Step 1: 替换事件一览中的 first_screen 行**

把第 171 行 `| \`perf_ui_first_screen\` | ... |` 一行删除，替换为 7 行：

```markdown
| `perf_ui_launch_to_input` | 启动到能输入总耗时 ms | 进程创建(`getCreationTime`)→ 启动门禁清除、输入框可用 | `session_id` |
| `perf_ui_launch_electron_init_ms` | Electron 启动 ms | 进程创建 → main JS | `session_id` |
| `perf_ui_launch_app_ready_ms` | main 初始化 ms | main JS → `app.whenReady` | `session_id` |
| `perf_ui_launch_window_ms` | 窗口编排 ms | `whenReady` → `loadURL` | `session_id` |
| `perf_ui_launch_renderer_load_ms` | renderer 加载 ms | `loadURL` → bundle 执行 | `session_id` |
| `perf_ui_launch_react_commit_ms` | React 渲染 ms | bundle → React 首次 commit | `session_id` |
| `perf_ui_launch_startup_gate_ms` | 启动门禁 ms | React commit → 输入框可用(鉴权/provider/workspace 恢复) | `session_id` |
```

- [ ] **Step 2: 更新「说明与边界」段**

在第 176 行附近补一条：

```markdown
- **启动分阶段**:7 段每进程冷启动各上报一次,`value` 为各段 ms(`Math.max(0,...)` 钳非负)。锚点 `process.getCreationTime()`,main 的 T0-T3 经主窗口 loadURL query(`zcodeLaunchMarks`)注入 renderer,在启动门禁清除(`isStartupRenderBlocked` 翻 false)时统一计算上报。未登录(WelcomeScreen)不上报;总时长 >300000ms 哨兵丢弃。`session_id` 关联同次启动各段。旧 `perf_ui_first_screen` 已废弃,语义并入 `perf_ui_launch_react_commit_ms`。
```

- [ ] **Step 3: 全量单测回归**

Run: `pnpm exec vitest run packages/ui/test/uiPerfArmsTelemetry.test.ts packages/ui/test/rootLaunchReport.test.ts packages/shared/test/launchMarks.test.ts`
Expected: PASS

- [ ] **Step 4: 本地验证（手动，开发构建 `arms_env=local`）**

参照 memory「桌面版 dev 启动」用国内镜像启动桌面 dev：
- 冷启动登录态 → main 日志 `beforeReport` 依次出现 7 条 `custom:perf_ui_launch_*`，`perf_ui_launch_to_input` ≈ 其余 6 段之和。
- `perf_ui_launch_react_commit_ms` 应接近旧 first_screen 的 ~75ms（sanity）。
- 未登录冷启动（WelcomeScreen）→ 不出现 `perf_ui_launch_to_input`。
- 回归：`perf_ui_first_token` / `perf_ui_message_complete` / `perf_ui_stream_stall` 仍正常。

- [ ] **Step 5: Commit**

```bash
git add docs/monitoring/performance-monitoring.md
git commit -m "docs(monitoring): 启动分阶段耗时事件,移除 perf_ui_first_screen"
```

---

## 实现顺序与依赖

Task 1（shared）→ Task 2（ui 上报）可并行于 Task 3（main）；Task 4 依赖 Task 1；Task 5 依赖 Task 2+4；Task 6 最后。建议顺序：1 → 2 → 3 → 4 → 5 → 6。
