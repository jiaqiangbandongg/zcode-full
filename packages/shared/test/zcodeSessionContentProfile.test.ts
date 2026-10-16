import { describe, expect, it } from "vitest";
import {
  deriveZCodeTaskStatusFromSessionSnapshot,
  elideSessionSnapshotForIndex,
  getConversationMessageProjectionPolicy,
  getZCodeUserVisibleMessages,
  resolveZCodeVisibleSessionTitle,
  zcodeMessageWithPartsSchema,
  zcodeSessionReadParamsSchema,
  type ZCodeMessageWithParts,
  type ZCodeSessionStateSnapshot,
} from "../src/index.js";

const SESSION_ID = "sess_idx";
const model = { providerId: "glm", modelId: "glm-4.6" };
const BIG = "x".repeat(2 * 1024 * 1024);

function user(
  messageId: string,
  created: number,
  parts: ZCodeMessageWithParts["parts"],
  patch: Record<string, unknown> = {},
): ZCodeMessageWithParts {
  return {
    info: {
      messageId,
      sessionId: SESSION_ID,
      role: "user",
      time: { created },
      agent: "build",
      model,
      ...patch,
    },
    parts,
  } as ZCodeMessageWithParts;
}

function assistant(
  messageId: string,
  created: number,
  parts: ZCodeMessageWithParts["parts"],
  patch: Record<string, unknown> = {},
): ZCodeMessageWithParts {
  return {
    info: {
      messageId,
      sessionId: SESSION_ID,
      role: "assistant",
      time: { created, completed: created + 1 },
      parentMessageId: "m_u1",
      agent: "build",
      model,
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      ...patch,
    },
    parts,
  } as ZCodeMessageWithParts;
}

function base(messageId: string, partId: string) {
  return { partId, sessionId: SESSION_ID, messageId };
}

