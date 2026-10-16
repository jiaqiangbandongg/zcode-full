import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { startPromptTurn } from "../src/zcode-protocol-v4/commands/prompt-turn.js";
import {
  V4CommandExecutor,
  V4SelectionSideChatRestrictedCommandError,
} from "../src/zcode-protocol-v4/commands/executor.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

vi.mock("../src/zcode-protocol-v4/commands/prompt-turn.js", () => ({
  startPromptTurn: vi.fn(),
}));

function record(taskType: V4SessionRecordView["taskType"] = "interactive"): V4SessionRecordView {
  return {
    app: { sessionId: "parent-1" } as V4SessionRecordView["app"],
    persistence: "immediate",
    taskType,
    workspace: { workspacePath: "/workspace" },
  } as V4SessionRecordView;
}

function envelope(type: CommandEnvelope["type"], payload: unknown = {}): CommandEnvelope {
  return {
    clientId: "client-1",
    commandId: `cmd-${type}`,
    issuedAt: 1,
    payload,
    sessionId: "parent-1",
    type,
  } as CommandEnvelope;
}

describe("v4 native selection side chat", () => {
  it("从 envelope 父会话创建 child 并返回结构化 ACK result", async () => {
    const parent = record();
    const createSelectionSideSession = vi.fn().mockResolvedValue({
      sessionId: "child-1",
    });
    const host: V4CommandCoreHost = {
      createSelectionSideSession,
      getRecord: (sessionId) => (sessionId === "parent-1" ? parent : undefined),
    };

    const result = await new V4CommandExecutor(host).execute(
      envelope("createSelectionSideSession"),
    );

    expect(createSelectionSideSession).toHaveBeenCalledWith("parent-1", {
      revisionAtDecision: 0,
      sourceCommandId: "cmd-createSelectionSideSession",
    });
    expect(result).toEqual({
      type: "createSelectionSideSession",
      sessionId: "child-1",
    });
  });

  it("携带 firstInput 时只在 child 上启动首轮普通输入", async () => {
    const parent = record();
    const child = record();
    child.app.sessionId = "child-1";
    const createSelectionSideSession = vi.fn().mockResolvedValue({ sessionId: "child-1" });
    const admitInputCommand = vi.fn(async () => null);
    vi.mocked(startPromptTurn).mockResolvedValue({
      turnStarted: Promise.resolve(),
      admission: {
        completion: Promise.resolve({}),
        kind: "started_turn",
        turnId: "turn-1",
      },
      messageId: "message-1",
    });
    const host: V4CommandCoreHost = {
      createSelectionSideSession,
      admitInputCommand,
      getRecord: (sessionId) =>
        sessionId === "parent-1" ? parent : sessionId === "child-1" ? child : undefined,
    };

    const result = await new V4CommandExecutor(host).execute(
      envelope("createSelectionSideSession", { firstInput: { text: "你好" } }),
    );

    expect(startPromptTurn).toHaveBeenCalledWith(
      host,
      child,
      expect.objectContaining({
        content: "你好",
        inputId: "cmd-createSelectionSideSession",
        intent: expect.objectContaining({
          text: "你好",
          requestedDelivery: "startNow",
        }),
      }),
    );
    expect(admitInputCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-1",
        type: "createSelectionSideSession",
        payload: { firstInput: { text: "你好" } },
      }),
      "child-1",
      expect.objectContaining({ queueItemId: "queue_cmd-createSelectionSideSession" }),
    );
    expect(result).toEqual({
      type: "createSelectionSideSession",
      sessionId: "child-1",
      input: {
        delivery: "startNow",
        inputId: "cmd-createSelectionSideSession",
        messageId: "message-1",
      },
    });
  });

  it("推荐模型随 child 创建一次传入，不修改父会话", async () => {
    const parent = record();
    const child = record();
    child.app.sessionId = "child-1";
    const createSelectionSideSession = vi.fn().mockResolvedValue({ sessionId: "child-1" });
    const admitInputCommand = vi.fn(async () => null);
    vi.mocked(startPromptTurn).mockResolvedValue({
      turnStarted: Promise.resolve(),
      admission: {
        completion: Promise.resolve({}),
        kind: "started_turn",
        turnId: "turn-1",
      },
      messageId: "message-1",
    });
    const host: V4CommandCoreHost = {
      createSelectionSideSession,
      admitInputCommand,
      getRecord: (sessionId) =>
        sessionId === "parent-1" ? parent : sessionId === "child-1" ? child : undefined,
    };

    const result = await new V4CommandExecutor(host).execute(
      envelope("createSelectionSideSession", {
        firstInput: {
          text: "你好",
          modelSelection: {
            providerId: "account:bigmodel-start-plan",
            modelId: "glm-5",
            options: { reasoningLevel: "high" },
          },
        },
      }),
    );

    expect(createSelectionSideSession).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({
        modelSelection: {
          providerId: "account:bigmodel-start-plan",
          modelId: "glm-5",
          options: { reasoningLevel: "high" },
        },
      }),
    );
    expect(startPromptTurn).toHaveBeenCalledWith(
      host,
      child,
      expect.objectContaining({
        content: "你好",
        inputId: "cmd-createSelectionSideSession",
        intent: expect.objectContaining({
          text: "你好",
          requestedDelivery: "startNow",
        }),
      }),
    );
    expect(admitInputCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-1",
        type: "createSelectionSideSession",
        payload: {
          firstInput: {
            text: "你好",
            modelSelection: {
              providerId: "account:bigmodel-start-plan",
              modelId: "glm-5",
              options: { reasoningLevel: "high" },
            },
          },
        },
      }),
      "child-1",
      expect.objectContaining({ queueItemId: "queue_cmd-createSelectionSideSession" }),
    );
    expect(result).toEqual({
      type: "createSelectionSideSession",
      sessionId: "child-1",
      input: {
        delivery: "startNow",
        inputId: "cmd-createSelectionSideSession",
        messageId: "message-1",
      },
    });
  });

  it.each([
    "sendGoalCommand",
    "resumeGoal",
    "editUserQuery",
    "retryTurn",
    "forkAssistant",
  ] as const)("selection_side_chat 拒绝受限命令 %s", async (command) => {
    const host: V4CommandCoreHost = {
      getRecord: () => record("selection_side_chat"),
    };

    await expect(
      new V4CommandExecutor(host).execute(envelope(command)),
    ).rejects.toMatchObject<V4SelectionSideChatRestrictedCommandError>({
      reasonCode: "guard.selectionSideChatRestrictedCommand",
    });
  });
});
