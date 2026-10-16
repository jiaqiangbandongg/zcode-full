import { describe, expect, it } from "vitest";
import {
  HOLE_PROMPT_MAX_CHARS,
  InMemoryJournalStore,
  WorkflowEngine,
  WorkflowError,
  refToString,
  type AskSpec,
  type HoleFill,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

/**
 * 留白（docs/execution-engine.md「Holes」）：`hole` 铸序号、盖出生阶段、记 `hole-reached`、把
 * deferred 停在站点下；`fillHole` 在一个同步步骤里换规格表、写脚本、记 `hole-filled`、记住代码、
 * 兑现全部停驻。没有 journal 行：留白不是会自己结算的节点。
 */

const RUN = "run";
const untyped = (...ids: string[]): Map<string, AskSpec> =>
  new Map(ids.map((id) => [id, { typed: false } as AskSpec]));

interface SetupOpts {
  journal?: InMemoryJournalStore;
  sitePhases?: ReadonlyMap<string, string>;
  now?: () => number;
  launch?: { inputId: string; phaseNames?: string[]; holes?: number[] };
}

function setup(opts: SetupOpts = {}) {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const driver = new FakeDriver(journal, {});
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: untyped("ask#1"),
    validate: () => [],
    scriptText: "original",
    scriptHash: "h0",
    ...(opts.sitePhases === undefined ? {} : { sitePhases: opts.sitePhases }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.launch === undefined ? {} : { launch: opts.launch }),
  });
  return { journal, driver, engine };
}

/** 一份最小的补全：有效脚本的规格表是原表的超集，新站点都带 `hole#1/` 前缀。 */
function fillFor(overrides: Partial<HoleFill> = {}): HoleFill {
  return {
    siteId: "hole#1",
    code: "(async () => { return 42; })",
    script: { text: "effective", hash: "h1" },
    askSpecs: untyped("ask#1", "hole#1/ask#1"),
    sitePhases: new Map([["hole#1/ask#1", "Verdict"]]),
    phaseNames: ["Gather", "Verdict"],
    holes: [],
    filledBy: "session-main",
    ...overrides,
  };
}

/** 一个 promise 当前是否已经结算（不等待）。 */
async function settledState(p: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
  const marker = Symbol("pending");
  const result = await Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    Promise.resolve(marker),
  ]);
  return result === marker ? "pending" : result;
}

describe("WorkflowEngine — hole(): reach and park", () => {
  it("mints the site's ordinal, records hole-reached and parks the promise without a node row", async () => {
    const { engine, driver, journal } = setup({ now: () => 1000 });
    const promise = engine.hole("hole#1", "Verdict", "Decide.");
    expect(await settledState(promise)).toBe("pending");

    const reached = driver.eventsOfType("hole-reached");
    expect(reached).toEqual([
      {
        type: "hole-reached",
        instance: { siteId: "hole#1", ordinal: 1 },
        name: "Verdict",
        prompt: "Decide.",
      },
    ]);
    expect(journal.getNode(RUN, "hole#1", 1)).toBeUndefined();
    expect(journal.listNodes(RUN, { kinds: "all", withResult: false })).toEqual([]);
    expect(engine.openHoles()).toEqual([
      { siteId: "hole#1", ordinal: 1, name: "Verdict", since: 1000 },
    ]);
    expect(engine.filledHoles()).toEqual([]);
  });

  it("leaves prompt absent when the site has none", () => {
    const { engine, driver } = setup();
    void engine.hole("hole#1", "Verdict");
    const [reached] = driver.eventsOfType("hole-reached");
    expect(reached).not.toHaveProperty("prompt");
  });

  it("bounds the prompt to 4000 chars with a trailing ellipsis", () => {
    const { engine, driver } = setup();
    void engine.hole("hole#1", "Verdict", "x".repeat(HOLE_PROMPT_MAX_CHARS + 50));
    const [reached] = driver.eventsOfType("hole-reached");
    expect(reached?.prompt?.length).toBe(HOLE_PROMPT_MAX_CHARS);
    expect(reached?.prompt?.endsWith("…")).toBe(true);
    // 恰好到上限的不截。
    void engine.hole("hole#2", "Other", "y".repeat(HOLE_PROMPT_MAX_CHARS));
    expect(driver.eventsOfType("hole-reached")[1]?.prompt).toBe("y".repeat(HOLE_PROMPT_MAX_CHARS));
  });

  it("stamps the birth phase lexically first, then from the marker the script last passed", () => {
    const { engine, driver } = setup({ sitePhases: new Map([["hole#1", "Gather"]]) });
    engine.enterPhase("Verify");
    void engine.hole("hole#1", "A");
    void engine.hole("hole#2", "B");
    expect(driver.eventsOfType("hole-reached").map((e) => e.phaseName)).toEqual([
      "Gather",
      "Verify",
    ]);
  });

  it("counts ordinals per site: several reaches of one site park side by side", () => {
    const { engine, driver } = setup();
    void engine.hole("hole#1", "A");
    void engine.hole("hole#1", "A");
    expect(driver.eventsOfType("hole-reached").map((e) => refToString(e.instance))).toEqual([
      "hole#1@1",
      "hole#1@2",
    ]);
    expect(engine.openHoles().map((h) => h.ordinal)).toEqual([1, 2]);
  });

  it("rejects a reach on a settled run", async () => {
    const { engine } = setup();
    engine.stop("user");
    await expect(engine.hole("hole#1", "A")).rejects.toMatchObject({ code: "Cancelled" });
  });
});

