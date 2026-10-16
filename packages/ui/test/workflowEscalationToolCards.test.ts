// escalate / ResolveWorkflowQuestion 专用工具卡（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。
//
// 文件名刻意是 `.test.ts` 而不是 `.test.tsx`：根 vitest 配置只收
// `packages/*/test/**/*.test.ts`（vitest.config.ts），`.test.tsx` 一个用例都不会被采集。
// 所以这里和 submitResultToolCallBlock.test.ts 一样用 createElement + renderToStaticMarkup，不写 JSX。
//
// 主会话与子代理侧板共用同一条 ToolCallBlocks 管线（侧板挂的是嵌套只读 SessionPane），所以
// 「从 ToolCallBlock 入口整链走下来就是专用卡」这一条同时钉住两个面。
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// CodeBlock 依赖 shiki / CodeViewer 根 provider，静态渲染跑不动；照 submit-result 的先例替换为
// 桩（本卡不用 CodeBlock，但整链入口可能间接触达，留桩最省心）。
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string; children?: ReactNode }) =>
    createElement("pre", { "data-testid": "code-block", "data-language": language }, code),
}));

// eslint-disable-next-line import/first -- 必须在 code-block mock 之后再引入被测 renderer。
import { EscalateToolCallBlock } from "../src/ToolCallBlocks/renderers/escalate.js";
// eslint-disable-next-line import/first -- 同上。
import { ResolveWorkflowQuestionToolCallBlock } from "../src/ToolCallBlocks/renderers/resolve-workflow-question.js";
// eslint-disable-next-line import/first -- 同上；路由断言要拿到 workflow family 的兜底 renderer。
import { CreateWorkflowToolCallBlock } from "../src/ToolCallBlocks/renderers/create-workflow.js";
// eslint-disable-next-line import/first -- 同上。
import { resolveToolCallRenderer } from "../src/ToolCallBlocks/resolveRenderer.js";
// eslint-disable-next-line import/first -- 同上；整链路由断言要走真实入口组件。
import { ToolCallBlock } from "@/ToolCallBlocks.js";
// eslint-disable-next-line import/first -- 同上；词条只用于双语存在性断言。
import enUS from "../src/i18n/locales/en-US.js";
// eslint-disable-next-line import/first -- 同上。
import zhCN from "../src/i18n/locales/zh-CN.js";

interface ToolCallOverrides {
  input?: unknown;
  output?: unknown;
  raw?: unknown;
  status?: string;
  toolName?: string;
  snapshotRefs?: readonly { field: string; previewBytes: number; fullBytes: number }[];
}

interface ContextOverrides {
  isRunning?: boolean;
  errorText?: string;
  forceOpen?: boolean;
  onLoadFullToolCallFields?: (toolId: string) => void;
}

function buildContext(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  defaultName = "escalate",
) {
  const name = toolCall.toolName ?? defaultName;
  return {
    toolCallNode: {
      toolCall: {
        toolId: "tool-escalation",
        toolName: name,
        kind: name,
        title: name,
        input: toolCall.input,
        output: toolCall.output,
        status: toolCall.status ?? "completed",
        raw: toolCall.raw ?? {},
        snapshotRefs: toolCall.snapshotRefs,
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
    isRunning: contextOverrides.isRunning ?? false,
    statusLabel: "已执行",
    errorText: contextOverrides.errorText,
    childToolList: null,
    showIcon: true,
    canToggle: true,
    forceOpen: contextOverrides.forceOpen ?? true,
    onLoadFullToolCallFields: contextOverrides.onLoadFullToolCallFields,
  };
}

function renderEscalate(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  locale: "en-US" | "zh-CN" = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(EscalateToolCallBlock, buildContext(toolCall, contextOverrides, "escalate")),
    ),
  );
}

function renderResolve(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  locale: "en-US" | "zh-CN" = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(
        ResolveWorkflowQuestionToolCallBlock,
        buildContext(toolCall, contextOverrides, "ResolveWorkflowQuestion"),
      ),
    ),
  );
}

