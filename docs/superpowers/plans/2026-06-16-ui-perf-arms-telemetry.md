# 端侧 UI 性能 ARMS 上报 Implementation Plan

> 状态（2026-07-15）：已实施，本文保留为历史实施计划。当前埋点契约以
> `docs/monitoring/performance-monitoring.md`、`docs/monitoring/performance-telemetry-catalog.md`
> 和 `packages/ui/src/lib/uiPerfArmsTelemetry.ts` 为准；下文 `useZCodeChat` 等接入路径是实施时轨迹。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Electron renderer(UI)侧新增四个性能埋点(首屏、首token、消息耗时、流式停顿),经现有 ARMS `sendCustom` 链路上报到 `group=ui_perf`。

**Architecture:** 新建模块级单例封装 `uiPerfArmsTelemetry.ts`(仿既有模块级 ARMS 业务埋点 helper),reporter 在 `Root.tsx` 注入。首token/耗时复用 `useZCodeChat` 已算好的 `completionTelemetry` 镜像双发,不动 `/report`;首屏在 `main.tsx` 监听 `zcode-react-startup-ready`;流式停顿的 per-task 计时状态封装在 telemetry 模块内,handler 仅一行调用。全采,失败吞错。

**Tech Stack:** TypeScript, React, Vitest, `@zcode/shared` 的 `IPlatformService.reportArmsCustomEvent`。

---

## 设计依据(spec)

`docs/superpowers/specs/2026-06-16-ui-perf-arms-telemetry-design.md`

## 关键事实(已核实)

- 上报 API:`platform.reportArmsCustomEvent({ name, group, value, properties })`,公共维度由 main handler(`desktopMainIpcRemote.ts:119`)自动补齐。
- `ArmsCustomEventPayload`(`@zcode/shared`):`{ name: string; group: string; value?: number; properties?: Record<string, string | number | boolean | undefined> }`。
- 镜像点:`packages/ui/src/hooks/useZCodeChat.ts:567-603` 的 `reportPromptCompletionTelemetry`,`completionTelemetry.eventExtraDetail` 已含 `time_to_first_token`、`duration_ms`、`status`、`model_name`;`completionTelemetry.taskId`、`completionTelemetry.messageId` 可用。
- 首屏终点事件:`window` 上的 `"zcode-react-startup-ready"`(`main.tsx:221` 派发)。
- chunk 到达点:`taskStreamEventHandlers.ts` 的 `agent_message_chunk`(行 ~821)与 `agent_thought_chunk`(行 ~927)case,均有局部变量 `taskId`。
- 终态清理点:`taskStreamEventTerminalHandlers.ts` 的 `handleTaskCompleteEvent`(110)、`handleTaskErrorEvent`(340)。
- 测试框架:Vitest(参考 `packages/ui/src/lib/*.test.ts`)。

## 文件结构

| 文件 | 职责 |
|------|------|
| `packages/ui/src/lib/uiPerfArmsTelemetry.ts` | **新建**:单例 reporter + 常量 + 4 个 report 函数 + 流式停顿 per-task 状态 |
| `packages/ui/src/lib/uiPerfArmsTelemetry.test.ts` | **新建**:单测 |
| `packages/ui/src/Root.tsx` | 注入/清理 reporter |
| `packages/desktop/src/renderer/src/main.tsx` | 首屏起点+终点上报 |
| `packages/ui/src/hooks/useZCodeChat.ts` | 镜像首token/耗时到 ARMS |
| `packages/ui/src/hooks/taskStreamEventHandlers.ts` | chunk 到达调用停顿追踪 |
| `packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts` | 终态清理停顿状态 |
| `docs/monitoring/performance-monitoring.md` | 新增 ui_perf 一节 |

---

## Task 1: 新建 uiPerfArmsTelemetry 模块(reporter + 常量 + 首屏/首token/耗时上报)

