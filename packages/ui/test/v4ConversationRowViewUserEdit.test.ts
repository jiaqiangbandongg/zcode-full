import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileClockIcon } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TID_V4_EDIT,
  TID_V4_EDIT_ATTACHMENT_REMOVE,
  TID_V4_EDIT_REWIND_WORKSPACE,
  TID_V4_FEEDBACK_DISLIKE,
  TID_V4_FEEDBACK_LIKE,
  testId,
} from "@zcode/shared";
import type { AssistantTextRow, ReasoningRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { CodeCommentComposerAttachment } from "@/lib/codeCommentContext.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";
import type { PptxElementReference } from "@/lib/pptxElementReference.js";
import {
  buildPromptWithWebElementContexts,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { serializeComposerPromptContexts } from "@/v4/composer/composerPromptContexts.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const {
  attachmentPropsById,
  attachmentRemovePropsByTestId,
  chatPromptEditorProps,
  fileRewindDialogProps,
  hoverCardContentProps,
  imagePreviewDialogProps,
  messageActionPropsByTestId,
  messageResponseProps,
  reasoningTriggerProps,
} = vi.hoisted(() => ({
  attachmentPropsById: new Map<string, Record<string, unknown>>(),
  attachmentRemovePropsByTestId: new Map<string, Record<string, unknown>>(),
  chatPromptEditorProps: [] as Array<Record<string, unknown>>,
  fileRewindDialogProps: [] as Array<Record<string, unknown>>,
  hoverCardContentProps: [] as Array<Record<string, unknown>>,
  imagePreviewDialogProps: [] as Array<Record<string, unknown>>,
  messageActionPropsByTestId: new Map<string, Record<string, unknown>>(),
  messageResponseProps: [] as Array<Record<string, unknown>>,
  reasoningTriggerProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/ai-elements/image-preview-dialog.js", () => ({
  ImagePreviewDialog: (props: Record<string, unknown>) => {
    imagePreviewDialogProps.push(props);
    return null;
  },
}));

vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: Record<string, unknown>) => {
      chatPromptEditorProps.push(props);
      return React.createElement(
        "form",
        { "data-testid": "mock-v4-user-edit-editor" },
        props.topContent as React.ReactNode,
      );
    },
  };
});
vi.mock("@/v4/ConversationFileRewindDialog.js", () => ({
  ConversationFileRewindDialog: (props: Record<string, unknown>) => {
    fileRewindDialogProps.push(props);
    return null;
  },
}));

vi.mock("@/components/ai-elements/attachments.js", async () => {
  const React = await import("react");
  const RemoveContext = React.createContext<(() => void) | undefined>(undefined);
  const Passthrough = ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("div", props, children);
  const Attachment = ({
    children,
    onRemove,
    data,
    variant: _variant,
    ...props
  }: {
    children?: React.ReactNode;
    onRemove?: () => void;
    data?: { id?: string };
    variant?: string;
  }) => {
    if (data?.id) {
      attachmentPropsById.set(data.id, {
        ...props,
        data,
        onRemove,
        variant: _variant,
      });
    }
    return React.createElement(
      RemoveContext.Provider,
      { value: onRemove },
      React.createElement("div", props, children),
    );
  };
  const AttachmentRemove = ({ alwaysVisible, label, ...props }: Record<string, unknown>) => {
    const onRemove = React.useContext(RemoveContext);
    const testIdValue = props["data-testid"];
    if (typeof testIdValue === "string") {
      attachmentRemovePropsByTestId.set(testIdValue, {
        ...props,
        alwaysVisible,
        label,
        onClick: onRemove,
      });
    }
    return React.createElement("button", { ...props, onClick: onRemove }, label);
  };
  const Trigger = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const HoverCard = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const HoverCardContent = ({ children, ...props }: { children?: React.ReactNode }) => {
    hoverCardContentProps.push(props);
    return React.createElement("div", props, children);
  };
  const Span = (props: Record<string, unknown>) => React.createElement("span", props);
  return {
    Attachment,
    AttachmentHoverCard: HoverCard,
    AttachmentHoverCardContent: HoverCardContent,
    AttachmentHoverCardTrigger: Trigger,
    AttachmentInfo: Span,
    AttachmentPreview: Span,
    AttachmentRemove,
    Attachments: Passthrough,
  };
});

vi.mock("@/components/ai-elements/message.js", async () => {
  const React = await import("react");
  return {
    MessageAction: ({
      children,
      label,
      tooltip,
      ...props
    }: {
      children?: React.ReactNode;
      label?: string;
      tooltip?: string;
    } & Record<string, unknown>) => {
      const testIdValue = props["data-testid"];
      if (typeof testIdValue === "string") {
        messageActionPropsByTestId.set(testIdValue, {
          ...props,
          label,
          tooltip,
        });
      }
      return React.createElement(
        "button",
        props,
        children,
        React.createElement("span", null, label ?? tooltip),
      );
    },
    MessageActions: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement("div", props, children),
    MessageResponse: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
    } & Record<string, unknown>) => {
      messageResponseProps.push(props);
      return React.createElement("div", null, children);
    },
  };
});

vi.mock("@/components/ai-elements/reasoning.js", async () => {
  const React = await import("react");
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children);
  return {
    Reasoning: Passthrough,
    ReasoningContent: Passthrough,
    ReasoningTrigger: (props: Record<string, unknown>) => {
      reasoningTriggerProps.push(props);
      return React.createElement("div", null, props.children as React.ReactNode);
    },
  };
});

