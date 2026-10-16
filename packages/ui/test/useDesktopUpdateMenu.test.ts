import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopCommandIds, type UpdateStatePayload } from "@zcode/shared";
import { useDesktopUpdateMenu } from "@/hooks/useDesktopUpdateMenu.js";
import { getUpdateMenuLabelId, getUpdateMenuLabelValues } from "@/lib/desktopUpdateMenu.js";

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZCODE_PRODUCT_FLAVOR: "production",
}));

const mocks = vi.hoisted(() => ({
  platform: {
    getUpdateState: vi.fn(),
    onUpdateStateChanged: vi.fn(),
    executeDesktopCommand: vi.fn(),
  },
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => mocks.platform }));
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
    style: {
      removeProperty: () => {},
      setProperty: () => {},
    },
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
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
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

let root: Root | undefined;
let latest: ReturnType<typeof useDesktopUpdateMenu>;
function Probe({ desktop }: { desktop: boolean }) {
  latest = useDesktopUpdateMenu(desktop);
  return null;
}
function mount(desktop = true) {
  root = createRoot(installMinimalDom());
  act(() => root!.render(createElement(Probe, { desktop })));
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
});

describe("帮助菜单更新状态", () => {
  it("实时检查状态不被较晚返回的 idle 快照覆盖，并在卸载时取消订阅", async () => {
    let resolve!: (state: UpdateStatePayload) => void;
    let listener!: (state: UpdateStatePayload) => void;
    const dispose = vi.fn();
    mocks.platform.getUpdateState.mockReturnValue(
      new Promise<UpdateStatePayload>((done) => {
        resolve = done;
      }),
    );
    mocks.platform.onUpdateStateChanged.mockImplementation((callback) => {
      listener = callback;
      return dispose;
    });
    mount();
    act(() => listener({ kind: "checking", enabled: false }));
    await act(async () => resolve({ kind: "idle", enabled: true }));
    expect(latest.labelId).toBe("desktopMenu.help.checkingForUpdates");
    expect(latest.disabled).toBe(true);
    act(() => listener({ kind: "update-downloaded", enabled: true, version: "3.13.0" }));
    expect(latest.labelId).toBe("desktopMenu.help.restartToUpdate");
    expect(latest.labelValues).toEqual({ version: "3.13.0" });
    latest.checkForUpdates();
    expect(mocks.platform.executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.CheckForUpdates,
    );
    act(() => root!.unmount());
    root = undefined;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("Web 不查询或订阅桌面更新状态", () => {
    mount(false);
    expect(latest.visible).toBe(false);
    expect(mocks.platform.getUpdateState).not.toHaveBeenCalled();
    expect(mocks.platform.onUpdateStateChanged).not.toHaveBeenCalled();
  });

  it("可用版本和下载进度沿用原有菜单文案参数", () => {
    const available: UpdateStatePayload = {
      kind: "update-available",
      enabled: true,
      version: "3.13.0",
    };
    const downloading: UpdateStatePayload = {
      kind: "download-progress",
      enabled: true,
      progress: "42%",
    };
    expect(getUpdateMenuLabelId(available)).toBe("desktopMenu.help.updateAvailableVersion");
    expect(getUpdateMenuLabelValues(available)).toEqual({ version: "3.13.0" });
    expect(getUpdateMenuLabelId(downloading)).toBe("desktopMenu.help.downloadingUpdateProgress");
    expect(getUpdateMenuLabelValues(downloading)).toEqual({ progress: "42%" });
  });
});
