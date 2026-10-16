import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const captured = vi.hoisted(() => ({
  chatErrorBannerProps: null as Record<string, unknown> | null,
  chatPromptEditorProps: null as Record<string, unknown> | null,
  modelControlsProps: null as Record<string, unknown> | null,
}));

vi.mock("@/ChatErrorBanner.js", async () => {
  const React = await import("react");
  return {
    ChatErrorBanner: (props: {
      error: { message: string };
      onOpenModelSettings?: () => void;
      onOpenUpgrade?: () => void;
    }) => {
      captured.chatErrorBannerProps = props;
      return React.createElement(
        "section",
        { "data-testid": "mock-chat-error-banner" },
        props.error.message,
      );
    },
    shouldSuppressChatErrorBanner: () => false,
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
    ChatPromptEditor: (
      props: {
        inputLeadingContent?: ReactNode;
        leadingActions?: ReactNode;
        submitControl?: ReactNode;
        topContent?: ReactNode;
      } & Record<string, unknown>,
    ) => {
      captured.chatPromptEditorProps = props;
      return React.createElement(
        "form",
        { "data-testid": "mock-chat-prompt-editor" },
        props.topContent,
        props.inputLeadingContent,
        props.leadingActions,
        props.submitControl,
      );
    },
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: () => ({
    attachments: [],
    attachmentError: null,
    adoptSentAttachments: vi.fn(async () => {}),
    hasAttachments: false,
    hasUnreadyAttachments: false,
    isDraggingOverComposer: false,
    attachmentInputRef: { current: null },
    openAttachmentPicker: vi.fn(),
    handleAttachmentInputChange: vi.fn(),
    handlePaste: vi.fn(),
    handleDragOverComposer: vi.fn(),
    handleDragLeaveComposer: vi.fn(),
    handleDropComposer: vi.fn(),
    handleWhiteboardMentionSelected: vi.fn(),
    removeAttachment: vi.fn(),
    retryAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    prepareForSend: vi.fn(async () => []),
    setAttachmentError: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/V4ComposerToolbar.js", async () => {
  const React = await import("react");
  const Stub = ({ label }: { label: string }) => React.createElement("span", null, label);
  return {
    V4ComposerModeSwitch: () => React.createElement(Stub, { label: "mode" }),
    V4ComposerModelControls: (props: Record<string, unknown>) => {
      captured.modelControlsProps = props;
      return React.createElement(Stub, { label: "model" });
    },
  };
});

const AnyConversationComposer = ConversationComposer as unknown as ComponentType<
  Record<string, unknown>
>;

function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "sendQueuedNowRequiresRunning" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

function renderComposerWithError(
  message: string,
  actions: {
    onOpenModelSettings?: () => void;
    onOpenModelUpgrade?: () => void;
    contextHeader?: ReactNode;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AnyConversationComposer, {
        snapshot: null,
        sessionId: "session-1",
        workspacePath: "/workspace",
        provider: undefined,
        onSendText: vi.fn(async () => {}),
        onStop: vi.fn(),
        onSelectModel: vi.fn(),
        onSelectThought: vi.fn(),
        onSwitchMode: vi.fn(),
        error: {
          code: "fault.provider.rateLimited",
          message,
          taskId: "session-1",
        },
        onDismissError: vi.fn(),
        contextHeader: actions.contextHeader,
        ...actions,
      }),
    ),
  );
}

function renderComposerWithSnapshot(
  snapshot: ConversationSnapshot | null = makeSnapshot(),
  overrides: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AnyConversationComposer, {
        snapshot,
        sessionId: "session-1",
        workspacePath: "/workspace",
        provider: undefined,
        onSendText: vi.fn(async () => {}),
        onStop: vi.fn(),
        onSelectModel: vi.fn(),
        onSelectThought: vi.fn(),
        onSwitchMode: vi.fn(),
        ...overrides,
      }),
    ),
  );
}

