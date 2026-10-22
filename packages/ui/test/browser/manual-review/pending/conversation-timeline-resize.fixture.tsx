import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const userRows: UserInputRow[] = Array.from({ length: 35 }, (_, index) => ({
  rowId: query.get("heavy") === "true" ? index * 200 + 1 : index + 1,
  turnId: `turn-${index + 1}`,
  createdAt: 1_700_000_000_000 + index,
  createdAtSeq: index + 1,
  kind: "userInput",
  origin: "realUser",
  text: `E2E_SRM10_${index + 1} ${"宽度变化时文字会重新换行，阅读历史不应被测高夺回滚动权。 Resize must preserve user scroll ownership. ".repeat(2)}`,
  attachments: [],
}));
// 侧栏 resize 的慢 trace 包含后台结果轮；该轮直接展示工具摘要，不能只用文本行回归。
const initialRows: ConversationRow[] = userRows.flatMap((row, index): ConversationRow[] => {
  if (query.get("heavy") !== "true" || index !== 20) return [row];
  return [
    {
      rowId: row.rowId,
      turnId: row.turnId,
      createdAt: row.createdAt,
      createdAtSeq: row.createdAtSeq,
      kind: "turnHeader",
      origin: "backgroundResult",
      state: "completedSuccess",
      startedAt: row.createdAt,
      endedAt: row.createdAt + 1000,
    },
    ...Array.from(
      { length: 134 },
      (_, toolIndex): ConversationRow => ({
        rowId: row.rowId + toolIndex + 1,
        turnId: row.turnId,
        createdAt: row.createdAt,
        createdAtSeq: row.createdAtSeq,
        kind: "toolCall",
        toolCallId: `resize-tool-${toolIndex}`,
        toolName: "FixtureTool",
        status: "success",
        inputText: '{"query":"fixture"}',
        input: { query: "fixture" },
      }),
    ),
  ];
});

function Fixture() {
  const [session, setSession] = useState("a");
  const [rows, setRows] = useState(initialRows);
  const back = useRef<(() => void) | null>(null);
  const locate = useRef<((target: { unitIndex: number; rowId: number }) => void) | null>(null);
  return (
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale={query.get("mobile") === "true" ? "en-US" : "zh-CN"}>
        <div className="flex h-dvh min-w-0 flex-col bg-background text-foreground">
          <nav className="flex shrink-0 gap-2 text-ui-caption">
            <button onClick={() => setSession((value) => (value === "a" ? "b" : "a"))}>
              Switch
            </button>
            <button onClick={() => back.current?.()}>Bottom</button>
            <button onClick={() => locate.current?.({ unitIndex: 0, rowId: 1 })}>Locate</button>
            {query.get("heavy") === "true" && (
              <button onClick={() => locate.current?.({ unitIndex: 19, rowId: 3801 })}>
                Tools
              </button>
            )}
            <button
              onClick={() =>
                setRows((value) =>
                  value.map((row, index) =>
                    index === value.length - 1 && row.kind === "userInput"
                      ? {
                          ...row,
                          text: row.text + " 新增内容 asynchronous content growth. ".repeat(20),
                        }
                      : row,
                  ),
                )
              }
            >
              Grow
            </button>
            <output data-testid="scope">{session}</output>
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1">
            <ConversationTimeline
              rows={rows}
              totalCount={rows.length}
              sessionKey={session}
              scrollMemoryKey={`fixture::main::${session}`}
              compactForRemoteControl={query.get("mobile") === "true"}
              scrollToBottomActionRef={back}
              scrollToQueryActionRef={locate}
              rowContext={{
                codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
                sessionId: session,
                theme,
                workspacePath: "/fixture",
              }}
              bottomDock={
                <div className="h-16 bg-background" data-testid="fixture-composer">
                  Composer
                </div>
              }
            />
          </div>
        </div>
      </ZCodeIntlProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
