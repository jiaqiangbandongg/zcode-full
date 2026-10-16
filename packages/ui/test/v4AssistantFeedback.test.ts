import type { IPlatformService } from "@zcode/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationAssistantTextActions } from "@/v4/ConversationRowView.js";

const actionCapture = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
const reportAppTelemetryEvent = vi.hoisted(() => vi.fn());

vi.mock("@/components/ai-elements/message.js", async () => {
  const React = await import("react");
  return {
    MessageAction: (props: Record<string, unknown>) => {
      actionCapture.props.push(props);
      return React.createElement("button", { type: "button" }, props.children);
    },
    MessageActions: (props: Record<string, unknown>) =>
      React.createElement("div", null, props.children),
    MessageResponse: (props: Record<string, unknown>) =>
      React.createElement("div", null, props.children),
  };
});

vi.mock("@/lib/appTelemetry.js", () => ({ reportAppTelemetryEvent }));

const platform = {
  reportTelemetryEvent: vi.fn(async () => undefined),
} as unknown as IPlatformService;

function renderActions(params: {
  feedback?: "like" | "dislike" | null;
  onFeedbackChange?: React.ComponentProps<
    typeof ConversationAssistantTextActions
  >["onFeedbackChange"];
}) {
  renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform },
        createElement(ConversationAssistantTextActions, {
          rowId: 9,
          entityId: "assistant-entity-9",
          text: "answer",
          createdAt: 1,
          sessionId: "session-1",
          feedback: params.feedback,
          onFeedbackChange: params.onFeedbackChange,
        }),
      ),
    ),
  );
}

function feedbackAction(testId: string): Record<string, unknown> {
  const action = actionCapture.props.find(
    (props) => props["data-testid"] === testId,
  );
  if (!action) throw new Error(`missing feedback action ${testId}`);
  return action;
}

describe("V4 assistant feedback", () => {
  beforeEach(() => {
    actionCapture.props = [];
    reportAppTelemetryEvent.mockClear();
  });

  it("点赞立即提交 CAS 回调并上报旧版 reaction/talk/message payload", async () => {
    const onFeedbackChange = vi.fn(async () => true);
    renderActions({ onFeedbackChange });

    (feedbackAction("v4-feedback-like-9").onClick as () => void)();
    await Promise.resolve();

    expect(onFeedbackChange).toHaveBeenCalledWith(
      { rowId: 9, entityId: "assistant-entity-9" },
      "like",
    );
    expect(reportAppTelemetryEvent).toHaveBeenCalledWith(
      platform,
      {
        elementName: "assistant_message_feedback",
        eventRegion: "chat",
        eventType: "ck",
        eventExtraDetail: { reaction: "like" },
        talkId: "session-1",
        messageId: "assistant-entity-9",
      },
      "ConversationRowView",
    );
  });

  it("再次点击已选 reaction 写 null 并上报 none", async () => {
    const onFeedbackChange = vi.fn(async () => true);
    renderActions({ feedback: "like", onFeedbackChange });

    (feedbackAction("v4-feedback-like-9").onClick as () => void)();
    await Promise.resolve();

    expect(onFeedbackChange).toHaveBeenCalledWith(
      { rowId: 9, entityId: "assistant-entity-9" },
      null,
    );
    expect(reportAppTelemetryEvent.mock.calls[0]?.[1]).toMatchObject({
      eventExtraDetail: { reaction: "none" },
      talkId: "session-1",
      messageId: "assistant-entity-9",
    });
  });

  it("旧 row 缺少 entityId 时不展示反馈按钮，禁止用 rowId 代替 messageId", () => {
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          PlatformProvider,
          { platform },
          createElement(ConversationAssistantTextActions, {
            rowId: 9,
            text: "answer",
            createdAt: 1,
            sessionId: "session-1",
          }),
        ),
      ),
    );
    expect(
      actionCapture.props.some((props) =>
        String(props["data-testid"] ?? "").startsWith("v4-feedback-"),
      ),
    ).toBe(false);
    expect(reportAppTelemetryEvent).not.toHaveBeenCalled();
  });

  it("只读视图未提供 command handler 时不展示伪反馈入口", () => {
    renderActions({ feedback: "like" });
    expect(
      actionCapture.props.some((props) =>
        String(props["data-testid"] ?? "").startsWith("v4-feedback-"),
      ),
    ).toBe(false);
    expect(reportAppTelemetryEvent).not.toHaveBeenCalled();
  });
});
