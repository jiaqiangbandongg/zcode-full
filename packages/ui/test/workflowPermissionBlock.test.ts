// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) =>
    createElement("pre", { "data-testid": "code-block" }, code),
}));

// ControlHintTooltip 依赖应用根部的 TooltipProvider；测试里按既有惯例替换为透传桩。
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

// eslint-disable-next-line import/first -- 必须在 mock 之后再引入被测组件。
import { PermissionDialog } from "@/PermissionDialog.js";

const SCRIPT = 'const x = 1;\nconst r = await agent("a").ask<string>("do");';
// CLI 侧的 ask reason 是协议诊断文案，确认窗必须不展示它。
const CLI_REASON = "createWorkflow.runConfirmation: user must confirm running the analyzed script";

const CAUSALITY_GRAPH = {
  steps: [
    {
      id: "ask#1",
      kind: "ask" as const,
      label: "a",
      line: 2,
      column: 21,
      lane: "actor#1",
    },
  ],
  lanes: [{ id: "actor#1", name: "a", line: 2, column: 11 }],
  // 参与者层：无标记脚本的卡归 `unphased`（UI 合成隐式模块）。
  participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
  sink: ["ask#1"],
};

const SESSION_OPTION = {
  optionId: "allowSession",
  kind: "allowAlways",
  name: "Always allow in this session",
  response: { decision: "allow" as const, reason: "Approved for this session" },
};

function buildWorkflowRequest(
  overrides: Partial<ZCodePermissionRequest> = {},
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId: "perm-workflow",
    description: CLI_REASON,
    kind: "CreateWorkflow",
    title: "CreateWorkflow",
    options: [
      {
        optionId: "allowOnce",
        kind: "allowOnce",
        name: "Allow",
        response: { decision: "allow" },
      },
      // 第 7 轮：会话免确认。v4 投影把 kind 映为 allowAlways，GUI 按 name 本地化。
      SESSION_OPTION,
      {
        optionId: "deny",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny" },
      },
    ],
    display: {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph: CAUSALITY_GRAPH,
    },
    raw: { name: "Research pipeline", script: SCRIPT },
    ...overrides,
  };
}

