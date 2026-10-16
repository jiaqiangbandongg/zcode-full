import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  decodeAnalysisCore,
  encodeAnalysisCore,
  serializeCore,
  type AnalysisCore,
  type AnalysisCoreJson,
} from "../src/index.js";

// `AnalysisCore` 的 JSON 往返（docs/chat/workflow-portfolio.md「样例包格式」）：作品集把 core
// 冻结成 core.json，站内投影全部在解码结果上算，所以解码结果必须与原 core 在规范文本上逐字节
// 相同，且 Map 的插入序（emission 的确定性求值序）不能被往返打乱。整个语料库都过一遍——
// 编解码器是按类型写的，任何一个 fixture 暴露出的形状（多端口 join、家族、detached 体、
// 阶段词汇）都应该同样过得去。
const graphsDir = join(dirname(fileURLToPath(import.meta.url)), "graphs");

/** 真正走一遍 JSON 文本，而不只是对象层面的 encode/decode。 */
function roundTrip(core: AnalysisCore): AnalysisCore {
  return decodeAnalysisCore(JSON.parse(JSON.stringify(encodeAnalysisCore(core))) as AnalysisCoreJson);
}

function mapKeys(core: AnalysisCore): string[][] {
  return [
    [...core.facts.askData.keys()],
    [...core.facts.askActor.keys()],
    [...core.facts.worldReadData.keys()],
    [...core.facts.joinIn.keys()],
    [...core.facts.fanoutIn.keys()],
    [...core.types.siteType.keys()],
    [...core.types.joinPortTypes.keys()],
  ];
}

