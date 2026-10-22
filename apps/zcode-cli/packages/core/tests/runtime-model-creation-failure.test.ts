import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  HookEventName,
  ModelErrorCode,
  ModelProtocolError,
  SessionEventType,
  createSessionId,
  type SessionEvent,
} from "@zcode/contracts";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

const CREATION_ERROR_MESSAGE = "Original model selection is unavailable";
const MODEL_CREATION_FAILED_MESSAGE = "Model creation failed";
const MODEL_CREATION_TURN_PHASE = "model_creation";
const LIFECYCLE_EVENT_TYPES = new Set<string>([
  SessionEventType.TurnStarted,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
]);
const RUNTIME_CONFIG = {
  modelSelection: createTestModelSelection("user-provider/user-model"),
  titleGeneration: { enabled: false },
  workingDirectory: "/workspace/project",
};
const TEXT_ATTACHMENT = {
  type: "file" as const,
  content: `data:text/plain;base64,${Buffer.from("pasted notes").toString("base64")}`,
  filename: "notes.txt",
  mimeType: "text/plain",
  sourceKind: "clipboard-text" as const,
};

/** 每次建模都失败：模拟 edit/retry 已截断历史后，Registry 中的 Provider 才消失。 */
function createFailingModelFactory() {
  return createTestModelFactory({
    onCreate() {
      throw new ModelProtocolError(ModelErrorCode.ProviderNotFound, CREATION_ERROR_MESSAGE);
    },
  });
}

function lifecycleEvents(events: SessionEvent[]): SessionEvent[] {
  return events.filter((event) => LIFECYCLE_EVENT_TYPES.has(event.type));
}

