import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createWorkflowProgram } from "../src/compiler/compile.js";
import { collectSites } from "../src/analysis/sites.js";
import { collectPhaseMarkerDiagnostics, PHASE_MARKER_CODE } from "../src/analysis/phases.js";
import { FACADE_SITING_CODE } from "../src/analysis/facade-misuse.js";
import { analyzeWorkflowScript } from "../src/index.js";
import { corpusDiagnostics } from "./helpers/analysis-corpus.js";

// phase() 标记的编译面（docs/analysis.md「Phases」）：
// 收集（无站点、不占计数器）、诊断（9004 的三条规则）、与 facade-siting 的分工。

const markers = (scriptText: string) => {
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  return { diagnostics: collectPhaseMarkerDiagnostics(workflow, table), table, workflow };
};

describe("phase marker collection", () => {
  it("collects a marker with its literal name, consuming no site id", () => {
    const { table } = markers(`phase("preflight");\nconst a = agent("a");\nreturn 1;`);
    expect(table.phases).toHaveLength(1);
    expect(table.phases[0]?.name).toBe("preflight");
    expect(table.phases[0]?.loc).toEqual({ column: 1, line: 1 });
    // 标记不是站点：actor 的 per-kind id 与全局 order 都从"第一个真站点"开始。
    expect(table.actors[0]?.id).toBe("actor#1");
    expect(table.actors[0]?.order).toBe(0);
  });

  it("takes a no-substitution template as a name (string-literal-like)", () => {
    const { table, diagnostics } = markers(`phase(\`gate\`);\nreturn 1;`);
    expect(table.phases[0]?.name).toBe("gate");
    expect(diagnostics).toEqual([]);
  });

  it("leaves name unset but keeps nameExpr when the argument is not a literal", () => {
    const { table } = markers(`const n = "gate";\nphase(n);\nreturn 1;`);
    expect(table.phases[0]?.name).toBeUndefined();
    expect(table.phases[0]?.nameExpr).toBeDefined();
  });

  it("ignores a script-local function that happens to be named phase", () => {
    // 身份按声明判定，与 sites.ts 的其余分支同一机制：别人的 `phase` 是别人的函数。
    const { table, diagnostics } = markers(
      `function phase(x: number): void { log(\`\${x}\`); }\nphase(1);\nreturn 1;`,
    );
    expect(table.phases).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  // site-id stability（docs/analysis.md 的 "Sites"）：加标记
  // 不许挪动任何站点的 id，**连全局 order 都不许挪**——这比 report 当年的豁免更强，而
  // 标记没有 id 可排，所以这条不变量是免费的。这里逐字节比对两份站点表的 (id, order)。
  it("moves no site id and no discovery order when markers are added", () => {
    const identity = (scriptText: string): string[] => {
      const { table } = markers(scriptText);
      return [...table.actors, ...table.asks, ...table.reports, ...table.worldReads]
        .sort((a, b) => a.order - b.order)
        .map((site) => `${site.order}:${site.id}`);
    };
    const bare =
      `const a = agent("a");\n` +
      `const paths = await files.glob("*.ts");\n` +
      `const x = await a.ask<string>("go");\n` +
      `report(x);\n` +
      `return paths.length;`;
    const annotated =
      `phase("preflight");\n` +
      `const a = agent("a");\n` +
      `const paths = await files.glob("*.ts");\n` +
      `phase("work");\n` +
      `const x = await a.ask<string>("go");\n` +
      `report(x);\n` +
      `phase("wrap-up");\n` +
      `return paths.length;`;
    expect(identity(annotated)).toEqual(identity(bare));
    expect(identity(bare)).toEqual(["0:actor#1", "1:world-read#1", "2:ask#1", "3:report#1"]);
  });
});

describe("phase marker diagnostics (9004)", () => {
  function expectRejected(
    scriptText: string,
    expected: { column: number; line: number; contains: string },
  ): void {
    const { diagnostics } = markers(scriptText);
    const match = diagnostics.find(
      (d) => d.line === expected.line && d.column === expected.column,
    );
    expect(
      match,
      `expected a 9004 diagnostic at ${expected.line}:${expected.column}; got ${JSON.stringify(diagnostics)}`,
    ).toBeDefined();
    expect(match?.code).toBe(PHASE_MARKER_CODE);
    expect(match?.message).toContain(expected.contains);
  }

  it("rejects a variable name, positioned on the offending expression", () => {
    expectRejected(`const n = "gate";\nphase(n);\nreturn 1;`, {
      column: 7,
      contains: "compile-time string literal",
      line: 2,
    });
  });

  it("rejects a template with holes", () => {
    expectRejected(`const i = 1;\nphase(\`round \${i}\`);\nreturn 1;`, {
      column: 7,
      contains: "compile-time string literal",
      line: 2,
    });
  });

  it("rejects an empty name, and one that is only whitespace", () => {
    expectRejected(`phase("");\nreturn 1;`, { column: 7, contains: "has no name to show", line: 1 });
    expectRejected(`phase("  \\t ");\nreturn 1;`, {
      column: 7,
      contains: "has no name to show",
      line: 1,
    });
  });

  it("rejects a marker in expression position (a void initializer typechecks)", () => {
    expectRejected(`const x = phase("a");\nreturn x;`, {
      column: 11,
      contains: "must stand alone as its own statement",
      line: 1,
    });
  });

  it("rejects markers in both arms of a ternary", () => {
    const { diagnostics } = markers(`const f = true;\nf ? phase("a") : phase("b");\nreturn 1;`);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.column)).toEqual([5, 18]);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe(PHASE_MARKER_CODE);
      expect(diagnostic.message).toContain("must stand alone");
    }
  });

  it("reports both rules for one marker that breaks both", () => {
    // `const x = phase(n)`：非字面量名 + 非语句位置。作者一次看全要改什么。
    const { diagnostics } = markers(`const n = "g";\nconst x = phase(n);\nreturn x;`);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.code)).toEqual([PHASE_MARKER_CODE, PHASE_MARKER_CODE]);
  });

  it("accepts valid markers at every legal position (top level, branch, loop body)", () => {
    const { diagnostics } = markers(
      `phase("preflight");\n` +
        `const paths = await files.glob("*.ts");\n` +
        `if (paths.length > 0) {\n` +
        `  phase("review");\n` +
        `  for (const p of paths) {\n` +
        `    phase("per-file");\n` +
        `    log(p);\n` +
        `  }\n` +
        `}\n` +
        `phase("wrap-up");\n` +
        `return paths.length;`,
    );
    expect(diagnostics).toEqual([]);
  });

  it("accepts an effect-free marker (block-final, and two in a row)", () => {
    // 无效果的标记合法、无害、不诊断（spec 的「无效果 marker」行）：块尾标记什么都不认领，
    // 连续两个标记里前一个立刻被后一个取代。两者都是陈旧编辑，不是错误。
    const { diagnostics } = markers(
      `phase("a");\n` +
        `phase("b");\n` +
        `const paths = await files.glob("*.ts");\n` +
        `if (paths.length > 0) {\n` +
        `  log("some");\n` +
        `  phase("nothing-follows");\n` +
        `}\n` +
        `return paths.length;`,
    );
    expect(diagnostics).toEqual([]);
  });
});

