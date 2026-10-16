/**
 * driver 侧的工具活动面（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Amend-resume」）：
 *   - actor runtime 的 `ToolCallStarted` 会话事件里、解析后能力判为「会改写工作区」的那一条 → onMutating；
 *   - 每个 ask 至多一次；reset 之后重新武装；
 *   - 只读工具、别的会话、别的事件种类一律不算；
 *   - 两个计数（全部调用 / 碰过外部世界的调用）由这份订阅数出来，喂给 statsFromTurn。
 */

import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createSessionId,
  type SessionEvent,
  type SessionEventSink,
} from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import { createActorToolActivity } from "../src/app/workflow-driver-tool-activity.js";
import { deriveToolTarget, summarizeToolCall } from "../src/app/workflow-driver-tool-target.js";
import { statsFromTurn } from "../src/app/workflow-driver-helpers.js";

const SESSION = createSessionId("sess-actor");

function stubRuntime() {
  const sinks = new Set<SessionEventSink>();
  return {
    unsubscribeCalls: 0,
    subscribeEvents(sink: SessionEventSink) {
      sinks.add(sink);
      return () => {
        this.unsubscribeCalls++;
        sinks.delete(sink);
      };
    },
    emit(type: SessionEventType, payload: Record<string, unknown>, sessionId: string = SESSION) {
      const event = {
        id: "evt",
        sessionId,
        type,
        timestamp: new Date(),
        traceId: "trace",
        sequenceNumber: 1,
        payload,
      } as unknown as SessionEvent;
      for (const sink of sinks) void sink.onSessionEvent(event);
    },
  };
}

const started = (flags: Record<string, unknown>) => ({
  toolCallId: "tc",
  toolName: "Probe",
  startedAt: new Date(),
  ...flags,
});

describe("createActorToolActivity", () => {
  it("reports the first workspace write of an ask once, and again after reset", () => {
    const onMutating = vi.fn();
    const activity = createActorToolActivity({ onMutating });
    const runtime = stubRuntime();
    activity.observe(runtime as never, SESSION);

    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "Read", readOnly: true, sideEffectScope: "none" }),
    );
    expect(onMutating).not.toHaveBeenCalled();
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "Write", readOnly: false, sideEffectScope: "workspace" }),
    );
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "Edit", readOnly: false, sideEffectScope: "workspace" }),
    );
    expect(onMutating).toHaveBeenCalledTimes(1);

    activity.reset();
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "Bash", readOnly: false, sideEffectScope: "system" }),
    );
    expect(onMutating).toHaveBeenCalledTimes(2);
  });

  it("ignores other sessions, other event types, and tools that only touch the network or the session", () => {
    const onMutating = vi.fn();
    const activity = createActorToolActivity({ onMutating });
    const runtime = stubRuntime();
    activity.observe(runtime as never, SESSION);

    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ readOnly: false, sideEffectScope: "workspace" }),
      "sess-other",
    );
    runtime.emit(SessionEventType.ToolCallResult, {
      toolCallId: "tc",
      readOnly: false,
      sideEffectScope: "workspace",
    });
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "WebFetch", readOnly: false, sideEffectScope: "network" }),
    );
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "submit_result", readOnly: false, sideEffectScope: "session" }),
    );
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "escalate", readOnly: false, sideEffectScope: "session" }),
    );
    expect(onMutating).not.toHaveBeenCalled();
  });

  it("treats a call without flags as a write (conservative), and unsubscribes cleanly", () => {
    const onMutating = vi.fn();
    const activity = createActorToolActivity({ onMutating });
    const runtime = stubRuntime();
    activity.observe(runtime as never, SESSION);
    runtime.emit(SessionEventType.ToolCallStarted, started({}));
    expect(onMutating).toHaveBeenCalledTimes(1);
    activity.unsubscribe();
    expect(runtime.unsubscribeCalls).toBe(1);
    activity.reset();
    runtime.emit(SessionEventType.ToolCallStarted, started({}));
    expect(onMutating).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on a runtime without subscribeEvents", () => {
    const activity = createActorToolActivity({ onMutating: () => {} });
    expect(() => activity.observe({} as never, SESSION)).not.toThrow();
    expect(() => activity.unsubscribe()).not.toThrow();
  });
});

