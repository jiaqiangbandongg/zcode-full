/**
 * 留白在 cell 里、在站点处求值（docs/execution-engine.md「The vm cell」的 Holes 段与「## Holes」）。
 * 这些 lowered 体是手写的（与 security.test.ts 同一正当性）：被测对象是 `__host.hole` shim、
 * 线协议的 `hole` 请求、harness 的路由与控制面的 `fillHole` 绑定，不是编译器。
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  type AskSpec,
  type FillHoleResult,
  type HoleFill,
  type RunEvent,
  type RunSettlement,
  type WorkflowEngine,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript, type RunControlBinding } from "../src/index.js";
import { AutoDriver, type AutoDriverConfig } from "./auto-driver.js";
import { TEST_CWD } from "./helpers.js";

type BoundEngine = Pick<
  WorkflowEngine,
  "setMaxConcurrency" | "fillHole" | "openHoles" | "filledHoles"
>;
type HoleReached = Extract<RunEvent, { type: "hole-reached" }>;

interface RunLoweredOptions {
  asks?: AutoDriverConfig["asks"];
  askSpecs?: Map<string, AskSpec>;
  signal?: AbortSignal;
  /**
   * 每条引擎事件都经这里（同步、在 driver.emit 里）；`engine()` 取控制面绑下来的这一世的引擎。
   * 惰性取：首条 `run-started` 在引擎构造函数里发出，早于 harness 绑控制面。
   */
  onEvent?: (event: RunEvent, engine: () => BoundEngine) => void;
}

interface RunLoweredResult {
  settlement: RunSettlement;
  driver: AutoDriver;
  journal: InMemoryJournalStore;
}

const untyped = (...ids: string[]): Map<string, AskSpec> =>
  new Map(ids.map((id) => [id, { typed: false } as AskSpec]));

let runSeq = 0;

