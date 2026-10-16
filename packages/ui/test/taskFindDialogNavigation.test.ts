import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

type CapturedButtonProps = {
  "aria-label"?: string;
  onClick?: () => void;
};

type CapturedInputProps = {
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: {
    key: string;
    preventDefault: () => void;
    shiftKey: boolean;
  }) => void;
};

const { capturedButtonProps, capturedInputProps } = vi.hoisted(() => ({
  capturedButtonProps: [] as CapturedButtonProps[],
  capturedInputProps: [] as CapturedInputProps[],
}));

type TestEvent = {
  bubbles?: boolean;
  button?: number;
  currentTarget?: TestElement;
  defaultPrevented?: boolean;
  key?: string;
  preventDefault?: () => void;
  shiftKey?: boolean;
  stopPropagation?: () => void;
  target?: TestElement;
  type: string;
};

type TestEventHandler = (event: TestEvent) => void;

type TestNode = TestElement | {
  nodeType: 3;
  nodeValue: string;
  ownerDocument: Document;
  parentNode: TestElement | null;
};

type TestElement = Element & {
  __attrs: Map<string, string>;
  __listeners: Map<string, TestEventHandler[]>;
  childNodes: TestNode[];
  dispatchEvent: (event: TestEvent) => boolean;
  focus: () => void;
  parentNode: TestElement | null;
  value: string;
};

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    ArrowDownIcon: createIcon("arrow-down"),
    ArrowUpIcon: createIcon("arrow-up"),
    FileDiffIcon: createIcon("file-diff"),
    MessageCircleIcon: createIcon("message-circle"),
    SearchIcon: createIcon("search"),
    XIcon: createIcon("x"),
  };
});

vi.mock("react/jsx-runtime", async () => {
  const actual = await vi.importActual<typeof import("react/jsx-runtime")>(
    "react/jsx-runtime",
  );
  const capture =
    (factory: typeof actual.jsx) =>
    (type: Parameters<typeof actual.jsx>[0], props: Record<string, unknown>, key?: string) => {
      if (type === "input") {
        capturedInputProps.push(props as CapturedInputProps);
      }
      return factory(type, props, key);
    };
  return {
    ...actual,
    jsx: capture(actual.jsx),
    jsxs: capture(actual.jsxs),
  };
});

