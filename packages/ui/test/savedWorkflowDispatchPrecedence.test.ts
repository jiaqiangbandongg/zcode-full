// @vitest-environment jsdom
//
// 分流优先级的 tripwire（team-lead 裁定 (b)）。
//
// 这个文件把 `resolveToolCallIdentity` 桩成「SaveWorkflow / ListSavedWorkflows 属于
// workflow family」——也就是**将来有人把这两个名字登记进 packages/shared 的
// tool-identity.ts 之后的世界**。断言的是一条性质而不是一次现状：
// **按工具名的判定必须赢过按 family 的判定。**
//
// 为什么这是 tripwire 而不是普通用例：workflow family 的兜底分支在两处都指向
// CreateWorkflow——`resolveRenderer.ts` 的 `identity.toolName === "submit_result"` 三元，
// 和 `PermissionDialog.tsx` 的 `blockKind === "workflow"`。一旦登记了名字却没有同时扩展
// family 分派，SaveWorkflow 会**静默**渲染成「创建工作流」：保存确认窗会长出因果图和
// Refine 选项（对一次写盘完全是错的语言），聊天区会把一次保存画成一次运行。
//
// 如果你正是那个在 tool-identity.ts 里加上这两个名字的人：本文件应当仍然全绿。
// 它红了，说明 family 分派把专用面吞掉了，去看 resolveRenderer.ts 与
// resolvePermissionBlockKind 里按名字判定的那两段注释。

import { cleanup, render, screen } from "@testing-library/react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 只改 family 判定，其余行为保持真实实现。
vi.mock("@/lib/toolIdentity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/toolIdentity.js")>();
  return {
    ...actual,
    resolveToolCallIdentity: (toolCall: { toolName?: string | null; kind?: string | null }) => {
      const name = toolCall.toolName ?? toolCall.kind ?? "";
      if (name === "SaveWorkflow" || name === "ListSavedWorkflows") {
        // 假想中的登记结果：两个名字都落进 workflow family。
        return { toolName: name, family: "workflow", source: "toolName", isLegacy: false };
      }
      return actual.resolveToolCallIdentity(toolCall);
    },
  };
});

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));

vi.mock("@/components/workflow-graph/workflow-causality-graph.js", () => ({
  WorkflowCausalityGraph: () => createElement("div", { "data-testid": "workflow-causality-graph" }),
}));

vi.mock("@/components/workflow-graph/workflow-graph-preview-dialog.js", () => ({
  WorkflowGraphPreviewDialog: () => null,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

/* eslint-disable import/first -- 必须在 mock 之后再引入被测模块。 */
import { PermissionDialog } from "@/PermissionDialog.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
import { ListSavedWorkflowsToolCallBlock } from "@/ToolCallBlocks/renderers/list-saved-workflows.js";
import { SaveWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/save-workflow.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
/* eslint-enable import/first */

const SCRIPT = 'const r = await agent("a").ask<string>("检查");';

function buildContext(toolCall: Record<string, unknown>): ToolCallBlockRenderContext {
  return {
    toolCallNode: { toolCall, childToolCalls: [] },
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "",
    childToolList: null,
    showIcon: true,
    forceOpen: true,
    canToggle: false,
  } as ToolCallBlockRenderContext;
}

afterEach(cleanup);

describe("saved-workflow dispatch precedence over tool family", () => {
  it("confirms the premise: identity now reports the workflow family", () => {
    // 前提断言——桩失效时下面几条会变成假绿，这里先把假想世界钉死。
    expect(resolveToolCallIdentity({ toolName: "SaveWorkflow" }).family).toBe("workflow");
    expect(resolveToolCallIdentity({ toolName: "ListSavedWorkflows" }).family).toBe("workflow");
  });

  it("keeps SaveWorkflow on its own card, not the CreateWorkflow card", () => {
    const renderer = resolveToolCallRenderer(
      buildContext({
        toolId: "tool-save-1",
        toolName: "SaveWorkflow",
        kind: "SaveWorkflow",
        status: "completed",
        input: { name: "release-check", script: SCRIPT, overwrite: false },
      }),
    );

    expect(renderer).toBe(SaveWorkflowToolCallBlock);
    expect(renderer).not.toBe(CreateWorkflowToolCallBlock);
  });

  it("keeps ListSavedWorkflows on its own card, not the CreateWorkflow card", () => {
    const renderer = resolveToolCallRenderer(
      buildContext({
        toolId: "tool-list-1",
        toolName: "ListSavedWorkflows",
        kind: "ListSavedWorkflows",
        status: "completed",
        input: {},
        output: { workflows: [], invalid: [] },
      }),
    );

    expect(renderer).toBe(ListSavedWorkflowsToolCallBlock);
    expect(renderer).not.toBe(CreateWorkflowToolCallBlock);
  });

  it("still routes CreateWorkflow itself to the CreateWorkflow card", () => {
    const renderer = resolveToolCallRenderer(
      buildContext({
        toolId: "tool-create-1",
        toolName: "CreateWorkflow",
        kind: "CreateWorkflow",
        status: "completed",
        input: { script: SCRIPT },
      }),
    );

    expect(renderer).toBe(CreateWorkflowToolCallBlock);
  });

  it("keeps the SaveWorkflow gate on the save block, not the run-confirmation block", () => {
    const request = {
      type: "permission_request",
      taskId: "task-1",
      traceId: "trace-1",
      requestId: "perm-save",
      description: "saveWorkflow.confirmation",
      kind: "SaveWorkflow",
      title: "SaveWorkflow",
      options: [
        {
          optionId: "allowOnce",
          kind: "allowOnce",
          name: "Allow",
          response: { decision: "allow" },
        },
        { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
      ],
      raw: {
        name: "release-check",
        description: "发布前检查",
        script: SCRIPT,
        path: "/workspace/.zcode/workflows/release-check.dwf.ts",
        overwrite: false,
        scope: "project",
      },
    } as ZCodePermissionRequest;

    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PermissionDialog, {
          request,
          onRespond: () => {},
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(document.querySelector('[data-save-workflow-permission-block="true"]')).toBeTruthy();
    // 运行确认窗的语言绝不能出现在一次写盘上：没有图，也没有「运行此工作流？」。
    expect(document.querySelector('[data-workflow-permission-block="true"]')).toBeNull();
    expect(screen.queryByTestId("workflow-causality-graph")).toBeNull();
    expect(document.body.textContent).not.toContain("Run this workflow?");
    expect(screen.getByText("Save this workflow to the project?")).toBeTruthy();
  });
});
