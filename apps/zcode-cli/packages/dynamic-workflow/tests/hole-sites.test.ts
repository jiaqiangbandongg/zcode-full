import { describe, expect, it } from "vitest";
import { createWorkflowProgram } from "../src/compiler/compile.js";
import { collectSites } from "../src/analysis/sites.js";
import { collectHoleDiagnostics, HOLE_CODE } from "../src/analysis/hole-sites.js";
import { holePrefixOf, holeSiteId, isHoleSiteId } from "../src/analysis/hole-id.js";
import { FACADE_SITING_CODE } from "../src/analysis/facade-misuse.js";
import {
  analyzeWorkflowScript,
  checkSiteStability,
  collectPhaseNames,
  collectSitePhases,
  lowerWorkflow,
  lowerWorkflowScript,
  MAIN_LANE,
  spliceHoleBody,
} from "../src/index.js";

// 留白的编译面（docs/dynamic-workflow/authoring.md「Holes」，docs/analysis.md「Sites」）：站点收集
// （名字键 id、一层前缀计数器、tail、三个重载）、规则 9012、图投影（步 / 阶段 / fill / holes）、
// lowering（holeBodies 与站点处的求值器）、以及补全服务的两件纯文本工具。

// 留白 id 是名字键（hole-id.ts）：测试里按名字取，不写死哈希。
const GROUP = holeSiteId("决定分组");
const ORDER = holeSiteId("决定顺序");
const VERDICT = holeSiteId("评判");
const DECIDE = holeSiteId("决定");
const OUTER = holeSiteId("外");
const INNER = holeSiteId("内");

