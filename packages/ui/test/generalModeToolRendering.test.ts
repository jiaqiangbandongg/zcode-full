import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { ExecuteGroupToolCallBlock } from "@/ToolCallBlocks/renderers/execute-group.js";
import { EditToolCallBlock } from "@/ToolCallBlocks/renderers/edit.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";

function context(general: boolean, failed = false): ToolCallBlockRenderContext {
  return {
    isOfficeMode: general,
    toolCallNode: {
      toolCall: {
        toolId: "mode-execute",
        kind: "execute",
        title: "MODE_PRIVATE_COMMAND",
        input: { command: "echo MODE_PRIVATE_COMMAND" },
        output: { stdout: "MODE_PRIVATE_OUTPUT", exitCode: failed ? 1 : 0 },
        status: failed ? "failed" : "completed",
      },
      childToolCalls: [],
    },
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: true,
      showInput: false,
      showOutput: true,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: failed ? "失败" : "已完成",
    errorText: failed ? "MODE_PRIVATE_ERROR" : undefined,
    childToolList: null,
    forceOpen: true,
    canToggle: true,
  };
}

function renderTool(component: typeof ExecuteToolCallBlock, props: ToolCallBlockRenderContext) {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, createElement(component, props)),
  );
}

describe("通用模式工具展示", () => {
  it.each([false, true])("执行详情隐藏但终态保留（failed=%s）", (failed) => {
    const props = context(true, failed);
    const original = JSON.stringify(props.toolCallNode);
    const general = renderTool(ExecuteToolCallBlock, props);
    expect(general).not.toContain("MODE_PRIVATE_COMMAND");
    expect(general).not.toContain("MODE_PRIVATE_OUTPUT");
    expect(general).not.toContain("MODE_PRIVATE_ERROR");
    expect(general).toContain(failed ? "失败" : "已运行命令");
    expect(general).not.toContain('aria-expanded="true"');
    const coding = renderTool(ExecuteToolCallBlock, { ...props, isOfficeMode: false });
    expect(coding).toContain("MODE_PRIVATE_COMMAND");
    expect(coding).toContain(failed ? "MODE_PRIVATE_ERROR" : "MODE_PRIVATE_OUTPUT");
    expect(JSON.stringify(props.toolCallNode)).toBe(original);
  });

  it("编辑保留文件入口但不渲染 Diff 正文", () => {
    const props = context(true);
    props.toolCallNode.toolCall.kind = "edit";
    props.rawFileSummaries = [
      {
        path: "/workspace/demo.py",
        filePath: "/workspace/",
        fileName: "demo.py",
        fileIconSrc: "/python.svg",
        actionLabel: "Edited",
        operationKind: "update",
        changeStat: { added: 1, removed: 1 },
        patch: "--- a/demo.py\n+++ b/demo.py\n@@ -1 +1 @@\n-old_value\n+MODE_NEW_VALUE",
      },
    ];
    props.onOpenCodeViewer = () => {};
    const html = renderTool(EditToolCallBlock, props);
    expect(html).toContain("demo.py");
    expect(html).not.toContain("MODE_NEW_VALUE");
    expect(html).not.toContain('aria-expanded="true"');
    expect(props.rawFileSummaries[0]?.patch).toContain("MODE_NEW_VALUE");
  });
});

it("运行中的执行组只展示状态，不泄露子命令或强制展开详情", () => {
  const props = context(true);
  props.isRunning = true;
  props.toolCallNode.childToolCalls = [
    {
      ...context(true).toolCallNode,
      toolCall: { ...context(true).toolCallNode.toolCall, status: "in_progress" },
    },
  ];
  const general = renderTool(ExecuteGroupToolCallBlock, props);
  expect(general).not.toContain("MODE_PRIVATE_COMMAND");
  expect(general).not.toContain("MODE_PRIVATE_OUTPUT");
  expect(general).not.toContain('aria-expanded="true"');
});