describe("升级问答工具卡路由", () => {
  it("escalate 按名分流到专用卡，不误伤 CreateWorkflow", () => {
    expect(resolveToolCallRenderer(buildContext({}, {}, "escalate") as never)).toBe(
      EscalateToolCallBlock,
    );
    expect(resolveToolCallRenderer(buildContext({ toolName: "CreateWorkflow" }) as never)).toBe(
      CreateWorkflowToolCallBlock,
    );
  });

  it("ResolveWorkflowQuestion 按名分流，snake_case wire 写法也命中", () => {
    for (const toolName of ["ResolveWorkflowQuestion", "resolve_workflow_question"]) {
      expect(resolveToolCallRenderer(buildContext({ toolName }) as never)).toBe(
        ResolveWorkflowQuestionToolCallBlock,
      );
    }
  });

  it("从 ToolCallBlock 入口整链走下来就是专用卡，不再是 fallback 的裸 JSON dump", () => {
    const escalateHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "escalate-e2e",
              toolName: "escalate",
              kind: "escalate",
              title: "escalate",
              input: { question: "门坏了吗？" },
              output: "跳过它。",
              status: "completed",
              raw: {},
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );
    expect(escalateHtml).toContain("已询问主代理");
    expect(escalateHtml).not.toContain("&quot;toolId&quot;");

    const resolveHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "resolve-e2e",
              toolName: "ResolveWorkflowQuestion",
              kind: "ResolveWorkflowQuestion",
              title: "ResolveWorkflowQuestion",
              input: { question_id: "dwfq-run1-1", answer: "跳过它。" },
              output: "Answer delivered.",
              status: "completed",
              raw: {},
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );
    expect(resolveHtml).toContain("已回答问题");
    expect(resolveHtml).not.toContain("&quot;toolId&quot;");
  });
});

describe("EscalateToolCallBlock 相位文案", () => {
  it.each([
    { name: "in_progress", status: "in_progress", isRunning: true, expected: "正在询问主代理" },
    { name: "pending", status: "pending", isRunning: true, expected: "正在询问主代理" },
    { name: "completed", status: "completed", isRunning: false, expected: "已询问主代理" },
  ])("$name 相写「$expected」", ({ status, isRunning, expected }) => {
    const html = renderEscalate({ input: { question: "门坏了吗？" }, status }, { isRunning });
    expect(html).toContain(expected);
  });

  it("en-US 下相位文案同样本地化", () => {
    const asking = renderEscalate(
      { input: { question: "Is the gate broken?" }, status: "in_progress" },
      { isRunning: true },
      "en-US",
    );
    expect(asking).toContain("Asking the main agent");

    const asked = renderEscalate(
      { input: { question: "Is the gate broken?" }, output: "Yes, skip it." },
      {},
      "en-US",
    );
    expect(asked).toContain("Asked the main agent");
    expect(asked).not.toContain("正在询问主代理");
  });
});

describe("EscalateToolCallBlock body 分支", () => {
  it("问题 + 背景 + 答案三段齐备", () => {
    const html = renderEscalate({
      input: { question: "门坏了吗？", context: "阈值 96，实际封顶 95。" },
      output: "对，跳过它，用旁路。",
    });
    expect(html).toContain("门坏了吗？");
    expect(html).toContain("阈值 96，实际封顶 95。");
    expect(html).toContain("对，跳过它，用旁路。");
    // 三个小标题都在场。
    expect(html).toContain("问题");
    expect(html).toContain("背景");
    expect(html).toContain("答复");
  });

  it("停驻中（running）只有问题、没有答案区，卡不显失败", () => {
    const html = renderEscalate(
      { input: { question: "门坏了吗？" }, status: "in_progress" },
      { isRunning: true },
    );
    expect(html).toContain("门坏了吗？");
    expect(html).toContain("正在询问主代理");
    // 答案小标题不该出现；停驻不是失败。
    expect(html).not.toContain("执行失败");
    expect(html).not.toContain("text-destructive");
  });

  it("预算已尽的驳回是普通结果——照常渲染成答案，绝不当失败", () => {
    // handler 的 formatModelContent 只返回 message；预算已尽的文案走的是普通 output（status
    // 仍是 completed），卡片绝不因文本内容把它样式成 error。
    const refusal =
      "You have used all 3 escalations for this ask. Proceed on your own best judgement.";
    const html = renderEscalate({ input: { question: "还能再问吗？" }, output: refusal });
    expect(html).toContain(refusal);
    expect(html).not.toContain("执行失败");
    expect(html).not.toContain("border-destructive");
  });

  it("首帧 input 还是空对象时不提供展开入口，也不渲染空面板", () => {
    const html = renderEscalate(
      { input: {}, status: "pending" },
      { isRunning: true, forceOpen: true },
    );
    expect(html).toContain("正在询问主代理");
    expect(html).not.toContain('role="button"');
  });
});