describe("WorkflowEngine — fillHole(): one synchronous step", () => {
  it("swaps the specs and phases, writes the script, records hole-filled, releases the parked branch", async () => {
    const { engine, driver, journal } = setup({ now: () => 2000 });
    const promise = engine.hole("hole#1", "Verdict", "Decide.");
    const eventsBefore = driver.events.length;

    const result = engine.fillHole(fillFor());
    expect(result).toEqual({ ok: true });

    // 脚本两列同笔改写，其余不动。
    const row = journal.getRun(RUN);
    expect(row?.scriptText).toBe("effective");
    expect(row?.scriptHash).toBe("h1");
    expect(row?.status).toBe("running");
    // 恰好一条 hole-filled，紧跟在 fill 上。
    expect(driver.events.slice(eventsBefore)).toEqual([
      {
        type: "hole-filled",
        siteId: "hole#1",
        filledAt: 2000,
        filledBy: "session-main",
        phaseNames: ["Gather", "Verdict"],
        holes: [],
      },
    ]);
    await expect(promise).resolves.toEqual({ code: "(async () => { return 42; })" });
    expect(engine.openHoles()).toEqual([]);
    expect(engine.filledHoles()).toEqual([
      { siteId: "hole#1", filledAt: 2000, filledBy: "session-main" },
    ]);

    // 规格表已是有效脚本的：体内的 ask 站点不再是 MissingAskSpec，且出生阶段来自新表。
    const actor = engine.createActor("hole#1/actor#1", "judge");
    void engine.ask("hole#1/ask#1", actor, "judge it");
    await flush();
    expect(driver.eventsOfType("run-settled")).toEqual([]);
    const queued = driver
      .eventsOfType("node-queued")
      .find((e) => e.instance.siteId === "hole#1/ask#1");
    expect(queued?.phaseName).toBe("Verdict");
  });

  it("leaves filledBy and holes absent when the fill carries none", () => {
    const { engine, driver } = setup();
    void engine.hole("hole#1", "Verdict");
    engine.fillHole(fillFor({ filledBy: undefined, holes: undefined }));
    const [filled] = driver.eventsOfType("hole-filled");
    expect(filled).toEqual({
      type: "hole-filled",
      siteId: "hole#1",
      filledAt: expect.any(Number),
      phaseNames: ["Gather", "Verdict"],
    });
  });

  it("carries the draft a fill minted on hole-filled, and nothing when the fill has none", () => {
    const { engine, driver } = setup();
    void engine.hole("hole#1", "Verdict");
    engine.fillHole(fillFor({ scriptPath: "/repo/.zcode/workflow-drafts/nightly.dwf.ts" }));
    const [filled] = driver.eventsOfType("hole-filled");
    expect(filled).toMatchObject({ scriptPath: "/repo/.zcode/workflow-drafts/nightly.dwf.ts" });
    expect("scriptPath" in (driver.eventsOfType("hole-filled")[0] ?? {})).toBe(true);
    const { engine: plain, driver: plainDriver } = setup();
    void plain.hole("hole#1", "Verdict");
    plain.fillHole(fillFor());
    expect("scriptPath" in (plainDriver.eventsOfType("hole-filled")[0] ?? {})).toBe(false);
  });

  it("resolves every ordinal parked on the site", async () => {
    const { engine } = setup();
    const first = engine.hole("hole#1", "A");
    const second = engine.hole("hole#1", "A");
    engine.fillHole(fillFor());
    await expect(first).resolves.toEqual({ code: "(async () => { return 42; })" });
    await expect(second).resolves.toEqual({ code: "(async () => { return 42; })" });
  });

  it("answers a later reach of a filled site from memory: no park, no new hole-reached", async () => {
    const { engine, driver } = setup();
    void engine.hole("hole#1", "A");
    engine.fillHole(fillFor());
    const eventsBefore = driver.events.length;
    await expect(engine.hole("hole#1", "A")).resolves.toEqual({
      code: "(async () => { return 42; })",
    });
    expect(driver.events.length).toBe(eventsBefore);
    expect(engine.openHoles()).toEqual([]);
  });

  it("is not_waiting when nothing is parked and nothing remembered, writing and emitting nothing", () => {
    const { engine, driver, journal } = setup();
    const eventsBefore = driver.events.length;
    expect(engine.fillHole(fillFor())).toEqual({ ok: false, reason: "not_waiting" });
    expect(driver.events.length).toBe(eventsBefore);
    expect(journal.getRun(RUN)?.scriptText).toBe("original");
    // 另一个站点在等也不算：停驻按站点。
    void engine.hole("hole#2", "B");
    expect(engine.fillHole(fillFor())).toEqual({ ok: false, reason: "not_waiting" });
    expect(journal.getRun(RUN)?.scriptText).toBe("original");
  });

  it("is settled on a settled run, writing and emitting nothing", () => {
    const { engine, driver, journal } = setup();
    engine.hole("hole#1", "A").catch(() => undefined);
    engine.stop("user");
    const eventsBefore = driver.events.length;
    expect(engine.fillHole(fillFor())).toEqual({ ok: false, reason: "settled" });
    expect(driver.events.length).toBe(eventsBefore);
    expect(journal.getRun(RUN)?.scriptText).toBe("original");
  });
});