function renderHighspeedComposer(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AnyConversationComposer, {
        snapshot: makeSnapshot(),
        sessionId: "session-1",
        workspacePath: "/workspace",
        provider: undefined,
        highspeedCard: {
          cardId: "hsc-composer",
          taskId: "session-1",
          provider: "zai",
          model: "glm-5.2",
          issuedAt: 1_000,
          expiresAt: 60_000,
        },
        onSendText: vi.fn(async () => {}),
        onStop: vi.fn(),
        onSelectModel: vi.fn(),
        onSelectThought: vi.fn(),
        onSwitchMode: vi.fn(),
        ...overrides,
      }),
    ),
  );
}

function renderBlockedComposer(): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AnyConversationComposer, {
        snapshot: makeSnapshot(),
        sessionId: "session-1",
        workspacePath: "/workspace",
        provider: undefined,
        blockingRequestId: "perm-1",
        onSendText: vi.fn(async () => {}),
        onStop: vi.fn(),
        onSelectModel: vi.fn(),
        onSelectThought: vi.fn(),
        onSwitchMode: vi.fn(),
      }),
    ),
  );
}

afterEach(() => {
  captured.chatErrorBannerProps = null;
  captured.chatPromptEditorProps = null;
  captured.modelControlsProps = null;
});

describe("ConversationComposer error banner", () => {
  it("renders an executed UserPromptSubmit Hook block reason as a chat error", () => {
    const html = renderComposerWithError("HOOK_PROMPT_BLOCK_REASON");

    expect(html).toContain("HOOK_PROMPT_BLOCK_REASON");
    expect(html).toContain("mock-chat-error-banner");
  });

  it("renders the session error banner above the prompt editor", () => {
    const html = renderComposerWithError("Provider rate limit exceeded.");

    expect(html).toContain("Provider rate limit exceeded.");
    expect(html.indexOf("mock-chat-error-banner")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("mock-chat-error-banner")).toBeLessThan(
      html.indexOf("mock-chat-prompt-editor"),
    );
  });

  it("renders the session error banner above the workspace context header", () => {
    const html = renderComposerWithError("No model", {
      contextHeader: createElement(
        "nav",
        { "data-testid": "mock-workspace-context-header" },
        "选择工作区",
      ),
    });

    expect(html.indexOf("mock-chat-error-banner")).toBeLessThan(
      html.indexOf("mock-workspace-context-header"),
    );
    expect(html.indexOf("mock-workspace-context-header")).toBeLessThan(
      html.indexOf("mock-chat-prompt-editor"),
    );
  });

  it("keeps the error banner outside the workspace and editor surface", () => {
    const html = renderComposerWithError("No model", {
      contextHeader: createElement(
        "nav",
        { "data-testid": "mock-workspace-context-header" },
        "选择工作区",
      ),
    });

    const bannerIndex = html.indexOf("mock-chat-error-banner");
    const inputSurfaceIndex = html.indexOf("chat-composer-input-surface");

    expect(html).toContain('class="mb-6 w-full shrink-0"');
    expect(bannerIndex).toBeGreaterThanOrEqual(0);
    expect(inputSurfaceIndex).toBeGreaterThan(bannerIndex);
    expect(html.indexOf("mock-workspace-context-header")).toBeGreaterThan(inputSurfaceIndex);
    expect(html.indexOf("mock-chat-prompt-editor")).toBeGreaterThan(inputSurfaceIndex);
  });

  it("keeps the bound-session input surface transparent", () => {
    const html = renderComposerWithError("No model");

    expect(html).toContain("chat-composer-input-surface relative w-full");
    expect(html).not.toContain("bg-[var(--color-background)]");
  });

  it("forwards model recovery actions to the shared error banner", () => {
    const onOpenModelSettings = vi.fn();
    const onOpenModelUpgrade = vi.fn();

    renderComposerWithError("No model", {
      onOpenModelSettings,
      onOpenModelUpgrade,
    });

    expect(captured.chatErrorBannerProps?.onOpenModelSettings).toBe(onOpenModelSettings);
    expect(captured.chatErrorBannerProps?.onOpenUpgrade).toBe(onOpenModelUpgrade);
  });

  it("does not render local queue behavior toggles in the composer", () => {
    const html = renderComposerWithSnapshot();

    expect(html).toContain("<span>mode</span>");
    expect(html).not.toContain("<span>queue</span>");
  });

  it("不再把 snapshot api retry 状态传入输入框工具条", () => {
    const snapshot = makeSnapshot();
    snapshot.control.apiRetry = {
      attempt: 1,
      maxAttempts: 11,
      nextRetryAt: 123,
      reasonCode: "fault.provider.rateLimited",
    };

    renderComposerWithSnapshot(snapshot);

    expect(captured.modelControlsProps).not.toHaveProperty("apiRetry");
  });

  it("keeps Enter and the submit control enabled by routing in guide mode", () => {
    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "running",
      sessionEnded: false,
      canStop: true,
    };
    snapshot.inputRouting = { mode: "guide" };

    renderComposerWithSnapshot(snapshot);

    expect(captured.chatPromptEditorProps?.disabled).toBe(false);
    expect(captured.chatPromptEditorProps?.submitDisabled).toBe(false);
  });

  it("keeps modified submit available when idle and reverses delivery only while running", () => {
    renderComposerWithSnapshot();
    const onModifiedSubmit = captured.chatPromptEditorProps?.onModifiedSubmit;
    expect(onModifiedSubmit).toEqual(expect.any(Function));
    expect((onModifiedSubmit as (value: string) => boolean)("草稿")).toBe(false);

    const snapshot = makeSnapshot();
    snapshot.control = {
      ...snapshot.control,
      phase: "running",
      sessionEnded: false,
      canStop: true,
    };
    snapshot.config.followupMode = "queue";
    snapshot.inputRouting = { mode: "enqueue" };

    renderComposerWithSnapshot(snapshot);
    expect(captured.chatPromptEditorProps?.onModifiedSubmit).toEqual(expect.any(Function));
  });

  it("keeps modified submit wired for a desktop new-task draft", () => {
    renderComposerWithSnapshot(null, {
      draftMode: true,
      sessionId: null,
    });

    expect(captured.chatPromptEditorProps?.onModifiedSubmit).toEqual(expect.any(Function));
  });

  it("keeps the composer mounted but hidden while a blocking request is active", () => {
    const html = renderBlockedComposer();

    expect(html).toMatch(
      /<div data-testid="v4-composer"[^>]*aria-hidden="true"[^>]*style="display:none"/,
    );
  });
});

