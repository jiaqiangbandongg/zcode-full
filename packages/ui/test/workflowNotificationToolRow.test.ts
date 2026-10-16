// 后台 workflow 通知行（docs/dynamic-workflow/transcript-and-notifications.md「The notification row」）——工具卡语法。
//
// 文件名是 `.test.ts`（不是 `.test.tsx`）：根 vitest 只收 packages/*/test/**/*.test.ts。
// 照 workflowEscalationToolCards 用 createElement + renderToStaticMarkup；展开态经 forceOpen
// 透传给 ToolLayout（ToolLayout 自管开合，静态渲染默认折叠，forceOpen 才把展开体渲进 DOM）。
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// CodeBlock 依赖 shiki / CodeViewer 根 provider，静态渲染跑不动；照 submit-result / escalation
// 的先例替换为桩，好让 json result 分支可断言。
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlockHeader: () => null,
  CodeBlock: ({ code, language }: { code: string; language?: string; children?: ReactNode }) =>
    createElement("pre", { "data-testid": "code-block", "data-language": language }, code),
}));

// eslint-disable-next-line import/first -- 必须在 code-block mock 之后再引入被测组件。
import {
  WorkflowNotificationToolRow,
  type WorkflowNotificationToolRowProps,
} from "@/v4/WorkflowNotificationToolRow.js";

function render(
  props: Partial<WorkflowNotificationToolRowProps> &
    Pick<WorkflowNotificationToolRowProps, "notification">,
  locale: "en-US" | "zh-CN" = "en-US",
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowNotificationToolRow, {
        runName: "flaky-test-triage",
        testIdKey: "turn-1:1",
        theme: "system",
        ...props,
      } as WorkflowNotificationToolRowProps),
    ),
  );
}

const EXPAND_TOGGLE_LABEL = "Expand tool details";
const OPEN_RUN_LABEL = "Open run details";

describe("WorkflowNotificationToolRow — terminal", () => {
  it("kindLabel 承载三个终态（工具卡语法，无失败装置）", () => {
    expect(
      render({ notification: { kind: "terminal", status: "completed", summary: "s" } }),
    ).toContain("Workflow completed");
    expect(
      render({
        notification: { kind: "terminal", status: "errored", summary: "s", error: "boom" },
      }),
    ).toContain("Workflow errored");
    expect(
      render({ notification: { kind: "terminal", status: "stopped", summary: "s" } }),
    ).toContain("Workflow stopped");
  });

  it("stopped 带原因词：kindLabel 后跟 `· <reason>`（决策 15）", () => {
    const html = render({
      notification: { kind: "terminal", status: "stopped", stopReason: "provider", summary: "s" },
    });
    expect(html).toContain("Workflow stopped · model error");
    expect(
      render({
        notification: { kind: "terminal", status: "stopped", stopReason: "user", summary: "s" },
      }),
    ).toContain("Workflow stopped · by you");
  });

  it("stopped 而带 error（provider / interrupted）→ 可展开，error 走错误面板", () => {
    const html = render({
      notification: {
        kind: "terminal",
        status: "stopped",
        stopReason: "provider",
        summary: "s",
        error: "Sign-in to BigModel expired.",
      },
      forceOpen: true,
    });
    expect(html).toContain("Sign-in to BigModel expired.");
    expect(html).toContain("border-destructive/40");
  });

  it("stall 通知：kindLabel「等待模型」+ 沙漏图标，展开体给等待时长 / 原因 / 并发数", () => {
    const html = render({
      notification: { kind: "stall", sinceMs: 20 * 60_000, reason: "rate_limited", cap: 2 },
      forceOpen: true,
    });
    expect(html).toContain("Workflow waiting on the model");
    expect(html).toContain("No model request in this run has succeeded for 20 min.");
    expect(html).toContain("rate_limited");
    expect(html).toContain("Max concurrency");
    expect(html).toContain("workflow-notification-stall");
  });

  it("primaryText = 分隔符与普通字体 run 名", () => {
    const html = render({
      notification: { kind: "terminal", status: "completed", summary: "s", result: "r" },
    });
    expect(html).toContain("flaky-test-triage");
    expect(html).not.toContain("font-mono");
    // testid 挂在行根，供 turn-group 断言。
    expect(html).toContain('data-testid="chat-workflow-notification-row-turn-1:1"');
  });

  it("展开体：completed 的 prose result 走 <p>（不进 code-block）", () => {
    const html = render({
      notification: {
        kind: "terminal",
        status: "completed",
        summary: "s",
        result: "Confirmed 3 flaky tests; harness race shared by two of them.",
        resultForm: "prose",
      },
      forceOpen: true,
    });
    expect(html).toContain("Confirmed 3 flaky tests; harness race shared by two of them.");
    expect(html).not.toContain('data-testid="code-block"');
    expect(html).toContain("max-h-80");
    expect(html).not.toContain("border-border bg-panel");
  });

  it("展开体：json result 进 CodeBlock 桩（language=json）", () => {
    const html = render({
      notification: {
        kind: "terminal",
        status: "completed",
        summary: "s",
        result: '{ "confirmed": 3 }',
        resultForm: "json",
      },
      forceOpen: true,
    });
    expect(html).toContain('data-testid="code-block"');
    expect(html).toContain('data-language="json"');
    expect(html).toContain("&quot;confirmed&quot;");
  });

  it("展开体：errored 的 error 走 border-destructive/40 面板（非行级失败装置）", () => {
    const html = render({
      notification: {
        kind: "terminal",
        status: "errored",
        summary: "s",
        error: "NODE_LIMIT exceeded: run spawned 100 nodes (budget 100).",
      },
      forceOpen: true,
    });
    expect(html).toContain("NODE_LIMIT exceeded: run spawned 100 nodes (budget 100).");
    expect(html).toContain("border-destructive/40");
  });

  it("result 与 error 双缺 → 行不可展开（无 chevron）", () => {
    const html = render({ notification: { kind: "terminal", status: "completed", summary: "s" } });
    expect(html).toContain("Workflow completed");
    expect(html).not.toContain(EXPAND_TOGGLE_LABEL);
  });

  it("errored 但 error 缺席 → 无 chevron", () => {
    const html = render({ notification: { kind: "terminal", status: "errored", summary: "s" } });
    expect(html).toContain("Workflow errored");
    expect(html).not.toContain(EXPAND_TOGGLE_LABEL);
  });

  it("打开运行详情链接：onOpenRun 在场时渲染，缺席时不渲染", () => {
    const withCb = render({
      notification: { kind: "terminal", status: "completed", summary: "s", result: "r" },
      onOpenRun: () => {},
      forceOpen: true,
    });
    expect(withCb).toContain(OPEN_RUN_LABEL);

    const without = render({
      notification: { kind: "terminal", status: "completed", summary: "s", result: "r" },
      forceOpen: true,
    });
    expect(without).not.toContain(OPEN_RUN_LABEL);
  });
});