describe("WorkflowEngine — settlement rejects parked holes", () => {
  it("stop rejects with Cancelled and empties the parked set", async () => {
    const { engine } = setup();
    const promise = engine.hole("hole#1", "A");
    engine.stop("user");
    await expect(promise).rejects.toMatchObject({ code: "Cancelled" });
    expect(engine.openHoles()).toEqual([]);
  });

  it("complete rejects the parked branch (a hole nobody awaited)", async () => {
    const { engine } = setup();
    const promise = engine.hole("hole#1", "A");
    engine.complete("done");
    await expect(promise).rejects.toMatchObject({ code: "Cancelled" });
  });

  it("fail rejects with the run's failure", async () => {
    const { engine } = setup();
    const promise = engine.hole("hole#1", "A");
    engine.fail(new WorkflowError("DriverError", "script threw"));
    await expect(promise).rejects.toMatchObject({ code: "DriverError", message: "script threw" });
  });

  it("keeps the fill memory out of settlement: filledHoles still lists the fill", () => {
    const { engine } = setup();
    void engine.hole("hole#1", "A");
    engine.fillHole(fillFor());
    engine.stop("user");
    expect(engine.filledHoles().map((h) => h.siteId)).toEqual(["hole#1"]);
  });
});

describe("WorkflowEngine — holes across lives", () => {
  it("run-launched carries the open-hole index table beside phaseNames", () => {
    const { driver } = setup({
      launch: { inputId: "in-1", phaseNames: ["Gather", "Verdict"], holes: [1] },
    });
    expect(driver.eventsOfType("run-launched")[0]).toMatchObject({
      phaseNames: ["Gather", "Verdict"],
      holes: [1],
    });
  });

  it("a run stopped while waiting resumes with nothing parked and re-reaches with a fresh hole-reached", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.hole("hole#1", "A", "Decide.").catch(() => undefined);
    first.engine.stop("user");

    const driver = new FakeDriver(journal, {});
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: untyped("ask#1"),
      validate: () => [],
      scriptText: "original",
      scriptHash: "h0",
    });
    expect(engine.openHoles()).toEqual([]);
    expect(engine.filledHoles()).toEqual([]);
    const promise = engine.hole("hole#1", "A", "Decide.");
    expect(await settledState(promise)).toBe("pending");
    expect(driver.eventsOfType("hole-reached")).toHaveLength(1);
    // 整段日志里现在有两条 hole-reached：上一世一条、这一世一条，序号都从 1 起（没有行可撞）。
    const all = journal.listEvents(RUN, { types: ["hole-reached"], reportItems: "all" });
    expect(
      all.map((e) => (e.event.type === "hole-reached" ? refToString(e.event.instance) : "")),
    ).toEqual(["hole#1@1", "hole#1@1"]);
  });

  it("resume of a filled run replays against the effective script's hash", () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    void first.engine.hole("hole#1", "A");
    first.engine.fillHole(fillFor());
    first.engine.stop("user");

    // 旧哈希：拒绝；新哈希：接受（两列同笔写，所以校验成立）。
    const driver = new FakeDriver(journal, {});
    const config = {
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: untyped("ask#1"),
      validate: () => [],
    };
    expect(
      () => new WorkflowEngine({ ...config, scriptText: "original", scriptHash: "h0" }),
    ).toThrow(/script changed/);
    expect(
      () => new WorkflowEngine({ ...config, scriptText: "effective", scriptHash: "h1" }),
    ).not.toThrow();
  });
});

