/**
 * run 的活体控制面与它在 `retuneConcurrency` 里的两个后果
 * （docs/dynamic-workflow/concurrency.md「The control path」）：
 *   - **还没绑上引擎的 run 一律 not_live，值绝不缓冲**：一个 `pending`、引擎尚未构造出来的 run
 *     收下这条命令、等引擎起来再补一次，就是在 UI 只承诺 `running` 就地生效的地方偷偷多承诺一次；
 *   - 引擎先、闸门后：引擎的布尔值就是这次命令的裁决，它说没改，闸门的上界一动都不动。
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { retuneRunConcurrency } from "../src/app/dynamic-workflow-run-retune.js";
import type { RunRegistryEntry } from "../src/app/dynamic-workflow-run-observation.js";
import { createWorkflowRunControl } from "../src/app/workflow-run-control.js";

const RUN = "dwfrun-control";
const DEFAULT_CONCURRENCY = 8;

/** 只记调用的假引擎；`verdict` 决定它是否承认这次真的改了。 */
function fakeEngine(verdict = true) {
  const calls: number[] = [];
  return {
    calls,
    engine: {
      setMaxConcurrency: (next: number) => {
        calls.push(next);
        return verdict;
      },
    },
  };
}

/** 只记上界的假闸门。 */
function fakeGate() {
  const limits: number[] = [];
  return { limits, gate: { setLimit: (next: number) => limits.push(next) } };
}

/** 一个最小的在飞条目：retune 只读 terminal / control / maxConcurrency 三样。 */
function liveEntry(control: RunRegistryEntry["control"], maxConcurrency?: number): RunRegistryEntry {
  return {
    controller: new AbortController(),
    startedAt: new Date(),
    cwd: "/tmp",
    scriptText: "",
    settlement: Promise.resolve({ status: "stopped", reason: "user" }) as never,
    ...(control === undefined ? {} : { control }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
  };
}

function contextWith(entry: RunRegistryEntry) {
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId: RUN, caps: { maxConcurrency: 4 }, spentTokens: 0, status: "running" });
  return { defaultConcurrency: () => DEFAULT_CONCURRENCY, journal, runs: new Map([[RUN, entry]]) };
}

describe("workflow run control", () => {
  it("还没绑上引擎：setMaxConcurrency 回 false，闸门不动，值也绝不缓冲", () => {
    const control = createWorkflowRunControl();
    const { gate, limits } = fakeGate();
    control.bindSeatGate(gate);

    expect(control.setMaxConcurrency(2)).toBe(false);
    expect(limits).toEqual([]);

    // 引擎稍后才起来：刚才那条命令**不该**在这一刻被补上。
    const { calls, engine } = fakeEngine();
    control.bind(engine);
    expect(calls).toEqual([]);
    expect(limits).toEqual([]);

    // 之后的显式调用照常生效。
    expect(control.setMaxConcurrency(2)).toBe(true);
    expect(calls).toEqual([2]);
    expect(limits).toEqual([2]);
  });

  it("引擎说没改（已结算 / 值没变）时闸门的上界一动不动", () => {
    const control = createWorkflowRunControl();
    const { gate, limits } = fakeGate();
    const { calls, engine } = fakeEngine(false);
    control.bind(engine);
    control.bindSeatGate(gate);

    expect(control.setMaxConcurrency(2)).toBe(false);
    expect(calls).toEqual([2]);
    expect(limits).toEqual([]);
  });

  it("没有闸门的装配也照常改（只剩调度器一个执行点）", () => {
    const control = createWorkflowRunControl();
    const { calls, engine } = fakeEngine();
    control.bind(engine);
    expect(control.setMaxConcurrency(3)).toBe(true);
    expect(calls).toEqual([3]);
  });

  // `pending` 且引擎还没构造出来的 run：端口必须回 not_live，而不是收下来等引擎起来再补。
  // 调用方据此走一次真正的修订——那条路本来就会处理一个还没开跑的前驱。
  it("retuneConcurrency 对着一个未绑定的控制面回 not_live，并且什么都没写", () => {
    const control = createWorkflowRunControl();
    const entry = liveEntry(control, 4);
    const ctx = contextWith(entry);

    expect(retuneRunConcurrency(ctx, { maxConcurrency: 2, runId: RUN })).toEqual({
      ok: false,
      reason: "not_live",
      current: 4,
    });
    expect(entry.maxConcurrency).toBe(4);
    expect(ctx.journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 4 });
    expect(ctx.journal.listEvents(RUN, { types: "all", reportItems: "all" })).toEqual([]);
  });

  it("retuneConcurrency 对着没有控制面的老条目同样回 not_live", () => {
    const ctx = contextWith(liveEntry(undefined, 4));
    expect(retuneRunConcurrency(ctx, { maxConcurrency: 2, runId: RUN })).toEqual({
      ok: false,
      reason: "not_live",
    });
  });
});
