// @vitest-environment jsdom
// 根 Vitest 只收集 .test.ts；本文件使用 createElement，不需要 TSX 扩展名。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  TID_V4_WORKSPACE_HOOK_PENDING_BANNER,
  TID_V4_WORKSPACE_HOOK_PENDING_DISMISS,
  TID_V4_WORKSPACE_HOOK_PENDING_REVIEW,
} from "@zcode/shared";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import {
  WorkspaceHookPendingBanner,
  workspaceHookPendingDismissStore,
} from "@/v4/WorkspaceHookPendingBanner.js";

// 模拟 settingsNavigation，验证 [去审核] 同时设置 intent
const settingsIntentMock = vi.hoisted(() => ({
  setPendingSettingsSectionIntent: vi.fn(),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: settingsIntentMock.setPendingSettingsSectionIntent,
}));

// 模拟 TabStoreProvider 的 openSettingsTab
const openSettingsTabMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/TabStoreProvider.js", () => ({
  useOptionalTabStore: () => openSettingsTabMock,
}));

// 模拟 workspaceHookReviewStore 的 findWorkspaceHookCommandBinding
const sendCommandMock = vi.hoisted(() => vi.fn(async () => ({ status: "accepted" })));
const onCommandSettledMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/workspaceHookReviewStore.js", () => ({
  useWorkspaceHookReviewStore: () => ({
    commandBindings: {
      "sess-1": {
        sessionId: "sess-1",
        workspacePath: "/workspace",
        workspaceIdentity: "/workspace",
        sendCommand: sendCommandMock,
        onCommandSettled: onCommandSettledMock,
      },
    },
  }),
  findWorkspaceHookCommandBinding: (
    _bindings: unknown,
    _workspacePath?: string | null,
    _workspaceIdentity?: string,
  ) => ({
    sessionId: "sess-1",
    workspacePath: "/workspace",
    workspaceIdentity: "/workspace",
    sendCommand: sendCommandMock,
    onCommandSettled: onCommandSettledMock,
  }),
}));

// 模拟 V4ConversationContext 的 sendCommand
vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    sendCommand: sendCommandMock,
  }),
}));

// 模拟 workspaceHookReviewCommands 的 sendWorkspaceHookCommand
const sendWorkspaceHookCommandMock = vi.hoisted(() =>
  vi.fn(async () => ({ accepted: true })),
);

vi.mock("@/settings/workspaceHookReviewCommands.js", () => ({
  sendWorkspaceHookCommand: sendWorkspaceHookCommandMock,
}));

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerMock.warn,
    error: vi.fn(),
  },
}));

const sampleAdmission = {
  pendingCount: 2,
  bundleDigest: "a".repeat(64),
  workspaceIdentity: "/workspace",
};

function renderBanner(props: {
  sessionId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  admission?: { pendingCount: number; bundleDigest: string; workspaceIdentity?: string } | null;
  onReview?: () => void;
  onDismiss?: () => void;
}) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkspaceHookPendingBanner, {
        sessionId: props.sessionId ?? "sess-1",
        workspacePath: props.workspacePath ?? "/workspace",
        workspaceIdentity: props.workspaceIdentity,
        admission: "admission" in props ? props.admission : sampleAdmission,
        onReview: props.onReview,
        onDismiss: props.onDismiss,
      }),
    ),
  );
}

function renderInteractiveBanner(admission = sampleAdmission) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkspaceHookPendingBanner, {
        sessionId: "sess-1",
        workspacePath: "/workspace",
        admission,
      }),
    ),
  );
}