describe("phase markers in analyzeWorkflowScript", () => {
  it("withholds both views on a 9004 diagnostic (ok: false)", () => {
    // 与 world.run 的字面量检查同席：诊断非空即**不提交**，图与因果视图一并扣下——
    // 半张图比没有图更坏（handler 只在 ok 时才走 submit）。
    const result = analyzeWorkflowScript(`const n = "g";\nphase(n);\nreturn 1;`);
    expect(result.ok).toBe(false);
    expect(result.graph).toBeUndefined();
    expect(result.causality).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toEqual([PHASE_MARKER_CODE]);
  });

  it("withholds both views for every 9004 shape, not just the non-literal name", () => {
    for (const script of [
      `phase("");\nreturn 1;`,
      `const x = phase("a");\nreturn x;`,
      `const i = 1;\nphase(\`round \${i}\`);\nreturn 1;`,
    ]) {
      const result = analyzeWorkflowScript(script);
      expect(result.ok, script).toBe(false);
      expect(result.graph, script).toBeUndefined();
      expect(result.causality, script).toBeUndefined();
      expect(result.diagnostics.some((d) => d.code === PHASE_MARKER_CODE), script).toBe(true);
    }
  });

  it("reports world.run and phase diagnostics from the same run", () => {
    const result = analyzeWorkflowScript(
      `const cmd = "lean";\nawait world.run(cmd, []);\nphase("");\nreturn 1;`,
    );
    expect(result.ok).toBe(false);
    expect(new Set(result.diagnostics.map((d) => d.code))).toEqual(new Set([9003, 9004]));
  });

  it("analyzes a marked script cleanly, and the markers change nothing in the graph (WP1)", () => {
    // WP1 收集但不投影：阶段词汇表是 WP2。这条钉住「加标记不动因果图」。
    const bare = `const a = agent("a");\nconst x = await a.ask<string>("go");\nreturn x;`;
    const marked = `phase("work");\nconst a = agent("a");\nconst x = await a.ask<string>("go");\nreturn x;`;
    const bareResult = analyzeWorkflowScript(bare);
    const markedResult = analyzeWorkflowScript(marked);
    expect(markedResult.ok).toBe(true);
    expect(markedResult.diagnostics).toEqual([]);
    expect(markedResult.graph?.nodes.map((n) => n.id)).toEqual(
      bareResult.graph?.nodes.map((n) => n.id),
    );
  });

  it("rejects aliasing the marker via facade-siting (9001), not via 9004", () => {
    // `phase` 是 facade 函数声明，所以 misuse pass 1 已经覆盖别名逃逸——9004 那一趟不必
    // 重实现它。反过来说：pass 2（"产生站点却没被 site 掉"）绝不能误伤合法的直接调用，
    // 这正是 phase 不进 SITE_PRODUCING_FUNCTIONS 的原因。
    const result = analyzeWorkflowScript(`const p = phase;\np("gate");\nreturn 1;`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: FACADE_SITING_CODE,
      column: 11,
      line: 1,
    });
    expect(result.diagnostics[0]?.message).toContain("facade function 'phase'");
  });

  it("does not flag a direct marker call as unsited facade misuse", () => {
    const result = analyzeWorkflowScript(
      `phase("work");\nconst a = agent("a");\nconst x = await a.ask<string>("go");\nreturn x;`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/**
 * `alongside` against the causality quotient, over the whole corpus (the plan's "Why
 * `alongside` is a node fact, not an edge").
 *
 * The two answer different questions and are computed by different passes: `alongside` is a
 * MARK-TIME fact from the control-flow projection ("which phases' strands were still parked
 * when this marker ran"), incomparability is a property of the causality quotient ("neither
 * phase must precede the other"). The plan's argument is that one implies the other in one
 * direction: if B's marker comes after A's on the main line, both phases actually do work,
 * and nothing in the quotient orders A before B, then the only way B was entered is WHILE
 * A's work was still in flight — so B must say it is alongside A.
 *
 * Asserted per fixture rather than by eye, in the style of graphs.test.ts, so a fixture that
 * grows a phase vocabulary is covered without being named here. The other direction is NOT
 * asserted: `alongside` is deliberately flow-insensitive across choice arms, so it may
 * over-claim where the quotient has an edge.
 */
describe("`alongside` covers every incomparable later phase (property over the whole corpus)", () => {
  const graphsDir = join(dirname(fileURLToPath(import.meta.url)), "graphs");
  /** A `phase("…")` marker call in the fixture source, ignoring `.phase` property reads. */
  const MARKER_CALL = /(^|[^.\w])phase\s*\(/;

  const marked = readdirSync(graphsDir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => MARKER_CALL.test(readFileSync(join(graphsDir, name), "utf8")))
    .sort();

  it("finds marked fixtures", () => {
    expect(marked.length).toBeGreaterThan(0);
  });

  for (const fixture of marked) {
    it(`${fixture}: a phase entered while an earlier one is in flight says so`, () => {
      const result = analyzeWorkflowScript(readFileSync(join(graphsDir, fixture), "utf8"));
      expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
      const flow = result.flow;
      const causality = result.causality;
      if (flow === undefined || causality === undefined) throw new Error("expected graphs");
      const phases = flow.phases ?? [];

      // Where each phase's FIRST marker stands on the main line, and which phases own work.
      const firstMark = new Map<string, number>();
      const owns = new Set<string>();
      flow.nodes.forEach((node, index) => {
        if (node.kind === "mark" && !firstMark.has(node.phase)) firstMark.set(node.phase, index);
        if (node.kind === "issue") owns.add(node.phase);
      });

      // Forward reachability in the quotient. `carry` is a repetition's back edge, never an
      // ordering between two phases, so it cannot be what makes B comparable to A.
      const forward = new Map<string, string[]>();
      for (const edge of causality.phaseEdges ?? []) {
        if (edge.kind === "carry") continue;
        const list = forward.get(edge.from);
        if (list === undefined) forward.set(edge.from, [edge.to]);
        else list.push(edge.to);
      }
      const reaches = (from: string, to: string): boolean => {
        const seen = new Set<string>([from]);
        const stack = [from];
        while (stack.length > 0) {
          for (const next of forward.get(stack.pop() as string) ?? []) {
            if (next === to) return true;
            if (!seen.has(next)) {
              seen.add(next);
              stack.push(next);
            }
          }
        }
        return false;
      };

      const missing: string[] = [];
      for (const earlier of phases) {
        for (const later of phases) {
          const a = firstMark.get(earlier.id);
          const b = firstMark.get(later.id);
          if (a === undefined || b === undefined || a >= b) continue;
          if (!owns.has(earlier.id) || !owns.has(later.id)) continue;
          if (reaches(earlier.id, later.id)) continue;
          if ((later.alongside ?? []).includes(earlier.id)) continue;
          missing.push(`${later.id} entered after ${earlier.id} without ordering or alongside`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
