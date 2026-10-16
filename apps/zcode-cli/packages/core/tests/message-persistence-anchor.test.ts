// v4 transcript 锚点写入测试（M2，docs/v4-refactor/07-persistence「无迁移」清单）：
// persistUserPrompt / persistAssistantMessage / persistSyntheticUserNoticeForSession
// 必须把 traceContext.turnId 与 v4 origin 词表落进 message.anchor（additive JSON）。
import { describe, expect, it } from "vitest";
import type { MessageInfo, TraceContext } from "@zcode/contracts";
import { createMessageId, createTraceId, createTurnId } from "@zcode/contracts";
import {
  persistAssistantMessage,
  persistSyntheticUserNoticeForSession,
  persistUserPrompt,
} from "../src/runtime/methods/message-persistence.js";

function createHarness() {
  const saved: MessageInfo[] = [];
  const fakeRuntime = {
    latestConversationMessageId: null as string | null,
    latestAssistantMessageId: null as string | null,
    latestAssistantTurnId: null as string | null,
    sessionId: "session-anchor",
    sessionStore: {},
    workingDirectory: "/tmp/w",
    workspaceRoot: "/tmp/w",
    config: { systemPrompt: "sys", envInfo: undefined },
    getSessionModelSelection: () => ({
      providerId: "prov",
      modelId: "model",
      options: { reasoningLevel: "high" },
    }),
    getTools: () => [],
    async persistMessage(input: MessageInfo) {
      saved.push(input);
    },
    async persistPart() {},
    logger: undefined,
  };
  return { saved, fakeRuntime };
}

function trace(turnId?: ReturnType<typeof createTurnId>): TraceContext {
  return { traceId: createTraceId(), turnId };
}

describe("v4 transcript 锚点（additive JSON）", () => {
  it("persistUserPrompt：anchor 带 turnId + origin=realUser", async () => {
    const { saved, fakeRuntime } = createHarness();
    const turnId = createTurnId();
    await persistUserPrompt.call(
      fakeRuntime as never,
      createMessageId(),
      "hello",
      undefined,
      trace(turnId),
    );
    expect(saved[0]?.role).toBe("user");
    expect(saved[0]?.anchor).toEqual({ turnId, origin: "realUser" });
  });

  it("persistUserPrompt：epilogueStart 落进 metadata；缺席时不写", async () => {
    const { saved, fakeRuntime } = createHarness();
    await persistUserPrompt.call(
      fakeRuntime as never,
      createMessageId(),
      "ask text\n\n---\nStandard for this result:",
      undefined,
      trace(createTurnId()),
      { epilogueStart: 8 },
    );
    expect(saved[0]?.metadata?.epilogueStart).toBe(8);

    await persistUserPrompt.call(
      fakeRuntime as never,
      createMessageId(),
      "plain",
      undefined,
      trace(createTurnId()),
    );
    expect(saved[1]?.metadata?.epilogueStart).toBeUndefined();
  });

  it("persistAssistantMessage：anchor 带 turnId；无 turnId 时不写空对象", async () => {
    const { saved, fakeRuntime } = createHarness();
    const turnId = createTurnId();
    const parentId = createMessageId();
    await persistAssistantMessage.call(
      fakeRuntime as never,
      createMessageId(),
      parentId,
      Date.now(),
      undefined,
      trace(turnId),
    );
    expect(saved[0]?.anchor).toEqual({ turnId, origin: undefined });
    expect(saved[0]).toMatchObject({ providerId: "prov", modelId: "model" });
    expect(saved[0]).not.toHaveProperty("variant");

    await persistAssistantMessage.call(
      fakeRuntime as never,
      createMessageId(),
      parentId,
      Date.now(),
      undefined,
      trace(),
    );
    expect(saved[1]?.anchor).toBeUndefined();
  });

  it("synthetic notice：旧 source 映射到 v4 origin 词表", async () => {
    const cases = [
      { source: "background_task", origin: "backgroundResult" },
      { source: "subagent", origin: "backgroundResult" },
      { source: "goal-continuation", origin: "goalContinuation" },
      { source: "fork", origin: "synthetic" },
      { source: "rewind", origin: "synthetic" },
    ] as const;
    for (const { source, origin } of cases) {
      const { saved, fakeRuntime } = createHarness();
      const turnId = createTurnId();
      await persistSyntheticUserNoticeForSession.call(fakeRuntime as never, {
        messageID: createMessageId(),
        sessionId: "session-anchor",
        source,
        text: "notice",
        traceContext: trace(turnId),
      });
      expect(saved[0]?.anchor).toEqual({ turnId, origin });
    }
  });

  it("synthetic notice：fork 默认写成 model-only provider context", async () => {
    const { saved, fakeRuntime } = createHarness();
    await persistSyntheticUserNoticeForSession.call(fakeRuntime as never, {
      messageID: createMessageId(),
      sessionId: "session-anchor",
      source: "fork",
      text: "fork notice",
      traceContext: trace(createTurnId()),
    });

    expect(saved[0]).toMatchObject({
      role: "user",
      source: "fork",
      synthetic: true,
      visibility: "model-only",
      semantics: {
        kind: "fork_notice",
        origin: "agent_runtime",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
        uiVisibility: "hidden",
      },
    });
  });
});
