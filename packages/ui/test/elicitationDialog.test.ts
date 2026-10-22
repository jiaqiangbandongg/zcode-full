import type { ZCodeElicitationRequest } from "@zcode/shared";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildElicitationResponseContent,
  createInitialElicitationDrafts,
  ElicitationDialog,
  getElicitationCountdownSeconds,
  getElicitationQuestionAdvanceKind,
  normalizeElicitationQuestions,
  resolveElicitationCustomInputKeyAction,
  updateElicitationDraftsForOption,
} from "../src/ElicitationDialog.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

const SUBAGENT_ORIGIN = {
  kind: "subagent" as const,
  agentId: "general-purpose",
  agentType: "general-purpose",
  childSessionId: "sess-child",
  parentSessionId: "sess-parent",
  parentToolCallId: "tool-parent-agent",
};

function createMultiQuestionRequest(): ZCodeElicitationRequest {
  return {
    type: "elicitation_request",
    taskId: "task-1",
    traceId: "run-1",
    requestId: "request-1",
    message: "请选择方案",
    options: [],
    questions: [
      {
        question: "请选择方案",
        header: "方案",
        options: [
          { value: "fast", label: "快速" },
          { value: "safe", label: "稳妥" },
        ],
      },
      {
        question: "请选择保障项",
        header: "保障项",
        options: [
          { value: "tests", label: "测试" },
          { value: "docs", label: "文档" },
        ],
      },
    ],
  };
}

function createPlanApprovalRequest(): ZCodeElicitationRequest {
  return {
    type: "elicitation_request",
    taskId: "task-1",
    traceId: "run-1",
    requestId: "exit-plan-1",
    message: "Review this implementation plan.",
    header: "Plan",
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      },
    ],
    questions: [
      {
        question: "Review this implementation plan.",
        header: "Plan",
        options: [
          {
            value: "approve",
            label: "Approve",
            description: "Exit plan mode and start implementation.",
          },
        ],
      },
    ],
    schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
  };
}