vi.mock("@/ToolCallBlocks.js", async () => {
  const React = await import("react");
  return {
    ToolCallBlock: () => React.createElement("div", { "data-testid": "mock-tool-call" }),
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
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
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

function collectAttributeValues(node: unknown, attributeName: string): string[] {
  if (!node || typeof node !== "object") return [];
  const candidate = node as {
    attributes?: Map<string, string>;
    childNodes?: unknown[];
    getAttribute?: (name: string) => string | null;
  };
  const ownValue =
    typeof candidate.getAttribute === "function"
      ? candidate.getAttribute(attributeName)
      : (candidate.attributes?.get(attributeName) ?? null);
  const childValues =
    candidate.childNodes?.flatMap((child) => collectAttributeValues(child, attributeName)) ?? [];
  return ownValue ? [ownValue, ...childValues] : childValues;
}

function findElementByAttribute(
  node: unknown,
  attributeName: string,
  attributeValue: string,
): { childNodes?: unknown[]; parentNode?: unknown } | null {
  if (!node || typeof node !== "object") return null;
  const candidate = node as {
    childNodes?: unknown[];
    getAttribute?: (name: string) => string | null;
    parentNode?: unknown;
  };
  if (candidate.getAttribute?.(attributeName) === attributeValue) return candidate;
  for (const child of candidate.childNodes ?? []) {
    const match = findElementByAttribute(child, attributeName, attributeValue);
    if (match) return match;
  }
  return null;
}

const rowContext: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  messageStreamShowReasoning: true,
  sessionId: "session-1",
  theme: "system",
  workspaceIdentity: "remote:workspace",
  workspacePath: "/workspace",
};

function userInputRow(overrides: Partial<UserInputRow> = {}): UserInputRow {
  return {
    rowId: 42,
    entityId: "message-user-42",
    turnId: "turn-1",
    createdAt: 1_700_000_000_000,
    createdAtSeq: 1,
    kind: "userInput",
    origin: "realUser",
    text: "我刚刚说了啥",
    attachments: [
      {
        bytes: 12,
        fileName: "note.txt",
        mime: "text/plain",
        ref: "/workspace/note.txt",
      },
    ],
    ...overrides,
  };
}

function assistantTextRow(overrides: Partial<AssistantTextRow> = {}): AssistantTextRow {
  return {
    rowId: 43,
    turnId: "turn-1",
    createdAt: 1_700_000_000_001,
    createdAtSeq: 2,
    kind: "assistantText",
    state: "streaming",
    text: "正在输出",
    ...overrides,
  };
}

function reasoningRow(overrides: Partial<ReasoningRow> = {}): ReasoningRow {
  return {
    rowId: 44,
    turnId: "turn-1",
    createdAt: 1_700_000_000_002,
    createdAtSeq: 3,
    kind: "reasoning",
    state: "streaming",
    text: "正在检查摘要接线",
    ...overrides,
  };
}

afterEach(() => {
  attachmentPropsById.clear();
  attachmentRemovePropsByTestId.clear();
  chatPromptEditorProps.length = 0;
  fileRewindDialogProps.length = 0;
  hoverCardContentProps.length = 0;
  imagePreviewDialogProps.length = 0;
  messageActionPropsByTestId.clear();
  messageResponseProps.length = 0;
  reasoningTriggerProps.length = 0;
  vi.restoreAllMocks();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ConversationRowView reasoning summary", () => {
  it("opens topic history from the owning transport only after clicking the attachment", async () => {
    const readAttachment = vi.fn(async () => ({
      bytes: new TextEncoder().encode("Alice | ou_a\nOriginal history"),
      mediaType: "text/plain",
    }));
    const row = userInputRow({
      attachments: [
        {
          ref: "zcode-artifact://history",
          fileName: "topic-history.txt",
          mime: "text/plain",
          bytes: 30,
          sourceKind: "topic-history",
          messageCount: 2,
        },
      ],
    });
    const root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, { context: { ...rowContext, readAttachment }, row }),
        ),
      );
    });
    expect(readAttachment).not.toHaveBeenCalled();
    const props = attachmentPropsById.get(`${row.rowId}-0`)!;
    expect(props.onOpen).toBeTypeOf("function");
    await act(async () => {
      await (props.onOpen as () => Promise<void>)();
    });
    expect(readAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", ref: "zcode-artifact://history" }),
    );
    await act(async () => root.unmount());
  });
  it("forwards streaming reasoning text to the collapsed summary trigger", async () => {
    const root: Root = createRoot(installMinimalDom());
    const row = reasoningRow();

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, { context: rowContext, row }),
        ),
      );
    });

    expect(reasoningTriggerProps).toHaveLength(1);
    expect(reasoningTriggerProps[0]?.streamingText).toBe(row.text);

    await act(async () => root.unmount());
  });
});

