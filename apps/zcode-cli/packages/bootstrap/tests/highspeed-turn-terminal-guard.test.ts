import { describe, expect, it, vi } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { persistHighspeedTimingOnTurnTerminal } from "../src/zcode-protocol/v4-bridge.js";

// 回归背景：turn 终态钩子对所有 turn 触发，且投影对普通 turn 也写入 model/tool 耗时，
// “双 undefined 才返回”的守卫形同虚设——每个普通 turn 终态都会做一次全量
// sessionStore.messages() 扫描，最后才因 metadata.highspeed 缺失返回（热路径 O(N) 浪费）。

function terminalEvent(): SessionEvent {
  return {
    id: "event-1",
    sessionId: "session-1",
    turnId: "turn-1",
    type: SessionEventType.TurnComplete,
    timestamp: new Date(1_700_000_000_000),
    traceId: "trace-1",
    sequenceNumber: 9,
    payload: {},
  } as unknown as SessionEvent;
}

function makeSnapshot(options: {
  highspeed: boolean;
  timing: boolean;
  fallbackAt?: number;
}): never {
  return {
    rows: {
      window: [
        {
          rowId: 1,
          turnId: "turn-1",
          entityId: "user-entity-1",
          createdAt: 1,
          createdAtSeq: 1,
          kind: "userInput",
          text: "加速这一轮",
          origin: "realUser",
          sourceCommandId: "cmd-1",
          ...(options.highspeed
            ? {
                highspeed: {
                  schemaVersion: 1,
                  cardId: "hsc-guard-1",
                  taskId: "session-1",
                  provider: "zai",
                  model: "glm-5",
                  issuedAt: 1,
                  expiresAt: 2,
                  ...(options.fallbackAt !== undefined ? { fallbackAt: options.fallbackAt } : {}),
                },
              }
            : {}),
        },
        {
          rowId: 2,
          turnId: "turn-1",
          entityId: "turn-entity-1",
          createdAt: 2,
          createdAtSeq: 2,
          kind: "turnHeader",
          origin: "userInput",
          sourceCommandId: "cmd-1",
          state: "completedSuccess",
          startedAt: 1,
          endedAt: 2,
          ...(options.timing ? { modelDurationMs: 1_000, toolDurationMs: 500 } : {}),
        },
      ],
      totalCount: 2,
      firstRowId: 1,
    },
  } as never;
}

function makeContext(messages: ReturnType<typeof vi.fn>): never {
  return {
    sessions: new Map([
      ["session-1", { eventStore: {}, traceContext: { traceId: "trace-1" } }],
    ]),
    deps: { sessionStore: { messages } },
    v4Gateway: undefined,
    logger: { warn: vi.fn() },
  } as never;
}

describe("highspeed turn terminal persistence guard", () => {
  it("普通 turn（user row 无 highspeed 身份，即使带耗时字段）不得触发 messages 全量扫描", () => {
    const messages = vi.fn(async () => []);
    persistHighspeedTimingOnTurnTerminal(
      makeContext(messages),
      "session-1",
      terminalEvent(),
      makeSnapshot({ highspeed: false, timing: true }),
    );
    expect(messages).not.toHaveBeenCalled();
  });

  it("无耗时字段的普通 turn 同样不触发扫描", () => {
    const messages = vi.fn(async () => []);
    persistHighspeedTimingOnTurnTerminal(
      makeContext(messages),
      "session-1",
      terminalEvent(),
      makeSnapshot({ highspeed: false, timing: false }),
    );
    expect(messages).not.toHaveBeenCalled();
  });

  it("加速 turn 终态仍进入持久化扫描链路", () => {
    const messages = vi.fn(async () => []);
    persistHighspeedTimingOnTurnTerminal(
      makeContext(messages),
      "session-1",
      terminalEvent(),
      makeSnapshot({ highspeed: true, timing: true }),
    );
    expect(messages).toHaveBeenCalledWith({ sessionID: "session-1" });
  });

  it("加速 turn 终态把 live 投影里的 fallbackAt 一并交给持久化", async () => {
    // CR-02 回归：fallbackAt 只存在于 live 投影；终态若不随 metadata 写入 transcript，
    // HighspeedMetricsUpdated 会用不含 fallbackAt 的 payload 覆盖 row，cold hydration 也恢复不了。
    const highspeed = {
      schemaVersion: 1,
      cardId: "hsc-guard-1",
      taskId: "session-1",
      provider: "zai",
      model: "glm-5",
      issuedAt: 1,
      expiresAt: 2,
    };
    let saved: Record<string, unknown> | undefined;
    const messages = vi.fn(async () => [
      {
        info: {
          id: "user-1",
          sessionID: "session-1",
          role: "user",
          time: { created: 1 },
          agent: "default",
          model: { providerID: "zai", modelID: "glm-5" },
          metadata: { highspeed, conversationInputIntent: { sourceCommandId: "cmd-1", highspeed } },
        },
        parts: [],
      },
    ]);
    const context = {
      sessions: new Map([
        [
          "session-1",
          {
            eventStore: {
              getLatestSequenceNumber: vi.fn(async () => 0),
              append: vi.fn(async (event: unknown) => event),
            },
            traceContext: { traceId: "trace-1" },
          },
        ],
      ]),
      deps: {
        sessionStore: {
          messages,
          saveMessage: vi.fn(async (info: { metadata?: Record<string, unknown> }) => {
            saved = info.metadata;
          }),
        },
      },
      v4Gateway: undefined,
      logger: { warn: vi.fn() },
    } as never;

    persistHighspeedTimingOnTurnTerminal(
      context,
      "session-1",
      terminalEvent(),
      makeSnapshot({ highspeed: true, timing: true, fallbackAt: 1_700_000_301_000 }),
    );

    await vi.waitFor(() => expect(saved).toBeDefined());
    expect(saved?.highspeed).toMatchObject({
      fallbackAt: 1_700_000_301_000,
      modelDurationMs: 1_000,
      toolDurationMs: 500,
    });
  });
});