describe("statsFromTurn · 工具计数来自观察面，不是 TurnResult", () => {
  const result = (totalTokens: number, modelRequestCount: number) =>
    ({
      response: "done",
      usage: { totalTokens, modelRequestCount },
      events: [],
    }) as unknown as TurnResult;

  it("原样带上观察到的两个计数", () => {
    expect(statsFromTurn(result(42, 2), { toolCalls: 4, worldToolCalls: 2 })).toEqual({
      tokens: 42,
      toolCalls: 4,
      turns: 2,
      worldToolCalls: 2,
    });
  });

  it("只交了结果的 typed ask 是纯的：toolCalls 1（submit_result）而 worldToolCalls 0", () => {
    expect(statsFromTurn(result(7, 1), { toolCalls: 1, worldToolCalls: 0 })).toEqual({
      tokens: 7,
      toolCalls: 1,
      turns: 1,
      worldToolCalls: 0,
    });
  });

  it("计数不看 TurnResult.events —— 那里没有工具事件（本轮修的正是这个 0）", () => {
    const withToolEvents = {
      response: "done",
      usage: { totalTokens: 5, modelRequestCount: 1 },
      events: [
        {
          type: SessionEventType.ToolCallStarted,
          payload: started({ readOnly: false, sideEffectScope: "workspace" }),
        },
        {
          type: SessionEventType.ToolCallStarted,
          payload: started({ readOnly: true, sideEffectScope: "none" }),
        },
      ],
    } as unknown as TurnResult;
    expect(statsFromTurn(withToolEvents, { toolCalls: 0, worldToolCalls: 0 })).toMatchObject({
      toolCalls: 0,
      worldToolCalls: 0,
    });
  });
});

describe("观察面的计数（ask 内累加，startAsk 归零）", () => {
  it("数出总调用数与其中碰过外部世界的那些；协议工具不计入 world；reset 之后重新数", () => {
    const activity = createActorToolActivity({ onMutating: () => {} });
    const runtime = stubRuntime();
    activity.observe(runtime as never, SESSION);
    expect(activity.counts()).toEqual({ toolCalls: 0, worldToolCalls: 0 });

    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "Read", readOnly: true, sideEffectScope: "none" }),
    );
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "Write", readOnly: false, sideEffectScope: "workspace" }),
    );
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "Edit", readOnly: false, sideEffectScope: "workspace" }),
    );
    // 协议工具（交结果 / 提问）计入总数，但不算碰过外部世界——否则每条 typed ask 都不再是纯的。
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "submit_result", readOnly: false, sideEffectScope: "session" }),
    );
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "escalate", readOnly: false, sideEffectScope: "session" }),
    );
    // 别的会话不算。
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ readOnly: false, sideEffectScope: "workspace" }),
      "sess-other",
    );
    expect(activity.counts()).toEqual({ toolCalls: 5, worldToolCalls: 3 });

    activity.reset();
    expect(activity.counts()).toEqual({ toolCalls: 0, worldToolCalls: 0 });
    // Read 声明的范围是 none（无副作用），但它的答案取决于工作区 —— 算碰过。
    runtime.emit(
      SessionEventType.ToolCallStarted,
      started({ toolName: "Read", readOnly: true, sideEffectScope: "none" }),
    );
    expect(activity.counts()).toEqual({ toolCalls: 1, worldToolCalls: 1 });
  });
});

