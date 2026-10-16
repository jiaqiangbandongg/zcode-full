import { describe, expect, it, vi } from "vitest";
import {
  zcodeProtocolMethods,
  OFF_PEAK_PROVIDER_IDS,
  buildRemoteWorkspaceIdentity,
} from "@zcode/shared";
import type { OffPeakClientConfig } from "../src/coding-plan-subscription/codingPlanSubscription.js";
import { offPeakSelectionView } from "./fixtures/offPeakSelection.js";

// D49：Off-Peak 本地支持能力作为 workspace 策略在客户端就绪时同步给 CLI。
// 不支持的 workspace 不发策略请求；支持时发送 enabled:true，绝不读取远端灰度。
// 旧 CLI method-not-found 降级忽略，不阻塞客户端就绪。

class MockProcessManagerBase {
  onRuntimeLifecycle() {
    return { dispose() {} };
  }
  onRuntimeRestarted() {
    return { dispose() {} };
  }
  markReady() {}
}

async function setup(params: {
  offPeakEnabled: boolean | undefined;
  configResolver?: () => Promise<OffPeakClientConfig>;
  policyResponse?: (request: unknown) => unknown;
}) {
  const resolveConfig = vi.fn(
    params.configResolver ??
      (async () => ({
        enabled: params.offPeakEnabled!,
        modelSelectionView: offPeakSelectionView(),
      })),
  );
  const request = vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy) {
      if (params.policyResponse) return params.policyResponse(requestParams);
      return requestParams;
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const getClient = vi.fn(async () => ({
    request,
    transportKind: "stdio" as const,
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
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
  const service = createZCodeAgentService({
    modelSelectionReadinessSource: { getView: async () => offPeakSelectionView() },
    ...(params.offPeakEnabled === undefined
      ? {}
      : {
          resolveOffPeakClientConfig: resolveConfig,
          resolveOffPeakTaskService: () => ({
            getCodingPlanSupport: async () => ({
              supported: true as const,
              kind: "zai-personal" as const,
              providerFamily: "zai" as const,
              providerId: OFF_PEAK_PROVIDER_IDS.zai,
            }),
            createTask: vi.fn(),
            list: vi.fn(),
          }),
        }),
  });
  return { service, request, getClient, resolveConfig };
}

function policyCalls(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.filter(
    ([method]) => method === zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy,
  );
}

describe("workspace/updateOffPeakToolPolicy 同步（D49-8）", () => {
  it("未装配 Off-Peak 依赖时不发策略请求", async () => {
    const { service, request, getClient } = await setup({ offPeakEnabled: undefined });
    await expect(service.initialize({ workspacePath: "/workspace/app" })).resolves.toEqual(
      expect.objectContaining({ available: true }),
    );
    expect(getClient).toHaveBeenCalled();
    expect(policyCalls(request)).toHaveLength(0);
    service.disposeAll();
  });

  it("灰度关闭仍注册本地工具，不读取远端灰度", async () => {
    const { service, request, resolveConfig } = await setup({ offPeakEnabled: false });
    await service.initialize({ workspacePath: "/workspace/app" });
    expect(policyCalls(request)).toHaveLength(1);
    expect(resolveConfig).not.toHaveBeenCalled();
    service.disposeAll();
  });

  it("灰度开启时在客户端就绪阶段下发 enabled:true", async () => {
    const { service, request } = await setup({ offPeakEnabled: true });
    await service.initialize({ workspacePath: "/workspace/app" });
    const calls = policyCalls(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({
      workspace: expect.objectContaining({ workspacePath: "/workspace/app" }),
      enabled: true,
    });
    service.disposeAll();
  });

  it("远端配置保持 pending 时本地 initialize 仍完成", async () => {
    const { service, resolveConfig } = await setup({
      offPeakEnabled: true,
      configResolver: () => new Promise<OffPeakClientConfig>(() => {}),
    });
    try {
      let ready = false;
      const operation = service.initialize({ workspacePath: "/workspace/app" }).then(() => {
        ready = true;
      });
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 500 });
      await operation;
      expect(resolveConfig).not.toHaveBeenCalled();
    } finally {
      service.disposeAll();
    }
  });

  it.each([
    { remoteSessionId: "remote-session" },
    {
      workspaceIdentity: buildRemoteWorkspaceIdentity("/workspace/app", {
        kind: "ssh",
        host: "test",
        username: "dev",
      }),
    },
  ])("远程工作区不注册也不读取灰度：%j", async (target) => {
    const { service, request, resolveConfig } = await setup({ offPeakEnabled: true });
    try {
      await service.initialize({ workspacePath: "/workspace/app", ...target });
      expect(policyCalls(request)).toHaveLength(0);
      expect(resolveConfig).not.toHaveBeenCalled();
    } finally {
      service.disposeAll();
    }
  });

  it("旧 CLI method-not-found（-32601）降级忽略，不阻塞客户端就绪", async () => {
    const { service, request } = await setup({
      offPeakEnabled: true,
      policyResponse: () => {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      },
    });
    await expect(service.initialize({ workspacePath: "/workspace/app" })).resolves.toEqual(
      expect.objectContaining({ available: true }),
    );
    expect(policyCalls(request)).toHaveLength(1);
    service.disposeAll();
  });

  it("策略同步超时等非 -32601 错误只记 warn，不阻断客户端就绪（机审 SG-02）", async () => {
    const { service, request } = await setup({
      offPeakEnabled: true,
      policyResponse: () => {
        throw new Error("request timed out");
      },
    });
    await expect(service.initialize({ workspacePath: "/workspace/app" })).resolves.toEqual(
      expect.objectContaining({ available: true }),
    );
    expect(policyCalls(request)).toHaveLength(1);
    service.disposeAll();
  });
});
