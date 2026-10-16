import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebRemoteControlTaskTarget } from "@zcode/shared";

type TestEvent = {
  bubbles?: boolean;
  currentTarget?: TestElement;
  relatedTarget?: unknown;
  target?: TestElement;
  type: string;
};

type TestEventHandler = (event: TestEvent) => void;

type TestElement = Element & {
  __attrs: Map<string, string>;
  __listeners: Map<string, TestEventHandler[]>;
  childNodes: TestElement[];
  dispatchEvent: (event: TestEvent) => boolean;
  parentNode: TestElement | null;
};

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    Archive: createIcon("archive"),
    ArchiveX: createIcon("archive-x"),
    CloudDownload: createIcon("cloud-download"),
    LoaderIcon: createIcon("loader"),
    Pin: createIcon("pin"),
    Trash2: createIcon("trash"),
  };
});

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
}));

vi.mock("@/lib/taskListItemPresentation.js", () => ({
  formatTaskRelativeTime: () => "now",
}));

const stableIntl = {
  formatMessage: ({ id }: { id: string }) => id,
};

function createTask(overrides: Partial<WebRemoteControlTaskTarget> = {}): WebRemoteControlTaskTarget {
  return {
    createdAt: 1,
    taskId: "task-1",
    title: "Task 1",
    updatedAt: 2,
    workspaceKind: "local",
    workspaceLabel: "Project",
    workspacePath: "/workspace",
    ...overrides,
  };
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    __attrs: new Map<string, string>(),
    __listeners: new Map<string, TestEventHandler[]>(),
    addEventListener: (type: string, handler: TestEventHandler) => {
      const handlers = element.__listeners.get(type) ?? [];
      handlers.push(handler);
      element.__listeners.set(type, handlers);
    },
    appendChild: (child: TestElement) => {
      child.parentNode = element as unknown as TestElement;
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as TestElement[],
    dispatchEvent: (event: TestEvent) => {
      event.target ??= element as unknown as TestElement;
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
      return true;
    },
    getAttribute: (name: string) => element.__attrs.get(name) ?? null,
    insertBefore: (child: TestElement, beforeChild?: TestElement | null) => {
      child.parentNode = element as unknown as TestElement;
      const beforeIndex = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
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
    querySelector: (selector: string) => {
      const attributeMatch = /^\[([^=\]]+)(?:=[^\]]+)?\]$/u.exec(selector);
      if (!attributeMatch) {
        return null;
      }
      return findByAttribute(element as unknown as TestElement, attributeMatch[1]);
    },
    removeAttribute: (name: string) => {
      element.__attrs.delete(name);
    },
    removeChild: (child: TestElement) => {
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
  };
  return element as unknown as TestElement;
}

function findByAttribute(node: TestElement, attributeName: string): TestElement | null {
  if (node.__attrs?.has(attributeName)) {
    return node;
  }
  for (const child of node.childNodes ?? []) {
    const match = findByAttribute(child, attributeName);
    if (match) {
      return match;
    }
  }
  return null;
}

function findByAttributeValue(
  node: TestElement,
  attributeName: string,
  attributeValue: string,
): TestElement | null {
  if (node.__attrs?.get(attributeName) === attributeValue) {
    return node;
  }
  for (const child of node.childNodes ?? []) {
    const match = findByAttributeValue(child, attributeName, attributeValue);
    if (match) {
      return match;
    }
  }
  return null;
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

describe("WebRemoteControlTaskIndexRow hover actions", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders pin and archive actions from row hover state", async () => {
    const { WebRemoteControlTaskIndexRow } = await import("@/WebRemoteControlTaskIndexRow.js");
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    act(() => {
      root.render(
        createElement(WebRemoteControlTaskIndexRow, {
          activeTaskId: null,
          activeWorkspaceKey: "/workspace",
          canMutateTask: true,
          intl: stableIntl,
          mutatingTaskKey: null,
          onArchiveTask: vi.fn(),
          onDeleteArchivedTask: vi.fn(),
          onOpenTask: vi.fn(),
          onToggleTaskPin: vi.fn(),
          onUnarchiveTask: vi.fn(),
          pendingArchiveTaskKey: null,
          switchingTaskKey: null,
          task: createTask(),
          taskSortBy: "updated",
        }),
      );
    });

    expect(findByAttributeValue(container, "aria-label", "taskList.pin")).toBeNull();
    expect(findByAttributeValue(container, "aria-label", "taskList.archive")).toBeNull();

    const row = findByAttribute(container, "data-web-remote-task-row");
    expect(row).not.toBeNull();

    act(() => {
      row?.dispatchEvent({
        bubbles: true,
        relatedTarget: null,
        type: "mouseover",
      });
    });

    const pinButton = findByAttributeValue(container, "aria-label", "taskList.pin");
    expect(pinButton).not.toBeNull();
    expect(pinButton?.__attrs.get("class")).toContain("z-10");
    expect(pinButton?.__attrs.get("class")).toContain("inline-flex");
    expect(findByAttributeValue(container, "aria-label", "taskList.archive")).not.toBeNull();

    act(() => {
      row?.dispatchEvent({
        bubbles: true,
        relatedTarget: null,
        type: "mouseout",
      });
    });

    expect(findByAttributeValue(container, "aria-label", "taskList.pin")).toBeNull();
    expect(findByAttributeValue(container, "aria-label", "taskList.archive")).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders unarchive and delete actions from archived row hover state", async () => {
    const { WebRemoteControlTaskIndexRow } = await import("@/WebRemoteControlTaskIndexRow.js");
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    act(() => {
      root.render(
        createElement(WebRemoteControlTaskIndexRow, {
          activeTaskId: null,
          activeWorkspaceKey: "/workspace",
          canMutateTask: true,
          intl: stableIntl,
          mutatingTaskKey: null,
          onArchiveTask: vi.fn(),
          onDeleteArchivedTask: vi.fn(),
          onOpenTask: vi.fn(),
          onToggleTaskPin: vi.fn(),
          onUnarchiveTask: vi.fn(),
          pendingArchiveTaskKey: null,
          switchingTaskKey: null,
          task: createTask({ archived: true, pinned: true }),
          taskSortBy: "updated",
        }),
      );
    });

    const row = findByAttribute(container, "data-web-remote-task-row");
    expect(row).not.toBeNull();

    act(() => {
      row?.dispatchEvent({
        bubbles: true,
        relatedTarget: null,
        type: "mouseover",
      });
    });

    expect(findByAttributeValue(container, "aria-label", "taskList.unarchive")).not.toBeNull();
    expect(findByAttributeValue(container, "aria-label", "taskList.delete")).not.toBeNull();
    expect(findByAttributeValue(container, "aria-label", "taskList.pin")).toBeNull();
    expect(findByAttributeValue(container, "aria-label", "taskList.unpin")).toBeNull();
    expect(findByAttributeValue(container, "aria-label", "taskList.archive")).toBeNull();

    act(() => {
      root.unmount();
    });
  });
});
