import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICodingPlanSubscriptionService, IOffPeakTaskService } from "@zcode/services";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const team = {
  supported: true,
  kind: "bigmodel-team",
  providerFamily: "bigmodel",
  providerId: "account:bigmodel-team-coding-plan",
  selectedConnectionKey: "team-plan:test",
};

function fixture() {
  const service = {
    list: vi.fn(async () => []),
    getCodingPlanSupport: vi.fn().mockResolvedValue(team),
    getTakeNumberAvailability: vi.fn().mockResolvedValue({ canTakeNumber: true }),
  };
  useOffPeakTaskStore.setState({ grayConfig: { enabled: true } as never });
  return { service, port: service as unknown as IOffPeakTaskService };
}

afterEach(() => useOffPeakTaskStore.setState(useOffPeakTaskStore.getInitialState(), true));

describe("闲时同代资格刷新", () => {
  it.each(["support", "availability"] as const)(
    "%s 在途时合并刷新；旧成功不能开放入口",
    async (phase) => {
      const { service, port } = fixture();
      const old = deferred<unknown>();
      const latest = deferred<unknown>();
      if (phase === "support") service.getCodingPlanSupport.mockReturnValueOnce(old.promise);
      else service.getTakeNumberAvailability.mockReturnValueOnce(old.promise);
      service.getCodingPlanSupport.mockReturnValueOnce(latest.promise);
      // availability 场景第一份资格必须先通过，再阻塞在旧额度。
      if (phase === "availability")
        service.getCodingPlanSupport
          .mockReset()
          .mockResolvedValueOnce(team)
          .mockReturnValueOnce(latest.promise);
      const first = useOffPeakTaskStore.getState().refreshCodingPlanSupport(port);
      await vi.waitFor(() =>
        expect(
          phase === "support" ? service.getCodingPlanSupport : service.getTakeNumberAvailability,
        ).toHaveBeenCalledOnce(),
      );
      const second = useOffPeakTaskStore.getState().refreshCodingPlanSupport(port);
      const third = useOffPeakTaskStore.getState().refreshTakeNumberAvailability(port);
      expect(service.getCodingPlanSupport).toHaveBeenCalledOnce();
      old.resolve(phase === "support" ? team : { canTakeNumber: true });
      await vi.waitFor(() => expect(service.getCodingPlanSupport).toHaveBeenCalledTimes(2));
      expect(useOffPeakTaskStore.getState()).toMatchObject({
        codingPlanSupport: null,
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "loading",
      });
      latest.resolve({ supported: false });
      await Promise.all([first, second, third]);
      expect(useOffPeakTaskStore.getState()).toMatchObject({
        codingPlanSupport: { supported: false },
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "idle",
      });
      expect(service.getTakeNumberAvailability).toHaveBeenCalledTimes(phase === "support" ? 0 : 1);
    },
  );

  it("旧错误不覆盖新检查，当前错误关闭入口；手动刷新重新检查资格", async () => {
    const { service, port } = fixture();
    const old = deferred<unknown>();
    const latest = deferred<unknown>();
    service.getCodingPlanSupport
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    const states: string[] = [];
    const unsubscribe = useOffPeakTaskStore.subscribe((state) =>
      states.push(state.takeNumberAvailabilityStatus),
    );
    const first = useOffPeakTaskStore.getState().refreshCodingPlanSupport(port);
    await vi.waitFor(() => expect(service.getCodingPlanSupport).toHaveBeenCalledOnce());
    const second = useOffPeakTaskStore.getState().refreshCodingPlanSupport(port);
    old.reject(new Error("obsolete"));
    await vi.waitFor(() => expect(service.getCodingPlanSupport).toHaveBeenCalledTimes(2));
    expect(states).not.toContain("error");
    latest.resolve(team);
    await Promise.all([first, second]);
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("ready");
    service.getCodingPlanSupport.mockRejectedValueOnce(new Error("current"));
    await useOffPeakTaskStore.getState().refreshTakeNumberAvailability(port);
    expect(useOffPeakTaskStore.getState().takeNumberAvailabilityStatus).toBe("error");
    expect(service.getTakeNumberAvailability).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("双入口相同通知去重，灰度初始化完成后只查最新代", async () => {
    const { service, port } = fixture();
    const config = deferred<{ enabled: boolean }>();
    const deps = {
      offPeakTaskService: port,
      codingPlanSubscriptionService: {
        getOffPeakClientConfig: () => config.promise,
      } as unknown as ICodingPlanSubscriptionService,
    };
    const first = useOffPeakTaskStore.getState().initialize(deps);
    const second = useOffPeakTaskStore.getState().initialize(deps);
    const third = useOffPeakTaskStore.getState().refreshCodingPlanSupport(port, "registry:2");
    const fourth = useOffPeakTaskStore.getState().refreshCodingPlanSupport(port, "registry:2");
    config.resolve({ enabled: true });
    await Promise.all([first, second, third, fourth]);
    expect(service.getCodingPlanSupport).toHaveBeenCalledOnce();
    expect(service.getTakeNumberAvailability).toHaveBeenCalledOnce();
    await useOffPeakTaskStore.getState().refreshCodingPlanSupport(port, "registry:2");
    expect(service.getCodingPlanSupport).toHaveBeenCalledOnce();
    service.getCodingPlanSupport.mockResolvedValueOnce({ supported: false });
    await useOffPeakTaskStore.getState().refreshCodingPlanSupport(port, "registry:3");
    expect(service.getCodingPlanSupport).toHaveBeenCalledTimes(2);
    expect(service.getTakeNumberAvailability).toHaveBeenCalledOnce();
  });
});
