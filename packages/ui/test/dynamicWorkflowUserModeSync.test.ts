// @vitest-environment jsdom
// DWG-22（docs/dynamic-workflow/launch.md「The user's choice」）：设置里的选择变化后，本窗口 Root
// 先让 Host 重发策略，再重读快照；首次读到的值只是基线，不发信号。多次变化按顺序串行。
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import {
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
} from "@zcode/shared";
import { useDynamicWorkflowUserModeSync } from "@/hooks/useDynamicWorkflowAvailability.js";
import {
  resetDynamicWorkflowAvailabilityStoreForTests,
  useDynamicWorkflowAvailabilityStore,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OFFER = createDynamicWorkflowClientConfig("alwaysOn", "remote");

function setup() {
  const events: string[] = [];
  let currentChoice: DynamicWorkflowMode | undefined;
  const zcodeAgentService = {
    syncDynamicWorkflowUserMode: vi.fn(async (params: { mode?: DynamicWorkflowMode }) => {
      events.push(`sync:${params.mode ?? "follow"}`);
    }),
  };
  const codingPlanSubscriptionService = {
    getDynamicWorkflowClientConfig: vi.fn(async () => {
      events.push("reload");
      return applyDynamicWorkflowUserMode(OFFER, currentChoice);
    }),
  } as unknown as ICodingPlanSubscriptionService;
  const hook = renderHook(
    (props: { settingsLoaded: boolean; userMode: DynamicWorkflowMode | undefined }) => {
      currentChoice = props.userMode;
      useDynamicWorkflowUserModeSync({
        ...props,
        zcodeAgentService,
        codingPlanSubscriptionService,
      });
    },
    { initialProps: { settingsLoaded: false, userMode: undefined } },
  );
  return { events, hook, zcodeAgentService };
}

describe("useDynamicWorkflowUserModeSync（DWG-22）", () => {
  afterEach(() => {
    cleanup();
    resetDynamicWorkflowAvailabilityStoreForTests();
  });

  it("设置未加载与首次读到的值都不发信号", () => {
    const { events, hook } = setup();
    hook.rerender({ settingsLoaded: true, userMode: "onDemand" });
    expect(events).toEqual([]);
  });

  it("选择变化：先让 Host 重发策略，再重读快照；回到跟随时发不带 mode 的信号", async () => {
    const { events, hook } = setup();
    hook.rerender({ settingsLoaded: true, userMode: undefined });
    hook.rerender({ settingsLoaded: true, userMode: "disabled" });
    await waitFor(() => expect(events).toEqual(["sync:disabled", "reload"]));
    expect(useDynamicWorkflowAvailabilityStore.getState()).toMatchObject({
      status: "ready",
      enabled: false,
      config: { mode: "disabled", offeredMode: "alwaysOn" },
    });

    hook.rerender({ settingsLoaded: true, userMode: undefined });
    await waitFor(() =>
      expect(events).toEqual(["sync:disabled", "reload", "sync:follow", "reload"]),
    );
    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(true);
  });

  it("连续两次变化串行：第二次信号在第一次重读之后才发", async () => {
    const { events, hook } = setup();
    hook.rerender({ settingsLoaded: true, userMode: undefined });
    hook.rerender({ settingsLoaded: true, userMode: "disabled" });
    hook.rerender({ settingsLoaded: true, userMode: "onDemand" });
    await waitFor(() =>
      expect(events).toEqual(["sync:disabled", "reload", "sync:onDemand", "reload"]),
    );
    expect(useDynamicWorkflowAvailabilityStore.getState().config).toMatchObject({
      mode: "onDemand",
    });
  });

  it("Host 同步失败也会重读快照（快照以 Host 当前结果为准）", async () => {
    const { events, hook, zcodeAgentService } = setup();
    zcodeAgentService.syncDynamicWorkflowUserMode.mockRejectedValueOnce(new Error("host gone"));
    hook.rerender({ settingsLoaded: true, userMode: undefined });
    hook.rerender({ settingsLoaded: true, userMode: "disabled" });
    await waitFor(() => expect(events).toEqual(["reload"]));
  });
});
