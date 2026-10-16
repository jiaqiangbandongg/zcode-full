import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_V4_TIMELINE, TID_V4_TIMELINE_BOTTOM } from "@zcode/shared";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import {
  clearChatSessionScrollMemoryForTest,
  readChatSessionScrollMemoryState,
  saveChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";

const layout = vi.hoisted(() => ({ clientHeight: 300, scrollHeight: 1200 }));
const virtualizer = vi.hoisted(() => ({
  getVirtualItemForOffset: vi.fn(),
  getTotalSize: () => layout.scrollHeight,
  getVirtualItems: () => [],
  measurementsCache: [] as Array<{
    end: number;
    index: number;
    key: string;
    lane: number;
    size: number;
    start: number;
  }>,
  measure: vi.fn(),
  measureElement: vi.fn(),
  resizeItem: vi.fn(),
  scrollOffset: null as number | null,
  scrollRect: null as { height: number } | null,
  scrollToIndex: vi.fn(),
  shouldAdjustScrollPositionOnItemSizeChange: null as null | ((item: {
    end: number;
    start: number;
  }) => boolean),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => virtualizer,
}));

vi.mock("@/v4/ConversationTurnGroup.js", async () => {
  const React = await import("react");
  return {
    ConversationTurnGroup: () => React.createElement("div"),
  };
});

vi.mock("@/v4/ConversationTurnNavigator.js", () => ({
  ConversationTurnNavigator: () => null,
}));

vi.mock("@/v4/useConversationTimelineFind.js", () => ({
  useConversationTimelineFind: () => undefined,
}));

type TestEventHandler = (event: Record<string, unknown>) => void;
type TestElement = Element & {
  __attrs: Map<string, string>;
  __listeners: Map<string, TestEventHandler[]>;
  childNodes: TestElement[];
  parentNode: TestElement | null;
  scrollTop: number;
};

let nextFrameId = 1;
const animationFrames = new Map<number, FrameRequestCallback>();
const scheduledMicrotasks: Array<() => void> = [];
const nativeQueueMicrotask = globalThis.queueMicrotask;
let mountedRoot: Root | null = null;
let collapseLayoutWhenTimelineBecomesEmpty = false;

function createMinimalElement(ownerDocument: Document, tagName = "div"): TestElement {
  let scrollTop = 0;
  const element = {
    __attrs: new Map<string, string>(),
    __listeners: new Map<string, TestEventHandler[]>(),
    addEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(type, [...(element.__listeners.get(type) ?? []), handler]);
    },
    appendChild: (child: TestElement) => {
      child.parentNode = element as unknown as TestElement;
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as TestElement[],
    dispatchEvent: (event: Event) => {
      // Bug 回归：ConversationTimeline 会在 commit 后派发标准 scroll 事件同步
      // virtualizer；最小 DOM 必须实现真实依赖，不能只提供测试专用 dispatchScroll。
      const forwardedEvent = {
        bubbles: event.bubbles,
        cancelBubble: event.cancelBubble,
        currentTarget: element,
        defaultPrevented: event.defaultPrevented,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        target: element,
        timeStamp: event.timeStamp,
        type: event.type,
      };
      for (const handler of element.__listeners.get(event.type) ?? []) {
        handler(forwardedEvent);
      }
      return !event.defaultPrevented;
    },
    getBoundingClientRect: () => ({
      bottom: layout.clientHeight,
      height: layout.clientHeight,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    getAttribute: (name: string) => element.__attrs.get(name) ?? null,
    insertBefore: (child: TestElement, beforeChild?: TestElement | null) => {
      child.parentNode = element as unknown as TestElement;
      const index = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (index >= 0) element.childNodes.splice(index, 0, child);
      else element.childNodes.push(child);
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as TestElement | null,
    removeAttribute: (name: string) => element.__attrs.delete(name),
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
    querySelectorAll: () => [],
    setAttribute: (name: string, value: string) => {
      element.__attrs.set(name, String(value));
      if (
        collapseLayoutWhenTimelineBecomesEmpty &&
        name === "data-render-unit-count" &&
        String(value) === "0"
      ) {
        layout.scrollHeight = layout.clientHeight;
      }
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  Object.defineProperties(element, {
    clientHeight: { get: () => layout.clientHeight },
    scrollHeight: { get: () => layout.scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(
          Math.max(Number(value) || 0, 0),
          Math.max(layout.scrollHeight - layout.clientHeight, 0),
        );
      },
    },
  });
  return element as unknown as TestElement;
}

function installMinimalDom(): TestElement {
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
  } as unknown as Document & { defaultView?: unknown };
  const windowMock = {
    setTimeout,
    clearTimeout,
    addEventListener: () => {},
    cancelAnimationFrame: (frameId: number) => animationFrames.delete(frameId),
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    queueMicrotask: (callback: () => void) => scheduledMicrotasks.push(callback),
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      animationFrames.set(frameId, callback);
      return frameId;
    },
  };
  documentMock.defaultView = windowMock;
  Object.assign(globalThis, {
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    queueMicrotask: windowMock.queueMicrotask,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}

function findByTestId(node: TestElement, testId: string, attribute = "data-testid"): TestElement | null {
  if (node.getAttribute(attribute) === testId) return node;
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    const match = findByTestId(child, testId, attribute);
    if (match) return match;
  }
  return null;
}

function dispatchScroll(element: TestElement): void {
  element.dispatchEvent(new Event("scroll"));
}

function dispatchWheel(element: TestElement, deltaY: number): void {
  const event = {
    bubbles: true,
    cancelBubble: false,
    currentTarget: element,
    defaultPrevented: false,
    deltaMode: 0,
    deltaX: 0,
    deltaY,
    preventDefault: () => {},
    stopPropagation: () => {},
    target: element,
    timeStamp: Date.now(),
    type: "wheel",
  };
  const path: TestElement[] = [];
  let current: TestElement | null = element;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  for (const currentTarget of path.reverse()) {
    event.currentTarget = currentTarget;
    for (const handler of currentTarget.__listeners.get("wheel") ?? []) handler(event);
  }
  for (const currentTarget of path) {
    event.currentTarget = currentTarget;
    for (const handler of currentTarget.__listeners.get("wheel") ?? []) handler(event);
  }
}

function flushAnimationFrame(): void {
  const frameIds = [...animationFrames.keys()];
  for (const frameId of frameIds) {
    const callback = animationFrames.get(frameId);
    if (!callback) continue;
    animationFrames.delete(frameId);
    callback(0);
  }
}

function flushScheduledMicrotasks(): void {
  while (scheduledMicrotasks.length > 0) {
    scheduledMicrotasks.shift()?.();
  }
}

const row: UserInputRow = {
  rowId: 1,
  turnId: "turn-1",
  createdAt: 1_700_000_000_000,
  createdAtSeq: 1,
  kind: "userInput",
  origin: "realUser",
  text: "hello",
  attachments: [],
};

const rowContext: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

function renderTimeline(
  root: Root,
  sessionKey: string,
  scrollMemoryKey: string | null,
  scrollToBottomActionRef?: { current: (() => void) | null },
  options: {
    canLoadOlder?: boolean;
    onLoadOlder?: () => void;
    rows?: readonly ConversationRow[];
    withComposerDock?: boolean;
  } = {},
): void {
  const timelineRows = options.rows ?? [row];
  root.render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationTimeline, {
        canLoadOlder: options.canLoadOlder,
        onLoadOlder: options.onLoadOlder,
        scrollToBottomActionRef,
        rows: timelineRows,
        totalCount: timelineRows.length,
        sessionKey,
        scrollMemoryKey,
        rowContext,
        // composer dock。它上方那条浮层带随浮岛一起删除，圆钮回到自己的居中定位。
        ...(options.withComposerDock
          ? {
              bottomDock: createElement("div", { "data-testid": "test-composer-dock" }),
            }
          : {}),
      }),
    ),
  );
}

beforeEach(() => {
  clearChatSessionScrollMemoryForTest();
  layout.clientHeight = 300;
  layout.scrollHeight = 1200;
  nextFrameId = 1;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
  collapseLayoutWhenTimelineBecomesEmpty = false;
  virtualizer.getVirtualItemForOffset.mockReset();
  virtualizer.measurementsCache = [];
  virtualizer.measure.mockClear();
});

afterEach(() => {
  act(() => {
    flushScheduledMicrotasks();
    mountedRoot?.unmount();
    flushScheduledMicrotasks();
  });
  mountedRoot = null;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
  globalThis.queueMicrotask = nativeQueueMicrotask;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ConversationTimeline renderer-local scroll memory", () => {
  it("跟随时先提交新行高再吸底，用户离底后 resize 不抢回滚动权", () => {
    const container = installMinimalDom();
    const observations: Array<{ target: Element; callback: ResizeObserverCallback }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          observations.push({ target, callback: this.callback });
        }
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      mountedRoot = createRoot(container);
      const backToBottom = { current: null as (() => void) | null };
      act(() => {
        renderTimeline(mountedRoot!, "session-1", null, backToBottom);
      });
      act(() => flushAnimationFrame());
      const timeline = findByTestId(container, TID_V4_TIMELINE)!;
      const observers = observations.filter((item) => item.target === timeline);
      expect(observers.length).toBeGreaterThan(0);
      const column = findByTestId(container, "true", "data-v4-timeline-virtual-history")!;
      let measuredHeight = 1200;
      let contentWidth = 1000;
      Object.defineProperty(column, "clientWidth", { configurable: true, get: () => contentWidth });
      const row = {
        getAttribute: () => "0",
        getBoundingClientRect: () => ({ height: measuredHeight }),
      } as unknown as Element;
      const query = vi
        .spyOn(column, "querySelectorAll")
        .mockReturnValue([row] as unknown as NodeListOf<Element>);
      // 模拟库已测高但 React 尚未提交占位高度；只有重新 render 才能读到新布局。
      const totalSize = vi.spyOn(virtualizer, "getTotalSize").mockImplementation(() => {
        layout.scrollHeight = measuredHeight;
        return measuredHeight;
      });
      for (const height of [1500, 1800, 1350, 2100]) {
        act(() => {
          measuredHeight = height;
          contentWidth -= 10;
          for (const observer of observers) observer.callback([], {} as ResizeObserver);
        });
        expect(timeline.scrollTop).toBe(height - layout.clientHeight);
        expect(virtualizer.resizeItem).toHaveBeenLastCalledWith(0, height);
      }
      act(() => {
        flushAnimationFrame();
        flushAnimationFrame();
        dispatchWheel(timeline, -120);
        timeline.scrollTop = 200;
        dispatchScroll(timeline);
      });
      expect(timeline.getAttribute("data-following")).toBe("false");
      act(() => {
        measuredHeight = 2400;
        contentWidth -= 10;
        for (const observer of observers) observer.callback([], {} as ResizeObserver);
      });
      expect(timeline.scrollTop).toBe(200);
      act(() => backToBottom.current?.());
      contentWidth -= 10;
      act(() => {
        for (const observer of observers) observer.callback([], {} as ResizeObserver);
      });
      expect(timeline.scrollTop).toBe(2100);
      // 用户在批量测高期间上滚，提交后必须再次检查跟随权。
      virtualizer.resizeItem.mockImplementationOnce(() => dispatchWheel(timeline, -120));
      const beforeInterrupt = timeline.scrollTop;
      act(() => {
        measuredHeight = 2700;
        contentWidth -= 10;
        for (const observer of observers) observer.callback([], {} as ResizeObserver);
      });
      expect(timeline.getAttribute("data-following")).toBe("false");
      expect(timeline.scrollTop).toBe(beforeInterrupt);
      totalSize.mockRestore();
      query.mockRestore();
      virtualizer.resizeItem.mockReset();
    } finally {
      vi.restoreAllMocks();
      virtualizer.resizeItem.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the visible turn anchored when a large prepend unmounts its DOM row", () => {
    layout.scrollHeight = 5000;
    const previousAnchorMeasurement = {
      end: 620,
      index: 0,
      key: "turn-100",
      lane: 0,
      size: 120,
      start: 500,
    };
    virtualizer.getVirtualItemForOffset.mockReturnValue(previousAnchorMeasurement);
    virtualizer.measurementsCache = [previousAnchorMeasurement];
    const onLoadOlder = vi.fn();
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-1",
        "workspace::pane:a::session:1",
        undefined,
        {
          canLoadOlder: true,
          onLoadOlder,
          rows: [{ ...row, rowId: 100, turnId: "turn-100" }],
        },
      ),
    );
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      dispatchWheel(timeline, -120);
      timeline.scrollTop = 500;
      dispatchScroll(timeline);
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    const olderRows: UserInputRow[] = Array.from({ length: 10 }, (_, index) => ({
      ...row,
      rowId: index + 1,
      turnId: `turn-${index + 1}`,
    }));
    virtualizer.measurementsCache = [
      ...olderRows.map((olderRow, index) => ({
        end: (index + 1) * 100,
        index,
        key: olderRow.turnId,
        lane: 0,
        size: 100,
        start: index * 100,
      })),
      {
        ...previousAnchorMeasurement,
        end: 1620,
        index: olderRows.length,
        start: 1500,
      },
    ];
    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-1",
        "workspace::pane:a::session:1",
        undefined,
        {
          canLoadOlder: false,
          onLoadOlder,
          rows: [...olderRows, { ...row, rowId: 100, turnId: "turn-100" }],
        },
      ),
    );

    // 旧锚点已在 viewport + 8 行 overscan 之外，DOM 查询和旧 totalSize 都无法给出位移。
    expect(timeline.querySelectorAll('[data-v4-turn-unit="true"]')).toHaveLength(0);
    expect(timeline.scrollTop).toBe(1500);
  });

  it("restores a detached history position immediately and after RAF correction", () => {
    saveChatSessionScrollMemoryState("workspace::pane:a::session:1", {
      scrollTop: 240,
      scrollHeight: 1000,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() => renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1"));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;

    expect(timeline.scrollTop).toBe(240);
    expect((timeline.childNodes[0] as unknown as HTMLElement).style.overflowAnchor).toBe("none");
    expect(
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange?.({
        end: 100,
        start: 0,
      }),
    ).toBe(false);
    expect(timeline.getAttribute("data-following")).toBe("false");
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).not.toBeNull();

    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
    });
    expect(timeline.scrollTop).toBe(240);
    expect(
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange?.({
        end: 100,
        start: 0,
      }),
    ).toBe(true);
    expect(
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange?.({
        end: 300,
        start: 100,
      }),
    ).toBe(false);
  });

  it("restores pinned intent to the current bottom after background growth", () => {
    saveChatSessionScrollMemoryState("workspace::pane:a::session:1", {
      scrollTop: 700,
      scrollHeight: 1000,
      clientHeight: 300,
      wasPinnedToBottom: true,
      updatedAt: 1,
    });
    layout.scrollHeight = 1800;
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() => renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1"));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;

    expect(timeline.scrollTop).toBe(1500);
    expect(timeline.getAttribute("data-following")).toBe("true");
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).toBeNull();
    expect(
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange?.({
        end: 100,
        start: 0,
      }),
    ).toBe(false);
  });

  it("keeps following when terminal layout shrink moves scrollTop without user input", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() => renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1"));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    expect(timeline.scrollTop).toBe(900);

    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      layout.scrollHeight = 1000;
      timeline.scrollTop = 700;
      renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1");
      dispatchScroll(timeline);
    });

    expect(timeline.scrollTop).toBe(700);
    expect(timeline.getAttribute("data-following")).toBe("true");
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).toBeNull();
  });

  it("lets an upward wheel win when terminal layout changes in the same commit", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() => renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1"));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;

    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      dispatchWheel(timeline, -120);
      timeline.scrollTop = 600;
      layout.scrollHeight = 1100;
      renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1");
      dispatchScroll(timeline);
    });

    expect(timeline.scrollTop).toBe(600);
    expect(timeline.getAttribute("data-following")).toBe("false");
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).not.toBeNull();
  });

  it("exposes the same one-shot bottom action used by prompt submission", () => {
    saveChatSessionScrollMemoryState("workspace::pane:a::session:1", {
      scrollTop: 240,
      scrollHeight: 1200,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const scrollToBottomActionRef = { current: null as (() => void) | null };

    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-1",
        "workspace::pane:a::session:1",
        scrollToBottomActionRef,
      ),
    );
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    expect(timeline.getAttribute("data-following")).toBe("false");

    act(() => scrollToBottomActionRef.current?.());

    expect(timeline.scrollTop).toBe(900);
    expect(timeline.getAttribute("data-following")).toBe("true");
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).toBeNull();

    act(() => {
      dispatchWheel(timeline, -120);
      timeline.scrollTop = 240;
      dispatchScroll(timeline);
    });
    expect(timeline.getAttribute("data-following")).toBe("false");
  });

  it("commits a bottom action before an immediate session switch", () => {
    saveChatSessionScrollMemoryState("workspace::pane:a::session:1", {
      scrollTop: 240,
      scrollHeight: 1200,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const scrollToBottomActionRef = { current: null as (() => void) | null };

    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-1",
        "workspace::pane:a::session:1",
        scrollToBottomActionRef,
      ),
    );

    act(() => scrollToBottomActionRef.current?.());

    expect(
      readChatSessionScrollMemoryState("workspace::pane:a::session:1"),
    ).toMatchObject({
      scrollTop: 900,
      wasPinnedToBottom: true,
    });

    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-2",
        "workspace::pane:a::session:2",
      ),
    );
    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-1",
        "workspace::pane:a::session:1",
      ),
    );

    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    expect(timeline.scrollTop).toBe(900);
    expect(timeline.getAttribute("data-following")).toBe("true");
  });

  it("restores a detached position after delayed rows arrive", () => {
    saveChatSessionScrollMemoryState("workspace::pane:a::session:1", {
      scrollTop: 240,
      scrollHeight: 1200,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });
    layout.scrollHeight = layout.clientHeight;
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-1",
        "workspace::pane:a::session:1",
        undefined,
        { rows: [] },
      ),
    );

    let timeline = findByTestId(container, TID_V4_TIMELINE)!;
    expect(timeline.scrollTop).toBe(0);
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).toBeNull();

    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
    });

    layout.scrollHeight = 1200;
    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-1",
        "workspace::pane:a::session:1",
        undefined,
        { rows: [row] },
      ),
    );

    timeline = findByTestId(container, TID_V4_TIMELINE)!;
    expect(timeline.scrollTop).toBe(240);
    expect(timeline.getAttribute("data-following")).toBe("false");
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).not.toBeNull();
  });

  it("keeps detached memory when switching away before rows arrive", () => {
    saveChatSessionScrollMemoryState("workspace::pane:a::session:1", {
      scrollTop: 240,
      scrollHeight: 1200,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });
    layout.scrollHeight = layout.clientHeight;
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-1",
        "workspace::pane:a::session:1",
        undefined,
        { rows: [] },
      ),
    );
    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-2",
        "workspace::pane:a::session:2",
        undefined,
        { rows: [] },
      ),
    );

    expect(
      readChatSessionScrollMemoryState("workspace::pane:a::session:1"),
    ).toMatchObject({
      scrollTop: 240,
      wasPinnedToBottom: false,
    });
  });

  it("cancels the second restore write when the user takes scroll ownership", () => {
    saveChatSessionScrollMemoryState("workspace::pane:a::session:1", {
      scrollTop: 240,
      scrollHeight: 1200,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() => renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1"));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      dispatchWheel(timeline, 120);
      timeline.scrollTop = 520;
      dispatchScroll(timeline);
      flushAnimationFrame();
      flushAnimationFrame();
    });

    expect(timeline.scrollTop).toBe(520);
    expect(readChatSessionScrollMemoryState("workspace::pane:a::session:1")?.scrollTop).toBe(520);
  });

  it("saves an unobserved up-scroll on scope change and keeps pane keys isolated", () => {
    saveChatSessionScrollMemoryState("workspace::pane:b::session:1", {
      scrollTop: 620,
      scrollHeight: 1200,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() => renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1"));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      timeline.scrollTop = 310;
      renderTimeline(mountedRoot!, "draft", null);
    });
    act(() => {
      renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1");
    });

    expect(timeline.scrollTop).toBe(310);
    expect(readChatSessionScrollMemoryState("workspace::pane:a::session:1")?.wasPinnedToBottom)
      .toBe(false);
    expect(readChatSessionScrollMemoryState("workspace::pane:b::session:1")?.scrollTop).toBe(620);
  });

  it("captures an unobserved downward scroll before the scope DOM mutates", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() => renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1"));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      dispatchWheel(timeline, -120);
      timeline.scrollTop = 240;
      dispatchScroll(timeline);
      timeline.scrollTop = 520;
      renderTimeline(mountedRoot!, "draft", null);
    });

    expect(readChatSessionScrollMemoryState("workspace::pane:a::session:1")?.scrollTop).toBe(520);
    expect(readChatSessionScrollMemoryState("workspace::pane:a::session:1")?.wasPinnedToBottom)
      .toBe(false);
  });

  it("does not overwrite a saved user position after the next scope collapses the DOM", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() => renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1"));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      dispatchWheel(timeline, -120);
      timeline.scrollTop = 280;
      dispatchScroll(timeline);
      collapseLayoutWhenTimelineBecomesEmpty = true;
      renderTimeline(mountedRoot!, "draft", null);
    });

    expect(readChatSessionScrollMemoryState("workspace::pane:a::session:1")?.scrollTop).toBe(280);
    expect(readChatSessionScrollMemoryState("workspace::pane:a::session:1")?.wasPinnedToBottom)
      .toBe(false);
  });

  it("saves the last observed DOM position when the timeline unmounts", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    act(() => renderTimeline(mountedRoot!, "session-1", "workspace::pane:a::session:1"));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      timeline.scrollTop = 410;
      mountedRoot?.unmount();
      mountedRoot = null;
    });

    expect(readChatSessionScrollMemoryState("workspace::pane:a::session:1")?.scrollTop).toBe(410);
    expect(readChatSessionScrollMemoryState("workspace::pane:a::session:1")?.wasPinnedToBottom)
      .toBe(false);
  });

  // 浮岛删除后（docs/dynamic-workflow/presentation.md「Other places a run appears」item 1）composer 上方不再有共享的
  // 浮层栈：`composerOverlay` 槽随它唯一的住户一起消失，回到底部圆钮**回到改动前的独立定位**
  // （`bottom-full` + `mb-2` 居中）。这条用例钉的就是那次几何回退——栈壳还在的话，圆钮会被一层
  // `pointer-events-none` 的容器包住，而那层已经没有任何存在理由。
  //
  // 「按钮还点得动」在这里只能按**类契约**断言，不能靠 fire 一次 click：这个最小 DOM 的
  // dispatchEvent 不冒泡，而 React 把 click 委托在根容器上，事件到不了；换成 jsdom 也一样
  // 无效——jsdom 不做 pointer-events 命中测试，`fireEvent.click` 在 `pointer-events: none`
  // 上照样成功。也就是说只有这条 class 断言会在真的漏掉 `pointer-events-auto` 时变红。
  it("centers the back-to-bottom button on its own once the overlay stack is gone", () => {
    saveChatSessionScrollMemoryState("workspace::pane:a::session:1", {
      scrollTop: 240,
      scrollHeight: 1000,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const scrollToBottomActionRef = { current: null as (() => void) | null };

    act(() =>
      renderTimeline(
        mountedRoot!,
        "session-1",
        "workspace::pane:a::session:1",
        scrollToBottomActionRef,
        { withComposerDock: true },
      ),
    );

    const button = findByTestId(container, TID_V4_TIMELINE_BOTTOM)!;
    // 槽位与它的栈壳都不复存在：圆钮自己定位在 dock 的 anchor 上。
    expect(findByTestId(container, "v4-composer-overlay")).toBeNull();
    const buttonClass = button.getAttribute("class") ?? "";
    expect(buttonClass).toContain("absolute bottom-full left-1/2");
    expect(buttonClass).toContain("mb-2");
    expect(buttonClass).toContain("-translate-x-1/2");
    expect(buttonClass).toContain("pointer-events-auto");
    // dock 仍在（圆钮锚在它上面），只有浮层带走了。
    expect(findByTestId(container, "test-composer-dock")).not.toBeNull();

    act(() => scrollToBottomActionRef.current?.());
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).toBeNull();
  });
});
