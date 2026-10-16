import { describe, expect, it } from "vitest";
import { analyzeWorkflowScript } from "../src/index.js";
import { DUPLICATE_ACTOR_NAME_CODE, FANOUT_ACTOR_NAME_CODE } from "../src/analysis/actor-names.js";

// 字面量 actor 重名的编译期 courtesy 诊断（docs/execution-engine.md 的
// 「命名唯一性（引擎）」行）。规则的正门在运行期（引擎 createActor 的 DuplicateActorName）；
// 这一趟只看字面量，所以它只许漏报、不许误报——每条 "legal" 用例都是对后者的断言。

/** 只取重名诊断（脚本本身必须 typecheck 干净，否则 analyze 根本走不到这一趟）。 */
function duplicates(scriptText: string) {
  const result = analyzeWorkflowScript(scriptText);
  const hits = result.diagnostics.filter((d) => d.code === DUPLICATE_ACTOR_NAME_CODE);
  return { hits, result };
}

/** 只取 fan-out 静态名诊断（子句 2，单独一个码——见 actor-names.ts 顶部）。 */
function fanOutNames(scriptText: string) {
  const result = analyzeWorkflowScript(scriptText);
  const hits = result.diagnostics.filter((d) => d.code === FANOUT_ACTOR_NAME_CODE);
  return { hits, result };
}

