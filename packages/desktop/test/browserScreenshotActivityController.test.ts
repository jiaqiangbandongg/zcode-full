import { describe, expect, it, vi } from "vitest";
import { DesktopBrowserScreenshotActivityController } from "../src/main/browserView/browserScreenshotActivityController.js";

function createHarness() {
  const ownerCaptureResolvers: Array<() => void> = [];
  const guestCaptureResolvers: Array<() => void> = [];
  const ownerCapturePage = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        ownerCaptureResolvers.push(resolve);
      }),
  );
  const guestCapturePage = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        guestCaptureResolvers.push(resolve);
      }),
  );
  const ownerWebContents = {
    id: 700,
    isDestroyed: vi.fn(() => false),
    capturePage: ownerCapturePage,
  };
  const guestWebContents = {
    id: 70,
    hostWebContents: ownerWebContents as { id: number },
    isDestroyed: vi.fn(() => false),
    capturePage: guestCapturePage,
  };
  const win = {
    isDestroyed: vi.fn(() => false),
    webContents: ownerWebContents,
  };
  const fromId = vi.fn(() => win);
  const fromWebContentsId = vi.fn(() => guestWebContents);
  const log = vi.fn();
  const controller = new DesktopBrowserScreenshotActivityController({
    fromId,
    fromWebContentsId,
    log,
  });

  return {
    controller,
    fromId,
    fromWebContentsId,
    guestCapturePage,
    guestCaptureResolvers,
    guestWebContents,
    log,
    ownerCapturePage,
    ownerCaptureResolvers,
    ownerWebContents,
    win,
  };
}

async function settleCaptures(harness: ReturnType<typeof createHarness>): Promise<void> {
  for (const resolve of harness.ownerCaptureResolvers.splice(0)) resolve();
  for (const resolve of harness.guestCaptureResolvers.splice(0)) resolve();
  await Promise.resolve();
  for (const resolve of harness.ownerCaptureResolvers.splice(0)) resolve();
  for (const resolve of harness.guestCaptureResolvers.splice(0)) resolve();
  await Promise.resolve();
}

