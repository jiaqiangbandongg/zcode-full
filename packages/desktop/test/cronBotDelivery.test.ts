import { describe, expect, it, vi } from "vitest";
import { watchCronRunBotDelivery } from "../src/host/cronBotDelivery.js";

describe("watchCronRunBotDelivery", () => {
  it("等待 Bot continuous watcher 完成订阅后才返回给 prompt 派发方", async () => {
    const order: string[] = [];
    let releaseWatcher!: () => void;
    const watcherReady = new Promise<void>((resolve) => {
      releaseWatcher = resolve;
    });
    const target = {
      provider: "weixin" as const,
      botId: "weixin-1",
      providerUserId: "wx_chat_1",
      chatType: "private" as const,
    };
    const repo = {
      getBotDeliveryTarget: vi.fn(async () => target),
    };
    const botsService = {
      watchAutomationRun: vi.fn(async () => {
        order.push("watch-start");
        await watcherReady;
        order.push("watch-ready");
      }),
    };

    const preparing = watchCronRunBotDelivery({
      automationId: "automation-1",
      runId: "cron-run-1",
      workspaceKey: "ssh://host/workspace",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      taskId: "task-1",
      repo,
      botsService,
    }).then(() => order.push("dispatch-ready"));

    await Promise.resolve();
    expect(order).toEqual(["watch-start"]);
    releaseWatcher();
    await preparing;
    expect(order).toEqual(["watch-start", "watch-ready", "dispatch-ready"]);
    expect(repo.getBotDeliveryTarget).toHaveBeenCalledWith("automation-1", "ssh://host/workspace");
    expect(botsService.watchAutomationRun).toHaveBeenCalledWith({
      target,
      runId: "cron-run-1",
      taskId: "task-1",
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
    });
  });

  it("没有 Bot 来源时不创建 watcher", async () => {
    const botsService = { watchAutomationRun: vi.fn() };
    await expect(
      watchCronRunBotDelivery({
        automationId: "automation-1",
        workspaceKey: "/workspace",
        workspacePath: "/workspace",
        taskId: "task-1",
        repo: { getBotDeliveryTarget: vi.fn(async () => undefined) },
        botsService,
      }),
    ).resolves.toBe(false);
    expect(botsService.watchAutomationRun).not.toHaveBeenCalled();
  });
});
