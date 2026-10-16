/**
 * 就地改本 run 自己的并发上界（`engine.setMaxConcurrency`，docs/dynamic-workflow/concurrency.md
 * 「Two bounds on a run」）。这里测的是**第一条界**：调度器的在飞 ask 上界，单位是子代理。
 * 进程级共享 cap（单位是模型请求）住在 driver 之下，与本文件无关。
 *
 * 与 engine-concurrency-observations.test.ts 同一套 fixture 姿态，单独成文件：那份测的是
 * 引擎只 record 的三个观察，这份测的是引擎唯一的一条并发**命令**。
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  type AskSpec,
  type Caps,
  type InstanceRef,
  type RunEvent,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run";
const inst = (siteId: string, ordinal = 1): InstanceRef => ({ siteId, ordinal });
const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

const SITES = ["ask#1", "ask#2", "ask#3"] as const;

function setup(caps: Caps, journal = new InMemoryJournalStore()) {
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps,
    askSpecs: untypedSpecs(...SITES),
    validate: () => [],
  });
  return { journal, driver, engine };
}

/**
 * 每个 actor 一个 ask：调度器串行同一个 actor，所以「还能不能再派发一个」只由并发上界决定。
 * 返回每个 ask 的 promise（按站点序）。
 */
function askEachOnItsOwnActor(engine: WorkflowEngine, count: number): Array<Promise<unknown>> {
  return SITES.slice(0, count).map((siteId, i) => {
    const actor = engine.createActor(`actor#${i + 1}`);
    return engine.ask(siteId, actor, `A${i + 1}`);
  });
}

const capsEvents = (driver: FakeDriver): Array<Extract<RunEvent, { type: "run-caps-changed" }>> =>
  driver.eventsOfType("run-caps-changed");

describe("WorkflowEngine — setMaxConcurrency（就地改本 run 的并发上界）", () => {
  it("调低：不再派发新 ask，在飞的照常跑完", async () => {
    const { engine, driver } = setup({ maxConcurrency: 2 });
    const [p1, p2, p3] = askEachOnItsOwnActor(engine, 3);
    await flush();
    expect(driver.startAskCount()).toBe(2);

    expect(engine.setMaxConcurrency(1)).toBe(true);
    await flush();
    // 调低不会把已派发的 ask 召回，也不会凭空多派一个。
    expect(driver.startAskCount()).toBe(2);
    expect(driver.cancels).toEqual([]);

    // 一个在飞 ask 结算后仍有 1 个在飞 ⇒ 队列里的第三个 ask 不得放行。
    engine.askTurnEnded(inst("ask#1"), "R1");
    await expect(p1).resolves.toBe("R1");
    await flush();
    expect(driver.startAskCount()).toBe(2);

    // 降到 0 个在飞才轮到它。
    engine.askTurnEnded(inst("ask#2"), "R2");
    await expect(p2).resolves.toBe("R2");
    await flush();
    expect(driver.startAskCount()).toBe(3);
    engine.askTurnEnded(inst("ask#3"), "R3");
    await expect(p3).resolves.toBe("R3");
  });

  it("抬高：排队中的 ask 立刻派发，不必等下一次结算", async () => {
    const { engine, driver } = setup({ maxConcurrency: 1 });
    const asks = askEachOnItsOwnActor(engine, 3);
    await flush();
    expect(driver.startAskCount()).toBe(1);

    expect(engine.setMaxConcurrency(3)).toBe(true);
    await flush();
    expect(driver.startAskCount()).toBe(3);

    for (const [i, site] of SITES.entries()) engine.askTurnEnded(inst(site), `R${i + 1}`);
    await expect(Promise.all(asks)).resolves.toEqual(["R1", "R2", "R3"]);
  });

  it("记一条事件，带改前改后的两份 caps，并把新值写进 journal 行", () => {
    const { engine, driver, journal } = setup({ maxConcurrency: 8 });
    expect(engine.setMaxConcurrency(2)).toBe(true);

    expect(capsEvents(driver)).toEqual([
      {
        type: "run-caps-changed",
        runId: RUN,
        caps: { maxConcurrency: 2 },
        previous: { maxConcurrency: 8 },
      },
    ]);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 2 });
    // 只碰这一列：状态与用量不在这条写入的范围里。
    expect(journal.getRun(RUN)?.status).toBe("running");

    // 事件也进了 journal（两条轨拿到的是同一条事件）。
    const stored = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .filter((e) => e.event.type === "run-caps-changed");
    expect(stored).toHaveLength(1);
  });

  it("同值：返回 false，不写库也不发事件", () => {
    const { engine, driver, journal } = setup({ maxConcurrency: 4 });
    const eventsBefore = driver.events.length;
    expect(engine.setMaxConcurrency(4)).toBe(false);
    expect(driver.events.length).toBe(eventsBefore);
    expect(capsEvents(driver)).toEqual([]);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 4 });
  });

  it("run 已结算：返回 false，不写库也不发事件（竞态下调用方回落到一次真正的 amend）", () => {
    const { engine, driver, journal } = setup({ maxConcurrency: 4 });
    engine.complete("done");
    const eventsBefore = driver.events.length;

    expect(engine.setMaxConcurrency(1)).toBe(false);
    expect(driver.events.length).toBe(eventsBefore);
    expect(capsEvents(driver)).toEqual([]);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 4 });
  });

  it("非有限值：按落库归一拒掉，不毒化 caps_max_concurrency", () => {
    const { engine, driver, journal } = setup({ maxConcurrency: 4 });
    expect(engine.setMaxConcurrency(Number.NaN)).toBe(false);
    // 钳到 [1, …] 之后与当前值相同，同样是 no-op（真正的天花板钳制在调用侧）。
    expect(engine.setMaxConcurrency(0)).toBe(true);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 1 });
    expect(capsEvents(driver)).toHaveLength(1);
  });

  it("resume 读到的是改后的值，且 replay 仍然确定（命中的 ask 零派发）", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ maxConcurrency: 8 }, journal);
    const actor = first.engine.createActor("actor#1");
    const p = first.engine.ask("ask#1", actor, "A1");
    await flush();
    expect(first.engine.setMaxConcurrency(2)).toBe(true);
    first.engine.askTurnEnded(inst("ask#1"), "R1");
    await expect(p).resolves.toBe("R1");
    first.engine.stop("user");

    // resume 的 caps 来自 journal 行（宿主侧同一条读：dynamic-workflow-run-submit 的 record.caps）。
    const resumedCaps = journal.getRun(RUN)!.caps;
    expect(resumedCaps).toEqual({ maxConcurrency: 2 });

    const second = setup(resumedCaps, journal);
    const actor2 = second.engine.createActor("actor#1");
    await expect(second.engine.ask("ask#1", actor2, "A1")).resolves.toBe("R1");
    await flush();
    // 命中即短路：journal 里多出的那条 run-caps-changed 不参与 replay 判定。
    expect(second.driver.startAskCount()).toBe(0);
    expect(second.driver.cachedSettleOrder()).toEqual(["ask#1@1"]);
    expect(second.driver.eventsOfType("run-started")[0]?.caps).toEqual({ maxConcurrency: 2 });
    expect(capsEvents(second.driver)).toEqual([]);
  });
});