describe("DesktopBrowserScreenshotActivityController", () => {
  function createTransparentBootstrapHarness(options?: {
    allowTransparentWindowBootstrap?: boolean;
    hideTaskbarDuringTransparentWindowBootstrap?: boolean;
    initiallyMinimized?: boolean;
    initiallyVisible?: boolean;
  }) {
    let opacity = 0.72;
    let visible = options?.initiallyVisible ?? false;
    let focused = false;
    let focusListener: (() => void) | undefined;
    const calls: string[] = [];
    const ownerWebContents = {
      id: 700,
      isDestroyed: () => false,
      capturePage: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const win = {
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => visible),
      isMinimized: vi.fn(() => options?.initiallyMinimized ?? false),
      isFocused: vi.fn(() => focused),
      getOpacity: vi.fn(() => opacity),
      setOpacity: vi.fn((nextOpacity: number) => {
        calls.push(`opacity:${nextOpacity}`);
        opacity = nextOpacity;
      }),
      setSkipTaskbar: vi.fn((skip: boolean) => {
        calls.push(`skipTaskbar:${skip}`);
      }),
      showInactive: vi.fn(() => {
        calls.push("showInactive");
        visible = true;
      }),
      hide: vi.fn(() => {
        calls.push("hide");
        visible = false;
      }),
      on: vi.fn((event: "focus", listener: () => void) => {
        if (event === "focus") focusListener = listener;
      }),
      removeListener: vi.fn((event: "focus", listener: () => void) => {
        if (event === "focus" && focusListener === listener) focusListener = undefined;
      }),
      webContents: ownerWebContents,
    };
    const guest = {
      id: 70,
      hostWebContents: ownerWebContents,
      isDestroyed: () => false,
      capturePage: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const controller = new DesktopBrowserScreenshotActivityController({
      fromId: () => win,
      fromWebContentsId: () => guest,
      allowTransparentWindowBootstrap: options?.allowTransparentWindowBootstrap ?? true,
      hideTaskbarDuringTransparentWindowBootstrap:
        options?.hideTaskbarDuringTransparentWindowBootstrap,
    });

    return {
      calls,
      controller,
      focus: () => {
        focused = true;
        focusListener?.();
      },
      guest,
      win,
    };
  }

  it("hidden owner 透明 showInactive 后先等待 presentation grace，再启动 pump 并恢复窗口", () => {
    vi.useFakeTimers();
    const harness = createTransparentBootstrapHarness();
    const lease = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-hidden-born",
      reason: "browser-screenshot",
    });

    expect(lease).toBeDefined();
    expect(harness.calls.slice(0, 2)).toEqual(["opacity:0", "showInactive"]);
    expect(harness.win.isFocused()).toBe(false);
    expect(harness.win.isVisible()).toBe(true);
    expect(harness.win.webContents.capturePage).not.toHaveBeenCalled();
    expect(harness.guest.capturePage).not.toHaveBeenCalled();

    lease?.markPrepared?.();
    vi.advanceTimersByTime(99);
    expect(harness.win.isVisible()).toBe(true);
    expect(harness.guest.capturePage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(harness.calls).toEqual(["opacity:0", "showInactive", "hide", "opacity:0.72"]);
    expect(harness.win.isVisible()).toBe(false);
    expect(harness.win.getOpacity()).toBe(0.72);
    expect(harness.win.webContents.capturePage).not.toHaveBeenCalled();
    expect(harness.guest.capturePage).toHaveBeenCalledTimes(1);
    lease?.release();
    vi.useRealTimers();
  });

  it("hidden owner 未 Ready 时只在 presentation grace 后启动重叠 preparing pump", async () => {
    vi.useFakeTimers();
    const harness = createTransparentBootstrapHarness();
    const lease = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-hidden-preparing",
      reason: "browser-screenshot",
    });

    vi.advanceTimersByTime(99);
    expect(harness.win.webContents.capturePage).not.toHaveBeenCalled();
    expect(harness.guest.capturePage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.win.webContents.capturePage).toHaveBeenCalledTimes(2);
    expect(harness.guest.capturePage).toHaveBeenCalledTimes(2);
    expect(harness.win.isVisible()).toBe(true);

    lease?.release();
    await Promise.resolve();
    expect(harness.win.isVisible()).toBe(false);
    vi.useRealTimers();
  });

  it("Windows hidden owner 在 showInactive 前隐藏 taskbar，恢复 hidden 时还原 taskbar", () => {
    vi.useFakeTimers();
    const harness = createTransparentBootstrapHarness({
      hideTaskbarDuringTransparentWindowBootstrap: true,
    });
    const lease = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-windows-tray",
      reason: "browser-screenshot",
    });

    expect(harness.calls).toEqual(["skipTaskbar:true", "opacity:0", "showInactive"]);
    lease?.markPrepared?.();
    vi.advanceTimersByTime(100);

    expect(harness.calls).toEqual([
      "skipTaskbar:true",
      "opacity:0",
      "showInactive",
      "hide",
      "opacity:0.72",
      "skipTaskbar:false",
    ]);
    expect(harness.win.isVisible()).toBe(false);
    lease?.release();
    vi.useRealTimers();
  });

  it("Windows 透明 bootstrap 期间用户 focus 会恢复 taskbar 且不再 hide", async () => {
    const harness = createTransparentBootstrapHarness({
      hideTaskbarDuringTransparentWindowBootstrap: true,
    });
    const lease = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-windows-user-focus",
      reason: "browser-screenshot",
    });

    harness.focus();
    expect(harness.calls).toEqual([
      "skipTaskbar:true",
      "opacity:0",
      "showInactive",
      "opacity:0.72",
      "skipTaskbar:false",
    ]);
    lease?.markPrepared?.();
    lease?.release();
    await Promise.resolve();

    expect(harness.win.hide).not.toHaveBeenCalled();
    expect(harness.win.isVisible()).toBe(true);
  });

  it("透明 bootstrap 期间用户 focus 会立即恢复 opacity，后续 Ready/release 不再 hide", async () => {
    const harness = createTransparentBootstrapHarness();
    const lease = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-user-focus",
      reason: "browser-screenshot",
    });

    harness.focus();
    expect(harness.calls).toEqual(["opacity:0", "showInactive", "opacity:0.72"]);
    lease?.markPrepared?.();
    lease?.release();
    await Promise.resolve();

    expect(harness.win.hide).not.toHaveBeenCalled();
    expect(harness.win.isVisible()).toBe(true);
    expect(harness.win.getOpacity()).toBe(0.72);
  });

  it("owner 原本可见时不启动透明 bootstrap", () => {
    const harness = createTransparentBootstrapHarness({ initiallyVisible: true });
    const lease = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-visible",
      reason: "browser-screenshot",
    });

    expect(lease).toBeDefined();
    expect(harness.win.setOpacity).not.toHaveBeenCalled();
    expect(harness.win.showInactive).not.toHaveBeenCalled();
    lease?.release();
  });

  it("owner 原本最小化时不启动透明 bootstrap，避免把窗口状态恢复成 hidden", () => {
    const harness = createTransparentBootstrapHarness({ initiallyMinimized: true });
    const lease = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-minimized",
      reason: "browser-screenshot",
    });

    expect(lease).toBeDefined();
    expect(harness.win.setOpacity).not.toHaveBeenCalled();
    expect(harness.win.showInactive).not.toHaveBeenCalled();
    lease?.release();
  });

  it("平台 capability 未启用时 hidden owner 仍沿用原 capture activity", () => {
    const harness = createTransparentBootstrapHarness({
      allowTransparentWindowBootstrap: false,
    });
    const lease = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-platform-disabled",
      reason: "browser-screenshot",
    });

    expect(lease).toBeDefined();
    expect(harness.win.setOpacity).not.toHaveBeenCalled();
    expect(harness.win.showInactive).not.toHaveBeenCalled();
    expect(harness.win.webContents.capturePage).toHaveBeenCalledTimes(2);
    expect(harness.guest.capturePage).toHaveBeenCalledTimes(2);
    lease?.release();
  });

  it("立即完成的 preparing capture 会先让出 macrotask，不会用 microtask 自旋锁死主进程", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const createImmediatelySettlingCapture = () => {
      let immediateCaptures = 32;
      return vi.fn(() => {
        if (immediateCaptures > 0) {
          immediateCaptures -= 1;
          return Promise.resolve();
        }
        return neverSettles;
      });
    };
    const ownerCapturePage = createImmediatelySettlingCapture();
    const guestCapturePage = createImmediatelySettlingCapture();
    const ownerWebContents = {
      id: 700,
      isDestroyed: () => false,
      capturePage: ownerCapturePage,
    };
    const controller = new DesktopBrowserScreenshotActivityController({
      fromId: () => ({
        isDestroyed: () => false,
        webContents: ownerWebContents,
      }),
      fromWebContentsId: () => ({
        id: 70,
        hostWebContents: ownerWebContents,
        isDestroyed: () => false,
        capturePage: guestCapturePage,
      }),
    });
    const firstMacrotask = new Promise<void>((resolve) => setTimeout(resolve, 0));

    const lease = controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-immediate",
      reason: "browser-screenshot",
    });
    await firstMacrotask;

    expect(ownerCapturePage).toHaveBeenCalledTimes(2);
    expect(guestCapturePage).toHaveBeenCalledTimes(2);
    lease?.release();
  });

  it("第一份 lease 为 owner/guest 各启动两份重叠 1×1 capture，最后 release 停止续泵", async () => {
    const harness = createHarness();
    const first = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-1",
      reason: "browser-screenshot",
    });
    const second = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-2",
      reason: "browser-screenshot",
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(harness.ownerCapturePage).toHaveBeenCalledTimes(2);
    expect(harness.guestCapturePage).toHaveBeenCalledTimes(2);
    expect(harness.ownerCapturePage).toHaveBeenNthCalledWith(1, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });

    first?.release();
    first?.release();
    await Promise.resolve();
    expect(harness.ownerCapturePage).toHaveBeenCalledTimes(2);
    expect(harness.guestCapturePage).toHaveBeenCalledTimes(2);

    second?.release();
    await Promise.resolve();
    await settleCaptures(harness);
    expect(harness.ownerCapturePage).toHaveBeenCalledTimes(2);
    expect(harness.guestCapturePage).toHaveBeenCalledTimes(2);
  });

  it("microtask 停泵前的新 acquire 复用 activity，避免 capturer count 归零", async () => {
    const harness = createHarness();
    const first = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-1",
      reason: "browser-screenshot",
    });
    first?.release();

    const second = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-2",
      reason: "browser-screenshot",
    });
    await Promise.resolve();
    harness.ownerCaptureResolvers.shift()?.();
    harness.guestCaptureResolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(harness.ownerCapturePage).toHaveBeenCalledTimes(3);
    expect(harness.guestCapturePage).toHaveBeenCalledTimes(3);

    second?.release();
    await Promise.resolve();
    await settleCaptures(harness);
  });

  it("surface Ready 后 owner 停泵，guest 改为 200ms 单 in-flight 脉冲", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const lease = harness.controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-paced",
      reason: "browser-screenshot",
    });

    expect(harness.ownerCapturePage).toHaveBeenCalledTimes(2);
    expect(harness.guestCapturePage).toHaveBeenCalledTimes(2);
    lease?.markPrepared?.();
    for (const resolve of harness.ownerCaptureResolvers.splice(0)) resolve();
    for (const resolve of harness.guestCaptureResolvers.splice(0)) resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.ownerCapturePage).toHaveBeenCalledTimes(2);
    expect(harness.guestCapturePage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(harness.guestCapturePage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.guestCapturePage).toHaveBeenCalledTimes(3);
    expect(harness.guestCaptureResolvers).toHaveLength(1);

    lease?.release();
    harness.guestCaptureResolvers.shift()?.();
    await Promise.resolve();
    await vi.runAllTimersAsync();
    expect(harness.ownerCapturePage).toHaveBeenCalledTimes(2);
    expect(harness.guestCapturePage).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("capture 失败会停止 pump 并使已交付 lease 立即失效", async () => {
    const capturePage = vi.fn(() => Promise.reject(new Error("surface unavailable")));
    const log = vi.fn();
    const controller = new DesktopBrowserScreenshotActivityController({
      fromId: () => ({
        isDestroyed: () => false,
        webContents: {
          id: 700,
          isDestroyed: () => false,
          capturePage,
        },
      }),
      fromWebContentsId: () => ({
        id: 70,
        hostWebContents: { id: 700 },
        isDestroyed: () => false,
        capturePage,
      }),
      log,
    });

    const lease = controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-failed",
      reason: "browser-screenshot",
    });
    expect(lease).toBeDefined();
    await Promise.resolve();
    await Promise.resolve();
    // 非 UnknownVizError 的失败保持快败：两份 in-flight 探测都落定后立即 invalidate。
    await Promise.resolve();
    await Promise.resolve();
    expect(capturePage).toHaveBeenCalledTimes(4);
    expect(lease?.invalidated?.aborted).toBe(true);
    expect(lease?.invalidated?.reason).toEqual(
      expect.objectContaining({ message: expect.stringContaining("capture failed") }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("capture failed"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("error=surface unavailable"));
  });

  it("preparing 阶段 guest UnknownVizError 串行退避重试，自愈后 lease 不失效", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const ownerCapturePage = vi.fn(() => new Promise<never>(() => undefined));
    const guestAttempts: Array<{
      resolve: () => void;
      reject: (error: Error) => void;
    }> = [];
    const guestCapturePage = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          guestAttempts.push({ resolve, reject });
        }),
    );
    const controller = new DesktopBrowserScreenshotActivityController({
      fromId: () => ({
        isDestroyed: () => false,
        webContents: { id: 700, isDestroyed: () => false, capturePage: ownerCapturePage },
      }),
      fromWebContentsId: () => ({
        id: 70,
        hostWebContents: { id: 700 },
        isDestroyed: () => false,
        capturePage: guestCapturePage,
      }),
      log,
    });

    const lease = controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-transient",
      reason: "browser-screenshot",
    });
    expect(lease).toBeDefined();
    // continuous 重叠：acquire 同步启动两份 in-flight 探测
    expect(guestCapturePage).toHaveBeenCalledTimes(2);

    // 两份探测同 turn 撞上未建立的 Viz surface
    for (const attempt of guestAttempts.splice(0)) attempt.reject(new Error("UnknownVizError"));
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    expect(lease?.invalidated?.aborted).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("transient capture retry scheduled"));
    // 退避窗口内不允许补发探测，更不允许并发读回
    expect(guestCapturePage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(99);
    expect(guestCapturePage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
    // 退避结束：恢复至多两份 in-flight 的常规重叠节奏
    expect(guestCapturePage).toHaveBeenCalledTimes(4);
    expect(lease?.invalidated?.aborted).toBe(false);

    // surface 已自愈：后续探测全部成功，泵继续存活
    for (const attempt of guestAttempts.splice(0)) attempt.resolve();
    await vi.advanceTimersByTimeAsync(10);
    const recoveredCalls = guestCapturePage.mock.calls.length;
    expect(recoveredCalls).toBeGreaterThan(4);
    expect(lease?.invalidated?.aborted).toBe(false);

    lease?.release();
    for (const attempt of guestAttempts.splice(0)) attempt.resolve();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it("UnknownVizError 持续超过重试预算后回到快败 invalidate", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const ownerCapturePage = vi.fn(() => new Promise<never>(() => undefined));
    const guestCapturePage = vi.fn(() => Promise.reject(new Error("UnknownVizError")));
    const controller = new DesktopBrowserScreenshotActivityController({
      fromId: () => ({
        isDestroyed: () => false,
        webContents: { id: 700, isDestroyed: () => false, capturePage: ownerCapturePage },
      }),
      fromWebContentsId: () => ({
        id: 70,
        hostWebContents: { id: 700 },
        isDestroyed: () => false,
        capturePage: guestCapturePage,
      }),
      log,
    });

    const lease = controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-transient-dead",
      reason: "browser-screenshot",
    });
    expect(lease).toBeDefined();

    // 2s 预算 + 退避间隔，推进 3s 覆盖整个重试链
    await vi.advanceTimersByTimeAsync(3_000);

    expect(lease?.invalidated?.aborted).toBe(true);
    expect(lease?.invalidated?.reason).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("browser screenshot activity capture failed for guest"),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("transient capture retry budget exhausted"),
    );

    // invalidate 后泵彻底停止，不再产生新的探测
    const finalCalls = guestCapturePage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(guestCapturePage).toHaveBeenCalledTimes(finalCalls);
    vi.useRealTimers();
  });

  it("preparing 阶段首份致命失败不等并发的 pending 探测，立即 invalidate 保持快败", async () => {
    const log = vi.fn();
    const ownerCapturePage = vi.fn(() => new Promise<never>(() => undefined));
    const guestAttempts: Array<{ reject: (error: Error) => void }> = [];
    const guestCapturePage = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          guestAttempts.push({ reject });
        }),
    );
    const controller = new DesktopBrowserScreenshotActivityController({
      fromId: () => ({
        isDestroyed: () => false,
        webContents: { id: 700, isDestroyed: () => false, capturePage: ownerCapturePage },
      }),
      fromWebContentsId: () => ({
        id: 70,
        hostWebContents: { id: 700 },
        isDestroyed: () => false,
        capturePage: guestCapturePage,
      }),
      log,
    });

    const lease = controller.acquire({
      windowId: 7,
      webContentsId: 70,
      requestId: "shot-fatal-fast",
      reason: "browser-screenshot",
    });
    expect(lease).toBeDefined();
    // continuous 重叠：acquire 同步启动两份 in-flight 探测
    expect(guestCapturePage).toHaveBeenCalledTimes(2);

    // 第一份以致命错误 reject，第二份永远 pending（hidden window 下 capturePage 挂死）
    guestAttempts[0]?.reject(new Error("webContents destroyed"));
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    expect(lease?.invalidated?.aborted).toBe(true);
    expect(lease?.invalidated?.reason).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("browser screenshot activity capture failed for guest"),
      }),
    );
    // 不再补发第三份探测
    expect(guestCapturePage).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("transient capture retry"));
    lease?.release();
  });

  it("窗口已销毁时 acquire 受控失败", () => {
    const harness = createHarness();
    harness.win.isDestroyed.mockReturnValue(true);
    expect(
      harness.controller.acquire({
        windowId: 7,
        webContentsId: 70,
        requestId: "shot-destroyed",
        reason: "browser-screenshot",
      }),
    ).toBeUndefined();
    expect(harness.ownerCapturePage).not.toHaveBeenCalled();
    expect(harness.guestCapturePage).not.toHaveBeenCalled();
  });

  it("guest 不属于目标 owner window 时拒绝 activity，避免跨窗口误唤醒", () => {
    const harness = createHarness();
    harness.guestWebContents.hostWebContents = { id: 999 };

    expect(
      harness.controller.acquire({
        windowId: 7,
        webContentsId: 70,
        requestId: "shot-wrong-owner",
        reason: "browser-screenshot",
      }),
    ).toBeUndefined();
    expect(harness.ownerCapturePage).not.toHaveBeenCalled();
    expect(harness.guestCapturePage).not.toHaveBeenCalled();
  });
});