describe("ResolveWorkflowQuestionToolCallBlock 相位文案", () => {
  it.each([
    { name: "in_progress", status: "in_progress", isRunning: true, expected: "正在回答问题" },
    { name: "completed", status: "completed", isRunning: false, expected: "已回答问题" },
  ])("$name 相写「$expected」", ({ status, isRunning, expected }) => {
    const html = renderResolve(
      { input: { question_id: "dwfq-run1-1", answer: "跳过它。" }, status },
      { isRunning },
    );
    expect(html).toContain(expected);
  });

  it("en-US 下相位文案同样本地化", () => {
    const html = renderResolve(
      { input: { question_id: "dwfq-run1-1", answer: "Skip it." }, output: "Answer delivered." },
      {},
      "en-US",
    );
    expect(html).toContain("Answered question");
    expect(html).not.toContain("正在回答问题");
  });
});

describe("ResolveWorkflowQuestionToolCallBlock body 分支", () => {
  it("qid mono 行 + 完整答案 + 成功确认三段齐备", () => {
    const html = renderResolve({
      input: { question_id: "dwfq-run1-1", answer: "跳过那道门，用旁路。" },
      output: "Answer delivered for question dwfq-run1-1. The run keeps going.",
    });
    expect(html).toContain("dwfq-run1-1");
    // qid 是标识键 → mono。
    expect(html).toMatch(/font-mono[^>]*>dwfq-run1-1/u);
    expect(html).toContain("跳过那道门，用旁路。");
    expect(html).toContain("The run keeps going.");
    expect(html).toContain("问题 ID");
    expect(html).toContain("答复");
    expect(html).toContain("结果");
  });

  it("结构化拒绝走失败样式（status failed）", () => {
    const refusal =
      "workflow_question_already_resolved: this question was already answered.";
    const html = renderResolve(
      { input: { question_id: "dwfq-run1-1", answer: "跳过它。" }, status: "failed" },
      { errorText: refusal },
    );
    expect(html).toContain("执行失败");
    expect(html).toContain(refusal);
    expect(html).toContain("border-destructive");
  });

  it("成功确认不带任何失败样式", () => {
    const html = renderResolve({
      input: { question_id: "dwfq-run1-1", answer: "跳过它。" },
      output: "Answer delivered for question dwfq-run1-1.",
    });
    expect(html).not.toContain("执行失败");
    expect(html).not.toContain("border-destructive");
  });
});

describe("升级问答工具卡快照字段提示", () => {
  it("escalate 卡后仍挂着快照字段提示", () => {
    const html = renderEscalate(
      {
        input: { question: "门坏了吗？" },
        snapshotRefs: [{ field: "input", previewBytes: 100, fullBytes: 5_000 }],
      },
      { onLoadFullToolCallFields: () => {} },
    );
    expect(html).toContain("加载完整工具数据");
  });
});

describe("升级问答工具卡词条双语齐备", () => {
  it("escalate 与 resolveQuestion 两组 key 在两种语言里都在场，且不是英文占位", () => {
    // 缺 key 会静默渲染裸 key（IntlProvider 的 messages[id] ?? id）。
    for (const key of [
      "chat.toolCall.workflow.escalate.asking",
      "chat.toolCall.workflow.escalate.asked",
      "chat.toolCall.workflow.escalate.question",
      "chat.toolCall.workflow.escalate.context",
      "chat.toolCall.workflow.escalate.answer",
      "chat.toolCall.workflow.escalate.fallbackName",
      "chat.toolCall.workflow.resolveQuestion.answering",
      "chat.toolCall.workflow.resolveQuestion.answered",
      "chat.toolCall.workflow.resolveQuestion.questionId",
      "chat.toolCall.workflow.resolveQuestion.answer",
      "chat.toolCall.workflow.resolveQuestion.outcome",
      "chat.toolCall.workflow.resolveQuestion.fallbackName",
    ]) {
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).toBeTruthy();
      expect(zhCN[key]).not.toBe(enUS[key]);
    }
  });

  it("事件日志两行措辞已与专用卡对齐（旧 Escalated / 升级提问 / 问题已答 不再出现）", () => {
    expect(enUS["chat.toolCall.workflow.run.event.escalationRaised"]).toBe("Asked main agent");
    expect(enUS["chat.toolCall.workflow.run.event.escalationResolved"]).toBe("Answered");
    expect(zhCN["chat.toolCall.workflow.run.event.escalationRaised"]).toBe("询问主代理");
    expect(zhCN["chat.toolCall.workflow.run.event.escalationResolved"]).toBe("已回答");
  });
});
