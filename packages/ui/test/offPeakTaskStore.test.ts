import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICodingPlanSubscriptionService, IOffPeakTaskService } from "@zcode/services";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type OffPeakTaskCreateResult,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import {
  isCurrentOffPeakCodingPlanSupported,
  isOffPeakQuotaError,
  resolveOffPeakCreateErrorMessageId,
  useOffPeakTaskStore,
} from "@/store/offPeakTaskStore.js";

const createInput = {
  title: "整理改动",
  prompt: "整理今天改动的文件并生成摘要",
  permissionMode: "build",
  workspacePath: "/tmp/workspace",
};

const createdTask = {
  offPeakTaskId: "offpeak-1",
  title: createInput.title,
  prompt: createInput.prompt,
  permissionMode: "build",
  workspaceKey: createInput.workspacePath,
  workspacePath: createInput.workspacePath,
  status: "queued",
  queuedAt: 1,
  createdAt: 1,
  updatedAt: 1,
} satisfies ZCodeOffPeakTask;

const successResult = {
  ok: true,
  task: createdTask,
  ticketInitialState: "queued",
  queuePosition: 2,
  providerName: "api.example.com",
} satisfies OffPeakTaskCreateResult;

describe("offPeakTaskStore createTask", () => {
  afterEach(() => {
    useOffPeakTaskStore.setState(useOffPeakTaskStore.getInitialState(), true);
  });

  it("3103 后刷新服务端额度快照，不保存额度耗尽 boolean", async () => {
    useOffPeakTaskStore.setState({ grayConfig: { enabled: true } as never });
    const service = {
      getCodingPlanSupport: vi.fn(async () => ({ supported: true })),
      createTask: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          failureStage: "ticket_request",
          errorCategory: "quota_3103",
          errorCode: "3103",
          providerName: "api.example.com",
        } satisfies OffPeakTaskCreateResult)
        .mockResolvedValueOnce(successResult),
      list: vi.fn(async () => []),
      getTakeNumberAvailability: vi
        .fn()
        .mockResolvedValueOnce({
          canTakeNumber: false,
          nextTakeAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce({ canTakeNumber: true }),
    } as unknown as IOffPeakTaskService;

    await expect(
      useOffPeakTaskStore.getState().createTask(createInput, service),
    ).resolves.toMatchObject({ ok: false, errorCategory: "quota_3103" });

    expect(useOffPeakTaskStore.getState().error).toBe("quota_3103");
    expect(useOffPeakTaskStore.getState()).not.toHaveProperty("quotaExhausted");
    expect(useOffPeakTaskStore.getState().takeNumberAvailability?.canTakeNumber).toBe(false);
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("ready");
    expect(useOffPeakTaskStore.getState().operationId).toBeNull();

    await expect(
      useOffPeakTaskStore.getState().createTask(createInput, service),
    ).resolves.toMatchObject({ ok: true });
    expect(service.createTask).toHaveBeenCalledTimes(2);
    expect(useOffPeakTaskStore.getState().takeNumberAvailability).toEqual({
      canTakeNumber: true,
    });
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("ready");
  });

  it("initialize 在灰度开启时加载额度快照；查询失败清空快照并 fail-closed", async () => {
    const offPeakTaskService = {
      list: vi.fn(async () => []),
      getCodingPlanSupport: vi.fn(async () => ({
        supported: true,
        kind: "bigmodel-personal",
        providerFamily: "bigmodel",
        providerId: "account:bigmodel-individual-coding-plan",
        selectedConnectionKey: "coding-plan:account:bigmodel-individual-coding-plan",
      })),
      getTakeNumberAvailability: vi
        .fn()
        .mockResolvedValueOnce({ canTakeNumber: false, nextTakeAt: 123_456 })
        .mockRejectedValueOnce(new Error("network down")),
    } as unknown as IOffPeakTaskService;
    const codingPlanSubscriptionService = {
      getOffPeakClientConfig: vi.fn(async () => ({
        enabled: true,
        modelSelectionView: { revision: 1, providers: [] },
      })),
    } as unknown as ICodingPlanSubscriptionService;

    await useOffPeakTaskStore.getState().initialize({
      offPeakTaskService,
      codingPlanSubscriptionService,
    });
    expect(useOffPeakTaskStore.getState().takeNumberAvailability).toEqual({
      canTakeNumber: false,
      nextTakeAt: 123_456,
    });
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("ready");

    await useOffPeakTaskStore.getState().refreshTakeNumberAvailability(offPeakTaskService);
    expect(useOffPeakTaskStore.getState().takeNumberAvailability).toBeNull();
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("error");
  });

  it("并发入口复用同一次 initialize，避免重复 availability 请求互相覆盖", async () => {
    let resolveSupport!: (value: {
      supported: true;
      kind: "bigmodel-team";
      providerFamily: "bigmodel";
      providerId: string;
      selectedConnectionKey: string;
    }) => void;
    const supportPromise = new Promise<Parameters<typeof resolveSupport>[0]>((resolve) => {
      resolveSupport = resolve;
    });
    const offPeakTaskService = {
      list: vi.fn(async () => []),
      getCodingPlanSupport: vi.fn(() => supportPromise),
      getTakeNumberAvailability: vi.fn(async () => ({ canTakeNumber: true })),
    } as unknown as IOffPeakTaskService;
    const codingPlanSubscriptionService = {
      getOffPeakClientConfig: vi.fn(async () => ({
        enabled: true,
        modelSelectionView: { revision: 1, providers: [] },
      })),
    } as unknown as ICodingPlanSubscriptionService;
    const dependencies = { offPeakTaskService, codingPlanSubscriptionService };

    const first = useOffPeakTaskStore.getState().initialize(dependencies);
    const second = useOffPeakTaskStore.getState().initialize(dependencies);
    resolveSupport({
      supported: true,
      kind: "bigmodel-team",
      providerFamily: "bigmodel",
      providerId: "account:bigmodel-individual-coding-plan",
      selectedConnectionKey: "team-plan:connection",
    });
    await Promise.all([first, second]);

    expect(offPeakTaskService.getCodingPlanSupport).toHaveBeenCalledOnce();
    expect(offPeakTaskService.getTakeNumberAvailability).toHaveBeenCalledOnce();
    expect(codingPlanSubscriptionService.getOffPeakClientConfig).toHaveBeenCalledOnce();
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("ready");
  });

  it("创建遇到临时依赖异常后关闭准入，直到 availability 成功刷新", async () => {
    useOffPeakTaskStore.setState({ grayConfig: { enabled: true } as never });
    const service = {
      getCodingPlanSupport: vi.fn(async () => ({ supported: true })),
      createTask: vi.fn().mockResolvedValue({
        ok: false,
        failureStage: "ticket_request",
        errorCategory: "network",
        errorCode: "2007",
        providerName: "api.example.com",
      } satisfies OffPeakTaskCreateResult),
      getTakeNumberAvailability: vi.fn(async () => ({ canTakeNumber: true })),
    } as unknown as IOffPeakTaskService;

    useOffPeakTaskStore.setState({
      takeNumberAvailability: { canTakeNumber: true },
      takeNumberAvailabilityStatus: "ready",
    });

    await expect(
      useOffPeakTaskStore.getState().createTask(createInput, service),
    ).resolves.toMatchObject({ ok: false, errorCategory: "network" });
    expect(useOffPeakTaskStore.getState().takeNumberAvailability).toBeNull();
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("error");

    await useOffPeakTaskStore.getState().refreshTakeNumberAvailability(service);
    expect(useOffPeakTaskStore.getState().takeNumberAvailability).toEqual({
      canTakeNumber: true,
    });
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("ready");
  });

  it("unsupported selected connection 不调用 availability，避免 UI 与 ticket resolver 分叉", async () => {
    const offPeakTaskService = {
      list: vi.fn(async () => []),
      getCodingPlanSupport: vi.fn(async () => ({
        supported: false,
        reason: "start_plan_not_supported",
      })),
      getTakeNumberAvailability: vi.fn(async () => ({ canTakeNumber: true })),
    } as unknown as IOffPeakTaskService;
    const codingPlanSubscriptionService = {
      getOffPeakClientConfig: vi.fn(async () => ({
        enabled: true,
        modelSelectionView: { revision: 1, providers: [] },
      })),
    } as unknown as ICodingPlanSubscriptionService;

    await useOffPeakTaskStore.getState().initialize({
      offPeakTaskService,
      codingPlanSubscriptionService,
    });

    expect(useOffPeakTaskStore.getState().codingPlanSupport).toEqual({
      supported: false,
      reason: "start_plan_not_supported",
    });
    expect(offPeakTaskService.getTakeNumberAvailability).not.toHaveBeenCalled();
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("idle");
  });
});

