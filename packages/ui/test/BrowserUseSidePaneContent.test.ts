// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { BrowserViewScreenshotSurfacePreparePayload } from "@zcode/shared";
import { Tabs, TabsContent } from "@/components/ui/tabs.js";
import type { BrowserUseSidePaneTab, WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

const h = vi.hoisted(() => {
  const prepareListeners = new Set<(payload: BrowserViewScreenshotSurfacePreparePayload) => void>();
  const releaseListeners = new Set<
    (payload: Omit<BrowserViewScreenshotSurfacePreparePayload, "viewport">) => void
  >();
  return { prepareListeners, releaseListeners };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: (() => {
    const platform = {
      onBrowserViewScreenshotSurfacePrepare: (
        listener: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
      ) => {
        h.prepareListeners.add(listener);
        return () => h.prepareListeners.delete(listener);
      },
      onBrowserViewScreenshotSurfaceRelease: (
        listener: (payload: Omit<BrowserViewScreenshotSurfacePreparePayload, "viewport">) => void,
      ) => {
        h.releaseListeners.add(listener);
        return () => h.releaseListeners.delete(listener);
      },
    };
    return () => platform;
  })(),
}));

vi.mock("@/browser-use/UnifiedBrowserView.js", () => ({
  UnifiedBrowserView: () => createElement("div", { "data-testid": "unified-browser-view" }),
}));

import { BrowserUseSidePaneContent } from "@/browser-use/BrowserUseSidePaneContent.js";
import {
  findScreenshotSurfaceTab,
  findScreenshotSurfaceTabForRender,
  useBrowserScreenshotSurfaceRequest,
} from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";

const browserUseTab: BrowserUseSidePaneTab = {
  id: "browser-use:tab-1",
  type: "browser-use",
  ownerTaskId: "sess-1",
  workspaceKey: "workspace-1",
  sessionId: "sess-1",
  tabId: "tab-1",
  browserId: "browser-1",
  browserGeneration: 2,
};

function createPrepare(overrides: Partial<BrowserViewScreenshotSurfacePreparePayload> = {}) {
  return {
    requestId: "request-1",
    workspaceKey: "workspace-1",
    sessionId: "sess-1",
    browserId: "browser-1",
    browserGeneration: 2,
    tabId: "tab-1",
    webContentsId: 42,
    viewport: { width: 1274, height: 720 },
    ...overrides,
  };
}

function RequestHarness({
  tabs,
  onRequest,
}: {
  tabs: readonly WorkspaceSidePaneTab[];
  onRequest: (requestId: string | null) => void;
}) {
  const request = useBrowserScreenshotSurfaceRequest(tabs);
  useEffect(() => {
    onRequest(request?.requestId ?? null);
  }, [onRequest, request?.requestId]);
  return null;
}

beforeEach(() => {
  cleanup();
  h.prepareListeners.clear();
  h.releaseListeners.clear();
});

afterEach(() => cleanup());

