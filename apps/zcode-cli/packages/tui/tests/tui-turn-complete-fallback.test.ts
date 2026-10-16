import assert from "node:assert/strict";
import test from "node:test";
import type React from "react";
import { applyTurnCompleteFallbackResponse } from "../src/app-turn-complete.js";
import { appendAgentResult } from "../src/app-submit.js";
import type { Message } from "../src/app-model.js";

// turn_complete 的 response 兜底：通知驱动的回合没有 applyResult，流式又可能一个字都没画
// （只有工具调用、或流中途断掉）。这组测试钉住兜底的三条性质：该补时补、已画过不补、
// 以及与 appendAgentResult 的守卫对称——同一段回答绝不出现两次。

function dispatch(current: Message[], payload: Record<string, unknown>): Message[] {
  let next = current;
  const setMessages: React.Dispatch<React.SetStateAction<Message[]>> = (update) => {
    next = typeof update === "function" ? (update as (m: Message[]) => Message[])(next) : update;
  };
  applyTurnCompleteFallbackResponse(payload, setMessages);
  return next;
}

test("appends the authoritative response when nothing was streamed (tool-only turn)", () => {
  const result = dispatch([], { response: "Workflow settled: 3 findings." });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.role, "agent");
  assert.equal(result[0]?.content, "Workflow settled: 3 findings.");
});

test("does not append when the streamed transcript already carries the response", () => {
  const streamed: Message = {
    content: "Workflow settled: 3 findings.",
    role: "agent",
    streamProjected: true,
  };
  const result = dispatch([streamed], { response: "Workflow settled: 3 findings." });
  assert.equal(result.length, 1);
});

test("empty or missing response is a no-op", () => {
  assert.equal(dispatch([], { response: "" }).length, 0);
  assert.equal(dispatch([], { response: "   " }).length, 0);
  assert.equal(dispatch([], {}).length, 0);
});

test("re-delivery of the same response is idempotent", () => {
  const once = dispatch([], { response: "same answer" });
  const twice = dispatch(once, { response: "same answer" });
  assert.equal(twice.length, 1);
});

test("regression: fallback then applyResult must not duplicate the answer", () => {
  // 用户回合里流断掉的场景：turn_complete 先到（兜底补上），随后 submitPrompt 结算、
  // appendAgentResult 再跑。守卫只扫 streamProjected 消息，所以兜底消息必须自带该标记，
  // 否则这里会出现同一段回答的第二份。
  const afterFallback = dispatch([], { response: "the one answer" });
  const afterResult = appendAgentResult(afterFallback, { response: "the one answer" });
  const occurrences = afterResult.filter((m) => m.content === "the one answer");
  assert.equal(occurrences.length, 1);
});