describe("AnalysisCore JSON codec", () => {
  const fixtures = readdirSync(graphsDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();

  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  let withCore = 0;
  for (const fixture of fixtures) {
    it(`round-trips ${fixture}`, () => {
      const source = readFileSync(join(graphsDir, fixture), "utf8");
      const core = analyzeWorkflowScript(source).core;
      if (core === undefined) return;
      withCore += 1;
      const decoded = roundTrip(core);
      expect(serializeCore(decoded)).toBe(serializeCore(core));
      // 插入序：serializeCore 对 fact 分组按 sink id 排过序，单靠它看不出 Map 序被打乱。
      expect(mapKeys(decoded)).toEqual(mapKeys(core));
      // 编码是稳定的：再编码一次得到同一份 JSON 文本（导出器的 core.json 可 diff）。
      expect(JSON.stringify(encodeAnalysisCore(decoded))).toBe(JSON.stringify(encodeAnalysisCore(core)));
    });
  }

  it("covered at least one fixture with a core", () => {
    expect(withCore).toBeGreaterThan(0);
  });
});

/** 一份手工 core：语料里没有端口类型带洞的 join，这里直接构造一个。 */
function tinyCore(): AnalysisCore {
  return {
    facts: {
      askActor: new Map([["ask#2", [{ exact: true, site: "actor#1" }]]]),
      // 故意用非字典序插入，检验往返不排序。
      askData: new Map([
        ["ask#2", [{ exact: true, site: "ask#1" }]],
        ["ask#1", [{ exact: false, port: 1, site: "join#1" }]],
      ]),
      fanoutIn: new Map(),
      holeData: new Map(),
      joinIn: new Map([["join#1", [{ exact: true, port: 0, site: "ask#1" }]]]),
      returnData: [{ exact: true, site: "ask#2" }],
      worldReadData: new Map(),
    },
    sites: {
      actors: [{ id: "actor#1", loc: { column: 1, line: 1 }, name: "w", order: 0 }],
      asks: [
        { id: "ask#1", label: "a", loc: { column: 1, line: 2 }, order: 1 },
        { id: "ask#2", label: "b", loc: { column: 1, line: 3 }, order: 3 },
      ],
      fanouts: [],
      holes: [],
      joins: [{ id: "join#1", label: "join", loc: { column: 1, line: 4 }, order: 2 }],
      worldReads: [],
    },
    trace: {
      controls: [],
      events: [
        { at: "actor", actor: "actor#1", regions: [] },
        { at: "issue", phase: "unphased", regions: ["region#0", "call#1"], step: "ask#1" },
        { at: "settle", joins: ["call#1"], maybe: false, regions: ["region#0"], steps: ["ask#1"] },
        { at: "issue", phase: "unphased", regions: [], step: "ask#2" },
        // A join-only barrier: a second await of the same promise settles no step, but the
        // join is still where the strand's parked exits reconnect.
        { at: "settle", joins: ["call#2"], maybe: false, regions: ["region#0"], steps: [] },
        { at: "jump", kind: "return", phase: "unphased", regions: [], target: "region#0" },
      ],
      phases: [],
      regions: [
        { entered: true, id: "region#0", kind: "seq" },
        { entered: true, id: "call#1", kind: "call", label: "helper", parent: "region#0", strand: true },
        { entered: true, id: "call#2", kind: "call", parent: "region#0", strand: true },
      ],
      root: "region#0",
    },
    types: {
      joinPortTypes: new Map([["join#1", ["A", undefined, "B"]]]),
      siteType: new Map([
        ["ask#2", "B"],
        ["ask#1", "A"],
      ]),
    },
  };
}

describe("AnalysisCore JSON codec: edge cases", () => {
  it("encodes joinPortTypes holes as null and decodes them back to undefined", () => {
    const core = tinyCore();
    const encoded = encodeAnalysisCore(core);
    expect(encoded.types.joinPortTypes).toEqual([["join#1", ["A", null, "B"]]]);
    const text = JSON.stringify(encoded);
    expect(text).toContain('["A",null,"B"]');
    const decoded = decodeAnalysisCore(JSON.parse(text) as AnalysisCoreJson);
    const ports = decoded.types.joinPortTypes.get("join#1");
    expect(ports).toHaveLength(3);
    expect(ports?.[1]).toBeUndefined();
    expect(ports?.[1]).not.toBeNull();
    expect(serializeCore(decoded)).toBe(serializeCore(core));
    expect(serializeCore(decoded)).toContain('ports="A",-,"B"');
  });

  // 并发词汇（analyzer-strands-plan.md「Trace changes」）是**加法式**的两个可选字段，所以
  // core-json 仍停在 version 1：往返必须原样带回 `OrderRegion.strand` 与 `SettleEvent.joins`，
  // 不然冻结在作品集里的 core.json 会把并发折回成一条串行时间线。
  it("round-trips the strand flag and a settle's joins", () => {
    const core = tinyCore();
    const decoded = roundTrip(core);
    expect(decoded.trace.regions[1]?.strand).toBe(true);
    const settle = decoded.trace.events[2];
    expect(settle?.at === "settle" ? settle.joins : undefined).toEqual(["call#1"]);
    const text = serializeCore(decoded);
    expect(text).toContain('region call#1 call parent=region#0 entered label="helper" strand');
    expect(text).toContain("settle ask#1 in=region#0 joins=call#1");
    expect(text).toBe(serializeCore(core));
  });

  // 只 join 不结算的屏障：`steps` 为空数组，往返后仍必须是数组而不是缺席，否则冻结的
  // core.json 会让控制流投影把那条 strand 永远停在 park 状态。
  it("round-trips a join-only settle and prints it without a step token", () => {
    const core = tinyCore();
    const decoded = roundTrip(core);
    const joinOnly = decoded.trace.events[4];
    expect(joinOnly?.at === "settle" ? joinOnly.steps : undefined).toEqual([]);
    expect(joinOnly?.at === "settle" ? joinOnly.joins : undefined).toEqual(["call#2"]);
    const text = serializeCore(decoded);
    expect(text).toContain("settle in=region#0 joins=call#2");
    expect(text).not.toContain("settle  in=region#0");
    expect(text).toBe(serializeCore(core));
  });

  it("preserves non-sorted Map insertion order", () => {
    const decoded = roundTrip(tinyCore());
    expect([...decoded.facts.askData.keys()]).toEqual(["ask#2", "ask#1"]);
    expect([...decoded.types.siteType.keys()]).toEqual(["ask#2", "ask#1"]);
  });

  // 留白的两个键（`sites.holes` / `facts.holeData`）是 2026-09-28 后加的：早于它冻结的样例包
  // 没有这两个键，解码必须按「没有留白」补齐，而不是让投影在 undefined 上翻车。
  it("decodes a frozen core that predates holes (no holes / holeData keys)", () => {
    const encoded = encodeAnalysisCore(tinyCore());
    const { holeData: _holeData, ...facts } = encoded.facts;
    const { holes: _holes, ...sites } = encoded.sites;
    const legacy = { ...encoded, facts, sites } as unknown as AnalysisCoreJson;
    const decoded = decodeAnalysisCore(legacy);
    expect(decoded.sites.holes).toEqual([]);
    expect(decoded.facts.holeData).toEqual(new Map());
    expect(serializeCore(decoded)).toBe(serializeCore(tinyCore()));
  });

  it("stamps version 1 and rejects other versions", () => {
    const encoded = encodeAnalysisCore(tinyCore());
    expect(encoded.version).toBe(1);
    const foreign = { ...encoded, version: 2 } as unknown as AnalysisCoreJson;
    expect(() => decodeAnalysisCore(foreign)).toThrow(/version 2/);
  });
});
