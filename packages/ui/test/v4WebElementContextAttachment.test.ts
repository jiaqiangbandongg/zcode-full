import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT,
  dispatchWebElementContextAddToChat,
  type WebElementContextPayload,
} from "@/lib/webElementContext.js";
import {
  dispatchCodeCommentAddToChat,
  type CodeCommentPayload,
} from "@/lib/codeCommentContext.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const { chatPromptEditorProps } = vi.hoisted(() => ({
  chatPromptEditorProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: Record<string, unknown>) => {
      chatPromptEditorProps.push(props);
      const inputApiRef = props.inputApiRef as
        | { current: Record<string, unknown> | null }
        | undefined;
      if (inputApiRef) {
        inputApiRef.current = {
          clear: vi.fn(),
          focus: vi.fn(),
          getEditorState: () => null,
          getMarkdown: () => "",
          setEditorStateJson: vi.fn(),
          setText: vi.fn(),
        };
      }
      return React.createElement(
        "form",
        { "data-testid": "mock-chat-prompt-editor" },
        props.topContent as ReactNode,
        props.leadingActions as ReactNode,
        props.submitControl as ReactNode,
      );
    },
  };
});

vi.mock("@/components/ai-elements/attachments.js", async () => {
  const React = await import("react");
  const Passthrough = ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
  } & Record<string, unknown>) => React.createElement("div", props, children);
  const Trigger = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const Span = (props: Record<string, unknown>) => React.createElement("span", props);
  return {
    Attachment: Passthrough,
    AttachmentHoverCard: Passthrough,
    AttachmentHoverCardContent: Passthrough,
    AttachmentHoverCardTrigger: Trigger,
    AttachmentInfo: Span,
    AttachmentPreview: Span,
    AttachmentRemove: (props: Record<string, unknown>) => React.createElement("button", props),
    Attachments: Passthrough,
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: () => ({
    attachmentError: null,
    adoptSentAttachments: vi.fn(async () => {}),
    attachmentInputRef: { current: null },
    attachments: [],
    clearAttachments: vi.fn(),
    handleAttachmentInputChange: vi.fn(),
    handleDragLeaveComposer: vi.fn(),
    handleDragOverComposer: vi.fn(),
    handleDropComposer: vi.fn(),
    handlePaste: vi.fn(),
    handleWhiteboardMentionSelected: vi.fn(),
    hasAttachments: false,
    hasUnreadyAttachments: false,
    isDraggingOverComposer: false,
    openAttachmentPicker: vi.fn(),
    prepareForSend: vi.fn(async () => []),
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    setAttachmentError: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/V4ComposerToolbar.js", async () => {
  const React = await import("react");
  return {
    V4ComposerModeSwitch: () => React.createElement("span", null, "mode"),
    V4ComposerModelControls: () => React.createElement("span", null, "model"),
  };
});

function createMinimalElement(ownerDocument: Document, tagName = "div") {
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

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  } as Storage;
}

function installMinimalDom() {
  class CustomEventMock<T = unknown> extends Event {
    detail: T;
    constructor(type: string, init?: CustomEventInit<T>) {
      super(type, init);
      this.detail = init?.detail as T;
    }
  }
  const target = new EventTarget();
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
    addEventListener: target.addEventListener.bind(target),
    cancelAnimationFrame: () => {},
    clearTimeout,
    CustomEvent: CustomEventMock,
    dispatchEvent: target.dispatchEvent.bind(target),
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    localStorage: createStorageMock(),
    matchMedia: () => ({
      addEventListener: () => {},
      addListener: () => {},
      matches: false,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
    Node: function Node() {},
    removeEventListener: target.removeEventListener.bind(target),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    setTimeout,
  };
  documentMock.defaultView = windowMock;
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: CustomEventMock,
  });
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
  return createMinimalElement(documentMock, "div");
}

function collectText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const candidate = node as {
    childNodes?: unknown[];
    nodeValue?: string;
    textContent?: string;
  };
  if (typeof candidate.nodeValue === "string") return candidate.nodeValue;
  if (candidate.childNodes && candidate.childNodes.length > 0) {
    return candidate.childNodes.map((child) => collectText(child)).join("");
  }
  return typeof candidate.textContent === "string" ? candidate.textContent : "";
}

