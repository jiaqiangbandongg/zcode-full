import { describe, expect, it, vi } from "vitest";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type MessageWithParts,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import {
  createTestModelFactory,
  type TestModelExecutionObservation,
} from "./test-runtime-model.js";
import type { ModelRequest } from "@zcode/contracts";
import { createTestModelSelection } from "./test-model-selection.js";

describe("未绑定模型的 Session 历史恢复", () => {
  it("不创建执行模型也能恢复历史及 SessionStart hook，重新选模后可以继续发送", async () => {
    const sessionId = createSessionId("unbound-resume");
    const messageId = createMessageId("unbound-resume-history");
    const session: SessionInfo = {
      id: sessionId,
      projectID: createProjectId("unbound-resume"),
      directory: "/workspace/project",
      slug: "unbound-resume",
      title: "history stays readable",
      version: "test",
      taskType: "interactive",
      time: { created: 1, updated: 1 },
    };
    const messages: MessageWithParts[] = [
      {
        info: {
          id: messageId,
          sessionID: sessionId,
          role: "user",
          agent: "zcode-agent",
          time: { created: 1 },
          // 历史请求来源不能替当前未绑定的选择自动补模型。
          modelSelection: createTestModelSelection("retired-provider/old-model"),
        },
        parts: [
          {
            id: createPartId("unbound-resume-text"),
            messageID: messageId,
            sessionID: sessionId,
            type: "text",
            text: "history before upgrade",
          },
        ],
      },
    ];
    const store = {
      getSession: vi.fn(async () => session),
      messages: vi.fn(async () => messages),
      sessionEntries: vi.fn(async () => []),
      readTodos: vi.fn(async () => []),
      readTarget: vi.fn(async () => null),
      saveMessage: vi.fn(async () => {}),
      savePart: vi.fn(async () => {}),
      saveSessionEntry: vi.fn(async () => {}),
      updateSession: vi.fn(async () => session),
    } as unknown as SessionStorePort;
    const generateText = vi.fn(
      async (_request: ModelRequest, observation: TestModelExecutionObservation) => ({
        finishReason: "stop" as const,
        model: observation.model,
        text: "continued",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    );
    const factory = vi.fn(createTestModelFactory({ generateText }));
    const runHook = vi.fn(async () => ({ additionalContexts: [] }));
    // 直接构造生产 Runtime，不能让通用测试 helper 注入默认模型掩盖未绑定场景。
    const runtime = new AgentRuntime(
      sessionId,
      {
        workingDirectory: session.directory,
        titleGeneration: { enabled: false },
      },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: store,
        modelFactory: factory,
        hookRunner: { run: runHook },
      },
    );

    expect(await runtime.resumeFromStore()).toMatchObject({ messageCount: 1, partCount: 1 });
    expect(runtime.getSessionModelSelection()).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(runHook).toHaveBeenCalledWith(
      expect.objectContaining({ source: "resume", model: undefined }),
      expect.anything(),
    );

    const selection = createTestModelSelection("provider-b/model-b", { reasoningLevel: "high" });
    await runtime.executeTurn("continue after selecting", undefined, {
      intent: {
        kind: "sendText",
        modelSelection: selection,
        requestedDelivery: "start-now",
        sourceCommandId: "reselect",
      },
    });
    expect(runtime.getSessionModelSelection()).toEqual(selection);
    expect(generateText).toHaveBeenCalledOnce();
    expect(JSON.stringify(generateText.mock.calls[0]?.[0].messages)).toContain(
      "history before upgrade",
    );
  });

  it("未选择模型的执行失败不调用 Factory，也不制造默认 Selection", async () => {
    const factory = vi.fn(createTestModelFactory({}));
    const runtime = new AgentRuntime(
      createSessionId("unbound-send"),
      {
        workingDirectory: "/workspace/project",
        titleGeneration: { enabled: false },
      },
      { eventStore: createTestSessionEventStore(), modelFactory: factory },
    );
    await expect(runtime.executeTurn("not ready")).rejects.toThrow(
      "Select a model before continuing",
    );
    expect(factory).not.toHaveBeenCalled();
    expect(runtime.getSessionModelSelection()).toBeUndefined();
  });
});