describe("WorkspaceHookPendingBanner（软门禁 D4）", () => {
  beforeEach(() => {
    workspaceHookPendingDismissStore.clear();
    settingsIntentMock.setPendingSettingsSectionIntent.mockClear();
    openSettingsTabMock.mockClear();
    sendWorkspaceHookCommandMock.mockClear();
    sendCommandMock.mockClear();
    onCommandSettledMock.mockClear();
    loggerMock.warn.mockClear();
  });

  afterEach(() => cleanup());

  it("pendingCount > 0 时渲染提示条", () => {
    const html = renderBanner({ admission: sampleAdmission });
    expect(html).toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_BANNER + '"');
    expect(html).toContain("2");
  });

  it("pendingCount === 0 时不渲染", () => {
    const html = renderBanner({
      admission: { pendingCount: 0, bundleDigest: "b".repeat(64) },
    });
    expect(html).not.toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_BANNER + '"');
  });

  it("admission 为 null 时不渲染", () => {
    const html = renderBanner({ admission: null });
    expect(html).not.toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_BANNER + '"');
  });

  it("dismiss 后同 bundle 不再现（幂等 key = sessionId + bundleDigest）", () => {
    // 第一次 dismiss
    workspaceHookPendingDismissStore.dismiss("sess-1", sampleAdmission.bundleDigest);
    const html = renderBanner({ admission: sampleAdmission });
    expect(html).not.toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_BANNER + '"');
  });

  it("bundle 变化后 dismiss 失效，提示条重新出现", () => {
    // dismiss 旧 bundle
    workspaceHookPendingDismissStore.dismiss("sess-1", sampleAdmission.bundleDigest);
    const newAdmission = {
      pendingCount: 3,
      bundleDigest: "c".repeat(64),
      workspaceIdentity: "/workspace",
    };
    const html = renderBanner({ admission: newAdmission });
    expect(html).toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_BANNER + '"');
    expect(html).toContain("3");
  });

  it("点击忽略后立即隐藏，bundleDigest 变化后重新出现", () => {
    const view = renderInteractiveBanner();
    expect(screen.getByTestId(TID_V4_WORKSPACE_HOOK_PENDING_BANNER)).toBeTruthy();

    fireEvent.click(screen.getByTestId(TID_V4_WORKSPACE_HOOK_PENDING_DISMISS));
    expect(screen.queryByTestId(TID_V4_WORKSPACE_HOOK_PENDING_BANNER)).toBeNull();

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkspaceHookPendingBanner, {
          sessionId: "sess-1",
          workspacePath: "/workspace",
          admission: { ...sampleAdmission, bundleDigest: "c".repeat(64) },
        }),
      ),
    );
    expect(screen.getByTestId(TID_V4_WORKSPACE_HOOK_PENDING_BANNER)).toBeTruthy();
  });

  it("requestWorkspaceHookReview reject 时通过 UI logger 记录 warn", async () => {
    sendWorkspaceHookCommandMock.mockRejectedValueOnce(new Error("request rejected"));
    renderInteractiveBanner();

    fireEvent.click(screen.getByTestId(TID_V4_WORKSPACE_HOOK_PENDING_REVIEW));

    await waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "[workspace-hook-pending] requestWorkspaceHookReview 发送失败",
        expect.objectContaining({
          bundleDigest: sampleAdmission.bundleDigest,
          sessionId: "sess-1",
        }),
      );
    });
  });

  it("[去审核] 按钮存在且 [忽略] 按钮存在", () => {
    const html = renderBanner({ admission: sampleAdmission });
    expect(html).toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_REVIEW + '"');
    expect(html).toContain('data-testid="' + TID_V4_WORKSPACE_HOOK_PENDING_DISMISS + '"');
  });

  it("i18n key zh/en 双侧存在（缺 key 会把原始 id 渲染到界面）", () => {
    const keys = [
      "chat.workspaceHookPending.message",
      "chat.workspaceHookPending.review",
      "chat.workspaceHookPending.dismiss",
    ];
    for (const key of keys) {
      expect(zhCN[key], `zh-CN 缺 ${key}`).toBeTruthy();
      expect(enUS[key], `en-US 缺 ${key}`).toBeTruthy();
    }
  });

  it("zh-CN 文案包含 count 参数占位", () => {
    expect(zhCN["chat.workspaceHookPending.message"]).toContain("{count}");
  });

  it("en-US 文案包含 count 参数占位", () => {
    expect(enUS["chat.workspaceHookPending.message"]).toContain("{count}");
  });
});