**Files:**
- Create: `packages/ui/src/lib/uiPerfArmsTelemetry.ts`
- Test: `packages/ui/src/lib/uiPerfArmsTelemetry.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/ui/src/lib/uiPerfArmsTelemetry.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArmsCustomEventPayload } from "@zcode/shared";
import {
  UI_PERF_ARMS_GROUP,
  clearUiPerfArmsReporterForTest,
  reportUiFirstScreen,
  reportUiMessageComplete,
  reportUiFirstToken,
  setUiPerfArmsReporter,
} from "./uiPerfArmsTelemetry.js";

function makeReporter() {
  const calls: ArmsCustomEventPayload[] = [];
  return {
    calls,
    reportArmsCustomEvent: vi.fn(async (payload: ArmsCustomEventPayload) => {
      calls.push(payload);
    }),
  };
}

afterEach(() => {
  clearUiPerfArmsReporterForTest();
  vi.restoreAllMocks();
});

describe("uiPerfArmsTelemetry", () => {
  it("未注入 reporter 时静默不抛错", () => {
    expect(() => reportUiFirstScreen(1234)).not.toThrow();
  });

  it("reportUiFirstScreen 构造正确 payload", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiFirstScreen(1234);
    expect(reporter.calls).toHaveLength(1);
    expect(reporter.calls[0]).toMatchObject({
      name: "perf_ui_first_screen",
      group: UI_PERF_ARMS_GROUP,
      value: 1234,
    });
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
    expect(() => reportUiFirstScreen(1)).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @zcode/ui exec vitest run src/lib/uiPerfArmsTelemetry.test.ts`
Expected: FAIL — 模块不存在 / 导出未定义。

- [ ] **Step 3: 写实现**

创建 `packages/ui/src/lib/uiPerfArmsTelemetry.ts`:

```typescript
import type { ArmsCustomEventPayload, IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";

export const UI_PERF_ARMS_GROUP = "ui_perf";

export const UI_PERF_EVENT_FIRST_SCREEN = "perf_ui_first_screen";
export const UI_PERF_EVENT_FIRST_TOKEN = "perf_ui_first_token";
export const UI_PERF_EVENT_MESSAGE_COMPLETE = "perf_ui_message_complete";
export const UI_PERF_EVENT_STREAM_STALL = "perf_ui_stream_stall";

// 超过该间隔(ms)未收到新 chunk 视为停顿并上报;value 仍为真实间隔。可据线上分布收紧。
export const STREAM_STALL_REPORT_THRESHOLD_MS = 3000;

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

let armsReporter: ArmsReporter | null = null;

export function setUiPerfArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

export function clearUiPerfArmsReporterForTest(): void {
  armsReporter = null;
  lastChunkAtByTask.clear();
}

// 原因:ARMS 属观测链路,UI 主流程(启动/发送/渲染)不得因埋点失败而中断。
function emit(payload: ArmsCustomEventPayload): void {
  if (!armsReporter) {
    return;
  }
  try {
    void Promise.resolve(armsReporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[ui-perf] ARMS 上报失败", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[ui-perf] ARMS 上报异常", { name: payload.name, error });
  }
}

export function reportUiFirstScreen(elapsedMs: number, phase?: string): void {
  emit({
    name: UI_PERF_EVENT_FIRST_SCREEN,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(elapsedMs)),
    properties: { phase },
  });
}

export function reportUiFirstToken(params: {
  ttftMs: number;
  model?: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_FIRST_TOKEN,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.ttftMs)),
    properties: { model: params.model, talk_id: params.talkId, message_id: params.messageId },
  });
}

export function reportUiMessageComplete(params: {
  durationMs: number;
  result: string;
  talkId?: string;
  messageId?: string;
}): void {
  emit({
    name: UI_PERF_EVENT_MESSAGE_COMPLETE,
    group: UI_PERF_ARMS_GROUP,
    value: Math.max(0, Math.round(params.durationMs)),
    properties: { result: params.result, talk_id: params.talkId, message_id: params.messageId },
  });
}

// 流式停顿:per-task 记录上一个正文 chunk 到达时刻,间隔超阈值则上报真实间隔。
const lastChunkAtByTask = new Map<string, number>();

export function recordStreamChunkArrival(
  taskId: string,
  options?: { waitingTool?: boolean; now?: number },
): void {
  const now = options?.now ?? Date.now();
  const last = lastChunkAtByTask.get(taskId);
  lastChunkAtByTask.set(taskId, now);
  if (last === undefined) {
    return;
  }
  const gapMs = now - last;
  if (gapMs <= STREAM_STALL_REPORT_THRESHOLD_MS) {
    return;
  }
  emit({
    name: UI_PERF_EVENT_STREAM_STALL,
    group: UI_PERF_ARMS_GROUP,
    value: Math.round(gapMs),
    properties: { stall_ms: Math.round(gapMs), waiting_tool: options?.waitingTool ?? false, talk_id: taskId },
  });
}

export function clearStreamStallTracking(taskId: string): void {
  lastChunkAtByTask.delete(taskId);
}
```

