import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/code-viewer.js", () => ({
  CodeViewer: () => createElement("pre", { "data-code-viewer": "" }),
}));

vi.mock("@/components/ai-elements/mermaid-block.js", () => ({
  MermaidBlock: () => createElement("div", { "data-mermaid-block": "" }),
}));

vi.mock("@/components/ai-elements/diagram-preview-dialog.js", () => ({
  DiagramPreviewDialog: () => null,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children),
}));

vi.mock("@/lib/fileDisplay.js", () => ({
  FileDisplayIcon: () => createElement("span", { "data-file-icon": "" }),
  resolveFileDisplayDescriptor: () => ({ fileIconSrc: "file.svg" }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
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
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  const documentMock = {
    addEventListener,
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
    documentElement: {
      classList: {
        contains: () => false,
      },
    },
    hidden: false,
    nodeType: 9,
    removeEventListener,
    visibilityState: "visible",
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

  return {
    container: createMinimalElement(documentMock),
    addEventListener,
    removeEventListener,
  };
}

describe("CodeBlock visibility subscription", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not subscribe non-mermaid code blocks to document visibility changes", async () => {
    const { CodeBlock } = await import("@/components/ai-elements/code-block.js");
    const { container, addEventListener } = installMinimalDom();
    const root: Root = createRoot(container);

    act(() => {
      root.render(
        createElement(CodeBlock, {
          code: "const answer = 42;",
          language: "ts",
        }),
      );
    });

    expect(
      addEventListener.mock.calls.filter(([eventName]) => eventName === "visibilitychange"),
    ).toHaveLength(0);

    act(() => {
      root.unmount();
    });
  });

  it("subscribes mermaid code blocks to document visibility changes", async () => {
    const { CodeBlock } = await import("@/components/ai-elements/code-block.js");
    const { container, addEventListener } = installMinimalDom();
    const root: Root = createRoot(container);

    act(() => {
      root.render(
        createElement(CodeBlock, {
          code: "graph TD\nA-->B",
          language: "mermaid",
        }),
      );
    });

    expect(
      addEventListener.mock.calls.filter(([eventName]) => eventName === "visibilitychange"),
    ).toHaveLength(1);

    act(() => {
      root.unmount();
    });
  });
});