function renderDialog(
  request: ZCodePermissionRequest = buildWorkflowRequest(),
  locale: "en-US" | "zh-CN" = "en-US",
  onRespond: (requestId: string, option: unknown, feedback?: string) => void = () => {},
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(PermissionDialog, {
        request,
        onRespond,
        workspacePath: "/workspace",
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("WorkflowPermissionBlock", () => {
  it("renders the timeline as the primary body and keeps the script folded", () => {
    renderDialog();

    // 时间线（docs/dynamic-workflow/presentation.md「The confirmation window」）：无标记脚本是一个隐式站「Workflow」，
    // 药丸是那条车道的作者原名。没有放大入口、没有弹窗。
    const timeline = screen.getByTestId("workflow-timeline");
    expect(timeline.textContent).toContain("Workflow");
    expect(screen.getByTestId("workflow-agent-pill").textContent).toContain("a");
    expect(screen.queryByLabelText("Expand graph")).toBeNull();
    expect(screen.getByText("Research pipeline")).toBeTruthy();
    expect(screen.getByText("Run this workflow?")).toBeTruthy();
    // 表头右侧：静态状态 + 计数细节。
    expect(screen.getByTestId("workflow-card-detail").textContent).toBe("1 phase");

    // 脚本是审计细节层：默认收起，Radix Collapsible 关闭时内容不进 DOM。
    expect(screen.queryByTestId("code-block")).toBeNull();
    expect(document.body.textContent).not.toContain('await agent("a")');
    expect(screen.getByText("Show full script")).toBeTruthy();
  });

  it("renders the localized question in both locales", () => {
    renderDialog(buildWorkflowRequest(), "zh-CN");
    expect(screen.getByText("运行此工作流？")).toBeTruthy();
    expect(screen.getByText("显示完整脚本")).toBeTruthy();
    cleanup();

    renderDialog(buildWorkflowRequest(), "en-US");
    expect(screen.getByText("Run this workflow?")).toBeTruthy();
  });

  it("asks the question above the workflow name", () => {
    renderDialog();

    // 刻意的顺序：弹窗通用标题「需要权限」+ 问句连读才是完整提问，名称行是它下方那张图的标题。
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText.indexOf("Run this workflow?")).toBeGreaterThanOrEqual(0);
    expect(blockText.indexOf("Run this workflow?")).toBeLessThan(
      blockText.indexOf("Research pipeline"),
    );
  });

  it("shows the full script after the fold is toggled open", () => {
    renderDialog();

    fireEvent.click(screen.getByText("Show full script"));

    expect(screen.getByTestId("code-block").textContent).toContain('await agent("a")');
    expect(screen.getByText("Hide full script")).toBeTruthy();
  });

  // 长脚本不再把弹窗撑高：脚本区限高 + 滚动。
  it("bounds the script region with a max height and makes it scrollable", () => {
    renderDialog();

    fireEvent.click(screen.getByText("Show full script"));

    const scroller = screen.getByTestId("workflow-script-scroll");
    expect(scroller.className).toMatch(/max-h-/u);
    expect(scroller.className).toMatch(/overflow-auto/u);
  });

  it("opens the script by default when there is no graph to show", () => {
    renderDialog(
      buildWorkflowRequest({
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
      }),
    );

    expect(screen.queryByTestId("workflow-timeline")).toBeNull();
    // 零 step 脚本没有图可看，代码就是唯一内容。
    expect(screen.getByTestId("code-block").textContent).toContain('await agent("a")');
    expect(screen.getByText("Hide full script")).toBeTruthy();
  });

  it("treats a participant-less graph as no graph", () => {
    renderDialog(
      buildWorkflowRequest({
        display: {
          kind: "create_workflow",
          ok: true,
          errorCount: 0,
          diagnostics: [],
          causalityGraph: { steps: [], lanes: [], participants: [], handoffs: [] },
        },
      }),
    );

    expect(screen.queryByTestId("workflow-timeline")).toBeNull();
    expect(screen.getByTestId("code-block")).toBeTruthy();
  });

  it("degrades to an open script when the ask carries no preview at all", () => {
    // 失败路径：prepareApproval 抛错 → 无 preview 的普通 ask。gate 仍然成立，
    // 只是没有图，脚本就成了唯一可审计内容。
    renderDialog(buildWorkflowRequest({ display: undefined }));

    expect(screen.queryByTestId("workflow-timeline")).toBeNull();
    expect(screen.getByTestId("code-block").textContent).toContain('await agent("a")');
    expect(screen.getByText("Run this workflow?")).toBeTruthy();
  });

  it("renders header and question without crashing when the input has no script", () => {
    renderDialog(buildWorkflowRequest({ display: undefined, raw: { name: "Broken input" } }));

    expect(screen.getByText("Run this workflow?")).toBeTruthy();
    expect(screen.getByText("Broken input")).toBeTruthy();
    expect(screen.queryByTestId("code-block")).toBeNull();
    expect(screen.queryByText("Show full script")).toBeNull();
  });

  // ── 修订的确认窗（docs/dynamic-workflow/launch.md「The `AmendWorkflow` tool」；presentation.md
  // 「The confirmation window」）──只对别的会话的 run 出现：问句换词，多一行 lineage。事实从**工具
  // 入参**渲染（`run_id` 与 CLI 回填的 `predecessor`），display 一个字节都不变——图仍是 create_workflow。

  function buildAmendRequest(raw: Record<string, unknown>): ZCodePermissionRequest {
    return buildWorkflowRequest({
      kind: "AmendWorkflow",
      title: "AmendWorkflow",
      description: "amendWorkflow.runConfirmation: user must confirm running the revised script",
      raw,
    });
  }

  it("asks 'Amend this workflow?' with the lineage line for an AmendWorkflow ask", () => {
    renderDialog(
      buildAmendRequest({
        name: "Research pipeline",
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false },
      }),
    );

    expect(screen.getByTestId("workflow-card-kind").textContent).toBe("Amend this workflow?");
    expect(document.body.textContent).not.toContain("Run this workflow?");
    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage).toBeTruthy();
    expect(lineage?.textContent).toContain("Amends run");
    expect(lineage?.textContent).toContain("dwfrun-prev");
    // 前驱已结算：没有「将被停止」那一句。
    expect(lineage?.getAttribute("data-workflow-amends-live")).toBeNull();
    expect(lineage?.textContent).not.toContain("still running");
    // 图仍是主体，脚本仍是折叠的审计层：lineage 只是多一行。
    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    expect(screen.queryByTestId("code-block")).toBeNull();
  });

  it.each(["running", "pending"] as const)(
    "says the predecessor will be stopped when it is still in flight (%s)",
    (status) => {
      renderDialog(
        buildAmendRequest({
          script: SCRIPT,
          run_id: "dwfrun-live",
          predecessor: { status, owned_by_this_session: false },
        }),
      );

      const lineage = document.querySelector('[data-workflow-amends="true"]');
      expect(lineage?.getAttribute("data-workflow-amends-live")).toBe("true");
      expect(lineage?.textContent).toContain("still running, will be stopped");
    },
  );

  it("localizes the amend title and lineage", () => {
    renderDialog(
      buildAmendRequest({
        name: "Research pipeline",
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "running", owned_by_this_session: false },
      }),
      "zh-CN",
    );

    expect(screen.getByTestId("workflow-card-kind").textContent).toBe("调整此工作流？");
    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage?.textContent).toContain("调整 run");
    expect(lineage?.textContent).toContain("dwfrun-prev");
    expect(lineage?.textContent).toContain("仍在运行，将被停止");
  });

  // 省略 script 的修订（docs/dynamic-workflow/launch.md「Keeping the predecessor's script」）：CLI 已把
  // 前驱的脚本回填进入参并盖上 `predecessor.script_inherited`。窗上照常画图、照常可展开脚本——审的
  // 就是将要跑的那一份——lineage 行多说一句「脚本不变」，让用户知道这次改的只是设定。
  it("says 'script unchanged' on the lineage line when the amend keeps the predecessor's script", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        max_concurrency: 2,
        predecessor: { status: "running", owned_by_this_session: false, script_inherited: true },
      }),
    );

    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage?.getAttribute("data-workflow-amends-script-inherited")).toBe("true");
    expect(lineage?.textContent).toContain("dwfrun-prev");
    expect(lineage?.textContent).toContain("script unchanged");
    expect(lineage?.textContent).toContain("still running, will be stopped");
    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    expect(screen.getByText("Show full script")).toBeTruthy();
    expect(screen.getByTestId("workflow-permission-max-concurrency").textContent).toBe(
      "At most 2 subagents at once",
    );
  });

  it("says nothing about the script when the amend passes one", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false },
      }),
    );

    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage?.getAttribute("data-workflow-amends-script-inherited")).toBeNull();
    expect(lineage?.textContent).not.toContain("script unchanged");
  });

  it("localizes 'script unchanged'", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false, script_inherited: true },
      }),
      "zh-CN",
    );

    const lineage = document.querySelector('[data-workflow-amends="true"]');
    expect(lineage?.textContent).toContain("脚本不变");
  });

  it("omits the lineage line entirely for a CreateWorkflow ask", () => {
    // CreateWorkflow 没有前驱（也不再有 resume_from）：不留空行、不留占位词、问句照旧。
    renderDialog();

    expect(screen.getByTestId("workflow-card-kind").textContent).toBe("Run this workflow?");
    expect(document.querySelector('[data-workflow-amends="true"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Amends run");
  });

  it("ignores a blank run_id instead of rendering an empty lineage", () => {
    renderDialog(buildAmendRequest({ script: SCRIPT, run_id: "  " }));

    expect(document.querySelector('[data-workflow-amends="true"]')).toBeNull();
  });

  // ── 并发上限（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）──
  // 模型只在用户要求时才写 `max_concurrency`，所以这一行在场就是用户自己提的条件。
  // 与 lineage 同一条纪律：事实从**工具入参**读，display 一个字节都不变。

  function queryMaxConcurrency(): HTMLElement | null {
    return screen.queryByTestId("workflow-permission-max-concurrency");
  }

  it("says how many subagents may run at once when the input carries max_concurrency", () => {
    renderDialog(
      buildWorkflowRequest({
        raw: { name: "Research pipeline", script: SCRIPT, max_concurrency: 3 },
      }),
    );

    expect(queryMaxConcurrency()?.textContent).toBe("At most 3 subagents at once");
  });

  it("shows the same row for an AmendWorkflow ask, right after the lineage row", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false },
        max_concurrency: 2,
      }),
    );

    expect(queryMaxConcurrency()?.textContent).toBe("At most 2 subagents at once");
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText.indexOf("Amends run")).toBeLessThan(blockText.indexOf("At most 2"));
  });

  it("localizes the row", () => {
    renderDialog(buildWorkflowRequest({ raw: { script: SCRIPT, max_concurrency: 4 } }), "zh-CN");

    expect(queryMaxConcurrency()?.textContent).toBe("最多 4 个子代理同时运行");
  });

  it.each([
    ["omitted", {}],
    // 修订的 `null` = 去掉上限：没有上限可说，与缺席同处理。
    ["null (the amend 'remove the limit' value)", { max_concurrency: null }],
    ["not a positive integer", { max_concurrency: 0 }],
    ["not an integer", { max_concurrency: 2.5 }],
  ])("renders no row when max_concurrency is %s", (_case, extra) => {
    renderDialog(buildWorkflowRequest({ raw: { script: SCRIPT, ...extra } }));

    expect(queryMaxConcurrency()).toBeNull();
    expect(document.body.textContent).not.toContain("subagents at once");
  });

  // ── 子代理模型（docs/dynamic-workflow/presentation.md）──
  // 模型只在用户开口要求时才写 `subagent_model`，所以这一行在场就是用户自己提的条件。
  // 到窗前的值已被 CLI 的 resolveInput 解析成规范串 `providerId/modelId[$level]`——但规范串是
  // 给机器回填用的：屏幕上说模型名与强度词，规范串只住在这一行的 tooltip 里。

  // 团队套餐的 provider id 是一串十六进制：这次改动要挡的就是它。
  const TEAM_PLAN_MODEL = "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high";

  function querySubagentModel(): HTMLElement | null {
    return screen.queryByTestId("workflow-permission-subagent-model");
  }

  it("says which model the subagents run on, by name and not by canonical string", () => {
    renderDialog(
      buildWorkflowRequest({
        raw: {
          name: "Research pipeline",
          script: SCRIPT,
          subagent_model: "zhipu/glm-5.3-flash",
        },
      }),
    );

    expect(querySubagentModel()?.textContent).toBe("Subagents run on glm-5.3-flash");
  });

  it("never shows the provider id, even when it is a team-plan UUID", () => {
    renderDialog(
      buildWorkflowRequest({ raw: { script: SCRIPT, subagent_model: TEAM_PLAN_MODEL } }),
    );

    const row = querySubagentModel();
    expect(row?.textContent).toContain("GLM-5.3-Flash");
    expect(row?.textContent).not.toContain("4fc7f541");
    // 规范串没有丢，它在 tooltip 里——回填与排障都还读得到。
    expect(row?.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
  });

  it("keeps the reasoning level, as a word: the level is part of the choice being approved", () => {
    renderDialog(
      buildWorkflowRequest({ raw: { script: SCRIPT, subagent_model: "anthropic/opus-5$high" } }),
    );

    expect(querySubagentModel()?.textContent).toBe("Subagents run on opus-5 · thinking High");
  });

  // 与可调的两句同一个次序（docs/dynamic-workflow/presentation.md「The confirmation window」）：模型在上、上界在下。
  it("sits directly above the concurrency row, and shows on an AmendWorkflow ask too", () => {
    renderDialog(
      buildAmendRequest({
        script: SCRIPT,
        run_id: "dwfrun-prev",
        predecessor: { status: "completed", owned_by_this_session: false },
        max_concurrency: 2,
        subagent_model: "zhipu/glm-5.3-flash",
      }),
    );

    expect(querySubagentModel()?.textContent).toBe("Subagents run on glm-5.3-flash");
    const blockText =
      document.querySelector('[data-workflow-permission-block="true"]')?.textContent ?? "";
    expect(blockText.indexOf("Subagents run on")).toBeLessThan(blockText.indexOf("At most 2"));
  });

  it("localizes the subagent-model row, leaving the model name untranslated", () => {
    renderDialog(
      buildWorkflowRequest({ raw: { script: SCRIPT, subagent_model: "anthropic/opus-5$high" } }),
      "zh-CN",
    );

    expect(querySubagentModel()?.textContent).toBe("子代理运行在 opus-5 · 思考 高");
  });

  it.each([
    ["omitted", {}],
    // 修订的 `null` = 退回会话模型：没有第二个模型可说，与缺席同处理。
    ["null (the amend 'back to the session model' value)", { subagent_model: null }],
    ["blank", { subagent_model: "   " }],
    ["not a string", { subagent_model: { providerId: "zhipu", modelId: "glm-5.3-flash" } }],
  ])("renders no row when subagent_model is %s", (_case, extra) => {
    renderDialog(buildWorkflowRequest({ raw: { script: SCRIPT, ...extra } }));

    expect(querySubagentModel()).toBeNull();
    expect(document.body.textContent).not.toContain("Subagents run on");
  });

  it("never paints the waiting ask with the success color, and says nothing about compiling", () => {
    renderDialog();

    // DESIGN.md 把绿色留给等待确认态。表头曾有一枚「compiled」空环灯；2026-09-09 起去掉——
    // 能走到确认窗就说明脚本过了校验，这个词对用户没有信息量。
    expect(document.body.innerHTML).not.toContain("text-success");
    expect(screen.queryByTestId("workflow-card-static-status")).toBeNull();
    expect(document.body.textContent).not.toContain("compiled");
  });
});

