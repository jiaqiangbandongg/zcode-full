import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPromptHistoryStorageKey,
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  ConversationComposer,
  type ConversationComposerSendResult,
} from "@/v4/ConversationComposer.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { getComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

const { attachmentState, chatPromptEditorProps, dialogOpenStates, inputClear } = vi.hoisted(() => ({
  attachmentState: {
    adoptSentAttachments: vi.fn(async () => {}),
    hasUnreadyAttachments: false,
    prepareForSend: vi.fn(async () => []),
  },
  chatPromptEditorProps: [] as Array<Record<string, unknown>>,
  dialogOpenStates: [] as boolean[],
  inputClear: vi.fn(),
}));

function expectedTelemetrySendOptions() {
  return expect.objectContaining({
    telemetrySeed: {
      sendTime: expect.any(Number),
      extraDetail: {
        ask_mode: "",
        model_name: "",
        model_provider: "glm",
        agent: "glm",
        plan_status: "unknown",
        plan_product_id: "",
        message_source: "chat",
        task_trigger: "",
      },
    },
  });
}

vi.mock("@/components/ui/dialog.js", async () => {
  const React = await import("react");
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) => {
      dialogOpenStates.push(Boolean(open));
      return open ? React.createElement(React.Fragment, null, children) : null;
    },
    DialogClose: Passthrough,
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});

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
          clear: inputClear,
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
    adoptSentAttachments: attachmentState.adoptSentAttachments,
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
    hasUnreadyAttachments: attachmentState.hasUnreadyAttachments,
    isDraggingOverComposer: false,
    openAttachmentPicker: vi.fn(),
    prepareForSend: attachmentState.prepareForSend,
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
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
  } as Storage;
}

function installMinimalDom() {
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

function flushAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function renderComposerElement(
  onSendText: (text: string, options?: unknown) => Promise<ConversationComposerSendResult | void>,
  sessionId: string | null,
  telemetryDraftConfig?: {
    mode?: string;
    model?: string;
    provider?: string;
  },
  skillCatalogSessionId?: string | null,
  createSubmissionFromComposer?: () => ComposerSubmissionConfig | null,
  composerDraft?: V4ComposerDraft,
  updateComposerContent?: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void,
  submissionReady = true,
) {
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  let ownedDraft =
    composerDraft ??
    readV4ComposerDraft("/workspace", undefined, scopeId) ?? {
      text: "",
      updatedAt: 0,
    };
  const persistOwnedContent =
    updateComposerContent ??
    ((content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      ownedDraft = { ...ownedDraft, ...content };
      persistV4ComposerDraft("/workspace", undefined, scopeId, ownedDraft);
    });
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(ConversationComposer, {
      draftMode: sessionId === null,
      onSelectModel: vi.fn(),
      onSelectThought: vi.fn(),
      onSendText,
      createSubmissionFromComposer,
      submissionReady,
      composerDraft: ownedDraft,
      updateComposerContent: persistOwnedContent,
      replaceComposerDraft: (next) => {
        ownedDraft = { ...next, updatedAt: Date.now() };
        persistV4ComposerDraft("/workspace", undefined, scopeId, ownedDraft);
      },
      onStop: vi.fn(),
      onSwitchMode: vi.fn(),
      provider: undefined,
      sessionId,
      skillCatalogSessionId,
      snapshot: null,
      telemetryDraftConfig,
      workspacePath: "/workspace",
    }),
  );
}

function renderComposer(
  onSendText: (text: string, options?: unknown) => Promise<ConversationComposerSendResult | void>,
  telemetryDraftConfig?: {
    mode?: string;
    model?: string;
    provider?: string;
  },
) {
  const container = installMinimalDom();
  const root: Root = createRoot(container);
  act(() => {
    root.render(renderComposerElement(onSendText, null, telemetryDraftConfig));
  });
  return {
    rerenderSession: (sessionId: string) => {
      act(() => root.render(renderComposerElement(onSendText, sessionId)));
    },
    root,
  };
}

