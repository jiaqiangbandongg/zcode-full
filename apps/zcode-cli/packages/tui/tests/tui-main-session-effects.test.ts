// WP-F 效果级回归：actor/子会话的原始事件绝不进主转写（user directive 2026-08-23）。
//
// 与 tui-main-session-filter.test.ts 的分工：那个文件钉谓词，这个文件钉**流水线的效果**
// （闸门 → 去重 → applySessionEventToState）。有些回归只在效果层面看得见——尤其是
// actor 的 turn_complete 会不会经 applyTurnCompleteFallbackResponse 把 actor 的答案
// 追加成主转写里的一条 agent 消息。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, createSessionEvent, type SessionEvent } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import { applyMainSessionEvent } from "../src/app-session-event-handler.js";
import type { Message } from "../src/app-model.js";
import { EMPTY_TUI_WORKFLOW_MIRROR, type TuiWorkflowMirror } from "../src/app-workflow-mirror.js";

const COPY = getZCodeCopy("en-US").tui;
const MAIN = "session-main";
const ACTOR = "session-actor-1";

/**
 * 收集所有可观察副作用，用来断言「什么都没发生」。
 *
 * 接的是 **getter** 而不是 id：显式传 `undefined` 会重新触发默认参数替换，
 * 于是「主会话 id 未知」这个用例其实还在按 MAIN 过滤——踩过一次，这里钉住。
 */
function harness(getMainSessionId: () => string | undefined = () => MAIN) {
  const state = {
    messages: [] as Message[],
    statuses: [] as string[],
    lastEvents: [] as string[],
    mirror: EMPTY_TUI_WORKFLOW_MIRROR as TuiWorkflowMirror,
  };
  const applied = new Set<string>();
  const input = {
    copy: COPY,
    getMainSessionId,
    setActiveTurnId: () => {},
    setCacheStats: () => {},
    setContextUsage: () => {},
    setLastError: () => {},
    setLastEvent: (value: string) => state.lastEvents.push(value),
    setLiveModelText: () => {},
    setMessages: (update: unknown) => {
      state.messages =
        typeof update === "function"
          ? (update as (current: Message[]) => Message[])(state.messages)
          : (update as Message[]);
    },
    setModel: () => {},
    setNetworkRequests: () => {},
    setStatus: (value: string) => state.statuses.push(value),
    setTodos: () => {},
    setUsage: () => {},
    setWorkflowMirror: (update: unknown) => {
      state.mirror =
        typeof update === "function"
          ? (update as (current: TuiWorkflowMirror) => TuiWorkflowMirror)(state.mirror)
          : (update as TuiWorkflowMirror);
    },
    assistantMessageIdsByToolCallId: new Map<string, string>(),
    toolNamesById: new Map<string, string>(),
  } as unknown as Parameters<typeof applyMainSessionEvent>[2];

  return {
    state,
    apply: (event: SessionEvent) => applyMainSessionEvent(event, applied, input),
  };
}

function event(sessionId: string, type: SessionEventType, payload: unknown = {}): SessionEvent {
  return { ...createSessionEvent(type, sessionId as never, payload), sessionId } as SessionEvent;
}

// ── 载荷最重的一条：actor 的 turn_complete 绝不经兜底写进主转写 ──

test("an actor turn_complete never appends its answer through the fallback", () => {
  const h = harness();
  const applied = h.apply(
    event(ACTOR, SessionEventType.TurnComplete, { response: "actor internal answer" }),
  );
  assert.equal(applied, false);
  // 这条是整个 WP-F 里最要命的：兜底会把任意 turn_complete.response 追加成 agent 消息，
  // 所以没有闸门的话 actor 的中间答案会原文出现在主转写里。
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(h.state.statuses, []);
});

test("a main-session turn_complete still appends through the fallback", () => {
  const h = harness();
  assert.equal(
    h.apply(event(MAIN, SessionEventType.TurnComplete, { response: "the real answer" })),
    true,
  );
  assert.equal(h.state.messages.length, 1);
  assert.equal(h.state.messages[0]?.content, "the real answer");
});

// ── actor 的其余噪音：不产生任何转写 part、不改状态行 ──