function makePayload(overrides: Partial<WebElementContextPayload> = {}): WebElementContextPayload {
  return {
    capturedAt: 1_700_000_000_000,
    id: "element-1",
    pageTitle: "Docs",
    pageUrl: "https://example.test/docs",
    role: "button",
    tagName: "button",
    text: "Submit",
    workspaceIdentity: "remote:workspace",
    workspacePath: "/workspace",
    ...overrides,
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderComposer(onSendText: (text: string, options?: unknown) => Promise<void>) {
  const container = installMinimalDom();
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ConversationComposer, {
          composerDraft: { text: "", updatedAt: 0 },
          updateComposerContent: vi.fn(),
          replaceComposerDraft: vi.fn(),
          draftMode: true,
          onSelectModel: vi.fn(),
          onSelectThought: vi.fn(),
          onSendText,
          onStop: vi.fn(),
          onSwitchMode: vi.fn(),
          provider: undefined,
          sessionId: null,
          snapshot: null,
          workspaceIdentity: "remote:workspace",
          workspacePath: "/workspace",
        }),
      ),
    );
  });
  return { container, root };
}

afterEach(() => {
  chatPromptEditorProps.length = 0;
  delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("V4 web element context attachment", () => {
  it("accepts focused workspace events and submits the prompt with a web element context block", async () => {
    const onSendText = vi.fn(async () => {});
    const { container, root } = renderComposer(onSendText);

    await act(async () => {
      dispatchWebElementContextAddToChat(
        makePayload({ id: "ignored", workspaceIdentity: "other-workspace" }),
      );
    });

    expect(collectText(container)).not.toContain("web element");

    await act(async () => {
      dispatchWebElementContextAddToChat(makePayload());
    });

    expect(collectText(container)).toContain("1 web element");

    const submit = chatPromptEditorProps.at(-1)?.onSubmit;
    expect(typeof submit).toBe("function");

    await act(async () => {
      (submit as (value: string) => void)("");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledTimes(1);
    expect(onSendText.mock.calls[0]?.[0]).toContain("# Web page elements:");
    expect(onSendText.mock.calls[0]?.[0]).toContain("Text:\n```\nSubmit\n```");
    expect(onSendText.mock.calls[0]?.[1]).toMatchObject({
      contextAttachmentCount: 1,
    });
    expect(collectText(container)).not.toContain("1 web element");

    await act(async () => {
      root.unmount();
    });
  });

  it("removes matching web element contexts through the remove event and keeps them after failed send", async () => {
    const onSendText = vi.fn(async () => {
      throw new Error("send failed");
    });
    const { container, root } = renderComposer(onSendText);

    await act(async () => {
      dispatchWebElementContextAddToChat(makePayload());
    });

    expect(collectText(container)).toContain("1 web element");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, {
          detail: {
            id: "missing",
            workspaceIdentity: "remote:workspace",
            workspacePath: "/workspace",
          },
        }),
      );
    });

    expect(collectText(container)).toContain("1 web element");

    const submit = chatPromptEditorProps.at(-1)?.onSubmit;
    await act(async () => {
      (submit as (value: string) => void)("Please inspect this");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledTimes(1);
    expect(collectText(container)).toContain("1 web element");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, {
          detail: {
            id: "element-1",
            workspaceIdentity: "remote:workspace",
            workspacePath: "/workspace",
          },
        }),
      );
    });

    expect(collectText(container)).not.toContain("1 web element");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("V4 code comment context attachment", () => {
  it("allows Enter to submit an empty editor when a code comment is attached", async () => {
    const onSendText = vi.fn(async () => {});
    const { root } = renderComposer(onSendText);
    const codeComment: CodeCommentPayload = {
      id: "comment-1",
      workspaceIdentity: "remote:workspace",
      workspacePath: "/workspace",
      sourcePath: "/workspace/example.ts",
      sourceTitle: "example.ts",
      startLine: 4,
      endLine: 5,
      selectedText: "const value = 1;",
      comment: "rename this",
    };

    await act(async () => {
      expect(dispatchCodeCommentAddToChat(codeComment)).toBe(true);
    });

    expect(chatPromptEditorProps.at(-1)?.allowSubmitWhenEmpty).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
