import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CreateWorkflowCausalityGraph,
  CreateWorkflowEdge,
  CreateWorkflowOutput,
} from "@zcode/contracts";
import type { ControlFlowGraph, HandoffGraph } from "@zcode/dynamic-workflow";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import { boundCausalityGraph } from "../src/tool/handlers/create-workflow-graph-bounds.js";
import {
  normalizeWorkflowMaxConcurrency,
  resolveCreateWorkflowInput,
} from "../src/tool/handlers/create-workflow-source.js";
import { saveSavedWorkflow } from "../src/tool/handlers/saved-workflows/index.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { analyzeScript } from "../src/tool/handlers/workflow-script-analysis.js";
import type { ModelCatalogEntry, ModelCatalogPort } from "@zcode/contracts";
import type { ToolExecutionContext, ToolHandlerFailure } from "../src/tool/types.js";
import { createToolRegistry } from "../src/tool/registry.js";

// Handler ignores context (pure typecheck, no I/O), so a bare stub is enough.
const stubContext = {} as ToolExecutionContext;

async function run(input: unknown): Promise<CreateWorkflowOutput> {
  return (await createWorkflowToolEntry.handler(input, stubContext)) as CreateWorkflowOutput;
}

/**
 * 分析器语料里的一个脚本（docs/dynamic-workflow/presentation.md 与
 * docs/dynamic-workflow/presentation.md 的验收样本）。
 */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../dynamic-workflow/tests/graphs/${name}`, import.meta.url),
    "utf8",
  );
}

/** 分析器全图 → 裁剪层，与 handler 的两个调用点同一签名。 */
function bound(script: string): CreateWorkflowCausalityGraph {
  const { causality, flow, handoff } = analyzeScript(script);
  expect(causality).toBeDefined();
  return boundCausalityGraph(causality!, flow, handoff);
}

type Edge = CreateWorkflowEdge;

/** 前向（非 back）边的传递闭包，`from -> Set<to>`。 */
function closure(edges: readonly Edge[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const next = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    if (edge.back === true) continue;
    nodes.add(edge.from);
    nodes.add(edge.to);
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  }
  for (const start of nodes) {
    const reached = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (reached.has(node)) continue;
      reached.add(node);
      stack.push(...(next.get(node) ?? []));
    }
    out.set(start, reached);
  }
  return out;
}

function closureEquals(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of keys) {
    const x = a.get(key) ?? new Set();
    const y = b.get(key) ?? new Set();
    if (x.size !== y.size || [...x].some((id) => !y.has(id))) return false;
  }
  return true;
}

/** 前向边集不可约：去掉任何一条都改变闭包。 */
function isIrredundant(edges: readonly Edge[]): boolean {
  const forward = edges.filter((edge) => edge.back !== true);
  const full = closure(forward);
  return forward.every(
    (edge) => !closureEquals(full, closure(forward.filter((other) => other !== edge))),
  );
}

/**
 * 载荷的引用完整性（spec「契约」）：三层之间的桥全部落在列出的集合里。
 * - step 的车道 ∈ lanes；step 的 phase ∈ phases（词汇表在场时每个 step 都带）。
 * - participant 的 phase ∈ phases，或词汇表缺席时全部为 `unphased`；lane ∈ lanes；
 *   steps ⊆ steps；每个 step 至多属于一张卡。
 * - handoff 两端 ∈ participants，无自环；phaseEdges 两端 ∈ phases；exits / sink 同理。
 * - phase 的 alongside ∈ phases，且不含自己（一个阶段不与自己并行）。
 * - phaseStreams 两端 ∈ phases、无自环、两端互为 alongside（docs/dynamic-workflow/presentation.md「Streams」）。
 */
function expectReferentialIntegrity(graph: CreateWorkflowCausalityGraph): void {
  const laneIds = new Set(graph.lanes.map((lane) => lane.id));
  const stepIds = new Set(graph.steps.map((step) => step.id));
  const phaseIds = new Set((graph.phases ?? []).map((phase) => phase.id));
  const participantIds = new Set(graph.participants.map((participant) => participant.id));
  expect(participantIds.size).toBe(graph.participants.length);
  for (const step of graph.steps) {
    expect(laneIds.has(step.lane)).toBe(true);
    for (const lane of step.lanes ?? []) expect(laneIds.has(lane)).toBe(true);
    if (graph.phases === undefined) expect(Object.hasOwn(step, "phase")).toBe(false);
    else expect(phaseIds.has(step.phase!)).toBe(true);
  }
  const owner = new Map<string, string>();
  for (const participant of graph.participants) {
    if (graph.phases === undefined) expect(participant.phase).toBe("unphased");
    else expect(phaseIds.has(participant.phase)).toBe(true);
    expect(laneIds.has(participant.lane)).toBe(true);
    expect(participant.steps.length).toBeGreaterThan(0);
    for (const id of participant.steps) {
      expect(stepIds.has(id)).toBe(true);
      // 家族成员卡共享同一站点 step：成员之间的共享是合法的，跨车道 / 跨阶段的不是。
      const seen = owner.get(id);
      if (seen !== undefined) {
        const other = graph.participants.find((candidate) => candidate.id === seen)!;
        expect([other.phase, other.lane]).toEqual([participant.phase, participant.lane]);
        expect(participant.member).toBeDefined();
      } else owner.set(id, participant.id);
    }
  }
  for (const edge of graph.handoffs) {
    expect(participantIds.has(edge.from)).toBe(true);
    expect(participantIds.has(edge.to)).toBe(true);
    expect(edge.from).not.toBe(edge.to);
  }
  for (const edge of graph.phaseEdges ?? []) {
    expect(phaseIds.has(edge.from)).toBe(true);
    expect(phaseIds.has(edge.to)).toBe(true);
    expect(edge.from).not.toBe(edge.to);
  }
  for (const phase of graph.phases ?? []) {
    for (const id of phase.alongside ?? []) {
      expect(phaseIds.has(id)).toBe(true);
      expect(id).not.toBe(phase.id);
    }
  }
  const alongsideOf = new Map(
    (graph.phases ?? []).map((phase) => [phase.id, phase.alongside ?? []]),
  );
  for (const stream of graph.phaseStreams ?? []) {
    expect(phaseIds.has(stream.from)).toBe(true);
    expect(phaseIds.has(stream.to)).toBe(true);
    expect(stream.from).not.toBe(stream.to);
    expect(
      alongsideOf.get(stream.from)!.includes(stream.to) ||
        alongsideOf.get(stream.to)!.includes(stream.from),
    ).toBe(true);
  }
  if (graph.phases === undefined) expect(Object.hasOwn(graph, "phaseStreams")).toBe(false);
  for (const id of graph.exits ?? []) expect(phaseIds.has(id)).toBe(true);
  for (const id of graph.sink ?? []) expect(stepIds.has(id)).toBe(true);
  // 四个阶段字段同进同退。
  expect(Object.hasOwn(graph, "phaseEdges")).toBe(Object.hasOwn(graph, "phases"));
  expect(Object.hasOwn(graph, "exits")).toBe(Object.hasOwn(graph, "phases"));
  // step 级边与车道多重性已从载荷退场（handoff-stack）。
  expect(Object.hasOwn(graph, "edges")).toBe(false);
  for (const lane of graph.lanes) expect(Object.hasOwn(lane, "nesting")).toBe(false);
}

describe("CreateWorkflow tool", () => {
  it("is registered by default via registerBuiltInTools", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);
    expect(registry.has("CreateWorkflow")).toBe(true);
  });

  it("typechecks a valid script cleanly", async () => {
    const output = await run({
      script:
        'interface R { done: boolean }\nconst r = await agent("a").ask<R>("do");\nreturn r.done;',
    });
    expect(output.ok).toBe(true);
    expect(output.diagnostics).toEqual([]);
    expect(output.response).toContain("NOT executed");
  });

  it("emits the bounded display graph for a clean script", async () => {
    const output = await run({
      script:
        'interface R { done: boolean }\nconst r = await agent("a").ask<R>("do");\nreturn r.done;',
    });
    expect(output.ok).toBe(true);
    expect(output.causalityGraph).toBeDefined();
    const graph = output.causalityGraph!;
    // One step, standing in the actor's lane, at its author-script (prelude-stripped,
    // 1-based) location; the returned artifact is fed by that step.
    expect(graph.steps).toHaveLength(1);
    expect(graph.steps[0]).toMatchObject({ kind: "ask", label: "a", lane: "actor#1", line: 2 });
    expect(graph.lanes.map((lane) => lane.id)).toEqual(["actor#1"]);
    expect(graph.lanes[0]?.name).toBe("a");
    expect(graph.sink).toEqual(["ask#1"]);
    expect(graph.truncated).toBeUndefined();
    // 第二层：一张子代理卡装着这一个 step，无交接。
    expect(graph.participants).toEqual([
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
    ]);
    expect(graph.handoffs).toEqual([]);
    // 分析器内部的词汇（region / certainty / 边种类）不进载荷（single-arrow-contract）；
    // step 级边与 `nesting` 不再转发（handoff-stack）。
    expect(Object.hasOwn(graph, "regions")).toBe(false);
    expect(Object.hasOwn(graph, "edges")).toBe(false);
    for (const step of graph.steps) {
      expect(Object.hasOwn(step, "region")).toBe(false);
      expect(Object.hasOwn(step, "certainty")).toBe(false);
    }
    expectReferentialIntegrity(graph);
  });

  it("keeps every reference resolvable inside the bounded payload", async () => {
    const output = await run({
      script: [
        'const a = await agent("a").ask<string>("x");',
        'phase("work");',
        "for (let i = 0; i < 2; i++) {",
        '  const b = await agent("b").ask<string>(`y ${a}`);',
        "  if (b.length > 0) {",
        '    phase("save");',
        '    await agent("c").ask<string>(`z ${b}`);',
        "  }",
        "}",
        "return a;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases).toHaveLength(3);
    expect(graph.participants.length).toBeGreaterThan(0);
    expectReferentialIntegrity(graph);
  });

  it("bounds the display graph at the output contract and flags truncation", async () => {
    // 70 asks exceed the 64-step bound; the head of the script survives, cards and
    // hand-offs pointing at dropped steps go with them, truncated is flagged.
    const asks = Array.from(
      { length: 70 },
      (_, index) => `const r${index} = await agent("a${index}").ask<string>("m");`,
    );
    const output = await run({
      script: [...asks, `return r0;`].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.truncated).toBe(true);
    expect(graph.steps.length).toBeLessThanOrEqual(64);
    expect(graph.lanes.length).toBeLessThanOrEqual(32);
    expect(graph.participants.length).toBeLessThanOrEqual(64);
    expect(graph.handoffs.length).toBeLessThanOrEqual(256);
    // Lanes cap at 32 while steps cap at 64, so steps whose lane was dropped must go
    // too — otherwise the renderer gets a card with no row to sit in. Each surviving
    // actor is one card in the single implicit phase.
    expect(graph.lanes).toHaveLength(32);
    expect(graph.steps).toHaveLength(32);
    expect(graph.participants).toHaveLength(32);
    expect(graph.handoffs).toHaveLength(31);
    expectReferentialIntegrity(graph);
  });

  it("carries one hand-off shape: from, to, a back bit for loop back-edges, and types for the inspector", async () => {
    // 类型标签、种类、确定性都不进展示通道：分析器仍算它们（文本图/mermaid/精炼 fork 用），
    // 边只表示 runs after；`back` 是唯一的边级标记，只标循环回边；`types` 是检视器素材，
    // 不上箭头。
    const output = await run({
      script: [
        'interface Flaky { findings: string[] }',
        'const f = await agent("a").ask<Flaky>("f");',
        "for (let i = 0; i < 2; i++) {",
        '  const u = await agent("b").ask<string>(`use ${f.findings[0]}`);',
        '  await agent("c").ask<string>(`check ${u}`);',
        "}",
        "return f;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.handoffs).toEqual([
      { from: "unphased:actor#1", to: "unphased:actor#2", types: ["Flaky"] },
      { from: "unphased:actor#2", to: "unphased:actor#3", types: ["string"] },
      { from: "unphased:actor#3", to: "unphased:actor#2", back: true },
    ]);
    for (const edge of graph.handoffs) {
      for (const key of Object.keys(edge)) expect(["back", "from", "to", "types"]).toContain(key);
      expect(Object.hasOwn(edge, "kind")).toBe(false);
      expect(Object.hasOwn(edge, "certainty")).toBe(false);
    }
    for (const edge of graph.phaseEdges ?? []) {
      expect(Object.keys(edge).sort()).toEqual(
        edge.back === true ? ["back", "from", "to"] : ["from", "to"],
      );
    }
  });

  it("carries an interpolated actor name's static shape through the bounded payload", async () => {
    // 契约边界是可选字段消失的地方：namePattern / labelPattern 漏掉限长映射不会被
    // strict schema 抓住，只会让车道头静静地退回「未命名智能体」。
    const output = await run({
      script: [
        "const topics = [1, 2, 3];",
        "const drafts = await Promise.all(",
        "  topics.map((i) => agent(`研究员${i}`).ask<string>(`draft ${i}`)),",
        ");",
        'const editor = agent("主编");',
        "const final = await editor.ask<string>(`merge ${drafts.join()}`);",
        "return final;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    const byId = new Map(graph.lanes.map((lane) => [lane.id, lane]));
    expect(byId.get("actor#1")?.namePattern).toEqual({ head: "研究员" });
    // 形状**不写进 name**：`name` 的契约是作者原样写下的那个词。
    expect(Object.hasOwn(byId.get("actor#1")!, "name")).toBe(false);
    // 字面量名的车道逐字节不变——字段缺席，不是 undefined 值。
    expect(byId.get("actor#2")?.name).toBe("主编");
    expect(Object.hasOwn(byId.get("actor#2")!, "namePattern")).toBe(false);
    // 多重性不再挂在车道上（曾是 families → nesting）：家族的成员数由参与者卡表达。
    expect(Object.hasOwn(byId.get("actor#1")!, "nesting")).toBe(false);
    expect(Object.hasOwn(byId.get("actor#1")!, "families")).toBe(false);
    expect(graph.participants.filter((p) => p.lane === "actor#1").map((p) => p.member)).toEqual([
      { index: 0, of: 3 },
      { index: 1, of: 3 },
      { index: 2, of: 3 },
    ]);
    // 内联 receiver 的卡片同样拿到形状；标识符 receiver 的卡片没有形状可言。
    const steps = new Map(graph.steps.map((step) => [step.id, step]));
    expect(steps.get("ask#1")).toMatchObject({ label: "ask", labelPattern: { head: "研究员" } });
    expect(Object.hasOwn(steps.get("ask#2")!, "labelPattern")).toBe(false);
  });

  it("carries the may-set copies' source through the bounded payload", async () => {
    // may-set 车道展开的拷贝要能一路活到工具输出：`source` 是可选字段，限长映射里漏掉它
    // 不会被 strict schema 抓住，只会让直播叠加静静地关联不上任何实例。
    const output = await run({
      script: [
        'const fast = agent("fast");',
        'const careful = agent("careful");',
        'const brief = await agent("triage").ask<string>("classify this request");',
        "const answer = await (brief.length > 8 ? careful : fast).ask<string>(`handle ${brief}`);",
        "return answer;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.steps.map((step) => [step.id, step.lane, step.source])).toEqual([
      ["ask#1", "actor#3", undefined],
      ["ask#2~actor#1", "actor#1", "ask#2"],
      ["ask#2~actor#2", "actor#2", "ask#2"],
    ]);
    // 未展开的 step 逐字节不变：字段缺席，不是 undefined 值。
    expect(Object.hasOwn(graph.steps[0]!, "source")).toBe(false);
    // 拷贝保留全部候选车道（悬停线索），id 在 64 字符上限内。
    expect(graph.steps[1]).toMatchObject({ lanes: ["actor#1", "actor#2"] });
    for (const step of graph.steps) expect(step.id.length).toBeLessThanOrEqual(64);
    // source 指向的是被拷贝替换掉的站点，图里没有这个节点——sink 与卡只引用拷贝。
    const stepIds = new Set(graph.steps.map((step) => step.id));
    expect(stepIds.has("ask#2")).toBe(false);
    expect(graph.sink).toEqual(["ask#2~actor#1", "ask#2~actor#2"]);
    // 两份拷贝分属两张卡（各在自己的车道上），开局者 triage 排第一。
    expect(graph.participants.map((p) => [p.id, p.steps])).toEqual([
      ["unphased:actor#3", ["ask#1"]],
      ["unphased:actor#1", ["ask#2~actor#1"]],
      ["unphased:actor#2", ["ask#2~actor#2"]],
    ]);
    expect(graph.handoffs).toEqual([
      { from: "unphased:actor#3", to: "unphased:actor#1", types: ["string"] },
      { from: "unphased:actor#3", to: "unphased:actor#2", types: ["string"] },
    ]);
  });

  // —— 第二层：参与者卡与交接（docs/dynamic-workflow/presentation.md「The display contract」）————

  it("expands a literal fan-out into one member card each, all handing to the reviewer", async () => {
    const output = await run({ script: fixture("handoff-literal-members.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.participants).toEqual([
      { id: "phase#1:actor#1[0]", phase: "phase#1", lane: "actor#1", steps: ["ask#1"], member: { index: 0, of: 3 } },
      { id: "phase#1:actor#1[1]", phase: "phase#1", lane: "actor#1", steps: ["ask#1"], member: { index: 1, of: 3 } },
      { id: "phase#1:actor#1[2]", phase: "phase#1", lane: "actor#1", steps: ["ask#1"], member: { index: 2, of: 3 } },
      { id: "phase#1:actor#2", phase: "phase#1", lane: "actor#2", steps: ["ask#2"] },
    ]);
    expect(graph.handoffs).toEqual([
      { from: "phase#1:actor#1[0]", to: "phase#1:actor#2", types: ["Draft"] },
      { from: "phase#1:actor#1[1]", to: "phase#1:actor#2", types: ["Draft"] },
      { from: "phase#1:actor#1[2]", to: "phase#1:actor#2", types: ["Draft"] },
    ]);
    // 单卡的 `member` / `many` 缺席，不是 undefined 值。
    expect(Object.hasOwn(graph.participants[3]!, "member")).toBe(false);
    expect(Object.hasOwn(graph.participants[3]!, "many")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("collapses a family of unknown cardinality into one `many` card", async () => {
    // 被 push 过的数组不是字面量长度；迭代 ask 结果同样不可知——都是一张 `many` 卡。
    const output = await run({ script: fixture("handoff-pushed-array-many.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.participants).toEqual([
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"], many: true },
      { id: "unphased:actor#2", phase: "unphased", lane: "actor#2", steps: ["ask#2"] },
      { id: "unphased:actor#3", phase: "unphased", lane: "actor#3", steps: ["ask#3"], many: true },
    ]);
    expect(graph.handoffs).toEqual([
      { from: "unphased:actor#1", to: "unphased:actor#2", types: ["Draft"] },
      { from: "unphased:actor#2", to: "unphased:actor#3", types: ["string[]"] },
    ]);
    for (const participant of graph.participants) expect(Object.hasOwn(participant, "member")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("puts every card in `unphased` when the script has no phase vocabulary", async () => {
    // 无阶段词汇：`phases` 缺席，卡的 phase 恒为 `unphased`（UI 合成一个同 id 的模块）。
    // 没有数据的接力（editor 的 ask 不提 draft）仍是交接；同车道自环消失。
    const output = await run({ script: fixture("handoff-unphased-baton.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(Object.hasOwn(graph, "phases")).toBe(false);
    expect(graph.participants).toEqual([
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1", "ask#2"] },
      { id: "unphased:actor#2", phase: "unphased", lane: "actor#2", steps: ["ask#3"] },
    ]);
    expect(graph.handoffs).toEqual([{ from: "unphased:actor#1", to: "unphased:actor#2" }]);
    expect(Object.hasOwn(graph.handoffs[0]!, "types")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("matches the earth-v5 hand-off acceptance sample after bounding", () => {
    // spec「测试与验收」的 earth-v5 验收：五个阶段的参与者与交接，逐字节；P2 零交接。
    const graph = bound(fixture("handoff-earth-v5.ts"));
    expect(graph.truncated).toBeUndefined();
    expect(graph.phases?.map((phase) => phase.id)).toEqual([
      "phase#1",
      "phase#2",
      "phase#3",
      "phase#4",
      "phase#5",
    ]);
    const byPhase = (phase: string): string[] =>
      graph.participants.filter((p) => p.phase === phase).map((p) => p.id);
    expect(byPhase("phase#1")).toEqual(["phase#1:actor#1"]);
    expect(byPhase("phase#2")).toEqual([
      "phase#2:actor#2",
      "phase#2:actor#3[0]",
      "phase#2:actor#3[1]",
      "phase#2:actor#3[2]",
      "phase#2:actor#3[3]",
      "phase#2:actor#3[4]",
    ]);
    expect(byPhase("phase#3")).toEqual(["phase#3:workspace", "phase#3:actor#4"]);
    expect(byPhase("phase#4")).toEqual([
      "phase#4:workspace",
      "phase#4:actor#4",
      "phase#4:actor#5",
      "phase#4:actor#6",
      "phase#4:actor#7",
      "phase#4:actor#8",
    ]);
    expect(byPhase("phase#5")).toEqual(["phase#5:workspace"]);
    // 参与者数组顺序 = 阶段序内的交接序（折叠面自上而下）。
    expect(graph.participants.map((p) => p.id)).toEqual([
      ...byPhase("phase#1"),
      ...byPhase("phase#2"),
      ...byPhase("phase#3"),
      ...byPhase("phase#4"),
      ...byPhase("phase#5"),
    ]);
    const lanes = new Map(graph.lanes.map((lane) => [lane.id, lane.name]));
    expect(["actor#1", "actor#2", "actor#4", "actor#5", "actor#6", "actor#7", "actor#8"].map((id) => lanes.get(id))).toEqual([
      "architect",
      "harness",
      "fixer",
      "jury-a",
      "jury-b",
      "jury-c",
      "polisher",
    ]);
    const members = graph.participants.filter((p) => p.lane === "actor#3");
    expect(members.map((p) => p.member)).toEqual(
      Array.from({ length: 5 }, (_, index) => ({ index, of: 5 })),
    );
    expect(graph.handoffs).toEqual([
      { from: "phase#3:workspace", to: "phase#3:actor#4", types: ["WorldRunResult"] },
      { from: "phase#3:actor#4", to: "phase#3:workspace", back: true },
      { from: "phase#4:workspace", to: "phase#4:actor#4", types: ["WorldRunResult"] },
      { from: "phase#4:workspace", to: "phase#4:actor#5" },
      { from: "phase#4:workspace", to: "phase#4:actor#6" },
      { from: "phase#4:workspace", to: "phase#4:actor#7" },
      { from: "phase#4:actor#4", to: "phase#4:workspace" },
      { from: "phase#4:actor#4", to: "phase#4:actor#7", back: true },
      { from: "phase#4:actor#5", to: "phase#4:actor#8", types: ["JuryVerdict"] },
      { from: "phase#4:actor#6", to: "phase#4:actor#8", types: ["JuryVerdict"] },
      { from: "phase#4:actor#7", to: "phase#4:actor#8", types: ["JuryVerdict"] },
      { from: "phase#4:actor#8", to: "phase#4:workspace" },
    ]);
    expect(graph.handoffs.filter((edge) => edge.from.startsWith("phase#2:"))).toEqual([]);
    expectReferentialIntegrity(graph);
  });

  // —— 阶段词汇表的裁剪（docs/dynamic-workflow/presentation.md「The display contract」）————
  // 阶段层来自控制流图的阶段商（阶段之间能去哪），step 层是站点表。

  it("carries the phase vocabulary through the bounded payload", async () => {
    const output = await run({
      script: [
        'phase("preflight");',
        'const found = await files.glob("*.ts");',
        'const plan = await agent("planner").ask<string>(`plan ${found.length}`);',
        'phase("work");',
        "for (let i = 0; i < 3; i++) {",
        '  const r = await agent("worker").ask<string>(`do ${plan}`);',
        "  if (r.length > 0) {",
        '    phase("checkpoint");',
        '    await agent("saver").ask<string>(`save ${r}`);',
        "  }",
        "}",
        "return plan;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.truncated).toBeUndefined();
    // 阶段按名字首次出现的标记顺序编号，带作者原词与该标记的位置。
    expect(graph.phases).toEqual([
      { id: "phase#1", name: "preflight", line: 1, column: 1 },
      { id: "phase#2", name: "work", line: 4, column: 1 },
      { id: "phase#3", name: "checkpoint", line: 8, column: 5 },
    ]);
    // 划分是全的：词汇表在场时每个 step 恰有一个阶段。
    expect(graph.steps.map((step) => step.phase)).toEqual([
      "phase#1",
      "phase#1",
      "phase#2",
      "phase#3",
    ]);
    // 阶段边是控制流图的阶段商，与交接边同一形状：循环回边带 `back`，其余什么都不带。
    // 同阶段自环（work 里的循环）不发。
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
      { from: "phase#3", to: "phase#2", back: true },
    ]);
    // 循环退出后脚本正常完成：两个可能是最后一轮的阶段都通向返回物。
    expect(graph.exits).toEqual(["phase#2", "phase#3"]);
    // 第二层按阶段分卡：跨阶段的因果边（plan → worker）不是交接，交接只在阶段内。
    expect(graph.participants.map((p) => p.id)).toEqual([
      "phase#1:workspace",
      "phase#1:actor#1",
      "phase#2:actor#2",
      "phase#3:actor#3",
    ]);
    expect(graph.handoffs).toEqual([
      { from: "phase#1:workspace", to: "phase#1:actor#1", types: ["string[]"] },
    ]);
    expectReferentialIntegrity(graph);
  });

  it("keeps a zero-marker graph free of every phase field", async () => {
    // UI 的视图切换条件就是「词汇表在场与否」，所以零标记脚本必须一个阶段字段都不带——
    // 缺席，不是 undefined 值，也不是空数组。
    const output = await run({
      script:
        'interface R { done: boolean }\nconst r = await agent("a").ask<R>("do");\nreturn r.done;',
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(Object.hasOwn(graph, "phases")).toBe(false);
    expect(Object.hasOwn(graph, "phaseEdges")).toBe(false);
    expect(Object.hasOwn(graph, "exits")).toBe(false);
    for (const step of graph.steps) expect(Object.hasOwn(step, "phase")).toBe(false);
    for (const participant of graph.participants) expect(participant.phase).toBe("unphased");
  });

  it("carries the unphased fallback for steps before the first marker", async () => {
    const output = await run({
      script: [
        'const a = await agent("x").ask<string>("q");',
        'phase("later");',
        'const b = await agent("y").ask<string>(`use ${a}`);',
        "return b;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    // 兜底阶段排在最前（它装的是首个标记之前的 step）且**无 name**：显示名由 UI 本地化，
    // 与 workspace / unknown 车道同一模式。
    expect(graph.phases?.[0]).toEqual({ id: "unphased" });
    expect(Object.hasOwn(graph.phases![0]!, "name")).toBe(false);
    expect(graph.phases?.[1]).toMatchObject({ id: "phase#1", name: "later" });
    expect(graph.steps.map((step) => step.phase)).toEqual(["unphased", "phase#1"]);
    // 词汇表在场时兜底阶段是表里的一员，卡照常归入它。
    expect(graph.participants.map((p) => [p.id, p.phase])).toEqual([
      ["unphased:actor#1", "unphased"],
      ["phase#1:actor#2", "phase#1"],
    ]);
    expectReferentialIntegrity(graph);
  });

  it("lists a marker-only phase: control passes through it even with no step", async () => {
    // 因果商图只认成员，看不见 prepare；控制流商看得见——它是两个 step 之间的一个位置。
    // 第二层没有它的卡：卡是「阶段里有 step 的车道」。
    const output = await run({ script: fixture("phase-empty-phase.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["scan", "prepare", "act"]);
    expect(graph.steps.map((step) => step.phase)).toEqual(["phase#1", "phase#3"]);
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
    ]);
    expect(graph.exits).toEqual(["phase#3"]);
    expect(graph.participants.some((p) => p.phase === "phase#2")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("keeps a phase whose only member was truncated: it is still a control-flow position", async () => {
    // 71 asks 截到 64 → 后一个阶段的唯一成员被截走。阶段层不按成员收敛（阶段是控制流
    // 位置，不是成员的集合），所以它和通向它的边都留下；step 层照旧只剩 early 的成员，
    // late 的那张卡随它的 step 一起消失。
    const asks = Array.from(
      { length: 70 },
      (_, index) => `const r${index} = await a.ask<string>("m${index}");`,
    );
    const output = await run({
      script: [
        'const a = agent("a");',
        'phase("early");',
        ...asks,
        'phase("late");',
        'const last = await a.ask<string>("last");',
        "return last;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.truncated).toBe(true);
    expect(graph.steps).toHaveLength(64);
    expect(graph.phases).toEqual([
      { id: "phase#1", name: "early", line: 2, column: 1 },
      { id: "phase#2", name: "late", line: 73, column: 1 },
    ]);
    expect(graph.phaseEdges).toEqual([{ from: "phase#1", to: "phase#2" }]);
    expect(graph.exits).toEqual(["phase#2"]);
    for (const step of graph.steps) expect(step.phase).toBe("phase#1");
    expect(graph.participants.map((p) => [p.id, p.steps.length])).toEqual([["phase#1:actor#1", 64]]);
    expectReferentialIntegrity(graph);
  });

  it("degrades the whole vocabulary past 32 phases", async () => {
    // 超界整体降级：裁一半的阶段图会说谎（被裁阶段的成员没了家），宁可不说——四个字段
    // 全部缺席 + truncated，UI 自然退回无阶段画面。
    const marked = Array.from(
      { length: 33 },
      (_, index) => `phase("p${index}");\nconst r${index} = await a.ask<string>("m${index}");`,
    );
    const output = await run({
      script: ['const a = agent("a");', ...marked, "return r0;"].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.truncated).toBe(true);
    expect(Object.hasOwn(graph, "phases")).toBe(false);
    expect(Object.hasOwn(graph, "phaseEdges")).toBe(false);
    expect(Object.hasOwn(graph, "exits")).toBe(false);
    // step 的 `phase` 必须一起消失：带着一个不在 phases 里的阶段 id 的卡片是悬空引用。
    expect(graph.steps).toHaveLength(33);
    for (const step of graph.steps) expect(Object.hasOwn(step, "phase")).toBe(false);
  });

  it("keeps participants inside the vocabulary when the vocabulary degrades", async () => {
    // spec「契约」引用完整性：`participant.phase` ∈ `phases[].id`，或全部为 `unphased` 且
    // `phases` 缺席。词汇表整体降级后卡不能还认领 `phase#N`——UI 会去查一个不存在的阶段。
    const marked = Array.from(
      { length: 33 },
      (_, index) => `phase("p${index}");\nconst r${index} = await a.ask<string>("m${index}");`,
    );
    const output = await run({
      script: ['const a = agent("a");', ...marked, "return r0;"].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(Object.hasOwn(graph, "phases")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("never lets a step, a card, an edge or an exit name a phase the payload does not list", async () => {
    // 引用完整性优先于保留数量，和车道/边同一条规则——对每一种阶段结局都成立。
    const scripts = [
      // 词汇表在场，含兜底阶段与跨阶段回边。
      [
        'const seed = await agent("seed").ask<string>("go");',
        'phase("loop");',
        "for (let i = 0; i < 2; i++) {",
        '  const r = await agent("worker").ask<string>(`step ${seed}`);',
        "  if (r.length > 0) {",
        '    phase("accept");',
        '    await agent("saver").ask<string>(`save ${r}`);',
        "  }",
        "}",
        "return seed;",
      ].join("\n"),
      // 零标记：四个字段全缺席。
      'const a = await agent("a").ask<string>("q");\nreturn a;',
      // 阶段内循环 + fan-out 家族 + 工作区卡。
      fixture("handoff-earth-v5.ts"),
    ];
    for (const script of scripts) {
      const output = await run({ script });
      expect(output.ok).toBe(true);
      expectReferentialIntegrity(output.causalityGraph!);
    }
  });

  it("emits an empty exits list when the script has no normal completion", async () => {
    // 组内可为空：无条件 throw 的脚本没有通向返回物的阶段，`exits` 在场但空，`abort` 终端
    // 没有节点所以那条边不出现，`truncated` 不能因此撒谎。
    const output = await run({
      script: 'phase("a");\nconst x = await agent("a").ask<string>("q");\nthrow new Error(x);',
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases).toHaveLength(1);
    expect(graph.phaseEdges).toEqual([]);
    expect(graph.exits).toEqual([]);
    expect(Object.hasOwn(graph, "truncated")).toBe(false);
  });

  it("ships an exception edge as an ordinary arrow and drops the abort terminal", async () => {
    // try 体里的 step may-throw 进 catch 阶段：那是真实的「可能接着跑」后继，不发则只靠异常
    // 进入的恢复阶段会悬空。catch 里的 throw 指向 abort，无节点可落，丢弃。
    const output = await run({
      script: [
        'phase("attempt");',
        'const plan = await agent("planner").ask<string>("plan");',
        'let result = "";',
        "try {",
        '  result = await agent("worker").ask<string>(`do: ${plan}`);',
        "} catch {",
        '  phase("recover");',
        '  const salvage = await agent("salvage").ask<string>(`salvage: ${plan}`);',
        '  if (salvage === "") throw new Error("unrecoverable");',
        "  result = salvage;",
        "}",
        "return result;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([{ from: "phase#1", to: "phase#2" }]);
    expect(graph.exits).toEqual(["phase#1", "phase#2"]);
    for (const edge of graph.phaseEdges ?? []) {
      for (const id of [edge.from, edge.to]) expect(["entry", "sink", "abort"]).not.toContain(id);
    }
  });

  // —— 阶段边的传递归约（spec Round 2：一种箭头只承诺 runs-after 的可达关系）————

  it("drops a phase skip edge the arm path already implies", async () => {
    // `if` 无 else：head → 后继的跳过边被 head → arm → 后继蕴含而消失。
    const output = await run({
      script: [
        'phase("a");',
        'const s1 = await agent("a").ask<string>("1");',
        "if (s1.length > 0) {",
        '  phase("b");',
        '  await agent("b").ask<string>(`2 ${s1}`);',
        "}",
        'phase("c");',
        'return agent("c").ask<string>(`3 ${s1}`);',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
    ]);
  });

  it("keeps both directions of interleaved phases (a; b; a): neither is a loop", async () => {
    const output = await run({
      script: [
        'phase("a");',
        'const s1 = await agent("a").ask<string>("1");',
        'phase("b");',
        'const s2 = await agent("b").ask<string>(`2 ${s1}`);',
        'phase("a");',
        'return agent("a2").ask<string>(`3 ${s2}`);',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#1" },
    ]);
    expect(graph.exits).toEqual(["phase#1"]);
  });

  it("keeps one back edge for a loop body spanning three phases with a continue", async () => {
    // B 里的 `continue` 回 A 被「B → C（前向）→ A（一跳回边）」见证而消失；两条互相见证的
    // 回边不会一起消失，所以 C → A 留下，环仍然闭合。
    const output = await run({
      script: [
        "for (let i = 0; i < 3; i++) {",
        '  phase("A");',
        '  const a = await agent("a").ask<string>("a");',
        '  phase("B");',
        '  const b = await agent("b").ask<string>(`b ${a}`);',
        "  if (b.length > 0) continue;",
        '  phase("C");',
        '  await agent("c").ask<string>(`c ${b}`);',
        "}",
        "return 1;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
      { from: "phase#3", to: "phase#1", back: true },
    ]);
    expect(graph.exits).toEqual(["phase#3"]);
  });

  it("keeps every edge of two independent choices that reuse the same two phase names", async () => {
    // Bug（spec「Untyped reduction」同一段）：两组互不相干的 if/else 复用同一对阶段名，商图
    // 里 left ↔ right 就成了一对普通分支边。旧实现在**原图**上找见证，于是 `choose → left`
    // 被 `choose → right → left` 判成冗余而删掉，`left → next` 被 `left → right → next` 删
    // 掉——画面变成「条件分支总是走 right，left 是 right 的岔路」，一句假话。绕环走回来的路径
    // 对「控制能不能到那儿」不作断言，所以归约跑在缩点上，同一分量里的边一条都不能少。
    const output = await run({
      script: [
        'phase("choose");',
        'const s = await agent("a").ask<string>("1");',
        "if (s.length > 0) {",
        '  phase("left");',
        '  await agent("l").ask<string>(`l ${s}`);',
        "} else {",
        '  phase("right");',
        '  await agent("r").ask<string>(`r ${s}`);',
        "}",
        "if (s.length > 1) {",
        '  phase("left");',
        '  await agent("l2").ask<string>(`l2 ${s}`);',
        "} else {",
        '  phase("right");',
        '  await agent("r2").ask<string>(`r2 ${s}`);',
        "}",
        'phase("next");',
        'return agent("n").ask<string>(`n ${s}`);',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["choose", "left", "right", "next"]);
    // left 与 right 互相可达，是一个分量：两条对穿边都在，且都**不是**回边（这不是循环，
    // 是两组选择各走各的边）。进出分量的四条边同样一条不少。
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#1", to: "phase#3" },
      { from: "phase#2", to: "phase#3" },
      { from: "phase#2", to: "phase#4" },
      { from: "phase#3", to: "phase#2" },
      { from: "phase#3", to: "phase#4" },
    ]);
    for (const edge of graph.phaseEdges ?? []) expect(Object.hasOwn(edge, "back")).toBe(false);
    expect(graph.exits).toEqual(["phase#4"]);
    expectReferentialIntegrity(graph);
  });

  it("still drops a spawner's pass-through edge over a fork/join: nothing there is on a cycle", async () => {
    // 缩点归约的另一半：无环处的删边一点不能放松。两个并发回调各开一个阶段，主线在 join
    // 之后进入收尾——`spawn → join` 被两条 strand 路径蕴含，照旧消失。三个阶段各自成分量，
    // 所以这里的见证仍然作数。
    const output = await run({
      script: [
        'phase("spawn");',
        'const seed = await agent("s").ask<string>("seed");',
        "const left = (async () => {",
        '  phase("left");',
        '  return agent("l").ask<string>(`l ${seed}`);',
        "})();",
        "const right = (async () => {",
        '  phase("right");',
        '  return agent("r").ask<string>(`r ${seed}`);',
        "})();",
        "const both = await Promise.all([left, right]);",
        'phase("join");',
        'return agent("j").ask<string>(`j ${both.join(",")}`);',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["spawn", "left", "right", "join"]);
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#1", to: "phase#3" },
      { from: "phase#2", to: "phase#4" },
      { from: "phase#3", to: "phase#4" },
    ]);
    expectReferentialIntegrity(graph);
  });

  it("leaves a loop's back edge out of the components: the skip edge it spans still drops", async () => {
    // 分量只看前向边。回边说的是「下一轮」，把它算进分量会让整个循环体缩成一个点，循环体
    // 内部真正冗余的边就再也删不掉——这里 `A → C` 会跟着 `B → C` 一起留下来。
    const output = await run({
      script: [
        "for (let i = 0; i < 3; i++) {",
        '  phase("A");',
        '  const a = await agent("a").ask<string>("a");',
        "  if (a.length > 0) {",
        '    phase("B");',
        '    await agent("b").ask<string>(`b ${a}`);',
        "  }",
        "}",
        'phase("C");',
        'return agent("c").ask<string>("c");',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#1", back: true },
      { from: "phase#2", to: "phase#3" },
    ]);
    expect(graph.exits).toEqual(["phase#3"]);
    expectReferentialIntegrity(graph);
  });

  it("carries `alongside` for a phase entered while another phase's strands still ran", async () => {
    // 语料 strand-fanout-two-phases-join.ts，golden `phase phase#2 "B" alongside=phase#1`：
    // A 的 fan-out 没有被 await，B 的标记因此在 A 的子代理还在跑的时候就到了。这是**节点事实**
    // ——只挂在 B 上，且不得在两者之间变出一条边（控制并没有从 A 转移到 B 之外的地方）。
    const output = await run({ script: fixture("strand-fanout-two-phases-join.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["A", "B", "C"]);
    expect(graph.phases?.[1]).toMatchObject({ id: "phase#2", name: "B", alongside: ["phase#1"] });
    expect(Object.hasOwn(graph.phases![0]!, "alongside")).toBe(false);
    expect(Object.hasOwn(graph.phases![2]!, "alongside")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("streams the channel between two stage futures, but not the writer after the join", async () => {
    // 语料 stream-pipeline.ts（docs/dynamic-workflow/presentation.md「Streams」）：因果图阶段商有
    // phase#1 →data→ phase#2（facts channel）、phase#1 →data→ phase#3、phase#2 →seq→ phase#3。
    // 只有第一条连着两个互为 alongside 的阶段——写作者在 join 之后，是控制箭头的事。
    const output = await run({ script: fixture("stream-pipeline.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseStreams).toEqual([{ from: "phase#1", to: "phase#2" }]);
    expectReferentialIntegrity(graph);
  });

  it("streams every hand-off of a five-stage pipeline, in order", () => {
    // 触发本设计的形状（testfield「2077 未来职业流水线」缩写）：五个 stage future 由四条 channel
    // 串起来，控制流视图里五个阶段两两 alongside、phaseEdges 为空——流是它们之间唯一的关系。
    const graph = bound(`
      const FIELDS = ["pets", "sleep", "food"];
      const s1 = channel<string>("s1");
      const s2 = channel<string>("s2");
      const s3 = channel<string>("s3");
      const s4 = channel<string>("s4");
      const a = future(async () => {
        phase("Invent");
        try {
          await Promise.all(FIELDS.map(async (field) => s1.send(await agent(\`inventor-\${field}\`).ask<string>(field))));
        } finally { s1.close(); }
      });
      const b = future(async () => {
        phase("Post");
        try { for await (const job of s1) s2.send(await agent(\`poster-\${job}\`).ask<string>(job)); }
        finally { s2.close(); }
      });
      const c = future(async () => {
        phase("Tell");
        try { for await (const job of s2) s3.send(await agent(\`teller-\${job}\`).ask<string>(job)); }
        finally { s3.close(); }
      });
      const d = future(async () => {
        phase("Roast");
        try { for await (const job of s3) s4.send(await agent(\`roaster-\${job}\`).ask<string>(job)); }
        finally { s4.close(); }
      });
      const done: string[] = [];
      const e = future(async () => {
        phase("Bind");
        for await (const job of s4) done.push(await agent(\`binder-\${job}\`).ask<string>(job));
      });
      await Promise.all([a, b, c, d, e]);
      return done;
    `);
    expect(graph.phases?.map((phase) => phase.name)).toEqual([
      "Invent",
      "Post",
      "Tell",
      "Roast",
      "Bind",
    ]);
    expect(graph.phaseStreams).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
      { from: "phase#3", to: "phase#4" },
      { from: "phase#4", to: "phase#5" },
    ]);
    expectReferentialIntegrity(graph);
  });

  it("leaves two futures with no channel between them without streams", () => {
    // 两个互不相干的 future 照样 alongside（一条带），但没有 data 边就没有流：字段整个缺席。
    const graph = bound(`
      const web = future(async () => {
        phase("Read the web");
        return agent("web-reader").ask<string>("web");
      });
      const papers = future(async () => {
        phase("Read the papers");
        return agent("paper-reader").ask<string>("papers");
      });
      const [w, p] = await Promise.all([web, papers]);
      phase("Write");
      return agent("writer").ask<string>(\`\${w} \${p}\`);
    `);
    expect(graph.phases?.[1]?.alongside).toEqual(["phase#1"]);
    expect(Object.hasOwn(graph, "phaseStreams")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("leaves the sequential control free of `alongside`", async () => {
    // 对照组 strand-fanout-awaited-per-phase.ts：同样三次 fan-out，但每个阶段都先 await 完
    // 自己的工作，没有东西跨过标记停着。缺席必须是**字段缺席**——UI 据缺席画一条直线。
    const output = await run({ script: fixture("strand-fanout-awaited-per-phase.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["A", "B", "C"]);
    for (const phase of graph.phases!) expect(Object.hasOwn(phase, "alongside")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("matches the control-flow phase quotient of phase-jsonl-db up to reduction", async () => {
    // 端到端验收（spec「测试与验收」）：载荷阶段边的前向闭包 = `.phase-flow.mmd` 去掉终端、
    // 自环与纯 loop 边后的闭包；载荷边集不可约；back 边是 mmd 里 loop 边的子集，且每条被
    // loop 边闭合的环仍被闭合（两端互相可达）。
    const output = await run({ script: fixture("phase-jsonl-db.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    const mmd = fixture("expected/phase-jsonl-db.phase-flow.mmd");
    const terminals = new Set(["entry", "sink", "abort"]);
    const forward: Edge[] = [];
    const loops: Edge[] = [];
    const exits = new Set<string>();
    for (const line of mmd.split("\n")) {
      const match = /^\s*(\S+) -->(?:\|"([^"]*)"\|)? (\S+)$/.exec(line);
      if (match === null) continue;
      const [, rawFrom, labels, rawTo] = match;
      const from = (rawFrom as string).replace("phase_", "phase#");
      const to = (rawTo as string).replace("phase_", "phase#");
      if (to === "sink") {
        exits.add(from);
        continue;
      }
      if (terminals.has(from) || terminals.has(to) || from === to) continue;
      const kinds = (labels ?? "next").split(", ").map((label) => label.replace(/ \(.*\)$/, ""));
      if (kinds.every((kind) => kind === "loop")) loops.push({ back: true, from, to });
      else forward.push({ from, to });
    }
    expect(closureEquals(closure(graph.phaseEdges ?? []), closure(forward))).toBe(true);
    expect(isIrredundant(graph.phaseEdges ?? [])).toBe(true);
    const backs = (graph.phaseEdges ?? []).filter((edge) => edge.back === true);
    expect(backs.length).toBeGreaterThan(0);
    for (const edge of backs) {
      expect(loops.some((loop) => loop.from === edge.from && loop.to === edge.to)).toBe(true);
    }
    // 每条 mmd 回边闭合的环在载荷（前向 ∪ back）里仍是环：两端互相可达。
    const all = (graph.phaseEdges ?? []).map((edge) => ({ from: edge.from, to: edge.to }));
    const reach = closure(all);
    for (const loop of loops) {
      expect(reach.get(loop.from)?.has(loop.to)).toBe(true);
      expect(reach.get(loop.to)?.has(loop.from)).toBe(true);
    }
    expect(graph.exits).toEqual([...exits]);
    // 六个阶段都在，成员划分是全的。
    expect(graph.phases?.map((phase) => phase.name)).toEqual([
      "preflight",
      "attempt",
      "gate",
      "checkpoint",
      "recover",
      "wrap-up",
    ]);
    expectReferentialIntegrity(graph);
  });

  it("withholds the display graph when the script has type errors", async () => {
    const output = await run({ script: 'const x: number = "s";' });
    expect(output.ok).toBe(false);
    expect(output.causalityGraph).toBeUndefined();
  });

  it("surfaces facade-misuse diagnostics with ok=false and no graph", async () => {
    const output = await run({ script: "const spawn = agent;\nreturn 1;" });
    expect(output.ok).toBe(false);
    expect(output.causalityGraph).toBeUndefined();
    expect(
      output.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("may only be called directly"),
      ),
    ).toBe(true);
    expect(output.response).toContain("NOT executed");
  });

  it("reports diagnostics for a type error with script-relative line", async () => {
    const output = await run({ script: 'const x: number = "s";' });
    expect(output.ok).toBe(false);
    expect(output.diagnostics.some((diagnostic) => diagnostic.line === 1)).toBe(true);
    expect(output.response).toContain("L1:");
    expect(output.response).toContain("NOT executed");
  });

  /**
   * 占位文案真化：诊断路径的 NOTE 曾自述「the execution model is still under development」与
   * 「only typechecks the script (placeholder for testing)」——引擎接线后两句都是谎言（干净脚本
   * 会真启动一个后台 run）。这条路径上唯一为真的是「没执行」+「改完重交」，模型据此走自己的
   * 改错重试回路，而不是以为整个工具还是个玩具。
   */
  it("诊断路径的 NOTE 只说没执行与改完重交，不再自述占位", async () => {
    const output = await run({ script: 'const x: number = "s";' });
    expect(output.ok).toBe(false);
    expect(output.response).toContain("NOT executed");
    expect(output.response).toContain("fix the errors above and resubmit");
    expect(output.response).not.toContain("under development");
    expect(output.response).not.toContain("placeholder");
    expect(output.response).not.toContain("only typechecks");
  });

  it("rejects Node globals to enforce script purity", async () => {
    const output = await run({ script: "process.exit(1);" });
    expect(output.ok).toBe(false);
    expect(output.diagnostics.some((diagnostic) => diagnostic.message.includes("Cannot find name"))).toBe(
      true,
    );
  });

  it("rejects input missing the script field", async () => {
    await expect(run({ name: "no-script" })).rejects.toThrow();
  });

  it("keeps the facade out of its description and points at the skill instead", () => {
    // 2026-09-21：facade 与写作规则搬进 dynamic-workflows 技能（docs/dynamic-workflow/authoring.md
    // 「The authoring surface」），描述只剩几百 token。这里钉住两件事：d.ts 不再随每次请求重发，
    // 描述点名了技能与 Skill 工具。路由信号仍在 workflow-routing-hints.test.ts。
    const description = createWorkflowToolEntry.metadata.description ?? "";
    expect(description).not.toContain("declare ");
    expect(description).not.toContain("ask<T");
    expect(description).toContain("`dynamic-workflows` skill");
    expect(description).toContain("Skill tool");
    // The description used to claim the tool "does NOT run anything" — stale since
    // the engine got wired, and it pushed the model to Agent for explicit workflow
    // requests.
    expect(description).not.toContain("does NOT run anything");
  });
});

// 并发上界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）的归一住在
// resolveInput 而不是 handler：确认窗必须显示将要生效的那个数，而窗在 handler 之前。
// 默认并发是起点不是上限，所以这里只向下取整到至少 1，高于默认的值原样放行。
describe("CreateWorkflow resolveInput — max_concurrency", () => {
  /** 内联路径一次盘都不碰，所以 cwd 是什么无所谓；saved 用例自己造真目录。 */
  const UNREAD_CWD = "/workspace/never-read";

  async function resolved(input: unknown, cwd = UNREAD_CWD): Promise<Record<string, unknown>> {
    const resolution = await resolveCreateWorkflowInput(input, cwd);
    expect(resolution).toMatchObject({ result: true });
    return (resolution as { input: unknown }).input as Record<string, unknown>;
  }

  it("leaves a request above the default byte-identical: there is no upper limit", async () => {
    const input = { script: "return 1;", max_concurrency: 200 };
    expect(await resolved(input)).toBe(input);
  });

  it("leaves a small request byte-identical: the inline path stays the identity", async () => {
    const input = { script: "return 1;", max_concurrency: 3 };
    expect(await resolved(input)).toBe(input);
  });

  it("never invents the key for a call that did not set one", async () => {
    expect(Object.hasOwn(await resolved({ script: "return 1;" }), "max_concurrency")).toBe(false);
  });

  it("carries the limit through the saved source, which rebuilds the input", async () => {
    // saved 分支是从零拼一份新入参的，所以「字段被悄悄丢掉」是这条路径独有的失效形态。
    const cwd = mkdtempSync(join(tmpdir(), "dwf-maxconc-"));
    try {
      saveSavedWorkflow({ cwd, name: "nightly", meta: { description: "d" }, script: "return 1;" });
      const input = await resolved({ saved: { name: "nightly" }, max_concurrency: 32 }, cwd);
      expect(input.max_concurrency).toBe(32);
      expect(input.script).toBe("return 1;");
      // 未设上界的 saved 调用同样不造空壳键。
      expect(
        Object.hasOwn(await resolved({ saved: { name: "nightly" } }, cwd), "max_concurrency"),
      ).toBe(false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("floors to a whole number of at least one, and nothing more", () => {
    // helper 是两个工具的共用入口：schema 之外的值（0、负数、小数）不该穿过去；大数原样过。
    expect(normalizeWorkflowMaxConcurrency(0)).toBe(1);
    expect(normalizeWorkflowMaxConcurrency(-3)).toBe(1);
    expect(normalizeWorkflowMaxConcurrency(3.7)).toBe(3);
    expect(normalizeWorkflowMaxConcurrency(500)).toBe(500);
  });
});

// 子代理模型（docs/dynamic-workflow/launch.md「From call to run」）与并发上界同住 resolveInput，
// 理由也同一条：确认窗必须显示将要生效的那个模型，而解不出来的调用根本不该开窗。
describe("CreateWorkflow resolveInput — subagent_model", () => {
  const UNREAD_CWD = "/workspace/never-read";

  function catalogOf(...entries: ModelCatalogEntry[]): ModelCatalogPort {
    return { listModels: () => entries };
  }

  function entry(
    providerId: string,
    modelId: string,
    extra: Partial<ModelCatalogEntry> = {},
  ): ModelCatalogEntry {
    return { providerId, modelId, reasoningLevels: [], current: false, ...extra };
  }

  const CATALOG = catalogOf(
    entry("bigmodel", "GLM-4.6", {
      reasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
      current: true,
    }),
    entry("openai", "gpt-5"),
  );

  async function resolved(
    input: unknown,
    catalog?: ModelCatalogPort,
    cwd = UNREAD_CWD,
  ): Promise<Record<string, unknown>> {
    const resolution = await resolveCreateWorkflowInput(input, cwd, catalog);
    expect(resolution).toMatchObject({ result: true });
    return (resolution as { input: unknown }).input as Record<string, unknown>;
  }

  async function failed(input: unknown, catalog?: ModelCatalogPort): Promise<ToolHandlerFailure> {
    const resolution = await resolveCreateWorkflowInput(input, UNREAD_CWD, catalog);
    expect(resolution.result).toBe(false);
    return resolution as ToolHandlerFailure;
  }

  it("rewrites the model the user named into the canonical picker form", async () => {
    // 用户说的是裸名、大小写也不同；窗上与 handler 看到的必须是注册表的那一个。
    expect(
      (await resolved({ script: "return 1;", subagent_model: "glm-4.6" }, CATALOG)).subagent_model,
    ).toBe("bigmodel/GLM-4.6$high");
  });

  it("leaves an already-canonical inline call byte-identical", async () => {
    const input = { script: "return 1;", subagent_model: "openai/gpt-5" };
    expect(await resolved(input, CATALOG)).toBe(input);
  });

  it("normalises a padded id rather than letting the window show the whitespace", async () => {
    // schema 带 `.trim()`，所以「解析后与规范形相等」并不意味着原始入参就是规范形。
    const input = { script: "return 1;", subagent_model: "  openai/gpt-5  " };
    const resolvedInput = await resolved(input, CATALOG);
    expect(resolvedInput).not.toBe(input);
    expect(resolvedInput.subagent_model).toBe("openai/gpt-5");
  });

  it("never invents the key for a call that did not choose a model", async () => {
    const input = { script: "return 1;" };
    expect(await resolved(input, CATALOG)).toBe(input);
    expect(Object.hasOwn(await resolved(input, CATALOG), "subagent_model")).toBe(false);
  });

  it("fails before the confirmation window and lists the ids the model could have used", async () => {
    const failure = await failed({ script: "return 1;", subagent_model: "gemini-3" }, CATALOG);
    expect(failure.message).toContain("No configured model matches `gemini-3`");
    expect(failure.message).toContain("bigmodel/GLM-4.6 [current]");
    expect(failure.message).toContain("openai/gpt-5");
    expect(failure.message).toContain("call ListModels");
  });

  it("refuses the field outright on a host with no model catalog", async () => {
    // 静默放行会让一个宿主解不了的字符串一路传到子代理第一次开口时才炸。
    const failure = await failed({ script: "return 1;", subagent_model: "gpt-5" }, undefined);
    expect(failure.message).toBe("This host cannot choose a subagent model; omit subagent_model.");
    // 没给字段的调用在同一台宿主上照常通过。
    expect(
      Object.hasOwn(await resolved({ script: "return 1;" }, undefined), "subagent_model"),
    ).toBe(false);
  });

  it("carries the canonical model through the saved source, which rebuilds the input", async () => {
    // saved 分支从零拼一份新入参，所以「字段被悄悄丢掉」是这条路径独有的失效形态。
    const cwd = mkdtempSync(join(tmpdir(), "dwf-subagent-model-"));
    try {
      saveSavedWorkflow({ cwd, name: "nightly", meta: { description: "d" }, script: "return 1;" });
      const input = await resolved(
        { saved: { name: "nightly" }, subagent_model: "GPT-5" },
        CATALOG,
        cwd,
      );
      expect(input.subagent_model).toBe("openai/gpt-5");
      expect(input.script).toBe("return 1;");
      expect(
        Object.hasOwn(
          await resolved({ saved: { name: "nightly" } }, CATALOG, cwd),
          "subagent_model",
        ),
      ).toBe(false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("fails a saved call without touching the disk: nothing runs and no window opens", async () => {
    // 解析排在读盘之前，所以一个连模型名都解不出来的调用不会先去扫一遍磁盘。
    const failure = await failed(
      { saved: { name: "nightly" }, subagent_model: "gemini-3" },
      CATALOG,
    );
    expect(failure.message).toContain("No configured model matches");
    expect(failure.message).not.toContain("saved workflow");
  });

  it("clamps the limit and canonicalises the model in the same rewrite", async () => {
    const input = await resolved(
      { script: "return 1;", max_concurrency: 3, subagent_model: "glm-4.6" },
      CATALOG,
    );
    expect(input.max_concurrency).toBe(3);
    expect(input.subagent_model).toBe("bigmodel/GLM-4.6$high");
  });
});

// 裁剪层是**自卫**的，不是信任生产者的：这些图直接喂给 boundCausalityGraph，因为分析器
// 按构造产不出它们。「认领的阶段都已声明」是上游的语料性质，不是本层的输入契约——阶段 id
// 是自由字符串，悬空引用 .strict() 抓不到，只能在这里挡住。
describe("boundCausalityGraph — 对损坏输入的引用完整性", () => {
  const step = (id: string, phase: string) => ({
    id,
    kind: "ask" as const,
    label: id,
    loc: { line: 1, column: 1 },
    lane: "actor#1",
    region: "seq#1",
    certainty: "always" as const,
    phase,
  });
  const base = {
    lanes: [{ id: "actor#1", name: "a" }],
    regions: [{ id: "seq#1", kind: "seq" as const }],
    edges: [],
  };
  const flowWith = (phaseEdges: ControlFlowGraph["phaseEdges"]): ControlFlowGraph => ({
    edges: [],
    nodes: [],
    phaseEdges,
    phases: [{ id: "phase#1", name: "declared" }],
  });

  it("strips a phase the vocabulary does not list, keeping the listed ones", () => {
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1"), step("ask#2", "phase#99")] },
      flowWith([]),
    );
    // 声明过的阶段照常列出并保留成员；声称未声明阶段的那个 step 只丢 `phase` 字段，
    // 卡片本身仍在图上（它的车道都还是好的）。
    expect(bounded.phases).toEqual([{ id: "phase#1", name: "declared" }]);
    expect(bounded.steps.map((s) => s.id)).toEqual(["ask#1", "ask#2"]);
    expect(bounded.steps[0]?.phase).toBe("phase#1");
    expect(Object.hasOwn(bounded.steps[1]!, "phase")).toBe(false);
  });

  it("keeps only listed ids in `alongside`, never itself and never twice", () => {
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1"), step("ask#2", "phase#2")] },
      {
        edges: [],
        nodes: [],
        phaseEdges: [],
        phases: [
          { id: "phase#1", name: "A" },
          { id: "phase#2", name: "B", alongside: ["phase#2", "phase#99", "phase#1", "phase#1"] },
        ],
      },
    );
    // 与边同一条引用完整性规则：自引用、未列出的阶段、重复项都丢掉，剩下空的就整个字段缺席。
    expect(bounded.phases).toEqual([
      { id: "phase#1", name: "A" },
      { id: "phase#2", name: "B", alongside: ["phase#1"] },
    ]);
    expect(Object.hasOwn(bounded.phases![0]!, "alongside")).toBe(false);
    // 而且它不是边：一条 phaseEdge 都不该因此长出来。
    expect(bounded.phaseEdges).toEqual([]);
  });

  it("streams only data edges between listed phases that run alongside each other", () => {
    const bounded = boundCausalityGraph(
      {
        ...base,
        steps: [step("ask#1", "phase#1"), step("ask#2", "phase#2"), step("ask#3", "phase#3")],
        phases: [
          { id: "phase#1", name: "A" },
          { id: "phase#2", name: "B" },
          { id: "phase#3", name: "C" },
        ],
        phaseEdges: [
          { certainty: "maybe", from: "phase#1", kind: "data", to: "phase#2" },
          // 重复、自环、非 data、未列出的阶段、不 alongside 的一对：全都不是流。
          { certainty: "always", from: "phase#1", kind: "data", to: "phase#2" },
          { certainty: "maybe", from: "phase#2", kind: "data", to: "phase#2" },
          { certainty: "maybe", from: "phase#1", kind: "seq", to: "phase#2" },
          { certainty: "maybe", from: "phase#2", kind: "data", to: "phase#99" },
          { certainty: "maybe", from: "phase#2", kind: "data", to: "phase#3" },
        ],
      },
      {
        edges: [],
        nodes: [],
        phaseEdges: [],
        phases: [
          { id: "phase#1", name: "A" },
          { id: "phase#2", name: "B", alongside: ["phase#1"] },
          { id: "phase#3", name: "C" },
        ],
      },
    );
    expect(bounded.phaseStreams).toEqual([{ from: "phase#1", to: "phase#2" }]);
    // 流不是边：phaseEdges 只来自控制流视图。
    expect(bounded.phaseEdges).toEqual([]);
  });

  it("drops the whole vocabulary when the streams exceed their bound", () => {
    const ids = Array.from({ length: 17 }, (_, i) => `phase#${i + 1}`);
    const bounded = boundCausalityGraph(
      {
        ...base,
        steps: [step("ask#1", "phase#1")],
        phases: ids.map((id) => ({ id, name: id })),
        // 17 × 16 = 272 条互为 alongside 的有序对，全是 data 边：超过 128。
        phaseEdges: ids.flatMap((from) =>
          ids
            .filter((to) => to !== from)
            .map((to) => ({ certainty: "maybe" as const, from, kind: "data" as const, to })),
        ),
      },
      {
        edges: [],
        nodes: [],
        phaseEdges: [],
        phases: ids.map((id) => ({ id, name: id, alongside: ids.filter((other) => other !== id) })),
      },
    );
    expect(Object.hasOwn(bounded, "phases")).toBe(false);
    expect(Object.hasOwn(bounded, "phaseStreams")).toBe(false);
    expect(bounded.truncated).toBe(true);
  });

  it("drops edges that touch an unlisted phase or a terminal, and folds sink edges into exits", () => {
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1")] },
      flowWith([
        { from: "entry", kind: "next", to: "phase#1" },
        { from: "phase#1", kind: "next", to: "phase#99" },
        { from: "phase#99", kind: "next", to: "phase#1" },
        { from: "phase#1", kind: "loop", to: "phase#1" },
        { from: "phase#1", kind: "throw", to: "abort" },
        { from: "phase#1", kind: "jump", to: "sink", via: "return" },
      ]),
    );
    // 端点过滤按**列出的**阶段；entry / abort 无节点；自环不发；sink 边变成 exits。
    expect(bounded.phaseEdges).toEqual([]);
    expect(bounded.exits).toEqual(["phase#1"]);
  });

  it("emits no vocabulary at all without a control-flow projection", () => {
    // 阶段层的唯一来源是控制流图；因果图自己带的 phases 不再进载荷。全有或全无。
    const bounded = boundCausalityGraph({
      ...base,
      steps: [step("ask#1", "phase#1")],
      phases: [{ id: "phase#1", name: "declared" }],
      phaseEdges: [],
    });
    expect(Object.hasOwn(bounded, "phases")).toBe(false);
    expect(Object.hasOwn(bounded, "phaseEdges")).toBe(false);
    expect(Object.hasOwn(bounded, "exits")).toBe(false);
    for (const s of bounded.steps) expect(Object.hasOwn(s, "phase")).toBe(false);
    expect(Object.hasOwn(bounded, "truncated")).toBe(false);
  });

  it("folds same-pair phase edges into one and marks back only when every fact was a back edge", () => {
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1"), step("ask#2", "phase#2")] },
      {
        edges: [],
        nodes: [],
        phases: [
          { id: "phase#1", name: "a" },
          { id: "phase#2", name: "b" },
        ],
        phaseEdges: [
          { from: "phase#1", kind: "loop", to: "phase#2" },
          { from: "phase#1", kind: "next", to: "phase#2" },
          { from: "phase#2", kind: "loop", to: "phase#1" },
        ],
      },
    );
    // phase#1 → phase#2 同时有前向事实与回边事实：按前向处理（排秩宁多一条约束）；
    // phase#2 → phase#1 只有回边事实：back。
    expect(bounded.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#1", back: true },
    ]);
  });

  it("emits no cards and no hand-offs without a hand-off projection", () => {
    // 第二层的唯一来源是分析器的交接图；缺席时两个必填数组为空，而不是 undefined。
    const bounded = boundCausalityGraph({ ...base, steps: [step("ask#1", "phase#1")] });
    expect(bounded.participants).toEqual([]);
    expect(bounded.handoffs).toEqual([]);
    expect(Object.hasOwn(bounded, "truncated")).toBe(false);
  });

  it("truncates participants in order to 64, dropping hand-offs that touch a cut card and types past 8", () => {
    // 70 张成员卡共享同一个站点 step（分析器的 FANOUT_EXPAND_CAP 产不出这么多，所以手造）。
    // 开局者活下来、尾巴被截；触及被截卡的交接随之消失；`types` 每边截到 8 个。
    const handoff: HandoffGraph = {
      participants: Array.from({ length: 70 }, (_, index) => ({
        id: `unphased:actor#1[${index}]`,
        phase: "unphased",
        lane: "actor#1",
        steps: ["ask#1"],
        member: { index, of: 70 },
      })),
      handoffs: [
        { from: "unphased:actor#1[0]", to: "unphased:actor#1[69]", types: ["Dropped"] },
        {
          from: "unphased:actor#1[0]",
          to: "unphased:actor#1[1]",
          types: Array.from({ length: 10 }, (_, index) => `T${index}`),
        },
        { from: "unphased:actor#1[65]", to: "unphased:actor#1[2]", back: true },
      ],
    };
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1")] },
      undefined,
      handoff,
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.participants).toHaveLength(64);
    expect(bounded.participants.map((p) => p.id)).toEqual(
      Array.from({ length: 64 }, (_, index) => `unphased:actor#1[${index}]`),
    );
    expect(bounded.participants[63]).toEqual({
      id: "unphased:actor#1[63]",
      phase: "unphased",
      lane: "actor#1",
      steps: ["ask#1"],
      member: { index: 63, of: 70 },
    });
    expect(bounded.handoffs).toEqual([
      {
        from: "unphased:actor#1[0]",
        to: "unphased:actor#1[1]",
        types: ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"],
      },
    ]);
  });

  it("drops a card whose lane or every step was cut, and its hand-offs with it", () => {
    // 卡的 step 收敛到存活的 step，一个都不剩的卡消失；车道不在场的卡消失；被截卡的 step
    // 仍留在 `steps`（运行状态照常关联）。任一丢弃置 truncated。
    const handoff: HandoffGraph = {
      participants: [
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1", "ask#ghost"] },
        { id: "unphased:actor#9", phase: "unphased", lane: "actor#9", steps: ["ask#1"] },
        { id: "unphased:workspace", phase: "unphased", lane: "workspace", steps: ["ask#ghost"] },
      ],
      handoffs: [
        { from: "unphased:actor#1", to: "unphased:actor#9" },
        { from: "unphased:workspace", to: "unphased:actor#1", types: ["X"] },
      ],
    };
    const bounded = boundCausalityGraph(
      { ...base, lanes: [...base.lanes, { id: "workspace" }], steps: [step("ask#1", "phase#1")] },
      undefined,
      handoff,
    );
    expect(bounded.participants).toEqual([
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
    ]);
    expect(bounded.handoffs).toEqual([]);
    expect(bounded.truncated).toBe(true);
  });
});
