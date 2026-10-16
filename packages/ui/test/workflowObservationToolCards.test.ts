// @vitest-environment jsdom
//
// 观察类工作流工具卡的渲染与分流测试（spec: docs/dynamic-workflow/launch.md
// 「工具卡 display」、docs/dynamic-workflow/authoring.md「EvalWorkflowSnippet」、docs/dynamic-workflow/launch.md「`SaveWorkflow`」「结果卡 display
// 增补」）。三个工具此前没有登记进已知工具表，全部掉进 raw JSON 兜底卡——本文件钉住
// 「按名分流 + display 驱动 + 无 display 时文本兜底（绝不是 JSON dump）」三件事。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { EvalWorkflowSnippetToolCallBlock } from "@/ToolCallBlocks/renderers/eval-workflow-snippet.js";
import { GetWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/get-workflow-run.js";
import { ListWorkflowRunsToolCallBlock } from "@/ToolCallBlocks/renderers/list-workflow-runs.js";
import { ResumeWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/resume-workflow-run.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

vi.mock("@/components/ui/code-viewer.js", () => ({
  CodeViewer: ({ code, language }: { code: string; language: string }) =>
    createElement("pre", { "data-language": language }, code),
}));

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlockHeader: () => null,
  CodeBlockCopyButton: () => null,
  CodeBlock: ({
    code,
    language,
    contentClassName,
  }: {
    code: string;
    language?: string;
    contentClassName?: string;
    children?: React.ReactNode;
  }) =>
    createElement(
      "pre",
      { "data-testid": "code-block", "data-language": language, className: contentClassName },
      code,
    ),
}));

const GET_RUN_DISPLAY = {
  kind: "get_workflow_run",
  runId: "wf_demo",
  label: "nightly-sync",
  status: "running",
  usage: {
    spentTokens: 12_345,
    nodesObserved: 7,
    nodesRunning: 2,
    nodesCompleted: 4,
    nodesFailed: 1,
  },
  actors: [
    { siteId: "agent#1", ordinal: 1, name: "scout" },
    { siteId: "agent#2", ordinal: 2 },
  ],
  logTail: [
    { sequence: 1, message: "started" },
    { sequence: 2, message: "fan-out complete" },
  ],
};

// ── 情势截面（spec: docs/dynamic-workflow/launch.md「`GetWorkflowRun`」「Their cards」）──
//
// 所有年龄都对快照时刻 `generatedAt` 算，所以这些常量写成「相对 G 的偏移」而不是绝对时刻：
// 测试不需要 fake timers，卡上的读数也不该随运行时刻变化。
const G = 1_800_000_000_000;