/** 覆盖 task index 所有判定分支会看的 part 类型与 metadata 形态。 */
function fixtureMessages(): ZCodeMessageWithParts[] {
  return [
    user("m_u1", 10, [
      { ...base("m_u1", "p1"), type: "text", text: "帮我实现订单查询" },
      {
        ...base("m_u1", "p2"),
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${BIG}`,
      },
    ]),
    assistant("m_a1", 20, [
      { ...base("m_a1", "p3"), type: "step-start", snapshot: "abc123" },
      { ...base("m_a1", "p4"), type: "reasoning", text: BIG },
      {
        ...base("m_a1", "p5"),
        type: "tool",
        callId: "call_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "cat big.log", content: BIG },
          output: BIG,
          title: "cat big.log",
          metadata: { output: BIG, exit: 0 },
          startedAt: 21,
          completedAt: 22,
        },
        metadata: { source: "tool-source-marker" },
      },
      {
        ...base("m_a1", "p6"),
        type: "tool",
        callId: "call_2",
        tool: "write",
        state: {
          status: "error",
          input: { content: BIG },
          error: BIG,
          startedAt: 23,
          completedAt: 24,
        },
      },
      {
        ...base("m_a1", "p7"),
        type: "tool",
        callId: "call_3",
        tool: "read",
        state: { status: "pending", input: { path: "a" }, raw: BIG },
      },
      {
        ...base("m_a1", "p8"),
        type: "tool",
        callId: "call_4",
        tool: "bash",
        state: {
          status: "running",
          input: { command: BIG },
          startedAt: 25,
          metadata: { output: BIG },
        },
      },
      { ...base("m_a1", "p9"), type: "text", text: "订单查询在 orderService 里" },
    ]),
    // compact summary（compaction 无 timelineStatus）必须仍被识别为不可见。
    user("m_u2", 30, [
      { ...base("m_u2", "p10"), type: "compaction", auto: true },
      { ...base("m_u2", "p11"), type: "text", text: "summary of history" },
    ]),
    // model-only tool part metadata 让整条消息变成 providerContextOnly。
    user("m_u3", 40, [
      {
        ...base("m_u3", "p12"),
        type: "tool",
        callId: "call_5",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: BIG },
          output: BIG,
          title: "t",
          metadata: {},
          startedAt: 41,
          completedAt: 42,
        },
        metadata: { visibility: "model-only" },
      },
      { ...base("m_u3", "p13"), type: "text", text: "hidden context" },
    ]),
    user("m_u4", 50, [
      {
        ...base("m_u4", "p14"),
        type: "text",
        text: '<system-reminder source="goal-continuation">Continue working toward the active session goal.',
      },
    ]),
    assistant("m_a2", 60, [
      {
        ...base("m_a2", "p15"),
        type: "timeline",
        timelineType: "context_compaction",
        display: "separator",
        status: "completed",
      },
      {
        ...base("m_a2", "p16"),
        type: "subagent",
        prompt: "explore",
        description: "探索",
        agent: "explore",
      },
      { ...base("m_a2", "p17"), type: "text", text: "最后一段回复" },
    ]),
  ];
}

function fixtureSnapshot(): ZCodeSessionStateSnapshot {
  return {
    session: {
      sessionId: SESSION_ID,
      title: "",
      status: "completed",
      workspace: { workspacePath: "/repo" },
    },
    projection: { target: null, lastError: null, pendingPermissions: [], activeToolCalls: [] },
    runtime: {},
    settings: { model: { current: model } },
    messages: fixtureMessages(),
  } as unknown as ZCodeSessionStateSnapshot;
}

function structureOf(snapshot: ZCodeSessionStateSnapshot) {
  return snapshot.messages.map((message) => ({
    info: message.info,
    parts: message.parts.map((part) => ({
      partId: part.partId,
      type: part.type,
      metadata: "metadata" in part ? part.metadata : undefined,
      text: part.type === "text" ? part.text : undefined,
      status: part.type === "tool" ? part.state.status : undefined,
      title: part.type === "tool" && "title" in part.state ? part.state.title : undefined,
    })),
  }));
}

describe("elideSessionSnapshotForIndex", () => {
  it("剥离 tool/reasoning/data URL 大载荷，同时保留 message 与 part 结构", () => {
    const full = fixtureSnapshot();
    const elided = elideSessionSnapshotForIndex(full);

    expect(structureOf(elided)).toEqual(structureOf(full));
    expect(JSON.stringify(elided).length).toBeLessThan(10_000);
    expect(JSON.stringify(full).length).toBeGreaterThan(BIG.length * 10);
    for (const message of elided.messages) {
      expect(() => zcodeMessageWithPartsSchema.parse(message)).not.toThrow();
    }
    const parts = elided.messages.flatMap((message) => message.parts);
    const byId = new Map(parts.map((part) => [part.partId, part]));
    expect(byId.get("p2")).toMatchObject({ type: "file", url: "data:," });
    expect(byId.get("p4")).toMatchObject({ type: "reasoning", text: "" });
    expect(byId.get("p5")).toMatchObject({
      state: { status: "completed", input: {}, output: "", metadata: {}, title: "cat big.log" },
    });
    expect(byId.get("p6")).toMatchObject({ state: { status: "error", input: {}, error: "" } });
    expect(byId.get("p7")).toMatchObject({ state: { status: "pending", input: {}, raw: "" } });
    expect(byId.get("p8")).toMatchObject({ state: { status: "running", input: {}, metadata: {} } });
    // 非大载荷 part 原样保留（同一引用即可证明未改写）。
    expect(byId.get("p3")).toBe(full.messages[1]?.parts[0]);
    expect(byId.get("p16")).toBe(full.messages[5]?.parts[1]);
  });

  it("不修改入参 snapshot（CLI 侧 messages 可能来自共享缓存）", () => {
    const full = fixtureSnapshot();
    const before = JSON.stringify(full);
    elideSessionSnapshotForIndex(full);
    expect(JSON.stringify(full)).toBe(before);
  });

  it("task index 依赖的全部派生结果与 full snapshot 一致", () => {
    const full = fixtureSnapshot();
    const elided = elideSessionSnapshotForIndex(full);

    const visibleIds = (snapshot: ZCodeSessionStateSnapshot) =>
      getZCodeUserVisibleMessages(snapshot.messages).map((message) => message.info.messageId);
    expect(visibleIds(elided)).toEqual(visibleIds(full));
    expect(visibleIds(full)).toEqual(["m_u1", "m_a1", "m_a2"]);

    expect(elided.messages.map(getConversationMessageProjectionPolicy)).toEqual(
      full.messages.map(getConversationMessageProjectionPolicy),
    );
    const title = (snapshot: ZCodeSessionStateSnapshot) =>
      resolveZCodeVisibleSessionTitle({ title: "", messages: snapshot.messages, target: null });
    expect(title(elided)).toBe(title(full));
    expect(title(full)).toBe("帮我实现订单查询");
    expect(deriveZCodeTaskStatusFromSessionSnapshot(elided)).toBe(
      deriveZCodeTaskStatusFromSessionSnapshot(full),
    );
  });

  it("非 data: 的 file URL 原样保留", () => {
    const full = fixtureSnapshot();
    const filePart = full.messages[0]?.parts[1];
    if (filePart?.type !== "file") throw new Error("fixture file part missing");
    filePart.url = "file:///repo/a.png";
    const elided = elideSessionSnapshotForIndex(full);
    expect(elided.messages[0]?.parts[1]).toBe(filePart);
  });
});

describe("session/read contentProfile", () => {
  it("接受 full / index，缺省兼容旧调用，拒绝未知值", () => {
    expect(zcodeSessionReadParamsSchema.parse({ sessionId: "s" })).toEqual({ sessionId: "s" });
    expect(
      zcodeSessionReadParamsSchema.parse({ sessionId: "s", contentProfile: "index" })
        .contentProfile,
    ).toBe("index");
    expect(
      zcodeSessionReadParamsSchema.parse({ sessionId: "s", contentProfile: "full" }).contentProfile,
    ).toBe("full");
    expect(() =>
      zcodeSessionReadParamsSchema.parse({ sessionId: "s", contentProfile: "tiny" }),
    ).toThrow();
  });
});
