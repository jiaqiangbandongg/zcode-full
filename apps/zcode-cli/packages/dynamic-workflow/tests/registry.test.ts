import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createWorkflowProgram } from "../src/compiler/compile.js";
import { collectSites } from "../src/analysis/sites.js";
import {
  facadeMemberOf,
  isSiteProducing,
  SITE_MEMBER_NAMES,
  siteProducingFunctionOfSymbol,
  WORLD_READ_REGISTRY,
  worldReadOp,
  worldReadOpOfSymbol,
} from "../src/facade/registry.js";

/**
 * world-read 注册表：(facade 容器, 成员) → op 的唯一真源（docs/execution-engine.md 的
 * "The world-read registry"）。这里钉住的核心性质是**身份按声明容器判定，不按裸名字**——
 * `git.log` 与顶层 `log()` 撞名，这是下一步加 `git.*` 时唯一会伤人的地方。
 */

/** 编译一份脚本，返回一个"按名字找到该标识符/属性名节点的 symbol"的查询器。 */
function symbols(scriptText: string): (name: string) => ts.Symbol | undefined {
  const { program, scriptFile } = createWorkflowProgram(scriptText);
  const checker = program.getTypeChecker();
  const found = new Map<string, ts.Symbol>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined && !found.has(node.text)) found.set(node.text, symbol);
    }
    ts.forEachChild(node, walk);
  };
  walk(scriptFile);
  return (name) => found.get(name);
}

describe("world-read registry — pure lookup", () => {
  it("keys on (container, member), so a bare member name never resolves alone", () => {
    expect(worldReadOp("files", "glob")).toBe("glob");
    expect(worldReadOp("files", "read")).toBe("read");
    expect(worldReadOp("files", "grep")).toBe("grep");
    expect(worldReadOp("git", "changedFiles")).toBe("git-changed-files");
    expect(worldReadOp("git", "diff")).toBe("git-diff");
    expect(worldReadOp("git", "status")).toBe("git-status");
    expect(worldReadOp("git", "log")).toBe("git-log");
    // 无容器（顶层函数）永不命中：world-read 一律挂在 facade 容器对象上。
    expect(worldReadOp(undefined, "glob")).toBeUndefined();
    // 同名成员挂在别的容器上就不是同一个 op —— 这正是 `git.log` vs 顶层 `log()` 的形状。
    expect(worldReadOp("git", "glob")).toBeUndefined();
    expect(worldReadOp("files", "log")).toBeUndefined();
    expect(worldReadOp("files", "nope")).toBeUndefined();
  });

  it("gives every op a distinct name and every member a distinct one too", () => {
    // op 名唯一：它是 journal 的 inputHash 与 Boundary A 的线上词汇表。
    const ops = WORLD_READ_REGISTRY.map((row) => row.op);
    expect(new Set(ops).size).toBe(ops.length);
    // 成员名跨容器唯一：facade-misuse 的 retyping 关卡按裸名字反查候选，只为把名字填进
    // 诊断文案。重名不会让判定出错，但会让文案引出的名字二义（见 facade-misuse 的
    // facadeSiteMember 注释）。破坏它就得把容器也穿进那一层。
    const members = WORLD_READ_REGISTRY.map((row) => row.member);
    expect(new Set(members).size).toBe(members.length);
  });

  it("derives the site-producing member set from the table (plus ask)", () => {
    for (const row of WORLD_READ_REGISTRY) {
      expect(SITE_MEMBER_NAMES.has(row.member)).toBe(true);
      // 每一行的 op 都能被 (容器, 成员) 反查出来 —— 表就是唯一真源。
      expect(worldReadOp(row.container, row.member)).toBe(row.op);
    }
    expect(SITE_MEMBER_NAMES.has("ask")).toBe(true);
    // `"log"` **在**这个集合里，因为 `git.log` 在表里——而顶层 `log()` 依然不产生站点。
    // 这一条就是这份裸名字清单只能当候选键、绝不能当身份依据的证明。
    expect(SITE_MEMBER_NAMES.has("log")).toBe(true);
    expect(isSiteProducing(undefined, "log")).toBe(false);
  });

  it("treats report as a site-producing top-level function and log as not", () => {
    // report 与 log 都是**顶层无容器**的 facade 函数，分野只有一条：report 有一行按站点
    // 建键的 journal，所以 facade-siting 规则（只许直接调用）必须约束它。
    expect(isSiteProducing(undefined, "report")).toBe(true);
    expect(isSiteProducing(undefined, "log")).toBe(false);
    expect(siteProducingFunctionOfSymbol(undefined)).toBeUndefined();
    // report 不是 world-read，也不是任何容器的成员——不该出现在那两张表里。
    expect(worldReadOp(undefined, "report")).toBeUndefined();
    expect(SITE_MEMBER_NAMES.has("report")).toBe(false);
  });

  it("treats agent/Agent.ask as site-producing and log as not", () => {
    expect(isSiteProducing(undefined, "agent")).toBe(true);
    expect(isSiteProducing("Agent", "ask")).toBe(true);
    expect(isSiteProducing("files", "glob")).toBe(true);
    expect(isSiteProducing("files", "grep")).toBe(true);
    expect(isSiteProducing("git", "log")).toBe(true);
    expect(isSiteProducing(undefined, "log")).toBe(false);
    // 关键防线：一个**没有容器**的 `log` 不产生站点。`git.log` 已经落地，所以这一条正在
    // 现役地阻止"每条进度消息都铸出一个 world-read 站点"。
    expect(worldReadOp(undefined, "log")).toBeUndefined();
  });
});

