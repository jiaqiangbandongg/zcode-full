import { describe, expect, it, vi } from "vitest";
import {
  permissionFullAccessReceiptSchema,
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
import type { Logger, ModelRequest } from "@zcode/contracts";
import { createTestModelSelection } from "./test-model-selection.js";

function validReceipt() {
  return {
    interactionId: "permission-1",
    event: {
      id: "event-1",
      sessionId: createSessionId("unbound-resume"),
      traceId: "trace",
      type: "session_mode_changed",
      timestamp: new Date(),
      sequenceNumber: 1,
      payload: {
        mode: "yolo",
        planEnabled: true,
        previousMode: "build",
        previousPlanEnabled: true,
        source: "command",
        permissionGrant: { interactionId: "permission-1", queueItemIds: [] },
      },
    },
  };
}
function fixture(data?: unknown) {
  const entries = data === undefined ? [] : [{ id: "receipt", data }];
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
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
    sessionEntries: vi.fn(async (query) =>
      query.type === "runtime/permission_full_access"
        ? entries
        : query.type === "runtime/execution_state"
          ? [{ data: { mode: "edit", planEnabled: true } }]
          : [],
    ),
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
      logger,
    },
  );

  return { runtime, entries, logger, runHook };
}

describe("CR-02 授权辅助标记不阻断任务恢复", () => {
  it.each([
    ["记录缺失", undefined],
    ["内容损坏", { interactionId: "permission-1", event: null }],
    ["未来字段", { ...validReceipt(), futureField: true }],
    [
      "跨任务记录",
      { ...validReceipt(), event: { ...validReceipt().event, sessionId: "other-session" } },
    ],
  ])("%s 时清除旧标记，仍恢复历史和执行模式", async (_name, data) => {
    const { runtime, logger, runHook } = fixture(data);
    runtime.lastPermissionGrantId = "stale-grant";
    expect(await runtime.resumeFromStore()).toMatchObject({ messageCount: 1, partCount: 1 });
    expect(runtime.lastPermissionGrantId).toBeUndefined();
    expect(runtime.getMode()).toBe("edit");
    expect(runtime.getPlanEnabled()).toBe(true);
    expect(runHook).toHaveBeenCalledWith(
      expect.objectContaining({ source: "resume" }),
      expect.anything(),
    );
    if (data !== undefined) {
      expect(logger.warn).toHaveBeenCalledWith(
        "Ignoring invalid permission grant marker during session resume",
        expect.objectContaining({
          event: "session.resume.permission_grant_invalid",
          entryId: "receipt",
        }),
      );
    } else expect(logger.warn).not.toHaveBeenCalled();
  });
  it("合法记录恢复标记，不以 receipt 内旧 mode 覆盖当前 execution state", async () => {
    expect(permissionFullAccessReceiptSchema.safeParse(validReceipt())).toMatchObject({
      success: true,
    });
    const { runtime, entries, logger } = fixture(validReceipt());
    await runtime.resumeFromStore();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(runtime.lastPermissionGrantId).toBe("permission-1");
    expect(runtime.getMode()).toBe("edit");
    expect(runtime.getPlanEnabled()).toBe(true);
    entries[0]!.data = { interactionId: "broken" };
    await runtime.resumeFromStore();
    expect(runtime.lastPermissionGrantId).toBeUndefined();
    expect(runtime.getMode()).toBe("edit");
    expect(runtime.getPlanEnabled()).toBe(true);
  });
});