describe("PermissionDialog workflow dispatch", () => {
  it("renders the workflow block instead of the fallback JSON dump", () => {
    renderDialog();

    expect(document.querySelector('[data-workflow-permission-block="true"]')).toBeTruthy();
    expect(document.body.textContent).not.toContain('"script"');
    expect(document.body.textContent).not.toContain("toolName");
  });

  it("suppresses the diagnostic CLI reason", () => {
    renderDialog();

    expect(document.body.textContent).not.toContain(CLI_REASON);
    expect(document.body.textContent).not.toContain("createWorkflow.runConfirmation");
  });

  it("renders Run / Always allow in this session / Deny, in that order", () => {
    renderDialog();

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options.map((option) => option.getAttribute("data-permission-option-kind"))).toEqual([
      "allowOnce",
      "allowAlways",
      "rejectOnce",
    ]);
    expect(document.body.textContent).toContain("Allow");
    expect(document.body.textContent).toContain("Deny");
  });

  // 会话免确认（docs/dynamic-workflow/launch.md「Always allow in this session」）：name 命中本地化，描述不沿用项目级文案。
  it.each([
    ["en-US", "Always allow in this session", "Do not ask again for workflows in this session"],
    ["zh-CN", "本会话内始终允许", "本会话内运行工作流不再询问"],
  ] as const)("localizes the session option in %s", (locale, label, description) => {
    renderDialog(buildWorkflowRequest(), locale);

    const option = document.querySelector('[data-permission-option-kind="allowAlways"]')!;
    expect(option.textContent).toContain(label);
    expect(option.textContent).toContain(description);
    expect(option.textContent).not.toContain("same permission request");
    expect(option.textContent).not.toContain("相同权限请求");
  });

  it("clicking the session option responds with optionId allowSession and no feedback", () => {
    const onRespond = vi.fn();
    renderDialog(buildWorkflowRequest(), "en-US", onRespond);

    const session = document.querySelector('[data-permission-option-kind="allowAlways"]')!;
    // 未选中的选项第一次点击只做选中，第二次点击应答（既有语义）。
    fireEvent.click(session);
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(session);

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith(
      "perm-workflow",
      expect.objectContaining({ optionId: "allowSession" }),
      undefined,
    );
  });

  it("the session option is not rendered when the CLI does not offer it (no-always-allow tools)", () => {
    const base = buildWorkflowRequest();
    renderDialog({
      ...base,
      options: base.options.filter((option) => option.optionId !== "allowSession"),
    });

    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(document.querySelectorAll('[data-permission-option-kind="allowAlways"]')).toHaveLength(
      0,
    );
  });

  it("still renders the graph when the ask carries no workflow name", () => {
    renderDialog(buildWorkflowRequest({ raw: { script: SCRIPT } }));

    expect(screen.getByTestId("workflow-timeline")).toBeTruthy();
    // 名称缺失时回退到聊天区同一兜底名。
    expect(screen.getByText("Workflow script")).toBeTruthy();
  });
});