describe("WorkflowEngine — recursive holes (a fill that contains an open hole)", () => {
  const INNER = "hole#1/hole#1";

  it("fills the inner site while the outer's fill is remembered: nested ids, superset tables, hole-filled by nested siteId", async () => {
    const { engine, driver, journal } = setup({ now: () => 3000 });
    void engine.hole("hole#1", "outer", "p");
    // 外层的有效脚本：内层留白的站点带外层前缀，词法上出生在外层的阶段。
    expect(
      engine.fillHole(
        fillFor({
          askSpecs: untyped("ask#1", "hole#1/ask#1"),
          sitePhases: new Map([
            ["hole#1/ask#1", "Verdict"],
            [INNER, "Verdict"],
          ]),
          phaseNames: ["Gather", "Verdict", "inner"],
          holes: [2],
          script: { text: "effective-1", hash: "h1" },
        }),
      ),
    ).toEqual({ ok: true });

    const inner = engine.hole(INNER, "inner", "q");
    expect(driver.eventsOfType("hole-reached").at(-1)).toEqual({
      type: "hole-reached",
      instance: { siteId: INNER, ordinal: 1 },
      name: "inner",
      prompt: "q",
      phaseName: "Verdict",
    });
    expect(engine.openHoles()).toEqual([{ siteId: INNER, ordinal: 1, name: "inner", since: 3000 }]);
    // 外层已记住，内层在等：对外层再补全不是 not_waiting（记忆在），对一个无人问津的站点才是。
    expect(engine.fillHole(fillFor({ siteId: "hole#2" }))).toEqual({
      ok: false,
      reason: "not_waiting",
    });

    const eventsBefore = driver.events.length;
    expect(
      engine.fillHole(
        fillFor({
          siteId: INNER,
          code: "(async () => { return before + inside; })",
          askSpecs: untyped("ask#1", "hole#1/ask#1", `${INNER}/ask#1`),
          sitePhases: new Map([
            ["hole#1/ask#1", "Verdict"],
            [INNER, "Verdict"],
            [`${INNER}/ask#1`, "Verdict"],
          ]),
          phaseNames: ["Gather", "Verdict"],
          holes: undefined,
          filledBy: "session-main",
          script: { text: "effective-2", hash: "h2" },
        }),
      ),
    ).toEqual({ ok: true });
    expect(driver.events.slice(eventsBefore)).toEqual([
      {
        type: "hole-filled",
        siteId: INNER,
        filledAt: 3000,
        filledBy: "session-main",
        phaseNames: ["Gather", "Verdict"],
      },
    ]);
    await expect(inner).resolves.toEqual({ code: "(async () => { return before + inside; })" });
    expect(engine.openHoles()).toEqual([]);
    expect(engine.filledHoles().map((h) => h.siteId)).toEqual(["hole#1", INNER]);
    expect(journal.getRun(RUN)).toMatchObject({ scriptText: "effective-2", scriptHash: "h2" });

    // 第二份有效脚本的规格表已生效：内层体内的 ask 站点有 spec，出生阶段来自新表。
    const actor = engine.createActor(`${INNER}/actor#1`, "judge");
    void engine.ask(`${INNER}/ask#1`, actor, "judge");
    await flush();
    expect(driver.eventsOfType("run-settled")).toEqual([]);
    expect(
      driver.eventsOfType("node-queued").find((e) => e.instance.siteId === `${INNER}/ask#1`)
        ?.phaseName,
    ).toBe("Verdict");

    // 两个站点都记住了：再到达任一个都立刻作答、不停驻、不记事件。
    const after = driver.events.length;
    await expect(engine.hole("hole#1", "outer")).resolves.toEqual({
      code: "(async () => { return 42; })",
    });
    await expect(engine.hole(INNER, "inner")).resolves.toEqual({
      code: "(async () => { return before + inside; })",
    });
    expect(driver.events.length).toBe(after);
  });

  it("stop while the inner is parked rejects it and keeps both fills in memory", async () => {
    const { engine } = setup();
    void engine.hole("hole#1", "outer");
    engine.fillHole(fillFor());
    const inner = engine.hole(INNER, "inner");
    engine.stop("user");
    await expect(inner).rejects.toMatchObject({ code: "Cancelled" });
    expect(engine.openHoles()).toEqual([]);
    expect(engine.filledHoles().map((h) => h.siteId)).toEqual(["hole#1"]);
  });
});
