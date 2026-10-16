import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_BINDING, lowerWorkflowScript } from "../src/lowering/index.js";

// Lowering 快照 + 语义断言。快照是契约：人类可读的 lowered JS 落在 expected/<base>.js。
// 语义断言超出快照本身：站点 id 恰好一次、类型全擦除（把输出当 JS 解析证明）、无 facade
// 脚本降级为纯 JS、确定性（两次降级逐字节相同）。
const here = dirname(fileURLToPath(import.meta.url));
const loweringDir = join(here, "lowering");
const graphsDir = join(here, "graphs");

// AsyncFunction 构造器：用它把 lowered code 当 JS 解析，证明没有 TS 语法残留
// （顶层 await/return 在 async 函数体里都合法）。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown;

/** 每个降级 code 应满足的通用不变量。 */
function assertLowered(source: string): { code: string; siteIds: string[] } {
  const result = lowerWorkflowScript(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
  const lowered = result.lowered;
  if (lowered === undefined) throw new Error("expected lowered output for a clean script");
  return lowered;
}

/** 站点 id -> 它应被打桩成的 __host.* 调用前缀（不含引号，兼容任意引号风格）。 */
function hostCallFor(siteId: string): string {
  // 留白函数体内的站点带 `hole#N/` 前缀（docs/analysis.md「Sites」）：按最后一段判种类。
  const kindStart = siteId.lastIndexOf("/") + 1;
  if (kindStart > 0) return hostCallFor(siteId.slice(kindStart));
  if (siteId.startsWith("ask#")) return "__host.ask(";
  if (siteId.startsWith("actor#")) return "__host.createActor(";
  if (siteId.startsWith("world-read#")) return "__host.worldRead(";
  if (siteId.startsWith("report#")) return "__host.report(";
  if (siteId.startsWith("hole#")) return "__host.hole(";
  throw new Error(`unexpected site id kind: ${siteId}`);
}

const SNAPSHOT_FIXTURES: { base: string; dir: string }[] = [
  { base: "log-only", dir: loweringDir },
  { base: "no-facade", dir: loweringDir },
  { base: "chained-inline-ask", dir: loweringDir },
  { base: "helper-asks", dir: loweringDir },
  { base: "files-read-glob", dir: loweringDir },
  { base: "git-and-grep", dir: loweringDir },
  { base: "report-and-log", dir: loweringDir },
  { base: "phase-markers", dir: loweringDir },
  { base: "channel-future", dir: loweringDir },
  { base: "holes", dir: loweringDir },
  // 复用三个 graph fixtures：planner-reviewer 覆盖 log/ask/for 循环/Promise.all，
  // glob-fanout 覆盖 files.glob + fan-out，user-defined-ask 是负向覆盖——同名的用户
  // 自定义 `.ask` 方法必须原样保留，只有 facade 的 agent().ask() 被降级。
  { base: "planner-reviewer", dir: graphsDir },
  { base: "glob-fanout", dir: graphsDir },
  { base: "user-defined-ask", dir: graphsDir },
];

describe("lowering snapshots", () => {
  for (const { base, dir } of SNAPSHOT_FIXTURES) {
    it(base, async () => {
      const source = readFileSync(join(dir, `${base}.ts`), "utf8");
      const { code } = assertLowered(source);
      await expect(code).toMatchFileSnapshot(join(loweringDir, "expected", `${base}.js`));
    });
  }
});

// 广度语义断言：跑遍所有 graph fixtures + lowering fixtures，逐条证明不变量。
const semanticFixtures = [
  ...readdirSync(loweringDir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ dir: loweringDir, name: n })),
  ...readdirSync(graphsDir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ dir: graphsDir, name: n })),
].sort((a, b) => a.name.localeCompare(b.name));