const GET_RUN_SITUATION_DISPLAY = {
  kind: "get_workflow_run",
  runId: "wf_situation",
  label: "nightly-sync",
  status: "running",
  summary:
    "Running for 15m 00s, in phase 2 of 3 (judge), 5 steps settled, 2 running (1 executing, 1 parked), last progress 40s ago.",
  generatedAt: G,
  usage: {
    spentTokens: 12_345,
    nodesObserved: 7,
    nodesRunning: 2,
    nodesCompleted: 4,
    nodesFailed: 1,
  },
  phases: [
    {
      name: "collect",
      state: "done",
      rounds: 1,
      nodesSettled: 3,
      nodesRunning: 0,
      enteredAt: G - 900_000,
      exitedAt: G - 600_000,
    },
    {
      name: "judge",
      state: "current",
      rounds: 2,
      nodesSettled: 2,
      nodesRunning: 2,
      enteredAt: G - 600_000,
    },
    { name: "report", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
  ],
  subagents: [
    {
      siteId: "agent#1",
      ordinal: 1,
      name: "scout",
      state: "executing",
      phaseName: "judge",
      instructionsHead: "Check the release notes for regressions",
      startedAt: G - 310_000,
      turn: 3,
      toolCalls: 7,
      lastTool: { name: "Bash", target: "pnpm test", at: G - 20_000 },
      stepsSettled: 2,
      stepsFailed: 0,
      tokens: 4_200,
    },
    {
      siteId: "agent#2",
      ordinal: 2,
      state: "parked",
      phaseName: "judge",
      parkedOn: "q_7",
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 900,
    },
    {
      siteId: "agent#3",
      ordinal: 3,
      name: "drafter",
      state: "waiting",
      phaseName: "judge",
      waitCause: "backoff",
      retryAfterMs: 45_000,
      waitSince: G - 65_000,
      stepsSettled: 0,
      stepsFailed: 0,
      tokens: 0,
    },
  ],
  health: {
    lastProgressAt: G - 40_000,
    concurrency: { effective: 2, cap: 4, reason: "rate_limited", since: G - 130_000 },
    consecutiveFailures: 2,
    cachedSteps: 3,
    pendingQuestionsKnown: true,
  },
  actors: [],
  logTail: [{ sequence: 9, message: "fan-out complete", at: G - 95_000 }],
};

const GET_RUN_COMPLETED_SITUATION_DISPLAY = {
  ...GET_RUN_SITUATION_DISPLAY,
  runId: "wf_done",
  status: "completed",
  summary: "Completed 3m 20s ago across 2 phases, 6 steps settled, deliverable: Release report.",
  result: "all checks passed",
  phases: [
    {
      name: "collect",
      state: "done",
      rounds: 1,
      nodesSettled: 3,
      nodesRunning: 0,
      enteredAt: G - 900_000,
      exitedAt: G - 600_000,
    },
    {
      name: "judge",
      state: "done",
      rounds: 1,
      nodesSettled: 3,
      nodesRunning: 0,
      enteredAt: G - 600_000,
      exitedAt: G - 200_000,
    },
  ],
  subagents: [
    {
      siteId: "agent#1",
      ordinal: 1,
      name: "scout",
      state: "done",
      phaseName: "judge",
      stepsSettled: 6,
      stepsFailed: 1,
      tokens: 8_800,
    },
  ],
  health: {
    lastProgressAt: G - 200_000,
    consecutiveFailures: 0,
    cachedSteps: 0,
    pendingQuestionsKnown: true,
  },
  logTail: [],
};

const GET_RUN_INTERRUPTED_SITUATION_DISPLAY = {
  kind: "get_workflow_run",
  runId: "wf_interrupted",
  label: "nightly-sync",
  status: "stopped",
  stopReason: "interrupted",
  summary: "Stopped 2h 15m ago in phase judge, 1 step settled, 1 still marked running.",
  generatedAt: G,
  usage: {
    spentTokens: 3_000,
    nodesObserved: 2,
    nodesRunning: 1,
    nodesCompleted: 1,
    nodesFailed: 0,
  },
  phases: [
    {
      name: "judge",
      state: "unfinished",
      rounds: 1,
      nodesSettled: 1,
      nodesRunning: 1,
      enteredAt: G - 8_100_000,
    },
  ],
  subagents: [
    {
      siteId: "agent#1",
      ordinal: 1,
      name: "scout",
      state: "unfinished",
      phaseName: "judge",
      startedAt: G - 8_000_000,
      turn: 2,
      stepsSettled: 1,
      stepsFailed: 1,
      tokens: 1_500,
    },
  ],
  health: {
    lastProgressAt: G - 8_000_000,
    consecutiveFailures: 0,
    cachedSteps: 0,
    leftoverRunning: 1,
    pendingQuestionsKnown: true,
  },
  actors: [],
  logTail: [],
  truncated: true,
};

/** 这个会话不持有的活 run：停驻的问题只活在提问进程里，卡必须把「看不见」说出口。 */
const GET_RUN_UNKNOWN_QUESTIONS_DISPLAY = {
  kind: "get_workflow_run",
  runId: "wf_foreign",
  label: "nightly-sync",
  status: "running",
  possiblyInterrupted: true,
  summary: "Running, 0 steps settled, pending questions unknown to this session.",
  generatedAt: G,
  usage: {
    spentTokens: 0,
    nodesObserved: 0,
    nodesRunning: 0,
    nodesCompleted: 0,
    nodesFailed: 0,
  },
  subagents: [],
  health: {
    consecutiveFailures: 0,
    cachedSteps: 0,
    pendingQuestionsKnown: false,
  },
  actors: [],
  logTail: [],
};

const LIST_RUNS_DISPLAY = {
  kind: "list_workflow_runs",
  runs: [
    {
      runId: "wf_a",
      label: "alpha",
      labelSource: "name",
      status: "completed",
      ownedByThisSession: true,
      createdAt: 1,
      updatedAt: 2,
      spentTokens: 10,
    },
    {
      runId: "wf_b",
      label: "// derive",
      labelSource: "script",
      status: "stopped",
      ownedByThisSession: false,
      possiblyInterrupted: true,
      createdAt: 3,
      updatedAt: 4,
      spentTokens: 20,
    },
  ],
  truncated: true,
};

const SNIPPET_DISPLAY = {
  kind: "eval_workflow_snippet",
  ok: false,
  diagnostics: [
    { code: 2322, column: 10, line: 3, message: "Type 'string' is not assignable to 'number'." },
  ],
  logs: ["glob matched 3 files"],
  response: "3",
  durationMs: 1_250,
};

function buildContext(
  toolCall: Record<string, unknown>,
  overrides: Partial<ToolCallBlockRenderContext> = {},
): ToolCallBlockRenderContext {
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
    ...overrides,
  } as ToolCallBlockRenderContext;
}

