import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { utilityProcess as electronUtilityProcess } from "electron";
import { hostCronRunMessageSchema, hostOffPeakRunMessageSchema } from "@zcode/shared";
import { spawnCronScheduler } from "../src/main/desktopCronScheduler.js";

vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
}));

vi.mock("../src/main/desktopRuntimeEnv.js", () => ({
  buildHostProcessEnv: vi.fn(() => ({})),
  schedulerModulePath: "/tmp/zcode-scheduler.js",
}));

class MockSchedulerProcess extends EventEmitter {
  pid: number | undefined = 12345;
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}

describe("desktopCronScheduler", () => {
  it.each(["cron", "offpeak"] as const)(
    "forwards and validates the saved %s project directory snapshot",
    async (kind) => {
      const child = new MockSchedulerProcess();
      const host = { postMessage: vi.fn() };
      vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);
      const scheduler = spawnCronScheduler({
        hostProcessLocalEnv: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        resolveDispatchHost: () => host as never,
      });
      const execution = {
        workspacePath: "/frozen",
        workspaceIdentity: "remote:server:s:/frozen",
        projectId: "p",
        hostId: "remote:server:s",
        additionalDirectories: [],
      };
      child.emit("message", {
        ...execution,
        type: `${kind}-dispatch-request`,
        prompt: "run",
        ...(kind === "cron"
          ? { automationId: "a", runId: "r" }
          : {
              offPeakTaskId: "o",
              permissionMode: "default",
              modelSelection: { providerId: "p", modelId: "m" },
            }),
      });
      const frame = host.postMessage.mock.calls[0]?.[0];
      expect(frame).toMatchObject(execution);
      expect(
        (kind === "cron" ? hostCronRunMessageSchema : hostOffPeakRunMessageSchema).parse(frame),
      ).toMatchObject(execution);
      const disposing = scheduler.dispose();
      child.emit("exit", 0);
      await disposing;
    },
  );

  it("立即执行时直接向 scheduler 发送 wake 消息", () => {
    const child = new MockSchedulerProcess();
    vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);

    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      resolveDispatchHost: () => null,
    });

    scheduler.wake("automation-1");

    expect(child.postMessage).toHaveBeenCalledWith({
      type: "scheduler-wake",
      automationId: "automation-1",
    });
  });

  it("进入退出状态后停止向 Host 派发新任务", async () => {
    const child = new MockSchedulerProcess();
    const host = { postMessage: vi.fn() };
    vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);
    const scheduler = spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveDispatchHost: () => host as never,
    });

    const disposing = scheduler.dispose();
    child.emit("message", {
      type: "cron-dispatch-request",
      runId: "run-after-dispose",
      automationId: "automation-1",
      prompt: "test",
      workspacePath: "C:/repo",
    });

    expect(host.postMessage).not.toHaveBeenCalled();
    expect(child.postMessage).toHaveBeenCalledWith({
      type: "cron-dispatch-result",
      runId: "run-after-dispose",
      ok: false,
      failureKind: "transient",
      error: "app is shutting down",
    });
    child.emit("exit", 0);
    await disposing;
  });

  it("把 scheduler 自采样本交给资源遥测来源，非法样本丢弃", async () => {
    const { selfHeapProcessResourceSampleSource } =
      await import("../src/main/processResourceSelfHeapSource.js");
    selfHeapProcessResourceSampleSource.reset?.();
    const child = new MockSchedulerProcess();
    vi.mocked(electronUtilityProcess.fork).mockReturnValue(child as never);
    spawnCronScheduler({
      hostProcessLocalEnv: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveDispatchHost: () => null,
    });

    // 字段缺失的样本在 main 入口丢弃，不抛错。
    expect(() =>
      child.emit("message", {
        type: "scheduler-resource-sample",
        sample: { cpuPercent: 1, rssKb: 122_880 },
      }),
    ).not.toThrow();
    child.emit("message", {
      type: "scheduler-resource-sample",
      sample: { cpuPercent: 1, rssKb: 122_880, heapUsedKb: 24_576 },
    });

    const heapSamples: Array<[string, number]> = [];
    selfHeapProcessResourceSampleSource.sample?.({
      now: 0,
      addRoleSample: () => {},
      addRoleHeapSample: (role, heapUsedKb) => heapSamples.push([role, heapUsedKb]),
      addAppProcessTotals: () => {},
    });

    expect(heapSamples).toEqual([["scheduler", 24_576]]);
  });
});