vi.mock("react/jsx-dev-runtime", async () => {
  const actual = await vi.importActual<typeof import("react/jsx-dev-runtime")>(
    "react/jsx-dev-runtime",
  );
  return {
    ...actual,
    jsxDEV: (
      type: Parameters<typeof actual.jsxDEV>[0],
      props: Record<string, unknown>,
      ...rest: unknown[]
    ) => {
      if (type === "input") {
        capturedInputProps.push(props as CapturedInputProps);
      }
      return actual.jsxDEV(type, props, ...rest);
    },
  };
});

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & CapturedButtonProps) => {
    capturedButtonProps.push(props);
    return createElement("button", props, children);
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    __attrs: new Map<string, string>(),
    __listeners: new Map<string, TestEventHandler[]>(),
    addEventListener: (type: string, handler: TestEventHandler) => {
      const handlers = element.__listeners.get(type) ?? [];
      handlers.push(handler);
      element.__listeners.set(type, handlers);
    },
    appendChild: (child: TestNode) => {
      child.parentNode = element as unknown as TestElement;
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as TestNode[],
    dispatchEvent: (event: TestEvent) => {
      event.target ??= element as unknown as TestElement;
      event.preventDefault ??= () => {
        event.defaultPrevented = true;
      };
      event.stopPropagation ??= () => {};
      let current: TestElement | null = element as unknown as TestElement;
      while (current) {
        event.currentTarget = current;
        for (const handler of current.__listeners.get(event.type) ?? []) {
          handler(event);
        }
        if (!event.bubbles) {
          break;
        }
        current = current.parentNode;
      }
      return !event.defaultPrevented;
    },
    focus: () => {},
    getAttribute: (name: string) => element.__attrs.get(name) ?? null,
    insertBefore: (child: TestNode, beforeChild?: TestNode | null) => {
      child.parentNode = element as unknown as TestElement;
      const beforeIndex = beforeChild
        ? element.childNodes.indexOf(beforeChild)
        : -1;
      if (beforeIndex >= 0) {
        element.childNodes.splice(beforeIndex, 0, child);
      } else {
        element.childNodes.push(child);
      }
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as TestElement | null,
    removeAttribute: (name: string) => {
      element.__attrs.delete(name);
    },
    removeChild: (child: TestNode) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    removeEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(
        type,
        (element.__listeners.get(type) ?? []).filter((item) => item !== handler),
      );
    },
    setAttribute: (name: string, value: string) => {
      element.__attrs.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
    value: "",
  };
  return element as unknown as TestElement;
}

function installMinimalDom() {
  const windowListeners = new Map<string, TestEventHandler[]>();
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3 as const,
      nodeValue,
      ownerDocument: documentMock as unknown as Document,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: (type: string, handler: TestEventHandler) => {
      const handlers = windowListeners.get(type) ?? [];
      handlers.push(handler);
      windowListeners.set(type, handlers);
    },
    cancelAnimationFrame: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: (type: string, handler: TestEventHandler) => {
      windowListeners.set(
        type,
        (windowListeners.get(type) ?? []).filter((item) => item !== handler),
      );
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
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
    dispatchWindowEvent: (event: TestEvent) => {
      event.preventDefault ??= () => {
        event.defaultPrevented = true;
      };
      for (const handler of windowListeners.get(event.type) ?? []) {
        handler(event);
      }
      return !event.defaultPrevented;
    },
  };
}

function getLatestInputProps() {
  const props = capturedInputProps.at(-1);
  expect(props).toBeDefined();
  return props!;
}

function getLatestButtonProps(label: string) {
  for (let index = capturedButtonProps.length - 1; index >= 0; index -= 1) {
    if (capturedButtonProps[index]?.["aria-label"] === label) {
      return capturedButtonProps[index]!;
    }
  }
  throw new Error(`没有找到按钮: ${label}`);
}

async function renderDialog({
  conversationMatchCount = 1,
  fileChangeMatchCount = 1,
}: {
  conversationMatchCount?: number;
  fileChangeMatchCount?: number;
} = {}) {
  const { TaskFindDialog } = await import("@/quickpick/TaskFindDialog.js");
  const { container, dispatchWindowEvent } = installMinimalDom();
  const root: Root = createRoot(container);
  const callbacks = {
    onConversationFindChange: vi.fn(),
    onConversationFindNavigate: vi.fn(),
    onFileChangeFindChange: vi.fn(),
    onFileChangeFindNavigate: vi.fn(),
    onOpenChange: vi.fn(),
    onOpenFileChanges: vi.fn(),
  };

  act(() => {
    root.render(
      createElement(TaskFindDialog, {
        open: true,
        placement: "chat",
        focusRequestId: 0,
        conversationMatchCount,
        conversationMatchIndex: 0,
        fileChangeMatchCount,
        fileChangeMatchIndex: 0,
        ...callbacks,
      }),
    );
  });

  act(() => {
    getLatestInputProps().onChange?.({ target: { value: "needle" } });
  });

  return { callbacks, dispatchWindowEvent, root };
}

function clearFindCallbacks(callbacks: Awaited<ReturnType<typeof renderDialog>>["callbacks"]) {
  callbacks.onConversationFindChange.mockClear();
  callbacks.onConversationFindNavigate.mockClear();
  callbacks.onFileChangeFindChange.mockClear();
  callbacks.onFileChangeFindNavigate.mockClear();
}

function triggerSixNavigationEntries() {
  act(() => {
    getLatestButtonProps("quickPick.find.previous").onClick?.();
    getLatestButtonProps("quickPick.find.next").onClick?.();
    getLatestInputProps().onKeyDown?.({
      key: "ArrowUp",
      preventDefault: vi.fn(),
      shiftKey: false,
    });
    getLatestInputProps().onKeyDown?.({
      key: "ArrowDown",
      preventDefault: vi.fn(),
      shiftKey: false,
    });
    getLatestInputProps().onKeyDown?.({
      key: "Enter",
      preventDefault: vi.fn(),
      shiftKey: false,
    });
    getLatestInputProps().onKeyDown?.({
      key: "Enter",
      preventDefault: vi.fn(),
      shiftKey: true,
    });
  });
}

describe("TaskFindDialog navigation", () => {
  afterEach(() => {
    capturedButtonProps.length = 0;
    capturedInputProps.length = 0;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("routes both buttons and Enter shortcuts through conversation navigate", async () => {
    const { callbacks, root } = await renderDialog();
    clearFindCallbacks(callbacks);

    triggerSixNavigationEntries();

    expect(callbacks.onConversationFindNavigate.mock.calls).toEqual([
      ["needle", 0],
      ["needle", 0],
      ["needle", 0],
      ["needle", 0],
      ["needle", 0],
      ["needle", 0],
    ]);
    expect(callbacks.onConversationFindChange).not.toHaveBeenCalled();
    expect(callbacks.onFileChangeFindChange).not.toHaveBeenCalled();
    expect(callbacks.onFileChangeFindNavigate).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("keeps file-change navigation isolated from conversation callbacks", async () => {
    const { callbacks, root } = await renderDialog();
    act(() => {
      getLatestButtonProps("quickPick.find.scope.changes").onClick?.();
    });
    clearFindCallbacks(callbacks);

    triggerSixNavigationEntries();

    expect(callbacks.onFileChangeFindNavigate.mock.calls).toEqual([
      ["needle", 0],
      ["needle", 0],
      ["needle", 0],
      ["needle", 0],
      ["needle", 0],
      ["needle", 0],
    ]);
    expect(callbacks.onFileChangeFindChange).not.toHaveBeenCalled();
    expect(callbacks.onConversationFindChange).not.toHaveBeenCalled();
    expect(callbacks.onConversationFindNavigate).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("ignores every navigation entry when there are no matches", async () => {
    const { callbacks, root } = await renderDialog({
      conversationMatchCount: 0,
      fileChangeMatchCount: 0,
    });
    clearFindCallbacks(callbacks);

    triggerSixNavigationEntries();

    expect(callbacks.onConversationFindChange).not.toHaveBeenCalled();
    expect(callbacks.onConversationFindNavigate).not.toHaveBeenCalled();
    expect(callbacks.onFileChangeFindChange).not.toHaveBeenCalled();
    expect(callbacks.onFileChangeFindNavigate).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("keeps find open when another active layer already handled Escape", async () => {
    const { callbacks, dispatchWindowEvent, root } = await renderDialog();
    callbacks.onOpenChange.mockClear();

    act(() => {
      dispatchWindowEvent({
        defaultPrevented: true,
        key: "Escape",
        type: "keydown",
      });
    });

    expect(callbacks.onOpenChange).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("closes find and consumes an unhandled Escape", async () => {
    const { callbacks, dispatchWindowEvent, root } = await renderDialog();
    callbacks.onOpenChange.mockClear();
    const event: TestEvent = {
      defaultPrevented: false,
      key: "Escape",
      type: "keydown",
    };

    act(() => {
      dispatchWindowEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false);

    act(() => root.unmount());
  });
});