/** 直接投喂手写 lowered 体（自由标识符仅 `__host`），把控制面句柄与事件钩子接给测试。 */
async function runLowered(
  lowered: string,
  opts: RunLoweredOptions = {},
): Promise<RunLoweredResult> {
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal, { asks: opts.asks });
  let engine: BoundEngine | undefined;
  const control: RunControlBinding = {
    bind(bound) {
      engine = bound;
    },
  };
  const requireEngine = (): BoundEngine => {
    if (engine === undefined) throw new Error("control was never bound to an engine");
    return engine;
  };
  const emit = driver.emit.bind(driver);
  driver.emit = (event: RunEvent): void => {
    emit(event);
    opts.onEvent?.(event, requireEngine);
  };
  const settlement = await runWorkflowScript({
    cwd: TEST_CWD,
    runId: `holes-${++runSeq}`,
    lowered,
    caps: { maxConcurrency: 4 },
    askSpecs: opts.askSpecs ?? new Map(),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    control,
    timeoutMs: 15000,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  return { settlement, driver, journal };
}

/** 一份补全：规格表是原表的超集，新站点都带 `hole#1/` 前缀。 */
function fillFor(code: string, overrides: Partial<HoleFill> = {}): HoleFill {
  return {
    siteId: "hole#1",
    code,
    script: { text: "effective", hash: "h1" },
    askSpecs: untyped("ask#1", "hole#1/ask#1"),
    sitePhases: new Map(),
    phaseNames: [],
    ...overrides,
  };
}

/** 在第一条 hole-reached 上补全（恰好一次），并把补全结果与到达事件留给断言。 */
function fillOnReach(code: string, overrides: Partial<HoleFill> = {}) {
  const reached: HoleReached[] = [];
  const results: FillHoleResult[] = [];
  const onEvent = (event: RunEvent, engine: () => BoundEngine): void => {
    if (event.type !== "hole-reached") return;
    reached.push(event);
    if (reached.length === 1) results.push(engine().fillHole(fillFor(code, overrides)));
  };
  return { onEvent, reached, results };
}

function artifactOf(settlement: RunSettlement): unknown {
  expect(settlement.status).toBe("completed");
  return (settlement as { status: "completed"; artifact: unknown }).artifact;
}

describe("holes — evaluated at the site", () => {
  it("the fill reads a const declared before the hole, and the request carries name and prompt", async () => {
    const hook = fillOnReach("(async () => { return base + 2; })", { filledBy: "main" });
    const { settlement, driver } = await runLowered(
      [
        "const base = 40;",
        'const v = await __host.hole("hole#1", "Verdict", "Decide on base.", (__src) => eval(__src));',
        "return v;",
      ].join("\n"),
      { onEvent: hook.onEvent },
    );
    expect(artifactOf(settlement)).toBe(42);
    expect(hook.results).toEqual([{ ok: true }]);
    expect(hook.reached).toEqual([
      {
        type: "hole-reached",
        instance: { siteId: "hole#1", ordinal: 1 },
        name: "Verdict",
        prompt: "Decide on base.",
      },
    ]);
    expect(driver.eventsOfType("hole-filled")).toEqual([
      {
        type: "hole-filled",
        siteId: "hole#1",
        filledAt: expect.any(Number),
        filledBy: "main",
        phaseNames: [],
      },
    ]);
  });

  it("the fill's own lowered sites run through __host (an ask inside the body)", async () => {
    const hook = fillOnReach(
      [
        "(async () => {",
        '  const judge = __host.createActor("hole#1/actor#1", "judge");',
        '  return await __host.ask("hole#1/ask#1", judge, "judge " + subject);',
        "})",
      ].join("\n"),
    );
    const { settlement, driver } = await runLowered(
      [
        'const subject = "the patch";',
        'const verdict = await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src));',
        "return verdict;",
      ].join("\n"),
      {
        onEvent: hook.onEvent,
        asks: {
          "hole#1/ask#1": ({ message }) => ({
            type: "text",
            finalText: `verdict on: ${message.instructions}`,
          }),
        },
      },
    );
    expect(artifactOf(settlement)).toBe("verdict on: judge the patch");
    expect(driver.eventsOfType("node-settled").map((e) => e.instance.siteId)).toEqual([
      "hole#1/ask#1",
    ]);
  });

  it("a hole in a loop is filled once and its body runs per iteration with that iteration's binding", async () => {
    const hook = fillOnReach("(async () => { return i * 10; })");
    const { settlement, driver } = await runLowered(
      [
        "const out = [];",
        "for (const i of [1, 2, 3]) {",
        '  out.push(await __host.hole("hole#1", "Scale", undefined, (__src) => eval(__src)));',
        "}",
        "return out;",
      ].join("\n"),
      { onEvent: hook.onEvent },
    );
    expect(artifactOf(settlement)).toEqual([10, 20, 30]);
    // 一次到达、一次补全：后两轮由 cell 的 fill 表作答，不过线。
    expect(hook.reached).toHaveLength(1);
    expect(driver.eventsOfType("hole-reached")).toHaveLength(1);
    expect(driver.eventsOfType("hole-filled")).toHaveLength(1);
  });

  it("a thrown fill rejects at the site and the script can catch it", async () => {
    const hook = fillOnReach('(async () => { throw new Error("boom"); })');
    const { settlement } = await runLowered(
      [
        "try {",
        '  await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src));',
        '  return "NO-THROW";',
        "} catch (e) {",
        "  return e.message;",
        "}",
      ].join("\n"),
      { onEvent: hook.onEvent },
    );
    expect(artifactOf(settlement)).toBe("boom");
  });

  it("a fill that does not parse rejects at the site too, as a SyntaxError", async () => {
    const hook = fillOnReach("(async () => { return ; ; )");
    const { settlement } = await runLowered(
      [
        "try {",
        '  await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src));',
        '  return "NO-THROW";',
        "} catch (e) {",
        "  return e.name;",
        "}",
      ].join("\n"),
      { onEvent: hook.onEvent },
    );
    expect(artifactOf(settlement)).toBe("SyntaxError");
  });

  it("a filled hole (body present) sends no wire message", async () => {
    const seen: string[] = [];
    const { settlement, driver } = await runLowered(
      [
        "const base = 5;",
        'const v = await __host.hole("hole#1", "Verdict", "p", (__src) => eval(__src), async () => { return base + 2; });',
        "return v;",
      ].join("\n"),
      {
        onEvent: (event) => {
          seen.push(event.type);
        },
      },
    );
    expect(artifactOf(settlement)).toBe(7);
    expect(seen).not.toContain("hole-reached");
    expect(driver.eventsOfType("hole-reached")).toEqual([]);
  });

  it("a body that throws synchronously rejects at the site rather than escaping the call", async () => {
    const { settlement } = await runLowered(
      [
        "try {",
        '  await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src), () => { throw new Error("sync"); });',
        '  return "NO-THROW";',
        "} catch (e) {",
        "  return e.message;",
        "}",
      ].join("\n"),
    );
    expect(artifactOf(settlement)).toBe("sync");
  });
});

describe("holes — a parked hole is a request in flight", () => {
  it("siblings keep running while the hole waits, and the stall detector stays quiet", async () => {
    let reachedCount = 0;
    let siblingSettled = false;
    let filled = false;
    let openWhileSiblingSettled: number | undefined;
    const results: FillHoleResult[] = [];
    const { settlement } = await runLowered(
      [
        'const worker = __host.createActor("actor#1", "w");',
        'const side = __host.future(async () => __host.ask("ask#1", worker, "hi"));',
        'const v = await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src));',
        "return [await side, v];",
      ].join("\n"),
      {
        askSpecs: untyped("ask#1"),
        asks: { "ask#1": () => ({ type: "text", finalText: "sibling done" }) },
        onEvent: (event, engine) => {
          if (event.type === "hole-reached") reachedCount += 1;
          if (event.type === "node-settled" && event.instance.siteId === "ask#1") {
            openWhileSiblingSettled = reachedCount;
            siblingSettled = true;
          }
          // 两件事都发生之后才补全，不论谁先到。修复原因：原先在兄弟 ask 结算的那一刻就补全，
          // 兄弟若先于留白被到达就结算，补全被拒（hole_not_waiting），run 永远停在留白处，用例
          // 5 秒超时——约三次里一次。停滞检测若开过火，run 早就 errored 了，结论不变。
          // 先立旗再补全：fillHole 同步发出 hole-filled，会重入这个回调。
          if (reachedCount > 0 && siblingSettled && !filled) {
            filled = true;
            results.push(engine().fillHole(fillFor("(async () => { return 1; })")));
          }
        },
      },
    );
    expect(artifactOf(settlement)).toEqual(["sibling done", 1]);
    // 兄弟可能在留白被到达之前或之后结算；两种次序下留白都只被到达一次、补全一次。
    expect([0, 1]).toContain(openWhileSiblingSettled);
    expect(reachedCount).toBe(1);
    expect(results).toEqual([{ ok: true }]);
  });

  it("a cancel while parked stops the run and the sandbox goes down with it", async () => {
    const controller = new AbortController();
    const { settlement, driver } = await runLowered(
      'await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src)); return "NO";',
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "hole-reached") controller.abort("user");
        },
      },
    );
    expect(settlement).toEqual({ status: "stopped", reason: "user" });
    expect(driver.eventsOfType("hole-filled")).toEqual([]);
  });

  it("the control binding hands out fillHole, openHoles and filledHoles beside setMaxConcurrency", async () => {
    let bound: BoundEngine | undefined;
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal);
    await runWorkflowScript({
      cwd: TEST_CWD,
      runId: `holes-${++runSeq}`,
      lowered: "return 1;",
      caps: { maxConcurrency: 4 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      control: {
        bind(engine) {
          bound = engine;
        },
      },
      timeoutMs: 15000,
    });
    expect(typeof bound?.fillHole).toBe("function");
    // 快照投影的两个只读面也经这条绑定交出去（run 已结算：停驻表空、本世没有补全）。
    expect(bound?.openHoles()).toEqual([]);
    expect(bound?.filledHoles()).toEqual([]);
    // 结算之后是 no-op：`settled`，不写不发。
    expect(bound?.fillHole(fillFor("(async () => 1)"))).toEqual({ ok: false, reason: "settled" });
  });
});

