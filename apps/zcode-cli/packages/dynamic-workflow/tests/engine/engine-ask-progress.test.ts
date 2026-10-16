/**
 * ask 的两条「它在干什么」事实（docs/execution-engine.md「Events」/「Progress within an ask」）：
 *   - ask 的 `node-queued` 带上作者指令的开头（`instructionsHead`，≤ 240 字符，不加省略号）；
 *   - driver 的 `askProgress` 被引擎**原样** record 成 `node-progress`——不改调度、不写 dwf_node，
 *     且与 usage 同规：run 结算后到达的观察被丢掉。
 * fixture 姿态照 engine-concurrency-observations.test.ts。
 */

import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_HEAD_MAX_CHARS,
  InMemoryJournalStore,
  WorkflowEngine,
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

describe("node-queued 上的 instructionsHead", () => {
  it("短指令原样带上（去两端空白）", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "  审一遍 auth 模块的错误路径  ");
    await flush();
    expect(driver.eventsOfType("node-queued")[0]?.instructionsHead).toBe(
      "审一遍 auth 模块的错误路径",
    );
    engine.askTurnEnded(inst("ask#1"), "done");
    await expect(p).resolves.toBe("done");
  });

  it("长指令截到上限且**不**加省略号（省略号是渲染的事，不是载荷的事）", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const long = "x".repeat(INSTRUCTIONS_HEAD_MAX_CHARS + 50);
    void engine.ask("ask#1", actor, long);
    await flush();
    const head = driver.eventsOfType("node-queued")[0]?.instructionsHead;
    expect(head).toBe("x".repeat(INSTRUCTIONS_HEAD_MAX_CHARS));
    expect(head?.endsWith("…")).toBe(false);
  });

  it("空指令让键缺席，而不是落一个空串（缺席才诚实）", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "   \n  ");
    await flush();
    expect(driver.eventsOfType("node-queued")[0]).not.toHaveProperty("instructionsHead");
  });

  it("world read 的 node-queued 不带它（那里没有作者指令可言）", async () => {
    const { engine, driver } = setup();
    void engine.worldRead("world#1", "files.glob", ["**/*.ts"]);
    await flush();
    const queued = driver.eventsOfType("node-queued").find((e) => e.kind !== "ask");
    expect(queued).toBeDefined();
    expect(queued).not.toHaveProperty("instructionsHead");
  });
});

describe("askProgress → node-progress（纯透传）", () => {
  it("原样落事件，且先于同一次 turn 的 usage-updated", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    driver.events.length = 0;

    engine.askProgress(inst("ask#1"), {
      turn: 2,
      toolCalls: 7,
      lastTool: { name: "Read", target: "src/auth/session.ts" },
    });
    engine.askStats(inst("ask#1"), { tokens: 20, toolCalls: 7, turns: 2 });

    expect(driver.events.map((e) => e.type)).toEqual(["node-progress", "usage-updated"]);
    expect(driver.eventsOfType("node-progress")[0]).toEqual({
      type: "node-progress",
      instance: { siteId: "ask#1", ordinal: 1 },
      turn: 2,
      toolCalls: 7,
      lastTool: { name: "Read", target: "src/auth/session.ts" },
    });
    engine.askTurnEnded(inst("ask#1"), "R");
    await expect(p).resolves.toBe("R");
  });

  it("lastTool 缺席时事件上也缺席", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "A");
    await flush();
    engine.askProgress(inst("ask#1"), { turn: 1, toolCalls: 0 });
    expect(driver.eventsOfType("node-progress")[0]).not.toHaveProperty("lastTool");
  });

  it("不改任何调度：不写 dwf_node 行，不动 ask 的结算", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    const before = journal.getNode(RUN, "ask#1", 1);
    engine.askProgress(inst("ask#1"), { turn: 1, toolCalls: 3 });
    expect(journal.getNode(RUN, "ask#1", 1)).toEqual(before);
    expect(driver.startAskCount()).toBe(1);
    engine.askTurnEnded(inst("ask#1"), "R");
    await expect(p).resolves.toBe("R");
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
  });

  it("落 journal，与实时轨拿到同一条", async () => {
    const { engine, journal } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "A");
    await flush();
    engine.askProgress(inst("ask#1"), { turn: 1, toolCalls: 1, lastTool: { name: "Bash" } });
    const stored = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .filter((e) => e.event.type === "node-progress");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.event).toMatchObject({ turn: 1, toolCalls: 1, lastTool: { name: "Bash" } });
  });

  it("run 结算之后到达的观察被丢掉（与 usage 同规：不给完结的 run 长尾巴）", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "R");
    await expect(p).resolves.toBe("R");
    engine.complete(undefined);
    driver.events.length = 0;
    engine.askProgress(inst("ask#1"), { turn: 9, toolCalls: 9 });
    expect(driver.eventsOfType("node-progress")).toHaveLength(0);
  });
});
