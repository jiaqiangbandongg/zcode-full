// @vitest-environment jsdom
// 灰度未命中时不留任何一条起引擎的路（docs/dynamic-workflow/launch.md「Gray release」DWG-07）。
//
// 供给点只有一个：SessionPane 把 Resume 回调放进会话上下文。工具卡页脚与轮尾摘要卡都以
// 「回调在不在场」作为按钮门控，所以这里按真实的门（resolveWorkflowResumeHandler）算出回调，
// 再把两处真的渲染出来看按钮在不在——而不是各自复述一遍规则。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resolveWorkflowResumeHandler } from "@/v4/workflowResumeGate.js";

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlockHeader: () => null,
  CodeBlock: ({ code }: { code: string; children?: ReactNode }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));
// ControlHintTooltip 依赖应用根部的 TooltipProvider；测试里按既有惯例替换为透传桩。
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

// eslint-disable-next-line import/first -- 必须在上面的 mock 之后再引入被测组件。
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
// eslint-disable-next-line import/first -- 同上。
import {
  WorkflowRunDigest,
  type WorkflowRunDigestProps,
} from "@/components/workflow-timeline/WorkflowRunDigest.js";

const sessionPaneSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/v4/SessionPane.tsx"),
  "utf8",
).replaceAll("\r\n", "\n");

/** 会话上下文里那个回调：由真实的门算出来，`undefined` 就是「这条路没有了」。 */
function resumeHandlerFor(dynamicWorkflowEnabled: boolean) {
  return resolveWorkflowResumeHandler({
    readOnly: false,
    dynamicWorkflowEnabled,
    handler: vi.fn(),
  });
}

const GRAPH = {
  steps: [{ id: "ask#1", kind: "ask", label: "plan", line: 2, column: 21, lane: "actor#1" }],
  lanes: [{ id: "actor#1", name: "planner", line: 1, column: 11 }],
  participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
} as const;

/** 停下且可恢复：这是三处 Resume 都会出现的那一种 run。 */
function stoppedResumableRun(): WorkflowRunState {
  return {
    runId: "dwfrun-42",
    toolCallId: "tool-create-workflow",
    status: "stopped",
    stopReason: "interrupted",
    usage: { spentTokens: 1_234, nodesUsed: 1 },
    actors: [],
    nodes: [],
    lastEventSequence: 7,
  } as unknown as WorkflowRunState;
}

function resumableSummary(): WorkflowRunCardSummary {
  const run = stoppedResumableRun();
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    status: run.status,
    nodesSettled: 0,
    nodesTotal: 1,
    resumable: true,
    run,
  } as WorkflowRunCardSummary;
}

function renderCard(
  onResumeWorkflowRun: ((request: { workflowName?: string }) => void) | undefined,
) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(CreateWorkflowToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-create-workflow",
            kind: "CreateWorkflow",
            title: "CreateWorkflow",
            output: "",
            status: "completed",
          },
          childToolCalls: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试上下文只填 renderer 读取的字段。
        } as any,
        workspacePath: "/workspace",
        displayModel: {
          inlinePreview: { type: "none" },
          planResult: null,
          viewerSource: null,
          viewerLabelId: "codeViewer.viewCode",
          showSummaryFileLink: false,
          showInput: false,
          showOutput: true,
          showKind: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上。
        } as any,
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: "已停止",
        childToolList: null,
        forceOpen: true,
        canToggle: true,
        showIcon: true,
        onResumeWorkflowRun,
        workflowRun: resumableSummary(),
      }),
    ),
  );
}

function renderDigest(onResume: (() => void) | undefined) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkflowRunDigest, {
        graph: GRAPH as unknown as WorkflowRunDigestProps["graph"],
        name: "implement-verify",
        runId: "dwfrun-42",
        testIdKey: "t",
        summary: resumableSummary(),
        ...(onResume === undefined ? {} : { onResume }),
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("resolveWorkflowResumeHandler", () => {
  it("灰度命中且可写 → 回调照常供给", () => {
    const handler = vi.fn();
    expect(
      resolveWorkflowResumeHandler({ readOnly: false, dynamicWorkflowEnabled: true, handler }),
    ).toBe(handler);
    // readOnly 缺省（undefined）等同于可写。
    expect(
      resolveWorkflowResumeHandler({ readOnly: undefined, dynamicWorkflowEnabled: true, handler }),
    ).toBe(handler);
  });

  it("灰度未命中 → 不供给；只读会话照旧不供给；两者都成立时也不供给", () => {
    const handler = vi.fn();
    expect(
      resolveWorkflowResumeHandler({ readOnly: false, dynamicWorkflowEnabled: false, handler }),
    ).toBeUndefined();
    expect(
      resolveWorkflowResumeHandler({ readOnly: true, dynamicWorkflowEnabled: true, handler }),
    ).toBeUndefined();
    expect(
      resolveWorkflowResumeHandler({ readOnly: true, dynamicWorkflowEnabled: false, handler }),
    ).toBeUndefined();
  });
});

describe("灰度关掉后工具卡页脚与摘要卡的 Resume", () => {
  it("工具卡页脚：灰度关 → 没有 Resume；灰度开 → 有", () => {
    expect(renderCard(resumeHandlerFor(false))).not.toContain("workflow-card-resume");
    expect(renderCard(resumeHandlerFor(true))).toContain("workflow-card-resume");
  });

  it("轮尾摘要卡：灰度关 → 没有 Resume；灰度开 → 有", () => {
    expect(
      renderDigest(resumeHandlerFor(false)).queryByTestId("workflow-digest-resume"),
    ).toBeNull();
    cleanup();
    expect(
      renderDigest(resumeHandlerFor(true)).queryByTestId("workflow-digest-resume"),
    ).not.toBeNull();
  });

  it("灰度关只收走 Resume：卡与摘要本身照常渲染", () => {
    // 「已有的 run 照常渲染」——种类词、状态这些都还在，只是按不动。
    expect(renderCard(resumeHandlerFor(false))).toContain("workflow-card-kind");
    expect(
      renderDigest(resumeHandlerFor(false)).queryByTestId("workflow-card-kind"),
    ).not.toBeNull();
  });
});

describe("SessionPane 供给点接线", () => {
  it("Resume 回调只经 resolveWorkflowResumeHandler 进上下文，灰度从 hook 读", () => {
    expect(sessionPaneSource).toContain("useDynamicWorkflowAvailability");
    expect(sessionPaneSource).toMatch(
      /onResumeWorkflowRun: resolveWorkflowResumeHandler\(\{\s*readOnly,\s*dynamicWorkflowEnabled,\s*handler: handleResumeWorkflowRun,\s*\}\)/,
    );
    // 旧的裸三元不能再存在，否则灰度就被绕过去了。
    expect(sessionPaneSource).not.toContain(
      "onResumeWorkflowRun: readOnly ? undefined : handleResumeWorkflowRun",
    );
  });
});