function renderCard(
  component: (context: ToolCallBlockRenderContext) => unknown,
  context: ToolCallBlockRenderContext,
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(component as never, context),
    ),
  );
}

function buildToolCall(overrides: Record<string, unknown> = {}) {
  return {
    toolId: "tool-obs-1",
    status: "completed",
    input: {},
    ...overrides,
  };
}

afterEach(cleanup);

describe("resolveToolCallRenderer observation dispatch", () => {
  it("routes the three observation tools by name, ahead of any family fallback", () => {
    for (const [toolName, expected] of [
      ["GetWorkflowRun", GetWorkflowRunToolCallBlock],
      ["ListWorkflowRuns", ListWorkflowRunsToolCallBlock],
      ["EvalWorkflowSnippet", EvalWorkflowSnippetToolCallBlock],
      ["ResumeWorkflowRun", ResumeWorkflowRunToolCallBlock],
    ] as const) {
      const renderer = resolveToolCallRenderer(
        buildContext(buildToolCall({ toolName, kind: toolName, title: toolName })),
      );
      expect(renderer).toBe(expected);
    }
  });

  it("matches snake_case wire spellings too", () => {
    for (const [toolName, expected] of [
      ["get_workflow_run", GetWorkflowRunToolCallBlock],
      ["list_workflow_runs", ListWorkflowRunsToolCallBlock],
      ["eval_workflow_snippet", EvalWorkflowSnippetToolCallBlock],
      ["resume_workflow_run", ResumeWorkflowRunToolCallBlock],
    ] as const) {
      const renderer = resolveToolCallRenderer(
        buildContext(buildToolCall({ toolName, kind: toolName, title: toolName })),
      );
      expect(renderer).toBe(expected);
    }
  });
});

