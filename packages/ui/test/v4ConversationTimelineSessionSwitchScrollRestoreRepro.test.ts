// 复现测试（ZCT-2092635483465441280 / ZCT-2092650540916523008 / ZCT-202608-C5F84801）：
// 切换/打开会话时滚动落在"既不是底部、也不是上次阅读位置"的随机历史中部。
//
// 回归断言按【预期行为】书写，锁定以下两个曾经导致随机历史落点的边界：
// 1. lease 竞态：SessionPane 切会话不重挂、lease 在 useEffect 里晚一拍到达，
//    scrollMemoryKey/sessionKey 先变而 rows 仍是旧会话内容；恢复 effect
//    （ConversationTimeline.tsx 会话切换 effect）在旧会话坐标系上执行像素钳制，
//    之后 rows 换成新会话（keep-warm 30s 内不经过 0 行）也不再重跑恢复。
// 2. 分片坐标系错位：记忆保存的是"全量窗口 × 真实测高"下的像素 scrollTop；
//    冷开只有尾部 60 行 + 72px 估算（heightCache 已清），钳制后的落点不再对应
//    保存时的阅读位置，且内容补齐后没有任何重新锚定。
//
// 器具复制自 v4ConversationTimelineScrollMemory.test.ts（最小 DOM + mock virtualizer）。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_V4_TIMELINE, TID_V4_TIMELINE_BOTTOM } from "@zcode/shared";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import {
  clearChatSessionScrollMemoryForTest,
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
  scrollOffset: null as number | null,
  scrollRect: null as { height: number } | null,
  scrollToIndex: vi.fn(),
  shouldAdjustScrollPositionOnItemSizeChange: null as
    | null
    | ((item: { end: number; start: number }) => boolean),
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
        // 与浏览器一致：赋值按当前内容高度钳制。
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

function findByTestId(node: TestElement, testId: string): TestElement | null {
  if (node.getAttribute("data-testid") === testId) return node;
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    const match = findByTestId(child, testId);
    if (match) return match;
  }
  return null;
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

function userInputRow(rowId: number): UserInputRow {
  return {
    rowId,
    turnId: `turn-${rowId}`,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: `message ${rowId}`,
    attachments: [],
  };
}

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
  rows: readonly ConversationRow[],
  options: { canLoadOlder?: boolean; totalCount?: number } = {},
): void {
  root.render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationTimeline, {
        canLoadOlder: options.canLoadOlder,
        rows,
        totalCount: options.totalCount ?? rows.length,
        sessionKey,
        scrollMemoryKey,
        rowContext,
      }),
    ),
  );
}

const KEY_A = "workspace::pane:a::session:a";
const KEY_B = "workspace::pane:a::session:b";
const ROWS_A = [userInputRow(1), userInputRow(2), userInputRow(3)];
// 新会话的分片尾窗（rowId 不同即可；真实场景是最后 60 行）。
const ROWS_B_TAIL = [userInputRow(101), userInputRow(102), userInputRow(103)];

beforeEach(() => {
  clearChatSessionScrollMemoryForTest();
  layout.clientHeight = 300;
  layout.scrollHeight = 1200;
  nextFrameId = 1;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
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

describe("会话切换滚动恢复（ZCT 复现）", () => {
  it("lease 迟一拍时，恢复必须以新会话内容为坐标系，而不是把旧会话钳制值当成最终落点", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);

    // ── commit 0：正在看会话 A（无记忆 → 吸底）。
    act(() => renderTimeline(mountedRoot!, "session-a", KEY_A, ROWS_A));
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      flushScheduledMicrotasks();
    });
    expect(timeline.scrollTop).toBe(900); // A 的底部（1200 - 300）

    // 会话 B 上次离开时处于离底阅读态：位置保存在 B 的全量坐标系（scrollHeight=20000）。
    saveChatSessionScrollMemoryState(KEY_B, {
      scrollTop: 5000,
      scrollHeight: 20000,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });

    // ── commit 1：SessionPane 切到 B。sessionKey/scrollMemoryKey 立即变化，
    // 但 lease 在 useEffect 里晚一拍 → rows 仍是 A 的内容（SessionPane.tsx rows
    // 无 sessionLeaseReady 守卫）。恢复 effect 此刻执行：clamp(5000, 1200-300)=900。
    act(() => renderTimeline(mountedRoot!, "session-b", KEY_B, ROWS_A));
    act(() => {
      flushAnimationFrame(); // 恢复 correction rAF（rows 仍是 A）
      flushAnimationFrame(); // release guard rAF
      flushScheduledMicrotasks();
    });

    // ── commit 2：lease 到位，B 在 keep-warm 内 → rows 直接替换为 B 的窗口，
    // 从未经过 0 行；B 的内容高度为 2400。
    act(() => {
      layout.scrollHeight = 2400;
      renderTimeline(mountedRoot!, "session-b", KEY_B, ROWS_B_TAIL);
    });
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      flushScheduledMicrotasks();
    });

    // 预期行为：恢复应以 B 的实际内容为坐标系 → clamp(5000, 2400-300)=2100
    //（至少要把保存位置在新坐标系下重放）。
    // 回归前实现：停在 commit 1 里按 A 内容钳出的 900 —— 既不是 B 的上次位置，
    // 也不是 B 的底部（2100），即工单描述的"落在历史中间"。
    expect(timeline.scrollTop).toBe(2100);
  });

  it("冷开时记忆的全量坐标像素被分片尾窗钳制后，内容补齐必须重新锚定回保存位置", () => {
    // 上次离开：全量窗口（20000px 高）里读到 12000px 处。
    saveChatSessionScrollMemoryState(KEY_B, {
      scrollTop: 12000,
      scrollHeight: 20000,
      clientHeight: 300,
      wasPinnedToBottom: false,
      updatedAt: 1,
    });

    // 冷开：只有尾部分片 + 72px 估算 → 内容只有 1200px 高。
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    act(() =>
      renderTimeline(mountedRoot!, "session-b", KEY_B, ROWS_B_TAIL, {
        canLoadOlder: true,
        totalCount: 5,
      }),
    );
    const timeline = findByTestId(container, TID_V4_TIMELINE)!;
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      flushScheduledMicrotasks();
    });
    // 恢复被钳进分片坐标系：clamp(12000, 900)=900。
    expect(timeline.scrollTop).toBe(900);
    expect(timeline.getAttribute("data-following")).toBe("false");
    expect(findByTestId(container, TID_V4_TIMELINE_BOTTOM)).not.toBeNull();

    // 历史补拉 + 真实测高完成：更早的行前插，总高度回到 20000。
    act(() => {
      layout.scrollHeight = 20000;
      renderTimeline(
        mountedRoot!,
        "session-b",
        KEY_B,
        [userInputRow(1), userInputRow(2), ...ROWS_B_TAIL],
        { canLoadOlder: false, totalCount: 5 },
      );
    });
    act(() => {
      flushAnimationFrame();
      flushAnimationFrame();
      flushScheduledMicrotasks();
    });

    // 预期行为：内容补齐后应回到保存的阅读位置 12000。
    // 回归前实现：prepend 锚定把"钳制瞬间恰好在视口里的那一行"当作阅读锚点平移
    //（900 + 18800 = 19700），落点漂到接近底部/任意历史处，保存位置永久丢失。
    expect(timeline.scrollTop).toBe(12000);
  });
});