afterEach(() => {
  chatPromptEditorProps.length = 0;
  attachmentState.hasUnreadyAttachments = false;
  attachmentState.adoptSentAttachments.mockClear();
  attachmentState.prepareForSend.mockClear();
  attachmentState.prepareForSend.mockResolvedValue([]);
  inputClear.mockClear();
  dialogOpenStates.length = 0;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ConversationComposer prompt history", () => {
  it("真实编辑器文本变更会推进草稿 revision，保护迟到的推荐 Prompt", async () => {
    const { root } = renderComposer(vi.fn(async () => {}));
    const revisionBefore = getComposerDraftRevision("/workspace");
    const onChange = chatPromptEditorProps.at(-1)?.onChange;

    await act(async () => {
      (onChange as (value: string) => void)("用户正在输入");
    });

    expect(getComposerDraftRevision("/workspace")).toBe(revisionBefore + 1);
    await act(async () => root.unmount());
  });

  it("草稿预热 Session 只作为 Skill catalog authority 传给输入区", async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        renderComposerElement(
          vi.fn(async () => {}),
          null,
          undefined,
          "prewarm-a",
        ),
      );
    });

    expect(chatPromptEditorProps.at(-1)).toMatchObject({
      taskId: null,
      skillCatalogSessionId: "prewarm-a",
    });
    await act(async () => root.unmount());
  });

  it("prewarm snapshot 未到时仍用冻结草稿 config 建立 send telemetry seed", async () => {
    const onSendText = vi.fn(async () => {});
    const { root } = renderComposer(onSendText, {
      mode: "build",
      model: "deepseek-v4-flash",
      provider: "e2e-deepseek",
    });
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("立即发送草稿");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledWith(
      "立即发送草稿",
      expect.objectContaining({
        telemetrySeed: expect.objectContaining({
          extraDetail: expect.objectContaining({
            ask_mode: "build",
            model_name: "custom:e2e-deepseek:deepseek-v4-flash",
            model_provider: "e2e-deepseek",
          }),
        }),
      }),
    );

    await act(async () => root.unmount());
  });

  it("存在非 ready 附件时 submit 不发送，也不调用最终附件提交入口", async () => {
    attachmentState.hasUnreadyAttachments = true;
    const onSendText = vi.fn(async () => {});
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("不能提前发送");
      await flushAsyncWork();
    });

    expect(attachmentState.prepareForSend).not.toHaveBeenCalled();
    expect(attachmentState.adoptSentAttachments).not.toHaveBeenCalled();
    expect(onSendText).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("等待附件就绪期间切换模型，本次请求仍使用点击发送时的选择", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    const onSendText = vi.fn(async () => {});
    let composer: ComposerSubmissionConfig = {
      mode: "build",
      modelSelection: {
        providerId: "provider-a",
        modelId: "shared-model",
        options: { reasoningLevel: "high" },
      },
    };
    const readSubmission = vi.fn(() => structuredClone(composer));
    let finishAttachments!: (value: []) => void;
    attachmentState.prepareForSend.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          finishAttachments = resolve;
        }),
    );
    act(() =>
      root.render(renderComposerElement(onSendText, null, undefined, null, readSubmission)),
    );
    const submit = chatPromptEditorProps.at(-1)!.onSubmit as (text: string) => boolean;
    await act(async () => {
      submit("冻结本次选择");
      await flushAsyncWork();
    });
    expect(readSubmission).toHaveBeenCalledTimes(1);
    expect(onSendText).not.toHaveBeenCalled();
    composer = {
      mode: "yolo",
      modelSelection: {
        providerId: "provider-b",
        modelId: "shared-model",
        options: { reasoningLevel: "low" },
      },
    };
    await act(async () => {
      finishAttachments([]);
      await flushAsyncWork();
    });
    expect(readSubmission).toHaveBeenCalledTimes(1);
    expect(onSendText).toHaveBeenCalledWith(
      "冻结本次选择",
      expect.objectContaining({
        submission: {
          mode: "build",
          modelSelection: {
            providerId: "provider-a",
            modelId: "shared-model",
            options: { reasoningLevel: "high" },
          },
        },
      }),
    );
    await act(async () => root.unmount());
  });

  it("模型或 reasoning 选择不完整时禁止提交并保留正文", async () => {
    const onSendText = vi.fn(async () => {});
    const container = installMinimalDom();
    const root = createRoot(container);
    act(() =>
      root.render(
        renderComposerElement(
          onSendText,
          "session-a",
          undefined,
          null,
          () => null,
          undefined,
          undefined,
          false,
        ),
      ),
    );

    expect(chatPromptEditorProps.at(-1)?.submitDisabled).toBe(true);
    await act(async () => {
      (chatPromptEditorProps.at(-1)!.onSubmit as (text: string) => boolean)("等待补全选择");
      await flushAsyncWork();
    });

    expect(onSendText).not.toHaveBeenCalled();
    expect(inputClear).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("发送成功只清正文，保留当前 scope 的模式和模型选择", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    const selection = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    };
    let draft: V4ComposerDraft = {
      text: "会被发送",
      mode: "yolo",
      modelSelection: selection,
      updatedAt: 1,
    };
    persistV4ComposerDraft("/workspace", undefined, "session-a", draft);
    const updateContent = vi.fn(
      (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
        draft = { ...draft, ...content };
        persistV4ComposerDraft("/workspace", undefined, "session-a", draft);
      },
    );
    act(() =>
      root.render(
        renderComposerElement(
          vi.fn(async () => {}),
          "session-a",
          undefined,
          null,
          () => ({ mode: "yolo", modelSelection: selection }),
          draft,
          updateContent,
        ),
      ),
    );
    await act(async () => {
      (chatPromptEditorProps.at(-1)!.onSubmit as (text: string) => boolean)("会被发送");
      await flushAsyncWork();
    });
    expect(readV4ComposerDraft("/workspace", undefined, "session-a")).toMatchObject({
      text: "",
      mode: "yolo",
      modelSelection: selection,
    });
    await act(async () => root.unmount());
  });

  it("迟到的发送成功不能清除等待期间产生的新正文", async () => {
    let resolveSend!: () => void;
    const onSendText = vi.fn(
      () => new Promise<void>((resolve) => { resolveSend = resolve; }),
    );
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)!.onSubmit as (text: string) => boolean;
    const onChange = chatPromptEditorProps.at(-1)!.onChange as (text: string) => void;
    inputClear.mockClear();
    await act(async () => {
      submit("第一条");
      await flushAsyncWork();
    });
    await act(async () => onChange("下一条"));
    await act(async () => {
      resolveSend();
      await flushAsyncWork();
    });
    expect(inputClear).not.toHaveBeenCalled();
    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)?.text).toBe("下一条");
    await act(async () => root.unmount());
  });

  it("二次门禁返回 null 时保留编辑器且不发送", async () => {
    attachmentState.prepareForSend.mockResolvedValueOnce(null);
    const onSendText = vi.fn(async () => {});
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("提交边界再次检查");
      await flushAsyncWork();
    });

    expect(attachmentState.prepareForSend).toHaveBeenCalledTimes(1);
    expect(attachmentState.adoptSentAttachments).not.toHaveBeenCalled();
    expect(onSendText).not.toHaveBeenCalled();
    expect(inputClear).not.toHaveBeenCalled();
    expect(readPromptHistoryEntries("/workspace")).toEqual([]);

    await act(async () => root.unmount());
  });

  it("writes submitted text to localStorage before an accepted send can promote away the draft composer", async () => {
    let resolveSend: (() => void) | undefined;
    const onSendText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    expect(typeof submit).toBe("function");

    await act(async () => {
      (submit as (value: string) => boolean)("你回答 1");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledWith("你回答 1", expectedTelemetrySendOptions());
    expect(readPromptHistoryEntries("/workspace")).toEqual(["你回答 1"]);

    await act(async () => {
      root.unmount();
      resolveSend?.();
      await flushAsyncWork();
    });
  });

  it("restores the previous localStorage prompt history when send fails", async () => {
    const onSendText = vi.fn(async () => {
      throw new Error("send failed");
    });
    const { root } = renderComposer(onSendText);
    persistPromptHistoryEntries("/workspace", ["上一条"]);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    expect(typeof submit).toBe("function");

    await act(async () => {
      (submit as (value: string) => boolean)("失败的消息");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledWith("失败的消息", expectedTelemetrySendOptions());
    expect(readPromptHistoryEntries("/workspace")).toEqual(["上一条"]);

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the editor draft and prompt history untouched when a product guard blocks send", async () => {
    const onSendText = vi.fn(async () => "blocked" as const);
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("/goal 保留这段输入");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenCalledWith("/goal 保留这段输入", expectedTelemetrySendOptions());
    expect(inputClear).not.toHaveBeenCalled();
    expect(attachmentState.adoptSentAttachments).not.toHaveBeenCalled();
    expect(readPromptHistoryEntries("/workspace")).toEqual([]);
    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)?.text).toBe(
      "/goal 保留这段输入",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("opens paused-queue confirmation without adopting the draft or prompt history", async () => {
    const onSendText = vi.fn(async () => "confirmationRequired" as const);
    const { root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("等待确认的消息");
      await flushAsyncWork();
    });

    expect(dialogOpenStates.at(-1)).toBe(true);
    expect(inputClear).not.toHaveBeenCalled();
    expect(attachmentState.adoptSentAttachments).not.toHaveBeenCalled();
    expect(readPromptHistoryEntries("/workspace")).toEqual([]);
    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)?.text).toBe(
      "等待确认的消息",
    );

    await act(async () => root.unmount());
  });

  it("does not persist a consecutive duplicate after trimming outer whitespace", async () => {
    const onSendText = vi.fn(async () => {});
    const { root } = renderComposer(onSendText);
    const firstSubmit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (firstSubmit as (value: string) => boolean)("重复消息");
      await flushAsyncWork();
    });

    const setItem = vi.mocked(window.localStorage.setItem);
    setItem.mockClear();
    const duplicateSubmit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (duplicateSubmit as (value: string) => boolean)("  重复消息  ");
      await flushAsyncWork();
    });

    expect(onSendText).toHaveBeenNthCalledWith(2, "重复消息", expectedTelemetrySendOptions());
    expect(readPromptHistoryEntries("/workspace")).toEqual(["重复消息"]);
    expect(setItem).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("does not write or roll back history when a consecutive duplicate send fails", async () => {
    const onSendText = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("send failed"));
    const { root } = renderComposer(onSendText);
    const firstSubmit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (firstSubmit as (value: string) => boolean)("重复消息");
      await flushAsyncWork();
    });

    const setItem = vi.mocked(window.localStorage.setItem);
    setItem.mockClear();
    const duplicateSubmit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (duplicateSubmit as (value: string) => boolean)("重复消息");
      await flushAsyncWork();
    });

    expect(readPromptHistoryEntries("/workspace")).toEqual(["重复消息"]);
    expect(setItem).not.toHaveBeenCalledWith(
      getPromptHistoryStorageKey("/workspace"),
      expect.any(String),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("does not restore the submitted draft while the composer is promoted to a session", async () => {
    let resolveSend: (() => void) | undefined;
    const onSendText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { rerenderSession, root } = renderComposer(onSendText);
    const submit = chatPromptEditorProps.at(-1)?.onSubmit;

    await act(async () => {
      (submit as (value: string) => boolean)("首条消息");
      await flushAsyncWork();
    });

    rerenderSession("session-1");
    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)).toBeNull();

    await act(async () => {
      resolveSend?.();
      await flushAsyncWork();
    });

    expect(readV4ComposerDraft("/workspace", undefined, V4_DRAFT_SCOPE_ROOT)).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
