/**
 * 引擎侧的三个自适应并发观察事件（docs/dynamic-workflow/concurrency.md「What the driver observes」）。
 * 引擎只 record，不据它们做任何决策；与 engine.test.ts 同一套 fixture 姿态，单独成文件只为不再往
 * 那份 1500 行的文件上堆。进程级闸门本身住在 driver 之下（bootstrap），这里没有槽位可言。
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  WorkflowError,
  type AskSpec,
  type InstanceRef,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run";
const inst = (siteId: string, ordinal = 1): InstanceRef => ({ siteId, ordinal });
const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

function setup() {
  const journal = new InMemoryJournalStore();
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: untypedSpecs("ask#1", "ask#2"),
    validate: () => [],
  });
  return { journal, driver, engine };
}

const eventTypes = (driver: FakeDriver): string[] => driver.events.map((e) => e.type);

describe("WorkflowEngine — 派发不经任何槽位", () => {
  it("WorkflowDriver 没有 acquireSlot；会话就绪后立即 node-dispatched + startAsk", async () => {
    const { engine, driver } = setup();
    expect((driver as { acquireSlot?: unknown }).acquireSlot).toBeUndefined();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    expect(eventTypes(driver)).toEqual(["run-started", "actor-created", "node-queued", "node-dispatched"]);
    expect(driver.startAskCount()).toBe(1);
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("driver 侧失败以 DriverError 落 node-settled（模型层归因字段已退场）", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askFailed(inst("ask#1"), new WorkflowError("DriverError", "boom"));
    await expect(p).rejects.toMatchObject({ code: "DriverError" });
    const settled = driver.eventsOfType("node-settled");
    expect(settled[0]?.error).toEqual({ code: "DriverError", message: "boom" });
  });

  // 确定性模型侧错误（docs/execution-engine.md）：driver 不结算节点，整个 run 以
  // stopped(provider) 停下，在飞 ask 与 cancel 同款 abort，failure 随 run-settled 与 journal 落库。
  it("stopRun(ProviderStop) 停下整个 run：在飞 ask abort、run-settled 带 stopReason 与 error", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    const stop = new WorkflowError("ProviderStop", "Sign-in to BigModel expired.", {
      providerStop: {
        kind: "auth",
        reason: "auth_failed",
        providerCode: "1006",
        subagent: "ask#1@1",
      },
    });
    engine.stopRun(stop);
    expect(driver.cancels).toContainEqual(inst("ask#1"));
    await expect(p).rejects.toMatchObject({ code: "Cancelled" });
    await expect(engine.settled).resolves.toEqual({
      status: "stopped",
      reason: "provider",
      error: stop,
    });
    expect(driver.eventsOfType("node-settled")[0]).toMatchObject({ outcome: "cancelled" });
    expect(driver.eventsOfType("run-settled")[0]).toEqual({
      type: "run-settled",
      status: "stopped",
      stopReason: "provider",
      error: stop.toJSON(),
    });
    const run = journal.getRun(RUN);
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("provider");
    expect(run?.failure).toEqual(stop.toJSON());
    // first-wins：结算后的第二次 stopRun / fail 都是 no-op。
    engine.stopRun(stop);
    engine.fail(new WorkflowError("DriverError", "late"));
    expect(driver.eventsOfType("run-settled")).toHaveLength(1);
  });

  // 引擎给 ProviderStop 补上触发子代理的出生阶段：driver 只知道 actor ref，阶段只有引擎知道。
  it("stopRun 用 instancePhases 给 providerStop 补 phase；没有标记或已带 phase 时原样", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("Verify");
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "A").catch(() => {});
    await flush();
    engine.stopRun(
      new WorkflowError("ProviderStop", "Model GLM-5.3 is not available.", {
        providerStop: { kind: "model_unavailable", reason: "invalid_request", subagent: "actor#1@1" },
      }),
    );
    const settled = driver.eventsOfType("run-settled")[0];
    expect(settled).toMatchObject({
      status: "stopped",
      stopReason: "provider",
      error: { providerStop: { subagent: "actor#1@1", phase: "Verify" } },
    });

    const bare = setup();
    const bareActor = bare.engine.createActor("actor#1");
    void bare.engine.ask("ask#1", bareActor, "A").catch(() => {});
    await flush();
    bare.engine.stopRun(
      new WorkflowError("ProviderStop", "boom", {
        providerStop: { kind: "auth", reason: "auth_failed", subagent: "actor#1@1" },
      }),
    );
    const bareError = bare.driver.eventsOfType("run-settled")[0]?.error;
    expect(bareError?.providerStop).toEqual({
      kind: "auth",
      reason: "auth_failed",
      subagent: "actor#1@1",
    });
  });

  it("runStalled 落一条 run-stalled；run 结算后忽略", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "A").catch(() => {});
    await flush();
    engine.runStalled({ sinceMs: 1_200_000, reason: "rate_limited", cap: 2 });
    expect(driver.events.at(-1)).toEqual({
      type: "run-stalled",
      sinceMs: 1_200_000,
      reason: "rate_limited",
      cap: 2,
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" }).at(-1)?.event.type).toBe(
      "run-stalled",
    );
    engine.stop("user");
    engine.runStalled({ sinceMs: 1 });
    expect(driver.events.at(-1)?.type).toBe("run-settled");
  });
});

describe("WorkflowEngine — 并发观察事件", () => {
  it("askWaiting(slot) / askWaiting(backoff) / askExecuting / concurrencyChanged 各落一条对应事件", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();

    engine.askWaiting(inst("ask#1"), { cause: "slot" });
    engine.askExecuting(inst("ask#1"));
    engine.askWaiting(inst("ask#1"), {
      cause: "backoff",
      reason: "rate_limited",
      attempt: 2,
      delayMs: 20_000,
      retryAfterMs: 20_000,
    });
    engine.concurrencyChanged({ key: "p/m", previous: 8, next: 4, reason: "rate_limited", lastGood: 4, cooldownMs: 20_000 });
    engine.askExecuting(inst("ask#1"));

    expect(driver.eventsOfType("node-waiting")).toEqual([
      { type: "node-waiting", instance: inst("ask#1"), cause: "slot" },
      {
        type: "node-waiting",
        instance: inst("ask#1"),
        cause: "backoff",
        reason: "rate_limited",
        attempt: 2,
        delayMs: 20_000,
        retryAfterMs: 20_000,
      },
    ]);
    expect(driver.eventsOfType("node-executing")).toEqual([
      { type: "node-executing", instance: inst("ask#1") },
      { type: "node-executing", instance: inst("ask#1") },
    ]);
    expect(driver.eventsOfType("concurrency-changed")).toEqual([
      { type: "concurrency-changed", key: "p/m", previous: 8, next: 4, reason: "rate_limited", lastGood: 4, cooldownMs: 20_000 },
    ]);
    // 观察事件不写 dwf_node：节点记录仍是准入时的 running。
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("running");
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("未知实例 / 已结算实例 / 已结算 run 上的观察被忽略", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askWaiting(inst("nope"), { cause: "slot" });
    engine.askExecuting(inst("nope"));
    engine.askTurnEnded(inst("ask#1"), "RA");
    await p;
    engine.askWaiting(inst("ask#1"), { cause: "backoff", reason: "timeout", attempt: 1, delayMs: 1 });
    engine.askExecuting(inst("ask#1"));
    engine.complete("done");
    await engine.settled;
    engine.concurrencyChanged({ key: "p/m", previous: 4, next: 5, reason: "recovered" });
    expect(driver.eventsOfType("node-waiting")).toEqual([]);
    expect(driver.eventsOfType("node-executing")).toEqual([]);
    expect(driver.eventsOfType("concurrency-changed")).toEqual([]);
  });
});
