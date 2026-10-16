import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `@zcode/dynamic-workflow/projections` 是给作品集浏览器包用的纯投影桶
// （docs/chat/workflow-portfolio.md）：站内在冻结的 core.json 上现场重算投影，整条链不能把
// `typescript`（分析器铸造 core 时才用的编译器）拖进前端 bundle。这里不靠打包器报错来发现——
// 直接静态遍历 dist/projections.js 的 ESM import 闭包（tsc 已经擦掉了 type-only import，
// 所以 dist 里剩下的每条 `from "…"` 都是运行时依赖），断言可达文件里没有一条 import 裸
// 说明符 "typescript"。任何一次把投影模块接到 causality-order.ts 之类带编译器的模块上的
// 改动，都会在这里第一时间炸出来，并列出泄漏的文件。
//
// 依赖 dist：turbo 的 test 任务 dependsOn build；在包目录里裸跑 `pnpm test` 前请先
// `pnpm run build`，否则这里检查的是上一次构建的产物。
const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ENTRY = join(distDir, "projections.js");

/** 每条静态 import / re-export 的说明符（含 `export … from`），side-effect import 也算。 */
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function specifiersOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) out.push((match[1] ?? match[2]) as string);
  return out;
}

/** 可达的 dist 文件与其中出现的裸（非相对）说明符，按发现文件归类。 */
function walk(entry: string): { files: string[]; bare: Map<string, string[]> } {
  const files: string[] = [];
  const bare = new Map<string, string[]>();
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        queue.push(resolve(dirname(file), spec));
      } else {
        const list = bare.get(spec) ?? [];
        list.push(file);
        bare.set(spec, list);
      }
    }
  }
  return { bare, files };
}

describe("projections barrel is browser-safe", () => {
  it("dist/projections.js exists (run `pnpm run build` first)", () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  it("no reachable dist file imports typescript (or any other bare specifier)", () => {
    const { bare, files } = walk(ENTRY);
    // 桶本身加上它再导出的投影模块——闭包不能退化成只有入口文件。
    expect(files.length).toBeGreaterThan(5);
    const leaks = [...bare.entries()].map(([spec, importers]) => `${spec} <- ${importers.join(", ")}`);
    expect(leaks, "bare imports reachable from the browser barrel").toEqual([]);
    expect(bare.has("typescript")).toBe(false);
    // 反向校验：走同一套遍历，根导出必然到达 typescript——否则说明遍历本身失效。
    expect(walk(join(distDir, "index.js")).bare.has("typescript")).toBe(true);
  });

  it("does not reach the analyzer front-end modules", () => {
    const { files } = walk(ENTRY);
    const names = files.map((file) => file.slice(distDir.length + 1));
    for (const forbidden of ["analysis/causality-order.js", "analysis/analyze.js", "compiler/compile.js", "analysis/domain.js"]) {
      expect(names, `${forbidden} must not be reachable`).not.toContain(forbidden);
    }
  });
});
