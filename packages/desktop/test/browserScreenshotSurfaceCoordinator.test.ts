import { describe, expect, it, vi } from "vitest";
import { DesktopBrowserScreenshotSurfaceCoordinator } from "../src/main/browserView/browserScreenshotSurfaceCoordinator.js";

const input = {
  requestId: "shot-1",
  windowId: 7,
  workspaceKey: "remote:ssh:dev:/repo",
  sessionId: "sess-1",
  browserId: "browser-1",
  browserGeneration: 4,
  tabId: "tab-1",
  webContentsId: 42,
  viewport: { width: 1274, height: 720 },
  surfaceScale: 1,
};

describe("DesktopBrowserScreenshotSurfaceCoordinator", () => {
  it("只接受同 window/sender/request/guest 且 viewport 误差不超过 1px 的 ready", async () => {
    const sendPrepare = vi.fn(() => true);
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare,
      sendRelease,
      timeoutMs: 100,
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    coordinator.handleReady({
      windowId: 7,
      senderWebContentsId: 700,
      payload: {
        ...input,
        surfaceScale: 0.625,
        viewport: { width: 1275, height: 719 },
      },
    });

    const lease = await pending;
    expect(lease).toMatchObject({
      surfaceScale: 0.625,
      webContentsId: 42,
      viewport: { width: 1275, height: 719 },
    });
    lease.release();
    lease.release();
    expect(sendRelease).toHaveBeenCalledTimes(1);
  });

  it("相同 guest 的自然和仿真 viewport 不共用 lease，并拒绝错误 mode 的 ready", async () => {
    const sendPrepare = vi.fn(() => true);
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare,
      sendRelease,
    });
    const natural = { ...input, viewportMode: "natural" as const };
    const emulated = { ...input, requestId: "emulated-shot", viewportMode: "emulated" as const };
    const pending = coordinator.prepare({ ...natural, signal: new AbortController().signal });
    const next = coordinator.prepare({ ...emulated, signal: new AbortController().signal });
    expect(sendPrepare).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ viewportMode: "natural" }),
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    await Promise.resolve();
    expect(settled).toBe(false);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: natural });
    const lease = await pending;
    expect(sendPrepare).toHaveBeenCalledTimes(1);
    lease.release();
    expect(sendRelease.mock.calls[0]?.[1]).not.toHaveProperty("viewportMode");
    expect(sendPrepare).toHaveBeenCalledTimes(2);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: emulated });
    (await next).release();
    coordinator.dispose();
  });

  it("默认 3000ms timeout 会 release，迟到 ready 不能复活请求", async () => {
    vi.useFakeTimers();
    const sendPrepare = vi.fn(() => true);
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare,
      sendRelease,
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    expect(sendPrepare).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ requestId: "shot-1", timeoutMs: 3000 }),
    );
    let rejection: unknown;
    void pending.catch((error: unknown) => {
      rejection = error;
    });

    await vi.advanceTimersByTimeAsync(2999);
    expect(rejection).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(rejection).toEqual(
      new Error("browser screenshot surface preparation timed out after 3000ms"),
    );
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    expect(sendRelease).toHaveBeenCalledTimes(1);
    expect(sendRelease.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
    vi.useRealTimers();
  });

  it("忽略错误 sender 和 window 的 ready", async () => {
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare: () => true,
      sendRelease: vi.fn(),
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    coordinator.handleReady({ windowId: 8, senderWebContentsId: 700, payload: input });
    coordinator.handleReady({
      windowId: 7,
      senderWebContentsId: 700,
      payload: { ...input, viewport: { width: 1277, height: 720 } },
    });
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 701, payload: input });

    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    const lease = await pending;
    lease.release();
  });

  it("viewport 不匹配后继续等待同一可信 sender 的下一次 ready", async () => {
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare: () => true,
      sendRelease: vi.fn(),
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    coordinator.handleReady({
      windowId: 7,
      senderWebContentsId: 700,
      payload: { ...input, viewport: { width: 1277, height: 720 } },
    });
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });

    const lease = await pending;
    lease.release();
  });

  it("surfaceScale 非法时继续等待同一可信 renderer 的下一次 ready", async () => {
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare: () => true,
      sendRelease: vi.fn(),
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    for (const surfaceScale of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      coordinator.handleReady({
        windowId: 7,
        senderWebContentsId: 700,
        payload: { ...input, surfaceScale },
      });
    }
    await Promise.resolve();
    expect(settled).toBe(false);

    coordinator.handleReady({
      windowId: 7,
      senderWebContentsId: 700,
      payload: { ...input, surfaceScale: 1 },
    });
    const lease = await pending;
    expect(lease.surfaceScale).toBe(1);
    lease.release();
  });

  it("BVR09: unscaled 请求只接受 100% surface，并在 release 中移除瞬时比例模式", async () => {
    const sendPrepare = vi.fn(() => true);
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare,
      sendRelease,
    });
    const unscaledInput = {
      ...input,
      surfaceScaleMode: "unscaled" as const,
      signal: new AbortController().signal,
    };
    const pending = coordinator.prepare(unscaledInput);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    expect(sendPrepare).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ surfaceScaleMode: "unscaled" }),
    );
    coordinator.handleReady({
      windowId: 7,
      senderWebContentsId: 700,
      payload: { ...unscaledInput, surfaceScale: 0.625 },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    coordinator.handleReady({
      windowId: 7,
      senderWebContentsId: 700,
      payload: { ...unscaledInput, surfaceScale: 1 },
    });
    const lease = await pending;
    expect(lease.surfaceScale).toBe(1);
    lease.release();
    expect(sendRelease.mock.calls[0]?.[1]).not.toHaveProperty("surfaceScaleMode");
  });

  it("同 guest 并发复用一次 prepare，并在全部 lease 释放后再 release", async () => {
    const sendPrepare = vi.fn(() => true);
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare,
      sendRelease,
    });
    const first = coordinator.prepare({ ...input, signal: new AbortController().signal });
    const second = coordinator.prepare({
      ...input,
      requestId: "shot-2",
      signal: new AbortController().signal,
    });

    expect(sendPrepare).toHaveBeenCalledTimes(1);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    const [firstLease, secondLease] = await Promise.all([first, second]);
    const internal = coordinator as unknown as {
      groupsByGuestKey: Map<string, { leaseCount?: number; leaseReleases: Set<() => void> }>;
      pendingByRequestId?: Map<string, unknown>;
    };
    const [group] = internal.groupsByGuestKey.values();
    expect(internal).not.toHaveProperty("pendingByRequestId");
    expect(group).not.toHaveProperty("leaseCount");
    expect(group?.leaseReleases.size).toBe(2);
    firstLease.release();
    expect(group?.leaseReleases.size).toBe(1);
    expect(sendRelease).not.toHaveBeenCalled();
    secondLease.release();
    expect(sendRelease).toHaveBeenCalledTimes(1);
  });

  it("active group 在 prepare 前持有一份 screenshot activity lease，全部释放后归还", async () => {
    const events: string[] = [];
    const activityRelease = vi.fn(() => events.push("activity-release"));
    const markPrepared = vi.fn(() => events.push("activity-prepared"));
    const acquireActivity = vi.fn(() => {
      events.push("activity-acquire");
      return { markPrepared, release: activityRelease };
    });
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      acquireActivity,
      sendPrepare: () => {
        events.push("prepare");
        return true;
      },
      sendRelease: () => events.push("surface-release"),
    });
    const first = coordinator.prepare({ ...input, signal: new AbortController().signal });
    const second = coordinator.prepare({
      ...input,
      requestId: "shot-2",
      signal: new AbortController().signal,
    });

    expect(events).toEqual(["activity-acquire", "prepare"]);
    expect(acquireActivity).toHaveBeenCalledTimes(1);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    const [firstLease, secondLease] = await Promise.all([first, second]);
    expect(markPrepared).toHaveBeenCalledOnce();
    firstLease.release();
    expect(activityRelease).not.toHaveBeenCalled();
    secondLease.release();
    expect(events).toEqual([
      "activity-acquire",
      "prepare",
      "activity-prepared",
      "surface-release",
      "activity-release",
    ]);
  });

  it("activity capture 失败时立即拒绝 prepare，不等待 renderer timeout", async () => {
    vi.useFakeTimers();
    const activityController = new AbortController();
    const activityRelease = vi.fn();
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      acquireActivity: () => ({
        invalidated: activityController.signal,
        release: activityRelease,
      }),
      sendPrepare: () => true,
      sendRelease,
      timeoutMs: 1500,
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    const rejected = expect(pending).rejects.toThrow("capture failed");

    activityController.abort(new Error("browser screenshot activity capture failed"));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(sendRelease).toHaveBeenCalledOnce();
    expect(activityRelease).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("Ready 后 activity 失败会使已交付 surface lease 失效", async () => {
    const activityController = new AbortController();
    const activityRelease = vi.fn();
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      acquireActivity: () => ({
        invalidated: activityController.signal,
        markPrepared: vi.fn(),
        release: activityRelease,
      }),
      sendPrepare: () => true,
      sendRelease,
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    const lease = await pending;

    expect(lease.invalidated?.aborted).toBe(false);
    activityController.abort(new Error("browser screenshot activity capture failed"));
    expect(lease.invalidated?.aborted).toBe(true);
    expect(sendRelease).toHaveBeenCalledOnce();
    expect(activityRelease).toHaveBeenCalledOnce();
    lease.release();
  });

  it("排队 group 不提前持有 activity lease，前一 group 释放后无节流抖动地接棒", async () => {
    const acquireActivity = vi.fn(() => ({ release: vi.fn() }));
    const sendPrepare = vi.fn(() => true);
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      acquireActivity,
      sendPrepare,
      sendRelease: vi.fn(),
    });
    const first = coordinator.prepare({ ...input, signal: new AbortController().signal });
    const secondInput = { ...input, requestId: "shot-2", webContentsId: 43, tabId: "tab-2" };
    const second = coordinator.prepare({
      ...secondInput,
      signal: new AbortController().signal,
    });

    expect(acquireActivity).toHaveBeenCalledTimes(1);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    (await first).release();
    expect(acquireActivity).toHaveBeenCalledTimes(2);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: secondInput });
    (await second).release();
  });

  it("ready 后 signal abort 自动释放 surface/activity，不等待 backend finally", async () => {
    const controller = new AbortController();
    const activityRelease = vi.fn();
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      acquireActivity: () => ({ release: activityRelease }),
      sendPrepare: () => true,
      sendRelease,
    });
    const pending = coordinator.prepare({ ...input, signal: controller.signal });
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    const lease = await pending;

    controller.abort();
    expect(sendRelease).toHaveBeenCalledTimes(1);
    expect(activityRelease).toHaveBeenCalledTimes(1);
    lease.release();
    expect(sendRelease).toHaveBeenCalledTimes(1);
    expect(activityRelease).toHaveBeenCalledTimes(1);
  });

  it("activity watchdog 强制释放 ready 后挂起的 group，迟到 lease release 保持幂等", async () => {
    vi.useFakeTimers();
    const activityRelease = vi.fn();
    const sendRelease = vi.fn();
    const warn = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      acquireActivity: () => ({ release: activityRelease }),
      sendPrepare: () => true,
      sendRelease,
      activityTimeoutMs: 35_000,
      warn,
    });
    const pending = coordinator.prepare({ ...input, signal: new AbortController().signal });
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    const lease = await pending;

    await vi.advanceTimersByTimeAsync(35_000);
    expect(sendRelease).toHaveBeenCalledTimes(1);
    expect(activityRelease).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("watchdog"));
    lease.release();
    expect(activityRelease).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("recording 可为当前 surface lease 请求更长但仍有界的 activity watchdog", async () => {
    vi.useFakeTimers();
    const activityRelease = vi.fn();
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      acquireActivity: () => ({ release: activityRelease }),
      sendPrepare: () => true,
      sendRelease,
      activityTimeoutMs: 35_000,
    });
    const pending = coordinator.prepare({
      ...input,
      signal: new AbortController().signal,
      activityTimeoutMs: 80_000,
    });
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    const lease = await pending;

    await vi.advanceTimersByTimeAsync(35_000);
    expect(sendRelease).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sendRelease).toHaveBeenCalledTimes(1);
    expect(activityRelease).toHaveBeenCalledTimes(1);
    lease.release();
    vi.useRealTimers();
  });

  it("release transport 抛错仍归还 activity lease 并继续调度下一 group", async () => {
    const activityRelease = vi.fn();
    const sendPrepare = vi.fn(() => true);
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      acquireActivity: () => ({ release: activityRelease }),
      sendPrepare,
      sendRelease: () => {
        throw new Error("window closing");
      },
      log: vi.fn(),
    });
    const first = coordinator.prepare({ ...input, signal: new AbortController().signal });
    const secondInput = { ...input, requestId: "shot-2", webContentsId: 43, tabId: "tab-2" };
    const second = coordinator.prepare({
      ...secondInput,
      signal: new AbortController().signal,
    });
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });

    const firstLease = await first;
    expect(() => firstLease.release()).not.toThrow();
    expect(activityRelease).toHaveBeenCalledTimes(1);
    expect(sendPrepare).toHaveBeenCalledTimes(2);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: secondInput });
    const secondLease = await second;
    expect(() => secondLease.release()).not.toThrow();
  });

  it("ready 后拒绝已取消的同 guest 复用，且不会阻塞下一 guest", async () => {
    const sendPrepare = vi.fn(() => true);
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare,
      sendRelease,
    });
    const first = coordinator.prepare({ ...input, signal: new AbortController().signal });
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    const firstLease = await first;

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      coordinator.prepare({ ...input, requestId: "shot-2", signal: cancelled.signal }),
    ).rejects.toThrow("cancelled");
    expect(sendRelease).not.toHaveBeenCalled();

    const nextInput = { ...input, requestId: "shot-3", webContentsId: 43, tabId: "tab-2" };
    const next = coordinator.prepare({ ...nextInput, signal: new AbortController().signal });
    expect(sendPrepare).toHaveBeenCalledTimes(1);
    firstLease.release();
    expect(sendPrepare).toHaveBeenCalledTimes(2);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: nextInput });
    (await next).release();
  });

  it("同步 ready 后 sendPrepare 抛错不会提前释放有效 lease", async () => {
    const sendRelease = vi.fn();
    let coordinator!: DesktopBrowserScreenshotSurfaceCoordinator;
    let calls = 0;
    const sendPrepare = vi.fn((windowId: number, payload: typeof input) => {
      calls += 1;
      if (calls === 1) {
        coordinator.handleReady({
          windowId,
          senderWebContentsId: 700,
          payload: { ...payload, surfaceScale: 1 },
        });
        throw new Error("sender observed a late transport error");
      }
      return true;
    });
    coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({ sendPrepare, sendRelease });

    const first = coordinator.prepare({ ...input, signal: new AbortController().signal });
    const firstLease = await first;
    const nextInput = { ...input, requestId: "shot-2", webContentsId: 43, tabId: "tab-2" };
    const next = coordinator.prepare({ ...nextInput, signal: new AbortController().signal });

    expect(sendRelease).not.toHaveBeenCalled();
    expect(sendPrepare).toHaveBeenCalledTimes(1);
    firstLease.release();
    expect(sendRelease).toHaveBeenCalledTimes(1);
    expect(sendPrepare).toHaveBeenCalledTimes(2);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: nextInput });
    (await next).release();
  });

  it("不同 guest 的 prepare 串行，前一个 release 后才发送下一个", async () => {
    const sendPrepare = vi.fn(() => true);
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare,
      sendRelease: vi.fn(),
    });
    const first = coordinator.prepare({ ...input, signal: new AbortController().signal });
    const secondInput = { ...input, requestId: "shot-2", webContentsId: 43, tabId: "tab-2" };
    const second = coordinator.prepare({ ...secondInput, signal: new AbortController().signal });

    expect(sendPrepare).toHaveBeenCalledTimes(1);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: input });
    const firstLease = await first;
    firstLease.release();
    expect(sendPrepare).toHaveBeenCalledTimes(2);
    coordinator.handleReady({ windowId: 7, senderWebContentsId: 700, payload: secondInput });
    const secondLease = await second;
    secondLease.release();
  });

  it("window destroyed 和 dispose 都拒绝 pending 并只 release 一次", async () => {
    const sendRelease = vi.fn();
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare: () => true,
      sendRelease,
    });
    const first = coordinator.prepare({ ...input, signal: new AbortController().signal });
    coordinator.handleWindowDestroyed(7);
    await expect(first).rejects.toThrow("window destroyed");
    coordinator.dispose();
    expect(sendRelease).toHaveBeenCalledTimes(1);

    const secondCoordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare: () => true,
      sendRelease,
    });
    const second = secondCoordinator.prepare({ ...input, signal: new AbortController().signal });
    secondCoordinator.dispose();
    await expect(second).rejects.toThrow("disposed");
    expect(sendRelease).toHaveBeenCalledTimes(2);
  });

  it("销毁窗口时先清空同窗口队列，再调度其它窗口", async () => {
    const sendPrepare = vi.fn(() => true);
    const coordinator = new DesktopBrowserScreenshotSurfaceCoordinator({
      sendPrepare,
      sendRelease: vi.fn(),
    });
    const active = coordinator.prepare({ ...input, signal: new AbortController().signal });
    const queued = coordinator.prepare({
      ...input,
      requestId: "shot-2",
      webContentsId: 43,
      tabId: "tab-2",
      signal: new AbortController().signal,
    });
    const activeRejected = expect(active).rejects.toThrow("window destroyed");
    const queuedRejected = expect(queued).rejects.toThrow("window destroyed");

    expect(sendPrepare).toHaveBeenCalledTimes(1);
    coordinator.handleWindowDestroyed(7);
    await Promise.all([activeRejected, queuedRejected]);
    expect(sendPrepare).toHaveBeenCalledTimes(1);

    const otherInput = {
      ...input,
      requestId: "shot-3",
      windowId: 8,
      webContentsId: 44,
      tabId: "tab-3",
    };
    const other = coordinator.prepare({ ...otherInput, signal: new AbortController().signal });
    expect(sendPrepare).toHaveBeenCalledTimes(2);
    coordinator.handleReady({ windowId: 8, senderWebContentsId: 800, payload: otherInput });
    (await other).release();
  });
});
