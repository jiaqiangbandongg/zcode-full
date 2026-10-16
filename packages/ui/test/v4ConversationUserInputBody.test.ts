import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX,
  ConversationUserInputBody,
  isUserInputContentOverflowing,
  resolveUserInputContentMaxHeight,
} from "@/v4/ConversationUserInputBody.js";

const buttonProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/components/ui/button.js", async () => {
  const React = await import("react");
  return {
    Button: ({ size: _size, variant: _variant, ...props }: Record<string, unknown>) => {
      buttonProps.push(props);
      return React.createElement("button", props, props.children as React.ReactNode);
    },
  };
});

const layout = {
  scrollHeight: 80,
};
let resizeObserverCallback: ResizeObserverCallback | null = null;

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: Node) => {
      Object.assign(child, { parentNode: element });
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as Node[],
    get scrollHeight() {
      return layout.scrollHeight;
    },
    getAttribute: (name: string) => element.attributes.get(name) ?? null,
    insertBefore: (child: Node, beforeChild?: Node | null) => {
      Object.assign(child, { parentNode: element });
      const beforeIndex = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (beforeIndex >= 0) {
        element.childNodes.splice(beforeIndex, 0, child);
      } else {
        element.childNodes.push(child);
      }
      return child;
    },
    attributes: new Map<string, string>(),
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as Node | null,
    removeAttribute: (name: string) => {
      element.attributes.delete(name);
    },
    removeChild: (child: Node) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      Object.assign(child, { parentNode: null });
      return child;
    },
    removeEventListener: () => {},
    setAttribute: (name: string, value: string) => {
      element.attributes.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createComment: (nodeValue: string) => ({
      nodeType: 8,
      nodeValue,
      parentNode: null,
    }),
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document & { defaultView?: unknown };
  const windowMock = {
    addEventListener: () => {},
    cancelAnimationFrame: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  };
  documentMock.defaultView = windowMock;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }
      disconnect() {}
      observe() {}
    },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

function latestButtonProps(): Record<string, unknown> | undefined {
  return buttonProps.at(-1);
}

async function renderBody(root: Root, rowId: number, contentText: string) {
  await act(async () => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ConversationUserInputBody,
          { contentText, rowId },
          createElement("span", null, "一段很长的用户正文"),
        ),
      ),
    );
  });
}

afterEach(() => {
  buttonProps.length = 0;
  layout.scrollHeight = 80;
  resizeObserverCallback = null;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ConversationUserInputBody", () => {
  it("keeps short content uncollapsed and only marks real overflow as expandable", () => {
    expect(COLLAPSED_USER_INPUT_CONTENT_MAX_HEIGHT_PX).toBe(120);
    expect(isUserInputContentOverflowing(120)).toBe(false);
    expect(isUserInputContentOverflowing(121)).toBe(false);
    expect(isUserInputContentOverflowing(122)).toBe(true);
    expect(resolveUserInputContentMaxHeight(false, 320)).toBe("120px");
    expect(resolveUserInputContentMaxHeight(true, 320)).toBe("320px");
    expect(resolveUserInputContentMaxHeight(true, 80)).toBe("120px");
  });

  it("reacts to measured overflow and toggles between expand and collapse", async () => {
    layout.scrollHeight = 320;
    const root = createRoot(installMinimalDom());
    await renderBody(root, 1, "long");

    expect(latestButtonProps()?.["aria-expanded"]).toBe(false);
    expect(latestButtonProps()?.["aria-label"]).toBe("展开");

    await act(async () => {
      (latestButtonProps()?.onClick as (() => void) | undefined)?.();
    });

    expect(latestButtonProps()?.["aria-expanded"]).toBe(true);
    expect(latestButtonProps()?.["aria-label"]).toBe("收起");

    await act(async () => {
      root.unmount();
    });
  });

  it("remeasures resize changes and resets expansion when row content changes", async () => {
    const root = createRoot(installMinimalDom());
    await renderBody(root, 1, "short");
    expect(buttonProps).toHaveLength(0);

    layout.scrollHeight = 280;
    await act(async () => {
      resizeObserverCallback?.([], {} as ResizeObserver);
    });
    expect(latestButtonProps()?.["aria-expanded"]).toBe(false);

    await act(async () => {
      (latestButtonProps()?.onClick as (() => void) | undefined)?.();
    });
    expect(latestButtonProps()?.["aria-expanded"]).toBe(true);

    await renderBody(root, 2, "new-content");
    expect(latestButtonProps()?.["aria-expanded"]).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });
});