describe("lowering semantics", () => {
  it("finds fixtures", () => {
    expect(semanticFixtures.length).toBeGreaterThan(0);
  });

  for (const { dir, name } of semanticFixtures) {
    it(`${name}: every site id appears exactly once in the right __host.* call`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const { code, siteIds } = assertLowered(source);
      // siteIds 去重后 == 原列表（每个站点唯一）。
      expect(new Set(siteIds).size).toBe(siteIds.length);
      for (const id of siteIds) {
        const quoted = new RegExp(`["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "g");
        const hits = code.match(quoted) ?? [];
        expect(hits.length, `site id ${id} must appear exactly once`).toBe(1);
        expect(code, `site id ${id} must sit in ${hostCallFor(id)}`).toContain(
          `${hostCallFor(id)}"${id}"`,
        );
      }
    });

    it(`${name}: lowers to type-stripped JS (parses as JS, no facade globals)`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const { code } = assertLowered(source);
      // 把输出当 JS 解析：TS 语法（interface / 类型注解 / <T> 类型实参）会让 AsyncFunction 抛错。
      expect(() => new AsyncFunction(HOST_BINDING, code)).not.toThrow();
      expect(code).not.toContain("interface ");
      expect(code).not.toContain("__host.ask<");
      // facade 全局名不应作为自由标识符残留——都改写成了 __host.*（phase 改写成 enterPhase）。
      expect(code).not.toMatch(/(^|[^.\w])files\.(glob|read|grep)\s*\(/);
      expect(code).not.toMatch(/(^|[^.\w])git\.(changedFiles|diff|status|log)\s*\(/);
      expect(code).not.toMatch(/(^|[^.\w])phase\s*\(/);
      // channel / future 同样改写成 __host.*（docs/dynamic-workflow/authoring.md「Streams」）。
      expect(code).not.toMatch(/(^|[^.\w])(channel|future)\s*\(/);
      // 留白改写成 __host.hole（docs/dynamic-workflow/authoring.md「Holes」）。
      expect(code).not.toMatch(/(^|[^.\w])hole\s*[(<]/);
    });

    it(`${name}: is deterministic (lowering twice yields identical bytes)`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const a = assertLowered(source);
      const b = assertLowered(source);
      expect(a.code).toBe(b.code);
      expect(a.siteIds).toEqual(b.siteIds);
    });
  }
});

describe("lowering edge cases", () => {
  it("packs world-read arguments positionally into an array literal", () => {
    // Boundary A 的 `worldRead(siteId, op, args)`：实参进**数组字面量**，按位置、不加解释
    // （spec 的 "lowering never switches on op"）。这是"加一个 world-read 原语在 lowering
    // 里零改动"的那条契约——多参 op（files.grep / git.diff）走的正是同一条路径。
    const source = readFileSync(join(loweringDir, "files-read-glob.ts"), "utf8");
    const { code } = assertLowered(source);
    expect(code).toContain(`__host.worldRead("world-read#1", "glob", ["src/**/*.ts"])`);
    expect(code).toContain(`__host.worldRead("world-read#2", "read", [first])`);
  });

  it("packs multi-argument and optional world-read arguments positionally", () => {
    // 可选实参**缺席就是更短的数组**，不是一个 undefined 洞：`inputHash({op, args})` 是
    // journal 键，`["TODO"]` 与 `["TODO", undefined]` 必须是两个不同的键，否则一次
    // "加了 glob 的 grep" 会命中一次"没加 glob 的 grep"的记录。
    const source = readFileSync(join(loweringDir, "git-and-grep.ts"), "utf8");
    const { code } = assertLowered(source);
    expect(code).toContain(`__host.worldRead("world-read#1", "grep", ["TODO"])`);
    expect(code).toContain(`__host.worldRead("world-read#2", "grep", ["TODO", "*.ts"])`);
    expect(code).toContain(`__host.worldRead("world-read#3", "git-changed-files", [])`);
    expect(code).toContain(`__host.worldRead("world-read#4", "git-changed-files", ["main"])`);
    expect(code).toContain(`__host.worldRead("world-read#5", "git-diff", [])`);
    expect(code).toContain(`__host.worldRead("world-read#6", "git-diff", ["main", "src/a.ts"])`);
    expect(code).toContain(`__host.worldRead("world-read#7", "git-status", [])`);
    expect(code).toContain(`__host.worldRead("world-read#8", "git-log", [])`);
    expect(code).toContain(`__host.worldRead("world-read#9", "git-log", [5])`);
  });

  it("lowers report(item) to __host.report(siteId, item) and log to __host.log", () => {
    // report 与 log 的分野在这一趟里最容易写错：两者都是**顶层无容器**的 facade 函数，
    // 但 report 有站点（走 siteMap，按 ts.Node 身份命中），log 没有（走 checker 名字识别）。
    const { code, siteIds } = assertLowered(
      `log("start");\nreport({ a: 1 });\nreport("plain");\nlog("done");\nreturn 1;\n`,
    );
    expect(siteIds).toEqual(["report#1", "report#2"]);
    expect(code).toContain(`__host.report("report#1", { a: 1 })`);
    expect(code).toContain(`__host.report("report#2", "plain")`);
    expect(code).toContain(`__host.log("start")`);
    expect(code).toContain(`__host.log("done")`);
    // 反向：log 绝不能被铸成 report 站点。
    expect(code).not.toContain(`"report#3"`);
  });

  it("interleaves report site ids into the global discovery order", () => {
    // siteIds 按全局 `order` 排（序列化的归并键），而 per-kind 计数器各自独立——所以
    // 插一个 report 会挪动 siteIds 的**顺序**，但不会挪动任何 ask#N / actor#N 的**名字**。
    const { siteIds } = assertLowered(
      `const a = agent("a");\nreport("before");\nconst x = await a.ask<string>("1");\nreport(x);\nconst y = await a.ask<string>("2");\nreturn x + y;\n`,
    );
    expect(siteIds).toEqual(["actor#1", "report#1", "ask#1", "report#2", "ask#2"]);
  });

  it("routes git.log to a world read and the top-level log to __host.log", () => {
    // 撞名两侧在同一份降级产物里各归其位。这是注册表按**声明容器**建键的可执行证明：
    // 裸名字方案要么给每条 log 铸一个 world-read 站点，要么把 git.log 的站点整个丢掉。
    const { code, siteIds } = assertLowered(
      `log("start");\nconst c = await git.log(3);\nlog("done");\nreturn c.length;\n`,
    );
    expect(siteIds).toEqual(["world-read#1"]);
    expect(code).toContain(`__host.worldRead("world-read#1", "git-log", [3])`);
    expect(code).toContain(`__host.log("start")`);
    expect(code).toContain(`__host.log("done")`);
    // 反向：没有第二个 world-read 站点，两条 log 都没被误铸成站点。
    expect(code).not.toContain(`"world-read#2"`);
  });

  it("keeps a multi-argument facade call's arguments in source order", () => {
    // 用 ask 的 receiver + 实参组合造一个"多个被访问的表达式"的降级：这里钉的是
    // visitExpr 对参数列表的遍历不打乱顺序，world-read 的数组打包共用同一段代码。
    const { code } = assertLowered(
      `const p = agent("p");\nconst paths = await files.glob("a");\n` +
        `const out = await p.ask<string>(paths.join(","));\nreturn out;\n`,
    );
    expect(code).toContain(`__host.worldRead("world-read#1", "glob", ["a"])`);
    expect(code).toContain(`__host.ask("ask#1", p, paths.join(","))`);
  });

  it("preserves the optional-chain short-circuit on ?.ask (identifier receiver)", () => {
    // Bug 回归：`p?.ask(x)` 原先被无条件降级成 __host.ask(siteId, p, x)，丢掉 `?.` 的短路。
    // p 为 undefined 时引擎会把 undefined 接收者判成 UnknownActor 并失败整个 run，而作者
    // 程序的语义是「跳过这次 ask，结果 undefined」。
    const { code } = assertLowered(
      `const flag = "x".length > 1;\nconst p = flag ? agent("a") : undefined;\n` +
        `const r = await p?.ask<string>("q");\nreturn r ?? "skipped";\n`,
    );
    expect(code).toContain(
      `p === null || p === undefined ? undefined : __host.ask("ask#1", p, "q")`,
    );
  });

  it("evaluates a non-identifier optional receiver exactly once via a hoisted temp", () => {
    const { code } = assertLowered(
      `const box = { p: "x".length > 1 ? agent("a") : undefined };\n` +
        `const r = await box.p?.ask<string>("q");\nreturn r ?? "skipped";\n`,
    );
    expect(code).toContain(`var _a`);
    expect(code).toContain(
      `(_a = box.p) === null || _a === undefined ? undefined : __host.ask("ask#1", _a, "q")`,
    );
  });

  it("optional-chain ask runtime semantics: nullish receiver skips the host call, args unevaluated", async () => {
    // 执行降级产物本身（AsyncFunction + stub host）钉住运行期语义：接收者为 nullish 时
    // __host.ask 不被调用、实参表达式不被求值，脚本落到 `?? "skipped"` 分支。
    const { code } = assertLowered(
      `let argEvaluated = false;\nfunction instr(): string { argEvaluated = true; return "q"; }\n` +
        `const p = "x".length > 1 ? agent("a") : undefined;\n` +
        `const wrap: { p?: Agent } = {};\n` +
        `const r1 = await p?.ask<string>(instr());\n` +
        `const r2 = await wrap.p?.ask<string>(instr());\n` +
        `return { argEvaluated, r1: r1 ?? "skipped", r2: r2 ?? "skipped" };\n`,
    );
    const askCalls: unknown[][] = [];
    const host = {
      createActor: () => "actor-handle",
      ask: (...args: unknown[]) => {
        askCalls.push(args);
        return Promise.resolve("answered");
      },
    };
    const run = new AsyncFunction(HOST_BINDING, code) as (h: unknown) => Promise<unknown>;
    // "x".length > 1 为假：p 是 undefined，wrap.p 也是 undefined —— 两个 ask 都必须短路。
    await expect(run(host)).resolves.toEqual({ argEvaluated: false, r1: "skipped", r2: "skipped" });
    expect(askCalls).toEqual([]);
  });

  it("optional-chain ask runtime semantics: a present receiver still reaches __host.ask", async () => {
    const { code } = assertLowered(
      `const p = "xy".length > 1 ? agent("a") : undefined;\n` +
        `const r = await p?.ask<string>("q");\nreturn r ?? "skipped";\n`,
    );
    const askCalls: unknown[][] = [];
    const host = {
      createActor: () => "actor-handle",
      ask: (...args: unknown[]) => {
        askCalls.push(args);
        return Promise.resolve("answered");
      },
    };
    const run = new AsyncFunction(HOST_BINDING, code) as (h: unknown) => Promise<unknown>;
    await expect(run(host)).resolves.toBe("answered");
    expect(askCalls).toEqual([["ask#1", "actor-handle", "q"]]);
  });

  it("a script with no facade calls lowers to plain stripped JS (no __host)", () => {
    const source = readFileSync(join(loweringDir, "no-facade.ts"), "utf8");
    const { code, siteIds } = assertLowered(source);
    expect(siteIds).toEqual([]);
    expect(code).not.toContain(HOST_BINDING);
  });

  it("lowers phase() markers to __host.enterPhase(name) and keeps them out of siteIds", async () => {
    // 标记无站点、无 journal 行，但控制流经过它这件事要让引擎看见（
    // docs/execution-engine.md「From script to sandbox input: lowering」）：改写成 __host.enterPhase(name)，名字去两端
    // 空白（与分析器铸造阶段 id 的键同一）。沙箱里绝不能残留自由标识符 `phase`。
    const { code, siteIds } = assertLowered(
      `phase("start");\nlog("hi");\nphase("  end  ");\nreturn 1;\n`,
    );
    expect(siteIds).toEqual([]);
    expect(code).not.toContain("void 0;");
    expect(code).not.toMatch(/(^|[^.\w])phase\s*\(/);
    const logged: string[] = [];
    const entered: string[] = [];
    const run = new AsyncFunction(HOST_BINDING, code) as (host: unknown) => Promise<unknown>;
    await expect(
      run({ log: (m: string) => logged.push(m), enterPhase: (n: string) => entered.push(n) }),
    ).resolves.toBe(1);
    expect(logged).toEqual(["hi"]);
    expect(entered).toEqual(["start", "end"]);
  });

  it("leaves siteIds byte-identical with and without markers (site-id stability)", () => {
    // site-id stability（docs/analysis.md 的 "Sites"）做成可执行
    // 断言：标记不占任何计数器，所以在一个脚本里撒满 phase() 之后，lowering 打桩的 site id
    // 清单必须逐字节不变——journal 键就是这份清单，挪一个名字就是让一次 resume 认错记录。
    const sites =
      `const a = agent("a");\n` +
      `const paths = await files.glob("*.ts");\n` +
      `const x = await a.ask<string>("go");\n` +
      `report(x);\n` +
      `return paths.length;\n`;
    const marked =
      `phase("preflight");\n` +
      `const a = agent("a");\n` +
      `const paths = await files.glob("*.ts");\n` +
      `phase("work");\n` +
      `const x = await a.ask<string>("go");\n` +
      `report(x);\n` +
      `phase("wrap-up");\n` +
      `return paths.length;\n`;
    const bare = assertLowered(sites);
    expect(bare.siteIds).toEqual(["actor#1", "world-read#1", "ask#1", "report#1"]);
    expect(assertLowered(marked).siteIds).toEqual(bare.siteIds);
  });

  it("does not lower a dirty script (typecheck error) — no output", () => {
    // `agent` 期望 string 名字，传 number 触发类型错误；lowering 只跑在干净程序上。
    const result = lowerWorkflowScript(`const a = agent(123);\nawait a.ask("x");\n`);
    expect(result.ok).toBe(false);
    expect(result.lowered).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("does not lower a facade-siting violation — no output", () => {
    // 取 ask 的引用（method extraction）破坏站点身份，facade-siting 拒绝。
    const result = lowerWorkflowScript(`const p = agent("p");\nconst f = p.ask;\nawait f("x");\n`);
    expect(result.ok).toBe(false);
    expect(result.lowered).toBeUndefined();
  });
});
