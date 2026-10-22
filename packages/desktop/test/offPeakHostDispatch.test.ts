import { readFile } from "node:fs/promises";
import ts from "typescript";
import { OFF_PEAK_PROVIDER_IDS } from "@zcode/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { OffPeakModelUnavailableError } from "@zcode/services/node";
import {
  assertBoundSessionDispatchable,
  resolveOffPeakDispatchKind,
} from "../src/host/offPeakDispatchPlan.js";

let createDispatch: (
  dependencies: Record<string, unknown>,
) => (request: Record<string, unknown>) => Promise<unknown>;

beforeAll(async () => {
  // 只装载真实派发函数，隔离 host/index 的进程启动副作用；不复制一份派发算法测试自己。
  const path = new URL("../src/host/index.ts", import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    await readFile(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "dispatchOffPeakRun",
  );
  if (!declaration) throw new Error("Missing production dispatchOffPeakRun");
  const code = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  createDispatch = (dependencies) =>
    new Function(...Object.keys(dependencies), `${code}; return dispatchOffPeakRun;`)(
      ...Object.values(dependencies),
    );
});

function setup() {
  const service = {
    listDeletedTaskIds: vi.fn(async (): Promise<string[]> => []),
    // tasks-index 行的 status 只镜像 CLI 终态，运行中只能来自 syncer 的活动集合。
    listActiveTaskIds: vi.fn(async (): Promise<string[]> => []),
    resumeTask: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    createTask: vi.fn(async (_params: Record<string, unknown>) => ({
      taskId: "new",
      traceId: "trace-new",
    })),
    sendPrompt: vi.fn(async () => {}),
  };
  const runtime = {
    service: {
      residentExecutions: {
        has: vi.fn(() => false),
        retakeGuard: vi.fn(() => () => true),
        isUserOwned: vi.fn(() => false),
        discardTicket: vi.fn(async () => {}),
        deliverTicket: vi.fn(async () => undefined as { sessionId: string } | undefined),
      },
    },
    validateSelection: vi.fn(async () => true),
    buildRequestAuth: vi.fn(async () => ({ apiKey: "test-ticket-auth" })),
  };
  const dispose = vi.fn();
  const admitted = vi.fn();
  const track = vi.fn(() => ({ admitted }));
  const repo = {
    get: vi.fn(async () => ({ status: "queued", conversationId: "bound" })),
    markRunning: vi.fn(async () => ({})),
    requeueForContinuation: vi.fn(async () => ({})),
  };
  const report = vi.fn();
  const dispatch = createDispatch({
    activeServices: { getOptional: () => service },
    reportHostSessionCreate: report,
    parentPort: {},
    IZCodeTaskService: Symbol("task-service"),
    IZCodeAgentService: Symbol("agent-service"),
    offPeakTaskRepo: repo,
    isOffPeakTerminalStatus: (status: string) =>
      ["completed", "failed", "cancelled"].includes(status),
    ensureOffPeakRuntime: async () => runtime,
    OffPeakModelUnavailableError,
    resolveOffPeakDispatchKind,
    assertBoundSessionDispatchable,
    randomUUID: () => "run-1",
    OFF_PEAK_RESUME_PROMPT: "resume prompt",
    offPeakRunSubscriptionKey: (taskId: string, traceId: string) => `${taskId}:${traceId}`,
    trackOffPeakRunOutcome: track,
    disposeOffPeakRunSubscription: dispose,
  });
  const modelSelection = {
    providerId: OFF_PEAK_PROVIDER_IDS.bigmodel,
    modelId: "GLM-5.2",
    options: { reasoningLevel: "high" },
  };
  const request = {
    offPeakTaskId: "idle-1",
    prompt: "task prompt",
    permissionMode: "yolo",
    modelSelection,
    sessionId: "bound",
    serverTicketId: "ticket-1",
    workspacePath: "/project",
    workspaceIdentity: "remote:ssh:test:/project",
  };
  return { service, runtime, dispose, track, report, dispatch, request, admitted, repo };
}

describe("Host OffPeak dispatch current execution contract", () => {
  it("会话准备期间任务取消，接纳前重新核对并释放票据", async () => {
    const state = setup();
    state.service.resumeTask.mockImplementation(async () => {
      state.repo.get.mockResolvedValue({ status: "cancelled", conversationId: "bound" });
    });
    await expect(state.dispatch(state.request)).resolves.toMatchObject({ lifecycleManaged: true });
    expect(state.service.sendPrompt).not.toHaveBeenCalled();
    expect(state.track).not.toHaveBeenCalled();
    expect(state.runtime.service.residentExecutions.discardTicket).toHaveBeenCalledWith("ticket-1");
  });

  it("续票交接报错期间已被用户接管，不将用户任务重新排队", async () => {
    const state = setup();
    state.runtime.service.residentExecutions.has.mockReturnValue(true);
    state.runtime.service.residentExecutions.retakeGuard.mockReturnValue(() => false);
    state.runtime.service.residentExecutions.deliverTicket.mockRejectedValue(
      new Error("lost reply"),
    );
    await expect(state.dispatch(state.request)).rejects.toThrow("lost reply");
    expect(state.repo.requeueForContinuation).not.toHaveBeenCalled();
  });
  it("任务已结束时迟到派发只释放票据，不重放原始任务", async () => {
    const state = setup();
    state.repo.get.mockResolvedValue({ status: "completed", conversationId: "bound" });
    await expect(state.dispatch(state.request)).resolves.toMatchObject({ lifecycleManaged: true });
    expect(state.service.sendPrompt).not.toHaveBeenCalled();
    expect(state.repo.markRunning).not.toHaveBeenCalled();
  });
  it("未创建会话的任务已删除时，不返回虚构的空会话标识", async () => {
    const state = setup();
    state.repo.get.mockResolvedValue(undefined as never);
    const result = await state.dispatch({ ...state.request, sessionId: undefined });
    expect(result).toMatchObject({ lifecycleManaged: true });
    expect((result as { sessionId?: string }).sessionId).toBeUndefined();
    expect(state.runtime.service.residentExecutions.discardTicket).toHaveBeenCalledWith("ticket-1");
    expect(state.service.createTask).not.toHaveBeenCalled();
  });
  it("构建续票凭据期间驻留执行结束，不落入初始派发", async () => {
    const state = setup();
    state.runtime.service.residentExecutions.has.mockReturnValue(true);
    await expect(state.dispatch(state.request)).resolves.toMatchObject({ lifecycleManaged: true });
    expect(state.service.sendPrompt).not.toHaveBeenCalled();
    expect(state.service.resumeTask).not.toHaveBeenCalled();
  });
  it("驻留执行收到新票只交接票据，不重复恢复或提交原始任务", async () => {
    const state = setup();
    state.runtime.service.residentExecutions.has.mockReturnValue(true);
    state.runtime.service.residentExecutions.deliverTicket.mockResolvedValue({
      sessionId: "bound",
    });
    await expect(state.dispatch({ ...state.request, conversationId: "bound" })).resolves.toEqual({
      conversationId: "bound",
      sessionId: "bound",
      lifecycleManaged: true,
    });
    expect(state.service.sendPrompt).not.toHaveBeenCalled();
    expect(state.service.resumeTask).not.toHaveBeenCalled();
    expect(state.track).not.toHaveBeenCalled();
  });
  it.each(["bound-first-run", "resume"])(
    "%s keeps idle reasoning out of persisted Session config",
    async (kind) => {
      const state = setup();
      const request = {
        ...state.request,
        ...(kind === "resume" ? { conversationId: "bound" } : {}),
      };
      await expect(state.dispatch(request)).resolves.toEqual({
        conversationId: "bound",
        sessionId: "bound",
        lifecycleManaged: true,
      });
      expect(state.service.setConfigOption.mock.calls).toHaveLength(1);
      expect(state.service.setConfigOption).toHaveBeenCalledWith(
        expect.objectContaining({ configId: "mode", value: "yolo" }),
      );
      expect(state.service.sendPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "bound",
          modelSelection: state.request.modelSelection,
          content: kind === "resume" ? "resume prompt" : "task prompt",
          toolDenylist: ["CronCreate", "OffPeakCreate"],
          modelExecution: {
            memoryExtraction: "skip",
            selectionScope: "execution",
            requestAuth: { apiKey: "test-ticket-auth" },
            offPeak: {
              executionId: expect.any(String),
              ticketId: "ticket-1",
              providerErrorCode: "3102",
            },
            subagents: { foregroundModel: "submission", background: "allow" },
          },
        }),
      );
      expect(state.service.createTask).not.toHaveBeenCalled();
      expect(state.repo.markRunning).toHaveBeenCalled();
      expect(state.admitted).toHaveBeenCalledTimes(1);
      expect(state.report).not.toHaveBeenCalled();
      expect(state.service.resumeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceIdentity: request.workspaceIdentity,
          offPeakTaskId: "idle-1",
        }),
      );
    },
  );

  it.each(["busy", "deleted"])(
    "bound session %s fails before config writes or dispatch",
    async (kind) => {
      const state = setup();
      if (kind === "busy") state.service.listActiveTaskIds.mockResolvedValue(["bound"]);
      else state.service.listDeletedTaskIds.mockResolvedValue(["bound"]);
      await expect(state.dispatch(state.request)).rejects.toThrow(
        kind === "busy" ? "is busy" : "was deleted",
      );
      expect(state.service.resumeTask).not.toHaveBeenCalled();
      expect(state.service.setConfigOption).not.toHaveBeenCalled();
      expect(state.service.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it("new session uses its ordinary initial selection, while dispatch keeps the frozen idle selection", async () => {
    const state = setup();
    await state.dispatch({ ...state.request, sessionId: undefined });
    expect(state.service.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        offPeakTaskId: "idle-1",
        deferPersistenceUntilFirstPrompt: true,
      }),
    );
    expect(state.report).toHaveBeenCalledExactlyOnceWith(
      {},
      {
        sessionId: "new",
        messageId: "trace-new",
        source: "automation_idle",
        workspaceIdentity: state.request.workspaceIdentity,
      },
    );
    expect(state.service.createTask.mock.calls[0]?.[0]).not.toHaveProperty("modelSelection");
    expect(state.service.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "new",
        modelSelection: state.request.modelSelection,
        modelExecution: expect.objectContaining({ selectionScope: "execution" }),
      }),
    );
  });

  it("rejects unavailable fixed selection before requesting ticket auth", async () => {
    const state = setup();
    state.runtime.validateSelection.mockResolvedValue(false);
    await expect(state.dispatch(state.request)).rejects.toThrow(OffPeakModelUnavailableError);
    expect(state.runtime.buildRequestAuth).not.toHaveBeenCalled();
    expect(state.service.resumeTask).not.toHaveBeenCalled();
  });

  it("unsubscribes outcome tracking when sending fails", async () => {
    const state = setup();
    state.service.sendPrompt.mockRejectedValue(new Error("send failed"));
    await expect(state.dispatch(state.request)).rejects.toThrow("send failed");
    expect(state.track).toHaveBeenCalledOnce();
    expect(state.dispose).toHaveBeenCalledWith("bound:idle-1:bound:run-1");
  });
});

it("闲时新建首发被拒绝时不报 session_create", async () => {
  const state = setup();
  state.service.sendPrompt.mockRejectedValue(new Error("rejected"));
  await expect(state.dispatch({ ...state.request, sessionId: undefined })).rejects.toThrow(
    "rejected",
  );
  expect(state.report).not.toHaveBeenCalled();
});