describe("AgentRuntime model creation failure lifecycle", () => {
  // Bug 回归：创建错误已经确定后仍初始化 Context，Context I/O 会在 TurnStarted 前覆盖原始错误，
  // 使 edit/retry 的 replacement input 再次消失。失败轮必须直接进入可持久化的 Turn 主链。
  it("persists the accepted input without initializing context after model creation fails", async () => {
    const sessionId = createSessionId("runtime-creation-failure-context");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const resolveContextSources = vi.fn(async () => {
      throw new Error("context source unavailable");
    });
    const runtime = createTestAgentRuntime(sessionId, RUNTIME_CONFIG, {
      contextSourcePort: { resolveContextSources } as never,
      eventStore,
      sessionStore,
      modelFactory: createFailingModelFactory(),
    });

    await expect(
      runtime.executeTurn("replacement input", undefined, { inputId: "command-context-error" }),
    ).rejects.toMatchObject({
      message: MODEL_CREATION_FAILED_MESSAGE,
      cause: expect.objectContaining({ message: CREATION_ERROR_MESSAGE }),
    });

    expect(resolveContextSources).not.toHaveBeenCalled();
    expect(
      lifecycleEvents(await eventStore.getEvents(sessionId)).map((event) => event.type),
    ).toEqual([SessionEventType.TurnStarted, SessionEventType.TurnError]);
    const [persistedUser] = await sessionStore.messages({ sessionID: sessionId });
    expect(persistedUser).toMatchObject({
      info: { role: "user", anchor: { sourceCommandId: "command-context-error" } },
      parts: [{ type: "text", text: "replacement input" }],
    });
  });

  // Bug 回归：失败轮运行 SessionStart 会提前消费一次性 Hook。它必须跳过 SessionStart，
  // 但仍运行 UserPromptSubmit；失败轮输入也不能被恢复轮的首次 Context 初始化清空。
  it("defers SessionStart and preserves accepted input until model creation recovers", async () => {
    const sessionId = createSessionId("runtime-creation-failure-session-start");
    const hookEvents: HookEventName[] = [];
    let failCreation = true;
    const runtime = createTestAgentRuntime(sessionId, RUNTIME_CONFIG, {
      eventStore: createTestSessionEventStore(),
      hookRunner: {
        run: vi.fn(async (input) => {
          hookEvents.push(input.hookEventName);
          return { additionalContexts: [] };
        }),
      },
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({
        onCreate() {
          if (failCreation) {
            throw new ModelProtocolError(ModelErrorCode.ProviderNotFound, CREATION_ERROR_MESSAGE);
          }
        },
        async generateText(request, observation) {
          expect(JSON.stringify(request.messages)).toContain("persist while unavailable");
          return {
            finishReason: "stop",
            model: observation.model,
            text: "model recovered",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    });

    await expect(
      runtime.executeTurn("persist while unavailable", undefined, {
        inputId: "command-session-start-failed",
      }),
    ).rejects.toMatchObject({ message: MODEL_CREATION_FAILED_MESSAGE });
    expect(hookEvents).toEqual([HookEventName.UserPromptSubmit]);

    failCreation = false;
    await expect(
      runtime.executeTurn("run after recovery", undefined, {
        inputId: "command-session-start-recovered",
      }),
    ).resolves.toMatchObject({ response: "model recovered" });
    expect(hookEvents).toEqual([
      HookEventName.UserPromptSubmit,
      HookEventName.SessionStart,
      HookEventName.UserPromptSubmit,
      HookEventName.Stop,
    ]);
  });
  // CR-01 回归：创建失败轮的输入落库曾在主生命周期 try 之外执行，附件写入失败会直接穿出，
  // 只留下 TurnStarted、没有终态，模型创建错误也被落库错误覆盖。
  it("keeps the model creation error as the terminal error when accepted input persistence fails", async () => {
    const sessionId = createSessionId("runtime-creation-failure-persistence-error");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(sessionId, RUNTIME_CONFIG, {
      artifactStore: {
        writeToolResultBinaryArtifact: vi.fn(async () => {
          throw new Error("artifact disk full");
        }),
      } as never,
      eventStore,
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createFailingModelFactory(),
    });

    await expect(
      runtime.executeTurn("persist after creation failure", [TEXT_ATTACHMENT], {
        inputId: "command-persistence-error",
      }),
    ).rejects.toMatchObject({
      message: MODEL_CREATION_FAILED_MESSAGE,
      cause: expect.objectContaining({ message: CREATION_ERROR_MESSAGE }),
    });

    const lifecycle = lifecycleEvents(await eventStore.getEvents(sessionId));
    expect(lifecycle.map((event) => event.type)).toEqual([
      SessionEventType.TurnStarted,
      SessionEventType.TurnError,
    ]);
    expect(lifecycle[1]?.payload).toMatchObject({
      turnPhase: MODEL_CREATION_TURN_PHASE,
      inputId: "command-persistence-error",
      error: { message: CREATION_ERROR_MESSAGE },
    });
  });

  // 落库期间用户点 Stop：取消优先于模型创建错误，与普通轮一样以 TurnComplete(cancelled) 收尾。
  it("finishes as cancelled when the user stops while accepted input is persisting", async () => {
    const sessionId = createSessionId("runtime-creation-failure-cancelled");
    const eventStore = createTestSessionEventStore();
    const controller = new AbortController();
    const runtime = createTestAgentRuntime(sessionId, RUNTIME_CONFIG, {
      artifactStore: {
        writeToolResultBinaryArtifact: vi.fn(async () => {
          controller.abort();
          throw Object.assign(new Error("artifact write aborted"), { name: "AbortError" });
        }),
      } as never,
      eventStore,
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createFailingModelFactory(),
    });

    await expect(
      runtime.executeTurn("stop while persisting", [TEXT_ATTACHMENT], {
        abortSignal: controller.signal,
        inputId: "command-cancelled",
      }),
    ).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

    const lifecycle = lifecycleEvents(await eventStore.getEvents(sessionId));
    expect(lifecycle.map((event) => event.type)).toEqual([
      SessionEventType.TurnStarted,
      SessionEventType.TurnComplete,
    ]);
    expect(lifecycle[1]?.payload).toMatchObject({
      resultType: "cancelled",
      inputId: "command-cancelled",
    });
  });

  // /compact 不是用户消息：创建失败时直接写终态，不能生成 TurnStarted 或 "/compact" 用户气泡。
  it("keeps manual compact creation failures on the immediate terminal path", async () => {
    const sessionId = createSessionId("runtime-creation-failure-compact");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    let failCreation = false;
    const runtime = createTestAgentRuntime(sessionId, RUNTIME_CONFIG, {
      eventStore,
      sessionStore,
      modelFactory: createTestModelFactory({
        onCreate() {
          if (failCreation) {
            throw new ModelProtocolError(ModelErrorCode.ProviderNotFound, CREATION_ERROR_MESSAGE);
          }
        },
        async generateText(_request, observation) {
          return {
            finishReason: "stop",
            model: observation.model,
            text: "first answer",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      }),
    });
    // /compact 只作用于已落库的会话：先完成一轮普通对话，再让 Registry 失效。
    await runtime.executeTurn("first prompt", undefined, { inputId: "command-first" });
    const eventCountBeforeCompact = (await eventStore.getEvents(sessionId)).length;
    const messagesBeforeCompact = await sessionStore.messages({ sessionID: sessionId });
    failCreation = true;

    await expect(
      runtime.executeTurn("/compact", undefined, { inputId: "command-compact" }),
    ).rejects.toMatchObject({
      message: MODEL_CREATION_FAILED_MESSAGE,
      cause: expect.objectContaining({ message: CREATION_ERROR_MESSAGE }),
    });

    const compactLifecycle = lifecycleEvents(
      (await eventStore.getEvents(sessionId)).slice(eventCountBeforeCompact),
    );
    expect(compactLifecycle.map((event) => event.type)).toEqual([SessionEventType.TurnError]);
    expect(compactLifecycle[0]?.payload).toMatchObject({
      turnPhase: MODEL_CREATION_TURN_PHASE,
      inputId: "command-compact",
      error: { message: CREATION_ERROR_MESSAGE },
    });
    expect(await sessionStore.messages({ sessionID: sessionId })).toEqual(messagesBeforeCompact);
  });

  // 创建失败轮复用主链的 UserPromptSubmit 闸门：被策略拦截的输入不落库，也不显示模型错误。
  it("lets a UserPromptSubmit block finish the turn without persisting the prompt", async () => {
    const sessionId = createSessionId("runtime-creation-failure-hook-blocked");
    const eventStore = createTestSessionEventStore();
    const sessionStore = createRecordingSubagentSessionStore();
    const runtime = createTestAgentRuntime(sessionId, RUNTIME_CONFIG, {
      eventStore,
      hookRunner: {
        run: vi.fn(async (input) =>
          input.hookEventName === HookEventName.UserPromptSubmit
            ? {
                additionalContexts: [],
                preventContinuation: true,
                stopReason: "blocked by policy",
              }
            : { additionalContexts: [] },
        ),
      },
      sessionStore,
      modelFactory: createFailingModelFactory(),
    });

    await expect(
      runtime.executeTurn("blocked prompt", undefined, { inputId: "command-hook-blocked" }),
    ).resolves.toMatchObject({ response: "blocked by policy" });

    const lifecycle = lifecycleEvents(await eventStore.getEvents(sessionId));
    expect(lifecycle.map((event) => event.type)).toEqual([
      SessionEventType.TurnStarted,
      SessionEventType.TurnComplete,
    ]);
    expect(lifecycle[1]?.payload).toMatchObject({
      resultType: "success",
      inputId: "command-hook-blocked",
    });
    expect(await sessionStore.messages({ sessionID: sessionId })).toEqual([]);
  });

  // 创建失败轮不会进入 model step，guide 无法被消费；必须拒绝并让调用方转入队列。
  it("rejects guide steering into a creation-failure turn", async () => {
    const sessionId = createSessionId("runtime-creation-failure-steer");
    const sessionStore = createRecordingSubagentSessionStore();
    const steerResults: unknown[] = [];
    const saveMessage = sessionStore.saveMessage.bind(sessionStore);
    let runtime: ReturnType<typeof createTestAgentRuntime> | undefined;
    sessionStore.saveMessage = async (message) => {
      if (message.role === "user" && runtime && steerResults.length === 0) {
        steerResults.push(
          await runtime.steerTurn({ delivery: "guide", input: "guide while failing" }),
        );
      }
      await saveMessage(message);
    };
    runtime = createTestAgentRuntime(sessionId, RUNTIME_CONFIG, {
      eventStore: createTestSessionEventStore(),
      sessionStore,
      modelFactory: createFailingModelFactory(),
    });

    await expect(
      runtime.executeTurn("persist then fail", undefined, { inputId: "command-steer" }),
    ).rejects.toMatchObject({ message: MODEL_CREATION_FAILED_MESSAGE });

    expect(steerResults).toEqual([
      expect.objectContaining({ kind: "rejected", reason: "turn_not_steerable" }),
    ]);
  });
});
