// submit_result 工具卡（docs/chat/submit-result-tool-card.md）。
//
// 文件名刻意是 `.test.ts` 而不是 `.test.tsx`：根 vitest 配置只收
// `packages/*/test/**/*.test.ts`（vitest.config.ts:68），`.test.tsx` 一个用例都不会被采集
// （仓库里已有几个这样的死文件）。所以这里和其余 renderer 测试一样用 createElement，不写 JSX。
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getZCodeToolFamilyForName, normalizeZCodeToolName } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

// CodeBlock 依赖 shiki / CodeViewer / Tooltip 根 provider，静态渲染跑不动；照
// createWorkflowToolCallBlock.test.ts 的先例替换为可断言的桩，顺带把 language 暴露出来，
// 让「JSON 分支确实是 language=json 的代码块」可以被钉住。
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string; children?: ReactNode }) =>
    createElement("pre", { "data-testid": "code-block", "data-language": language }, code),
}));

// eslint-disable-next-line import/first -- 必须在 code-block mock 之后再引入被测 renderer。
import { SubmitResultToolCallBlock } from "../src/ToolCallBlocks/renderers/submit-result.js";
// eslint-disable-next-line import/first -- 同上；路由断言要拿到 workflow family 的另一个 renderer。
import { CreateWorkflowToolCallBlock } from "../src/ToolCallBlocks/renderers/create-workflow.js";
// eslint-disable-next-line import/first -- 同上。
import { resolveToolCallRenderer } from "../src/ToolCallBlocks/resolveRenderer.js";
// eslint-disable-next-line import/first -- 同上；整链路由断言要走真实入口组件。
import { ToolCallBlock } from "@/ToolCallBlocks.js";
// eslint-disable-next-line import/first -- 同上；词条只用于双语言存在性断言。
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

function buildContext(toolCall: ToolCallOverrides, contextOverrides: ContextOverrides = {}) {
  return {
    toolCallNode: {
      toolCall: {
        toolId: "tool-submit-result",
        toolName: toolCall.toolName ?? "submit_result",
        kind: toolCall.toolName ?? "submit_result",
        title: toolCall.toolName ?? "submit_result",
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

function renderBlock(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  locale: "en-US" | "zh-CN" = "zh-CN",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(SubmitResultToolCallBlock, buildContext(toolCall, contextOverrides)),
    ),
  );
}

const REJECTION_TEXT = [
  "The submitted result does not match the required schema:",
  "verdict: expected one of proved | disproved, got string",
  "steps[0].tactic: expected string, got number",
].join("\n");

describe("submit_result 路由", () => {
  it("submit_result 是已知工具名，归 workflow family", () => {
    // wire 名就是 snake_case 的 `submit_result`——下划线必须字面在场。
    expect(normalizeZCodeToolName("submit_result")).toBe("submit_result");
    expect(getZCodeToolFamilyForName("submit_result")).toBe("workflow");
    expect(resolveToolCallIdentity({ toolName: "submit_result" })).toMatchObject({
      toolName: "submit_result",
      family: "workflow",
      isLegacy: false,
    });
  });

  it("workflow family 内按工具名分派，不误伤 CreateWorkflow", () => {
    expect(resolveToolCallRenderer(buildContext({}) as never)).toBe(SubmitResultToolCallBlock);
    expect(resolveToolCallRenderer(buildContext({ toolName: "CreateWorkflow" }) as never)).toBe(
      CreateWorkflowToolCallBlock,
    );
  });

  it("从 ToolCallBlock 入口整链走下来就是新卡，不再是 fallback 的裸 JSON dump", () => {
    // 主会话与 actor 侧板共用这条链路（侧板挂的是嵌套只读 SessionPane），所以这一条
    // 同时钉住两个面。
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolCallBlock, {
          toolCallNode: {
            toolCall: {
              toolId: "submit-e2e",
              toolName: "submit_result",
              kind: "submit_result",
              title: "submit_result",
              input: { result: { verdict: "proved" } },
              output: { status: "accepted" },
              status: "completed",
              raw: {},
            },
            childToolCalls: [],
          },
          workspacePath: "/workspace",
        }),
      ),
    );

    expect(html).toContain("已提交结果");
    // fallback 的首字母大写标签与整对象 dump 都不该再出现。
    expect(html).not.toContain("Submit_result");
    expect(html).not.toContain("&quot;toolId&quot;");
  });
});

describe("SubmitResultToolCallBlock 相位文案", () => {
  it.each([
    { name: "completed", status: "completed", isRunning: false, expected: "已提交结果" },
    { name: "pending", status: "pending", isRunning: true, expected: "正在提交结果" },
    { name: "in_progress", status: "in_progress", isRunning: true, expected: "正在提交结果" },
    { name: "failed", status: "failed", isRunning: false, expected: "提交被驳回" },
    { name: "stopped", status: "stopped", isRunning: false, expected: "提交已停止" },
  ])("$name 相写「$expected」", ({ status, isRunning, expected }) => {
    const html = renderBlock({ input: { result: { verdict: "proved" } }, status }, { isRunning });

    expect(html).toContain(expected);
  });

  it("en-US 下相位文案同样本地化", () => {
    const html = renderBlock({ input: { result: { verdict: "proved" } } }, {}, "en-US");

    expect(html).toContain("Result submitted");
    expect(html).not.toContain("已提交结果");
  });
});