> 注:`properties` 里 `phase`/`model` 等为 `undefined` 时,main handler 的 `.filter(entry => entry[1] !== undefined)` 会自动剔除,无需在 UI 侧清理。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @zcode/ui exec vitest run src/lib/uiPerfArmsTelemetry.test.ts`
Expected: PASS(5 个用例)。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/lib/uiPerfArmsTelemetry.ts packages/ui/src/lib/uiPerfArmsTelemetry.test.ts
git commit -m "feat(ui-perf): 新增 UI 性能 ARMS 上报封装模块"
```

---

## Task 2: 流式停顿追踪单测

**Files:**
- Test: `packages/ui/src/lib/uiPerfArmsTelemetry.test.ts`(追加)

- [ ] **Step 1: 追加失败测试**

在 `uiPerfArmsTelemetry.test.ts` 的 `describe` 内追加:

```typescript
import {
  recordStreamChunkArrival,
  clearStreamStallTracking,
  STREAM_STALL_REPORT_THRESHOLD_MS,
} from "./uiPerfArmsTelemetry.js";

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
    recordStreamChunkArrival("t1", { now: 1000 + STREAM_STALL_REPORT_THRESHOLD_MS + 500, waitingTool: true });
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

- [ ] **Step 2: 运行测试**

Run: `pnpm --filter @zcode/ui exec vitest run src/lib/uiPerfArmsTelemetry.test.ts`
Expected: PASS(全部用例,含新增 4 个)。实现已在 Task 1 完成,本任务确认行为。

- [ ] **Step 3: 提交**

```bash
git add packages/ui/src/lib/uiPerfArmsTelemetry.test.ts
git commit -m "test(ui-perf): 覆盖流式停顿追踪逻辑"
```

---

## Task 3: 在 Root.tsx 注入 reporter

**Files:**
- Modify: `packages/ui/src/Root.tsx:73`(import)、`:150-157`(useEffect)

- [ ] **Step 1: 加 import**

在 `Root.tsx` 现有 ARMS reporter import(行 73 附近)下方新增:

```typescript
import { setUiPerfArmsReporter } from "@/lib/uiPerfArmsTelemetry.js";
```

- [ ] **Step 2: 在现有 useEffect 注入/清理**

将 `Root.tsx:150-157` 的 useEffect 改为:

```typescript
  useEffect(() => {
    // 既有 reporter 注入保持不变
    setMcpStorePlatform(platform);
    setUiPerfArmsReporter(platform);
    return () => {
      setMcpStorePlatform(null);
      setUiPerfArmsReporter(null);
    };
  }, [platform]);
```

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @zcode/ui exec tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 4: 提交**

```bash
git add packages/ui/src/Root.tsx
git commit -m "feat(ui-perf): Root 注入 UI 性能 ARMS reporter"
```

---

## Task 4: 镜像首token/消息耗时到 ARMS

**Files:**
- Modify: `packages/ui/src/hooks/useZCodeChat.ts:16`(import 区)、`:589-600`(reportAppTelemetryEvent 之后)

- [ ] **Step 1: 加 import**

在 `useZCodeChat.ts` 的 `import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";`(行 16)下方新增:

```typescript
import { reportUiFirstToken, reportUiMessageComplete } from "@/lib/uiPerfArmsTelemetry.js";
```

- [ ] **Step 2: 在镜像点追加 ARMS 上报**

