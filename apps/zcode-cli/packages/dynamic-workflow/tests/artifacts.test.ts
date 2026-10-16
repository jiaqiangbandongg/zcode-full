/**
 * 用户面产物（docs/dynamic-workflow/authoring.md）的编译侧：站点身份、lowering、编译期诊断与
 * `declaredArtifacts` 清单。引擎侧在 tests/engine/engine-artifacts.test.ts。
 *
 * ⚠ 术语：本文件的 artifact 一律指**用户面产物**（脚本发布给用户看的产出），不是引擎内部
 * 同名的顶层返回值（`RunSettlement.artifact`）。
 */

import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  ARTIFACT_DECLARATION_CODE,
  ARTIFACT_HOISTING_CODE,
  ARTIFACT_PRIMARY_CONFLICT_CODE,
  collectArtifactDeclarations,
  collectDiagnostics,
  collectSites,
  createWorkflowProgram,
  lowerWorkflow,
} from "../src/index.js";
import { FACADE_SITING_CODE } from "../src/analysis/facade-misuse.js";

const CHART = '{ x: { field: "round" }, y: { field: "ms" } }';

/** 编译 + 收集站点（脚本必须先干净通过 typecheck——否则站点表不可信）。 */
function sites(scriptText: string) {
  const workflow = createWorkflowProgram(scriptText);
  expect(collectDiagnostics(workflow.program)).toEqual([]);
  return { table: collectSites(workflow), workflow };
}

function lower(scriptText: string): string {
  const { table, workflow } = sites(scriptText);
  return lowerWorkflow(workflow, table).code;
}

/** 只取产物相关的三个诊断码（其余 authoring 诊断不在本文件的射程内）。 */
function artifactDiagnostics(scriptText: string) {
  const analyzed = analyzeWorkflowScript(scriptText);
  return analyzed.diagnostics.filter(
    (d) =>
      d.code === ARTIFACT_DECLARATION_CODE ||
      d.code === ARTIFACT_HOISTING_CODE ||
      d.code === ARTIFACT_PRIMARY_CONFLICT_CODE,
  );
}

describe("artifact sites", () => {
  it("mints one site per member with the registry op, on its own counter", () => {
    const { table } = sites(
      [
        `artifact.chart("perf", ${CHART});`,
        `artifact.table("rows", { columns: [{ field: "name" }] });`,
        `artifact.metrics("m", { metrics: [{ field: "p95" }] });`,
        `artifact.board("b", { key: "id", status: "state", columns: ["todo"] });`,
        `await artifact.file("book", "out/book.pdf");`,
        `await artifact.markdown("notes", "# hi");`,
      ].join("\n"),
    );
    expect(table.artifacts.map((site) => [site.id, site.op, site.artifactId])).toEqual([
      ["artifact#1", "chart", "perf"],
      ["artifact#2", "table", "rows"],
      ["artifact#3", "metrics", "m"],
      ["artifact#4", "board", "b"],
      ["artifact#5", "file", "book"],
      ["artifact#6", "markdown", "notes"],
    ]);
  });

  // site-id stability：加产物调用不得挪动任何既有 id（journal 的键就是这些 id）。
  it("leaves ask/actor/report/world-read ids byte-identical", () => {
    const withoutArtifacts = [
      `const a = agent("w");`,
      `const files1 = await files.glob("*.ts");`,
      `report({ n: files1.length });`,
      `const r = await a.ask("go");`,
      `return r;`,
    ].join("\n");
    const withArtifacts = [
      `const a = agent("w");`,
      `artifact.chart("perf", ${CHART});`,
      `const files1 = await files.glob("*.ts");`,
      `report({ n: files1.length }, "perf");`,
      `await artifact.markdown("notes", "# hi");`,
      `const r = await a.ask("go");`,
      `return r;`,
    ].join("\n");
    const idsOf = (text: string) => {
      const { table } = sites(text);
      return [
        ...table.actors.map((s) => s.id),
        ...table.asks.map((s) => s.id),
        ...table.reports.map((s) => s.id),
        ...table.worldReads.map((s) => s.id),
      ];
    };
    expect(idsOf(withArtifacts)).toEqual(idsOf(withoutArtifacts));
  });

  it("collects the report tag as a literal, and keeps a non-literal one raw", () => {
    const { table } = sites(
      [
        `artifact.chart("perf", ${CHART});`,
        `const tag = "perf";`,
        `report({ a: 1 }, "perf");`,
        `report({ a: 2 }, tag);`,
        `report({ a: 3 });`,
      ].join("\n"),
    );
    expect(table.reports.map((s) => s.artifactId)).toEqual(["perf", undefined, undefined]);
    // 非字面量标签有表达式、无值；无标签两者皆无——诊断趟据此区分「写错了」与「没写」。
    expect(table.reports.map((s) => s.artifactIdExpr !== undefined)).toEqual([true, true, false]);
  });

  it("consumes the global discovery order alongside report sites", () => {
    const { table, workflow } = sites(
      [`report({ a: 1 });`, `artifact.chart("perf", ${CHART});`, `report({ a: 2 }, "perf");`].join(
        "\n",
      ),
    );
    expect(lowerWorkflow(workflow, table).siteIds).toEqual(["report#1", "artifact#1", "report#2"]);
  });
});

