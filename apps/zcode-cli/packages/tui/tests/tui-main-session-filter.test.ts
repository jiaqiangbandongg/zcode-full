// 主会话闸门（WP-F，user directive 2026-08-23）。
//
// actor / 子会话的原始事件会经 notifyExternalChildSessionEvent 投进**父 runtime 的同一个
// 外部 sink 集**，并保留子自己的 sessionId。TUI 的常驻订阅与 per-turn onEvent 都挂在那个集合上，
// 所以不过滤就会把 actor 的流式增量、工具调用、submit_result、turn_complete 画进主转写。
//
// 同时必须证明**没有过滤过头**：dwf 进度是父会话事件，工具卡与结算完成回合要照常活着。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, createSessionEvent, type SessionEvent } from "@zcode/contracts";
import { isMainSessionEvent } from "../src/app-session-event-handler.js";

const MAIN = "session-main";
const ACTOR = "session-actor-1";

function eventFrom(sessionId: string, type: SessionEventType = SessionEventType.AssistantMessage) {
  return { ...createSessionEvent(type, sessionId as never, {}), sessionId } as SessionEvent;
}

test("main-session events pass the gate", () => {
  assert.equal(isMainSessionEvent(eventFrom(MAIN), MAIN), true);
});

test("actor/child-session events are dropped", () => {
  assert.equal(isMainSessionEvent(eventFrom(ACTOR), MAIN), false);
});

test("every noisy actor event kind is dropped, not just some", () => {
  // 用户看到的噪音就是这几类：流式增量、工具调用（submit_result 走 tool_call_*）、回合终结。
  for (const type of [
    SessionEventType.ModelStreaming,
    SessionEventType.AssistantMessage,
    SessionEventType.ToolCallScheduled,
    SessionEventType.ToolCallResult,
    SessionEventType.ToolCallError,
    SessionEventType.TurnStarted,
    SessionEventType.TurnComplete,
  ]) {
    assert.equal(isMainSessionEvent(eventFrom(ACTOR, type), MAIN), false, `${type} leaked`);
    assert.equal(isMainSessionEvent(eventFrom(MAIN, type), MAIN), true, `${type} wrongly dropped`);
  }
});

test("dwf progress from the parent session survives the gate (the card must keep working)", () => {
  // 进度事件追加在**父会话**（session.events.ts:134）。过滤过头就会把工具卡变回死的文本投影。
  const progress = eventFrom(MAIN, SessionEventType.DynamicWorkflowRunProgress);
  assert.equal(isMainSessionEvent(progress, MAIN), true);
});

test("an unknown main session id fails open rather than blanking the transcript", () => {
  // 拿不到 id 的窗口（app 尚未建好）宁可多渲染，也不要让转写整片空白。
  assert.equal(isMainSessionEvent(eventFrom(ACTOR), undefined), true);
  assert.equal(isMainSessionEvent(eventFrom(MAIN), ""), true);
});

test("an event with no sessionId fails open", () => {
  const anonymous = { ...eventFrom(MAIN), sessionId: undefined } as unknown as SessionEvent;
  assert.equal(isMainSessionEvent(anonymous, MAIN), true);
});

test("the gate follows the session across a swap rather than pinning the first id", () => {
  // /new /resume /fork 之后主会话换了；闸门读的是当时的 id，所以新会话的事件照常通过，
  // 而旧会话的事件（可能还有在飞的尾巴）被判为外来。
  const afterSwap = "session-main-2";
  assert.equal(isMainSessionEvent(eventFrom(afterSwap), afterSwap), true);
  assert.equal(isMainSessionEvent(eventFrom(MAIN), afterSwap), false);
});