describe("BrowserUseSidePaneContent", () => {
  it.each(["current", "unscaled"] as const)(
    "%s prepare 时进入底层 capture layer，但不改变 active tab 或焦点",
    (surfaceScaleMode) => {
      const userInput = document.createElement("input");
      document.body.append(userInput);
      userInput.focus();
      const preparePayload = createPrepare({ surfaceScaleMode });
      const view = render(
        createElement(
          Tabs,
          { value: "active-tab" },
          createElement(TabsContent, { value: "active-tab" }, "active"),
          createElement(BrowserUseSidePaneContent, {
            tab: browserUseTab,
            isPanelVisible: true,
            isSelected: false,
            screenshotSurfaceRequest: preparePayload,
            workspacePath: "C:\\repo",
            onUrlChange: vi.fn(),
            onPageMetadataChange: vi.fn(),
          }),
        ),
      );

      const content = view.container.querySelector(
        '[data-browser-screenshot-surface-state="preparing"]',
      );
      expect(content).not.toBeNull();
      expect(content?.classList.contains("fixed")).toBe(true);
      expect(content?.style.position).toBe("fixed");
      expect(content?.style.left).toBe("0px");
      expect(content?.style.width).toBe(`${preparePayload.viewport.width}px`);
      expect(content?.style.height).toBe(`${preparePayload.viewport.height + 48}px`);
      expect(content?.style.maxWidth).toBe(surfaceScaleMode === "unscaled" ? "" : "100vw");
      expect(content?.style.maxHeight).toBe(surfaceScaleMode === "unscaled" ? "" : "100vh");
      expect(content?.style.opacity).toBe("0.001");
      expect(content?.classList.contains("pointer-events-none")).toBe(true);
      expect(content?.classList.contains("hidden")).toBe(false);
      expect(content?.hasAttribute("inert")).toBe(true);
      expect(content?.getAttribute("aria-hidden")).toBe("true");
      expect(document.activeElement).toBe(userInput);
      expect(view.container.querySelector('[data-state="active"]')?.textContent).toContain(
        "active",
      );

      view.rerender(
        createElement(
          Tabs,
          { value: "active-tab" },
          createElement(TabsContent, { value: "active-tab" }, "active"),
          createElement(BrowserUseSidePaneContent, {
            tab: browserUseTab,
            isPanelVisible: true,
            isSelected: false,
            screenshotSurfaceRequest: null,
            workspacePath: "C:\\repo",
            onUrlChange: vi.fn(),
            onPageMetadataChange: vi.fn(),
          }),
        ),
      );
      expect(
        view.container
          .querySelector('[data-browser-use-tab-id="tab-1"]')
          ?.classList.contains("hidden"),
      ).toBe(true);
      userInput.remove();
    },
  );

  it("只接受完整 tab scope 的 prepare，并让 release 严格匹配 request", () => {
    const received: Array<string | null> = [];
    render(
      createElement(RequestHarness, {
        tabs: [browserUseTab],
        onRequest: (requestId) => received.push(requestId),
      }),
    );

    for (const mismatch of [
      createPrepare({ workspaceKey: "other-workspace" }),
      createPrepare({ sessionId: "other-session" }),
      createPrepare({ tabId: "other-tab" }),
    ]) {
      act(() => {
        h.prepareListeners.forEach((listener) => listener(mismatch));
      });
    }
    expect(received).toEqual([null]);

    const first = createPrepare({ requestId: "request-1" });
    act(() => {
      h.prepareListeners.forEach((listener) => listener(first));
    });
    const concurrent = createPrepare({ requestId: "request-2" });
    act(() => {
      h.prepareListeners.forEach((listener) => listener(concurrent));
    });
    for (const mismatch of [
      { requestId: "wrong-request" },
      { workspaceKey: "wrong-workspace" },
      { sessionId: "wrong-session" },
      { tabId: "wrong-tab" },
      { webContentsId: 99 },
    ]) {
      act(() => {
        h.releaseListeners.forEach((listener) => listener({ ...first, ...mismatch }));
      });
    }
    expect(received).toEqual([null, "request-1"]);

    act(() => {
      h.releaseListeners.forEach((listener) => listener({ ...first }));
    });
    expect(received).toEqual([null, "request-1", null]);
  });

  // 跨进程恢复的 browser tab（browser: 前缀）在 renderer registry 里的 browserId/
  // browserGeneration 仍是持久 shell 里旧进程的值；main 侧 owner 已被新一轮 scope 接管。
  // 七元组严格匹配会让 prepare 被静默忽略——恢复 tab 的 AI 截图必 3s 超时（dev 实测：
  // 同一 turn 内新开 tab ok=true/407ms，恢复 tab ok=false/3000ms 且无 renderer ready）。
  // prepare 匹配必须降级到 workspaceKey+sessionId+tabId；stale 防护由 main 侧用请求内
  // generation 做（coordinator 已有），renderer 不承担该职责。
  it("跨进程恢复 tab 的 browserId/browserGeneration 漂移时仍接受 prepare", () => {
    const received: Array<string | null> = [];
    const restoredTab: BrowserUseSidePaneTab = {
      ...browserUseTab,
      browserId: "browser-from-previous-process",
      browserGeneration: 1,
    };
    render(
      createElement(RequestHarness, {
        tabs: [restoredTab],
        onRequest: (requestId) => received.push(requestId),
      }),
    );

    const prepare = createPrepare({
      requestId: "request-restore-1",
      browserId: "browser-current",
      browserGeneration: 99,
    });
    act(() => {
      h.prepareListeners.forEach((listener) => listener(prepare));
    });
    expect(received).toEqual([null, "request-restore-1"]);
  });

  it("release 对 browserId/browserGeneration 漂移容错，避免恢复 tab 的 surface 永久卡死", () => {
    const received: Array<string | null> = [];
    render(
      createElement(RequestHarness, {
        tabs: [browserUseTab],
        onRequest: (requestId) => received.push(requestId),
      }),
    );

    const prepare = createPrepare({ requestId: "request-restore-2" });
    act(() => {
      h.prepareListeners.forEach((listener) => listener(prepare));
    });
    expect(received).toEqual([null, "request-restore-2"]);

    // release 由 main settleGroup 在截图结算时发出；期间 tab 若被重新接管，
    // payload 携带的是新 scope 元数据。严格匹配会让 release 永不命中，
    // browser pane 停留在近透明 fixed 层（用户感知为透明遮罩假死，只能重启）。
    act(() => {
      h.releaseListeners.forEach((listener) =>
        listener({
          ...prepare,
          browserId: "browser-current",
          browserGeneration: 100,
        }),
      );
    });
    expect(received).toEqual([null, "request-restore-2", null]);
  });

  it("tab registry 更新时保持截图 surface IPC listener 稳定", () => {
    const view = render(
      createElement(RequestHarness, {
        tabs: [browserUseTab],
        onRequest: vi.fn(),
      }),
    );
    const prepareListener = [...h.prepareListeners][0];
    const releaseListener = [...h.releaseListeners][0];

    view.rerender(
      createElement(RequestHarness, {
        tabs: [{ ...browserUseTab, browserUseOperationUntil: Date.now() + 1_000 }],
        onRequest: vi.fn(),
      }),
    );

    expect([...h.prepareListeners]).toEqual([prepareListener]);
    expect([...h.releaseListeners]).toEqual([releaseListener]);
  });

  it("findScreenshotSurfaceTab 在任一 scope 不匹配时拒绝 tab", () => {
    expect(findScreenshotSurfaceTab([browserUseTab], createPrepare())).toBe(browserUseTab);
    expect(
      findScreenshotSurfaceTab([browserUseTab], createPrepare({ tabId: "wrong" })),
    ).toBeUndefined();
  });

  it("browserGeneration 在 attach 后更新时仍把已接收请求路由到原 tab", () => {
    const payload = createPrepare();
    const updatedTab = { ...browserUseTab, browserGeneration: payload.browserGeneration + 1 };

    expect(findScreenshotSurfaceTab([updatedTab], payload)).toBeUndefined();
    expect(findScreenshotSurfaceTabForRender([updatedTab], payload)).toBe(updatedTab);
  });
});