describe("artifact lowering", () => {
  it("lowers content members to __host.publishArtifact with positional args", () => {
    const code = lower(
      `await artifact.file("book", "out/book.pdf", { title: "Book" });\n` +
        `await artifact.markdown("notes", "# hi");`,
    );
    expect(code).toContain(
      `__host.publishArtifact("artifact#1", "file", ["book", "out/book.pdf", { title: "Book" }])`,
    );
    expect(code).toContain(`__host.publishArtifact("artifact#2", "markdown", ["notes", "# hi"])`);
  });

  it("lowers preset members to __host.declareArtifact", () => {
    const code = lower(`artifact.chart("perf", ${CHART});`);
    expect(code).toContain(`__host.declareArtifact("artifact#1", "chart", ["perf", {`);
    expect(code).not.toContain("publishArtifact");
  });

  it("passes the report tag through as a third argument", () => {
    const code = lower(
      `artifact.chart("perf", ${CHART});\nreport({ a: 1 }, "perf");\nreport({ a: 2 });`,
    );
    expect(code).toContain(`__host.report("report#1", { a: 1 }, "perf")`);
    expect(code).toContain(`__host.report("report#2", { a: 2 })`);
  });

  it("leaves log and phase on their own host members", () => {
    const code = lower(`phase("gate");\nlog("hi");\nawait artifact.markdown("n", "x");`);
    expect(code).toContain("__host.log(");
    // 标记不再抹成 void 0：它改写成 enterPhase（docs/execution-engine.md「From script to sandbox input: lowering」）。
    expect(code).toContain('__host.enterPhase("gate")');
    expect(code).toContain("__host.publishArtifact(");
  });

  it("keeps artifact sites in the lowered site id list", () => {
    const { table, workflow } = sites(`await artifact.file("book", "b.pdf");`);
    expect(lowerWorkflow(workflow, table).siteIds).toEqual(["artifact#1"]);
  });
});

