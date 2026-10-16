import { describe, expect, it, vi } from "vitest";
import {
  zcodeProtocolMethods,
  OFF_PEAK_PROVIDER_IDS,
  type OffPeakCodingPlanSupport,
  type ZCodeOffPeakTaskCreateParams,
} from "@zcode/shared";
import { offPeakSelectionView } from "./fixtures/offPeakSelection.js";

// review CR-01：offPeak/create、offPeak/list 兜底 catch 不得把底层异常文本（路径/SQL/上游片段）
// 跨 RPC 回传；对外固定稳定错误码 + 通用文案，原始错误只进服务端日志。

const SENSITIVE = "/Users/alice/.zcode/private.db: SQLITE_BUSY database is locked";

class MockProcessManagerBase {
  onRuntimeLifecycle() {
    return { dispose() {} };
  }
  onRuntimeRestarted() {
    return { dispose() {} };
  }
  markReady() {}
}

type RequestHandler = (request: { id: string; method: string; params?: unknown }) => void;

async function setup(
  support?: OffPeakCodingPlanSupport,
  configState: "enabled" | "disabled" | "error" = "enabled",
) {
  const handlers: RequestHandler[] = [];
  const respond = vi.fn(async (_id: string, _result: unknown) => undefined);
  const respondError = vi.fn(async (_id: string, _error: unknown) => undefined);
  const createTask = vi.fn(async (_params: ZCodeOffPeakTaskCreateParams) => {
    throw new Error(SENSITIVE);
  });
  const request = vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy) return requestParams;
    throw new Error(`Unexpected method ${method}`);
  });
  const getClient = vi.fn(async () => ({
    request,
    respond,
    respondError,
    transportKind: "stdio" as const,
    onNotification: () => ({ dispose() {} }),
    onRequest: (handler: RequestHandler) => {
      handlers.push(handler);
      return { dispose() {} };
    },
    onClose: () => ({ dispose() {} }),
  }));
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class extends MockProcessManagerBase {
      getClient = getClient;
      disposeAll() {}
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const resolveConfig = vi.fn(async () => {
    if (configState === "error") throw new Error("config unavailable");
    return { enabled: configState === "enabled", modelSelectionView: offPeakSelectionView() };
  });
  const service = createZCodeAgentService({
    modelSelectionReadinessSource: { getView: async () => offPeakSelectionView() },
    resolveOffPeakClientConfig: resolveConfig,
    resolveOffPeakTaskService: () => ({
      getCodingPlanSupport: async () =>
        support ?? {
          supported: true as const,
          kind: "zai-personal" as const,
          providerFamily: "zai" as const,
          providerId: OFF_PEAK_PROVIDER_IDS.zai,
        },
      createTask,
      list: vi.fn(async () => {
        throw new Error(SENSITIVE);
      }),
    }),
  });
  await service.initialize({ workspacePath: "/workspace/app" });
  const dispatch = async (method: string, params: unknown) => {
    for (const handler of handlers) handler({ id: "req-1", method, params });
    await vi.waitFor(() => expect(respondError).toHaveBeenCalled());
    return respondError.mock.calls[0]?.[1] as { code: number; message: string; data?: unknown };
  };
  const dispatchReply = async (params: unknown) => {
    for (const handler of handlers)
      handler({ id: "req-1", method: zcodeProtocolMethods.offPeakCreate, params });
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    return respond.mock.calls[0]?.[1];
  };
  return { service, dispatch, respond, dispatchReply, createTask, resolveConfig };
}

describe("offPeak RPC 内部异常脱敏（review CR-01）", () => {
  it.each(["disabled", "error"] as const)(
    "灰度 %s 不阻塞初始化，但调用时拒绝且无创建副作用",
    async (state) => {
      const { service, dispatchReply, createTask, resolveConfig } = await setup(undefined, state);
      try {
        expect(resolveConfig).not.toHaveBeenCalled();
        expect(
          await dispatchReply({ title: "t", prompt: "p", boundSessionId: "sess-1" }),
        ).toMatchObject({
          ok: false,
          failureStage: "client_validation",
          errorCode: "offpeak_disabled",
        });
        expect(resolveConfig).toHaveBeenCalledOnce();
        expect(createTask).not.toHaveBeenCalled();
      } finally {
        service.disposeAll();
      }
    },
  );

  it.each(["zai", "bigmodel"] as const)(
    "%s 工具默认只使用同域 Provider，携带完整选择/绑定/工作区",
    async (family) => {
      const { service, dispatch, createTask } = await setup({
        supported: true,
        kind: family === "zai" ? "zai-personal" : "bigmodel-personal",
        providerFamily: family,
        providerId: `account:${family}-individual-coding-plan`,
      });
      try {
        await dispatch(zcodeProtocolMethods.offPeakCreate, {
          title: "t",
          prompt: "p",
          boundSessionId: "sess-1",
        });
        expect(createTask).toHaveBeenCalledExactlyOnceWith({
          title: "t",
          prompt: "p",
          permissionMode: "yolo",
          boundSessionId: "sess-1",
          workspacePath: "/workspace/app",
          modelSelection: {
            providerId: OFF_PEAK_PROVIDER_IDS[family],
            modelId: "GLM-5.2",
            options: { reasoningLevel: "max" },
          },
        });
      } finally {
        service.disposeAll();
      }
    },
  );

  it("显式档位传给创建服务；另一域独有模型不取号", async () => {
    const { service, dispatch, dispatchReply, createTask } = await setup();
    try {
      await dispatch(zcodeProtocolMethods.offPeakCreate, {
        title: "t",
        prompt: "p",
        model: " glm-5.2 ",
        thoughtLevel: "high",
      });
      expect(createTask).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelSelection: {
            providerId: OFF_PEAK_PROVIDER_IDS.zai,
            modelId: "GLM-5.2",
            options: { reasoningLevel: "high" },
          },
        }),
      );
      createTask.mockClear();
      expect(
        await dispatchReply({ title: "t", prompt: "p", model: "BigModel-only" }),
      ).toMatchObject({ ok: false, errorCode: "model_not_allowed" });
      expect(createTask).not.toHaveBeenCalled();
    } finally {
      service.disposeAll();
    }
  });

  it("没有受支持的当前账号时不从候选猜 Family", async () => {
    const { service, dispatchReply, createTask } = await setup({
      supported: false,
      reason: "connection_unselected",
    });
    try {
      expect(await dispatchReply({ title: "t", prompt: "p" })).toMatchObject({
        ok: false,
        errorCode: "offpeak_disabled",
      });
      expect(createTask).not.toHaveBeenCalled();
    } finally {
      service.disposeAll();
    }
  });

  it("offPeak/create 底层抛错时不回传原始错误文本", async () => {
    const { service, dispatch, respond } = await setup();
    const error = await dispatch(zcodeProtocolMethods.offPeakCreate, {
      title: "t",
      prompt: "p",
    });
    expect(error.code).toBe(-32603);
    expect(error.message).toBe("Internal off-peak service error");
    expect(error.data).toEqual({ errorCode: "offpeak_internal_error" });
    expect(JSON.stringify(error)).not.toContain("private.db");
    expect(JSON.stringify(error)).not.toContain("SQLITE");
    expect(respond).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("offPeak/list 底层抛错时不回传原始错误文本", async () => {
    const { service, dispatch } = await setup();
    const error = await dispatch(zcodeProtocolMethods.offPeakList, {});
    expect(error.code).toBe(-32603);
    expect(error.message).toBe("Internal off-peak service error");
    expect(JSON.stringify(error)).not.toContain(SENSITIVE);
    service.disposeAll();
  });
});
