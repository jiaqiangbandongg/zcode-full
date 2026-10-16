import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const { rowViewProps } = vi.hoisted(() => ({
  rowViewProps: [] as Array<{
    row: ConversationRow;
    onRetry?: (rowId: number) => void;
    onEdit?: (
      rowId: number,
      newText: string,
      attachments?: readonly unknown[],
    ) => Promise<boolean | void> | boolean | void;
  }>,
}));

vi.mock("@/v4/ConversationRowView.js", async () => {
  const React = await import("react");
  return {
    ConversationAssistantTextActions: () =>
      React.createElement("div", {
        "data-testid": "mock-assistant-actions",
      }),
    readAssistantFeedback: () => null,
    ConversationRowView: (props: (typeof rowViewProps)[number]) => {
      rowViewProps.push(props);
      return React.createElement("div", {
        "data-testid": `row-${props.row.rowId}`,
      });
    },
  };
});

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspaceIdentity: "workspace-identity",
  workspacePath: "/workspace",
};

function userInputRow(
  rowId: number,
  turnId: string,
  origin: UserInputRow["origin"] = "realUser",
  canEdit = false,
): UserInputRow {
  return {
    rowId,
    turnId,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    origin,
    text: `question ${rowId}`,
    actions: { canEdit },
  };
}

function turnHeaderRow(rowId: number, turnId: string): ConversationRow {
  return {
    rowId,
    turnId,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
    endedAt: 1_700_000_000_100 + rowId,
  };
}

function assistantTextRow(rowId: number, turnId: string, canRetry = false): ConversationRow {
  return {
    rowId,
    turnId,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    state: "complete",
    text: `answer ${rowId}`,
    actions: { canRetry },
  };
}

beforeEach(() => {
  rowViewProps.length = 0;
});

describe("authoritative conversation row actions", () => {
  it("passes onEdit only to the row authorized by the CLI projection", () => {
    const rows = [
      turnHeaderRow(1, "turn-1"),
      userInputRow(2, "turn-1"),
      assistantTextRow(3, "turn-1"),
      turnHeaderRow(4, "turn-2"),
      userInputRow(5, "turn-2", "realUser", true),
      assistantTextRow(6, "turn-2"),
    ];
    const units = buildConversationTurnRenderUnits(rows);
    const onEdit = vi.fn();

    for (const unit of units) {
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationTurnGroup, {
            unit,
            context,
            onEdit,
          }),
        ),
      );
    }

    const userRows = rowViewProps.filter(
      (props): props is (typeof rowViewProps)[number] & { row: UserInputRow } =>
        props.row.kind === "userInput",
    );
    expect(userRows.find((props) => props.row.rowId === 2)?.onEdit).toBeUndefined();
    expect(userRows.find((props) => props.row.rowId === 5)?.onEdit).toBe(onEdit);
  });

  it("passes onRetry only to the row authorized by the CLI projection", () => {
    const rows = [
      turnHeaderRow(1, "turn-1"),
      userInputRow(2, "turn-1"),
      assistantTextRow(3, "turn-1"),
      turnHeaderRow(4, "turn-2"),
      userInputRow(5, "turn-2"),
      assistantTextRow(6, "turn-2", true),
    ];
    const units = buildConversationTurnRenderUnits(rows);
    const onRetry = vi.fn();

    for (const unit of units) {
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationTurnGroup, {
            unit,
            context,
            onRetry,
          }),
        ),
      );
    }

    const assistantRows = rowViewProps.filter((props) => props.row.kind === "assistantText");
    expect(assistantRows.find((props) => props.row.rowId === 3)?.onRetry).toBeUndefined();
    expect(assistantRows.find((props) => props.row.rowId === 6)?.onRetry).toBe(onRetry);
  });
});
