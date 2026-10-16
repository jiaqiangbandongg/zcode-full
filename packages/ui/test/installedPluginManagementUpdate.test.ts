import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodePluginInfo, ZCodePluginUserConfigOption } from "@zcode/shared";

// 复用 taskListItemHoverActions.test.ts 的「mock Button 捕获 onClick」套路：
// renderToStaticMarkup 不会派发真实点击事件，故把 Button 替换成记录 props 的桩，
// 在 createRoot 渲染后直接调用捕获到的 onClick，确定性地验证更新按钮的点击回调。
const { buttonProps } = vi.hoisted(() => ({
  buttonProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => {
    buttonProps.push(props);
    return createElement("button", props as Record<string, unknown>, children);
  },
}));

function basePlugin(overrides: Partial<ZCodePluginInfo> = {}): ZCodePluginInfo {
  return {
    id: "skill-creator@zcode-plugins-official",
    name: "skill-creator",
    version: "1.0.0",
    enabled: true,
    source: "official",
    marketplace: "zcode-plugins-official",
    skillCount: 0,
    skillRootCount: 0,
    commandRootCount: 0,
    declaredMcpServerNames: [],
    mcpServerNames: [],
    hookDetails: [],
    rootPath: "/cache/skill-creator",
    components: [],
    ...overrides,
  };
}

const sharedPanelProps = {
  getPluginOptionValue: (
    _plugin: ZCodePluginInfo,
    _key: string,
    option: ZCodePluginUserConfigOption,
  ) => option.default ?? "",
  onSavePluginOptions: () => {},
  setPluginOptionDraft: () => {},
  renderPluginSource: (target: ZCodePluginInfo) => target.marketplace,
} as const;

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

describe("InstalledPluginDetailPanel update badge", () => {
  afterEach(() => {
    buttonProps.length = 0;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders the update button, target version, and new-sessions note when update-available", async () => {
    const { InstalledPluginDetailPanel } = await import(
      "../src/settings/InstalledPluginManagement.js"
    );
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(InstalledPluginDetailPanel, {
          ...sharedPanelProps,
          operationId: null,
          plugin: basePlugin(),
          updateStatus: "update-available",
          latestVersion: "2.0.0",
          uninstallable: true,
          onRequestUninstall: () => {},
          onRequestUpdate: () => {},
        }),
      ),
    );

    expect(html).toContain("Update available → v2.0.0");
    expect(html).toContain("Takes effect in new sessions");
  });

  it("omits the update block when there is no update", async () => {
    const { InstalledPluginDetailPanel } = await import(
      "../src/settings/InstalledPluginManagement.js"
    );
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(InstalledPluginDetailPanel, {
          ...sharedPanelProps,
          operationId: null,
          plugin: basePlugin(),
          updateStatus: "none",
          uninstallable: true,
          onRequestUninstall: () => {},
          onRequestUpdate: () => {},
        }),
      ),
    );

    expect(html).not.toContain("Takes effect in new sessions");
  });

  it("invokes onRequestUpdate with the plugin id when the update button is clicked", async () => {
    const { InstalledPluginDetailPanel } = await import(
      "../src/settings/InstalledPluginManagement.js"
    );
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
    const onRequestUpdate = vi.fn();
    const root: Root = createRoot(installMinimalDom());

    act(() => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(InstalledPluginDetailPanel, {
            ...sharedPanelProps,
            operationId: null,
            plugin: basePlugin(),
            updateStatus: "update-available",
            latestVersion: "2.0.0",
            uninstallable: true,
            onRequestUninstall: () => {},
            onRequestUpdate,
          }),
        ),
      );
    });

    // 收集所有渲染到的按钮 onClick（更新按钮 + 卸载按钮），逐个触发；
    // 只有更新按钮的回调会带上 pluginId 调用 onRequestUpdate。
    const clickHandlers = buttonProps
      .map((props) => props.onClick)
      .filter((onClick): onClick is () => void => typeof onClick === "function");
    expect(clickHandlers.length).toBeGreaterThan(0);
    for (const onClick of clickHandlers) {
      onClick();
    }

    expect(onRequestUpdate).toHaveBeenCalledWith("skill-creator@zcode-plugins-official");
    expect(onRequestUpdate).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });
});
