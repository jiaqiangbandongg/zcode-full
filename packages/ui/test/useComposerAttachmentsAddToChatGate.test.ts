import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPromptAttachmentTransferService } from "@zcode/services";
import { useComposerAttachmentUploadStore } from "@/store/composerAttachmentUploadStore.js";
import {
  useComposerAttachments,
  type ComposerAttachmentsApi,
} from "@/v4/composer/useComposerAttachments.js";
import {
  dispatchWhiteboardAddToChat,
  WHITEBOARD_ADD_TO_CHAT_EVENT,
} from "@/lib/whiteboard.js";

const mocks = vi.hoisted(() => ({
  platform: {
    canSelectFilePath: true,
    createTempTextAttachment: vi.fn(),
    getPathForFile: vi.fn(),
    selectFiles: vi.fn(async () => [] as string[]),
  },
  service: null as IPromptAttachmentTransferService | null,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => mocks.platform,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ promptAttachmentTransferService: mocks.service }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

// 复刻 useComposerAttachmentsUpload.test.ts 的 DOM shim：window/document 都是 EventTarget，
// 保证 window.dispatchEvent(CustomEvent) 能驱动 hook 内的 add-to-chat 监听。
function createMinimalElement(ownerDocument: Document) {
  const element = {
    addEventListener: () => {},
    appendChild: (child: Node) => {
      Object.assign(child, { parentNode: element });
      element.childNodes.push(child);
      return child;
    },
    attributes: new Map<string, string>(),
    childNodes: [] as Node[],
    getAttribute: (name: string) => element.attributes.get(name) ?? null,
    insertBefore: (child: Node) => element.appendChild(child),
    nodeName: "DIV",
    nodeType: 1,
    ownerDocument,
    parentNode: null,
    removeAttribute: (name: string) => element.attributes.delete(name),
    removeChild: (child: Node) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      return child;
    },
    removeEventListener: () => {},
    setAttribute: (name: string, value: string) => element.attributes.set(name, value),
    style: {},
    tagName: "DIV",
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const documentMock = {
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    createComment: () => ({ nodeType: 8, parentNode: null }),
    createElement: () => createMinimalElement(documentMock as unknown as Document),
    createTextNode: (nodeValue: string) => ({ nodeType: 3, nodeValue, parentNode: null }),
    defaultView: null as unknown,
    nodeType: 9,
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
  };
  const windowMock = {
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    clearTimeout,
    dispatchEvent: windowTarget.dispatchEvent.bind(windowTarget),
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    setTimeout,
  };
  documentMock.defaultView = windowMock;
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock as unknown as Document);
}

let latestApi: ComposerAttachmentsApi | null = null;

function Probe({ listenAddToChatEvents }: { listenAddToChatEvents?: boolean }) {
  latestApi = useComposerAttachments({
    attachmentPut: vi.fn(),
    attachmentSessionId: null,
    // 模拟 SessionPane 的分屏/侧聊语义：只有聚焦 composer 传 listenAddToChatEvents=true。
    listenAddToChatEvents,
    scopeId: "add-to-chat-gate",
    workspacePath: "/workspace",
  });
  return null;
}

function renderProbe(options: { listenAddToChatEvents?: boolean }) {
  const root = createRoot(installMinimalDom());
  act(() => root.render(createElement(Probe, options)));
  return root;
}

function dispatchWhiteboardEvent() {
  return dispatchWhiteboardAddToChat({
    workspacePath: "/workspace",
    boardId: "board-missing",
  });
}

beforeEach(() => {
  latestApi = null;
  mocks.platform.createTempTextAttachment.mockReset();
  mocks.platform.getPathForFile.mockReset();
  mocks.platform.selectFiles.mockReset();
  useComposerAttachmentUploadStore.setState({ scopes: {} });
});

afterEach(async () => {
  vi.useRealTimers();
  useComposerAttachmentUploadStore.setState({ scopes: {} });
  // React 19 scheduler 会在 root.unmount() 后留一个 setImmediate 回调，先排空再删 DOM shim。
  await new Promise<void>((resolve) => setImmediate(resolve));
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("useComposerAttachments add-to-chat 门控", () => {
  it("listenAddToChatEvents=false 同样不消费 whiteboard 引用事件（pre-existing 同款收口）", () => {
    const root = renderProbe({ listenAddToChatEvents: false });

    let cancelled = false;
    act(() => {
      cancelled = dispatchWhiteboardEvent();
    });
    expect(cancelled).toBe(false);
    // boardId 不存在时接收方会设置 exportMissing 错误；未接收则保持 null。
    expect(latestApi?.attachmentError).toBeNull();

    act(() => root.unmount());
  });

  it("listenAddToChatEvents=true 时 whiteboard 引用事件仍被接收", () => {
    const root = renderProbe({ listenAddToChatEvents: true });

    let cancelled = false;
    act(() => {
      cancelled = dispatchWhiteboardEvent();
    });
    expect(cancelled).toBe(true);
    expect(latestApi?.attachmentError).toBe("whiteboard.exportMissing");

    act(() => root.unmount());
  });

  it("事件常量与监听名保持稳定", () => {
    expect(WHITEBOARD_ADD_TO_CHAT_EVENT).toBe("zcode:add-whiteboard-to-chat");
  });
});