describe("lastTool · 最近一次真正开跑的工具调用", () => {
  const scheduled = (toolCallId: string, toolName: string, input: unknown) => ({
    toolCallId,
    assistantMessageId: "m1",
    toolName,
    input,
    schedule: { parallelGroups: [], executionOrder: [] },
  });
  const startedCall = (toolCallId: string, toolName: string) => ({
    toolCallId,
    toolName,
    startedAt: new Date(),
    readOnly: true,
    sideEffectScope: "none",
  });

  it("名字来自 started，目标来自更早的 scheduled 入参；后一次覆盖前一次", () => {
    const activity = createActorToolActivity({ onMutating: () => {} });
    const runtime = stubRuntime();
    activity.observe(runtime as never, SESSION);
    expect(activity.lastTool()).toBeUndefined();

    runtime.emit(
      SessionEventType.ToolCallScheduled,
      scheduled("tc-1", "Read", {
        file_path: "/repo/src/auth/session.ts",
      }),
    );
    runtime.emit(SessionEventType.ToolCallStarted, startedCall("tc-1", "Read"));
    expect(activity.lastTool()).toEqual({ name: "Read", target: "/repo/src/auth/session.ts" });

    runtime.emit(
      SessionEventType.ToolCallScheduled,
      scheduled("tc-2", "Bash", {
        command: "pnpm exec vitest run tests/auth.test.ts\n# 第二行不算",
      }),
    );
    runtime.emit(SessionEventType.ToolCallStarted, startedCall("tc-2", "Bash"));
    expect(activity.lastTool()).toEqual({
      name: "Bash",
      target: "pnpm exec vitest run tests/auth.test.ts",
    });
  });

  it("只在 started 上落：scheduled 之后被拒掉、从未开跑的调用不冒充当前动作", () => {
    const activity = createActorToolActivity({ onMutating: () => {} });
    const runtime = stubRuntime();
    activity.observe(runtime as never, SESSION);
    runtime.emit(
      SessionEventType.ToolCallScheduled,
      scheduled("tc-1", "Write", { file_path: "/x" }),
    );
    expect(activity.lastTool()).toBeUndefined();
  });

  it("没有 scheduled 那一手时仍给出名字，只是没有目标", () => {
    const activity = createActorToolActivity({ onMutating: () => {} });
    const runtime = stubRuntime();
    activity.observe(runtime as never, SESSION);
    runtime.emit(SessionEventType.ToolCallStarted, startedCall("tc-lonely", "Glob"));
    expect(activity.lastTool()).toEqual({ name: "Glob" });
  });

  it("别的会话不算；reset 之后重新从「没有」开始", () => {
    const activity = createActorToolActivity({ onMutating: () => {} });
    const runtime = stubRuntime();
    activity.observe(runtime as never, SESSION);
    runtime.emit(
      SessionEventType.ToolCallScheduled,
      scheduled("tc-other", "Read", { file_path: "/other" }),
      "sess-other",
    );
    runtime.emit(SessionEventType.ToolCallStarted, startedCall("tc-other", "Read"), "sess-other");
    expect(activity.lastTool()).toBeUndefined();

    runtime.emit(
      SessionEventType.ToolCallScheduled,
      scheduled("tc-1", "Read", { file_path: "/mine" }),
    );
    runtime.emit(SessionEventType.ToolCallStarted, startedCall("tc-1", "Read"));
    expect(activity.lastTool()).toEqual({ name: "Read", target: "/mine" });
    activity.reset();
    expect(activity.lastTool()).toBeUndefined();
  });
});

describe("目标线索的分寸（deriveToolTarget / summarizeToolCall）", () => {
  it("按键名认，不按工具名认：file_path > path > command > pattern > url > query", () => {
    expect(deriveToolTarget({ file_path: "/a.ts", command: "rm -rf /" })).toBe("/a.ts");
    expect(deriveToolTarget({ path: "src", pattern: "TODO" })).toBe("src");
    expect(deriveToolTarget({ pattern: "TODO", url: "https://x" })).toBe("TODO");
    expect(deriveToolTarget({ url: "https://example.com/a" })).toBe("https://example.com/a");
    expect(deriveToolTarget({ query: "release notes" })).toBe("release notes");
  });

  it("认不出就缺席：没有已知键、值不是字符串、空串、不是对象", () => {
    expect(deriveToolTarget({ todos: [{ content: "x" }] })).toBeUndefined();
    expect(deriveToolTarget({ file_path: 42 })).toBeUndefined();
    expect(deriveToolTarget({ command: "   " })).toBeUndefined();
    expect(deriveToolTarget("/a.ts")).toBeUndefined();
    expect(deriveToolTarget(undefined)).toBeUndefined();
    expect(deriveToolTarget(["/a.ts"])).toBeUndefined();
  });

  it("命令只取第一行并压掉连续空白（整段 heredoc 不是「在跑什么」）", () => {
    expect(deriveToolTarget({ command: "  git   log --oneline  \nwhile read x; do :; done" })).toBe(
      "git log --oneline",
    );
  });

  it("超长路径保尾（文件名才是分辨点），超长命令保头", () => {
    const deepPath = `/${"segment/".repeat(40)}session.ts`;
    const pathTarget = deriveToolTarget({ file_path: deepPath })!;
    expect(pathTarget.length).toBe(120);
    expect(pathTarget.startsWith("…")).toBe(true);
    expect(pathTarget.endsWith("session.ts")).toBe(true);

    const longCommand = `echo ${"a".repeat(300)}`;
    const commandTarget = deriveToolTarget({ command: longCommand })!;
    expect(commandTarget.length).toBe(120);
    expect(commandTarget.startsWith("echo a")).toBe(true);
  });

  it("没有名字就整条缺席；名字超长截到 64", () => {
    expect(summarizeToolCall({ input: { file_path: "/a.ts" } })).toBeUndefined();
    expect(summarizeToolCall({ toolName: "   " })).toBeUndefined();
    expect(summarizeToolCall({ toolName: "T".repeat(100) })?.name).toHaveLength(64);
  });
});
