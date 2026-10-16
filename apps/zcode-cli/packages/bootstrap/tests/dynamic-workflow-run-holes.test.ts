/**
 * 留白的宿主侧纯合成规则（dynamic-workflow-run-holes.ts；docs/execution-engine.md「Holes」）：
 * 编译期事实表、`run-launched.holes` 的下标、快照投影（`waiting` 只听引擎的）与补全诊断的落点映射。
 * 端到端（引擎停驻 → 补全 → 草稿改写）在 dynamic-workflow-run-service.test.ts 的留白那组用例里。
 */

import { describe, expect, it } from "vitest";
import {
  collectSites,
  createWorkflowProgram,
  holeSiteId,
  spliceHoleBody,
  type StoredEvent,
} from "@zcode/dynamic-workflow";
import {
  compiledHolesOf,
  mapFillDiagnostics,
  openHoleIndexes,
  phaseNamesFromEvents,
  projectRunHoles,
  type CompiledHole,
} from "../src/app/dynamic-workflow-run-holes.js";

const HOLE_SCRIPT = [
  'phase("准备");',
  'const a = await agent("worker").ask<{ text: string }>("do the thing");',
  'const v = await hole<string>("裁决", `decide on ${a.text}`);',
  'phase("收尾");',
  'const b = await agent("closer").ask<{ text: string }>("close");',
  "return v + b.text;",
].join("\n");

// 留白 id 是名字键（docs/analysis.md「Sites」）：按名字取，不写死哈希。
const VERDICT = holeSiteId("裁决");

const HOLES: CompiledHole[] = [
  { siteId: VERDICT, name: "裁决", type: "string", line: 3, open: true },
];

function stored(sequence: number, event: StoredEvent["event"], timeCreated?: number): StoredEvent {
  return { sequence, event, ...(timeCreated === undefined ? {} : { timeCreated }) };
}

describe("compiledHolesOf", () => {
  it("reads name, type argument text, call line and openness off the site table", () => {
    const table = collectSites(createWorkflowProgram(HOLE_SCRIPT));
    expect(compiledHolesOf(table)).toEqual(HOLES);
  });

  it("a filled hole is no longer open, and its body's sites carry the hole prefix", () => {
    const table = collectSites(createWorkflowProgram(HOLE_SCRIPT));
    const spliced = spliceHoleBody(HOLE_SCRIPT, table, VERDICT, 'return "ok";');
    const filled = collectSites(createWorkflowProgram(spliced!.text));
    expect(compiledHolesOf(filled)).toEqual([{ ...HOLES[0], open: false }]);
  });
});

describe("openHoleIndexes", () => {
  it("indexes the declared phase table by the names of the open holes", () => {
    expect(openHoleIndexes(["准备", "裁决", "收尾"], HOLES)).toEqual([1]);
  });

  it("is absent without a phase table, without open holes, or when nothing matches", () => {
    expect(openHoleIndexes(undefined, HOLES)).toBeUndefined();
    expect(openHoleIndexes(["准备", "裁决"], [{ ...HOLES[0]!, open: false }])).toBeUndefined();
    expect(openHoleIndexes(["准备", "收尾"], HOLES)).toBeUndefined();
  });
});

describe("phaseNamesFromEvents", () => {
  it("takes the declared table, then the effective table of the last fill", () => {
    const events = [
      stored(0, { type: "run-launched", inputId: "i", phaseNames: ["准备", "裁决"], holes: [1] }),
      stored(1, {
        type: "hole-filled",
        siteId: VERDICT,
        filledAt: 5,
        phaseNames: ["准备", "裁决", "复核"],
      }),
    ];
    expect(phaseNamesFromEvents(events)).toEqual(["准备", "裁决", "复核"]);
    expect(phaseNamesFromEvents([events[0]!])).toEqual(["准备", "裁决"]);
    expect(phaseNamesFromEvents([])).toBeUndefined();
  });
});

