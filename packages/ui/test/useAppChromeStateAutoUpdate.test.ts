import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopWindowChromeState,
  IPlatformService,
  UpdateStatePayload,
} from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

describe("useAppChromeState auto update state", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("clears legacy ready version when update state leaves downloaded", async () => {
    const { useAppChromeState } = await import("@/app-shell/useAppChromeState.js");
    let readyCallback: ((version: string) => void) | null = null;
    let stateCallback: ((payload: UpdateStatePayload) => void) | null = null;
    let latestChromeState: { updateReadyVersion: string | null } | null = null;
    const platform = {
      getUpdateState: vi.fn(async () => ({ kind: "idle", enabled: true })),
      onUpdateReady: vi.fn((callback: (version: string) => void) => {
        readyCallback = callback;
        return () => {};
      }),
      onUpdateStateChanged: vi.fn((callback: (payload: UpdateStatePayload) => void) => {
        stateCallback = callback;
        return () => {};
      }),
    } as unknown as IPlatformService;
    const root: Root = createRoot(installMinimalDom());
    const Harness = () => {
      latestChromeState = useAppChromeState({
        isDesktop: false,
        isMacDesktop: false,
        isWindowsDesktop: false,
        platform,
        workspaceAbsPath: "/repo/demo",
      });
      return null;
    };

    await act(async () => {
      root.render(createElement(Harness));
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      readyCallback?.("3.3.2");
    });
    expect(latestChromeState?.updateReadyVersion).toBe("3.3.2");

    act(() => {
      stateCallback?.({
        kind: "update-downloaded",
        enabled: true,
        version: "3.3.2",
      });
    });
    expect(latestChromeState?.updateReadyVersion).toBe("3.3.2");

    act(() => {
      stateCallback?.({ kind: "idle", enabled: true });
    });

    // Bugfix: staging error 会让 main 广播 idle；旧 ready 版本必须同步清掉，
    // 否则顶部按钮会继续展示“重启以更新”并触发一个无效安装请求。
    expect(latestChromeState?.updateReadyVersion).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("does not let an initial stale snapshot hide a later available update event", async () => {
    const { useAppChromeState } = await import("@/app-shell/useAppChromeState.js");
    let resolveInitialSnapshot:
      | ((payload: UpdateStatePayload) => void)
      | null = null;
    let stateCallback: ((payload: UpdateStatePayload) => void) | null = null;
    let latestChromeState: {
      updateReadyVersion: string | null;
      updateState: UpdateStatePayload | null;
    } | null = null;
    const platform = {
      getUpdateState: vi.fn(
        () =>
          new Promise<UpdateStatePayload>((resolve) => {
            resolveInitialSnapshot = resolve;
          }),
      ),
      onUpdateStateChanged: vi.fn((callback: (payload: UpdateStatePayload) => void) => {
        stateCallback = callback;
        return () => {};
      }),
    } as unknown as IPlatformService;
    const root: Root = createRoot(installMinimalDom());
    const Harness = () => {
      latestChromeState = useAppChromeState({
        isDesktop: false,
        isMacDesktop: false,
        isWindowsDesktop: false,
        platform,
        workspaceAbsPath: "/repo/demo",
      });
      return null;
    };

    await act(async () => {
      root.render(createElement(Harness));
    });

    act(() => {
      stateCallback?.({
        kind: "update-available",
        enabled: true,
        version: "3.3.3",
      });
    });
    expect(latestChromeState?.updateState?.kind).toBe("update-available");

    await act(async () => {
      resolveInitialSnapshot?.({ kind: "idle", enabled: true });
      await Promise.resolve();
    });

    // Bugfix: 初始 getUpdateState 可能晚于状态事件返回旧 idle。
    // 旧快照不能覆盖已经收到的 update-available，否则主页更新按钮会消失。
    expect(latestChromeState?.updateState?.kind).toBe("update-available");

    act(() => {
      root.unmount();
    });
  });
});

describe("useAppChromeState desktop chrome state", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    [15, 6],
    [26, 12],
  ])("loads macOS %i from the platform before resolving radius %i", async (version, radius) => {
    const { useAppChromeState } = await import("@/app-shell/useAppChromeState.js");
    const { resolveWorkspaceShellPanelRadiusPx } = await import("@/app-shell/workspaceShellWindowChrome.js");
    const dispose = vi.fn();
    const platform = {
      onWindowFullscreenChanged: vi.fn(() => () => {}),
      getDesktopWindowChromeState: vi.fn(async () => ({
        isMaximized: false,
        supportsNativeRoundedCorners: false,
        macOSMajorVersion: version,
      })),
      onDesktopWindowChromeStateChanged: vi.fn(() => dispose),
    } as unknown as IPlatformService;
    let actualRadius: number | undefined;
    const root = createRoot(installMinimalDom());
    const Harness = () => {
      const { desktopWindowChromeState } = useAppChromeState({
        isDesktop: true,
        isMacDesktop: true,
        platform,
        workspaceAbsPath: "/repo/demo",
      });
      actualRadius = resolveWorkspaceShellPanelRadiusPx({
        isMacDesktop: true,
        macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
      });
      return null;
    };
    try {
      await act(async () => root.render(createElement(Harness)));
      expect(platform.getDesktopWindowChromeState).toHaveBeenCalledOnce();
      expect(actualRadius).toBe(radius);
    } finally {
      act(() => root.unmount());
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps capability unknown when the desktop bridge is unavailable", async () => {
    const { useAppChromeState } = await import("@/app-shell/useAppChromeState.js");
    let latestState: DesktopWindowChromeState | null | undefined;
    const root: Root = createRoot(installMinimalDom());
    const Harness = () => {
      latestState = useAppChromeState({
        isDesktop: true,
        isMacDesktop: false,
        isWindowsDesktop: true,
        platform: {} as IPlatformService,
        workspaceAbsPath: "/repo/demo",
      }).desktopWindowChromeState;
      return null;
    };

    await act(async () => {
      root.render(createElement(Harness));
    });

    expect(latestState).toBeNull();
    act(() => root.unmount());
  });

  it("does not let the initial query overwrite a newer maximize event", async () => {
    const { useAppChromeState } = await import("@/app-shell/useAppChromeState.js");
    let resolveInitialState: ((state: DesktopWindowChromeState) => void) | null = null;
    let stateCallback: ((state: DesktopWindowChromeState) => void) | null = null;
    let latestState: DesktopWindowChromeState | null | undefined;
    const platform = {
      getDesktopWindowChromeState: vi.fn(
        () =>
          new Promise<DesktopWindowChromeState>((resolve) => {
            resolveInitialState = resolve;
          }),
      ),
      onDesktopWindowChromeStateChanged: vi.fn(
        (callback: (state: DesktopWindowChromeState) => void) => {
          stateCallback = callback;
          return () => {};
        },
      ),
    } as unknown as IPlatformService;
    const root: Root = createRoot(installMinimalDom());
    const Harness = () => {
      latestState = useAppChromeState({
        isDesktop: true,
        isMacDesktop: false,
        isWindowsDesktop: true,
        platform,
        workspaceAbsPath: "/repo/demo",
      }).desktopWindowChromeState;
      return null;
    };

    await act(async () => {
      root.render(createElement(Harness));
    });
    act(() => {
      stateCallback?.({ isMaximized: true, supportsNativeRoundedCorners: true });
    });
    await act(async () => {
      resolveInitialState?.({ isMaximized: false, supportsNativeRoundedCorners: true });
      await Promise.resolve();
    });

    expect(latestState).toEqual({ isMaximized: true, supportsNativeRoundedCorners: true });
    act(() => root.unmount());
  });
});