/** 内层留白的站点 id 带外层前缀（docs/analysis.md「Sites」）：外层的体是有效脚本的一部分，体内的站点都是 `hole#1/…`。 */
const INNER = "hole#1/hole#1";

/** 外层补全的体：声明一个 const，再到达一处内层留白，把内层的值原样返回。 */
const OUTER_WITH_INNER = [
  "(async () => {",
  '  const inside = "I" + (typeof i === "undefined" ? "" : i);',
  `  return await __host.hole("${INNER}", "inner", "q", (__src) => eval(__src));`,
  "})",
].join("\n");

describe("holes — recursive: a fill that contains an open hole", () => {
  it("the inner request goes out with the nested siteId, parks only that branch, and its fill reads both scopes", async () => {
    const reached: HoleReached[] = [];
    const results: FillHoleResult[] = [];
    let openWhileInnerParked: unknown;
    const { settlement, driver } = await runLowered(
      [
        'const before = "B";',
        'const worker = __host.createActor("actor#1", "w");',
        'const side = __host.future(async () => __host.ask("ask#1", worker, "hi"));',
        'const v = await __host.hole("hole#1", "outer", "p", (__src) => eval(__src));',
        "return [await side, v];",
      ].join("\n"),
      {
        askSpecs: untyped("ask#1"),
        asks: { "ask#1": () => ({ type: "text", finalText: "sibling done" }) },
        onEvent: (event, engine) => {
          if (event.type !== "hole-reached") return;
          reached.push(event);
          if (event.instance.siteId === "hole#1") {
            results.push(engine().fillHole(fillFor(OUTER_WITH_INNER)));
            return;
          }
          // 内层停驻期间只有它自己在飞：拖一段真时间再补全，停滞检测若把停驻的留白当成
          // 「无在飞请求」，run 会在这段时间里 errored。
          openWhileInnerParked = engine().openHoles();
          setTimeout(() => {
            results.push(
              engine().fillHole(
                fillFor("(async () => { return before + inside; })", {
                  siteId: INNER,
                  askSpecs: untyped("ask#1", "hole#1/ask#1", `${INNER}/ask#1`),
                }),
              ),
            );
          }, 30);
        },
      },
    );
    expect(artifactOf(settlement)).toEqual(["sibling done", "BI"]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(reached.map((e) => [e.instance.siteId, e.instance.ordinal, e.name, e.prompt])).toEqual([
      ["hole#1", 1, "outer", "p"],
      [INNER, 1, "inner", "q"],
    ]);
    expect(openWhileInnerParked).toEqual([
      { siteId: INNER, ordinal: 1, name: "inner", since: expect.any(Number) },
    ]);
    expect(driver.eventsOfType("hole-filled").map((e) => e.siteId)).toEqual(["hole#1", INNER]);
  });

  it("reached again in a loop, both are answered from the cell's fill table and the inner sees the iteration's binding", async () => {
    const results: FillHoleResult[] = [];
    const { settlement, driver } = await runLowered(
      [
        'const before = "B";',
        "const out = [];",
        "for (const i of [1, 2, 3]) {",
        '  out.push(await __host.hole("hole#1", "outer", undefined, (__src) => eval(__src)));',
        "}",
        "return out;",
      ].join("\n"),
      {
        onEvent: (event, engine) => {
          if (event.type !== "hole-reached") return;
          if (event.instance.siteId === "hole#1") {
            results.push(engine().fillHole(fillFor(OUTER_WITH_INNER)));
          } else {
            results.push(
              engine().fillHole(
                fillFor("(async () => { return before + inside; })", { siteId: INNER }),
              ),
            );
          }
        },
      },
    );
    expect(artifactOf(settlement)).toEqual(["BI1", "BI2", "BI3"]);
    // 两个站点各到达一次、各补全一次；后两轮外层与内层都不过线。
    expect(driver.eventsOfType("hole-reached").map((e) => e.instance.siteId)).toEqual([
      "hole#1",
      INNER,
    ]);
    expect(driver.eventsOfType("hole-filled").map((e) => e.siteId)).toEqual(["hole#1", INNER]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("an inner fill that throws rejects the inner site; uncaught, it propagates out of the outer body to the outer awaiter", async () => {
    const fillBoth = (event: RunEvent, engine: () => BoundEngine): void => {
      if (event.type !== "hole-reached") return;
      if (event.instance.siteId === "hole#1")
        return void engine().fillHole(fillFor(OUTER_WITH_INNER));
      engine().fillHole(
        fillFor('(async () => { throw new Error("inner boom"); })', { siteId: INNER }),
      );
    };
    const uncaught = await runLowered(
      [
        "try {",
        '  await __host.hole("hole#1", "outer", undefined, (__src) => eval(__src));',
        '  return "NO-THROW";',
        "} catch (e) {",
        '  return "outer caught: " + e.message;',
        "}",
      ].join("\n"),
      { onEvent: fillBoth },
    );
    expect(artifactOf(uncaught.settlement)).toBe("outer caught: inner boom");
  });

  it("an inner rejection caught inside the outer body stays inside it", async () => {
    const outerCatching = [
      "(async () => {",
      "  try {",
      `    return await __host.hole("${INNER}", "inner", undefined, (__src) => eval(__src));`,
      "  } catch (e) {",
      '    return "inner caught: " + e.message;',
      "  }",
      "})",
    ].join("\n");
    const { settlement } = await runLowered(
      'return await __host.hole("hole#1", "outer", undefined, (__src) => eval(__src));',
      {
        onEvent: (event, engine) => {
          if (event.type !== "hole-reached") return;
          if (event.instance.siteId === "hole#1")
            return void engine().fillHole(fillFor(outerCatching));
          engine().fillHole(
            fillFor('(async () => { throw new Error("inner boom"); })', { siteId: INNER }),
          );
        },
      },
    );
    expect(artifactOf(settlement)).toBe("inner caught: inner boom");
  });
});