describe("projectRunHoles", () => {
  const reached = stored(
    3,
    { type: "hole-reached", instance: { siteId: VERDICT, ordinal: 1 }, name: "裁决", prompt: "p" },
    1_000,
  );

  it("waiting only while the engine says the instance is parked, enriched with type, line and neighbours", () => {
    const holes = projectRunHoles({
      events: [reached],
      openHoles: [{ siteId: VERDICT, ordinal: 1, name: "裁决", since: 1_000 }],
      holes: HOLES,
      phaseNames: ["准备", "裁决", "收尾"],
    });
    expect(holes).toEqual([
      {
        siteId: VERDICT,
        ordinal: 1,
        name: "裁决",
        type: "string",
        state: "waiting",
        since: 1_000,
        line: 3,
        before: "准备",
        after: "收尾",
      },
    ]);
  });

  it("a reached hole nobody is parked at (dead process) is not reported as waiting", () => {
    expect(
      projectRunHoles({
        events: [reached],
        openHoles: undefined,
        holes: HOLES,
        phaseNames: undefined,
      }),
    ).toEqual([]);
    expect(
      projectRunHoles({ events: [reached], openHoles: [], holes: HOLES, phaseNames: undefined }),
    ).toEqual([]);
  });

  it("filled comes from the hole-filled event, with the filler and the effective table's neighbours", () => {
    const filled = stored(4, {
      type: "hole-filled",
      siteId: VERDICT,
      filledAt: 2_000,
      filledBy: "sess_main",
      phaseNames: ["准备", "裁决", "复核", "收尾"],
    });
    const holes = projectRunHoles({
      events: [reached, filled],
      openHoles: [],
      holes: [{ ...HOLES[0]!, open: false }],
      phaseNames: ["准备", "裁决", "复核", "收尾"],
    });
    expect(holes).toEqual([
      {
        siteId: VERDICT,
        ordinal: 1,
        name: "裁决",
        type: "string",
        state: "filled",
        filledAt: 2_000,
        filledBy: "sess_main",
        line: 3,
        before: "准备",
        after: "复核",
      },
    ]);
  });

  it("omits line / neighbours without a compile product or phase table, and falls back on the type", () => {
    const holes = projectRunHoles({
      events: [reached],
      openHoles: [{ siteId: VERDICT, ordinal: 1, name: "裁决", since: 1 }],
      holes: undefined,
      phaseNames: undefined,
    });
    expect(holes).toEqual([
      {
        siteId: VERDICT,
        ordinal: 1,
        name: "裁决",
        type: "unknown",
        state: "waiting",
        since: 1_000,
      },
    ]);
  });

  it("one row per reached ordinal (a hole under a loop), capped at 32", () => {
    const events = Array.from({ length: 40 }, (_, index) =>
      stored(index, {
        type: "hole-reached",
        instance: { siteId: VERDICT, ordinal: index + 1 },
        name: "裁决",
      }),
    );
    const openHoles = events.map((_, index) => ({
      siteId: VERDICT,
      ordinal: index + 1,
      name: "裁决",
      since: 0,
    }));
    const holes = projectRunHoles({ events, openHoles, holes: HOLES, phaseNames: undefined });
    expect(holes).toHaveLength(32);
    expect(holes.map((hole) => hole.ordinal)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  });
});

describe("mapFillDiagnostics", () => {
  const table = collectSites(createWorkflowProgram(HOLE_SCRIPT));
  const body = ['const x: number = "no";', 'return "v";'].join("\n");
  const spliced = spliceHoleBody(HOLE_SCRIPT, table, VERDICT, body)!;

  it("a diagnostic inside the spliced body is reported in the body's own lines and columns", () => {
    // 拼接后函数体第 1 行在脚本第 4 行，前面垫了 2 格缩进（调用在第 0 列）。
    const [mapped] = mapFillDiagnostics({
      diagnostics: [{ line: 4, column: 21, message: "not a number", code: 2322 }],
      effectiveText: spliced.text,
      body,
      insertedAtLine: spliced.insertedAtLine,
      insertedLines: spliced.insertedLines,
    });
    expect(mapped).toEqual({
      inFill: true,
      line: 1,
      column: 19,
      message: "not a number",
      code: 2322,
    });
  });

  it("a diagnostic after the splice is shifted back onto the draft's lines", () => {
    // 有效脚本里 `phase("收尾")` 在第 7 行（3 行函数体 + 右花括号）；草稿里它仍在第 4 行。
    const [mapped] = mapFillDiagnostics({
      diagnostics: [{ line: 7, column: 1, message: "elsewhere", code: 9005 }],
      effectiveText: spliced.text,
      body,
      insertedAtLine: spliced.insertedAtLine,
      insertedLines: spliced.insertedLines,
    });
    expect(mapped).toEqual({ inFill: false, line: 4, column: 1, message: "elsewhere", code: 9005 });
  });

  it("the closing brace line and lines before the splice map to the draft unchanged", () => {
    const mapped = mapFillDiagnostics({
      diagnostics: [
        { line: 6, column: 1, message: "brace", code: 1 },
        { line: 2, column: 5, message: "before", code: 2 },
      ],
      effectiveText: spliced.text,
      body,
      insertedAtLine: spliced.insertedAtLine,
      insertedLines: spliced.insertedLines,
    });
    expect(mapped).toEqual([
      { inFill: false, line: 3, column: 1, message: "brace", code: 1 },
      { inFill: false, line: 2, column: 5, message: "before", code: 2 },
    ]);
  });
});
