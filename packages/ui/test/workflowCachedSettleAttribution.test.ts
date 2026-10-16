// 修订 / resume 之后「命中缓存的子代理显示待开始」（2026-09-22 用户报告）的读面回归。
//
// 走真实管线的后两段：事件信封 → 共享 reducer → 时间线模型 / transcript 门。修订 run 从空表
// 开始，缓存命中又没有 node-queued，所以命中的结算必须自己点名子代理
// （docs/dynamic-workflow/presentation.md「Reduction」）；transcript 要去持有交换的那条会话
// 里读（「Subagent transcripts」）。
import { describe, expect, it } from "vitest";
import {
  reduceWorkflowRunsState,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowActorStartState } from "@/app-shell/workflowRunPanel.js";

const RUN_ID = "dwfrun-b";

/** 一条 `many` 车道：worker 扇出三个实例，同一个 ask 站点——拆卡的那条路径。 */
const FAN_OUT: WorkflowCausalityGraphData = {
  exits: ["phase#1"],
  handoffs: [],
  lanes: [{ id: "actor#1", name: "worker" }],
  participants: [
    { id: "phase#1:actor#1", lane: "actor#1", many: true, phase: "phase#1", steps: ["ask#1"] },
  ],
  phases: [{ id: "phase#1", name: "work" }],
  steps: [{ id: "ask#1", kind: "ask", label: "ask#1", lane: "actor#1", phase: "phase#1" }],
};

const actorRef = (ordinal: number) => ({ siteId: "actor#1", ordinal });
const askRef = (ordinal: number) => ({ siteId: "ask#1", ordinal });
const ownSession = (ordinal: number) => `sess-b-${ordinal}`;
const predecessorSession = (ordinal: number) => `sess-a-${ordinal}`;

function reduce(events: Array<[string, Record<string, unknown>, string?]>): WorkflowRunsState {
  let state: WorkflowRunsState | undefined;
  events.forEach(([eventType, payload, actorSessionId], sequence) => {
    const envelope: WorkflowRunProgressEnvelope = {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence,
      eventType,
      payload,
      ...(actorSessionId === undefined ? {} : { actorSessionId }),
    };
    state = reduceWorkflowRunsState(state, envelope) ?? state;
  });
  return state!;
}

/** worker 1、2 命中导入缓存；worker 3 live。`namesActor: false` 是老 journal 的形状。 */
function amendedRun(options: { namesActor: boolean; settled: boolean }): WorkflowRunsState {
  const cachedSettle = (ordinal: number): [string, Record<string, unknown>, string?] =>
    options.namesActor
      ? [
          "node-settled",
          {
            instance: askRef(ordinal),
            outcome: "ok",
            cached: true,
            kind: "ask",
            actor: actorRef(ordinal),
            actorSeq: 0,
            sourceSessionId: predecessorSession(ordinal),
          },
          ownSession(ordinal),
        ]
      : ["node-settled", { instance: askRef(ordinal), outcome: "ok", cached: true }];
  return reduce([
    ["run-started", { caps: { maxConcurrency: 4 } }],
    ["phase-entered", { name: "work", ordinal: 1 }],
    ...[1, 2, 3].map((ordinal): [string, Record<string, unknown>, string?] => [
      "actor-created",
      { actor: actorRef(ordinal), name: `w${ordinal}`, phaseName: "work" },
      ownSession(ordinal),
    ]),
    cachedSettle(1),
    cachedSettle(2),
    ["node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(3), actorSeq: 0 }],
    [
      "node-dispatched",
      { instance: askRef(3), kind: "ask", actor: actorRef(3), actorName: "w3" },
      ownSession(3),
    ],
    ["node-executing", { instance: askRef(3) }],
    ...(options.settled
      ? ([
          ["node-settled", { instance: askRef(3), outcome: "ok" }],
          ["run-settled", { status: "completed" }],
        ] as Array<[string, Record<string, unknown>, string?]>)
      : []),
  ]);
}

function pillsOf(state: WorkflowRunsState) {
  const run = state.runs[0]!;
  return buildWorkflowTimeline(FAN_OUT, run).stations[0]!.pills.map((pill) => ({
    key: pill.key,
    status: pill.status,
    sessionId: pill.instance?.sessionId,
  }));
}

describe("修订 run 的缓存命中：拆开的实例卡", () => {
  it("命中的两个 worker 是 done，不是待开始（run 还在跑时也一样）", () => {
    expect(pillsOf(amendedRun({ namesActor: true, settled: false }))).toEqual([
      { key: "phase#1:actor#1@1", status: "done", sessionId: predecessorSession(1) },
      { key: "phase#1:actor#1@2", status: "done", sessionId: predecessorSession(2) },
      { key: "phase#1:actor#1@3", status: "running", sessionId: ownSession(3) },
    ]);
  });

  it("run 完成之后仍是 done（报告里的形状：待开始一直停到最后）", () => {
    expect(
      pillsOf(amendedRun({ namesActor: true, settled: true })).map((pill) => pill.status),
    ).toEqual(["done", "done", "done"]);
  });

  it("老 journal（命中不点名子代理）：归属不上，卡停在 pending——记录在案的限制，不是回归", () => {
    expect(
      pillsOf(amendedRun({ namesActor: false, settled: true })).map((pill) => pill.status),
    ).toEqual(["pending", "pending", "done"]);
  });
});

describe("修订 run 的缓存命中：transcript 门", () => {
  const slot = (ordinal: number) => ({ runId: RUN_ID, siteId: "actor#1", ordinal });

  it("全部命中的子代理已启动，订阅前驱里持有交换的那条会话", () => {
    const runs = amendedRun({ namesActor: true, settled: true }).runs;
    expect(workflowActorStartState(runs, slot(1))).toEqual({
      state: "started",
      sessionId: predecessorSession(1),
    });
    // live 的那个照旧订阅本 run 自己的会话。
    expect(workflowActorStartState(runs, slot(3))).toEqual({
      state: "started",
      sessionId: ownSession(3),
    });
  });

  it("tab 打开时带的是本 run 铸的 id：门以投影为准，不去订阅那条从未建过的会话", () => {
    const runs = amendedRun({ namesActor: true, settled: true }).runs;
    expect(
      workflowActorStartState(runs, { ...slot(2), actorSessionId: ownSession(2) }).sessionId,
    ).toBe(predecessorSession(2));
  });

  it("老 journal：门仍说未启动（归属不上的命中证明不了任何会话）", () => {
    const runs = amendedRun({ namesActor: false, settled: true }).runs;
    expect(workflowActorStartState(runs, slot(1)).state).toBe("notStarted");
  });
});
