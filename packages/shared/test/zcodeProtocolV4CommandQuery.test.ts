import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  conversationInputIntentSchema,
  queueItemSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("ZCode Protocol v4 authoritative input intent", () => {
  const baseIntent = {
    sourceCommandId: "cmd-input-1",
    queueItemId: "queue-1",
    clientId: "client-a",
    kind: "sendText" as const,
    text: "原文",
    delivery: { requested: "guide" as const, admitted: "queue" as const },
    order: { admissionSeq: 3, queuePosition: 1 },
    steer: { state: "fellBack" as const, reasonCode: "guide.attachmentsUnsupported" },
    dispatch: { state: "queued" as const },
    admittedAt: 1000,
  };

  it("完整字段通过，缺省 attachments 规范化为 []", () => {
    expect(conversationInputIntentSchema.parse(baseIntent)).toEqual({
      ...baseIntent,
      attachments: [],
    });

    const parsed = conversationInputIntentSchema.parse({
      ...baseIntent,
      attachments: [
        {
          ref: "artifact:1",
          fileName: "note.txt",
          mime: "text/plain",
          bytes: 4,
        },
      ],
      dispatch: { state: "reserved", reservationId: "reservation-1" },
    });
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.dispatch).toEqual({ state: "reserved", reservationId: "reservation-1" });
  });

  it("严格拒绝额外字段和非法顺序", () => {
    expect(
      conversationInputIntentSchema.safeParse({ ...baseIntent, unknownField: true }).success,
    ).toBe(false);
    expect(
      conversationInputIntentSchema.safeParse({
        ...baseIntent,
        order: { admissionSeq: -1 },
      }).success,
    ).toBe(false);
  });

  it("QueueItem 复用同一 intent，并把 dispatch 收窄为 queue lifecycle", () => {
    expect(
      queueItemSchema.parse({
        ...baseIntent,
        attachments: [],
        dispatch: { state: "queued" },
      }),
    ).toMatchObject({
      sourceCommandId: "cmd-input-1",
      queueItemId: "queue-1",
      clientId: "client-a",
      attachments: [],
    });
    expect(
      queueItemSchema.safeParse({
        ...baseIntent,
        attachments: [],
        dispatch: { state: "drained" },
      }).success,
    ).toBe(false);
    expect(
      queueItemSchema.safeParse({
        queueItemId: "queue-legacy",
        kind: "sendText",
        text: "lost fields",
        sourceCommandId: "cmd-legacy",
        submittedByClientId: "legacy",
        enqueuedAt: 1,
      }).success,
    ).toBe(false);
  });
});

describe("ZCode Protocol v4 commands/query", () => {
  const key = (index: number, sessionId: string | null = "session-1") => ({
    sessionId,
    commandId: `command-${index}`,
  });

  it("方法名冻结，1/64 个 key 与 null global key 通过", () => {
    expect(V4_METHODS.commandsQuery).toBe("v4/commands/query");
    expect(commandsQueryParamsSchema.parse({ commands: [key(1, null)] }).commands).toHaveLength(1);
    expect(
      commandsQueryParamsSchema.parse({
        commands: Array.from({ length: 64 }, (_, index) => key(index)),
      }).commands,
    ).toHaveLength(64);
  });

  it("0/65 个 key 与额外字段拒绝", () => {
    expect(commandsQueryParamsSchema.safeParse({ commands: [] }).success).toBe(false);
    expect(
      commandsQueryParamsSchema.safeParse({
        commands: Array.from({ length: 65 }, (_, index) => key(index)),
      }).success,
    ).toBe(false);
    expect(
      commandsQueryParamsSchema.safeParse({ commands: [key(1)], callerWorkspace: "/forged" })
        .success,
    ).toBe(false);
  });

  it("result 接受 ordered ack/unknown 且严格校验 envelope", () => {
    const parsed = commandsQueryResultSchema.parse({
      results: [
        { key: key(1), result: "unknown" },
        {
          key: key(2, null),
          result: {
            commandId: "command-2",
            status: "failed",
            reasonCode: "fault.command.inputDiscardedOnRestart",
            revisionAtDecision: 0,
          },
        },
      ],
    });
    expect(parsed.results.map((item) => item.key.commandId)).toEqual(["command-1", "command-2"]);
    expect(
      commandsQueryResultSchema.safeParse({
        results: [{ key: key(1), result: "unknown", extra: 1 }],
      }).success,
    ).toBe(false);
  });
});