describe("GetWorkflowRunToolCallBlock", () => {
  it("renders the structured card from display payload", () => {
    const context = buildContext(
      buildToolCall({
        toolId: "tool-get-run",
        toolName: "GetWorkflowRun",
        kind: "GetWorkflowRun",
        title: "GetWorkflowRun",
        input: { run_id: "wf_demo" },
        raw: { display: GET_RUN_DISPLAY },
      }),
    );
    renderCard(GetWorkflowRunToolCallBlock, context);

    // 折叠行：kindLabel + label + 步数（settled 5 = completed 4 + failed 1，observed 7）+ 状态词。
    expect(screen.getAllByText("Workflow status").length).toBeGreaterThan(0);
    expect(screen.getAllByText("nightly-sync").length).toBeGreaterThan(0);
    expect(screen.getAllByText("5/7 steps").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    // 展开卡体：用量（只有已花 token，没有上限）/ Actors / 日志。
    expect(screen.queryByText("Usage")).toBeNull();
    expect(screen.getByText("12.3k tokens")).toBeTruthy();
    expect(screen.getByText("2 running nodes")).toBeTruthy();
    expect(screen.queryByText("scout")).toBeNull();
    // 日志面板把多条 join 成一个 <pre>，用子串匹配。
    expect(screen.getByText(/fan-out complete/)).toBeTruthy();
  });

  it("renders the completed run result as prose", () => {
    const context = buildContext(
      buildToolCall({
        toolName: "GetWorkflowRun",
        kind: "GetWorkflowRun",
        title: "GetWorkflowRun",
        raw: {
          display: {
            ...GET_RUN_DISPLAY,
            status: "completed",
            result: "all checks passed",
          },
        },
      }),
    );
    renderCard(GetWorkflowRunToolCallBlock, context);
    expect(screen.getByText("all checks passed")).toBeTruthy();
    expect(screen.queryByText("Result")).toBeNull();
  });

  it("查询中即使带旧 display 也不展开", () => {
    renderCard(
      GetWorkflowRunToolCallBlock,
      buildContext(buildToolCall({ raw: { display: GET_RUN_DISPLAY } }), { isRunning: true }),
    );
    expect(screen.queryByTestId("workflow-status-body")).toBeNull();
  });
  it("查询失败只显示查询错误，不显示旧 run 数据", () => {
    renderCard(
      GetWorkflowRunToolCallBlock,
      buildContext(buildToolCall({ status: "failed", raw: { display: GET_RUN_DISPLAY } }), {
        errorText: "lookup denied",
      }),
    );
    expect(screen.getByText("lookup denied")).toBeTruthy();
    expect(screen.queryByText(/fan-out complete/)).toBeNull();
  });
  it("run 失败保持查询成功样式且优先显示错误", () => {
    renderCard(
      GetWorkflowRunToolCallBlock,
      buildContext(
        buildToolCall({
          raw: {
            display: {
              ...GET_RUN_DISPLAY,
              status: "errored",
              error: { code: "RUN_ERROR", message: "actor failed" },
            },
          },
        }),
      ),
    );
    expect(screen.getByTestId("workflow-status-body").textContent).toMatch(
      /^RUN_ERROR: actor failed/,
    );
    expect(screen.queryByText("Usage")).toBeNull();
  });

  it("falls back to the text projection without display — never a raw JSON dump", () => {
    const toolCall = buildToolCall({
      toolName: "GetWorkflowRun",
      kind: "GetWorkflowRun",
      title: "GetWorkflowRun",
      output: "<run_id>wf_demo</run_id><status>running</status>",
    });
    renderCard(GetWorkflowRunToolCallBlock, buildContext(toolCall));

    expect(screen.getAllByText(/wf_demo/).length).toBeGreaterThan(0);
    // raw JSON dump 兜底卡会把整个 toolCall stringify 进 DOM——这里必须不存在。
    expect(screen.queryByText(/"toolId"/)).toBeNull();
  });

  it("shows the fetching kind label while running (zh + en)", () => {
    for (const [locale, expected] of [
      ["zh-CN", "正在获取工作流状态"],
      ["en-US", "Checking workflow status"],
    ] as const) {
      cleanup();
      renderCard(
        GetWorkflowRunToolCallBlock,
        buildContext(
          buildToolCall({
            toolName: "GetWorkflowRun",
            kind: "GetWorkflowRun",
            title: "GetWorkflowRun",
            input: { run_id: "wf_demo" },
          }),
          { isRunning: true, forceOpen: false },
        ),
        locale,
      );
      expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
    }
  });
});

// 情势截面上卡（spec: docs/dynamic-workflow/launch.md「`GetWorkflowRun`」「Their cards」）：
// 摘要句 / 阶段轨 / 花名册 / 健康行 / 日志年龄，以及两处「把不知道说出口」。
describe("GetWorkflowRunToolCallBlock situation report", () => {
  function renderRun(display: Record<string, unknown>, locale: "en-US" | "zh-CN" = "en-US") {
    renderCard(
      GetWorkflowRunToolCallBlock,
      buildContext(
        buildToolCall({
          toolId: "tool-situation",
          toolName: "GetWorkflowRun",
          kind: "GetWorkflowRun",
          title: "GetWorkflowRun",
          raw: { display },
        }),
      ),
      locale,
    );
  }

  it("running: summary on both the collapsed line and the body", () => {
    renderRun(GET_RUN_SITUATION_DISPLAY);
    expect(screen.getByTestId("workflow-run-summary-line").textContent).toBe(
      GET_RUN_SITUATION_DISPLAY.summary,
    );
    expect(screen.getByTestId("workflow-run-summary").textContent).toBe(
      GET_RUN_SITUATION_DISPLAY.summary,
    );
    // 有摘要就让它占住折叠行，步数让位（步数仍在展开的用量行里）。
    expect(screen.getAllByText("5/7 steps").length).toBe(1);
  });

  it("running: phase rows carry state word, rounds, counts and duration", () => {
    renderRun(GET_RUN_SITUATION_DISPLAY);
    const phases = screen.getByTestId("workflow-run-phases");
    expect(phases.textContent).toContain("1.collectdone");
    expect(phases.textContent).toContain("1 round");
    expect(phases.textContent).toContain("3 settled");
    // 已离开的阶段写实际时长；当前阶段写「到现在为止」，两者都对 generatedAt 算。
    expect(phases.textContent).toContain("5m 00s");
    expect(phases.textContent).toContain("2.judgecurrent");
    expect(phases.textContent).toContain("2 rounds");
    expect(phases.textContent).toContain("2 running");
    expect(phases.textContent).toContain("10m 00s so far");
    // `ahead` 的行只有序号、名字和状态词：它还没发生过，没有 0 可写。
    expect(phases.textContent).toContain("3.reportahead");
    expect(phases.textContent).not.toContain("0 settled");
  });

  it("running: roster rows mirror the model text per state", () => {
    renderRun(GET_RUN_SITUATION_DISPLAY);
    const roster = screen.getByTestId("workflow-run-subagents");
    // 在跑的行：地址、相位词、阶段、这一步的年龄、轮次、工具调用数、最后一个工具及其年龄、token。
    expect(roster.textContent).toContain("scout");
    expect(roster.textContent).toContain("agent#1@1");
    expect(roster.textContent).toContain("executing");
    expect(roster.textContent).toContain("phase judge");
    expect(roster.textContent).toContain("5m 10s on this step");
    expect(roster.textContent).toContain("turn 3");
    expect(roster.textContent).toContain("7 tool calls");
    expect(roster.textContent).toContain("last Bash pnpm test 20s ago");
    expect(roster.textContent).toContain("4.2k tokens");
    // 缩进的任务行：作者自己写的指令头。
    expect(screen.getByText("task: Check the release notes for regressions")).toBeTruthy();
    // 停驻的行：只有问题 id，没有等待时长（卡面载荷不带提问时刻，绝不编一个）。
    expect(roster.textContent).toContain("agent#2@2");
    expect(roster.textContent).toContain("parked");
    expect(roster.textContent).toContain("on question q_7");
    // 退避的行：等了多久贴着原因，还要等多久收尾。
    expect(roster.textContent).toContain("drafter");
    expect(roster.textContent).toContain("in backoff");
    expect(roster.textContent).toContain("for 1m 05s");
    expect(roster.textContent).toContain("retry in 45s");
    // token 为 0 的行不写「0 tokens」（前置的 \D 是为了不把 "900 tokens" 误当命中）。
    expect(roster.textContent).not.toMatch(/(?:^|\D)0 tokens/u);
  });

  it("running: health readings and log ages are relative to generatedAt", () => {
    renderRun(GET_RUN_SITUATION_DISPLAY);
    const health = screen.getByTestId("workflow-run-health");
    expect(health.textContent).toContain("last progress 40s ago");
    expect(health.textContent).toContain("concurrency 2/4");
    expect(health.textContent).toContain("rate limited");
    expect(health.textContent).toContain("since 2m 10s ago");
    expect(health.textContent).toContain("not stalled");
    expect(health.textContent).toContain("2 consecutive failures");
    expect(health.textContent).toContain("3 cached steps");
    expect(screen.queryByTestId("workflow-run-leftover")).toBeNull();
    // 日志行按 journal 时刻前缀年龄（同一把尺，同一个基准）。
    expect(screen.getByText(/1m 35s ago\s+fan-out complete/u)).toBeTruthy();
  });

  it("running: zh-CN uses the run pane vocabulary", () => {
    renderRun(GET_RUN_SITUATION_DISPLAY, "zh-CN");
    const roster = screen.getByTestId("workflow-run-subagents");
    expect(roster.textContent).toContain("执行中");
    expect(roster.textContent).toContain("停驻");
    expect(roster.textContent).toContain("退避中");
    expect(roster.textContent).toContain("已等 1m 05s");
    expect(roster.textContent).toContain("45s 后重试");
    expect(screen.getByTestId("workflow-run-health").textContent).toContain("最近进展 40s 前");
    expect(screen.getByTestId("workflow-run-phases").textContent).toContain("进行中");
  });

  it("completed: result stays first, phases and roster still render", () => {
    renderRun(GET_RUN_COMPLETED_SITUATION_DISPLAY);
    const body = screen.getByTestId("workflow-status-body");
    // 摘要是导语，结果紧跟其后（终态卡先给结果，这是原有行为）。
    expect(body.textContent?.startsWith(GET_RUN_COMPLETED_SITUATION_DISPLAY.summary)).toBe(true);
    expect(screen.getByText("all checks passed")).toBeTruthy();
    expect(screen.getByTestId("workflow-run-phases").textContent).toContain("2.judgedone");
    const roster = screen.getByTestId("workflow-run-subagents");
    expect(roster.textContent).toContain("6 steps");
    expect(roster.textContent).toContain("1 failed");
    // 终态 run 不说 stalled，健康行也不写为 0 的读数。
    const health = screen.getByTestId("workflow-run-health");
    expect(health.textContent).not.toContain("stalled");
    expect(health.textContent).not.toContain("0 cached steps");
  });

  it("interrupted: leftover note, unfinished wording and the truncated footnote", () => {
    renderRun(GET_RUN_INTERRUPTED_SITUATION_DISPLAY);
    expect(screen.getByTestId("workflow-run-leftover").textContent).toBe(
      "The step below marked running is a leftover of the exited process, not live work.",
    );
    const phases = screen.getByTestId("workflow-run-phases");
    // 终态 run 里的「还在跑」是没结算，不是在动；也不写「到现在为止」的时长。
    expect(phases.textContent).toContain("1 unfinished");
    expect(phases.textContent).not.toContain("so far");
    const roster = screen.getByTestId("workflow-run-subagents");
    expect(roster.textContent).toContain("unfinished");
    expect(roster.textContent).toContain("was in flight at the stop");
    expect(screen.getByText("Some rows were left off this card.")).toBeTruthy();
  });

  it("says out loud that this session cannot see the pending questions", () => {
    renderRun(GET_RUN_UNKNOWN_QUESTIONS_DISPLAY);
    expect(screen.getByTestId("workflow-run-questions-unknown").textContent).toContain(
      "cannot see this run's pending questions",
    );
    // 空花名册什么也不画；没有阶段就没有阶段轨。
    expect(screen.queryByTestId("workflow-run-subagents")).toBeNull();
    expect(screen.queryByTestId("workflow-run-phases")).toBeNull();
  });

  it("renders a pre-situation payload exactly as before", () => {
    renderRun(GET_RUN_DISPLAY);
    // 情势五件缺席 → 折叠行回到步数，卡体没有摘要 / 阶段轨 / 花名册 / 健康行。
    expect(screen.getAllByText("5/7 steps").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("workflow-run-summary-line")).toBeNull();
    expect(screen.queryByTestId("workflow-run-summary")).toBeNull();
    expect(screen.queryByTestId("workflow-run-phases")).toBeNull();
    expect(screen.queryByTestId("workflow-run-subagents")).toBeNull();
    expect(screen.queryByTestId("workflow-run-health")).toBeNull();
    // 没有 journal 时刻的日志行不带年龄前缀：日志面板逐字还是那两行。
    expect(screen.getByTestId("workflow-status-body").querySelector("pre")?.textContent).toBe(
      "started\nfan-out complete",
    );
  });
});

describe("ListWorkflowRunsToolCallBlock", () => {
  it("renders rows with status word, session tag, interrupted hint and truncated footnote", () => {
    const context = buildContext(
      buildToolCall({
        toolName: "ListWorkflowRuns",
        kind: "ListWorkflowRuns",
        title: "ListWorkflowRuns",
        raw: { display: LIST_RUNS_DISPLAY },
      }),
    );
    renderCard(ListWorkflowRunsToolCallBlock, context);

    expect(screen.getAllByText("2 runs").length).toBeGreaterThan(0);
    expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
    expect(screen.getByText("this session")).toBeTruthy();
    expect(screen.getByText("possibly interrupted")).toBeTruthy();
    expect(screen.getByText("Showing the most recent runs only")).toBeTruthy();
  });

  it("renders the empty state from an empty display list", () => {
    const context = buildContext(
      buildToolCall({
        toolName: "ListWorkflowRuns",
        kind: "ListWorkflowRuns",
        title: "ListWorkflowRuns",
        raw: { display: { kind: "list_workflow_runs", runs: [] } },
      }),
      { forceOpen: true },
    );
    renderCard(ListWorkflowRunsToolCallBlock, context);
    expect(screen.getAllByText("No workflow runs yet").length).toBeGreaterThan(0);
  });
});

describe("EvalWorkflowSnippetToolCallBlock", () => {
  it("完成展开只显示返回值，没有标题、日志或代码", () => {
    renderCard(
      EvalWorkflowSnippetToolCallBlock,
      buildContext(
        buildToolCall({
          input: { code: "return 7;" },
          raw: { display: { ...SNIPPET_DISPLAY, ok: true, diagnostics: [], response: "7" } },
        }),
      ),
    );
    const body = screen.getByTestId("workflow-snippet-body");
    expect(body.textContent).toBe("7");
    expect(body.querySelector("pre")?.className).toContain("max-h-80");
    expect(body.querySelector("pre")?.getAttribute("data-language")).toBe("json");

    expect(body.querySelector("h4, summary")).toBeNull();
    expect(screen.queryByTestId("snippet-logs")).toBeNull();
    expect(screen.queryByTestId("snippet-code")).toBeNull();
  });
  it("完成无返回值时，即使有代码和日志也没有展开入口", () => {
    renderCard(
      EvalWorkflowSnippetToolCallBlock,
      buildContext(
        buildToolCall({
          input: { code: "return;" },
          raw: {
            display: {
              ...SNIPPET_DISPLAY,
              ok: true,
              diagnostics: [],
              logs: [],
              response: "The snippet completed in 1250ms.\nIt returned no value.",
            },
          },
        }),
        { forceOpen: false },
      ),
    );
    expect(screen.queryByTestId("workflow-snippet-body")).toBeNull();
    expect(document.querySelector("[aria-expanded]")).toBeNull();
  });

  it("进行中计时递增且无结果占位；终态使用固定耗时", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    try {
      renderCard(
        EvalWorkflowSnippetToolCallBlock,
        buildContext(buildToolCall({ startedAt: 1000, input: { code: "return 1;" } }), {
          isRunning: true,
        }),
      );
      // 进行中按整秒走、每秒一格（修订 2026-09-12：与面板里其他计时同一粒度，毫秒尾数肉眼读不了，
      // 而 100ms 一次 setState 是聊天区里最频繁的待处理更新——嵌套更新计数的种子）。
      expect(screen.getByText("0s")).toBeTruthy();
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByText("0s")).toBeTruthy();
      expect(screen.queryByText(/\dms$/)).toBeNull();
      act(() => vi.advanceTimersByTime(700));
      expect(screen.getByText("1s")).toBeTruthy();
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText("2s")).toBeTruthy();
      expect(screen.queryByTestId("snippet-result")).toBeNull();
      expect(screen.queryByTestId("snippet-logs")).toBeNull();
      expect(screen.getByTestId("workflow-snippet-body").textContent).toBe("return 1;");
      cleanup();
      renderCard(
        EvalWorkflowSnippetToolCallBlock,
        buildContext(
          buildToolCall({
            raw: {
              display: {
                ...SNIPPET_DISPLAY,
                ok: true,
                diagnostics: [],
                logs: [],
                response: "1",
                durationMs: 427,
              },
            },
          }),
        ),
      );
      // 终态定格在工具结果的精确毫秒。
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText("427ms")).toBeTruthy();
      expect(screen.queryByText("1427ms")).toBeNull();
      expect(screen.queryByText(/^\ds$/)).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("renders code, shared diagnostics, logs and response from display", () => {
    const context = buildContext(
      buildToolCall({
        toolName: "EvalWorkflowSnippet",
        kind: "EvalWorkflowSnippet",
        title: "EvalWorkflowSnippet",
        input: { code: 'const n = (await files.glob("*.ts")).length; return n;' },
        raw: { display: SNIPPET_DISPLAY },
      }),
    );
    renderCard(EvalWorkflowSnippetToolCallBlock, context);

    // 诊断走共享的编译反馈卡（与 CreateWorkflow 同一形状，docs/dynamic-workflow/presentation.md「Compiler feedback」）。
    expect(screen.getByText("Compiler feedback")).toBeTruthy();
    expect(screen.getByText("L3:C10")).toBeTruthy();
    expect(screen.getByText(/Type 'string' is not assignable/)).toBeTruthy();
    // 代码 / 日志 / 返回值分区。
    fireEvent.click(screen.getByText("Code"));
    expect(screen.getAllByText(/files\.glob/).length).toBeGreaterThan(0);
    expect(screen.getByText("glob matched 3 files")).toBeTruthy();
    expect(screen.queryByText("Return value")).toBeNull();
    // 折叠行：时长（1_250ms → "1.3s"，toFixed(1) 四舍五入）与 response 预览。
    expect(screen.queryByText("1250ms")).toBeNull();
  });

  it("keeps the completed summary free of PASS and result preview", () => {
    const context = buildContext(
      buildToolCall({
        toolName: "EvalWorkflowSnippet",
        kind: "EvalWorkflowSnippet",
        title: "EvalWorkflowSnippet",
        input: { code: "return 1;" },
        raw: {
          display: { ...SNIPPET_DISPLAY, ok: true, diagnostics: [], response: "1" },
        },
      }),
      { forceOpen: false },
    );
    renderCard(EvalWorkflowSnippetToolCallBlock, context);
    expect(screen.queryByText("PASS")).toBeNull();
    expect(screen.getByText("1250ms")).toBeTruthy();
    expect(screen.queryByText("1")).toBeNull();
  });

  it("falls back to response text without display", () => {
    const context = buildContext(
      buildToolCall({
        toolName: "EvalWorkflowSnippet",
        kind: "EvalWorkflowSnippet",
        title: "EvalWorkflowSnippet",
        input: { code: "return 1;" },
        output: "The snippet returned 1.",
      }),
    );
    renderCard(EvalWorkflowSnippetToolCallBlock, context);
    expect(screen.getAllByText("The snippet returned 1.").length).toBeGreaterThan(0);
    expect(screen.queryByText(/"toolId"/)).toBeNull();
  });
});

