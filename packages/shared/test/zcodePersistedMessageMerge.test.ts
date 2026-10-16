import { describe, expect, it } from "vitest";
import {
  coalesceConsecutiveZCodeAssistants,
  type ZCodePersistedMessage,
} from "../src/index.js";

function userMessage(
  overrides: Partial<ZCodePersistedMessage> = {},
): ZCodePersistedMessage {
  return {
    role: "user",
    content: "hello",
    timestamp: 1_000,
    ...overrides,
  };
}

function assistantMessage(
  overrides: Partial<ZCodePersistedMessage> = {},
): ZCodePersistedMessage {
  return {
    role: "assistant",
    content: "ok",
    timestamp: 2_000,
    durationMs: 500,
    ...overrides,
  };
}

describe("coalesceConsecutiveZCodeAssistants", () => {
  it("leaves a single user/assistant pair untouched (apart from turnIndex)", () => {
    const input = [userMessage(), assistantMessage()];
    const result = coalesceConsecutiveZCodeAssistants(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: "user", turnIndex: 0 });
    expect(result[1]).toMatchObject({
      role: "assistant",
      durationMs: 500,
      turnIndex: 0,
    });
  });

  it("merges two consecutive assistants into one with summed-span duration", () => {
    const first = assistantMessage({
      timestamp: 2_000,
      durationMs: 1_000,
      content: "round1 ",
      thought: "thinking1 ",
      tools: [{ toolName: "Bash", input: { command: "ls" } }],
      parts: [
        { type: "content", content: "round1 " },
        { type: "tool-call", toolIndex: 0 },
      ],
    });
    const next = assistantMessage({
      timestamp: 4_000, // 1s gap simulating tool execution between rounds
      durationMs: 2_000,
      content: "round2",
      thought: "thinking2",
      tools: [{ toolName: "Read", input: { path: "/x" } }],
      parts: [
        { type: "content", content: "round2" },
        { type: "tool-call", toolIndex: 0 },
      ],
    });

    const result = coalesceConsecutiveZCodeAssistants([
      userMessage(),
      first,
      next,
    ]);

    expect(result).toHaveLength(2);
    const merged = result[1]!;
    expect(merged.role).toBe("assistant");
    expect(merged.timestamp).toBe(2_000);
    // 整轮跨度 = next 结束时刻 (4000 + 2000) − first 起点 (2000)
    expect(merged.durationMs).toBe(4_000);
    expect(merged.content).toBe("round1 round2");
    expect(merged.thought).toBe("thinking1 thinking2");
    expect(merged.tools).toEqual([
      { toolName: "Bash", input: { command: "ls" } },
      { toolName: "Read", input: { path: "/x" } },
    ]);
    expect(merged.parts).toEqual([
      { type: "content", content: "round1 " },
      { type: "tool-call", toolIndex: 0 },
      { type: "content", content: "round2" },
      { type: "tool-call", toolIndex: 1 }, // shifted from 0 by firstTools.length
    ]);
    expect(merged.turnIndex).toBe(0);
  });

  it("keeps original assistant message ids when merging consecutive assistants", () => {
    const result = coalesceConsecutiveZCodeAssistants([
      userMessage(),
      assistantMessage({ id: "msg_assistant_1", content: "round1 " }),
      assistantMessage({ id: "msg_assistant_2", content: "round2" }),
    ]);

    expect(result[1]).toMatchObject({
      id: "msg_assistant_1",
      mergedMessageIds: ["msg_assistant_1", "msg_assistant_2"],
    });
  });

  it("merges three consecutive assistants (covers the 1s/1s/2s screenshot case)", () => {
    const result = coalesceConsecutiveZCodeAssistants([
      userMessage({ timestamp: 0 }),
      assistantMessage({ timestamp: 100, durationMs: 1_000, content: "a" }),
      assistantMessage({ timestamp: 1_100, durationMs: 1_000, content: "b" }),
      assistantMessage({ timestamp: 2_100, durationMs: 2_000, content: "c" }),
    ]);
    expect(result).toHaveLength(2);
    const merged = result[1]!;
    expect(merged.content).toBe("abc");
    expect(merged.timestamp).toBe(100);
    expect(merged.durationMs).toBe(4_000); // 2100+2000 − 100
  });

  it("returns undefined duration when any round is still in progress", () => {
    const result = coalesceConsecutiveZCodeAssistants([
      userMessage(),
      assistantMessage({ timestamp: 2_000, durationMs: 500 }),
      assistantMessage({ timestamp: 2_500, durationMs: undefined }),
    ]);
    expect(result[1]!.durationMs).toBeUndefined();
  });

  it("does not merge synthetic timeline assistants into surrounding assistant content", () => {
    const compact = assistantMessage({
      id: "msg_compact",
      content: "",
      timestamp: 4_000,
      durationMs: 2_000,
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "context_compaction",
        operationId: "cmp-1",
        status: "completed",
        trigger: "manual",
        display: "separator",
      },
    });

    const result = coalesceConsecutiveZCodeAssistants([
      userMessage({ timestamp: 1_000 }),
      assistantMessage({
        id: "msg_assistant",
        timestamp: 2_000,
        durationMs: 500,
        content: "hello",
      }),
      compact,
      assistantMessage({
        id: "msg_skipped",
        content: "",
        timestamp: 8_000,
        durationMs: 0,
        syntheticTimeline: {
          version: 1,
          kind: "synthetic",
          type: "context_compaction",
          operationId: "cmp-2",
          status: "skipped",
          trigger: "manual",
          display: "separator",
        },
      }),
    ]);

    expect(result).toHaveLength(4);
    expect(result[1]).toMatchObject({
      id: "msg_assistant",
      durationMs: 500,
    });
    expect(result[2]).toMatchObject({
      id: "msg_compact",
      syntheticTimeline: { operationId: "cmp-1" },
    });
    expect(result[3]).toMatchObject({
      id: "msg_skipped",
      syntheticTimeline: { operationId: "cmp-2" },
    });
  });

  it("is a no-op on strictly alternating legacy ZCode Agent data", () => {
    const input = [
      userMessage({ timestamp: 0, turnIndex: 0 }),
      assistantMessage({
        timestamp: 100,
        durationMs: 1_000,
        turnIndex: 0,
        content: "a",
      }),
      userMessage({ timestamp: 2_000, turnIndex: 1, content: "hi again" }),
      assistantMessage({
        timestamp: 2_100,
        durationMs: 500,
        turnIndex: 1,
        content: "b",
      }),
    ];
    const result = coalesceConsecutiveZCodeAssistants(input);
    expect(result).toHaveLength(4);
    expect(
      result.map((m) => ({ role: m.role, turnIndex: m.turnIndex })),
    ).toEqual([
      { role: "user", turnIndex: 0 },
      { role: "assistant", turnIndex: 0 },
      { role: "user", turnIndex: 1 },
      { role: "assistant", turnIndex: 1 },
    ]);
  });

  it("assigns turnIndex by counting user messages across merged sequence", () => {
    const result = coalesceConsecutiveZCodeAssistants([
      userMessage({ timestamp: 0, content: "u0" }),
      assistantMessage({ timestamp: 1, durationMs: 1 }),
      assistantMessage({ timestamp: 2, durationMs: 1 }),
      userMessage({ timestamp: 10, content: "u1" }),
      assistantMessage({ timestamp: 11, durationMs: 1 }),
    ]);
    expect(result.map((m) => m.turnIndex)).toEqual([0, 0, 1, 1]);
  });

  it("propagates next's interrupted / feedback / model to the merged message", () => {
    const result = coalesceConsecutiveZCodeAssistants([
      userMessage(),
      assistantMessage({ model: "m1", durationMs: 500, content: "a" }),
      assistantMessage({
        timestamp: 2_500,
        durationMs: 500,
        model: "m2",
        content: "b",
        interrupted: true,
        feedback: "like",
      }),
    ]);
    const merged = result[1]!;
    expect(merged.model).toBe("m2");
    expect(merged.interrupted).toBe(true);
    expect(merged.feedback).toBe("like");
  });

  it("recomputes characterCount only when at least one round tracked it", () => {
    const withCount = coalesceConsecutiveZCodeAssistants([
      userMessage(),
      assistantMessage({ content: "hello", characterCount: 5 }),
      assistantMessage({ timestamp: 2_500, durationMs: 500, content: "!" }),
    ]);
    expect(withCount[1]!.characterCount).toBe("hello!".length);

    const withoutCount = coalesceConsecutiveZCodeAssistants([
      userMessage(),
      assistantMessage({ content: "hello" }),
      assistantMessage({ timestamp: 2_500, durationMs: 500, content: "!" }),
    ]);
    expect(withoutCount[1]!.characterCount).toBeUndefined();
  });
});