// ── Refine 选项（docs/dynamic-workflow/launch.md「Refine」）──
// v4 投影对 CreateWorkflow 追加第三选项 workflowRefine；GUI 不把它画成按钮，而是复用其他
// 确认窗同一行编号的行内反馈输入行，提交把 freeText 连同该选项交给应答。

const REFINE_OPTION = {
  optionId: "workflowRefine",
  kind: "custom",
  name: "Refine",
  response: { decision: "deny" as const, reason: "Denied" },
};

function buildRefineRequest(): ZCodePermissionRequest {
  const base = buildWorkflowRequest();
  return { ...base, options: [...base.options, REFINE_OPTION] };
}

function queryRefineInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(
    '[data-permission-feedback-option="workflowRefine"]',
  );
}

describe("PermissionDialog workflow refine", () => {
  it("Refine 渲染为紧随 Run/Deny 的编号反馈行，而不是第三个选项按钮", () => {
    renderDialog(buildRefineRequest(), "en-US");

    // 只有 Run / Session / Deny 三个 option 按钮；Refine 不占 listbox 位置。
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(screen.queryByRole("option", { name: "Refine" })).toBeNull();

    const input = queryRefineInput();
    expect(input).toBeTruthy();
    expect(input!.closest('[role="listbox"]')).toBeNull();
    // 与通用反馈行同一结构：编号 + textarea，编号紧随三个按钮之后（第 7 轮起顺延为 4）。
    expect(input!.previousElementSibling?.textContent).toBe("4.");
    expect(input!.placeholder).toBe("Describe how the workflow should change…");
    expect(input!.getAttribute("aria-label")).toBe("Refine");
    // 通用「拒绝并附反馈」行不再额外出现：Refine 就是这个窗的反馈行。
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it.each(["Enter", "confirm"])(
    "通过 %s 提交把 trim 后的 freeText 连同 Refine 选项交给 onRespond；空白禁发",
    (method) => {
      const onRespond = vi.fn();
      renderDialog(buildRefineRequest(), "en-US", onRespond);
      const input = queryRefineInput()!;
      const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;

      act(() => input.focus());
      // 空白：确认按钮禁用，Enter 也不产生应答。
      fireEvent.change(input, { target: { value: "   " } });
      expect(confirm.disabled).toBe(true);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onRespond).not.toHaveBeenCalled();

      fireEvent.change(input, { target: { value: " 只保留三个 finder " } });
      expect(confirm.disabled).toBe(false);
      if (method === "Enter") fireEvent.keyDown(input, { key: "Enter" });
      else fireEvent.click(confirm);

      expect(onRespond).toHaveBeenCalledTimes(1);
      expect(onRespond).toHaveBeenCalledWith(
        "perm-workflow",
        expect.objectContaining({ optionId: "workflowRefine" }),
        // 提交前 trim：CLI broker 对空白 freeText 落普通 deny，不能把纯空白当反馈。
        "只保留三个 finder",
      );
    },
  );

  it("Esc 只让输入行失焦并保留草稿（同通用反馈行，不再收起什么）", () => {
    const onRespond = vi.fn();
    renderDialog(buildRefineRequest(), "en-US", onRespond);
    const input = queryRefineInput()!;

    act(() => input.focus());
    fireEvent.change(input, { target: { value: "先跑 lint 再 fan out" } });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
    expect(queryRefineInput()!.value).toBe("先跑 lint 再 fan out");
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("方向键在 Run / Session / Deny 与 Refine 行之间循环，数字 4 直达 Refine 行", async () => {
    renderDialog(buildRefineRequest(), "en-US");
    const options = screen.getAllByRole("option");
    const input = queryRefineInput()!;
    const row = input.parentElement!;

    await waitFor(() => {
      expect(document.activeElement).toBe(options[0]);
    });
    fireEvent.keyDown(options[0]!, { key: "ArrowUp" });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    expect(row.classList.contains("bg-selected")).toBe(true);
    expect(options.every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => {
      expect(document.activeElement).toBe(options[0]);
    });
    expect(row.classList.contains("bg-selected")).toBe(false);

    fireEvent.keyDown(options[0]!, { key: "4" });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it("Run / Deny 的即时应答语义不受 Refine 行影响；Deny 不携带 Refine 草稿", () => {
    const onRespond = vi.fn();
    renderDialog(buildRefineRequest(), "en-US", onRespond);

    // 草稿属于 Refine：点 Deny 就是普通拒绝，不能让修改意见以普通拒绝理由的身份发出。
    const input = queryRefineInput()!;
    fireEvent.change(input, { target: { value: "把 fan out 改成串行" } });

    const deny = screen.getByRole("option", { name: "Deny" });
    // 未选中的选项第一次点击只做选中，第二次点击应答（既有语义）。
    fireEvent.click(deny);
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(deny);
    expect(onRespond).toHaveBeenCalledWith(
      "perm-workflow",
      expect.objectContaining({ optionId: "deny" }),
      undefined,
    );
  });

  it("双语渲染 Refine 行文案", () => {
    renderDialog(buildRefineRequest(), "zh-CN");
    expect(queryRefineInput()!.placeholder).toBe("描述这个工作流应该怎么改…");
    expect(queryRefineInput()!.getAttribute("aria-label")).toBe("提出修改");
    cleanup();

    renderDialog(buildRefineRequest(), "en-US");
    expect(queryRefineInput()!.placeholder).toBe("Describe how the workflow should change…");
  });
});