describe("ConversationComposer Highspeed style", () => {
  it("renders the migrated visual without the legacy Fast badge or redundant active prop", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const html = renderHighspeedComposer();

    expect(html).toContain('data-highspeed-composer="true"');
    expect(html).toContain("highspeed-composer-surface");
    expect(html).toContain("highspeed-composer-background");
    expect(html).not.toContain("Fast");
    expect(captured.chatPromptEditorProps?.shellClassName).toContain("!border-0");
    expect(captured.modelControlsProps).toMatchObject({
      highspeedExpiresAt: 60_000,
      modelLocked: true,
    });
    expect(captured.modelControlsProps).not.toHaveProperty("highspeedActive");
  });

  it("没有激活请求的卡（切回 Task、快照恢复）直接呈现稳定态，不重播激活动效", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const html = renderHighspeedComposer();

    expect(html).toContain('data-highspeed-entrance="restore"');
    expect(html).toContain('data-phase="stable"');
    expect(html).not.toContain("highspeed-diffusion-canvas");
    expect(html).toContain("highspeed-placeholder-presented");
    expect(captured.modelControlsProps).toMatchObject({
      highspeedPresented: true,
      highspeedEntranceAnimated: false,
      highspeedSweepActive: false,
    });
  });

  it("draw 新命中的激活请求从扩散起点播放，模型与倒计时等待交接后再展示", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const html = renderHighspeedComposer({ highspeedActivationCardId: "hsc-composer" });

    expect(html).toContain('data-highspeed-entrance="activation"');
    expect(html).toContain('data-phase="diffusing"');
    expect(html).not.toContain("highspeed-placeholder-presented");
    expect(captured.modelControlsProps).toMatchObject({
      highspeedPresented: false,
      highspeedEntranceAnimated: true,
    });
  });
});
