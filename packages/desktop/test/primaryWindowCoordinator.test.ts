import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPrimaryWindowCoordinator } from "../src/main/primaryWindowCoordinator.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("primaryWindowCoordinator", () => {
  const windows: Array<{
    isDestroyed: () => boolean;
    isVisible: () => boolean;
    isMinimized: () => boolean;
    isRendererCrashed?: () => boolean;
    restore: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    destroy?: ReturnType<typeof vi.fn>;
  }> = [];

  beforeEach(() => {
    windows.length = 0;
  });

  it("ready 和 activate 并发时只会创建一个主窗口", async () => {
    const deferred = createDeferred<{ initialWorkspacePath?: string }>();
    const createWindow = vi.fn();
    const resolveStartupWindowBootstrap = vi.fn(() => deferred.promise);
    const coordinator = createPrimaryWindowCoordinator({
      listWindows: () => windows,
      resolveStartupWindowBootstrap,
      createWindow,
      logger: { info: vi.fn() },
    });

    const readyPromise = coordinator.ensurePrimaryWindow("app-ready");
    const activatePromise = coordinator.ensurePrimaryWindow("app-activate");

    expect(resolveStartupWindowBootstrap).toHaveBeenCalledTimes(1);
    expect(createWindow).not.toHaveBeenCalled();

    deferred.resolve({ initialWorkspacePath: "/Users/dev/test/my-react-app" });
    await Promise.all([readyPromise, activatePromise]);

    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledWith({
      initialWorkspacePath: "/Users/dev/test/my-react-app",
    });
  });

  it("已有隐藏窗口时优先复用而不是新建", async () => {
    const hiddenWindow = {
      isDestroyed: () => false,
      isVisible: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    windows.push(hiddenWindow);

    const createWindow = vi.fn();
    const resolveStartupWindowBootstrap = vi.fn(async () => ({
      initialWorkspacePath: "/Users/dev/test/my-react-app",
    }));
    const coordinator = createPrimaryWindowCoordinator({
      listWindows: () => windows,
      resolveStartupWindowBootstrap,
      createWindow,
      logger: { info: vi.fn() },
    });

    await coordinator.ensurePrimaryWindow("app-activate");

    expect(hiddenWindow.show).toHaveBeenCalledTimes(1);
    expect(hiddenWindow.focus).toHaveBeenCalledTimes(1);
    expect(resolveStartupWindowBootstrap).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("已有窗口 renderer 崩溃时销毁旧窗口并创建新主窗口", async () => {
    let destroyed = false;
    const crashedWindow = {
      isDestroyed: () => destroyed,
      isRendererCrashed: () => true,
      isVisible: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      destroy: vi.fn(() => {
        destroyed = true;
      }),
    };
    windows.push(crashedWindow);

    const createWindow = vi.fn();
    const resolveStartupWindowBootstrap = vi.fn(async () => ({
      initialWorkspacePath: "/Users/dev/test/my-react-app",
    }));
    const coordinator = createPrimaryWindowCoordinator({
      listWindows: () => windows,
      resolveStartupWindowBootstrap,
      createWindow,
      logger: { info: vi.fn() },
    });

    await coordinator.ensurePrimaryWindow("app-activate");

    expect(crashedWindow.destroy).toHaveBeenCalledTimes(1);
    expect(crashedWindow.show).not.toHaveBeenCalled();
    expect(crashedWindow.focus).not.toHaveBeenCalled();
    expect(resolveStartupWindowBootstrap).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledWith({
      initialWorkspacePath: "/Users/dev/test/my-react-app",
    });
  });

  it("强制升级 gate 阻断时不会复用或创建主窗口", async () => {
    const hiddenWindow = {
      isDestroyed: () => false,
      isVisible: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    windows.push(hiddenWindow);

    const createWindow = vi.fn();
    const resolveStartupWindowBootstrap = vi.fn(async () => ({
      initialWorkspacePath: "/Users/dev/test/my-react-app",
    }));
    const coordinator = createPrimaryWindowCoordinator({
      listWindows: () => windows,
      resolveStartupWindowBootstrap,
      createWindow,
      canCreateWindow: () => false,
      logger: { info: vi.fn() },
    });

    await coordinator.ensurePrimaryWindow("app-activate");

    expect(hiddenWindow.show).not.toHaveBeenCalled();
    expect(hiddenWindow.focus).not.toHaveBeenCalled();
    expect(resolveStartupWindowBootstrap).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });
});
