import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchCodeCommentAddToChat,
  dispatchCodeCommentRemoveFromChat,
  type CodeCommentPayload,
} from "@/lib/codeCommentContext.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";
import type { WebElementContextComposerAttachment } from "@/lib/webElementContext.js";
import type { PptxElementReference } from "@/lib/pptxElementReference.js";
import {
  countComposerPromptContexts,
  parseComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import {
  useCodeCommentContexts,
  type UseCodeCommentContextsResult,
} from "@/v4/composer/useCodeCommentContexts.js";

let latestApi: UseCodeCommentContextsResult | null = null;

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: Node) => {
      Object.assign(child, { parentNode: element });
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as Node[],
    insertBefore: (child: Node, beforeChild?: Node | null) => {
      Object.assign(child, { parentNode: element });
      const beforeIndex = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (beforeIndex >= 0) element.childNodes.splice(beforeIndex, 0, child);
      else element.childNodes.push(child);
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as Node | null,
    removeChild: (child: Node) => {
      element.childNodes = element.childNodes.filter((candidate) => candidate !== child);
      Object.assign(child, { parentNode: null });
      return child;
    },
    removeEventListener: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const target = new EventTarget();
  const documentMock = {
    addEventListener: () => {},
    createComment: (nodeValue: string) => ({ nodeType: 8, nodeValue, parentNode: null }),
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({ nodeType: 3, nodeValue, parentNode: null }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document & { defaultView?: unknown };
  const windowMock = {
    addEventListener: target.addEventListener.bind(target),
    cancelAnimationFrame: () => {},
    clearTimeout,
    dispatchEvent: target.dispatchEvent.bind(target),
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: target.removeEventListener.bind(target),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    setTimeout,
  };
  documentMock.defaultView = windowMock;
  vi.stubGlobal("document", documentMock);
  vi.stubGlobal("window", windowMock);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return createMinimalElement(documentMock, "div");
}

function Harness({
  listen,
  onContextRemoved,
  requestFocus,
  scopeKey = "/target\0session-1",
}: {
  listen: boolean;
  onContextRemoved: (context: CodeCommentPayload & { id: string }) => void;
  requestFocus: () => void;
  scopeKey?: string;
}) {
  latestApi = useCodeCommentContexts({
    listenAddToChatEvents: listen,
    onContextRemoved,
    requestFocus,
    scopeKey,
  });
  return null;
}

function renderHarness(props: Parameters<typeof Harness>[0]): Root {
  const root = createRoot(installMinimalDom());
  act(() => root.render(createElement(Harness, props)));
  return root;
}

function comment(
  workspaceIdentity: string,
  value: string,
): CodeCommentPayload {
  return {
    id: "same-id",
    workspacePath: "/source",
    workspaceIdentity,
    sourcePath: "/source/example.ts",
    sourceTitle: "example.ts",
    startLine: 4,
    endLine: 5,
    selectedText: "const value = 1;",
    comment: value,
  };
}

afterEach(() => {
  latestApi = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("V4 code comment composer context", () => {
  it("claims add-to-chat, replaces the same source comment, focuses, and removes exactly", () => {
    const requestFocus = vi.fn();
    const onContextRemoved = vi.fn();
    const root = renderHarness({ listen: true, onContextRemoved, requestFocus });

    act(() => {
      expect(dispatchCodeCommentAddToChat(comment("remote:ssh:a:/source", "first"))).toBe(true);
      expect(dispatchCodeCommentAddToChat(comment("remote:ssh:a:/source", "updated"))).toBe(true);
      expect(dispatchCodeCommentAddToChat(comment("remote:ssh:b:/source", "other"))).toBe(true);
    });

    expect(latestApi?.contexts).toMatchObject([
      { comment: "updated", workspaceIdentity: "remote:ssh:a:/source" },
      { comment: "other", workspaceIdentity: "remote:ssh:b:/source" },
    ]);
    expect(requestFocus).toHaveBeenCalledTimes(3);

    act(() => {
      dispatchCodeCommentRemoveFromChat({
        id: "same-id",
        workspacePath: "/source",
        workspaceIdentity: "remote:ssh:a:/source",
      });
    });

    expect(latestApi?.contexts).toMatchObject([
      { comment: "other", workspaceIdentity: "remote:ssh:b:/source" },
    ]);
    expect(onContextRemoved).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceIdentity: "remote:ssh:a:/source" }),
    );

    act(() => root.unmount());
  });

  it("does not claim events in a background pane", () => {
    const root = renderHarness({
      listen: false,
      onContextRemoved: vi.fn(),
      requestFocus: vi.fn(),
    });

    expect(dispatchCodeCommentAddToChat(comment("remote:ssh:a:/source", "first"))).toBe(false);
    expect(latestApi?.contexts).toHaveLength(0);

    act(() => root.unmount());
  });

  it("clears the claimed comment when the target composer scope changes", () => {
    const requestFocus = vi.fn();
    const onContextRemoved = vi.fn();
    const firstProps = { listen: true, onContextRemoved, requestFocus };
    const root = renderHarness(firstProps);

    act(() => {
      dispatchCodeCommentAddToChat(comment("remote:ssh:a:/source", "first"));
    });
    expect(latestApi?.contexts).toHaveLength(1);

    act(() => {
      root.render(
        createElement(Harness, {
          ...firstProps,
          scopeKey: "/target\0session-2",
        }),
      );
    });

    expect(latestApi?.contexts).toHaveLength(0);
    expect(onContextRemoved).toHaveBeenCalledWith(
      expect.objectContaining({ id: "same-id" }),
    );

    act(() => root.unmount());
  });
});

describe("V4 composer prompt contexts", () => {
  it("serializes and parses conversation selections, code comments, and web elements", () => {
    const selection: ConversationSelectionReference = {
      id: "selection-1",
      sourceSessionId: "source-session",
      sourceRowId: 3,
      contentType: "assistant",
      text: "selected answer",
    };
    const webElement: WebElementContextComposerAttachment = {
      id: "element-1",
      workspacePath: "/target",
      pageUrl: "https://example.test",
      pageTitle: "Example",
      tagName: "button",
      text: "Save",
      capturedAt: 1,
    };
    const codeComment = { ...comment("remote:ssh:a:/source", "rename this"), id: "comment-1" };
    const pptxElement: PptxElementReference = {
      id: "pptx-1",
      workspacePath: "/target",
      sourcePath: "/target/deck.pptx",
      sourceTitle: "deck.pptx",
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title 1",
      nodeType: "shape",
      bounds: { x: 0, y: 0, width: 100, height: 30 },
      zIndex: 1,
      capturedAt: 1,
    };

    const serialized = serializeComposerPromptContexts("visible body", {
      codeComments: [codeComment],
      conversationSelections: [selection],
      webElements: [webElement],
      pptxElements: [pptxElement],
    });

    expect(serialized.indexOf("# userselect:")).toBeGreaterThan(0);
    expect(serialized.indexOf("# Code comments:")).toBeGreaterThan(
      serialized.indexOf("# userselect:"),
    );
    expect(serialized.indexOf("# Web page elements:")).toBeGreaterThan(
      serialized.indexOf("# Code comments:"),
    );
    expect(
      serialized.indexOf("# Presentation element comments:"),
    ).toBeGreaterThan(
      serialized.indexOf("# Web page elements:"),
    );
    expect(
      parseComposerPromptContexts(serialized, {
        workspacePath: "/target",
        workspaceIdentity: "remote:ssh:target:/target",
      }),
    ).toMatchObject({
      visibleContent: "visible body",
      codeComments: [{ comment: "rename this", sourcePath: "/source/example.ts" }],
      conversationSelections: [{ text: "selected answer" }],
      webElements: [{ pageUrl: "https://example.test", tagName: "button" }],
      pptxElements: [{ sourceTitle: "deck.pptx", nodeId: "7" }],
    });
    expect(
      countComposerPromptContexts({
        codeComments: [codeComment],
        conversationSelections: [selection],
        webElements: [webElement],
        pptxElements: [pptxElement],
      }),
    ).toBe(4);
  });
});