const ESCALATION = {
  kind: "escalation",
  qid: "q_7f2c",
  actor: "planner #3",
  question:
    "Fix the harness once (larger blast radius) or patch each test individually (safe but leaves the race)?",
  context: "Harness fix = ~40 lines in test/fixtures/harness.ts.",
  askedAt: Date.now() - 5 * 60_000,
} as const;

describe("WorkflowNotificationToolRow — escalation", () => {
  it("kindLabel 三态由 pendingQids 活翻转", () => {
    expect(render({ notification: ESCALATION, pendingQids: new Set(["q_7f2c"]) })).toContain(
      "Subagent is waiting for an answer",
    );
    expect(render({ notification: ESCALATION, pendingQids: new Set<string>() })).toContain(
      "Subagent question answered",
    );
    expect(render({ notification: ESCALATION })).toContain("Subagent asked a question");
  });

  it("primaryText = 问题单行概要（折叠态可见，全文不挂载）", () => {
    const html = render({ notification: ESCALATION, pendingQids: new Set(["q_7f2c"]) });
    // 概要（问题被 160 截断/折行；这里短，整句作为概要出现）。
    expect(html).toContain("Fix the harness once (larger blast radius)");
    // 折叠态不挂载 context。
    expect(html).not.toContain("Harness fix = ~40 lines in test/fixtures/harness.ts.");
  });

  it("展开体：问题全文 + context；不引用答案原文", () => {
    const html = render({
      notification: ESCALATION,
      pendingQids: new Set(["q_7f2c"]),
      forceOpen: true,
    });
    expect(html).toContain(
      "Fix the harness once (larger blast radius) or patch each test individually (safe but leaves the race)?",
    );
    expect(html).toContain("Harness fix = ~40 lines in test/fixtures/harness.ts.");
  });

  it("等待时长只在 waiting 态出现", () => {
    const waiting = render({
      notification: ESCALATION,
      pendingQids: new Set(["q_7f2c"]),
      forceOpen: true,
    });
    expect(waiting).toContain("5m ago");

    const answered = render({
      notification: ESCALATION,
      pendingQids: new Set<string>(),
      forceOpen: true,
    });
    expect(answered).not.toContain("5m ago");
  });
});
