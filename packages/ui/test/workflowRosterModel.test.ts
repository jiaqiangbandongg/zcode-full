// 阶段名册的纯划分（docs/dynamic-workflow/presentation.md「Past six participants」）：谁被钉住、谁是其余、
// 各状态几人；「还有 n 个」那一行读什么（追记「五枚药丸与一扇门」）、门后的名单怎么分组（追记「一扇门
// 与一卷名单」）。四处消费同一条规则，所以钉在这里而不是各自的渲染测试里。
import { describe, expect, it } from "vitest";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import {
  ROSTER_PINS_CARD,
  ROSTER_PINS_PANE,
  ROSTER_THRESHOLD,
  pillInstanceKey,
  rosterCounts,
  rosterMore,
  rosterRestCounts,
  rosterRoll,
  stationRoster,
  stationRosterOf,
} from "@/components/workflow-timeline/roster-model.js";
import type {
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";

function pill(
  index: number,
  status: StepRunStatus | undefined,
  extra: Partial<TimelinePill> = {},
): TimelinePill {
  return {
    key: `phase#a:actor#1@${index}`,
    lane: { id: "actor#1", laneClass: "agent", name: "reviewer" },
    laneClass: "agent",
    status,
    instance: { ordinal: index, siteId: "actor#1", sessionId: `s-${index}` },
    stepIds: ["ask#1"],
    ...extra,
  };
}

function pills(statuses: readonly (StepRunStatus | undefined)[]): TimelinePill[] {
  return statuses.map((status, index) => pill(index + 1, status));
}

const keys = (list: readonly TimelinePill[]) => list.map((entry) => entry.instance!.ordinal);

describe("stationRoster · 阈值", () => {
  it("参与者不多于阈值时没有名册（药丸列原样）", () => {
    expect(stationRoster(pills(Array(ROSTER_THRESHOLD).fill("done")), { pins: 3 })).toBeUndefined();
    expect(
      stationRoster(pills(Array(ROSTER_THRESHOLD + 1).fill("done")), { pins: 3 }),
    ).toBeDefined();
  });
});

describe("stationRoster · 钉位", () => {
  it("asking 先、running 次之、failed 再次，之后按参与者序补位，槽永不空", () => {
    const list = pills(["done", "running", "failed", "done", "running", "done", "failed", "done"]);
    list[3] = pill(4, "done", { asking: true });
    const roster = stationRoster(list, { pins: 5 })!;
    // asking 4 → running 2、5 → failed 3、7。
    expect(keys(roster.pinned)).toEqual([4, 2, 5, 3, 7]);
    // 其余按参与者序。
    expect(keys(roster.rest)).toEqual([1, 6, 8]);
    expect(roster.total).toBe(8);
  });

  it("还在跑的多于钉数时也不让位：钉位给参与者序里的前几个 running，failed 落进其余", () => {
    const list = pills([
      "failed",
      "running",
      "running",
      "running",
      "running",
      "running",
      "running",
      "done",
    ]);
    const roster = stationRoster(list, { pins: 5 })!;
    expect(keys(roster.pinned)).toEqual([2, 3, 4, 5, 6]);
    expect(keys(roster.rest)).toEqual([1, 7, 8]);
  });

  it("八个在跑、两个失败、其中一个在提问：钉位 = 提问者 + 四个 running，失败的藏在那一行后面", () => {
    const list = pills([
      "running",
      "running",
      "running",
      "running",
      "running",
      "running",
      "running",
      "running",
      "failed",
      "failed",
    ]);
    list[7] = pill(8, "running", { asking: true });
    const roster = stationRoster(list, { pins: 5 })!;
    expect(keys(roster.pinned)).toEqual([8, 1, 2, 3, 4]);
    // 两个 failed 一枚也没上钉位，红色 `✕ 2` 替它们说话。
    expect(rosterMore(roster).failed).toBe(2);
  });

  it("一枚 running 停下来时钉位只换一枚：让位的是它自己，其余原地不动", () => {
    const running: StepRunStatus[] = Array(6).fill("running").concat(Array(3).fill("done"));
    const before = stationRoster(pills(running), { pins: 5 })!;
    expect(keys(before.pinned)).toEqual([1, 2, 3, 4, 5]);
    // 第三个 running 结束：它让出钉位，第六个 running 顶上。
    const after = running.map((status, index) => (index === 2 ? "done" : status));
    const settled = stationRoster(pills(after), { pins: 5 })!;
    expect(keys(settled.pinned)).toEqual([1, 2, 4, 5, 6]);
    const left = keys(before.pinned).filter((key) => !keys(settled.pinned).includes(key));
    const entered = keys(settled.pinned).filter((key) => !keys(before.pinned).includes(key));
    expect([left, entered]).toEqual([[3], [6]]);
  });

  it("跑完的站没有 asking 也没有 running：这条序自己退化成 failed → 参与者序", () => {
    const roster = stationRoster(
      pills(["done", "failed", "done", "done", "failed", "done", "done"]),
      {
        pins: 3,
      },
    )!;
    expect(keys(roster.pinned)).toEqual([2, 5, 1]);
    expect(keys(roster.rest)).toEqual([3, 4, 6, 7]);
  });

  it("没有任何值得注意的参与者时按参与者序补位；钉数受 pins 上限约束", () => {
    const roster = stationRoster(pills(Array(9).fill("done")), { pins: 3 })!;
    expect(keys(roster.pinned)).toEqual([1, 2, 3]);
    expect(keys(roster.rest)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it("failed 多于钉数时只钉前几个，其余 failed 留在其余里（参与者序不变）", () => {
    const roster = stationRoster(
      pills(["failed", "done", "failed", "failed", "failed", "done", "done"]),
      {
        pins: 3,
      },
    )!;
    expect(keys(roster.pinned)).toEqual([1, 3, 4]);
    expect(keys(roster.rest)).toEqual([2, 5, 6, 7]);
  });

  it("其余不设上限：六十个参与者钉三枚，其余五十七个都在、按参与者序", () => {
    const roster = stationRoster(pills(Array(60).fill("done")), { pins: 3 })!;
    expect(roster.rest).toHaveLength(57);
    expect(keys(roster.rest).slice(0, 3)).toEqual([4, 5, 6]);
    expect(keys(roster.rest).at(-1)).toBe(60);
  });
});

describe("rosterCounts / pillInstanceKey", () => {
  it("计数含全部参与者；静态药丸（status undefined）计作 pending", () => {
    expect(rosterCounts(pills(["done", undefined, "running", "failed", "pending"]))).toEqual({
      done: 1,
      failed: 1,
      pending: 2,
      running: 1,
    });
  });

  it("实例键是 siteId@ordinal；合成车道没有", () => {
    expect(pillInstanceKey(pill(4, "done"))).toBe("actor#1@4");
    expect(pillInstanceKey({ instance: undefined })).toBeUndefined();
  });
});

// ── 「还有 n 个」那一行（docs/dynamic-workflow/presentation.md「Past six participants」）──
describe("rosterMore", () => {
  it("卡上钉五枚：五枚 + 一行 = 六枚药丸的高度", () => {
    expect(ROSTER_PINS_CARD).toBe(5);
  });

  it("count 是其余人数；deck 按注意力序取前三（同档保持参与者序）；failed 只数藏起来的", () => {
    const list = pills([
      "done",
      "failed",
      "running",
      "done",
      "pending",
      "failed",
      "done",
      "running",
      "failed",
      "done",
    ]);
    // 钉 3：running 3、8 → failed 2；其余 1 4 5 6 7 9 10 → failed 6、9 在前，pending 5 次之。
    const more = rosterMore(stationRoster(list, { pins: 3 })!);
    expect(more.count).toBe(7);
    expect(keys(more.deck)).toEqual([6, 9, 5]);
    expect(more.failed).toBe(2);
    // 钉位只够 running 时：三个 failed 全藏起来，都计入，且排在叠的最前。
    const two = rosterMore(stationRoster(list, { pins: 2 })!);
    expect(two.count).toBe(8);
    expect(keys(two.deck)).toEqual([2, 6, 9]);
    expect(two.failed).toBe(3);
  });

  it("叠的张数可调；六十人里叠上仍是全体其余里最要紧的，failed 数照旧准确", () => {
    const statuses: StepRunStatus[] = Array(60).fill("done");
    statuses[50] = "failed";
    statuses[55] = "running";
    statuses[57] = "failed";
    // 钉 1：running 56；其余里 failed 51、58 领先。
    const roster = stationRoster(pills(statuses), { pins: 1 })!;
    const more = rosterMore(roster, 2);
    expect(more.count).toBe(59);
    expect(keys(more.deck)).toEqual([51, 58]);
    expect(more.failed).toBe(2);
  });
});

// ── 门后的名单（docs/dynamic-workflow/presentation.md「The spine」）──
describe("rosterRoll", () => {
  it("其余按状态分组，组序 failed → running → pending → done，组内参与者序，空组缺席，钉住的不在", () => {
    const list = pills([
      "done",
      "failed",
      "running",
      "done",
      "pending",
      "failed",
      "done",
      "running",
      "failed",
      undefined,
    ]);
    // 钉 1：running 3；其余 1 2 4 5 6 7 8 9 10。
    const groups = rosterRoll(stationRoster(list, { pins: 1 })!);
    expect(groups.map((group) => group.status)).toEqual(["failed", "running", "pending", "done"]);
    expect(groups.map((group) => keys(group.pills))).toEqual([[2, 6, 9], [8], [5, 10], [1, 4, 7]]);
  });

  it("全体完成时只有一组；名单里的人数 = 其余人数", () => {
    const roster = stationRoster(pills(Array(9).fill("done")), { pins: 5 })!;
    const groups = rosterRoll(roster);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.status).toBe("done");
    expect(groups[0]!.pills).toHaveLength(roster.rest.length);
  });
});

// ── 表外的那些（docs/dynamic-workflow/presentation.md「Past six participants」）：被归约淘汰的
// 子代理没有药丸、没有脸、没有行，但这一站的每个数字都得把它们算回来。
describe("stationRoster · 表外条目", () => {
  function station(list: TimelinePill[], unlisted?: TimelineStation["unlisted"]): TimelineStation {
    return {
      id: "phase#a",
      naming: { id: "phase#a", name: "review" },
      onLoop: false,
      pills: list,
      rounds: 1,
      status: "running",
      track: 0,
      visited: true,
      ...(unlisted === undefined ? {} : { unlisted }),
    };
  }

  it("阈值按表内 + 表外判：四枚药丸加三百个被淘汰的仍是名册，表外的一枚药丸都不占", () => {
    // 四枚药丸自己不成名册；补上两个表外的正好到阈值，仍不是。
    expect(stationRoster(pills(Array(4).fill("done")), { pins: 5 })).toBeUndefined();
    expect(
      stationRoster(pills(Array(4).fill("done")), {
        pins: 5,
        unlisted: { actors: 2, failed: 0, settled: 2 },
      }),
    ).toBeUndefined();
    const roster = stationRoster(pills(Array(4).fill("running")), {
      pins: 5,
      unlisted: { actors: 300, failed: 4, settled: 300 },
    })!;
    expect(roster.total).toBe(304);
    // 表外的没有药丸：钉位与其余里一枚都找不到它们。
    expect(keys(roster.pinned)).toEqual([1, 2, 3, 4]);
    expect(roster.rest).toEqual([]);
    // 三百个全跑完了：失败的算 failed，其余算 done。
    expect(roster.counts).toEqual({ done: 296, failed: 4, pending: 0, running: 4 });
  });

  // 表外 ≠ 已结束：出生就被拒、或排队时被淘汰的子代理还要跑，把它们记成 done 就是那句假话。
  it("只有 actorsSettled 那部分算结局，其余全进 pending", () => {
    const roster = stationRoster(pills(Array(4).fill("done")), {
      pins: 5,
      unlisted: { actors: 300, failed: 2, settled: 100 },
    })!;
    expect(roster.total).toBe(304);
    // 表内四个 done，加表外结算的 100 − 2；失败 2；剩下的 200 个还没跑。
    expect(roster.counts).toEqual({ done: 102, failed: 2, pending: 200, running: 0 });
    const more = rosterMore(roster);
    expect(more.count).toBe(300);
    expect(more.failed).toBe(2);
  });

  it("一格都没结算（actorsSettled 缺席归零）：三百个全是 pending", () => {
    const roster = stationRoster(pills(Array(4).fill("running")), {
      pins: 5,
      unlisted: { actors: 300, failed: 0, settled: 0 },
    })!;
    expect(roster.counts).toEqual({ done: 0, failed: 0, pending: 300, running: 4 });
    expect(rosterRestCounts(roster)).toEqual({ done: 0, failed: 0, pending: 300, running: 0 });
  });

  it("「还有 n 个」把表外的算进人数与红 ✕；叠上的脸只有表内的", () => {
    const roster = stationRoster(
      pills(["running", "running", "running", "running", "running", "failed", "done"]),
      { pins: 5, unlisted: { actors: 10, failed: 3, settled: 10 } },
    )!;
    const more = rosterMore(roster);
    // 其余两枚药丸 + 十个表外的。
    expect(more.count).toBe(12);
    // 藏起来的一个 failed + 表外失败的三个。
    expect(more.failed).toBe(4);
    expect(keys(more.deck)).toEqual([6, 7]);
  });

  it("门关着的计数行 = 其余 + 表外；门后的名单只列得出表内的其余", () => {
    const roster = stationRoster(pills(["running", "failed", "done", "done", "pending"]), {
      pins: 2,
      unlisted: { actors: 10, failed: 3, settled: 10 },
    })!;
    // 钉 running 1、failed 2；其余 3 4 done、5 pending。
    expect(rosterRestCounts(roster)).toEqual({ done: 9, failed: 3, pending: 1, running: 0 });
    expect(rosterRoll(roster).map((group) => keys(group.pills))).toEqual([[5], [3, 4]]);
  });

  it("stationRosterOf 从站上取表外那一格：卡与侧板读同一个值，缺席即一条都没少", () => {
    const list = pills(Array(4).fill("done"));
    expect(stationRosterOf(station(list), ROSTER_PINS_PANE)).toBeUndefined();
    const roster = stationRosterOf(
      station(list, { actors: 300, failed: 2, nodesSettled: 300, settled: 100 }),
      ROSTER_PINS_CARD,
    )!;
    expect(roster.total).toBe(304);
    expect(rosterMore(roster).count).toBe(300);
    // 站带的是子代理的结局，不是节点的：`nodesSettled` 只进 fraction，一个人都不算。
    expect(roster.counts).toEqual({ done: 102, failed: 2, pending: 200, running: 0 });
  });
});