describe("ConversationRowView user query editing", () => {
  it.each([false, true])(
    "renders topic originals separately (mobile=%s)",
    async (compactForRemoteControl) => {
      const container = installMinimalDom();
      const root = createRoot(container);
      const row = userInputRow({
        text: "combined execution payload",
        botGroupSource: {
          provider: "feishu",
          botId: "bot",
          chatId: "chat",
          threadId: "topic",
          senderId: "b",
          senderName: "乙",
          messageId: "b",
          messages: [
            {
              messageId: "a",
              senderId: "a",
              senderName: "甲",
              text: "第一条需求",
              attachmentIndexes: [],
              conversationQuotes: [{ text: "根原文" }],
            },
            {
              messageId: "b",
              senderId: "b",
              senderName: "乙",
              text: "第二条补充",
              attachmentIndexes: [],
            },
          ],
        },
      });
      await act(async () => {
        root.render(
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(ConversationRowView, {
              context: { ...rowContext, compactForRemoteControl },
              row,
            }),
          ),
        );
      });
      const first = findElementByAttribute(container, "data-topic-message-id", "a");
      const second = findElementByAttribute(container, "data-topic-message-id", "b");
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(collectText(first)).toContain("第一条需求");
      expect(collectText(first)).toContain("甲");
      expect(collectText(second)).toContain("第二条补充");
      expect(collectText(second)).toContain("乙");
      expect(findElementByAttribute(first, "data-v4-user-input-quotes", "true")).not.toBeNull();
      expect(findElementByAttribute(second, "data-v4-user-input-quotes", "true")).toBeNull();
      expect(collectText(container)).not.toContain("combined execution payload");
      await act(async () => root.unmount());
    },
  );

  it("orders group sender, quote and attachments without an invented message bubble", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    const row = userInputRow({
      text: "",
      conversationQuotes: [
        {
          text: "actual quoted request",
          senderName: "Ryan Bot",
          senderId: "ou_bot",
          sentAt: "2026-09-09T10:32:44+08:00",
        },
      ],
      botGroupSource: {
        provider: "feishu",
        botId: "bot",
        chatId: "chat",
        senderId: "member",
        senderName: "测试成员",
        messageId: "message",
      },
    });
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, { context: rowContext, row }),
        ),
      );
    });
    const source = findElementByAttribute(container, "data-v4-user-input-source", "true");
    const area = findElementByAttribute(container, "data-v4-user-input-attachments", "true");
    const quotes = findElementByAttribute(container, "data-v4-user-input-quotes", "true");
    expect(source).not.toBeNull();
    expect(quotes).not.toBeNull();
    const siblings = [...source!.parentNode.childNodes];
    expect(siblings.indexOf(source)).toBeLessThan(siblings.indexOf(area));
    expect([...area!.childNodes][0]).toBe(quotes);
    expect(findElementByAttribute(container, "data-v4-user-input-bubble", "true")).toBeNull();
    await act(async () => root.unmount());
  });

  it.each([
    {
      label: "scheduled automation prompt",
      sourceCommandId: "automation-1:1700000000000",
      visible: true,
    },
    {
      label: "manual automation prompt",
      sourceCommandId: "automation-1:manual:run-1",
      visible: true,
    },
    { label: "ordinary prompt", sourceCommandId: "command-1", visible: false },
  ])("shows the scheduled-task origin only for $label", async ({ sourceCommandId, visible }) => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            row: userInputRow({ sourceCommandId }),
          }),
        ),
      );
    });

    const origin = findElementByAttribute(
      container,
      "data-v4-user-input-automation-origin",
      "schedule",
    );
    expect(Boolean(origin)).toBe(visible);
    if (origin) {
      expect(collectText(origin)).toBe("由定时任务发送");
      expect(findElementByAttribute(origin, "data-cron-task-icon", "true")).not.toBeNull();
    }

    await act(async () => root.unmount());
  });

  it.each([
    {
      label: "attachments and text",
      text: "解释附件",
      attachments: userInputRow().attachments,
      bubble: true,
    },
    {
      label: "attachments only",
      text: "",
      attachments: userInputRow().attachments,
      bubble: false,
    },
    { label: "text only", text: "只有文字", attachments: [], bubble: true },
  ])("renders the user message layout for $label", async ({ text, attachments, bubble }) => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            row: userInputRow({ text, attachments }),
          }),
        ),
      );
    });

    const attachmentArea = findElementByAttribute(
      container,
      "data-v4-user-input-attachments",
      "true",
    );
    const messageBubble = findElementByAttribute(container, "data-v4-user-input-bubble", "true");
    expect(Boolean(attachmentArea)).toBe(attachments.length > 0);
    expect(Boolean(messageBubble)).toBe(bubble);
    if (messageBubble) {
      const bubbleClasses = collectAttributeValues(messageBubble, "class").join(" ");
      const bubbleClassTokens = bubbleClasses.split(/\s+/);
      expect(bubbleClasses).toContain("max-w-full");
      expect(bubbleClasses).toContain("@min-[624px]/conversation:max-w-xl");
      expect(bubbleClassTokens).not.toContain("w-fit");
      expect(bubbleClassTokens).not.toContain("w-full");
      expect(bubbleClassTokens).not.toContain("@md/conversation:max-w-xl");
      expect(bubbleClassTokens).not.toContain("@xl/conversation:max-w-xl");
      expect(bubbleClassTokens).not.toContain("@md/conversation:w-full");
    }
    if (attachmentArea && messageBubble) {
      expect(attachmentArea.parentNode).toBe(messageBubble.parentNode);
      const siblings = attachmentArea.parentNode as {
        childNodes?: unknown[];
      };
      expect(siblings.childNodes?.indexOf(attachmentArea)).toBeLessThan(
        siblings.childNodes?.indexOf(messageBubble) ?? -1,
      );
    }

    await act(async () => root.unmount());
  });

  it("renders sent attachments as surface pills with a file icon and filename", async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            row: userInputRow({ text: "" }),
          }),
        ),
      );
    });

    const pill = findElementByAttribute(container, "data-v4-user-input-attachment-pill", "true");
    expect(pill).not.toBeNull();
    const classes = collectAttributeValues(pill, "class").join(" ");
    expect(classes).toContain("rounded-full");
    expect(classes).toContain("bg-surface");
    expect(collectText(pill)).toBe("note.txt");
    expect(collectAttributeValues(pill, "src").some((src) => src.endsWith(".svg"))).toBe(true);

    await act(async () => root.unmount());
  });

  it("renders image thumbnails above ordered file and context pills", async () => {
    const context: WebElementContextComposerAttachment = {
      capturedAt: 1_700_000_000_000,
      id: "element-1",
      pageTitle: "Docs",
      pageUrl: "https://example.test/docs",
      tagName: "button",
      text: "Submit",
      workspacePath: "/workspace",
    };
    const readAttachment = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71]),
      mediaType: "image/png",
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sent-thumbnail");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const comment: CodeCommentComposerAttachment = {
      id: "comment-1",
      workspacePath: "/workspace",
      sourcePath: "/workspace/app.ts",
      sourceTitle: "app.ts",
      selectedText: "const value = 1",
      comment: "检查这里",
      startLine: 1,
      endLine: 1,
    };
    const pptxElement: PptxElementReference = {
      id: "pptx-1",
      workspacePath: "/workspace",
      sourcePath: "/workspace/deck.pptx",
      sourceTitle: "deck.pptx",
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      bounds: { x: 0, y: 0, width: 100, height: 30 },
      zIndex: 1,
      capturedAt: 1,
    };
    const selection: ConversationSelectionReference = {
      id: "selection-1",
      sourceSessionId: "source-session",
      sourceRowId: 8,
      contentType: "assistant",
      text: "selected answer",
    };
    const row = userInputRow({
      text: serializeComposerPromptContexts("", {
        codeComments: [comment],
        conversationSelections: [selection],
        pptxElements: [pptxElement],
        webElements: [context],
      }),
      attachments: [
        {
          ref: "/workspace/shot.png",
          fileName: "shot.png",
          mime: "image/png",
          bytes: 4,
        },
        {
          ref: "/workspace/demo.mov",
          fileName: "demo.mov",
          mime: "video/quicktime",
          bytes: 8,
        },
        {
          ref: "/workspace/note.txt",
          fileName: "note.txt",
          mime: "text/plain",
          bytes: 4,
        },
      ],
    });
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, readAttachment },
            row,
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const attachmentArea = findElementByAttribute(
      container,
      "data-v4-user-input-attachments",
      "true",
    );
    const imageRow = findElementByAttribute(
      attachmentArea,
      "data-v4-user-input-media-attachments",
      "true",
    );
    const pillRow = findElementByAttribute(
      attachmentArea,
      "data-v4-user-input-attachment-pills",
      "true",
    );
    const image = findElementByAttribute(imageRow, "data-v4-user-input-media-attachment", "true");
    // findElementByAttribute 只返回首个匹配；media 行内还有视频卡，按子节点序取第二个。
    const mediaCards = [...(imageRow as { childNodes?: unknown[] }).childNodes!].filter(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        "getAttribute" in child &&
        (child as { getAttribute(name: string): string | null }).getAttribute(
          "data-v4-user-input-media-attachment",
        ) === "true",
    );
    const video = mediaCards[1] ?? null;
    const file = findElementByAttribute(pillRow, "data-v4-user-input-attachment-pill", "true");
    const web = findElementByAttribute(pillRow, "aria-label", "1 个网页元素");
    const codeComment = findElementByAttribute(pillRow, "aria-label", "1 条评论");
    const pptx = findElementByAttribute(pillRow, "aria-label", "1 个幻灯片元素");
    const conversation = findElementByAttribute(pillRow, "aria-label", "1 条对话引用");
    expect(imageRow?.parentNode).toBe(attachmentArea);
    expect(pillRow?.parentNode).toBe(attachmentArea);
    expect(image?.parentNode).toBe(imageRow);
    expect(video?.parentNode).toBe(imageRow);
    expect(file?.parentNode).toBe(pillRow);
    // 媒体行内按添加顺序混排图片与视频；视频不进入文件 pill 行。
    const mediaChildren = (imageRow as { childNodes?: unknown[] }).childNodes ?? [];
    expect(mediaChildren.indexOf(image)).toBeLessThan(mediaChildren.indexOf(video));
    expect(web?.parentNode).toBe(pillRow);
    const areaChildren = (attachmentArea as { childNodes?: unknown[] }).childNodes ?? [];
    expect(areaChildren.indexOf(imageRow)).toBeLessThan(areaChildren.indexOf(pillRow));
    const pillChildren = (pillRow as { childNodes?: unknown[] }).childNodes ?? [];
    expect([
      pillChildren.indexOf(file),
      pillChildren.indexOf(codeComment),
      pillChildren.indexOf(web),
      pillChildren.indexOf(pptx),
      pillChildren.indexOf(conversation),
    ]).toEqual(
      [...pillChildren]
        .map((child, index) => ({ child, index }))
        .filter(({ child }) => [file, codeComment, web, pptx, conversation].includes(child))
        .map(({ index }) => index),
    );
    expect(attachmentPropsById.get("42-0")).toMatchObject({
      variant: "grid",
      data: { url: "blob:sent-thumbnail" },
    });
    // 可见消息行会读取已发送视频，卡片复用 Blob URL 由无控件 video 展示首帧。
    expect(attachmentPropsById.get("42-1")).toMatchObject({
      variant: "grid",
      data: { url: "blob:sent-thumbnail", filename: "demo.mov" },
    });
    expect(readAttachment).toHaveBeenCalledWith({
      sessionId: "session-1",
      ref: "/workspace/demo.mov",
      mediaType: "video/quicktime",
      target: { rowId: 42, entityId: "message-user-42" },
      attachmentIndex: 1,
      signal: expect.any(AbortSignal),
    });
    const imageClasses = collectAttributeValues(image, "class").join(" ");
    expect(imageClasses).toContain("size-20");
    expect(imageClasses).toContain("rounded-xl");
    expect(imageClasses).not.toMatch(/(?:^|\s)border(?:\s|$)/u);
    expect(imageClasses).toContain("after:border");
    expect(imageClasses).toContain("after:pointer-events-none");
    const videoClasses = collectAttributeValues(video, "class").join(" ");
    expect(videoClasses).toContain("size-20");
    expect(videoClasses).toContain("rounded-xl");

    await act(async () => root.unmount());
  });

  it("opens sent images with the shared Markdown preview gallery and leaves non-images static", async () => {
    const readAttachment = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71]),
      mediaType: "image/png",
    });
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first-preview")
      .mockReturnValueOnce("blob:second-preview");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const row = userInputRow({
      attachments: [
        {
          ref: "/workspace/first.png",
          fileName: "first.png",
          mime: "image/png",
          bytes: 4,
        },
        {
          ref: "/workspace/second.png",
          fileName: "second.png",
          mime: "image/png",
          bytes: 4,
        },
        {
          ref: "/workspace/note.txt",
          fileName: "note.txt",
          mime: "text/plain",
          bytes: 4,
        },
      ],
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, readAttachment },
            row,
          }),
        ),
      );
    });

    expect(attachmentPropsById.get("42-0")?.onOpen).toBeTypeOf("function");
    expect(attachmentPropsById.get("42-0")?.openLabel).toBe("打开图片预览");
    expect(attachmentPropsById.get("42-1")?.onOpen).toBeTypeOf("function");
    expect(attachmentPropsById.get("42-2")?.onOpen).toBeUndefined();

    const openPreview = attachmentPropsById.get("42-1")?.onOpen;
    expect(openPreview).toBeTypeOf("function");
    await act(async () => {
      (openPreview as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readAttachment).toHaveBeenCalledTimes(2);
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(imagePreviewDialogProps.at(-1)).toMatchObject({
      open: true,
      initialIndex: 1,
      items: [
        { alt: "first.png", filename: "first.png", src: "blob:first-preview" },
        {
          alt: "second.png",
          filename: "second.png",
          src: "blob:second-preview",
        },
      ],
    });

    const onPreviewOpenChange = imagePreviewDialogProps.at(-1)?.onOpenChange;
    expect(onPreviewOpenChange).toBeTypeOf("function");
    await act(async () => {
      (onPreviewOpenChange as (open: boolean) => void)(false);
    });
    await act(async () => root.unmount());
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:first-preview");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:second-preview");
  });

  it("opens sent videos in the shared mixed media gallery by exact row attachment", async () => {
    const readAttachment = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([0, 0, 0, 24]),
      mediaType: "video/quicktime",
    });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sent-preview");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const row = userInputRow({
      attachments: [
        {
          ref: "/workspace/shot.png",
          fileName: "shot.png",
          mime: "image/png",
          bytes: 4,
        },
        {
          ref: "/workspace/demo.mov",
          fileName: "demo.mov",
          mime: "video/quicktime",
          bytes: 4,
        },
        {
          ref: "/workspace/note.txt",
          fileName: "note.txt",
          mime: "text/plain",
          bytes: 4,
        },
      ],
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, readAttachment },
            row,
          }),
        ),
      );
    });

    expect(attachmentPropsById.get("42-0")?.onOpen).toBeTypeOf("function");
    expect(attachmentPropsById.get("42-0")?.openLabel).toBe("打开图片预览");
    expect(attachmentPropsById.get("42-1")?.onOpen).toBeTypeOf("function");
    expect(attachmentPropsById.get("42-1")?.openLabel).toBe("打开视频预览");
    expect(attachmentPropsById.get("42-2")?.onOpen).toBeUndefined();

    const openPreview = attachmentPropsById.get("42-1")?.onOpen;
    expect(openPreview).toBeTypeOf("function");
    await act(async () => {
      (openPreview as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readAttachment).toHaveBeenCalledWith({
      sessionId: "session-1",
      ref: "/workspace/demo.mov",
      mediaType: "video/quicktime",
      target: { rowId: 42, entityId: "message-user-42" },
      attachmentIndex: 1,
      signal: expect.any(AbortSignal),
    });
    // 挂载时 image/video 各读取一次；点击 video 复用首帧 Blob，不重复读取。
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(imagePreviewDialogProps.at(-1)).toMatchObject({
      open: true,
      initialIndex: 1,
      items: [
        {
          alt: "shot.png",
          filename: "shot.png",
          mediaType: "image/png",
          src: expect.stringMatching(/^blob:/u),
        },
        {
          alt: "demo.mov",
          filename: "demo.mov",
          mediaType: "video/quicktime",
          src: "blob:sent-preview",
        },
      ],
    });

    const onPreviewOpenChange = imagePreviewDialogProps.at(-1)?.onOpenChange;
    expect(onPreviewOpenChange).toBeTypeOf("function");
    await act(async () => {
      (onPreviewOpenChange as (open: boolean) => void)(false);
    });
    // gallery 关闭后首帧仍在消息卡片使用，直到消息行卸载才统一释放。
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:sent-preview");
    await act(async () => root.unmount());
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:sent-preview");
  });

  it("loads a video when mixed-media gallery navigation selects it", async () => {
    let resolveVideoPreview!: (value: { bytes: Uint8Array; mediaType: string }) => void;
    let videoReads = 0;
    const readAttachment = vi.fn(({ ref }: { ref: string }) => {
      if (ref.endsWith("shot.png")) {
        return Promise.resolve({
          bytes: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        });
      }
      videoReads += 1;
      if (videoReads === 1) {
        return Promise.reject(new Error("thumbnail prefetch failed"));
      }
      return new Promise<{ bytes: Uint8Array; mediaType: string }>((resolve) => {
        resolveVideoPreview = resolve;
      });
    });
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:image-preview")
      .mockReturnValueOnce("blob:video-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const row = userInputRow({
      attachments: [
        {
          ref: "/workspace/shot.png",
          fileName: "shot.png",
          mime: "image/png",
          bytes: 3,
        },
        {
          ref: "/workspace/demo.mp4",
          fileName: "demo.mp4",
          mime: "video/mp4",
          bytes: 4,
        },
      ],
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, readAttachment },
            row,
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const openImagePreview = attachmentPropsById.get("42-0")?.onOpen;
    expect(openImagePreview).toBeTypeOf("function");
    await act(async () => {
      (openImagePreview as () => void)();
    });
    const onActiveIndexChange = imagePreviewDialogProps.at(-1)?.onActiveIndexChange as
      | ((index: number) => void)
      | undefined;
    expect(onActiveIndexChange).toBeTypeOf("function");
    await act(async () => {
      onActiveIndexChange?.(1);
      await Promise.resolve();
    });
    expect(readAttachment).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      ref: "/workspace/demo.mp4",
      mediaType: "video/mp4",
      target: { rowId: 42, entityId: "message-user-42" },
      attachmentIndex: 1,
      signal: expect.any(AbortSignal),
    });
    expect(imagePreviewDialogProps.at(-1)).toMatchObject({
      initialIndex: 1,
      items: [
        expect.objectContaining({ src: "blob:image-preview" }),
        expect.objectContaining({ loading: true, src: undefined }),
      ],
    });

    await act(async () => {
      resolveVideoPreview({
        bytes: new Uint8Array([0, 0, 0, 24]),
        mediaType: "video/mp4",
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(imagePreviewDialogProps.at(-1)).toMatchObject({
      items: [
        expect.objectContaining({ src: "blob:image-preview" }),
        expect.objectContaining({ loading: false, src: "blob:video-preview" }),
      ],
    });

    await act(async () => root.unmount());
  });

  it("opens a Desktop local media URL without creating or revoking a Blob URL", async () => {
    const readAttachment = vi.fn().mockResolvedValue({
      url: "zcode-media://local/desktop-video",
      mediaType: "video/mp4",
    });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const row = userInputRow({
      attachments: [{ ref: "/tmp/demo.mp4", fileName: "demo.mp4", mime: "video/mp4", bytes: 1024 }],
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, readAttachment },
            row,
          }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readAttachment).toHaveBeenCalledWith({
      sessionId: "session-1",
      ref: "/tmp/demo.mp4",
      mediaType: "video/mp4",
      target: { rowId: row.rowId, entityId: row.entityId },
      attachmentIndex: 0,
      signal: expect.any(AbortSignal),
    });
    expect(attachmentPropsById.get(`${row.rowId}-0`)).toMatchObject({
      data: { url: "zcode-media://local/desktop-video" },
    });
    const openPreview = attachmentPropsById.get(`${row.rowId}-0`)?.onOpen;
    expect(openPreview).toBeTypeOf("function");
    await act(async () => {
      (openPreview as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(imagePreviewDialogProps.at(-1)).toMatchObject({
      open: true,
      initialIndex: 0,
      items: [
        {
          alt: "demo.mp4",
          filename: "demo.mp4",
          mediaType: "video/mp4",
          src: "zcode-media://local/desktop-video",
          loading: false,
          error: false,
        },
      ],
    });
    expect(createObjectUrl).not.toHaveBeenCalled();
    const closePreview = imagePreviewDialogProps.at(-1)?.onOpenChange;
    expect(closePreview).toBeTypeOf("function");
    await act(async () => {
      (closePreview as (open: boolean) => void)(false);
    });
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("aborts an unfinished sent media read when the preview closes", async () => {
    let readSignal: AbortSignal | undefined;
    const readAttachment = vi.fn(
      (params: { signal?: AbortSignal }) =>
        new Promise<{ bytes: Uint8Array; mediaType: string }>(() => {
          readSignal = params.signal;
        }),
    );
    const row = userInputRow({
      attachments: [
        {
          ref: "/workspace/large.mp4",
          fileName: "large.mp4",
          mime: "video/mp4",
          bytes: 80,
        },
      ],
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, readAttachment },
            row,
          }),
        ),
      );
    });
    const openPreview = attachmentPropsById.get("42-0")?.onOpen;
    expect(openPreview).toBeTypeOf("function");
    await act(async () => {
      (openPreview as () => void)();
      await Promise.resolve();
    });
    expect(readSignal).toBeDefined();
    expect(readSignal?.aborted).toBe(false);

    const replacedSignal = readSignal;
    await act(async () => {
      (openPreview as () => void)();
      await Promise.resolve();
    });
    expect(replacedSignal?.aborted).toBe(true);
    expect(readSignal).not.toBe(replacedSignal);
    expect(readSignal?.aborted).toBe(false);

    const closePreview = imagePreviewDialogProps.at(-1)?.onOpenChange;
    expect(closePreview).toBeTypeOf("function");
    await act(async () => {
      (closePreview as (open: boolean) => void)(false);
    });
    expect(readSignal?.aborted).toBe(true);

    const closedSignal = readSignal;
    await act(async () => {
      (openPreview as () => void)();
      await Promise.resolve();
    });
    expect(readSignal).not.toBe(closedSignal);
    expect(readSignal?.aborted).toBe(false);

    await act(async () => root.unmount());
    expect(readSignal?.aborted).toBe(true);
  });

  it("aborts unfinished visible-row media prefetch when the row unmounts", async () => {
    let prefetchSignal: AbortSignal | undefined;
    const readAttachment = vi.fn(
      (params: { signal?: AbortSignal }) =>
        new Promise<{ bytes: Uint8Array; mediaType: string }>(() => {
          prefetchSignal = params.signal;
        }),
    );
    const row = userInputRow({
      attachments: [
        {
          ref: "/workspace/large.mp4",
          fileName: "large.mp4",
          mime: "video/mp4",
          bytes: 80,
        },
      ],
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, readAttachment },
            row,
          }),
        ),
      );
      await Promise.resolve();
    });

    expect(prefetchSignal).toBeDefined();
    expect(prefetchSignal?.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(prefetchSignal?.aborted).toBe(true);
  });

  it("marks an unreadable sent image unavailable and removes its open action", async () => {
    const readAttachment = vi.fn().mockRejectedValue(new Error("gone"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = userInputRow({
      attachments: [
        {
          ref: "/workspace/gone.png",
          fileName: "gone.png",
          mime: "image/png",
          bytes: 4,
        },
      ],
    });
    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, readAttachment },
            row,
          }),
        ),
      );
    });

    expect(readAttachment).toHaveBeenCalledWith({
      sessionId: "session-1",
      ref: "/workspace/gone.png",
      signal: expect.any(AbortSignal),
    });
    expect(attachmentPropsById.get("42-0")?.onOpen).toBeUndefined();
    expect(attachmentPropsById.get("42-0")?.title).toBe("这张图片已无法预览。");
    await act(async () => root.unmount());
  });

  // 回归：v4 迁移后用户行复制/编辑按钮硬编码中文，未走 i18n；
  // en-US 下会显示「复制」「编辑」。文案必须跟随当前 locale。
  it.each([
    ["zh-CN", "复制", "编辑"],
    ["en-US", "Copy", "Edit"],
  ] as const)(
    "renders user row copy/edit action labels from locale %s",
    async (locale, copyLabel, editLabel) => {
      const row = userInputRow();
      const container = installMinimalDom();
      const root: Root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            ZCodeIntlProvider,
            { initialLocale: locale },
            createElement(ConversationRowView, {
              context: rowContext,
              onEdit: vi.fn(),
              row,
            }),
          ),
        );
      });

      const copyAction = messageActionPropsByTestId.get(`v4-copy-${row.rowId}`);
      expect(copyAction?.label).toBe(copyLabel);
      expect(copyAction?.tooltip).toBe(copyLabel);

      const editAction = messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)));
      expect(editAction?.label).toBe(editLabel);
      expect(editAction?.tooltip).toBe(editLabel);

      await act(async () => {
        root.unmount();
      });
    },
  );

  it("keeps user message actions visible in compact remote control mode", async () => {
    const row = userInputRow();
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, compactForRemoteControl: true },
            row,
            onEdit: vi.fn(),
          }),
        ),
      );
    });

    const actionsClassName = collectAttributeValues(container, "class").find((value) =>
      value.includes("mt-1 opacity"),
    );
    expect(actionsClassName).toContain("opacity-100");
    expect(actionsClassName).not.toContain("opacity-0");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps assistant feedback local to the mounted action toolbar", async () => {
    const row = assistantTextRow({
      entityId: "message-assistant-43",
      state: "complete",
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: { ...rowContext, compactForRemoteControl: true },
            row,
            onFeedbackChange: vi.fn(async () => true),
          }),
        ),
      );
    });

    const likeTestId = testId(TID_V4_FEEDBACK_LIKE, String(row.rowId));
    const dislikeTestId = testId(TID_V4_FEEDBACK_DISLIKE, String(row.rowId));
    expect(messageActionPropsByTestId.get(likeTestId)?.["aria-pressed"]).toBe(false);
    expect(messageActionPropsByTestId.get(dislikeTestId)?.["aria-pressed"]).toBe(false);
    expect(messageActionPropsByTestId.get(likeTestId)?.tooltip).toBeUndefined();

    const handleLike = messageActionPropsByTestId.get(likeTestId)?.onClick;
    expect(handleLike).toBeTypeOf("function");
    await act(async () => {
      (handleLike as () => void)();
    });
    expect(messageActionPropsByTestId.get(likeTestId)?.["aria-pressed"]).toBe(true);
    expect(messageActionPropsByTestId.get(dislikeTestId)?.["aria-pressed"]).toBe(false);

    const handleLikeAgain = messageActionPropsByTestId.get(likeTestId)?.onClick;
    expect(handleLikeAgain).toBeTypeOf("function");
    await act(async () => {
      (handleLikeAgain as () => void)();
    });
    expect(messageActionPropsByTestId.get(likeTestId)?.["aria-pressed"]).toBe(false);
    expect(messageActionPropsByTestId.get(dislikeTestId)?.["aria-pressed"]).toBe(false);

    const handleDislike = messageActionPropsByTestId.get(dislikeTestId)?.onClick;
    expect(handleDislike).toBeTypeOf("function");
    await act(async () => {
      (handleDislike as () => void)();
    });
    expect(messageActionPropsByTestId.get(likeTestId)?.["aria-pressed"]).toBe(false);
    expect(messageActionPropsByTestId.get(dislikeTestId)?.["aria-pressed"]).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not append a visual cursor to streaming assistant text", async () => {
    const row = assistantTextRow();
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            row,
          }),
        ),
      );
    });

    expect(collectText(container)).toContain(row.text);
    const classValues = collectAttributeValues(container, "class");
    expect(classValues.join(" ")).not.toContain("animate-pulse");

    await act(async () => {
      root.unmount();
    });
  });

  it.each(["complete", "streaming"] as const)(
    "puts assistant %s text inside a real selectable DOM region",
    async (state) => {
      const row = assistantTextRow({ state });
      const container = installMinimalDom();
      const root: Root = createRoot(container);

      await act(async () => {
        root.render(
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(ConversationRowView, {
              context: rowContext,
              row,
            }),
          ),
        );
      });

      expect(collectAttributeValues(container, "data-conversation-selectable")).toContain("true");
      // 回归根因：标记不能继续依赖不透传 data-* 的 MessageResponse。
      expect(messageResponseProps.at(-1)?.["data-conversation-selectable"]).toBeUndefined();

      await act(async () => {
        root.unmount();
      });
    },
  );

  it("保持显式 Markdown 文件处理器，仅为 Assistant 开启 citation 投影", async () => {
    const row = assistantTextRow({
      state: "complete",
      text: "See [README](./README.md) and https://example.test.",
    });
    const onOpenBrowserUrl = vi.fn();
    const onOpenCodeViewer = vi.fn();
    const onOpenFileLink = vi.fn();
    const readAttachment = vi.fn();
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: {
              ...rowContext,
              onOpenBrowserUrl,
              onOpenCodeViewer,
              onOpenFileLink,
              readAttachment,
            },
            row,
          }),
        ),
      );
    });

    expect(messageResponseProps).toHaveLength(1);
    expect(messageResponseProps[0]?.onOpenExternalUrl).toBe(onOpenBrowserUrl);
    expect(messageResponseProps[0]?.onOpenCodeViewer).toBe(onOpenCodeViewer);
    expect(messageResponseProps[0]?.onOpenFileLink).toBe(onOpenFileLink);
    expect(messageResponseProps[0]?.renderZCodeFileCitations).toBe(true);
    // 回归根因：artifact 图片读取能力必须由行级生产接线继续传入 Markdown。
    expect(messageResponseProps[0]?.sessionId).toBe("session-1");
    expect(messageResponseProps[0]?.readAttachment).toBe(readAttachment);

    await act(async () => {
      root.unmount();
    });
  });

  it("renders web element contexts as read-only chips while keeping the raw row text for actions", async () => {
    const context: WebElementContextComposerAttachment = {
      capturedAt: 1_700_000_000_000,
      id: "element-1",
      pageTitle: "Docs",
      pageUrl: "https://example.test/docs",
      role: "button",
      tagName: "button",
      text: "Submit",
      workspaceIdentity: "remote:workspace",
      workspacePath: "/workspace",
    };
    const rawText = buildPromptWithWebElementContexts("帮我看这个按钮", [context]);
    const row = userInputRow({
      text: rawText,
    });
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            onEdit: vi.fn(),
            row,
          }),
        ),
      );
    });

    const text = collectText(container);
    expect(text).toContain("帮我看这个按钮");
    expect(text).toContain("1 个网页元素");
    expect(text).not.toContain("# Web page elements:");

    const attachmentArea = findElementByAttribute(
      container,
      "data-v4-user-input-attachments",
      "true",
    );
    const messageBubble = findElementByAttribute(container, "data-v4-user-input-bubble", "true");
    expect(collectText(attachmentArea)).toContain("note.txt");
    expect(collectText(attachmentArea)).toContain("1 个网页元素");
    expect(collectText(messageBubble)).toBe("帮我看这个按钮");
    const fileAttachmentPill = findElementByAttribute(
      attachmentArea,
      "data-v4-user-input-attachment-pill",
      "true",
    );
    const webElementChip = findElementByAttribute(attachmentArea, "aria-label", "1 个网页元素");
    const pillRow = findElementByAttribute(
      attachmentArea,
      "data-v4-user-input-attachment-pills",
      "true",
    );
    expect(fileAttachmentPill?.parentNode).toBe(pillRow);
    expect(webElementChip?.parentNode).toBe(pillRow);
    expect(collectAttributeValues(webElementChip, "class").join(" ")).toContain("rounded-full");

    const copyAction = messageActionPropsByTestId.get(`v4-copy-${row.rowId}`);
    expect(copyAction).toBeDefined();
    expect(copyAction?.disabled).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("right-aligns PPT and conversation-reference hover cards in sent user rows", async () => {
    const pptxElement: PptxElementReference = {
      id: "pptx-1",
      workspacePath: "/workspace",
      sourcePath: "/workspace/deck.pptx",
      sourceTitle: "deck.pptx",
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      bounds: { x: 0, y: 0, width: 100, height: 30 },
      zIndex: 1,
      capturedAt: 1,
    };
    const selection: ConversationSelectionReference = {
      id: "selection-1",
      sourceSessionId: "source-session",
      sourceRowId: 8,
      contentType: "assistant",
      text: "selected answer",
    };
    const row = userInputRow({
      text: serializeComposerPromptContexts("请处理", {
        codeComments: [],
        conversationSelections: [selection],
        pptxElements: [pptxElement],
        webElements: [],
      }),
    });
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            onEdit: vi.fn(),
            row,
          }),
        ),
      );
    });

    expect(hoverCardContentProps).toHaveLength(4);
    expect(hoverCardContentProps.every((props) => props.align === "end")).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it("does not render a bubble when a user row only contains context references", async () => {
    const context: WebElementContextComposerAttachment = {
      capturedAt: 1_700_000_000_000,
      id: "element-only",
      pageTitle: "Docs",
      pageUrl: "https://example.test/docs",
      tagName: "main",
      text: "Content",
      workspaceIdentity: "remote:workspace",
      workspacePath: "/workspace",
    };
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            row: userInputRow({
              attachments: [],
              text: buildPromptWithWebElementContexts("", [context]),
            }),
          }),
        ),
      );
    });

    expect(
      findElementByAttribute(container, "data-v4-user-input-attachments", "true"),
    ).not.toBeNull();
    expect(findElementByAttribute(container, "data-v4-user-input-bubble", "true")).toBeNull();
    await act(async () => root.unmount());
  });

  it("renders an authoritative goal query without the slash", async () => {
    const row = userInputRow({
      attachments: [],
      text: "/goal 看一下这是个啥项目",
    });
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            row,
          }),
        ),
      );
    });

    expect(collectText(container)).toContain("goal 看一下这是个啥项目");
    expect(collectText(container)).not.toContain("/goal");
    expect(collectAttributeValues(container, "class").join(" ")).toContain("lucide-goal");
    expect(collectAttributeValues(container, "data-v4-user-input-command")).toContain("goal");

    await act(async () => {
      root.unmount();
    });
  });

  it("opens an inline editor and submits edited text with original attachments", async () => {
    const onEdit = vi.fn(async () => true);
    const row = userInputRow();
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            onEdit,
            row,
          }),
        ),
      );
    });

    const editAction = messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)));
    expect(editAction).toBeDefined();
    const editOnClick = editAction?.onClick;
    expect(typeof editOnClick).toBe("function");

    await act(async () => {
      (editOnClick as () => void)();
    });

    expect(chatPromptEditorProps).toHaveLength(1);
    expect(chatPromptEditorProps[0]?.initialValue).toBe(row.text);
    const submitEdit = chatPromptEditorProps[0]?.onSubmit;
    expect(typeof submitEdit).toBe("function");

    await act(async () => {
      await (submitEdit as (value: string) => Promise<void>)("改过的问题");
    });

    expect(onEdit).toHaveBeenCalledWith(
      { rowId: row.rowId, entityId: row.entityId },
      "改过的问题",
      row.attachments,
      "preserve",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("renders edit attachments like the composer and submits the remaining refs in source order", async () => {
    const onEdit = vi.fn(async () => true);
    const row = userInputRow({
      text: "",
      attachments: [
        {
          bytes: 12,
          fileName: "first.txt",
          mime: "text/plain",
          ref: "/workspace/first.txt",
        },
        {
          bytes: 24,
          fileName: "second.png",
          mime: "image/png",
          ref: "/workspace/second.png",
        },
        {
          bytes: 48,
          fileName: "third.mov",
          mime: "video/quicktime",
          ref: "/workspace/third.mov",
        },
      ],
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            onEdit,
            row,
          }),
        ),
      );
    });
    await act(async () => {
      (
        messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)))?.onClick as
          | (() => void)
          | undefined
      )?.();
    });

    // 编辑态按「媒体优先、组内原序」排列：second.png、third.mov 为媒体卡，first.txt 为文件卡。
    expect(attachmentPropsById.get(`${row.rowId}-1`)).toMatchObject({
      className: expect.stringContaining("size-12"),
      variant: "grid",
      "data-v4-user-edit-attachment-kind": "image",
    });
    expect(attachmentPropsById.get(`${row.rowId}-2`)).toMatchObject({
      className: expect.stringContaining("size-12"),
      variant: "grid",
      "data-v4-user-edit-attachment-kind": "video",
    });
    expect(attachmentPropsById.get(`${row.rowId}-0`)).toMatchObject({
      className: expect.stringContaining("h-12"),
      variant: "inline",
      "data-v4-user-edit-attachment-kind": "file",
    });

    const firstRemoveId = testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${row.rowId}-0`);
    const secondRemoveId = testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${row.rowId}-1`);
    expect(attachmentRemovePropsByTestId.get(firstRemoveId)).toMatchObject({
      alwaysVisible: undefined,
      className: expect.stringContaining("size-3.5"),
      label: "移除附件",
      placement: "corner",
      variant: "default",
    });
    expect(attachmentRemovePropsByTestId.get(secondRemoveId)).toBeDefined();

    await act(async () => {
      (attachmentRemovePropsByTestId.get(firstRemoveId)!.onClick as () => void)();
    });
    expect(chatPromptEditorProps.at(-1)?.allowSubmitWhenEmpty).toBe(true);
    expect(chatPromptEditorProps.at(-1)?.submitDisabled).toBe(false);

    await act(async () => {
      await (chatPromptEditorProps.at(-1)!.onSubmit as (value: string) => Promise<void>)("");
    });
    expect(onEdit).toHaveBeenCalledWith(
      { rowId: row.rowId, entityId: row.entityId },
      "",
      [row.attachments?.[1], row.attachments?.[2]],
      "preserve",
    );

    await act(async () => root.unmount());
  });

  it("renders prompt contexts in the edit second row and keeps protocol text out of the editor", async () => {
    const onEdit = vi.fn(async () => true);
    const webContext: WebElementContextComposerAttachment = {
      capturedAt: 1_700_000_000_000,
      id: "edit-web-element",
      pageTitle: "Docs",
      pageUrl: "https://example.test/docs",
      selector: "main",
      tagName: "main",
      workspacePath: "/workspace",
    };
    const row = userInputRow({
      attachments: [],
      text: buildPromptWithWebElementContexts("改一下", [webContext]),
    });
    const container = installMinimalDom();
    const root: Root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            onEdit,
            row,
          }),
        ),
      );
    });
    await act(async () => {
      (
        messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)))?.onClick as
          | (() => void)
          | undefined
      )?.();
    });

    expect(chatPromptEditorProps.at(-1)?.initialValue).toBe("改一下");
    const contextRow = findElementByAttribute(
      container,
      "data-v4-user-edit-context-attachments-row",
      "true",
    );
    expect(contextRow).not.toBeNull();
    expect(collectText(contextRow)).toContain("1 个网页元素");

    await act(async () => {
      await (chatPromptEditorProps.at(-1)!.onSubmit as (value: string) => Promise<void>)("更新");
    });
    expect(onEdit).toHaveBeenCalledWith(
      { rowId: row.rowId, entityId: row.entityId },
      buildPromptWithWebElementContexts("更新", [webContext]),
      [],
      "preserve",
    );

    await act(async () => root.unmount());
  });

  it("rejects an edit only after both text and attachments become empty", async () => {
    const onEdit = vi.fn(async () => true);
    const row = userInputRow({ text: "" });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            onEdit,
            row,
          }),
        ),
      );
    });
    await act(async () => {
      (
        messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)))?.onClick as
          | (() => void)
          | undefined
      )?.();
    });
    expect(chatPromptEditorProps.at(-1)?.submitDisabled).toBe(false);

    await act(async () => {
      (
        attachmentRemovePropsByTestId.get(testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${row.rowId}-0`))!
          .onClick as () => void
      )();
    });
    expect(chatPromptEditorProps.at(-1)?.allowSubmitWhenEmpty).toBe(false);
    expect(chatPromptEditorProps.at(-1)?.submitDisabled).toBe(true);

    await act(async () => {
      await (chatPromptEditorProps.at(-1)!.onSubmit as (value: string) => Promise<void>)("   ");
    });
    expect(onEdit).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("restores the original attachment list after cancelling and reopening edit", async () => {
    const onEdit = vi.fn(async () => true);
    const row = userInputRow({
      attachments: [
        ...(userInputRow().attachments ?? []),
        {
          bytes: 24,
          fileName: "second.txt",
          mime: "text/plain",
          ref: "/workspace/second.txt",
        },
      ],
    });
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            onEdit,
            row,
          }),
        ),
      );
    });
    await act(async () => {
      (
        messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)))?.onClick as
          | (() => void)
          | undefined
      )?.();
    });
    await act(async () => {
      (
        attachmentRemovePropsByTestId.get(testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${row.rowId}-0`))!
          .onClick as () => void
      )();
      (chatPromptEditorProps.at(-1)!.onCancel as () => void)();
    });
    await act(async () => {
      (
        messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)))?.onClick as
          | (() => void)
          | undefined
      )?.();
    });
    await act(async () => {
      await (chatPromptEditorProps.at(-1)!.onSubmit as (value: string) => Promise<void>)(row.text);
    });

    expect(onEdit).toHaveBeenCalledWith(
      { rowId: row.rowId, entityId: row.entityId },
      row.text,
      row.attachments,
      "preserve",
    );
    await act(async () => root.unmount());
  });

  it("keeps removed refs after a failed ACK and leaves 15360+ pasted text in the editor", async () => {
    const onEdit = vi.fn(async () => false);
    const row = userInputRow({
      attachments: [
        ...(userInputRow().attachments ?? []),
        {
          bytes: 24,
          fileName: "second.txt",
          mime: "text/plain",
          ref: "/workspace/second.txt",
        },
      ],
    });
    const longText = "长".repeat(15_361);
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            onEdit,
            row,
          }),
        ),
      );
    });
    await act(async () => {
      (
        messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)))?.onClick as
          | (() => void)
          | undefined
      )?.();
    });
    expect(chatPromptEditorProps.at(-1)?.onPaste).toBeUndefined();
    await act(async () => {
      (
        attachmentRemovePropsByTestId.get(testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${row.rowId}-0`))!
          .onClick as () => void
      )();
      (chatPromptEditorProps.at(-1)!.onChange as (value: string) => void)(longText);
    });
    await act(async () => {
      await (chatPromptEditorProps.at(-1)!.onSubmit as (value: string) => Promise<void>)(longText);
    });

    expect(onEdit).toHaveBeenCalledWith(
      { rowId: row.rowId, entityId: row.entityId },
      longText,
      [row.attachments?.[1]],
      "preserve",
    );
    expect(chatPromptEditorProps.at(-1)?.initialValue).toBe(row.text);
    expect(
      attachmentRemovePropsByTestId.has(testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${row.rowId}-0`)),
    ).toBe(true);

    await act(async () => root.unmount());
  });

  it("keeps the disabled file reset tooltip hoverable and explains why it is unavailable", async () => {
    const row = userInputRow();
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            editWorkspaceRewindAvailability: {
              enabled: false,
              reason: "noFiles",
            },
            onEdit: vi.fn(),
            row,
          }),
        ),
      );
    });

    const editAction = messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)));
    const editOnClick = editAction?.onClick;
    expect(editOnClick).toBeTypeOf("function");
    await act(async () => {
      (editOnClick as () => void)();
    });

    const slot = chatPromptEditorProps.at(-1)?.betweenCancelAndSubmitAction as ReactElement<{
      description?: string;
      title: string;
      children: ReactElement<Record<string, unknown>>;
    }>;
    const disabledTooltipTrigger = slot.props.children;
    const rewindButton = disabledTooltipTrigger.props.children as ReactElement<
      Record<string, unknown>
    >;
    expect(slot.props.title).toBe("与文件一起重置");
    expect(slot.props.description).toBe("本轮没有可安全恢复的文件改动");
    expect(disabledTooltipTrigger.type).toBe("span");
    expect(disabledTooltipTrigger.props["data-disabled-tooltip-trigger"]).toBe("true");
    expect(rewindButton.props.disabled).toBe(true);
    expect(rewindButton.props.size).toBe("icon-md");
    expect((rewindButton.props.children as ReactElement).type).toBe(FileClockIcon);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the file+conversation action between cancel and send and falls back after a blocked preview", async () => {
    const preview = {
      canApply: false,
      safeFiles: [],
      unsafeFiles: [
        {
          action: "restore" as const,
          operationCount: 1,
          path: "/workspace/note.txt",
          reason: "external_modified" as const,
          toolNames: ["Write"],
        },
      ],
      ignoredFiles: [],
    };
    const onEdit = vi
      .fn()
      .mockResolvedValueOnce({
        commandId: "edit-rewind-command",
        accepted: true,
        result: {
          type: "editUserQuery",
          disposition: "blocked",
          preview,
          reasonCode: "edit.workspaceRewindBlocked",
        },
      })
      .mockResolvedValueOnce({
        commandId: "edit-conversation-only-command",
        accepted: true,
        result: { type: "editUserQuery", disposition: "rewind" },
      });
    const row = userInputRow();
    const root: Root = createRoot(installMinimalDom());

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, {
            context: rowContext,
            editWorkspaceRewindAvailability: {
              enabled: true,
              reason: "available",
            },
            onEdit,
            row,
          }),
        ),
      );
    });
    const editAction = messageActionPropsByTestId.get(testId(TID_V4_EDIT, String(row.rowId)));
    const editOnClick = editAction?.onClick;
    expect(editOnClick).toBeTypeOf("function");
    await act(async () => {
      (editOnClick as () => void)();
    });

    const slot = chatPromptEditorProps.at(-1)?.betweenCancelAndSubmitAction as ReactElement<{
      description?: string;
      title: string;
      children: ReactElement<Record<string, unknown>>;
    }>;
    const rewindButton = slot.props.children;
    expect(slot.props.title).toBe("与文件一起重置");
    expect(slot.props.description).toBeUndefined();
    expect(rewindButton.props["data-testid"]).toBe(
      testId(TID_V4_EDIT_REWIND_WORKSPACE, String(row.rowId)),
    );
    expect(rewindButton.props.disabled).toBe(false);
    expect(rewindButton.props.size).toBe("icon-md");
    expect(rewindButton.props.children).toMatchObject({
      type: FileClockIcon,
      props: { className: "size-4" },
    });

    await act(async () => {
      (rewindButton.props.onClick as () => void)();
      await Promise.resolve();
    });

    expect(onEdit).toHaveBeenNthCalledWith(
      1,
      { rowId: row.rowId, entityId: row.entityId },
      row.text,
      row.attachments,
      "rewind",
    );
    expect(fileRewindDialogProps.at(-1)).toMatchObject({
      open: true,
      preview,
      variant: "editConflict",
    });

    const onConversationOnly = fileRewindDialogProps.at(-1)?.onConversationOnly;
    expect(onConversationOnly).toBeTypeOf("function");
    await act(async () => {
      (onConversationOnly as () => void)();
      await Promise.resolve();
    });
    expect(onEdit).toHaveBeenNthCalledWith(
      2,
      { rowId: row.rowId, entityId: row.entityId },
      row.text,
      row.attachments,
      "preserve",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
