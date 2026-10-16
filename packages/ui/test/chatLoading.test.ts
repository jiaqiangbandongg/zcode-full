import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActiveWorkSummary, PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { ChatLoading } from "@/components/ai-elements/chat-loading.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  hasChatLoadingBlockingActiveWork,
  hasChatLoadingBlockingInteraction,
} from "@/v4/chatLoadingVisibility.js";

function renderChatLoading() {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ChatLoading, { loading: true }),
    ),
  );
}

describe("ChatLoading", () => {
  it("只展示旋转 loading 图标，不渲染可见文案", () => {
    const html = renderChatLoading();

    expect(html).toContain("animate-spin");
    expect(html).toContain('data-zcode-chat-loading-animate="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).not.toContain('data-testid="chat-loading-text"');
    expect(html).not.toContain("正在思考");
  });

  it.each([
    [
      "permission",
      {
        interactionId: "permission-1",
        kind: "permission",
        anchorRowId: 1,
        createdAt: 1,
        payload: {
          kind: "permission",
          toolCallId: "tool-1",
          toolName: "Bash",
          summary: "需要确认",
          detail: {},
          options: [],
        },
      },
    ],
    [
      "AskUserQuestion",
      {
        interactionId: "ask-1",
        kind: "userInput",
        anchorRowId: 2,
        createdAt: 2,
        payload: {
          kind: "userInput",
          prompt: "请选择",
          freeText: false,
          toolName: "AskUserQuestion",
          toolCallId: "tool-2",
        },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, PendingInteraction]>)(
    "%s pending interaction blocks ChatLoading",
    (_label, interaction) => {
      expect(hasChatLoadingBlockingInteraction([interaction])).toBe(true);
    },
  );

  // 软门禁（workspace-hook-trust-soft-gate.md D4）下 workspaceHookReview 不再阻塞
  // 聊天 loading——审核改为非阻塞的常驻提示条，用户可继续对话。
  it("does not treat workspaceHookReview as a ChatLoading blocker (soft gate)", () => {
    const interaction = {
      interactionId: "workspace-review-1",
      kind: "workspaceHookReview",
      anchorRowId: null,
      createdAt: 4,
      payload: { kind: "workspaceHookReview" },
    } as unknown as PendingInteraction;

    expect(hasChatLoadingBlockingInteraction([interaction])).toBe(false);
  });

  it("does not treat other userInput interactions as ChatLoading blockers", () => {
    const interaction: PendingInteraction = {
      interactionId: "plan-1",
      kind: "userInput",
      anchorRowId: 3,
      createdAt: 3,
      payload: {
        kind: "userInput",
        prompt: "批准计划",
        freeText: true,
        toolName: "ExitPlanMode",
        toolCallId: "tool-3",
      },
    };

    expect(hasChatLoadingBlockingInteraction([interaction])).toBe(false);
  });

  it.each([
    ["compact", true],
    ["goalVerifier", true],
    ["primaryTurn", false],
    ["foregroundSubagent", false],
    ["goalContinuation", false],
    ["turnSteer", false],
  ] satisfies ReadonlyArray<readonly [ActiveWorkSummary["kind"], boolean]>)(
    "%s active work blocker = %s",
    (kind, expected) => {
      expect(hasChatLoadingBlockingActiveWork([{ kind, startedAt: 1 }])).toBe(expected);
    },
  );
});