在 `useZCodeChat.ts` 的 `reportPromptCompletionTelemetry` 内,现有 `await reportAppTelemetryEvent(...)`(行 589-600)调用**之后**、回调结束前,追加:

```typescript
      // 镜像到 ARMS(group=ui_perf):不改动上面的 /report 链路,只额外双发。
      const detail = completionTelemetry.eventExtraDetail;
      const ttft = Number(detail.time_to_first_token);
      if (Number.isFinite(ttft)) {
        reportUiFirstToken({
          ttftMs: ttft,
          model: detail.model_name || undefined,
          talkId: completionTelemetry.taskId,
          messageId: completionTelemetry.messageId,
        });
      }
      const durationMs = Number(detail.duration_ms);
      if (Number.isFinite(durationMs)) {
        reportUiMessageComplete({
          durationMs,
          result: detail.status ?? statusToReport,
          talkId: completionTelemetry.taskId,
          messageId: completionTelemetry.messageId,
        });
      }
```

> `eventExtraDetail` 各字段为 `string`(见 `messageTelemetry.ts:634-650`),用 `Number()` 转回数值。`model_name`/`status` 已是 string。

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter @zcode/ui exec tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 4: 回归测试**

Run: `pnpm --filter @zcode/ui exec vitest run src/lib`
Expected: PASS(现有 messageTelemetry 等测试不受影响)。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/hooks/useZCodeChat.ts
git commit -m "feat(ui-perf): 镜像首token/消息耗时到 ARMS"
```

---

## Task 5: chunk 到达时追踪流式停顿

**Files:**
- Modify: `packages/ui/src/hooks/taskStreamEventHandlers.ts:12`(import 区附近)、`agent_message_chunk` case(~821)、`agent_thought_chunk` case(~927)

- [ ] **Step 1: 加 import**

在 `taskStreamEventHandlers.ts` 顶部 import 区(`recordPromptFirstToken` 所在的 `messageTelemetry` import 附近)新增:

```typescript
import { recordStreamChunkArrival } from "@/lib/uiPerfArmsTelemetry.js";
```

- [ ] **Step 2: 在 agent_message_chunk case 调用**

在 `taskStreamEventHandlers.ts` 的 `case "agent_message_chunk":` 块内、已有 `recordPromptFirstToken(taskId);`(行 ~865)旁,追加:

```typescript
        recordStreamChunkArrival(taskId, { waitingTool: false });
```

- [ ] **Step 3: 在 agent_thought_chunk case 调用**

在 `case "agent_thought_chunk":` 块(行 ~927)内,与 message_chunk 对称地追加同一行:

```typescript
        recordStreamChunkArrival(taskId, { waitingTool: false });
```

> 说明:正文/思考 chunk 到达即视为"流仍在推进"。`tool_call`/`tool_call_update` 期间没有正文 chunk 是预期行为;停顿事件的 `waiting_tool` 在本期固定为 `false`(纯 chunk 间隔),区分等工具的根因留待后续(spec 未来项)。本期先采到真实停顿分布。

- [ ] **Step 4: 类型检查**

Run: `pnpm --filter @zcode/ui exec tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/hooks/taskStreamEventHandlers.ts
git commit -m "feat(ui-perf): chunk 到达追踪流式停顿"
```

---

## Task 6: 终态清理停顿追踪状态

**Files:**
- Modify: `packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts`(import 区 + `handleTaskCompleteEvent`:110 / `handleTaskErrorEvent`:340)

- [ ] **Step 1: 加 import**

在 `taskStreamEventTerminalHandlers.ts` 顶部 import 区新增:

```typescript
import { clearStreamStallTracking } from "@/lib/uiPerfArmsTelemetry.js";
```

- [ ] **Step 2: 在 task_complete 清理**

在 `handleTaskCompleteEvent` 内,已有 `reportPromptCompletionTelemetry(taskId, "success", promptFinishedAt, event.usage);`(行 251)之后追加:

```typescript
  clearStreamStallTracking(taskId);
```

- [ ] **Step 3: 在 task_error 清理**

在 `handleTaskErrorEvent` 内,函数末尾(`reportPromptCompletionTelemetry(taskId, "fail", Date.now());` 行 469 之后)追加:

```typescript
  clearStreamStallTracking(taskId);
