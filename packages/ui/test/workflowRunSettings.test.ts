// 「配置」的纯规则（docs/dynamic-workflow/presentation.md「The settings popover」「The settings turn」；
// 命令见 docs/dynamic-workflow/launch.md「Changing a run's settings from the GUI」）：哪些 run 能配、
// 表单起点、Apply 发什么、被拒说哪句话、转写行与来龙去脉的措辞、借图规则与侧栏 tab 的原地替换。
import { describe, expect, it } from "vitest";
import type { WorkflowRunState, WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import {
  clampWorkflowRunSettingsBound,
  describeWorkflowRunSettingsRejection,
  initialWorkflowRunSettingsDraft,
  isWorkflowRunConfigurable,
  workflowRunDefaultConcurrency,
  workflowRunSettingsChange,
  workflowRunSettingsConsequenceId,
  workflowRunSettingsRejectionDetail,
  workflowRunSettingsRejectionMessageId,
  workflowSessionModelOf,
  type WorkflowRunSettingsDraft,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import {
  workflowSettingsChangeSegments,
  workflowSettingsProvenanceRows,
} from "@/components/workflow-timeline/workflowSettingsChange.js";
import {
  openWorkflowRunSidePane,
  replaceWorkflowRunSidePane,
  type WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { resolveWorkflowRunGraph } from "@/v4/workflowRunCardJoin.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

function run(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "run-a",
    toolCallId: "tool-a",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}

/** 与 ZCodeIntlProvider 同一个替换规则（`{name}` 直接替换）。 */
function formatterFor(messages: Record<string, string>) {
  return (descriptor: { id: string }, values?: Record<string, string | number>) => {
    let text = messages[descriptor.id] ?? descriptor.id;
    for (const [key, value] of Object.entries(values ?? {})) {
      text = text.replaceAll(`{${key}}`, String(value));
    }
    return text;
  };
}

describe("isWorkflowRunConfigurable", () => {
  it.each([
    ["pending", run({ status: "pending" }), true],
    ["running", run(), true],
    ["errored（换个模型重试）", run({ status: "errored" }), true],
    ["stopped（可恢复）", run({ status: "stopped", stopReason: "user", resumable: true }), true],
    [
      "stopped · superseded（活的是后继）",
      run({ status: "stopped", stopReason: "superseded", supersededBy: "run-b" }),
      false,
    ],
    ["completed（每个 ask 都会从缓存重放）", run({ status: "completed" }), false],
    ["不在投影里", undefined, false],
  ] as const)("%s", (_case, state, expected) => {
    expect(isWorkflowRunConfigurable(state)).toBe(expected);
  });
});

describe("表单起点", () => {
  it("两项都取 run 自己的设置：模型拆出思考档，上限取本 run 的界", () => {
    const draft = initialWorkflowRunSettingsDraft(
      run({
        subagentModel: "zhipu/glm-5.3$high",
        concurrencyCeiling: 13,
        concurrency: { cap: 13, ceiling: 13, limit: 4 },
      }),
    );
    expect(draft).toEqual({
      model: { kind: "model", providerId: "zhipu", modelId: "glm-5.3", level: "high" },
      bound: 4,
    });
  });

  it("没指定过模型 = 会话模型；没有自己的界 = 停在默认上；默认也未知 = null", () => {
    expect(initialWorkflowRunSettingsDraft(run({ concurrencyCeiling: 13 }))).toEqual({
      model: { kind: "session" },
      bound: 13,
    });
    expect(initialWorkflowRunSettingsDraft(run()).bound).toBeNull();
  });

  it("默认并发只读 run.concurrencyCeiling：老 CLI 芯片的水位是学到的 cap，不是默认，不拿来顶替", () => {
    expect(workflowRunDefaultConcurrency(run({ concurrencyCeiling: 12 }))).toBe(12);
    expect(
      workflowRunDefaultConcurrency(run({ concurrency: { cap: 2, ceiling: 2, limit: 1 } })),
    ).toBeUndefined();
    expect(workflowRunDefaultConcurrency(run())).toBeUndefined();
  });

  it("有自己的界、且高于默认：起点就是那个界", () => {
    expect(
      initialWorkflowRunSettingsDraft(
        run({ concurrencyCeiling: 8, concurrency: { cap: 8, ceiling: 8, limit: 20 } }),
      ).bound,
    ).toBe(20);
  });
});

describe("workflowRunSettingsChange：只发改过的", () => {
  const initial: WorkflowRunSettingsDraft = {
    model: { kind: "model", providerId: "zhipu", modelId: "glm-5.3", level: "high" },
    bound: 4,
  };

  it("两项都没变 → 没有可发的（Apply 禁用）", () => {
    expect(workflowRunSettingsChange(initial, { ...initial }, 13)).toBeUndefined();
  });

  it("只改上限：省略模型", () => {
    expect(workflowRunSettingsChange(initial, { ...initial, bound: 2 }, 13)).toEqual({
      maxConcurrency: 2,
    });
  });

  it("上限到默认 = 解除本 run 自己的界：发 null", () => {
    expect(workflowRunSettingsChange(initial, { ...initial, bound: 13 }, 13)).toEqual({
      maxConcurrency: null,
    });
  });

  it("默认之上是一个真的数：原样发出去，不是解除", () => {
    expect(workflowRunSettingsChange(initial, { ...initial, bound: 40 }, 13)).toEqual({
      maxConcurrency: 40,
    });
    const raised: WorkflowRunSettingsDraft = { model: { kind: "session" }, bound: 40 };
    expect(workflowRunSettingsChange(raised, { ...raised, bound: 13 }, 13)).toEqual({
      maxConcurrency: null,
    });
  });

  it("起点就在默认上，停在那里不算改", () => {
    const atCeiling: WorkflowRunSettingsDraft = { model: { kind: "session" }, bound: 13 };
    expect(workflowRunSettingsChange(atCeiling, { ...atCeiling }, 13)).toBeUndefined();
  });

  it("换模型发规范串；只换思考档也算换了模型", () => {
    expect(
      workflowRunSettingsChange(
        initial,
        { ...initial, model: { kind: "model", providerId: "zhipu", modelId: "glm-5.3-flash" } },
        13,
      ),
    ).toEqual({ subagentModel: "zhipu/glm-5.3-flash" });
    expect(
      workflowRunSettingsChange(
        initial,
        {
          ...initial,
          model: { kind: "model", providerId: "zhipu", modelId: "glm-5.3", level: "low" },
        },
        13,
      ),
    ).toEqual({ subagentModel: "zhipu/glm-5.3$low" });
  });

  it("回到会话模型：发 null；两项一起改就一起发", () => {
    expect(
      workflowRunSettingsChange(initial, { model: { kind: "session" }, bound: 6 }, 13),
    ).toEqual({ subagentModel: null, maxConcurrency: 6 });
  });

  it("默认未知时数就是数，不会被读成解除", () => {
    expect(workflowRunSettingsChange(initial, { ...initial, bound: 40 }, undefined)).toEqual({
      maxConcurrency: 40,
    });
  });

  it("步进器只有下限 1、没有上限：默认是起点不是天花板", () => {
    expect(clampWorkflowRunSettingsBound(0)).toBe(1);
    expect(clampWorkflowRunSettingsBound(20)).toBe(20);
    expect(clampWorkflowRunSettingsBound(2.7)).toBe(2);
    expect(clampWorkflowRunSettingsBound(500)).toBe(500);
  });
});

describe("后果句与拒绝", () => {
  const en = formatterFor(enUS);
  const zh = formatterFor(zhCN);

  const modelChange = { subagentModel: "zhipu/glm-5.3" };

  it("后果句随 run 状态换；running 的中文是用户定下的原句", () => {
    expect(zh({ id: workflowRunSettingsConsequenceId("running", modelChange)! })).toBe(
      "将停止当前运行，以新设置另起一次运行，已完成的步骤会保留。",
    );
    expect(en({ id: workflowRunSettingsConsequenceId("pending", modelChange)! })).toBe(
      "Starts a new run with these settings; this one has not begun any step yet.",
    );
    expect(zh({ id: workflowRunSettingsConsequenceId("stopped", modelChange)! })).toBe(
      "将以新设置另起一次运行接着跑，已完成的步骤会保留。",
    );
    expect(en({ id: workflowRunSettingsConsequenceId("errored", modelChange)! })).toBe(
      "Retries as a new run with these settings; finished steps are kept.",
    );
  });

  // 什么都还没改：Apply 禁用，没有后果可说；这时念任何一句都是替还没做的改动下结论
  // （原先 running 念「将停止当前运行」，而只改并发恰恰不会停）。
  it.each(["running", "pending", "stopped", "errored"] as const)(
    "%s 的 run 什么都还没改：没有后果句",
    (status) => {
      expect(workflowRunSettingsConsequenceId(status, undefined)).toBeUndefined();
    },
  );

  // 只改并发上限、而且 run 正在跑：就地生效（docs/dynamic-workflow/concurrency.md）——这一句不能再
  // 念「将停止当前运行」，那是它唯一说错话的场景。
  it("在跑的 run 只改并发上限：后果句换成「就地生效」", () => {
    expect(zh({ id: workflowRunSettingsConsequenceId("running", { maxConcurrency: 3 })! })).toBe(
      "立即应用到当前运行，不会新起一次运行。",
    );
    expect(en({ id: workflowRunSettingsConsequenceId("running", { maxConcurrency: null })! })).toBe(
      "Applies to this run right away; no new run is started.",
    );
  });

  it.each([
    ["还改了模型", "running" as const, { maxConcurrency: 3, subagentModel: "zhipu/glm-5.3" }],
    ["只改了模型", "running" as const, { subagentModel: null }],
  ])("%s：仍是「另起一次运行」的原句", (_case, status, change) => {
    expect(workflowRunSettingsConsequenceId(status, change)).toBe(
      "chat.toolCall.workflow.run.settings.consequence.running",
    );
  });

  it.each([
    ["pending", "pending" as const],
    ["stopped", "stopped" as const],
    ["errored", "errored" as const],
  ])("%s 的 run 不在飞：就地生效无从谈起，仍念各自的原句", (_case, status) => {
    expect(workflowRunSettingsConsequenceId(status, { maxConcurrency: 3 })).toBe(
      `chat.toolCall.workflow.run.settings.consequence.${status}`,
    );
  });

  it("词表内的 reason 反查成一句话；compile_failed 的诊断进细节块", () => {
    const rejection = describeWorkflowRunSettingsRejection({
      status: "rejected",
      reasonCode: "fault.command.workflowRunSettingsRejected.compile_failed",
      message: "L3:C1 boom",
    });
    expect(rejection).toEqual({
      reason: "compile_failed",
      code: "fault.command.workflowRunSettingsRejected.compile_failed",
      message: "L3:C1 boom",
    });
    expect(workflowRunSettingsRejectionDetail(rejection!)).toBe("L3:C1 boom");
    expect(en({ id: workflowRunSettingsRejectionMessageId(rejection!) })).toContain(
      "no longer compiles",
    );
  });

  it("start_failed 的原因嵌进那句话，不再重复一个细节块", () => {
    const rejection = describeWorkflowRunSettingsRejection({
      status: "rejected",
      reasonCode: "fault.command.workflowRunSettingsRejected.start_failed",
      message: "port gone",
    })!;
    expect(workflowRunSettingsRejectionDetail(rejection)).toBeUndefined();
    expect(
      en({ id: workflowRunSettingsRejectionMessageId(rejection) }, { message: "port gone" }),
    ).toBe("The new run could not be started (port gone).");
  });

  it("能力缺席 → unsupported；词表外 → generic 带 code；accepted / noop 不是拒绝", () => {
    expect(
      describeWorkflowRunSettingsRejection({
        status: "rejected",
        reasonCode: "fault.command.capabilityUnsupported",
      })?.reason,
    ).toBe("unsupported");
    const generic = describeWorkflowRunSettingsRejection({
      status: "failed",
      reasonCode: "fault.command.workflowRunSettingsRejected.bogus",
    })!;
    expect(generic.reason).toBe("generic");
    expect(zh({ id: workflowRunSettingsRejectionMessageId(generic) }, { code: generic.code })).toBe(
      "设置没能调整（fault.command.workflowRunSettingsRejected.bogus）。",
    );
    expect(describeWorkflowRunSettingsRejection({ status: "accepted" })).toBeUndefined();
    expect(describeWorkflowRunSettingsRejection({ status: "noop" })).toBeUndefined();
  });

  it("每个 reason 在两种语言里都有词条", () => {
    for (const reason of [
      "not_found",
      "not_configurable",
      "unchanged",
      "script_missing",
      "model_unavailable",
      "compile_failed",
      "missing_boundaries",
      "start_failed",
      "unsupported",
      "generic",
    ]) {
      const id = `chat.toolCall.workflow.run.settings.rejection.${reason}`;
      expect(enUS[id], id).toBeTruthy();
      expect(zhCN[id], id).toBeTruthy();
    }
  });
});

describe("会话模型", () => {
  it("优先持久的稀疏选择，退回 provider / model 投影，都读不出即缺席", () => {
    expect(
      workflowSessionModelOf({
        modelSelection: { providerId: "zhipu", modelId: "glm-5.3" },
        provider: "x",
        model: "y",
      }),
    ).toEqual({ providerId: "zhipu", modelId: "glm-5.3" });
    expect(workflowSessionModelOf({ provider: "zhipu", model: "glm-5.3" })).toEqual({
      providerId: "zhipu",
      modelId: "glm-5.3",
    });
    expect(workflowSessionModelOf({ provider: "", model: "" })).toBeUndefined();
    expect(workflowSessionModelOf(undefined)).toBeUndefined();
  });
});

describe("设置轮的措辞", () => {
  const both: WorkflowSettingsAmendMeta = {
    predecessorRunId: "run-a",
    subagentModel: { from: "zhipu/glm-5.3", to: "zhipu/glm-5.3-flash$high" },
    maxConcurrency: { to: 4 },
    ceiling: 13,
  };

  it("转写行：模型在前、上限在后，只写改过的；英文与中文", () => {
    expect(workflowSettingsChangeSegments(both, { formatMessage: formatterFor(enUS) })).toEqual([
      "subagents on glm-5.3-flash",
      "at most 4 at once",
    ]);
    expect(workflowSettingsChangeSegments(both, { formatMessage: formatterFor(zhCN) })).toEqual([
      "子代理改用 glm-5.3-flash",
      "最多 4 个同时运行",
    ]);
  });

  it("回到会话模型 / 解除上限（to 缺席或等于默认）各有自己的话", () => {
    const reset: WorkflowSettingsAmendMeta = {
      predecessorRunId: "run-a",
      subagentModel: { from: "zhipu/glm-5.3" },
      maxConcurrency: { from: 4, to: 13 },
      ceiling: 13,
    };
    expect(workflowSettingsChangeSegments(reset, { formatMessage: formatterFor(zhCN) })).toEqual([
      "子代理改回会话模型",
      "上限恢复为默认",
    ]);
    expect(
      workflowSettingsChangeSegments(
        { predecessorRunId: "run-a", maxConcurrency: { from: 4 } },
        { formatMessage: formatterFor(enUS) },
      ),
    ).toEqual(["limit back to the default"]);
  });

  it("高于默认的上限念它自己的数", () => {
    expect(
      workflowSettingsChangeSegments(
        { maxConcurrency: { to: 40 }, ceiling: 13 },
        { formatMessage: formatterFor(zhCN) },
      ),
    ).toEqual(["最多 40 个同时运行"]);
  });

  it("来龙去脉：每项一行「from → to」，缺席的一端写默认，默认已知时带数字", () => {
    expect(workflowSettingsProvenanceRows(both, { formatMessage: formatterFor(enUS) })).toEqual([
      { key: "model", label: "Subagent model", value: "glm-5.3 → glm-5.3-flash" },
      { key: "limit", label: "Max concurrency", value: "default 13 → 4" },
    ]);
    expect(
      workflowSettingsProvenanceRows(
        {
          predecessorRunId: "run-a",
          subagentModel: { to: "zhipu/glm-5.3" },
          maxConcurrency: { from: 2 },
        },
        { formatMessage: formatterFor(zhCN) },
      ),
    ).toEqual([
      { key: "model", label: "子代理模型", value: "会话模型 → glm-5.3" },
      { key: "limit", label: "最大并发数", value: "2 → 默认" },
    ]);
    // 高于默认的一端念数，不再被当成「本机上限」。
    expect(
      workflowSettingsProvenanceRows(
        { maxConcurrency: { from: 40 }, ceiling: 13 },
        { formatMessage: formatterFor(zhCN) },
      ),
    ).toEqual([{ key: "limit", label: "最大并发数", value: "40 → 默认 13" }]);
  });

  it("两处的词条键集在两种语言下一致", () => {
    for (const prefix of [
      "chat.toolCall.workflow.settingsChange.",
      "chat.workflowLaunch.settings",
    ]) {
      const en = Object.keys(enUS).filter((key) => key.startsWith(prefix));
      const zh = Object.keys(zhCN).filter((key) => key.startsWith(prefix));
      expect(en.length).toBeGreaterThan(0);
      expect(en).toEqual(zh);
    }
  });
});

describe("resolveWorkflowRunGraph：只有「配置」出来的 run 借前驱的图", () => {
  const GRAPH = { steps: [{ id: "ask#1" }] } as never;
  const graphs = new Map([["tool-a", GRAPH]]);
  const runs = [
    run({ runId: "run-a", toolCallId: "tool-a", status: "stopped", supersededBy: "run-b" }),
    run({ runId: "run-b", toolCallId: "settings-1", resumedFrom: "run-a" }),
    run({ runId: "run-c", toolCallId: "settings-2", resumedFrom: "run-b" }),
    run({ runId: "run-d", toolCallId: "tool-amend", resumedFrom: "run-a" }),
  ];

  it("自己的图在行窗口里就用自己的", () => {
    expect(resolveWorkflowRunGraph(graphs, "tool-a", runs)).toBe(GRAPH);
  });

  it("设置轮还没落地：经 resumedFrom 借前驱的图，链上多次「配置」也一路借到", () => {
    expect(resolveWorkflowRunGraph(graphs, "settings-1", runs)).toBe(GRAPH);
    expect(resolveWorkflowRunGraph(graphs, "settings-2", runs)).toBe(GRAPH);
  });

  it("改过脚本的修订（AmendWorkflow 行）不借：它画的是另一张图", () => {
    expect(resolveWorkflowRunGraph(graphs, "tool-amend", runs)).toBeUndefined();
  });

  it("前驱不在投影里 / 链成环时不借也不死循环", () => {
    expect(resolveWorkflowRunGraph(new Map(), "settings-1", runs)).toBeUndefined();
    const loop = [
      run({ runId: "x", toolCallId: "settings-x", resumedFrom: "y" }),
      run({ runId: "y", toolCallId: "settings-y", resumedFrom: "x" }),
    ];
    expect(resolveWorkflowRunGraph(new Map(), "settings-x", loop)).toBeUndefined();
  });
});

describe("replaceWorkflowRunSidePane：面板跟着工作流走", () => {
  const base = {
    workspaceKey: "/w",
    workspacePath: "/w",
    parentSessionId: "parent-a",
  };

  function withTabs() {
    const first = openWorkflowRunSidePane(null, {
      ...base,
      toolCallId: "tool-a",
      runId: "run-a",
      workflowName: "Fan-out review",
    });
    const stamped = {
      ...first,
      tabs: first.tabs.map((tab) => ({ ...tab, ownerTaskId: "task-1" })),
    };
    return openWorkflowRunSidePane(
      openWorkflowRunSidePane(stamped, { ...base, toolCallId: "tool-z", runId: "run-z" }),
      { ...base, toolCallId: "tool-a", runId: "run-a" },
    );
  }

  it("原地换成新 run 的 tab：同一个位置、沿用名字与归属，原来是活动 tab 就还是活动 tab", () => {
    const state = withTabs();
    const next = replaceWorkflowRunSidePane(state, {
      ...base,
      toolCallId: "settings-1",
      runId: "run-b",
      replaceRunId: "run-a",
    })!;
    const replaced = next.tabs[0] as WorkflowRunSidePaneTab;
    expect(next.tabs).toHaveLength(2);
    expect(replaced).toMatchObject({
      type: "workflow-run",
      runId: "run-b",
      toolCallId: "settings-1",
      workflowName: "Fan-out review",
      ownerTaskId: "task-1",
    });
    expect(next.activeTabId).toBe(replaced.id);
    expect((next.tabs[1] as WorkflowRunSidePaneTab).runId).toBe("run-z");
  });

  it("旧 tab 不是活动 tab：活动 tab 不动", () => {
    const state = withTabs();
    const focusedOther = { ...state, activeTabId: state.tabs[1]!.id };
    const next = replaceWorkflowRunSidePane(focusedOther, {
      ...base,
      toolCallId: "settings-1",
      runId: "run-b",
      replaceRunId: "run-a",
    })!;
    expect(next.activeTabId).toBe(state.tabs[1]!.id);
  });

  it("旧 tab 已被关掉（或侧栏为空）：原样返回，替换不是打开", () => {
    const state = withTabs();
    const request = { ...base, toolCallId: "settings-1", runId: "run-b", replaceRunId: "run-gone" };
    expect(replaceWorkflowRunSidePane(state, request)).toBe(state);
    expect(replaceWorkflowRunSidePane(null, request)).toBeNull();
  });

  // 就地生效的修订（只改并发上限，docs/dynamic-workflow/concurrency.md）没有后继：结果里的 runId
  // 就是这个 run 自己。tab 的 id 只由 runId 铸，所以「新 tab 已经开着」那一支会认出它自己、把这个
  // tab 关掉，留下一个指向已不存在 tab 的 activeTabId——详情页就这么整个消失。
  it("结果里的 run 就是被替换的那个（就地生效）：原样返回，什么都不动", () => {
    const state = withTabs();
    const next = replaceWorkflowRunSidePane(state, {
      ...base,
      toolCallId: "settings-1",
      runId: "run-a",
      replaceRunId: "run-a",
    });
    expect(next).toBe(state);
    expect(next?.tabs.map((tab) => (tab as WorkflowRunSidePaneTab).runId)).toEqual([
      "run-a",
      "run-z",
    ]);
  });

  it("新 run 的 tab 已经开着：关掉旧的、聚焦那一个，不出两个", () => {
    const state = openWorkflowRunSidePane(withTabs(), {
      ...base,
      toolCallId: "settings-1",
      runId: "run-b",
    });
    const onOld = { ...state, activeTabId: state.tabs[0]!.id };
    const next = replaceWorkflowRunSidePane(onOld, {
      ...base,
      toolCallId: "settings-1",
      runId: "run-b",
      replaceRunId: "run-a",
    })!;
    const runIds = next.tabs.map((tab) => (tab as WorkflowRunSidePaneTab).runId);
    expect(runIds).toEqual(["run-z", "run-b"]);
    expect(next.activeTabId).toBe(next.tabs[1]!.id);
  });
});