/** 干净脚本的断言：无重名诊断，且整份分析通过（图照常产出）。 */
function expectClean(scriptText: string): void {
  const { hits, result } = duplicates(scriptText);
  expect(hits).toEqual([]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
}

describe("duplicate actor names (compile-time courtesy)", () => {
  it("flags two literal name arguments that are the same string, on the later site", () => {
    const { hits, result } = duplicates(
      `const a = agent("planner");\nconst b = agent("planner");\nreturn 1;`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.message).toContain('"planner"');
    // 诊断与 world.run / phase 同席：脚本不可提交，图不产出。
    expect(result.ok).toBe(false);
    expect(result.graph).toBeUndefined();
  });

  it("reads through an object-literal persona to the name argument", () => {
    // 今天 `AgentPersona` **不声明** name（facade dts），所以脚本能写出的 persona 从不带名字，
    // 有效名一律来自 name 实参。收集器仍按 normalizePersona 的规则处理 persona（见下面两条
    // 跳过用例）——那是为了与运行期的有效名定义保持同步，而不是为了今天能触发。
    const { hits } = duplicates(
      `const a = agent("planner", { system: "You plan first." });\n` +
        `const b = agent("planner", { system: "You plan." });\n` +
        `return 1;`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });

  it("takes a string persona as a system prompt, not a name", () => {
    // agent(name, "You plan.") 的有效名仍是 name 实参——两处同名照样是重名。
    const { hits } = duplicates(
      `const a = agent("planner", "You plan.");\n` +
        `const b = agent("planner", "You also plan.");\n` +
        `return 1;`,
    );
    expect(hits).toHaveLength(1);
  });

  it("reports each later repetition of a name", () => {
    const { hits } = duplicates(
      `const a = agent("w");\nconst b = agent("w");\nconst c = agent("w");\nreturn 1;`,
    );
    expect(hits.map((d) => d.line)).toEqual([2, 3]);
  });

  it("leaves anonymous actors alone, however many", () => {
    // 匿名合法（运行期也不查）。注意站点表会把绑定名当**展示标签**记进 site.name，
    // 所以这条同时钉住「诊断读的是实参，不是那个标签」——否则下面两个都叫 "a"/"b" 的
    // 匿名 actor 会被误伤。
    expectClean(`const a = agent();\nconst b = agent();\nreturn 1;`);
  });

  it("leaves empty names alone (empty is anonymous, matching the engine)", () => {
    expectClean(`const a = agent("");\nconst b = agent("");\nreturn 1;`);
  });

  it("leaves distinct names alone", () => {
    expectClean(`const a = agent("planner");\nconst b = agent("reviewer");\nreturn 1;`);
  });

  it("skips dynamic names — the runtime check is the real gate", () => {
    // 模板洞、标识符、循环里的同一个站点：静态说不准，一律放行，由引擎运行期兜底。
    expectClean(
      `const workers = [1, 2, 3].map((i) => agent(\`worker-\${i}\`));\n` +
        `const n = "planner";\nconst p = agent(n);\nconst q = agent(n);\n` +
        `return workers.length;`,
    );
  });

  it("skips a persona with a computed key (the key itself could be `name`)", () => {
    // 计算键必须让整个站点放弃，而不是「跳过这一个属性再落回 name 实参」——后者是一次猜测，
    // 猜错的方向正好是误报。
    expectClean(
      `const a = agent("w", { ["system"]: "You work." });\n` +
        `const b = agent("w", { ["system"]: "You work." });\n` +
        `return 1;`,
    );
  });

  it("skips a template-with-holes persona (it is a runtime string, not a literal)", () => {
    expectClean(
      `const role = "planner";\n` +
        `const a = agent("w", \`You are the \${role}.\`);\n` +
        `const b = agent("w", \`You are the \${role}.\`);\n` +
        `return 1;`,
    );
  });

  it("skips dynamic names inside a fan-out too (per-element names are the fix, not a violation)", () => {
    expectClean(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `const notes = await Promise.all(paths.map((p) => agent(\`reviewer-\${p}\`).ask<string>(\`Review \${p}\`)));\n` +
        `return notes.length;`,
    );
  });

  it("skips a spread persona and a non-literal persona (either could carry a name)", () => {
    // 保守而不是聪明：`AgentPersona` 今天没有 name，但收集器不拿 facade 的现状当前提——
    // 一旦它长出 name，「按 name 实参判定」就会变成对一个被改名的 actor 的**误报**，而误报
    // 会挡住合法脚本。漏报没有代价（引擎运行期兜底），所以看不穿就放行。
    expectClean(
      `const base = { system: "You work." };\n` +
        `const a = agent("w", { ...base });\nconst b = agent("w", base);\nreturn 1;`,
    );
  });
});

// 第二条子句：fan-out 体内的静态名。一个站点、N 个 actor、同一个名字——运行期必然
// DuplicateActorName。这条**刻意**可能误报（`.map` 的集合可能只有一个元素），理由见
// src/analysis/actor-names.ts 顶部：修复免费，而沉默的代价是烧掉一整个 run。
describe("static actor names inside a fan-out (compile-time)", () => {
  it("flags a literal name inside an array-method fan-out, without withholding the graph", () => {
    const { hits, result } = fanOutNames(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `const verdicts = await Promise.all(paths.map((p) => agent("reviewer").ask<string>(\`Review \${p}\`)));\n` +
        `return verdicts.length;`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.message).toContain("fan-out");
    expect(hits[0]?.message).toContain('"reviewer"');
    // 提交被挡住（ok:false），但图照常产出——这一条说的是脚本**跑**起来会失败，不是
    // 「这段代码没法分析」，而作者正需要看图才知道是哪个 fan-out（见 analyze.ts）。
    expect(result.ok).toBe(false);
    expect(result.graph).toBeDefined();
    expect(result.causality).toBeDefined();
  });

  it("flags a literal name inside a for...of body", () => {
    const { hits } = fanOutNames(
      `const items = ["a", "b"];\nconst out: string[] = [];\n` +
        `for (const item of items) {\n  const w = agent("worker");\n  out.push(await w.ask<string>(\`Do \${item}\`));\n}\n` +
        `return out;`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(4);
  });

  it("still withholds the graph when a blocking clause fires alongside it", () => {
    // 9005 与 9006 同时在场：9005 是扣图的那一档，整份分析照旧不产出图。
    const { result } = fanOutNames(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `const verdicts = await Promise.all(paths.map((p) => agent("reviewer").ask<string>(\`Review \${p}\`)));\n` +
        `const a = agent("dup");\nconst b = agent("dup");\n` +
        `return [verdicts.length, await a.ask<string>("x"), await b.ask<string>("y")];`,
    );
    expect(result.ok).toBe(false);
    expect(result.graph).toBeUndefined();
  });

  it("leaves an anonymous actor inside a fan-out alone", () => {
    expectClean(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `const verdicts = await Promise.all(paths.map((p) => agent().ask<string>(\`Review \${p}\`)));\n` +
        `return verdicts.length;`,
    );
  });

  it("leaves a literal name outside any fan-out alone (single site = runtime's business)", () => {
    expectClean(`const reviewer = agent("reviewer");\nreturn await reviewer.ask<string>("Review.");`);
  });

  it("reports one diagnostic per site, preferring the fan-out clause over the duplicate one", () => {
    // 同一个名字既在 fan-out 里、又在外面重复出现：fan-out 站点报 9006，外面那个照常按
    // 9005 报——两个站点各一条，不叠加。
    const script =
      `const paths = await files.glob("src/**/*.ts");\n` +
      `const verdicts = await Promise.all(paths.map((p) => agent("reviewer").ask<string>(\`Review \${p}\`)));\n` +
      `const late = agent("reviewer");\n` +
      `return [verdicts.length, await late.ask<string>("Again?")];`;
    expect(fanOutNames(script).hits.map((d) => d.line)).toEqual([2]);
    expect(duplicates(script).hits.map((d) => d.line)).toEqual([3]);
  });
});
