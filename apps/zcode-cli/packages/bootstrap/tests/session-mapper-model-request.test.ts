// RET-012：内存 store 淘汰 sealed turn 时把 model_request 瘦身为 messageCount，映射结果必须与完整 payload 一致。
import { describe, expect, it } from "vitest";
import { SessionEventType, createSessionEvent, type SessionId } from "@zcode/contracts";
import { mapSessionEvent } from "../src/zcode-protocol/session-mapper.js";

const sessionId = "session_mapper_model_request" as SessionId;

describe("session-mapper model_request", () => {
  it("RET-012 瘦身 payload 与完整 payload 映射出相同的 messageCount", () => {
    const full = createSessionEvent(SessionEventType.ModelRequest, sessionId, {
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      providerId: "p",
      modelId: "m",
      toolCount: 2,
    });
    const slim = createSessionEvent(SessionEventType.ModelRequest, sessionId, {
      messageCount: 3,
      providerId: "p",
      modelId: "m",
      toolCount: 2,
    });
    expect(mapSessionEvent(slim).payload).toEqual(mapSessionEvent(full).payload);
    expect(mapSessionEvent(slim).payload).toMatchObject({ messageCount: 3 });
  });
});