describe("artifact id diagnostics", () => {
  it("rejects a non-literal id, positioned on the argument", () => {
    const diagnostics = artifactDiagnostics(
      `const id = "book";\nawait artifact.file(id, "b.pdf");`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(ARTIFACT_DECLARATION_CODE);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("compile-time string literal");
  });

  it("rejects a substitution-template id", () => {
    expect(
      artifactDiagnostics('const n = 1;\nawait artifact.file(`book-${n}`, "b.pdf");'),
    ).toHaveLength(1);
  });

  it("rejects an empty id", () => {
    const diagnostics = artifactDiagnostics(`await artifact.file("", "b.pdf");`);
    expect(diagnostics[0]?.message).toContain("must not be empty");
  });

  it("rejects an over-long id", () => {
    const id = "x".repeat(65);
    const diagnostics = artifactDiagnostics(`await artifact.file("${id}", "b.pdf");`);
    expect(diagnostics[0]?.message).toContain("the limit is 64");
  });

  it("rejects illegal characters", () => {
    const diagnostics = artifactDiagnostics(`await artifact.file("out/book pdf", "b.pdf");`);
    expect(diagnostics[0]?.message).toContain("[A-Za-z0-9_.-]");
  });

  it("accepts the legal character set", () => {
    expect(artifactDiagnostics(`await artifact.file("perf.p95_v2-final", "b.pdf");`)).toEqual([]);
  });

  it("rejects one id used with two kinds, pointing at the second", () => {
    const diagnostics = artifactDiagnostics(
      `await artifact.file("x", "b.pdf");\nawait artifact.markdown("x", "hi");`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("two different kinds");
  });

  it("allows the same id republished with the same kind (that is a new version)", () => {
    expect(
      artifactDiagnostics(`await artifact.file("x", "a.pdf");\nawait artifact.file("x", "b.pdf");`),
    ).toEqual([]);
  });
});

describe("primary diagnostics (9009)", () => {
  it("rejects two different ids both marked primary, positioned on the second flag", () => {
    const diagnostics = artifactDiagnostics(
      `await artifact.file("book", "b.pdf", { primary: true });\n` +
        `await artifact.markdown("notes", "hi", { title: "Notes",\n  primary: true });`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(ARTIFACT_PRIMARY_CONFLICT_CODE);
    expect(diagnostics[0]?.line).toBe(3);
    expect(diagnostics[0]?.message).toContain('"book" already is');
  });

  it("counts a preset's spec flag too", () => {
    const diagnostics = artifactDiagnostics(
      `artifact.board("b", { key: "id", status: "s", columns: ["x"], primary: true });\n` +
        `await artifact.file("book", "b.pdf", { primary: true });`,
    );
    expect(diagnostics.map((d) => d.code)).toEqual([ARTIFACT_PRIMARY_CONFLICT_CODE]);
  });

  it("allows the same id flagged twice (a new version of the deliverable)", () => {
    expect(
      artifactDiagnostics(
        `await artifact.file("x", "a.pdf", { primary: true });\nawait artifact.file("x", "b.pdf", { primary: true });`,
      ),
    ).toEqual([]);
  });

  it("ignores a computed or false flag — that half belongs to the engine", () => {
    expect(
      artifactDiagnostics(
        `const p = true;\nawait artifact.file("a", "a.pdf", { primary: p });\n` +
          `await artifact.file("b", "b.pdf", { primary: true });\nawait artifact.file("c", "c.pdf", { primary: false });`,
      ),
    ).toEqual([]);
  });
});

describe("preset hoisting diagnostics", () => {
  it("rejects a preset declared in a loop body", () => {
    const diagnostics = artifactDiagnostics(
      `for (const p of ["a"]) {\n  artifact.chart("perf", ${CHART});\n}`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(ARTIFACT_HOISTING_CODE);
    expect(diagnostics[0]?.message).toContain("inside a loop");
  });

  it("rejects a preset declared inside a callback", () => {
    const diagnostics = artifactDiagnostics(
      `["a"].forEach(() => {\n  artifact.table("rows", { columns: [{ field: "n" }] });\n});`,
    );
    expect(diagnostics[0]?.code).toBe(ARTIFACT_HOISTING_CODE);
    expect(diagnostics[0]?.message).toContain("inside a callback");
  });

  it("rejects a preset declared inside a conditional branch", () => {
    const diagnostics = artifactDiagnostics(
      `if (args.deep) {\n  artifact.metrics("m", { metrics: [{ field: "p95" }] });\n}`,
    );
    expect(diagnostics[0]?.code).toBe(ARTIFACT_HOISTING_CODE);
    expect(diagnostics[0]?.message).toContain("conditional branch");
  });

  // 回归（2026-09-29 testfield 实测）：补全的函数体被拼进 `hole(name, prompt, async () => {…})` 的箭头里，
  // 旧规则把一切箭头都当回调，于是任何补全都声明不了看板——主代理只好放弃那块看板。
  const BOARD = '{ key: "module", status: "status", columns: ["done", "concerns"] }';

  it("lets a fill declare a preset: the hole's body runs where the hole stands", () => {
    expect(
      artifactDiagnostics(
        `return await hole<number>("第1步：施工", "p", async () => {\n` +
          `  artifact.board("modules", ${BOARD});\n` +
          `  report({ module: "lexer", status: "done" }, "modules");\n` +
          `  return 1;\n` +
          `});`,
      ),
    ).toEqual([]);
  });

  it("lets a fill nested in a tail chain declare a preset too", () => {
    expect(
      artifactDiagnostics(
        `return await hole<number>("第1步：施工", "p", async () => {\n` +
          `  return await hole<number>("第2步：验收", "q", async () => {\n` +
          `    artifact.chart("perf", ${CHART});\n` +
          `    return 2;\n` +
          `  });\n` +
          `});`,
      ),
    ).toEqual([]);
  });

  it("still sees the loop around a hole whose fill declares a preset", () => {
    const diagnostics = artifactDiagnostics(
      `for (const p of ["a", "b"]) {\n` +
        `  await hole<void>("每轮怎么做", p, async () => {\n` +
        `    artifact.board("modules", ${BOARD});\n` +
        `  });\n` +
        `}`,
    );
    expect(diagnostics.map((d) => d.code)).toEqual([ARTIFACT_HOISTING_CODE]);
    expect(diagnostics[0]?.message).toContain("inside a loop");
  });

  it("still flags a real callback inside a fill", () => {
    const diagnostics = artifactDiagnostics(
      `return await hole<number>("第1步：施工", "p", async () => {\n` +
        `  ["a"].forEach(() => {\n    artifact.board("modules", ${BOARD});\n  });\n` +
        `  return 1;\n` +
        `});`,
    );
    expect(diagnostics.map((d) => d.code)).toEqual([ARTIFACT_HOISTING_CODE]);
    expect(diagnostics[0]?.message).toContain("inside a callback");
  });

  it("leaves content members alone in loops and branches (a new version per round is the point)", () => {
    expect(
      artifactDiagnostics(
        `for (const p of ["a"]) {\n  await artifact.file("book", "b.pdf");\n}\n` +
          `if (args.x) { await artifact.markdown("notes", "hi"); }`,
      ),
    ).toEqual([]);
  });

  it("accepts a top-level preset declaration fed from inside a loop", () => {
    expect(
      artifactDiagnostics(
        `artifact.chart("perf", ${CHART});\nfor (const p of ["a"]) {\n  report({ round: 1 }, "perf");\n}`,
      ),
    ).toEqual([]);
  });
});

describe("report tag diagnostics", () => {
  it("rejects a non-literal tag", () => {
    const diagnostics = artifactDiagnostics(
      `artifact.chart("perf", ${CHART});\nconst t = "perf";\nreport({ a: 1 }, t);`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(3);
    expect(diagnostics[0]?.message).toContain("compile-time string literal");
  });

  it("rejects a tag naming no declared preset, and lists the ones that exist", () => {
    const diagnostics = artifactDiagnostics(
      `artifact.chart("perf", ${CHART});\nreport({ a: 1 }, "nope");`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('declared presets: "perf"');
  });

  it("says so plainly when the script declares no presets at all", () => {
    const diagnostics = artifactDiagnostics(`report({ a: 1 }, "perf");`);
    expect(diagnostics[0]?.message).toContain("no preset artifacts at all");
  });

  it("rejects a tag naming a content artifact", () => {
    const diagnostics = artifactDiagnostics(
      `await artifact.markdown("doc", "# hi");\nreport({ a: 1 }, "doc");`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("holds content rather than a stream of items");
  });

  it("accepts a tag declared later in the text (order is a run-time matter)", () => {
    expect(
      artifactDiagnostics(`report({ a: 1 }, "perf");\nartifact.chart("perf", ${CHART});`),
    ).toEqual([]);
  });

  it("leaves untagged reports alone", () => {
    expect(artifactDiagnostics(`report({ a: 1 });`)).toEqual([]);
  });
});

describe("declaredArtifacts", () => {
  it("is deduplicated and sorted by id", () => {
    const analyzed = analyzeWorkflowScript(
      [
        `artifact.chart("perf", ${CHART});`,
        `artifact.chart("perf", ${CHART});`,
        `await artifact.file("book", "b.pdf");`,
        `await artifact.file("book", "b2.pdf");`,
        `artifact.board("kanban", { key: "id", status: "s", columns: ["a"] });`,
      ].join("\n"),
    );
    expect(analyzed.ok).toBe(true);
    expect(analyzed.declaredArtifacts).toEqual([
      { id: "book", kind: "file" },
      { id: "kanban", kind: "board" },
      { id: "perf", kind: "chart" },
    ]);
  });

  it("is empty for a script with no artifacts, and for one that does not compile", () => {
    expect(analyzeWorkflowScript(`log("hi");`).declaredArtifacts).toEqual([]);
    expect(analyzeWorkflowScript(`const x: number = "no";`).declaredArtifacts).toEqual([]);
  });

  it("comes straight off the site table, so collectArtifactDeclarations is usable alone", () => {
    const { table, workflow } = sites(`await artifact.file("book", "b.pdf");`);
    const { declaredArtifacts, diagnostics } = collectArtifactDeclarations(workflow, table);
    expect(diagnostics).toEqual([]);
    expect(declaredArtifacts).toEqual([{ id: "book", kind: "file" }]);
  });
});

/**
 * 诊断的**去处**（2026-09-04 裁决）：产物诊断必须与 world.run 的非字面量 cmd 走**同一条**
 * authoring 通道——也就是 `analyzeWorkflowScript` 的 `{ ok, diagnostics }`。
 *
 * 那条通道有三个消费方，都在 core 侧读同一个 `analyzeScript(...)`：CreateWorkflow handler
 * （`!ok` ⇒ 把每条诊断渲染成 `L{line}:C{column} {message}` 回给模型自修，且**不执行**）、
 * SaveWorkflow（`!ok` ⇒ 不落盘）、以及中枢直接启动（`!ok || diagnostics.length > 0` ⇒
 * compile_failed）。所以"被收集到了"不等于"被看见了"：`ok` 必须被清掉，诊断必须带位置。
 * 本组用例把这两件事与 world.run 的先例并排钉住。
 */
describe("authoring diagnostics channel", () => {
  const BAD_ARTIFACT = `const id = "book";\nawait artifact.file(id, "b.pdf");`;
  const BAD_WORLD_RUN = `const cmd = "lean";\nawait world.run(cmd, []);`;

  it("clears ok and surfaces the diagnostic, exactly like a non-literal world.run cmd", () => {
    const artifactRun = analyzeWorkflowScript(BAD_ARTIFACT);
    const worldRun = analyzeWorkflowScript(BAD_WORLD_RUN);
    expect(artifactRun.ok).toBe(worldRun.ok);
    expect(artifactRun.ok).toBe(false);
    expect(artifactRun.diagnostics).toHaveLength(1);
    expect(artifactRun.diagnostics[0]?.code).toBe(ARTIFACT_DECLARATION_CODE);
  });

  it("positions every artifact diagnostic, so the model-facing render has a line and column", () => {
    const scripts = [
      BAD_ARTIFACT,
      `await artifact.file("", "b.pdf");`,
      `await artifact.file("a b", "b.pdf");`,
      `await artifact.file("x", "a.pdf");\nawait artifact.markdown("x", "hi");`,
      `report({ a: 1 }, "perf");`,
      `for (const p of ["a"]) {\n  artifact.chart("perf", ${CHART});\n}`,
    ];
    for (const script of scripts) {
      const analyzed = analyzeWorkflowScript(script);
      expect(analyzed.ok).toBe(false);
      expect(analyzed.diagnostics.length).toBeGreaterThan(0);
      for (const diagnostic of analyzed.diagnostics) {
        expect(diagnostic.line).toBeGreaterThan(0);
        expect(diagnostic.column).toBeGreaterThan(0);
        expect(diagnostic.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("withholds the graphs, like the other authoring rules", () => {
    const analyzed = analyzeWorkflowScript(BAD_ARTIFACT);
    expect(analyzed.causality).toBeUndefined();
    expect(analyzed.graph).toBeUndefined();
    // 清单本身仍然给出（它是从站点表直接读的事实，不依赖解释）——只是这一条 id 读不出来。
    expect(analyzed.declaredArtifacts).toEqual([]);
  });

  it("still reports artifact diagnostics alongside the other authoring families", () => {
    const analyzed = analyzeWorkflowScript(
      [
        `const cmd = "lean";`,
        `await world.run(cmd, []);`,
        `await artifact.file("a b", "b.pdf");`,
        `phase(cmd);`,
      ].join("\n"),
    );
    expect(analyzed.ok).toBe(false);
    // 一趟报全：作者一次就能看全要改什么（与 world.run / phase 同席的理由）。
    const codes = new Set(analyzed.diagnostics.map((d) => d.code));
    expect(codes.has(ARTIFACT_DECLARATION_CODE)).toBe(true);
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("artifact facade siting", () => {
  it("rejects taking a reference to a facade artifact member", () => {
    const analyzed = analyzeWorkflowScript(`const publish = artifact.file;\nlog("x");`);
    expect(analyzed.ok).toBe(false);
    expect(analyzed.diagnostics[0]?.code).toBe(FACADE_SITING_CODE);
    expect(analyzed.diagnostics[0]?.message).toContain("'file'");
  });

  it("still allows a direct call", () => {
    expect(analyzeWorkflowScript(`await artifact.file("book", "b.pdf");`).ok).toBe(true);
  });
});
