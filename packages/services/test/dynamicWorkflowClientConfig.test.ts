import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, type ApiClient } from "@zcode/shared";
import { BigModelCodingPlanSubscriptionProvider } from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";
import { createCodingPlanSubscriptionService } from "../src/coding-plan-subscription/codingPlanSubscriptionService.js";

// 动态工作流灰度快照的 Host 侧读取（docs/dynamic-workflow/launch.md「Gray release」）：
// 复用 client/configs 通道，本地覆盖短路远端，失败 fail-closed 且不抛给调用方。

function createConfigsResponse(dynamicWorkflow: unknown): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      msg: "",
      data: { configs: dynamicWorkflow === undefined ? {} : { dynamicWorkflow } },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function createProvider(apiClient: ApiClient) {
  return new BigModelCodingPlanSubscriptionProvider({
    apiClient,
    credentialService: { load: vi.fn() },
  });
}

describe("getDynamicWorkflowClientConfig", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("本地覆盖命中时直接返回，不打远端（无 TTL、无首次 Host 竞态）", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "alwaysOn");
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("override must not request remote client config");
      }),
    };
    const provider = createProvider(apiClient);

    await expect(provider.getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "override",
      offeredMode: "alwaysOn",
    });
    await expect(
      provider.getDynamicWorkflowClientConfig({ forceRefresh: true }),
    ).resolves.toMatchObject({ source: "override" });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("覆盖值非法时忽略覆盖，仍读远端", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "on");
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse({ mode: "onDemand" })),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "onDemand",
      enabled: true,
      source: "remote",
      offeredMode: "onDemand",
    });
    expect(apiClient.request).toHaveBeenCalledTimes(1);
  });

  it("远端下发合法 mode 时按远端裁决", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse({ mode: "alwaysOn" })),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "remote",
      offeredMode: "alwaysOn",
    });
  });

  it("远端成功但没有该 key 时视为关闭", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => createConfigsResponse(undefined)),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "disabled",
      enabled: false,
      source: "default",
      offeredMode: "disabled",
    });
  });

  it("命中 1h 快照缓存，forceRefresh 绕过并看到新值", async () => {
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(createConfigsResponse({ mode: "disabled" }))
        .mockResolvedValueOnce(createConfigsResponse({ mode: "alwaysOn" })),
    };
    const provider = createProvider(apiClient);

    await expect(provider.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      enabled: false,
    });
    await expect(provider.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      enabled: false,
    });
    expect(apiClient.request).toHaveBeenCalledTimes(1);

    await expect(
      provider.getDynamicWorkflowClientConfig({ forceRefresh: true }),
    ).resolves.toMatchObject({ mode: "alwaysOn", enabled: true, source: "remote" });
    expect(apiClient.request).toHaveBeenCalledTimes(2);
  });

  it("远端请求失败时 fail-closed 返回 default，不抛给调用方", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("network down");
      }),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "disabled",
      enabled: false,
      source: "default",
      offeredMode: "disabled",
    });
  });

  it("请求失败但本地有覆盖时仍返回覆盖（覆盖先于任何网络动作）", async () => {
    vi.stubEnv(ZCODE_DYNAMIC_WORKFLOW_MODE_ENV, "disabled");
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("network down");
      }),
    };

    await expect(createProvider(apiClient).getDynamicWorkflowClientConfig()).resolves.toEqual({
      mode: "disabled",
      enabled: false,
      source: "override",
      offeredMode: "disabled",
    });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("service 把 options 原样委托给 bigmodel provider", async () => {
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(createConfigsResponse({ mode: "disabled" }))
        .mockResolvedValueOnce(createConfigsResponse({ mode: "alwaysOn" })),
    };
    const service = createCodingPlanSubscriptionService({
      apiClient,
      credentialService: { load: vi.fn() },
    });

    await expect(service.getDynamicWorkflowClientConfig()).resolves.toMatchObject({
      enabled: false,
    });
    await expect(
      service.getDynamicWorkflowClientConfig({ forceRefresh: true }),
    ).resolves.toMatchObject({ enabled: true, source: "remote" });
    expect(apiClient.request).toHaveBeenCalledTimes(2);
  });
});