describe("SubmitResultToolCallBlock body 智能分流", () => {
  it("对象 result 走 JSON 代码块，且是缩进后的 JSON", () => {
    const html = renderBlock({
      input: { result: { verdict: "proved", steps: [{ tactic: "simp" }] } },
      output: { status: "accepted" },
    });

    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain('data-language="json"');
    expect(html).toContain("&quot;verdict&quot;: &quot;proved&quot;");
  });

  it("数组 result 同样走 JSON 分支", () => {
    const html = renderBlock({ input: { result: ["alpha", "beta"] } });

    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain("&quot;alpha&quot;");
  });

  it("纯字符串 result 走正文 prose，不进代码块、不用 mono", () => {
    const prose = "根因在 scheduler 的 may-set 展开：lane 副本没有 actor 路由。";
    const html = renderBlock({ input: { result: prose } });

    expect(html).toContain(prose);
    expect(html).not.toContain('data-testid="code-block"');
    // DESIGN.md 把 mono 留给路径/命令/代码/标识符；人话是 prose。
    expect(html).not.toMatch(/font-mono[^>]*>根因在/u);
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("JSON 字符串 result 被解开成对象后走代码块分支", () => {
    // 引擎侧记档过的实盘事实：真实模型常把 result 序列化成 JSON 字符串。
    const html = renderBlock({ input: { result: '{"verdict":"disproved","steps":[]}' } });

    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain("&quot;verdict&quot;: &quot;disproved&quot;");
    // 折叠头部的单行概要仍是压缩形态，但 body 里不能再多出一块 prose 面板。
    expect(html).not.toContain("rounded-lg border border-border bg-panel");
  });

  it("看着像 JSON 但解析不了的字符串保持 prose，不崩卡", () => {
    const broken = '{"verdict":"proved"';
    const html = renderBlock({ input: { result: broken } });

    expect(html).not.toContain('data-testid="code-block"');
    expect(html).toContain("{&quot;verdict&quot;:&quot;proved&quot;");
  });

  it("数字 / 布尔 result 也有归宿（非字符串一律走 JSON 分支）", () => {
    expect(renderBlock({ input: { result: 42 } })).toContain('data-testid="code-block"');
    expect(renderBlock({ input: { result: false } })).toContain('data-testid="code-block"');
  });

  it("input 是 JSON 字符串时同样能读到 result", () => {
    const html = renderBlock({ input: JSON.stringify({ result: { verdict: "proved" } }) });

    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain("&quot;verdict&quot;");
  });

  it("折叠头部给一行 result 概要", () => {
    const html = renderBlock(
      { input: { result: { verdict: "proved", steps: [{ tactic: "simp" }] } } },
      { forceOpen: false },
    );

    // 概要是单行压缩形态；折叠时 body 不渲染，缩进 JSON 不该出现。
    expect(html).toContain("{&quot;verdict&quot;:&quot;proved&quot;");
    expect(html).not.toContain("&quot;verdict&quot;: &quot;proved&quot;");
    expect(html).not.toContain('data-testid="code-block"');
  });
});

describe("SubmitResultToolCallBlock 流式门", () => {
  it("首帧还没有 result 键时不提供展开入口，也不渲染空面板", () => {
    const html = renderBlock(
      { input: {}, status: "pending", raw: { kind: "tool_input_start" } },
      { isRunning: true, forceOpen: true },
    );

    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-testid="code-block"');
    expect(html).not.toContain("rounded-lg border border-border bg-panel");
    expect(html).toContain("正在提交结果");
  });

  it("input 完全缺席时同样不提供展开入口", () => {
    const html = renderBlock({ status: "pending" }, { isRunning: true });

    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-testid="code-block"');
  });
});

describe("SubmitResultToolCallBlock 驳回态", () => {
  it("驳回态是扁平行：不给展开入口、不渲染 body，也不复述逐字段违规", () => {
    const html = renderBlock(
      { input: { result: { verdict: "yes" } }, status: "failed", output: REJECTION_TEXT },
      { errorText: REJECTION_TEXT },
    );

    expect(html).toContain("提交被驳回");
    // 折叠头部的单行 result 概要仍在——扁平行本身是一条概要行。
    expect(html).toContain("{&quot;verdict&quot;:&quot;yes&quot;}");
    // 不可展开：没有 toggle 按钮、没有展开后的 result 代码块。
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-testid="code-block"');
    // 逐字段违规面板整体撤除：违规原文与小标题都不再出现在卡里（走失败态 tooltip）。
    expect(html).not.toContain("expected one of proved | disproved, got string");
    expect(html).not.toContain("不符合要求的字段");
  });

  it("驳回态没有任何错误文本时同样是扁平行", () => {
    const html = renderBlock({ input: { result: { verdict: "yes" } }, status: "failed" });

    expect(html).toContain("提交被驳回");
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('data-testid="code-block"');
  });
});

describe("SubmitResultToolCallBlock 快照字段提示", () => {
  it("卡后仍挂着快照字段提示", () => {
    const html = renderBlock(
      {
        input: { result: { verdict: "proved" } },
        snapshotRefs: [{ field: "input", previewBytes: 100, fullBytes: 5_000 }],
      },
      { onLoadFullToolCallFields: () => {} },
    );

    expect(html).toContain("加载完整工具数据");
  });
});

describe("submitResult 词条双语齐备", () => {
  it("四个相位 key 加一个小标题 key 在两种语言里都在场，且不是英文占位", () => {
    // 缺 key 会静默渲染裸 key（IntlProvider.tsx 的 messages[id] ?? id）。
    for (const key of [
      "chat.toolCall.submitResult.submitting",
      "chat.toolCall.submitResult.submitted",
      "chat.toolCall.submitResult.rejected",
      "chat.toolCall.submitResult.stopped",
      "chat.toolCall.submitResult.resultHeading",
    ]) {
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).toBeTruthy();
      expect(zhCN[key]).not.toBe(enUS[key]);
    }
  });
});