```

> `user_interrupt` 分支(行 420)与 `fail` 共在 `handleTaskErrorEvent` 内,行 469 的清理覆盖正常错误路径;若 `user_interrupt` 提前 return,则在其 `return` 前也追加同一行 `clearStreamStallTracking(taskId);`。实现时确认 420 是否 return:若 return,则在 420 后补一行。

- [ ] **Step 4: 类型检查 + 回归**

Run: `pnpm --filter @zcode/ui exec tsc --noEmit && pnpm --filter @zcode/ui exec vitest run src/lib src/hooks`
Expected: 无新增类型错误;测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/hooks/taskStreamEventTerminalHandlers.ts
git commit -m "feat(ui-perf): 消息终态清理流式停顿追踪"
```

---

## Task 7: 首屏耗时上报(main.tsx)

**Files:**
- Modify: `packages/desktop/src/renderer/src/main.tsx`(模块顶部 + 模块尾部监听)

- [ ] **Step 1: 模块顶部记起点**

在 `main.tsx` import 区之后、模块顶层(任何同步初始化之前)新增:

```typescript
import { reportUiFirstScreen } from "@zcode/ui";

// 首屏起点:renderer 模块加载早期。终点为 React commit 后派发的 "zcode-react-startup-ready"。
const uiFirstScreenStartedAt =
  typeof performance?.now === "function" ? performance.now() : Date.now();
```

> 确认 `reportUiFirstScreen` 已从 `@zcode/ui` 包导出。若未导出,在 `packages/ui/src/index.ts`(或对应 barrel)补 `export { reportUiFirstScreen } from "./lib/uiPerfArmsTelemetry.js";`。实现时先 grep `packages/ui/src/index.ts` 确认导出方式。

- [ ] **Step 2: 监听终点事件并上报**

在 `main.tsx` 模块顶层(`StartupReadyNotifier` 定义附近、模块加载即执行的位置)新增一次性监听:

```typescript
// 首屏终点:React commit 后由 StartupReadyNotifier 派发。一次性监听,reporter 此时已在 Root mount 注入。
window.addEventListener(
  "zcode-react-startup-ready",
  () => {
    const now = typeof performance?.now === "function" ? performance.now() : Date.now();
    reportUiFirstScreen(now - uiFirstScreenStartedAt);
  },
  { once: true },
);
```

- [ ] **Step 3: 确认导出 + 类型检查**

Run: `grep -n "uiPerfArmsTelemetry\|reportUiFirstScreen" packages/ui/src/index.ts`
若无输出,按 Step 1 注记补 barrel 导出。
Run: `pnpm --filter @zcode/desktop exec tsc --noEmit`
Expected: 无新增错误。

- [ ] **Step 4: 提交**

```bash
git add packages/ui/src/index.ts packages/desktop/src/renderer/src/main.tsx
git commit -m "feat(ui-perf): 上报首屏可交互耗时"
```

---

## Task 8: 更新监控文档

**Files:**
- Modify: `docs/monitoring/performance-monitoring.md`

- [ ] **Step 1: 新增 ui_perf 一节**

在 `performance-monitoring.md` 的 "P0 网络与通信指标" 之后、"ARMS 看板建议" 之前,插入:

```markdown
## P0 端侧 UI 性能指标

renderer(UI)侧埋点,经 `reportArmsCustomEvent` → IPC → `armsRum.sendCustom` 上报。事件 `group=ui_perf`,名称前缀 `perf_ui_`。全采(100%)。公共维度由 main IPC handler 自动补齐(`app_version` / `arms_env` / `device_mid` / `platform` / `renderer_id`)。

### 事件一览

| 事件 | `value` | 来源 | 关键 properties |
|------|---------|------|-----------------|
| `perf_ui_first_screen` | 首屏耗时 ms | renderer 模块加载 → `zcode-react-startup-ready`(React commit) | `phase`(可选) |
| `perf_ui_first_token` | 首 token 延迟 ms | 镜像 `message_completion` 的 `time_to_first_token` | `model` / `talk_id` / `message_id` |
| `perf_ui_message_complete` | 消息端到端耗时 ms | 镜像 `message_completion` 的 `duration_ms` | `result` / `talk_id` / `message_id` |
| `perf_ui_stream_stall` | 真实停顿时长 ms | 流式相邻正文 chunk 间隔 > 3000ms | `stall_ms` / `waiting_tool` / `talk_id` |

### 说明与边界

- **首 token / 消息耗时**:不新增计时,复用 `messageTelemetry.finalizePromptTelemetry()` 已算好的值,在 `useZCodeChat.reportPromptCompletionTelemetry` 镜像双发到 ARMS;`/report` 的 `message_completion` 链路与看板不受影响。
- **流式停顿**:`value` 为真实 chunk 间隔(非阈值),阈值 `STREAM_STALL_REPORT_THRESHOLD_MS=3000` 仅作上报闸门。chunk 间隔 >3s 的根因可能在上游(模型推理/网络),不一定是客户端渲染卡顿;但用户视角"界面长时间不动"可感知,故上报。后续据线上分布收紧阈值。
- **渲染卡顿(longTask)**:由 ARMS Browser SDK 自动采集(`browserCollectors.longTask`),不在此手动埋点。

常量(代码):`STREAM_STALL_REPORT_THRESHOLD_MS=3000`(`packages/ui/src/lib/uiPerfArmsTelemetry.ts`)。
```

- [ ] **Step 2: 实现索引追加**

在文末 "实现索引" 表格追加一行:

```markdown
| P0 端侧 UI 性能上报 | `packages/ui/src/lib/uiPerfArmsTelemetry.ts` |
```

- [ ] **Step 3: 提交**

```bash
git add docs/monitoring/performance-monitoring.md
git commit -m "docs: 监控文档新增端侧 UI 性能指标"
```

---

## Task 9: 全量验证

- [ ] **Step 1: 全包类型检查 + 测试**

Run: `pnpm --filter @zcode/ui exec tsc --noEmit && pnpm --filter @zcode/desktop exec tsc --noEmit && pnpm --filter @zcode/ui exec vitest run`
Expected: 无类型错误;全部测试 PASS。

- [ ] **Step 2: 本地构建验证(开发包,`arms_env=local`)**

参考 `docs/monitoring/performance-monitoring.md` 本地验证 checklist:
- 启动应用 → main 日志 `[arms] beforeReport` 出现 `custom:perf_ui_first_screen`。
- 发一条消息并完成 → 出现 `custom:perf_ui_first_token`、`custom:perf_ui_message_complete`。
- 用慢模型或断点制造 >3s chunk 间隔 → 出现 `custom:perf_ui_stream_stall`,value 为真实间隔。
- 回归:`/report` 的 `message_completion` 仍正常上报。

> 启动方式见用户记忆 `zcode-desktop-dev-startup.md`(pnpm 10.33.2 + ELECTRON_MIRROR 国内镜像)。

- [ ] **Step 3: 最终提交(若验证中有微调)**

```bash
git add -A
git commit -m "chore(ui-perf): 端侧 UI 性能上报本地验证收尾"
```

---

## Self-Review 检查结论

- **Spec 覆盖**:四个事件(first_screen/first_token/message_complete/stream_stall)分别对应 Task 7/4/4/5;封装 Task 1;注入 Task 3;清理 Task 6;文档 Task 8;全采无开关已落实(无采样代码);失败吞错在 `emit()` 实现。✅
- **占位符扫描**:无 TODO/TBD;每个改码步骤含完整代码。两处"实现时确认"(Task 6 user_interrupt return、Task 7 barrel 导出)是真实的代码事实核验点,已给出确认命令与兜底动作,非占位符。✅
- **类型一致**:`setUiPerfArmsReporter`/`reportUiFirstScreen`/`reportUiFirstToken`/`reportUiMessageComplete`/`recordStreamChunkArrival`/`clearStreamStallTracking`/`UI_PERF_ARMS_GROUP`/`STREAM_STALL_REPORT_THRESHOLD_MS` 全程命名一致。✅