describe("world-read registry — declaration-based resolution", () => {
  const lookup = symbols(
    `const paths = await files.glob("src/**");\n` +
      `const body = await files.read(paths[0] ?? "x");\n` +
      `log(body);\n` +
      `const out = await agent("a").ask<string>("go");\n` +
      `return out;\n`,
  );

  it("resolves a facade member's declaring container from its declaration", () => {
    expect(facadeMemberOf(lookup("glob"))).toEqual({ container: "files", member: "glob" });
    expect(facadeMemberOf(lookup("read"))).toEqual({ container: "files", member: "read" });
    // `ask` 声明在 `declare interface Agent` 里 → 容器是 Agent（接口容器）。
    expect(facadeMemberOf(lookup("ask"))).toEqual({ container: "Agent", member: "ask" });
    // 顶层 facade 函数无容器 —— 这就是 `git.log` 不会与它相撞的原因。
    expect(facadeMemberOf(lookup("log"))).toEqual({ container: undefined, member: "log" });
    expect(facadeMemberOf(lookup("agent"))).toEqual({ container: undefined, member: "agent" });
  });

  it("resolves the two bare site-producing functions and rejects log", () => {
    const fns = symbols(
      `report({ a: 1 });\nlog("x");\nconst out = await agent("a").ask<string>("go");\nreturn out;\n`,
    );
    expect(siteProducingFunctionOfSymbol(fns("report"))).toBe("report");
    expect(siteProducingFunctionOfSymbol(fns("agent"))).toBe("agent");
    expect(siteProducingFunctionOfSymbol(fns("log"))).toBeUndefined();
    // 容器成员走另一条路（worldReadOp / ASK_MEMBER），不该从这个入口命中。
    expect(siteProducingFunctionOfSymbol(fns("ask"))).toBeUndefined();
  });

  it("does not resolve a script-local function named report", () => {
    const local = symbols(
      `const report = (item: unknown): void => { void item; };\nreport({ a: 1 });\nreturn 1;\n`,
    );
    expect(siteProducingFunctionOfSymbol(local("report"))).toBeUndefined();
    expect(facadeMemberOf(local("report"))).toBeUndefined();
  });

  it("maps only facade-declared members to ops", () => {
    expect(worldReadOpOfSymbol(lookup("glob"))).toBe("glob");
    expect(worldReadOpOfSymbol(lookup("read"))).toBe("read");
    expect(worldReadOpOfSymbol(lookup("log"))).toBeUndefined();
    expect(worldReadOpOfSymbol(lookup("ask"))).toBeUndefined();
    expect(worldReadOpOfSymbol(undefined)).toBeUndefined();
  });

  it("resolves the two `log` declarations to different identities in one script", () => {
    // 同一份脚本里两个 `log`：`git.log` 的容器是 git（→ "git-log" op），顶层 `log` 无容器
    // （→ 不是 world-read）。symbols() 的查询器按名字取**首次**出现的 symbol，所以两侧要
    // 分开取：先只放顶层 log，再只放 git.log。
    const topLevel = symbols(`log("progress");\nreturn 1;\n`);
    expect(facadeMemberOf(topLevel("log"))).toEqual({ container: undefined, member: "log" });
    expect(worldReadOpOfSymbol(topLevel("log"))).toBeUndefined();

    const gitLog = symbols(`const c = await git.log(3);\nreturn c.length;\n`);
    expect(facadeMemberOf(gitLog("log"))).toEqual({ container: "git", member: "log" });
    expect(worldReadOpOfSymbol(gitLog("log"))).toBe("git-log");
  });

  it("resolves the whole git container and files.grep from declarations", () => {
    const git = symbols(
      `const changed = await git.changedFiles();\n` +
        `const d = await git.diff("HEAD");\n` +
        `const s = await git.status();\n` +
        `const hits = await files.grep("TODO", "*.ts");\n` +
        `return [changed.length, d.length, s.clean, hits.length];\n`,
    );
    expect(worldReadOpOfSymbol(git("changedFiles"))).toBe("git-changed-files");
    expect(worldReadOpOfSymbol(git("diff"))).toBe("git-diff");
    expect(worldReadOpOfSymbol(git("status"))).toBe("git-status");
    expect(worldReadOpOfSymbol(git("grep"))).toBe("grep");
    expect(facadeMemberOf(git("grep"))).toEqual({ container: "files", member: "grep" });
  });

  it("does not resolve a script-local object whose members merely share the names", () => {
    const local = symbols(
      `const fake = { glob(p: string): string[] { return [p]; }, read(p: string): string { return p; } };\n` +
        `const out = fake.glob("x").join(fake.read("y"));\n` +
        `return out;\n`,
    );
    expect(facadeMemberOf(local("glob"))).toBeUndefined();
    expect(worldReadOpOfSymbol(local("glob"))).toBeUndefined();
    expect(worldReadOpOfSymbol(local("read"))).toBeUndefined();
  });

  it("does not resolve a script-local `git`-shaped object (shadowing the facade)", () => {
    // 一个自建的 `myGit.status()`：名字与容器形状都对得上，但声明不在 facade .d.ts 里。
    const local = symbols(
      `const myGit = { status(): string { return "clean"; }, log(n: number): number { return n; } };\n` +
        `return myGit.status() + String(myGit.log(1));\n`,
    );
    expect(worldReadOpOfSymbol(local("status"))).toBeUndefined();
    expect(worldReadOpOfSymbol(local("log"))).toBeUndefined();
  });
});