describe("observation card i18n key parity", () => {
  const PREFIXES = [
    "chat.toolCall.workflow.getRun.",
    "chat.toolCall.workflow.listRuns.",
    "chat.toolCall.workflow.snippet.",
  ] as const;

  it("zh-CN and en-US define identical key sets for the new namespaces", () => {
    for (const prefix of PREFIXES) {
      const zhKeys = Object.keys(zhCN)
        .filter((key) => key.startsWith(prefix))
        .sort();
      const enKeys = Object.keys(enUS)
        .filter((key) => key.startsWith(prefix))
        .sort();
      expect(zhKeys.length).toBeGreaterThan(0);
      expect(enKeys).toEqual(zhKeys);
    }
  });
});

// spec：docs/dynamic-workflow/presentation.md「The run card」。
// 恢复卡三件事：display 驱动（runId + 状态点词 + 本地化说明）、双语、无 display 文本兜底。
const RESUME_DISPLAY = {
  kind: "resume_workflow_run",
  runId: "dwfrun_resumed",
} as const;

function buildResumeToolCall(overrides: Record<string, unknown> = {}) {
  return buildToolCall({
    toolId: "tool-resume-run",
    toolName: "ResumeWorkflowRun",
    raw: { display: RESUME_DISPLAY },
    ...overrides,
  });
}