describe("Off-Peak 创建错误展示", () => {
  it.each([
    ["quota_3103", "3103", "offPeak.error.quota", true],
    ["network", "2007", "offPeak.error.unavailable", false],
    ["invalid_response", "", "offPeak.error.unavailable", false],
    ["local_persist", "", "offPeak.error.generic", false],
  ] as const)("按结构化分类映射：%s", (errorCategory, errorCode, expectedId, quota) => {
    const result = {
      ok: false,
      failureStage: errorCategory === "local_persist" ? "local_persist" : "ticket_request",
      errorCategory,
      errorCode,
      providerName: "",
    } satisfies OffPeakTaskCreateResult;
    expect(resolveOffPeakCreateErrorMessageId(result)).toBe(expectedId);
    expect(isOffPeakQuotaError(result)).toBe(quota);
  });
});

describe("isCurrentOffPeakCodingPlanSupported", () => {
  const support = {
    supported: true as const,
    kind: "zai-personal" as const,
    providerFamily: "zai" as const,
    providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  };

  it("只接受与 support snapshot 完全一致的当前 family/connection", () => {
    expect(
      isCurrentOffPeakCodingPlanSupported(support, {
        providerFamilyDomain: "zai",
        providerFamilyConnectionSelections: {
          zai: { kind: "individual-coding-plan" },
        },
      }),
    ).toBe(true);

    expect(
      isCurrentOffPeakCodingPlanSupported(support, {
        providerFamilyDomain: "zai",
        providerFamilyConnectionSelections: {
          zai: { kind: "start-plan" },
        },
      }),
    ).toBe(false);
    expect(
      isCurrentOffPeakCodingPlanSupported(support, {
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: {
          bigmodel: { kind: "individual-coding-plan" },
        },
      }),
    ).toBe(false);
  });
});