test("actor submit_result / tool_call_* create no transcript parts and no status changes", () => {
  const h = harness();
  const toolEvents: readonly [SessionEventType, unknown][] = [
    [
      SessionEventType.ToolCallScheduled,
      { toolCallId: "tc-a", toolName: "submit_result", input: {} },
    ],
    [SessionEventType.ToolCallStarted, { toolCallId: "tc-a", toolName: "submit_result" }],
    [
      SessionEventType.ToolCallResult,
      { toolCallId: "tc-a", toolName: "submit_result", result: { content: "ok" } },
    ],
    [SessionEventType.ToolCallError, { toolCallId: "tc-a", toolName: "submit_result" }],
  ];
  for (const [type, payload] of toolEvents) {
    assert.equal(h.apply(event(ACTOR, type, payload)), false, `${type} passed the gate`);
  }
  assert.deepEqual(h.state.messages, []);
  assert.deepEqual(h.state.statuses, []);
  assert.deepEqual(h.state.lastEvents, []);
});

test("actor model_streaming and assistant_message never reach the transcript", () => {
  const h = harness();
  h.apply(event(ACTOR, SessionEventType.ModelStreaming, { delta: "half a thought" }));
  h.apply(event(ACTOR, SessionEventType.AssistantMessage, { content: "actor prose" }));
  assert.deepEqual(h.state.messages, []);
});

test("actor turn lifecycle events do not touch the main status line", () => {
  const h = harness();
  h.apply(event(ACTOR, SessionEventType.TurnStarted, {}));
  h.apply(event(ACTOR, SessionEventType.ModelRequest, {}));
  assert.deepEqual(h.state.statuses, []);
});

// ── 没有过滤过头：三个必须活着的表面 ──

test("dwf progress on the parent session still reduces into the mirror", () => {
  const h = harness();
  const applied = h.apply(
    event(MAIN, SessionEventType.DynamicWorkflowRunProgress, {
      runId: "dwfrun-1",
      toolCallId: "tc-1",
      sequence: 0,
      eventType: "run-started",
      payload: { caps: { maxConcurrency: 4 } },
    }),
  );
  assert.equal(applied, true);
  // 卡片的生命线：闸门收得太紧就会把工具卡打回死的文本投影。
  assert.equal(h.state.mirror.state.runs[0]?.runId, "dwfrun-1");
  assert.equal(h.state.mirror.state.runs[0]?.status, "running");
});

test("a mirrored subagent tool event still renders (it carries the parent sessionId)", () => {
  // mirrorSubagentToolEvent 用 createSessionEvent(type, parentSessionId, ...) 铸造，
  // 所以 Agent 工具的渲染不受 WP-F 影响。
  const h = harness();
  const applied = h.apply(
    event(MAIN, SessionEventType.ToolCallScheduled, {
      toolCallId: "tc-agent",
      toolName: "Agent",
      input: { description: "explore" },
    }),
  );
  assert.equal(applied, true);
  assert.equal(h.state.messages.length, 1);
});

test("the actor gate does not depend on event kind — only on session", () => {
  // 同一种事件，父会话过、子会话不过。闸门是会话级的，不是按类型拉黑名单。
  const h = harness();
  assert.equal(h.apply(event(MAIN, SessionEventType.AssistantMessage, { content: "main" })), true);
  assert.equal(
    h.apply(event(ACTOR, SessionEventType.AssistantMessage, { content: "actor" })),
    false,
  );
  assert.deepEqual(
    h.state.messages.map((message) => message.content),
    ["main"],
  );
});

// ── 闸门与去重的组合 ──

test("the gate runs before dedup, so actor events never consume dedup slots", () => {
  const h = harness();
  const actorEvent = event(ACTOR, SessionEventType.AssistantMessage, { content: "noise" });
  h.apply(actorEvent);
  h.apply(actorEvent);
  // 主会话事件仍照常去重（第一条应用、第二条丢弃），证明窗口没被 actor 事件搅乱。
  const mainEvent = event(MAIN, SessionEventType.AssistantMessage, { content: "signal" });
  assert.equal(h.apply(mainEvent), true);
  assert.equal(h.apply(mainEvent), false);
  assert.deepEqual(
    h.state.messages.map((message) => message.content),
    ["signal"],
  );
});

test("an unknown main session id fails open so the transcript is never blank", () => {
  const h = harness(() => undefined);
  assert.equal(h.apply(event(ACTOR, SessionEventType.AssistantMessage, { content: "x" })), true);
});
