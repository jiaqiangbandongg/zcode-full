import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { GoalToolCallBlock } from "../src/ToolCallBlocks/renderers/goal.js";

const displayModel = {
  inlinePreview: { type: "none" as const },
  planResult: null,
  viewerSource: null,
  viewerLabelId: "codeViewer.viewCode" as const,
  showSummaryFileLink: false,
  showInput: false,
  showOutput: true,
  showKind: false,
};

describe("GoalToolCallBlock", () => {
  it("renders only goal result details without parameters or raw tool payload", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(GoalToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "tool-goal-update",
              toolName: "GoalUpdate",
              kind: "GoalUpdate",
              title: "GoalUpdate",
              input: {
                completionEvidence: "测试已通过，文档已更新。",
                status: "complete",
              },
              output: JSON.stringify({
                goal: {
                  sessionID: "sess_1",
                  targetID: "target_1",
                  objective: "完成 goal UI",
                  summaryTitle: "完成 goal UI",
                  status: "complete",
                },
                verification: {
                  passed: true,
                  reason: "所有验收项都有证据。",
                },
              }),
              content: "模型额外返回的 content",
              status: "completed",
              raw: {
                result: {
                  content: "raw result content should be deduped",
                  display: {
                    summary: "raw display content",
                  },
                },
                parentToolUseId: null,
                rawDebug: "raw debug payload",
              },
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
          displayModel,
          viewerSource: null,
          rawFileSummaries: [],
          isRunning: false,
          statusLabel: "已执行",
          childToolList: null,
          forceOpen: true,
          canToggle: true,
          showIcon: true,
        }),
      ),
    );

    expect(html).toContain("GoalUpdate");
    expect(html).toContain("结果");
    expect(html).toContain("completed");
    expect(html).toContain("complete");
    expect(html).toContain("模型额外返回的 content");
    expect(html).toContain("所有验收项都有证据");
    expect(html).not.toContain("Parameters");
    expect(html).not.toContain("completionEvidence");
    expect(html).not.toContain("parentToolUseId");
    expect(html).not.toContain("raw debug payload");
  });
});