describe("world-read registry — site collection uses it", () => {
  it("sites facade world reads with the registry op, not the member name", () => {
    const table = collectSites(
      createWorkflowProgram(
        `const paths = await files.glob("src/**");\n` +
          `const body = await files.read(paths[0] ?? "x");\n` +
          `return body;\n`,
      ),
    );
    expect(table.worldReads.map((site) => site.op)).toEqual(["glob", "read"]);
    expect(table.worldReads.map((site) => site.id)).toEqual(["world-read#1", "world-read#2"]);
    // 实参按位置收集（多参 op 的接缝；1 参 op 就是单元素数组）。
    expect(table.worldReads[0]?.args).toHaveLength(1);
  });

  it("sites every new op on one shared world-read counter, args packed positionally", () => {
    const table = collectSites(
      createWorkflowProgram(
        `const hits = await files.grep("TODO", "*.ts");\n` +
          `const changed = await git.changedFiles();\n` +
          `const d = await git.diff("main", "src/a.ts");\n` +
          `const s = await git.status();\n` +
          `const c = await git.log(5);\n` +
          `return [hits.length, changed.length, d.length, s.clean, c.length];\n`,
      ),
    );
    expect(table.worldReads.map((site) => site.op)).toEqual([
      "grep",
      "git-changed-files",
      "git-diff",
      "git-status",
      "git-log",
    ]);
    // 一个**共享的** per-kind 计数器（`world-read#N` 带 op 字段），不是 `grep#N`/`git-log#N`。
    expect(table.worldReads.map((site) => site.id)).toEqual([
      "world-read#1",
      "world-read#2",
      "world-read#3",
      "world-read#4",
      "world-read#5",
    ]);
    // 元数按位置原样收集：可选实参缺席就是更短的数组（journal 键因此可区分）。
    expect(table.worldReads.map((site) => site.args.length)).toEqual([2, 0, 2, 0, 1]);
  });

  it("mints no world-read site for a same-named script-local method", () => {
    const table = collectSites(
      createWorkflowProgram(
        `const fake = { glob(p: string): string[] { return [p]; } };\n` +
          `const out = fake.glob("x");\n` +
          `return out.length;\n`,
      ),
    );
    expect(table.worldReads).toEqual([]);
  });

  it("mints a site for git.log and none for the top-level log, in one script", () => {
    // 这是注册表按容器建键的可执行证明。裸名字集合的两种下场都会在这里露出来：
    // 要么 `log("progress")` 也被铸成 world-read 站点（站点数 2），要么 `git.log` 一个站点
    // 都没有（站点数 0）——而没有站点的 facade 调用就没有 journal 键。
    const table = collectSites(
      createWorkflowProgram(
        `log("progress");\n` +
          `const c = await git.log(3);\n` +
          `log("done");\n` +
          `const out = await agent("a").ask<string>(String(c.length));\n` +
          `return out;\n`,
      ),
    );
    expect(table.worldReads).toHaveLength(1);
    expect(table.worldReads[0]?.op).toBe("git-log");
    expect(table.worldReads[0]?.id).toBe("world-read#1");
    expect(table.asks).toHaveLength(1);
  });

  it("mints no world-read site for the top-level log alone", () => {
    const table = collectSites(
      createWorkflowProgram(
        `log("progress");\nconst out = await agent("a").ask<string>("go");\nreturn out;\n`,
      ),
    );
    expect(table.worldReads).toEqual([]);
    expect(table.asks).toHaveLength(1);
  });
});
