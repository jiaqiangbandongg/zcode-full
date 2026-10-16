import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IZCodeAgentService,
  ZCodeAgentRunAutomationNowResult,
} from "@zcode/services";
import type { ZCodeAutomation } from "@zcode/shared";
import { useAutomationManagementStore } from "@/store/automationManagementStore.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("automationManagementStore runAutomationNow", () => {
  afterEach(() => {
    useAutomationManagementStore.setState(
      useAutomationManagementStore.getInitialState(),
      true,
    );
  });

  it("连续立即运行同一 automation 时只发送一次 RPC", async () => {
    const pendingRun = deferred<ZCodeAgentRunAutomationNowResult>();
    const agentService = {
      runAutomationNow: vi.fn(() => pendingRun.promise),
      listAllAutomations: vi.fn(async () => []),
    } as unknown as IZCodeAgentService;

    useAutomationManagementStore.setState({
      workspacePath: "/tmp/ws",
      workspaceIdentity: null,
    });

    const first = useAutomationManagementStore
      .getState()
      .runAutomationNow("automation-1", agentService);
    const duplicate = await useAutomationManagementStore
      .getState()
      .runAutomationNow("automation-1", agentService);

    expect(duplicate).toBe("duplicate");
    expect(agentService.runAutomationNow).toHaveBeenCalledTimes(1);

    pendingRun.resolve({ status: "queued" });

    await expect(first).resolves.toBe("queued");
    expect(agentService.listAllAutomations).toHaveBeenCalledTimes(1);
  });

  it("host 拒绝重复立即运行时不再误报 queued 或刷新列表", async () => {
    const agentService = {
      runAutomationNow: vi.fn(async () => ({ status: "duplicate" as const })),
      listAllAutomations: vi.fn(async () => []),
    } as unknown as IZCodeAgentService;

    useAutomationManagementStore.setState({
      workspacePath: "/tmp/ws",
      workspaceIdentity: null,
    });

    await expect(
      useAutomationManagementStore
        .getState()
        .runAutomationNow("automation-1", agentService),
    ).resolves.toBe("duplicate");
    expect(agentService.runAutomationNow).toHaveBeenCalledTimes(1);
    expect(agentService.listAllAutomations).not.toHaveBeenCalled();
  });

  it("RPC 返回后恢复入口，活动 run 的重复触发交由 host 判断", async () => {
    const agentService = {
      runAutomationNow: vi
        .fn()
        .mockResolvedValueOnce({ status: "queued" as const })
        .mockResolvedValueOnce({ status: "duplicate" as const }),
      listAllAutomations: vi.fn(async () => []),
    } as unknown as IZCodeAgentService;

    useAutomationManagementStore.setState({
      workspacePath: "/tmp/ws",
      workspaceIdentity: null,
    });

    await expect(
      useAutomationManagementStore
        .getState()
        .runAutomationNow("automation-1", agentService),
    ).resolves.toBe("queued");
    await expect(
      useAutomationManagementStore
        .getState()
        .runAutomationNow("automation-1", agentService),
    ).resolves.toBe("duplicate");
    expect(agentService.runAutomationNow).toHaveBeenCalledTimes(2);
  });

  it("启停跨项目 automation 时使用 automation 自己的 workspace，并本地翻转状态", async () => {
    const automation = {
      automationId: "automation-remote",
      title: "remote task",
      cronExpr: "*/5 * * * *",
      prompt: "ping",
      workspacePath: "/tmp/remote",
      workspaceIdentity: "ssh://remote/tmp/remote",
      enabled: true,
      lifecycleStatus: "active",
      nextRunAt: Date.now() + 60_000,
      runCount: 0,
      recurring: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies ZCodeAutomation;
    const agentService = {
      setAutomationEnabled: vi.fn(async () => undefined),
      listAllAutomations: vi.fn(async () => [
        { ...automation, enabled: false, lifecycleStatus: "paused" as const },
      ]),
    } as unknown as IZCodeAgentService;

    useAutomationManagementStore.setState({
      workspacePath: "/tmp/current",
      workspaceIdentity: null,
      automations: [automation],
    });

    await useAutomationManagementStore
      .getState()
      .setEnabled("automation-remote", false, agentService);

    expect(agentService.setAutomationEnabled).toHaveBeenCalledWith({
      workspacePath: "/tmp/remote",
      workspaceIdentity: "ssh://remote/tmp/remote",
      automationId: "automation-remote",
      enabled: false,
    });
    expect(useAutomationManagementStore.getState().automations[0]).toEqual(
      expect.objectContaining({
        enabled: false,
        lifecycleStatus: "paused",
      }),
    );
  });
});
