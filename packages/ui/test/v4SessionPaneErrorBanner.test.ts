import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { SessionPane } from "@/v4/SessionPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const projectionState = vi.hoisted(() => ({
  current: null as {
    status: "live" | "error";
    snapshot: ConversationSnapshot | null;
    subscriptionId: string | null;
    lastError: string | null;
    optimisticCommands: readonly [];
    loadingOlder: boolean;
  } | null,
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: {
      acquire: vi.fn(),
    },
    sendCommand: vi.fn(),
    attachmentPut: vi.fn(),
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { zcodeInteractionBehavior: "queue" },
    loading: false,
    error: null,
    update: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => ({
    zcodeSessionService: {
      updateProviderRegistry: vi.fn(),
    },
    zcodeTaskService: {
      restartWorkspaceProcess: vi.fn(),
    },
  }),
}));

vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: { state: { status: "loading" }, reload: vi.fn() },
    captureAcceptedModelSelection: () => vi.fn(),
    draftConfigRef: { current: {} },
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
  }),
}));

vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({
    binding: null,
  }),
}));

vi.mock("@/v4/ConversationComposer.js", async () => {
  const React = await import("react");
  return {
    ConversationComposer: ({
      error,
    }: {
      error?: {
        message: string;
        attribution?: { reason?: string };
        underlyingErrorMessage?: string;
        underlyingErrorDetail?: string;
      } | null;
    }) =>
      React.createElement(
        "div",
        {
          "data-testid": "mock-v4-composer-error",
          "data-attribution-reason": error?.attribution?.reason ?? "",
          "data-underlying-error-message": error?.underlyingErrorMessage ?? "",
          "data-underlying-error-detail": error?.underlyingErrorDetail ?? "",
        },
        error?.message ?? "no-error",
      ),
  };
});

vi.mock("@/v4/ConversationHeader.js", async () => {
  const React = await import("react");
  return {
    ConversationHeader: () => React.createElement("div", { "data-testid": "mock-header" }),
  };
});

vi.mock("@/v4/ConversationStatusPanel.js", async () => {
  const React = await import("react");
  return {
    ConversationStatusPanel: () => React.createElement("div", { "data-testid": "mock-status" }),
  };
});

vi.mock("@/v4/ConversationTimeline.js", async () => {
  const React = await import("react");
  return {
    ConversationTimeline: ({ bottomDock }: { bottomDock?: ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-timeline" }, bottomDock),
  };
});

vi.mock("@/v4/ConversationQueuePanel.js", async () => {
  const React = await import("react");
  return {
    ConversationQueuePanel: () => React.createElement("div", { "data-testid": "mock-queue" }),
  };
});

vi.mock("@/v4/V4InteractionDialogs.js", async () => {
  const React = await import("react");
  return {
    V4InteractionDialogs: () => React.createElement("div", { "data-testid": "mock-interactions" }),
  };
});

vi.mock("@/request-security-edition/V4ProviderRuntimeHeadersController.js", async () => {
  const React = await import("react");
  return {
    V4ProviderRuntimeHeadersController: () =>
      React.createElement("div", { "data-testid": "mock-runtime-headers" }),
  };
});

vi.mock("@/v4/ConversationDraftEmptyState.js", async () => {
  const React = await import("react");
  return {
    ConversationDraftEmptyState: () =>
      React.createElement("div", { "data-testid": "mock-draft-empty" }),
  };
});

function makeSnapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 1,
    control: {
      phase: "error",
      sessionEnded: false,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: {
        code: "fault.provider.rateLimited",
        message: "Provider rate limit exceeded.",
        recoverable: true,
        at: 1_777_777_777,
        source: "provider",
        attribution: {
          source: "provider",
          reason: "rate_limited",
          providerId: "account:zai-individual-coding-plan",
          modelId: "glm-5",
          statusCode: 429,
          retryable: true,
        },
        underlyingErrorMessage: "Upstream request failed",
        underlyingErrorDetail: "Upstream instance timed out after 10000ms.",
      },
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue" },
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
    ...overrides,
  };
}

function renderPane(): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SessionPane, {
        paneId: "workspace-main",
        sessionId: "session-1",
        workspacePath: "/workspace",
      }),
    ),
  );
}

describe("SessionPane error banner wiring", () => {
  it("passes snapshot.control.lastError to the composer error banner", () => {
    projectionState.current = {
      status: "live",
      snapshot: makeSnapshot(),
      subscriptionId: "sub-1",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
    };

    const html = renderPane();

    expect(html).toContain("Provider rate limit exceeded.");
    expect(html).toContain('data-attribution-reason="rate_limited"');
    expect(html).toContain('data-underlying-error-message="Upstream request failed"');
    expect(html).toContain(
      'data-underlying-error-detail="Upstream instance timed out after 10000ms."',
    );
  });

  it("renders the feedback shortcut in the subscription error state", () => {
    projectionState.current = {
      status: "error",
      snapshot: null,
      subscriptionId: null,
      lastError: "EPERM: operation not permitted",
      optimisticCommands: [],
      loadingOlder: false,
    };

    const html = renderPane();

    expect(html).toContain("EPERM: operation not permitted");
    expect(html).toContain("反馈问题");
    expect(html).toContain("重新连接");
  });
});