describe("ElicitationDialog", () => {
  it("only exposes 59s through 1s during the final minute", () => {
    const autoResolution = {
      state: "visibleCountdown" as const,
      startedAt: 700_000,
      visibleAt: 760_000,
      deadlineAt: 1_000_000,
    };

    expect(getElicitationCountdownSeconds(autoResolution, 940_000)).toBeNull();
    expect(getElicitationCountdownSeconds(autoResolution, 940_001)).toBe(59);
    expect(getElicitationCountdownSeconds(autoResolution, 999_000)).toBe(1);
    expect(getElicitationCountdownSeconds(autoResolution, 999_999)).toBe(1);
    expect(getElicitationCountdownSeconds(autoResolution, 1_000_000)).toBeNull();
    expect(
      getElicitationCountdownSeconds(
        { state: "snoozed", startedAt: 700_000, snoozedAt: 900_000 },
        940_001,
      ),
    ).toBeNull();
  });

  it("renders a localized final-minute timer", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(940_001);
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const autoResolution = {
      state: "visibleCountdown" as const,
      startedAt: 700_000,
      visibleAt: 760_000,
      deadlineAt: 1_000_000,
    };
    const render = (locale: "en-US" | "zh-CN") =>
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: locale },
          createElement(Dialog, {
            request: createMultiQuestionRequest(),
            autoResolution,
            onFirstInteraction: () => {},
            onRespond: () => {},
          }),
        ),
      );

    try {
      const zhHtml = render("zh-CN");
      expect(zhHtml).toContain('data-elicitation-countdown-seconds="59"');
      expect(zhHtml).toContain('aria-label="停止计时"');
      expect(zhHtml).toContain(">59秒</button>");

      const enHtml = render("en-US");
      expect(enHtml).toContain(">59s</button>");
      expect(enHtml).toContain('aria-label="Stop timer"');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("shows a subagent source tag for delegated elicitation requests only", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const request = createMultiQuestionRequest();
    const mainHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );
    const subagentHtml = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(Dialog, {
          request: {
            ...request,
            origin: SUBAGENT_ORIGIN,
          },
          onRespond: () => {},
        }),
      ),
    );

    expect(mainHtml).not.toContain('data-interaction-origin-badge="subagent"');
    expect(subagentHtml).toContain('data-interaction-origin-badge="subagent"');
    expect(subagentHtml).toContain("子智能体");
    expect(subagentHtml).toContain("来自子智能体：general-purpose");
  });

  it("submits after the final question and includes the final selected option", () => {
    const request = createMultiQuestionRequest();
    const questions = normalizeElicitationQuestions(request);
    const initialDrafts = createInitialElicitationDrafts(questions, request);
    const firstDrafts = updateElicitationDraftsForOption(initialDrafts, questions[0]!, "fast");
    const finalDrafts = updateElicitationDraftsForOption(firstDrafts, questions[1]!, "tests");

    expect(getElicitationQuestionAdvanceKind(questions, 0)).toBe("next");
    expect(getElicitationQuestionAdvanceKind(questions, 1)).toBe("submit");
    expect(buildElicitationResponseContent(questions, finalDrafts)).toEqual({
      answers: {
        请选择方案: "fast",
        请选择保障项: "tests",
      },
      answer_0: "fast",
      answer_1: "tests",
    });
  });

  it("允许只提交部分问题的答案且不伪造未回答项", () => {
    const request = createMultiQuestionRequest();
    const questions = normalizeElicitationQuestions(request);
    const initialDrafts = createInitialElicitationDrafts(questions, request);
    const finalDrafts = updateElicitationDraftsForOption(initialDrafts, questions[1]!, "tests");

    expect(buildElicitationResponseContent(questions, finalDrafts)).toEqual({
      answers: { 请选择保障项: "tests" },
      answer_1: "tests",
    });
  });

  it("允许提交零回答", () => {
    const request = createMultiQuestionRequest();
    const questions = normalizeElicitationQuestions(request);
    const drafts = createInitialElicitationDrafts(questions, request);

    expect(buildElicitationResponseContent(questions, drafts)).toEqual({ answers: {} });
  });

  it("为截断的问题标题保留完整 hover title", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const longQuestion =
      "The PRD spans 4 native codebases plus shared contract and tokens. How should I sequence implementation?";
    const request = createMultiQuestionRequest();
    request.questions![0] = {
      ...request.questions![0]!,
      question: longQuestion,
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain(`title="${longQuestion}"`);
  });

  it("长问题同时保留正文与完整title", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const longQuestion =
      "The PRD spans 4 native codebases plus shared contract and tokens. How should I sequence implementation without hiding the decision text on mobile?";
    const request = createMultiQuestionRequest();
    request.questions![0] = {
      ...request.questions![0]!,
      question: longQuestion,
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain(`title="${longQuestion}"`);
    expect(html).toContain(">方案</span>");
    expect(html).toContain(`>${longQuestion}</span>`);
  });

  it("长问题提供展开入口", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const longQuestion =
      "假设你正在设计一个面向全球用户的下一代分布式实时协作平台，该平台需要支持百万级并发用户同时在线编辑文档、画板、表格和低代码应用，并且要求在离线状态下仍然可以正常编辑并在恢复网络后自动合并冲突。请在数据同步协议层面说明选择。";
    const request = createMultiQuestionRequest();
    request.questions![0] = {
      question: longQuestion,
      header: "数据同步协议",
      options: [
        {
          value: "crdt",
          label: "CRDT (Conflict-free Replicated Data Types)",
          description: "基于无冲突复制数据类型，天然支持去中心化同步和 P2P 场景。",
        },
        {
          value: "ot",
          label: "OT (Operational Transform)",
          description: "基于操作变换算法，依赖中央服务器对操作进行排序和转换。",
        },
        {
          value: "hybrid",
          label: "混合 CRDT + OT",
          description: "客户端处理本地变更和离线缓冲，服务端处理最终排序。",
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain('aria-label="展开问题"');
  });

  it("手机端阻塞弹窗提供整卡折叠入口并标记可隐藏内容", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(Dialog, {
          request: createMultiQuestionRequest(),
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain('aria-label="折叠问题弹窗"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-elicitation-dialog-body="true"');
    expect(html).toContain('data-elicitation-dialog-footer="true"');
  });

  it("选项显示标题与描述", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const request = createMultiQuestionRequest();
    request.questions![0]!.options[0] = {
      value: "fast",
      label: "快速",
      description: "先处理核心路径",
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(Dialog, {
          request,
          onRespond: () => {},
        }),
      ),
    );

    expect(html).toContain(">快速</span>");
    expect(html).toContain(">先处理核心路径</span>");
  });

  it("plan approval title follows permission copy and approve option keeps approval copy in both locales", () => {
    const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
    const request = createPlanApprovalRequest();
    const render = (locale: "en-US" | "zh-CN") =>
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: locale },
          createElement(Dialog, {
            request,
            onRespond: () => {},
          }),
        ),
      );

    const enHtml = render("en-US");
    expect(enHtml).toContain("Permission required");
    expect(enHtml).toContain("Implementation plan");
    expect(enHtml).toContain(">Approve</span>");
    expect(enHtml).toContain("Exit plan mode and start implementation.");
    expect(enHtml).toContain(">1.</span>");
    expect(enHtml).toContain(">2.</span>");
    expect(enHtml).not.toContain(">Allow</span>");
    expect(enHtml).not.toContain("Allow only this time");

    const zhHtml = render("zh-CN");
    expect(zhHtml).toContain("需要权限");
    expect(zhHtml).toContain("实施计划");
    expect(zhHtml).toContain(">批准</span>");
    expect(zhHtml).toContain("退出计划模式并开始实施。");
    expect(zhHtml).toContain(">1.</span>");
    expect(zhHtml).toContain(">2.</span>");
    expect(zhHtml).not.toContain(">允许</span>");
    expect(zhHtml).not.toContain(">Approve</span>");
    expect(zhHtml).not.toContain("Exit plan mode and start implementation.");
  });

  it("自定义回答输入框 Enter 遵循当前题目和计划审批语义，并避开输入法组词态", () => {
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        advanceKind: "next",
      }),
    ).toBe("advance");
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        advanceKind: "submit",
      }),
    ).toBe("submit");
    expect(resolveElicitationCustomInputKeyAction({ key: "Enter" })).toBe("advance");
    expect(resolveElicitationCustomInputKeyAction({ key: "Enter", ctrlKey: true })).toBe("submit");
    expect(resolveElicitationCustomInputKeyAction({ key: "Enter", metaKey: true })).toBe("submit");
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        nativeEvent: { isComposing: true },
      }),
    ).toBeNull();
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        compositionActive: true,
      }),
    ).toBeNull();
    expect(resolveElicitationCustomInputKeyAction({ key: "Escape" })).toBe("dismiss");
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Escape",
        hasPreviousQuestion: true,
      }),
    ).toBe("previous");
  });

  it("ExitPlanMode 自定义反馈输入框裸 Enter 提交", () => {
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Enter",
        isPlanApproval: true,
      }),
    ).toBe("submit");
    expect(
      resolveElicitationCustomInputKeyAction({
        key: "Escape",
        hasPreviousQuestion: true,
        isPlanApproval: true,
      }),
    ).toBe("dismiss");
  });
});