describe("ResumeWorkflowRunToolCallBlock", () => {
  it("renders the structured resume card from display payload", () => {
    renderCard(ResumeWorkflowRunToolCallBlock, buildContext(buildResumeToolCall()));
    expect(screen.getByText("Workflow run resumed")).toBeTruthy();
    expect(screen.getByText("dwfrun_resumed")).toBeTruthy();
    expect(screen.getByText("Running in background")).toBeTruthy();
    // 展开说明在场（replay / 重新派发 / 完成通知）。
    expect(screen.getByText(/replayed from the journal/u)).toBeTruthy();
  });

  it("renders the zh-CN card", () => {
    renderCard(ResumeWorkflowRunToolCallBlock, buildContext(buildResumeToolCall()), "zh-CN");
    expect(screen.getByText("工作流实例已恢复")).toBeTruthy();
    expect(screen.getByText("后台运行中")).toBeTruthy();
    expect(screen.getByText(/从 journal 重放/u)).toBeTruthy();
  });

  it("falls back to bounded text output when display is absent", () => {
    renderCard(
      ResumeWorkflowRunToolCallBlock,
      buildContext(
        buildResumeToolCall({
          raw: undefined,
          output: "The workflow run dwfrun_resumed has been resumed.",
        }),
      ),
    );
    expect(screen.getByText(/has been resumed/u)).toBeTruthy();
    // 文本兜底不是 JSON dump。
    expect(screen.queryByText(/\{"/u)).toBeNull();
  });
});

// run 态紧凑可点卡（spec「ResumeWorkflowRun 工具卡 display」二轮）：联接命中后复用
// CreateWorkflow 的紧凑卡（WorkflowRunCompactCard），标签换「已恢复」，整卡点击打开侧栏。
describe("ResumeWorkflowRunToolCallBlock run-state compact card", () => {
  const RESUME_RUN_SUMMARY = {
    runId: "dwfrun_resumed",
    status: "running" as const,
    nodesSettled: 2,
    nodesTotal: 5,
  };

  it("renders the shared compact card with resumed wording and live status", () => {
    const onOpenWorkflowRun = vi.fn();
    renderCard(
      ResumeWorkflowRunToolCallBlock,
      buildContext(buildResumeToolCall(), {
        workflowRun: RESUME_RUN_SUMMARY,
        onOpenWorkflowRun,
      }),
    );

    const card = screen.getByTestId("workflow-run-card");
    expect(card).toBeTruthy();
    expect(card.getAttribute("data-workflow-run-id")).toBe("dwfrun_resumed");
    // 标签是「已恢复」而不是 create 卡的「已启动」；runId 与实时状态/步数在场。
    expect(screen.getByText("Workflow run resumed")).toBeTruthy();
    expect(screen.getByText("dwfrun_resumed")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("2/5 steps")).toBeTruthy();
  });

  it("opens the side panel run view when the card is clicked", () => {
    const onOpenWorkflowRun = vi.fn();
    renderCard(
      ResumeWorkflowRunToolCallBlock,
      buildContext(buildResumeToolCall(), {
        workflowRun: RESUME_RUN_SUMMARY,
        onOpenWorkflowRun,
      }),
    );

    fireEvent.click(screen.getByTestId("workflow-run-card"));
    expect(onOpenWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("renders zh-CN wording on the compact card", () => {
    renderCard(
      ResumeWorkflowRunToolCallBlock,
      buildContext(buildResumeToolCall(), { workflowRun: RESUME_RUN_SUMMARY }),
      "zh-CN",
    );
    expect(screen.getByText("工作流实例已恢复")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("2/5 步")).toBeTruthy();
  });
});
