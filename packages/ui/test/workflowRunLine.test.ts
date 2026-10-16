// 侧栏工作流运行行的纯模型与确认集合（docs/dynamic-workflow/presentation.md「The sidebar run line」）。
import { describe, expect, it } from "vitest";
import type {
  SessionWorkflowActivity,
  SessionWorkflowPhaseSummary,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import {
  WORKFLOW_RUN_ACK_LIMIT,
  createWorkflowRunAckStore,
  WORKFLOW_RUN_ACK_STORAGE_KEY,
} from "@/lib/workflowRunAckStore.js";
import {
  WORKFLOW_RUN_LINE_MAX_LINES,
  countLiveWorkflowRuns,
  foldWorkflowRunRail,
  selectWorkflowRunLines,
  settledWorkflowRunIds,
  workflowRunParallelPhaseLabel,
} from "@/lib/workflowRunLine.js";

function run(
  overrides: Partial<SessionWorkflowRunSummary> & { runId: string },
): SessionWorkflowRunSummary {
  return { status: "running", phases: [], agentsWorking: 0, ...overrides };
}

function phases(statuses: SessionWorkflowPhaseSummary["status"][]): SessionWorkflowPhaseSummary[] {
  return statuses.map((status, index) => ({ name: `p${index}`, status }));
}

describe("foldWorkflowRunRail", () => {
  it("no phase vocabulary → one implicit station", () => {
    expect(foldWorkflowRunRail([])).toEqual({ stations: [], hidden: 0, implicit: true });
  });

  it("up to six stations are all drawn; the segment into a reached station is strong", () => {
    const rail = foldWorkflowRunRail(phases(["done", "running", "pending"]));
    expect(rail.hidden).toBe(0);
    expect(rail.implicit).toBe(false);
    expect(rail.stations.map((station) => [station.status, station.reached])).toEqual([
      ["done", true],
      ["running", true],
      ["pending", false],
    ]);
  });

  it("past six stations folds to the running station ± 2 with a +n tail", () => {
    const rail = foldWorkflowRunRail(
      phases(["done", "done", "done", "done", "running", "pending", "pending", "pending"]),
    );
    expect(rail.stations.map((station) => station.name)).toEqual(["p2", "p3", "p4", "p5", "p6"]);
    expect(rail.hidden).toBe(3);
  });

  it("the window clamps at either end and anchors on the last reached station when nothing runs", () => {
    const start = foldWorkflowRunRail(phases(["running", ...Array<"pending">(7).fill("pending")]));
    expect(start.stations.map((station) => station.name)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    const ended = foldWorkflowRunRail(phases([...Array<"done">(7).fill("done"), "failed"]));
    expect(ended.stations.map((station) => station.name)).toEqual(["p3", "p4", "p5", "p6", "p7"]);
    expect(ended.hidden).toBe(3);
  });
});

describe("foldWorkflowRunRail · 并行站点", () => {
  /** 声明表 + 每站的 alongside（下标指向同一张表）。 */
  function band(alongside: (number[] | undefined)[]): SessionWorkflowPhaseSummary[] {
    return alongside.map((beside, index) => ({
      name: `p${index}`,
      status: "pending" as const,
      ...(beside === undefined ? {} : { alongside: beside }),
    }));
  }

  it("a station beside the previous one rides a twin segment; the one after the band does not", () => {
    // A ∥ B → C：B 与 A 同带不同轨（进入 B 的那段是双线），C 在带外（普通段）。
    const rail = foldWorkflowRunRail(band([undefined, [0], undefined]));
    expect(rail.stations.map((station) => station.twin)).toEqual([undefined, true, undefined]);
  });

  it("an overlap chain keeps every branch station on a twin segment", () => {
    // 重叠链：进 B 时 A 还在跑、进 C 时 B 还在跑。三站连成一条带，轨道是
    // [[A, C], [B]]（贪心着色），于是进 B 与进 C 的两段都跨轨 —— 都是双线段。
    const rail = foldWorkflowRunRail(band([undefined, [0], [1]]));
    expect(rail.stations.map((station) => station.twin)).toEqual([undefined, true, true]);
  });

  it("without any alongside no station is twinned", () => {
    const rail = foldWorkflowRunRail(band([undefined, undefined, undefined]));
    expect(rail.stations.every((station) => station.twin === undefined)).toBe(true);
    expect(rail.stations.every((station) => !Object.hasOwn(station, "twin"))).toBe(true);
  });

  it("the band is folded on the full table, so the window cannot break it apart", () => {
    // 9 站、窗口只留 5 站：带在全表上折，双线标志随站进窗口（按窗口内下标重折会把带拆断）。
    const phases = band([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [6],
      [5],
      undefined,
      undefined,
    ]);
    phases[6] = { ...phases[6]!, status: "running" };
    const rail = foldWorkflowRunRail(phases);
    expect(rail.stations.map((station) => station.name)).toEqual(["p4", "p5", "p6", "p7", "p8"]);
    expect(rail.stations.map((station) => station.twin)).toEqual([
      undefined,
      undefined,
      true,
      undefined,
      undefined,
    ]);
  });
});

describe("workflowRunParallelPhaseLabel", () => {
  it("joins every running phase with ∥, and stays silent for a single one", () => {
    expect(
      workflowRunParallelPhaseLabel([
        { name: "A", status: "running" },
        { name: "B", status: "running" },
        { name: "C", status: "pending" },
      ]),
    ).toBe("A ∥ B");
    expect(
      workflowRunParallelPhaseLabel([
        { name: "A", status: "done" },
        { name: "B", status: "running" },
      ]),
    ).toBeUndefined();
    expect(workflowRunParallelPhaseLabel([])).toBeUndefined();
  });
});

describe("selectWorkflowRunLines", () => {
  const activity: SessionWorkflowActivity = {
    runs: [
      run({ runId: "live-1" }),
      run({ runId: "live-2", status: "pending" }),
      run({ runId: "done-new", status: "completed" }),
      run({ runId: "done-old", status: "errored" }),
    ],
  };

  it("live runs always show; settled ones only while unacknowledged; at most two lines", () => {
    const none = selectWorkflowRunLines(activity, () => false);
    expect(none.lines.map((line) => line.runId)).toEqual(["live-1", "live-2"]);
    expect(none.overflow).toBe(2);
    expect(WORKFLOW_RUN_LINE_MAX_LINES).toBe(2);
  });

  it("acknowledged settled runs disappear, live ones do not", () => {
    const acked = new Set(["done-new", "done-old", "live-1"]);
    const selection = selectWorkflowRunLines(activity, (runId) => acked.has(runId));
    expect(selection.lines.map((line) => line.runId)).toEqual(["live-1", "live-2"]);
    expect(selection.overflow).toBe(0);
  });

  it("a single unacknowledged settled run lingers as the only line", () => {
    const selection = selectWorkflowRunLines(
      { runs: [run({ runId: "done", status: "stopped", stopReason: "user" })] },
      () => false,
    );
    expect(selection.lines.map((line) => line.runId)).toEqual(["done"]);
    expect(selectWorkflowRunLines(undefined, () => false)).toEqual({ lines: [], overflow: 0 });
  });

  it("settledWorkflowRunIds / countLiveWorkflowRuns split the activity by liveness", () => {
    expect(settledWorkflowRunIds(activity)).toEqual(["done-new", "done-old"]);
    expect(countLiveWorkflowRuns(activity)).toBe(2);
    expect(countLiveWorkflowRuns(undefined)).toBe(0);
  });
});

describe("workflowRunAckStore", () => {
  function memoryStorage(seed?: string) {
    const map = new Map<string, string>();
    if (seed !== undefined) map.set(WORKFLOW_RUN_ACK_STORAGE_KEY, seed);
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      dump: () => map.get(WORKFLOW_RUN_ACK_STORAGE_KEY),
    };
  }

  it("acknowledges, persists and notifies once per change", () => {
    const storage = memoryStorage();
    const store = createWorkflowRunAckStore(storage);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    expect(store.isAcknowledged("r1")).toBe(false);
    store.acknowledge(["r1", "r2"]);
    expect(store.isAcknowledged("r1")).toBe(true);
    expect(store.getVersion()).toBe(1);
    expect(notified).toBe(1);
    // 重复确认无变化：不抬版本、不通知、不写盘。
    store.acknowledge(["r1"]);
    expect(store.getVersion()).toBe(1);
    expect(notified).toBe(1);
    expect(JSON.parse(storage.dump() ?? "[]")).toEqual(["r1", "r2"]);
  });

  it("reads the persisted set back and survives garbage", () => {
    expect(createWorkflowRunAckStore(memoryStorage('["a","b",3]')).isAcknowledged("b")).toBe(true);
    expect(createWorkflowRunAckStore(memoryStorage("not json")).isAcknowledged("a")).toBe(false);
    expect(createWorkflowRunAckStore(null).isAcknowledged("a")).toBe(false);
  });

  it("is bounded: the oldest acknowledgement is evicted past the limit", () => {
    const store = createWorkflowRunAckStore(memoryStorage());
    store.acknowledge(["first"]);
    store.acknowledge(Array.from({ length: WORKFLOW_RUN_ACK_LIMIT }, (_, index) => `r${index}`));
    expect(store.isAcknowledged("first")).toBe(false);
    expect(store.isAcknowledged("r0")).toBe(true);
    expect(store.isAcknowledged(`r${WORKFLOW_RUN_ACK_LIMIT - 1}`)).toBe(true);
  });
});
