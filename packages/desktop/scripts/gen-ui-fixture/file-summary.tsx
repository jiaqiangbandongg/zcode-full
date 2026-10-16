import { useMemo } from "react";
import type { AssistantTextRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";

export function FileSummaryFixture({
  path,
  root,
  mode,
  compact,
}: {
  path: string;
  root: string;
  mode: "only" | "mixed" | "ordinary";
  compact: boolean;
}) {
  const row = useMemo<AssistantTextRow>(
    () => ({
      rowId: 2,
      entityId: "summary-text",
      turnId: "summary-turn",
      createdAt: 2,
      createdAtSeq: 2,
      kind: "assistantText",
      state: "complete",
      text:
        mode === "ordinary"
          ? `${root}/demo.html`
          : `::visualize${JSON.stringify({ path })}\n[可视化](${path})${mode === "mixed" ? `\n${root}/demo.html` : ""}`,
    }),
    [mode, path, root],
  );
  const rows = useMemo(() => [row], [row]);
  const context = useMemo(
    () => ({
      workspacePath: root,
      workspaceIdentity: "ssh:fixture:/workspace",
      workspaceRemoteSessionId: "remote-1",
      theme: "system" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      compactForRemoteControl: compact,
      fetchFileChanges: async () => ({
        items: [
          ...(mode !== "ordinary" ? [{ path, additions: 70, deletions: 1, patches: [] }] : []),
          ...(mode !== "only"
            ? [{ path: `${root}/demo.html`, additions: 7, deletions: 2, patches: [] }]
            : []),
        ],
      }),
    }),
    [compact, mode, path, root],
  );
  const header: TurnHeaderRow = {
    rowId: 1,
    entityId: "summary-header",
    turnId: "summary-turn",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
    fileChanges: {
      files: mode === "mixed" ? 2 : 1,
      additions: mode === "ordinary" ? 7 : mode === "mixed" ? 77 : 70,
      deletions: mode === "ordinary" ? 2 : mode === "mixed" ? 3 : 1,
      state: "active",
    },
  };
  const cards = useAssistantPreviewCardsForAssistantTextRow({
    row,
    assistantTextRows: rows,
    latestAssistantTextRow: row,
    ...context,
    fileChangesTarget: { rowId: 1, entityId: "summary-header" },
    fileChangesState: "active",
  });
  return (
    <div id="file-summary-fixture">
      <div id="file-preview-cards">
        <AssistantPreviewCards cards={cards} {...context} />
      </div>
      <div id="file-summary-panel">
        <ConversationFileSummaryPanel header={header} context={context} assistantText={row.text} />
      </div>
    </div>
  );
}