describe("hole ids (name key)", () => {
  it("is hole# plus eight hex digits of the trimmed name, the same at any depth", () => {
    expect(GROUP).toMatch(/^hole#[0-9a-f]{8}$/u);
    expect(holeSiteId(" 决定分组 ")).toBe(GROUP);
    expect(holeSiteId("决定分组 ")).toBe(GROUP);
    expect(ORDER).not.toBe(GROUP);
    expect(isHoleSiteId(GROUP)).toBe(true);
    expect(isHoleSiteId("hole#1")).toBe(false);
    expect(isHoleSiteId(`${GROUP}/ask#1`)).toBe(false);
    expect(holePrefixOf(`${GROUP}/ask#1`)).toBe(GROUP);
    expect(holePrefixOf(GROUP)).toBeUndefined();
    expect(holePrefixOf("ask#1")).toBeUndefined();
  });

  it("reports two different names that hash to one id as 9012 instead of guessing", () => {
    // 离线搜到的一对 FNV-1a 32 位撞车名（k32728 / k261234 → 0x92c402be）。
    expect(holeSiteId("k32728")).toBe(holeSiteId("k261234"));
    const { diagnostics } = sitesOf(
      `const a = await hole<string>("k32728");
const b = await hole<string>("k261234");
return a + b;`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(HOLE_CODE);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("same site id");
  });
});

const sitesOf = (scriptText: string) => {
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  return { diagnostics: collectHoleDiagnostics(workflow, table), table, workflow };
};

const OPEN = [
  `interface Plan { groups: string[][] }`,
  `const survey = await agent("勘察员").ask<string>("摸底");`,
  `const plan = await hole<Plan>("决定分组", \`最慢的是 \${survey}\`);`,
  `return agent("执行者").ask<string>(\`按 \${plan.groups.length} 组执行\`);`,
].join("\n");

const FILLED = [
  `interface Plan { groups: string[][] }`,
  `const survey = await agent("勘察员").ask<string>("摸底");`,
  `const plan = await hole<Plan>("决定分组", \`最慢的是 \${survey}\`, async () => {`,
  `  phase("分组");`,
  `  return await agent("分组员").ask<Plan>(\`分组 \${survey}\`);`,
  `});`,
  `return agent("执行者").ask<string>(\`按 \${plan.groups.length} 组执行\`);`,
].join("\n");

describe("hole site collection", () => {
  it("collects an open hole keyed by its name, consuming the global order", () => {
    const { diagnostics, table } = sitesOf(OPEN);
    expect(diagnostics).toEqual([]);
    expect(table.holes).toHaveLength(1);
    const [site] = table.holes;
    expect(site?.id).toBe(GROUP);
    expect(site?.fill).toBeUndefined();
    expect(site?.name).toBe("决定分组");
    expect(site?.typeText).toBe("Plan");
    expect(site?.prompt).toBeDefined();
    expect(site?.body).toBeUndefined();
    expect(site?.tail).toBe(false);
    expect(site?.order).toBe(2);
    // 留白之后的站点照常编号：留白不是另一套计数器的起点。
    expect(table.asks.map((s) => s.id)).toEqual(["ask#1", "ask#2"]);
    expect(table.actors.map((s) => s.id)).toEqual(["actor#1", "actor#2"]);
  });

  it("prefixes every id minted inside a body and leaves the outer ids untouched", () => {
    const outer = sitesOf(OPEN).table;
    const { diagnostics, table } = sitesOf(FILLED);
    expect(diagnostics).toEqual([]);
    expect(table.holes[0]?.body).toBeDefined();
    expect(table.asks.map((s) => s.id)).toEqual(["ask#1", `${GROUP}/ask#1`, "ask#2"]);
    expect(table.actors.map((s) => s.id)).toEqual(["actor#1", `${GROUP}/actor#1`, "actor#2"]);
    // 站点 id 稳定性规则延伸到「加函数体」：体外每个 id 逐字不变。
    const ids = (t: typeof table) =>
      [...t.asks, ...t.actors, ...t.holes].map((s) => s.id).filter((id) => !id.includes("/"));
    expect(ids(table)).toEqual(ids(outer));
    // 函数体里的 return 不是顶层 return。
    expect(table.topLevelReturns).toHaveLength(1);
    // 体内的标记照常收集（它没有 id）。
    expect(table.phases.map((m) => m.name)).toEqual(["分组"]);
  });

  it("nests: a hole inside a body keeps a flat name-key id, records its enclosing hole in fill, and its body opens a third counter set", () => {
    const { diagnostics, table } = sitesOf(
      [
        `const plan = await hole<string>("外", "p", async () => {`,
        `  const inner = await hole<string>("内", "q", async () => {`,
        `    return await agent("a").ask<string>("x");`,
        `  });`,
        `  return inner;`,
        `});`,
        `return plan;`,
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    expect(table.holes.map((s) => [s.id, s.fill])).toEqual([
      [OUTER, undefined],
      [INNER, OUTER],
    ]);
    // 前缀只有一层：内层留白体内的站点带内层的 id，不带外层的。
    expect(table.asks.map((s) => s.id)).toEqual([`${INNER}/ask#1`]);
  });

  it("marks the tail form and distinguishes the three overloads", () => {
    const tail = sitesOf(`return await hole<string>("评判", "p");`).table.holes[0];
    expect(tail?.tail).toBe(true);
    expect(tail?.prompt).toBeDefined();
    const bodyOnly = sitesOf(`return await hole<string>("评判", async () => "x");`).table.holes[0];
    expect(bodyOnly?.prompt).toBeUndefined();
    expect(bodyOnly?.body).toBeDefined();
    const inHelper = sitesOf(
      `async function f(): Promise<string> { return await hole<string>("评判"); }\nreturn await f();`,
    ).table.holes[0];
    expect(inHelper?.tail).toBe(false);
    expect(inHelper?.prompt).toBeUndefined();
  });

  it("ignores a script-local function named hole (identity by declaration)", () => {
    const { table } = sitesOf(
      `async function hole(n: string): Promise<string> { return n; }\nreturn await hole("x");`,
    );
    expect(table.holes).toEqual([]);
  });
});

describe("hole diagnostics (9012)", () => {
  const codes = (scriptText: string) => sitesOf(scriptText).diagnostics.map((d) => d.code);
  const messages = (scriptText: string) => sitesOf(scriptText).diagnostics.map((d) => d.message);

  it("requires an explicit type argument", () => {
    const { diagnostics } = sitesOf(`const x = await hole("决定", "p");\nreturn x;`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(HOLE_CODE);
    expect(diagnostics[0]?.message).toContain("explicit type argument");
    expect(diagnostics[0]?.line).toBe(1);
  });

  it("requires a non-empty literal name of at most 128 characters", () => {
    expect(messages(`const n = "x";\nconst v = await hole<string>(n);\nreturn v;`)[0]).toContain(
      "string literal",
    );
    expect(messages(`const v = await hole<string>("");\nreturn v;`)[0]).toContain("no name");
    expect(
      messages(`const v = await hole<string>("${"名".repeat(129)}");\nreturn v;`)[0],
    ).toContain("128");
    expect(codes(`const v = await hole<string>("${"名".repeat(128)}");\nreturn v;`)).toEqual([]);
  });

  it("rejects a name shared by two holes, and a name shared with a phase marker", () => {
    const twice = sitesOf(
      `const a = await hole<string>("决定");\nconst b = await hole<string>("决定");\nreturn a + b;`,
    ).diagnostics;
    expect(twice).toHaveLength(1);
    expect(twice[0]?.line).toBe(2); // 报在后一个上
    expect(twice[0]?.message).toContain("two holes are named");
    const marker = sitesOf(
      `phase("决定");\nconst a = await hole<string>("决定");\nreturn a;`,
    ).diagnostics;
    expect(marker).toHaveLength(1);
    expect(marker[0]?.line).toBe(2);
    expect(marker[0]?.message).toContain("phase(");
    // 嵌套补全里的名字也算：体内的标记与外面的留白撞名。
    const nested = sitesOf(
      `const a = await hole<string>("决定", async () => {\n  phase("决定");\n  return "x";\n});\nreturn a;`,
    ).diagnostics;
    expect(nested).toHaveLength(1);
  });

  it("requires the call to be awaited where it is called", () => {
    expect(messages(`const p = hole<string>("决定");\nreturn await p;`)[0]).toContain(
      "must be awaited",
    );
    expect(messages(`return hole<string>("决定");`)[0]).toContain("must be awaited");
    expect(codes(`return await hole<string>("决定");`)).toEqual([]);
  });

  it("rejects a hole inside an array-method callback, allows for...of and plain loops", () => {
    expect(
      messages(
        `const xs = [1, 2];\nconst ys = await Promise.all(xs.map(async (x) => await hole<string>(\`h\${x}\`)));\nreturn ys;`,
      ),
    ).toEqual([expect.stringContaining("string literal"), expect.stringContaining("fan-out")]);
    // 未提升的候选也算：forEach 的回调里没有别的站点，留白本身就是它到达的第一个站点。
    expect(
      messages(`[1, 2].forEach(async () => {\n  await hole<string>("决定");\n});\nreturn 1;`)[0],
    ).toContain("fan-out");
    // for...of 带 await 是顺序的：第一轮停在留白，补全后每轮跑函数体（authoring.md「Holes」）。
    expect(codes(`for (const x of [1, 2]) {\n  await hole<string>("决定");\n}\nreturn 1;`)).toEqual(
      [],
    );
    expect(
      codes(`for (let i = 0; i < 2; i += 1) {\n  await hole<string>("决定");\n}\nreturn 1;`),
    ).toEqual([]);
  });

  it("rejects a body that reads a binding declared after the hole, allows hoisted and body-local ones", () => {
    const late = sitesOf(
      [
        `const v = await hole<string>("决定", async () => {`,
        `  return later + fn();`,
        `});`,
        `const later = "x";`,
        `function fn(): string { return "y"; }`,
        `return v;`,
      ].join("\n"),
    ).diagnostics;
    expect(late).toHaveLength(1);
    expect(late[0]?.message).toContain('"later"');
    expect(late[0]?.line).toBe(2);
    expect(
      codes(
        [
          `const before = "b";`,
          `const v = await hole<string>("决定", async () => {`,
          `  const local = before;`,
          `  return local;`,
          `});`,
          `return v;`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("requires the body to be an inline function literal", () => {
    expect(
      messages(
        `const body = async () => "x";\nconst v = await hole<string>("决定", body);\nreturn v;`,
      )[0],
    ).toContain("inline");
    expect(
      messages(
        `const body = async () => "x";\nconst v = await hole<string>("决定", "p", body);\nreturn v;`,
      )[0],
    ).toContain("inline");
  });

  it("is wired into analyze and lower (ok: false, graphs withheld, nothing lowered)", () => {
    const script = `const v = await hole<string>("决定");\nconst w = await hole<string>("决定");\nreturn v + w;`;
    const analyzed = analyzeWorkflowScript(script);
    expect(analyzed.ok).toBe(false);
    expect(analyzed.diagnostics.map((d) => d.code)).toEqual([HOLE_CODE]);
    expect(analyzed.graph).toBeUndefined();
    const lowered = lowerWorkflowScript(script);
    expect(lowered.ok).toBe(false);
    expect(lowered.lowered).toBeUndefined();
  });

  it("leaves aliasing the facade function to facade-siting (9001)", () => {
    const analyzed = analyzeWorkflowScript(`const h = hole;\nreturn await h<string>("决定");`);
    expect(analyzed.diagnostics.map((d) => d.code)).toContain(FACADE_SITING_CODE);
  });
});

describe("holes in the graphs", () => {
  it("draws an open hole as a step in the main lane with its prompt as a sink and a memberless phase", () => {
    const analyzed = analyzeWorkflowScript(OPEN);
    expect(analyzed.ok).toBe(true);
    const node = analyzed.graph?.nodes.find((n) => n.id === GROUP);
    expect(node?.kind).toBe("hole");
    expect(node?.label).toBe("决定分组");
    expect(node?.artifactType).toBe("Plan");
    expect(analyzed.graph?.edges).toContainEqual({
      exact: true,
      from: "ask#1",
      kind: "data",
      to: GROUP,
      type: "string",
    });
    expect(analyzed.graph?.edges).toContainEqual({
      exact: true,
      from: GROUP,
      kind: "data",
      to: "ask#2",
      type: "Plan",
    });
    const step = analyzed.causality?.steps.find((s) => s.id === GROUP);
    expect(step?.kind).toBe("hole");
    expect(step?.lane).toBe(MAIN_LANE);
    expect(step?.fill).toBeUndefined();
    expect(analyzed.causality?.lanes[0]?.id).toBe(MAIN_LANE);
    // 留白是一个阶段：控制流投影的阶段表里有它、没有成员；因果图的阶段表（按成员）没有它。
    expect(analyzed.flow?.phases?.map((p) => p.id)).toEqual(["unphased", GROUP]);
    expect(analyzed.flow?.nodes.filter((n) => n.kind === "issue" && n.phase === GROUP)).toEqual([]);
    expect(analyzed.causality?.phases?.map((p) => p.id)).toEqual(["unphased"]);
    expect(analyzed.flow?.holes).toEqual([
      { name: "决定分组", phase: "unphased", siteId: GROUP, type: "Plan" },
    ]);
  });

  it("marks the tail form on the display's holes", () => {
    const analyzed = analyzeWorkflowScript(`return await hole<string>("评判");`);
    expect(analyzed.flow?.holes).toEqual([
      { name: "评判", phase: "unphased", siteId: VERDICT, tail: true, type: "string" },
    ]);
    expect(analyzed.causality?.sink?.fedBy).toEqual([VERDICT]);
  });

  it("gives a filled hole no step, a phase that claims the body up to its first marker, and fill on what the fill wrote", () => {
    const analyzed = analyzeWorkflowScript(FILLED);
    expect(analyzed.ok).toBe(true);
    expect(analyzed.graph?.nodes.some((n) => n.id === GROUP)).toBe(false);
    expect(analyzed.flow?.holes).toBeUndefined();
    // 函数体以标记开头：留白自己的阶段没有成员，但它有 mark 节点，所以仍在阶段表里（接龙的每一步
    // 名字因此留在侧栏）；顶层留白的阶段不带 fill，体内的阶段带 fill 指回它。
    expect(analyzed.flow?.phases).toEqual([
      { id: "unphased" },
      { id: GROUP, loc: { column: 20, line: 3 }, name: "决定分组" },
      { fill: GROUP, id: "phase#1", loc: { column: 3, line: 4 }, name: "分组" },
    ]);
    // 因果图的阶段表按成员：空的留白阶段不在里面。
    expect(analyzed.causality?.phases?.map((p) => p.id)).toEqual(["unphased", "phase#1"]);
    const bodyAsk = analyzed.causality?.steps.find((s) => s.id === `${GROUP}/ask#1`);
    expect(bodyAsk?.fill).toBe(GROUP);
    expect(bodyAsk?.phase).toBe("phase#1");
    expect(bodyAsk?.lane).toBe(`${GROUP}/actor#1`);
    expect(analyzed.causality?.steps.find((s) => s.id === "ask#2")?.fill).toBeUndefined();
    // 没有标记的函数体：留白自己的阶段认领体内的 ask，站在它的名字下。
    const noMarker = analyzeWorkflowScript(FILLED.replace(`  phase("分组");\n`, ""));
    expect(noMarker.flow?.phases).toEqual([
      { id: "unphased" },
      { id: GROUP, loc: { column: 20, line: 3 }, name: "决定分组" },
    ]);
    expect(noMarker.causality?.steps.find((s) => s.id === `${GROUP}/ask#1`)?.phase).toBe(GROUP);
  });

  it("stamps body sites with the hole's name in the site-phase table, and lists phases with the open-hole index", () => {
    const script = [
      `phase("摸底");`,
      `const survey = await agent("勘察员").ask<string>("摸底");`,
      `const plan = await hole<string>("决定分组", \`\${survey}\`, async () => {`,
      `  return await agent("分组员").ask<string>("分组");`,
      `});`,
      `const order = await hole<string>("决定顺序");`,
      `phase("执行");`,
      `return agent("执行者").ask<string>(\`\${plan}\${order}\`);`,
    ].join("\n");
    const analyzed = analyzeWorkflowScript(script);
    expect(analyzed.ok).toBe(true);
    const phases = collectSitePhases(analyzed.core!);
    expect(phases.get(`${GROUP}/ask#1`)).toBe("决定分组");
    expect(phases.get(ORDER)).toBe("摸底"); // 开放的留白站在「摸底」里
    expect(collectPhaseNames(analyzed.flow)).toEqual({
      holes: [2],
      phaseNames: ["摸底", "决定分组", "决定顺序", "执行"],
    });
    expect(collectPhaseNames(undefined)).toEqual({ holes: [], phaseNames: [] });
  });
});

describe("hole lowering", () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  it("emits the evaluator at the site and the body as text in holeBodies", () => {
    const result = lowerWorkflowScript(FILLED);
    expect(result.ok).toBe(true);
    const lowered = result.lowered!;
    expect(lowered.siteIds).toEqual([
      "ask#1",
      "actor#1",
      GROUP,
      `${GROUP}/ask#1`,
      `${GROUP}/actor#1`,
      "ask#2",
      "actor#2",
    ]);
    expect(lowered.code).toContain(
      `__host.hole("${GROUP}", "决定分组", \`最慢的是 \${survey}\`, __src => eval(__src), async () => {`,
    );
    const body = lowered.holeBodies[GROUP];
    expect(body?.startsWith("(async () => {\n")).toBe(true);
    expect(body?.endsWith("\n})")).toBe(true);
    expect(body).toContain(
      `__host.ask("${GROUP}/ask#1", __host.createActor("${GROUP}/actor#1", "分组员")`,
    );
    expect(body).not.toContain("<Plan>");
    // 开放的留白：提示缺席退回 void 0，没有函数体也没有 holeBodies 条目。
    const open = lowerWorkflowScript(`const v = await hole<string>("决定");\nreturn v;`).lowered!;
    expect(open.code).toContain(`__host.hole("${DECIDE}", "决定", void 0, __src => eval(__src))`);
    expect(open.holeBodies).toEqual({});
  });

  it("evaluates a fill's text at the site: the body closes over the bindings there", async () => {
    // 模拟 cell：__host.hole 在站点处拿到求值器，用 holeBodies 的文本求出函数并调用；函数体里
    // 引用的 `survey` 是留白之前的 const——只有站点处的直接 eval 能看见它。
    const lowered = lowerWorkflowScript(FILLED).lowered!;
    const calls: string[] = [];
    const host = {
      ask: async (id: string, actor: string, text: string) => {
        calls.push(`${id}:${actor}:${text}`);
        return id === "ask#1" ? "S" : { groups: [["a"]] };
      },
      createActor: (id: string) => id,
      enterPhase: () => undefined,
      hole: async (
        id: string,
        _n: string,
        _p: unknown,
        evaluate: (src: string) => () => Promise<unknown>,
      ) => {
        return evaluate(lowered.holeBodies[id] as string)();
      },
    };
    // 把已补全的调用改成开放形式（去掉第五实参），让文本路径真的跑起来。
    const unfilledCode = lowered.code.replace(/, async \(\) => \{[\s\S]*?\n\}\);/, ");");
    const result = await new AsyncFunction("__host", unfilledCode)(host);
    expect(result).toEqual({ groups: [["a"]] });
    expect(calls).toEqual([
      "ask#1:actor#1:摸底",
      `${GROUP}/ask#1:${GROUP}/actor#1:分组 S`,
      "ask#2:actor#2:按 1 组执行",
    ]);
  });
});

describe("spliceHoleBody / checkSiteStability", () => {
  const BODY = `phase("分组");\nreturn await agent("分组员").ask<Plan>(\`分组 \${survey}\`);`;

  it("splices the body after the last argument, indented under the call", () => {
    const { table } = sitesOf(OPEN);
    const spliced = spliceHoleBody(OPEN, table, GROUP, BODY);
    expect(spliced).toBeDefined();
    expect(spliced?.text).toBe(FILLED);
    expect(spliced?.insertedAtLine).toBe(4);
    expect(spliced?.insertedLines).toBe(3);
    // 拼出来的脚本编译干净，且函数体的站点带前缀。
    const after = sitesOf(spliced!.text);
    expect(after.diagnostics).toEqual([]);
    expect(after.table.asks.map((s) => s.id)).toEqual(["ask#1", `${GROUP}/ask#1`, "ask#2"]);
  });

  it("indents by the call's own indentation plus two", () => {
    const script = `if (true) {\n  const v = await hole<string>("决定");\n  log(v);\n}\nreturn 1;`;
    const { table } = sitesOf(script);
    const spliced = spliceHoleBody(script, table, DECIDE, `return "x";`);
    expect(spliced?.text).toBe(
      `if (true) {\n  const v = await hole<string>("决定", async () => {\n    return "x";\n  });\n  log(v);\n}\nreturn 1;`,
    );
    expect(spliced?.insertedAtLine).toBe(3);
    expect(spliced?.insertedLines).toBe(2);
  });

  it("keeps a trailing comma and a multi-line call intact (prettier-style call site)", () => {
    // 2026-09-28 首次实测：主代理写了带尾随逗号的多行调用，旧的「右括号前插入」得到 `, , async`。
    const script = [
      `const v = await hole<string>(`,
      `  "决定",`,
      `  \`提示\`,`,
      `);`,
      `log(v);`,
      `return 1;`,
    ].join("\n");
    const { table, diagnostics } = sitesOf(script);
    expect(diagnostics).toEqual([]);
    const spliced = spliceHoleBody(script, table, DECIDE, `return "x";`);
    expect(spliced?.text).toBe(
      [
        `const v = await hole<string>(`,
        `  "决定",`,
        `  \`提示\`, async () => {`,
        `  return "x";`,
        `},`,
        `);`,
        `log(v);`,
        `return 1;`,
      ].join("\n"),
    );
    expect(spliced?.insertedAtLine).toBe(4);
    expect(spliced?.insertedLines).toBe(2);
    const after = sitesOf(spliced!.text);
    expect(after.diagnostics).toEqual([]);
    expect(
      checkSiteStability(
        table,
        after.table,
        DECIDE,
        spliced!.insertedAtLine,
        spliced!.insertedLines,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses an unknown hole and an already filled one", () => {
    expect(spliceHoleBody(OPEN, sitesOf(OPEN).table, holeSiteId("nope"), BODY)).toBeUndefined();
    expect(spliceHoleBody(FILLED, sitesOf(FILLED).table, GROUP, BODY)).toBeUndefined();
  });

  it("accepts a fill that shifts every later site by the inserted lines and adds only prefixed ids", () => {
    const before = sitesOf(OPEN).table;
    const spliced = spliceHoleBody(OPEN, before, GROUP, BODY)!;
    const after = sitesOf(spliced.text).table;
    expect(
      checkSiteStability(before, after, GROUP, spliced.insertedAtLine, spliced.insertedLines),
    ).toEqual({ ok: true });
  });

  it("rejects a vanished id, a moved id and an unprefixed new id", () => {
    const before = sitesOf(OPEN).table;
    const vanished = sitesOf(
      OPEN.replace(
        `return agent("执行者").ask<string>(\`按 \${plan.groups.length} 组执行\`);`,
        `return 1;`,
      ),
    ).table;
    expect(checkSiteStability(before, vanished, GROUP, 4, 3)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("ask#2 vanished"),
    });
    const moved = sitesOf(`\n${OPEN}`).table;
    expect(checkSiteStability(before, moved, GROUP, 4, 3)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("ask#1 moved"),
    });
    const extra = sitesOf(`${OPEN}\nawait agent("x").ask<string>("y");`).table;
    expect(checkSiteStability(before, extra, GROUP, 99, 0)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("ask#3 appeared"),
    });
    // 体外新出现的留白也算「补全之外」：它的 fill 链通不到被补全的留白。
    const strayHole = sitesOf(`${OPEN}\nawait hole<string>("别处");`).table;
    expect(checkSiteStability(before, strayHole, GROUP, 99, 0)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("appeared outside"),
    });
  });

  it("lowers the spliced script with the fill's body text byte-identical to a direct compile", () => {
    const spliced = spliceHoleBody(OPEN, sitesOf(OPEN).table, GROUP, BODY)!;
    const workflow = createWorkflowProgram(spliced.text);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.holeBodies).toEqual(lowerWorkflowScript(FILLED).lowered?.holeBodies);
  });
});

// 递归留白（docs/analysis.md「Sites」）：一个补全体里再留一个留白，补全它就是对**有效脚本**再拼接
// 一次。内层留白的 id 仍是它自己的名字键（不带外层前缀，深度不长 id），归属记在 fill 上。五件事
// 逐一证明：站点表、拼接、稳定性、lowering 的两层 holeBodies、阶段表里的位置。
describe("recursive holes", () => {
  const OUTER_OPEN = [
    `interface Plan { groups: string[][] }`,
    `interface Order { first: string }`,
    `const survey = await agent("勘察员").ask<string>("摸底");`,
    `const plan = await hole<Plan>("决定分组", \`\${survey}\`);`,
    `return agent("执行者").ask<string>(\`\${plan.groups.length}\`);`,
  ].join("\n");
  const OUTER_BODY = [
    `const draft = await agent("分组员").ask<Plan>(\`分组 \${survey}\`);`,
    `const order = await hole<Order>("决定顺序", \`\${draft.groups.length} 组\`);`,
    `return { groups: [[order.first], ...draft.groups] };`,
  ].join("\n");
  const INNER_BODY = `return await agent("排序员").ask<Order>(\`排 \${draft.groups.length} 组\`);`;

  const outerFilled = () => {
    const spliced = spliceHoleBody(OUTER_OPEN, sitesOf(OUTER_OPEN).table, GROUP, OUTER_BODY)!;
    return { ...spliced, table: sitesOf(spliced.text).table };
  };
  const bothFilled = () => {
    const first = outerFilled();
    const spliced = spliceHoleBody(first.text, first.table, ORDER, INNER_BODY)!;
    return { ...spliced, before: first.table, table: sitesOf(spliced.text).table };
  };

  it("(1) lists the inner hole with its own flat id and its enclosing hole, open, and splices into the inner call", () => {
    const first = outerFilled();
    expect(sitesOf(first.text).diagnostics).toEqual([]);
    expect(first.table.holes.map((h) => [h.id, h.fill, h.body === undefined])).toEqual([
      [GROUP, undefined, false],
      [ORDER, GROUP, true],
    ]);
    const second = bothFilled();
    expect(sitesOf(second.text).diagnostics).toEqual([]);
    // 拼进了内层调用：内层调用现在带函数体，且体内的站点带内层留白自己的一层前缀。
    expect(second.text).toContain(
      `const order = await hole<Order>("决定顺序", \`\${draft.groups.length} 组\`, async () => {`,
    );
    expect(second.text).toContain(`\n    return await agent("排序员")`);
    expect(second.table.holes.map((h) => [h.id, h.fill, h.body === undefined])).toEqual([
      [GROUP, undefined, false],
      [ORDER, GROUP, false],
    ]);
    expect(second.table.asks.map((s) => s.id)).toEqual([
      "ask#1",
      `${GROUP}/ask#1`,
      `${ORDER}/ask#1`,
      "ask#2",
    ]);
    expect(second.table.actors.map((s) => s.id)).toEqual([
      "actor#1",
      `${GROUP}/actor#1`,
      `${ORDER}/actor#1`,
      "actor#2",
    ]);
    // 内层调用的缩进（外层体 2 格）+ 2：内层函数体 4 格，右括号回到 2 格。
    expect(second.text).toContain(`\n  });\n  return { groups`);
  });

  it("(2) checkSiteStability accepts the inner fill and rejects a renumbering", () => {
    const second = bothFilled();
    expect(
      checkSiteStability(
        second.before,
        second.table,
        ORDER,
        second.insertedAtLine,
        second.insertedLines,
      ),
    ).toEqual({ ok: true });
    // 重新编号：在有效脚本前面多插一个 ask，外层与外层体的 id 全部错位。
    const renumbered = sitesOf(`await agent("x").ask<string>("y");\n${second.text}`).table;
    const verdict = checkSiteStability(
      second.before,
      renumbered,
      ORDER,
      second.insertedAtLine,
      second.insertedLines,
    );
    expect(verdict.ok).toBe(false);
    // 外层体的 id（`<GROUP>/…`）必须原样存在：把它们改掉也被拒。
    const dropped = sitesOf(
      second.text.replace(
        `const draft = await agent("分组员").ask<Plan>(\`分组 \${survey}\`);`,
        `const draft = { groups: [["a"]] } as Plan;`,
      ),
    ).table;
    expect(
      checkSiteStability(
        second.before,
        dropped,
        ORDER,
        second.insertedAtLine,
        second.insertedLines,
      ),
    ).toMatchObject({
      detail: expect.stringContaining(`${GROUP}/ask#1 vanished`),
      ok: false,
    });
  });

  it("(3) lowers the inner open hole inside the outer body's text, then both bodies once both are filled", () => {
    const first = lowerWorkflowScript(outerFilled().text).lowered!;
    expect(Object.keys(first.holeBodies)).toEqual([GROUP]);
    expect(first.holeBodies[GROUP]).toContain(
      `__host.hole("${ORDER}", "决定顺序", \`\${draft.groups.length} 组\`, __src => eval(__src))`,
    );
    expect(first.siteIds).toEqual([
      "ask#1",
      "actor#1",
      GROUP,
      `${GROUP}/ask#1`,
      `${GROUP}/actor#1`,
      ORDER,
      "ask#2",
      "actor#2",
    ]);
    const second = lowerWorkflowScript(bothFilled().text).lowered!;
    expect(Object.keys(second.holeBodies).sort()).toEqual([GROUP, ORDER].sort());
    const inner = second.holeBodies[ORDER]!;
    expect(inner.startsWith("(async () => {\n")).toBe(true);
    expect(inner).toContain(
      `__host.ask("${ORDER}/ask#1", __host.createActor("${ORDER}/actor#1", "排序员")`,
    );
    // 外层文本现在把内层函数体内联为第五实参，且与单独打印的内层文本同一份改写。
    const outer = second.holeBodies[GROUP]!;
    expect(outer).toContain(
      `__host.hole("${ORDER}", "决定顺序", \`\${draft.groups.length} 组\`, __src => eval(__src), async () => {`,
    );
    expect(outer).toContain(
      `__host.ask("${ORDER}/ask#1", __host.createActor("${ORDER}/actor#1", "排序员")`,
    );
    expect(second.siteIds).toContain(`${ORDER}/ask#1`);
  });

  it("(4) projects the three states: outer open, inner open, both filled", () => {
    const open = analyzeWorkflowScript(OUTER_OPEN);
    expect(open.flow?.holes).toEqual([
      { name: "决定分组", phase: "unphased", siteId: GROUP, type: "Plan" },
    ]);
    const innerOpen = analyzeWorkflowScript(outerFilled().text);
    expect(innerOpen.ok).toBe(true);
    expect(innerOpen.flow?.holes).toEqual([
      { name: "决定顺序", phase: GROUP, siteId: ORDER, type: "Order" },
    ]);
    // 顶层留白自己的阶段不带 fill；体内的留白阶段带外层的 id——嵌套关系只在这里。
    expect(innerOpen.flow?.phases?.map((p) => [p.id, p.fill])).toEqual([
      ["unphased", undefined],
      [GROUP, undefined],
      [ORDER, GROUP],
    ]);
    expect(innerOpen.causality?.steps.find((s) => s.id === ORDER)).toMatchObject({
      fill: GROUP,
      kind: "hole",
      lane: MAIN_LANE,
      phase: GROUP,
    });
    const filled = analyzeWorkflowScript(bothFilled().text);
    expect(filled.ok).toBe(true);
    expect(filled.flow?.holes).toBeUndefined();
    expect(filled.causality?.steps.find((s) => s.id === ORDER)).toBeUndefined();
    expect(filled.causality?.steps.find((s) => s.id === `${ORDER}/ask#1`)).toMatchObject({
      fill: ORDER,
      phase: ORDER,
    });
    expect(filled.causality?.steps.find((s) => s.id === `${GROUP}/ask#1`)).toMatchObject({
      fill: GROUP,
      phase: GROUP,
    });
    expect(filled.causality?.phases?.map((p) => [p.id, p.fill])).toEqual([
      ["unphased", undefined],
      [GROUP, undefined],
      [ORDER, GROUP],
    ]);
    expect(collectSitePhases(filled.core!).get(`${ORDER}/ask#1`)).toBe("决定顺序");
  });

  it("(5) collectPhaseNames places the inner hole by name with its index", () => {
    expect(collectPhaseNames(analyzeWorkflowScript(outerFilled().text).flow)).toEqual({
      holes: [1],
      phaseNames: ["决定分组", "决定顺序"],
    });
    expect(collectPhaseNames(analyzeWorkflowScript(bothFilled().text).flow)).toEqual({
      holes: [],
      phaseNames: ["决定分组", "决定顺序"],
    });
  });
});

// 修复原因：id 曾逐层拼接（`hole#1/hole#1/…`，每层 7 个字符），接龙八九步就顶到协议的 64 字符
// id 上界。名字键之后深度不再进 id：这里把一条尾巴留白的接龙长到 20 步，每一步都走真实的
// 拼接 + 稳定性复核 + 全量分析，最后看最长的 id 与第一步时一样短。
describe("a tail chain twenty fills deep", () => {
  const STEPS = 20;
  const stepName = (k: number) => `第${k}步`;
  const SEED = [
    `phase("盘点");`,
    `const s0 = await agent("勘察员").ask<string>("看一眼");`,
    `return await hole<string>("${stepName(1)}", \`起点 \${s0}\`);`,
  ].join("\n");
  const body = (k: number) =>
    k === STEPS
      ? `return s${k - 1};`
      : [
          `phase("做${stepName(k)}");`,
          `const s${k} = await agent("写手${k}").ask<string>(\`接着 \${s${k - 1}}\`);`,
          `return await hole<string>("${stepName(k + 1)}", \`进度 ${k}\`);`,
        ].join("\n");

  const grow = () => {
    let text = SEED;
    const lengths: number[] = [];
    for (let k = 1; k <= STEPS; k += 1) {
      const before = sitesOf(text);
      const id = holeSiteId(stepName(k));
      const spliced = spliceHoleBody(text, before.table, id, body(k));
      expect(spliced, `step ${k}`).toBeDefined();
      const after = sitesOf(spliced!.text);
      expect(after.diagnostics, `step ${k}`).toEqual([]);
      expect(
        checkSiteStability(
          before.table,
          after.table,
          id,
          spliced!.insertedAtLine,
          spliced!.insertedLines,
        ),
        `step ${k}`,
      ).toEqual({ ok: true });
      const all = [...after.table.asks, ...after.table.actors, ...after.table.holes].map(
        (s) => s.id,
      );
      lengths.push(Math.max(...all.map((sid) => sid.length)));
      text = spliced!.text;
    }
    return { lengths, text };
  };

  it("keeps every fill stable and every id as short at step 20 as at step 1", () => {
    const { lengths, text } = grow();
    // 最长的 id 是 `hole#xxxxxxxx/actor#1` 这一类：21 个字符，与深度无关。
    expect(new Set(lengths)).toEqual(new Set([lengths[0]]));
    expect(lengths[0]).toBeLessThanOrEqual(24);
    const analyzed = analyzeWorkflowScript(text);
    expect(analyzed.ok).toBe(true);
    // 每一步的名字都还在阶段表里：接龙的步名不会从侧栏消失。
    const names = collectPhaseNames(analyzed.flow).phaseNames;
    for (let k = 1; k <= STEPS; k += 1) expect(names).toContain(stepName(k));
    expect(collectPhaseNames(analyzed.flow).holes).toEqual([]);
  });

  it("records each step's enclosing step in fill, so nesting survives without being spelled in the id", () => {
    const { text } = grow();
    const { table } = sitesOf(text);
    for (let k = 2; k <= STEPS; k += 1) {
      const hole = table.holes.find((h) => h.id === holeSiteId(stepName(k)));
      expect(hole?.fill, `step ${k}`).toBe(holeSiteId(stepName(k - 1)));
    }
    expect(table.holes.find((h) => h.id === holeSiteId(stepName(1)))?.fill).toBeUndefined();
    // 最里层函数体的站点只带最里层留白自己的一层前缀。
    const lowered = lowerWorkflowScript(text).lowered!;
    expect(lowered.siteIds).toContain(`${holeSiteId(stepName(19))}/ask#1`);
    expect(Object.keys(lowered.holeBodies)).toHaveLength(STEPS);
  });
});
