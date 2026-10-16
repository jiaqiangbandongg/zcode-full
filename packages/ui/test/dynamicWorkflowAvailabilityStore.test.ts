// 动态工作流灰度快照在 renderer 的唯一副本（docs/dynamic-workflow/launch.md「Gray release」DWG-07）。
// 只钉三件事：一个 app 会话取一次、失败 fail-closed、换了 service 实例会重试。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import {
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  type DynamicWorkflowClientConfig,
} from "@zcode/shared";
import {
  resetDynamicWorkflowAvailabilityStoreForTests,
  useDynamicWorkflowAvailabilityStore,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

const ENABLED: DynamicWorkflowClientConfig = createDynamicWorkflowClientConfig(
  "alwaysOn",
  "remote",
);
const DISABLED: DynamicWorkflowClientConfig = createDynamicWorkflowClientConfig(
  "disabled",
  "remote",
);

function serviceReturning(config: DynamicWorkflowClientConfig): ICodingPlanSubscriptionService & {
  getDynamicWorkflowClientConfig: ReturnType<typeof vi.fn>;
} {
  return {
    getDynamicWorkflowClientConfig: vi.fn(async () => config),
  } as unknown as ICodingPlanSubscriptionService & {
    getDynamicWorkflowClientConfig: ReturnType<typeof vi.fn>;
  };
}

function serviceFailing(): ICodingPlanSubscriptionService & {
  getDynamicWorkflowClientConfig: ReturnType<typeof vi.fn>;
} {
  return {
    getDynamicWorkflowClientConfig: vi.fn(async () => {
      throw new Error("host unreachable");
    }),
  } as unknown as ICodingPlanSubscriptionService & {
    getDynamicWorkflowClientConfig: ReturnType<typeof vi.fn>;
  };
}

describe("dynamicWorkflowAvailabilityStore", () => {
  beforeEach(() => {
    warn.mockClear();
  });
  afterEach(() => {
    resetDynamicWorkflowAvailabilityStoreForTests();
  });

  it("初值是 loading + 未启用：未知即不提供（fail-closed），入口不会先闪一下再收起", () => {
    const state = useDynamicWorkflowAvailabilityStore.getState();
    expect(state.status).toBe("loading");
    expect(state.enabled).toBe(false);
    expect(state.config).toBeNull();
  });

  it("单飞：并发的 ensureLoaded 只发一次 RPC，结果写进快照", async () => {
    const service = serviceReturning(ENABLED);
    const { ensureLoaded } = useDynamicWorkflowAvailabilityStore.getState();

    await Promise.all([ensureLoaded(service), ensureLoaded(service), ensureLoaded(service)]);

    expect(service.getDynamicWorkflowClientConfig).toHaveBeenCalledTimes(1);
    const state = useDynamicWorkflowAvailabilityStore.getState();
    expect(state.status).toBe("ready");
    expect(state.enabled).toBe(true);
    expect(state.config).toEqual(ENABLED);
  });

  it("同一个 service 已出过结果就不再请求（一个 app 会话取一次）", async () => {
    const service = serviceReturning(ENABLED);
    const { ensureLoaded } = useDynamicWorkflowAvailabilityStore.getState();

    await ensureLoaded(service);
    await ensureLoaded(service);

    expect(service.getDynamicWorkflowClientConfig).toHaveBeenCalledTimes(1);
  });

  it("服务端下发 disabled → enabled false，来源留在快照里供日志区分", async () => {
    const service = serviceReturning(DISABLED);
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service);

    const state = useDynamicWorkflowAvailabilityStore.getState();
    expect(state.status).toBe("ready");
    expect(state.enabled).toBe(false);
    expect(state.config?.source).toBe("remote");
  });

  it("请求失败 → fail-closed 成 disabled 并留一条 warn，不把异常抛给调用方", async () => {
    const service = serviceFailing();

    await expect(
      useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service),
    ).resolves.toBeUndefined();

    const state = useDynamicWorkflowAvailabilityStore.getState();
    expect(state.status).toBe("ready");
    expect(state.enabled).toBe(false);
    expect(state.config).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("失败不粘住：换一份 service（手机 /remote 桥接后 accessor 会换）会重试并纠正", async () => {
    const failing = serviceFailing();
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(failing);
    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(false);

    const bridged = serviceReturning(ENABLED);
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(bridged);

    expect(bridged.getDynamicWorkflowClientConfig).toHaveBeenCalledTimes(1);
    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(true);
  });

  it("refresh 绕过闩并带 forceRefresh，用来在设置变化后重取", async () => {
    const service = serviceReturning(DISABLED);
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service);
    service.getDynamicWorkflowClientConfig.mockResolvedValue(ENABLED);

    await useDynamicWorkflowAvailabilityStore.getState().refresh(service);

    expect(service.getDynamicWorkflowClientConfig).toHaveBeenCalledTimes(2);
    expect(service.getDynamicWorkflowClientConfig).toHaveBeenLastCalledWith({
      forceRefresh: true,
    });
    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(true);
  });

  // DWG-22（launch.md「The user's choice」）：用户改选择后 Host 先重发策略，renderer 再重读快照；
  // 不带 forceRefresh——服务端的「提供」不变，变的只是 Host 套上的用户选择。
  it("reload 绕过闩但不带 forceRefresh，读到 Host 套上用户选择后的生效值", async () => {
    const service = serviceReturning(ENABLED);
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service);
    service.getDynamicWorkflowClientConfig.mockResolvedValue(
      applyDynamicWorkflowUserMode(ENABLED, "disabled"),
    );

    await useDynamicWorkflowAvailabilityStore.getState().reload(service);

    expect(service.getDynamicWorkflowClientConfig).toHaveBeenCalledTimes(2);
    expect(service.getDynamicWorkflowClientConfig).toHaveBeenLastCalledWith({});
    const state = useDynamicWorkflowAvailabilityStore.getState();
    expect(state.enabled).toBe(false);
    expect(state.config).toMatchObject({ mode: "disabled", offeredMode: "alwaysOn" });
  });
});
