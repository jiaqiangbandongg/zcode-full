import { describe, expect, it, vi } from "vitest";
import { prepareAccountConnectionSwitch } from "@/root/accountConnectionLossSuggestion.js";

function fixture() {
  let valid = true;
  let settings = {
    providerFamilyDomain: "bigmodel",
    providerFamilyConnectionSelections: {
      bigmodel: {
        kind: "team-coding-plan",
        organizationId: "old-org",
        projectId: "old-project",
        productId: "old-product",
      },
    },
  };
  const view = {
    revision: 1,
    providers: [
      {
        providerId: "account:bigmodel-team-coding-plan",
        accountState: {
          current: true,
          connectionKey: "account/start",
          availability: "unavailable",
        },
      },
      {
        providerId: "account:bigmodel-individual-coding-plan",
        accountState: { current: false, availability: "available" },
      },
    ],
  };
  const services = {
    settingService: {
      get: vi.fn(async () => structuredClone(settings)),
      update: vi.fn(async (patch) => {
        settings = { ...settings, ...patch };
      }),
    },
    providerSettingsService: { getView: vi.fn(async () => view), refresh: vi.fn(async () => view) },
    codingPlanSubscriptionService: {
      getEnterprisePricing: vi.fn(async () => ({ productList: [] })),
    },
    usageStatsService: { getEntitlementSnapshot: vi.fn() },
  };
  const event = {
    providerId: "account:bigmodel-team-coding-plan",
    connectionKey: "account/start",
    isCurrent: () => valid,
  };
  return {
    services,
    event,
    view,
    invalidate: () => {
      valid = false;
    },
  };
}

describe("套餐切换建议", () => {
  it("付费失效时不推荐把全局连接改成 Start", async () => {
    const { services, event, view } = fixture();
    view.providers[1]!.providerId = "account:bigmodel-start-plan";
    expect(await prepareAccountConnectionSwitch(services as never, event)).toBeNull();
    expect(services.settingService.update).not.toHaveBeenCalled();
  });
  it("Team 建议校验具体项目，点击不改成别的 Team", async () => {
    const { services, event, view } = fixture();
    view.providers[1]!.accountState.availability = "unavailable";
    services.codingPlanSubscriptionService.getEnterprisePricing.mockResolvedValue({
      productList: [
        {
          productId: "product",
          subscribed: true,
          teamProjects: [
            { organizationId: "org-a", projectId: "project-a", organizationName: "团队 A" },
            { organizationId: "org-b", projectId: "project-b", organizationName: "团队 B" },
          ],
        },
      ],
    } as never);
    services.usageStatsService.getEntitlementSnapshot.mockImplementation(
      async ({ accountAccess }) =>
        accountAccess.projectId === "project-b"
          ? {
              subscription: {
                identityType: "unknown",
                identityMasked: null,
                details: [{ productId: "product", productName: "团队 B" }],
              },
            }
          : { unavailableReason: "no_plan" },
    );
    const suggestion = await prepareAccountConnectionSwitch(services as never, event);
    expect(suggestion?.label).toBe("团队 B");
    expect(suggestion?.selection).toEqual({
      kind: "team-coding-plan",
      productId: "product",
      organizationId: "org-b",
      projectId: "project-b",
    });
    services.usageStatsService.getEntitlementSnapshot.mockResolvedValue({
      unavailableReason: "no_plan",
    });
    expect(await suggestion?.apply()).toBe("stale");
    expect(services.settingService.update).not.toHaveBeenCalled();
  });
  it("写入成功而刷新失败仍返回已保存", async () => {
    const { services, event, view } = fixture();
    const suggestion = await prepareAccountConnectionSwitch(services as never, event);
    services.providerSettingsService.refresh
      .mockResolvedValueOnce(view)
      .mockRejectedValueOnce(new Error("offline"));
    expect(await suggestion?.apply()).toBe("switched");
    expect(services.settingService.update).toHaveBeenCalledOnce();
  });
  it("点击等待刷新期间切换意图或重复点击，不提交旧建议", async () => {
    const { services, event, view, invalidate } = fixture();
    const suggestion = await prepareAccountConnectionSwitch(services as never, event);
    let finish!: (value: typeof view) => void;
    services.providerSettingsService.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = suggestion!.apply();
    expect(await suggestion!.apply()).toBe("stale");
    invalidate();
    finish(view);
    expect(await pending).toBe("stale");
    expect(services.settingService.update).not.toHaveBeenCalled();
  });
  it("计算不写入，只有点击才条件保存，重复点击不重复写", async () => {
    const { services, event } = fixture();
    const suggestion = await prepareAccountConnectionSwitch(services as never, event);
    expect(suggestion?.selection).toEqual({ kind: "individual-coding-plan" });
    expect(services.settingService.update).not.toHaveBeenCalled();
    expect(await suggestion?.apply()).toBe("switched");
    expect(services.settingService.update).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
      }),
      expect.objectContaining({
        providerFamilyConnectionSelections: {
          bigmodel: {
            kind: "team-coding-plan",
            organizationId: "old-org",
            projectId: "old-project",
            productId: "old-product",
          },
        },
      }),
    );
    await suggestion?.apply();
    expect(services.settingService.update).toHaveBeenCalledTimes(1);
  });
  it.each(["intent", "recovered", "target"])("%s 改变后旧按钮不再提交", async (kind) => {
    const { services, event, view, invalidate } = fixture();
    const suggestion = await prepareAccountConnectionSwitch(services as never, event);
    if (kind === "intent") invalidate();
    if (kind === "recovered") view.providers[0]!.accountState.availability = "available";
    if (kind === "target") view.providers[1]!.accountState.availability = "unavailable";
    expect(await suggestion?.apply()).toBe("stale");
    expect(services.settingService.update).not.toHaveBeenCalled();
  });
  it("没有可用目标不把购买入口当替代", async () => {
    const { services, event, view } = fixture();
    view.providers[1]!.accountState.availability = "unavailable";
    expect(await prepareAccountConnectionSwitch(services as never, event)).toBeNull();
    expect(services.settingService.update).not.toHaveBeenCalled();
  });
  it("保存失败抛出操作错误而不是宣称成功", async () => {
    const { services, event } = fixture();
    services.settingService.update.mockRejectedValueOnce(new Error("disk"));
    const suggestion = await prepareAccountConnectionSwitch(services as never, event);
    await expect(suggestion?.apply()).rejects.toThrow("disk");
  });
});
