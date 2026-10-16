import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findSavedWorkflowShadowing,
  listSavedWorkflows,
  moveSavedWorkflow,
  parseSavedWorkflow,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  savedWorkflowExists,
  savedWorkflowRoots,
  serializeSavedWorkflow,
  validateWorkflowArgs,
} from "../src/tool/handlers/saved-workflows/index.js";
import type { SavedWorkflowMeta } from "@zcode/contracts";

const created: string[] = [];

function makeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwf-saved-"));
  created.push(dir);
  return dir;
}

/** 一个隔离的家目录，供全局档用例注入——绝不碰开发机真实的 `~/.zcode/workflows`。 */
function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwf-home-"));
  created.push(dir);
  return dir;
}

/** 往指定作用域根写一个保存文件，绕过 saveSavedWorkflow——读侧的用例不该依赖写侧。 */
function writeRawInRoot(dir: string, fileName: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, source, "utf8");
  return path;
}

/** 直接往项目根写一个保存文件，绕过 saveSavedWorkflow——读侧的用例不该依赖写侧。 */
function writeRaw(cwd: string, fileName: string, source: string): string {
  return writeRawInRoot(savedWorkflowRoots(cwd)[0]!.dir, fileName, source);
}

// 全局根默认取 os.homedir()。不注入 homeDir 的既有用例会扫真实家目录，那里可能真有全局
// 定义——把 HOME 指到一个空的临时目录，让「两根 first-wins」的既有断言只看到项目档。
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  const home = makeHome();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  while (created.length > 0) rmSync(created.pop()!, { force: true, recursive: true });
});

const SCRIPT = [
  "interface R { done: boolean }",
  'const r = await agent("worker").ask<R>("do it");',
  "return r.done;",
].join("\n");

describe("saved workflow frontmatter codec", () => {
  it("round-trips metadata and preserves the script byte-exactly", () => {
    const meta: SavedWorkflowMeta = {
      description: "Review a pull request",
      whenToUse: "When the user asks for a PR review",
      args: {
        pr: { type: "string", description: "PR number", required: true },
        deep: { type: "boolean", default: false },
      },
    };

    const parsed = parseSavedWorkflow(serializeSavedWorkflow(meta, SCRIPT));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta).toEqual(meta);
    expect(parsed.script).toBe(SCRIPT);
  });

  it("serializes deterministically so re-saving makes no spurious diff", () => {
    const meta: SavedWorkflowMeta = { description: "stable", whenToUse: "always" };
    expect(serializeSavedWorkflow(meta, SCRIPT)).toBe(serializeSavedWorkflow(meta, SCRIPT));
  });

  // 脚本正文是 run 的脚本哈希的基准，任何一次"顺手规范化"都会让 resume 对不上。
  it("preserves trailing newlines, blank lines and CRLF-free content verbatim", () => {
    const script = "\n\nlog('one');\n\n\nlog('two');\n";
    const parsed = parseSavedWorkflow(
      serializeSavedWorkflow({ description: "whitespace" }, script),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.script).toBe(script);
  });

  it("keeps an empty script empty", () => {
    const parsed = parseSavedWorkflow(serializeSavedWorkflow({ description: "empty" }, ""));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.script).toBe("");
  });

  it("tolerates blank lines before the sentinel", () => {
    const parsed = parseSavedWorkflow(
      `\n\n${serializeSavedWorkflow({ description: "padded" }, SCRIPT)}`,
    );
    expect(parsed.ok).toBe(true);
  });

  // 四种失败各有各的名字，因为它们要给用户不同的建议。
  it("names a missing sentinel", () => {
    const parsed = parseSavedWorkflow(SCRIPT);
    expect(parsed).toMatchObject({ ok: false, reason: "missing_frontmatter" });
  });

  it("names an unterminated block", () => {
    const parsed = parseSavedWorkflow("/* zcode-workflow\ndescription: x\n");
    expect(parsed).toMatchObject({ ok: false, reason: "unterminated_frontmatter" });
  });

  it("names a body that is not YAML", () => {
    const parsed = parseSavedWorkflow("/* zcode-workflow\n  a: [1\n bad: : :\n*/\nreturn 1;");
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_yaml" });
  });

  it("names a body that is YAML but not valid metadata", () => {
    const parsed = parseSavedWorkflow("/* zcode-workflow\nwhenToUse: no description\n*/\n");
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_metadata" });
  });

  // .strict()：拼错一个键必须被指出来，而不是被静默丢弃——这些文件是用户手改的。
  it("rejects an unknown metadata key", () => {
    const parsed = parseSavedWorkflow("/* zcode-workflow\ndescription: x\nwhenToUseIt: typo\n*/\n");
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_metadata" });
  });

  it("rejects an argument declared with an unknown type", () => {
    const parsed = parseSavedWorkflow(
      "/* zcode-workflow\ndescription: x\nargs:\n  a:\n    type: date\n*/\n",
    );
    expect(parsed).toMatchObject({ ok: false, reason: "invalid_metadata" });
  });
});

describe("saved workflow store", () => {
  it("resolves a saved workflow written through the store", () => {
    const cwd = makeCwd();
    const meta: SavedWorkflowMeta = { description: "pr review" };
    const written = saveSavedWorkflow({ cwd, name: "pr-review", meta, script: SCRIPT });

    expect(written.overwritten).toBe(false);
    expect(written.scope).toBe("project");
    expect(written.path).toBe(join(cwd, ".zcode/workflows/pr-review.dwf.ts"));

    const resolved = resolveSavedWorkflow({ cwd, name: "pr-review" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.script).toBe(SCRIPT);
    expect(resolved.meta).toEqual(meta);
    expect(resolved.scope).toBe("project");
  });

  it("reports an overwrite on the second save", () => {
    const cwd = makeCwd();
    const meta: SavedWorkflowMeta = { description: "v1" };
    saveSavedWorkflow({ cwd, name: "dup", meta, script: SCRIPT });
    const second = saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "v2" },
      script: "return 2;",
    });

    expect(second.overwritten).toBe(true);
    const resolved = resolveSavedWorkflow({ cwd, name: "dup" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.meta.description).toBe("v2");
    expect(resolved.script).toBe("return 2;");
  });

  // 名字合法性检查**就是**路径穿越的防线：拼进 join 之后就晚了。
  it.each([
    ["../evil", "traversal"],
    ["a/b", "separator"],
    ["", "empty"],
    ["..", "dot-dot"],
    ["x".repeat(65), "too long"],
    ["has space", "whitespace"],
  ])("rejects the name %j (%s) before touching the filesystem", (name) => {
    const cwd = makeCwd();
    expect(resolveSavedWorkflow({ cwd, name })).toMatchObject({
      ok: false,
      reason: "invalid_name",
    });
  });

  it("accepts a 64-character name (the boundary is inclusive)", () => {
    const cwd = makeCwd();
    const name = "n".repeat(64);
    saveSavedWorkflow({ cwd, name, meta: { description: "long" }, script: SCRIPT });
    expect(resolveSavedWorkflow({ cwd, name }).ok).toBe(true);
  });

  it("reports not_found rather than throwing when the root directory is absent", () => {
    const cwd = makeCwd();
    expect(resolveSavedWorkflow({ cwd, name: "nope" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("surfaces a malformed file as a parse error naming the path", () => {
    const cwd = makeCwd();
    const path = writeRaw(cwd, "broken.dwf.ts", "return 1;\n");
    expect(resolveSavedWorkflow({ cwd, name: "broken" })).toMatchObject({
      ok: false,
      reason: "parse_error",
      path,
    });
  });

  it("lists entries with metadata only, sorted, and without script bodies", () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "beta",
      meta: { description: "second", whenToUse: "later" },
      script: SCRIPT,
    });
    saveSavedWorkflow({
      cwd,
      name: "alpha",
      meta: { description: "first", args: { a: { type: "number" } } },
      script: SCRIPT,
    });

    const { entries, invalid } = listSavedWorkflows({ cwd });

    expect(invalid).toEqual([]);
    expect(entries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(entries[0]).toEqual({
      name: "alpha",
      description: "first",
      args: { a: { type: "number" } },
      scope: "project",
      path: join(cwd, ".zcode/workflows/alpha.dwf.ts"),
    });
    // 枚举不是读取：正文绝不进列表。
    expect(JSON.stringify(entries)).not.toContain("agent(");
  });

  it("keeps listing the good files when one is malformed", () => {
    const cwd = makeCwd();
    saveSavedWorkflow({ cwd, name: "good", meta: { description: "fine" }, script: SCRIPT });
    const badPath = writeRaw(
      cwd,
      "bad.dwf.ts",
      "/* zcode-workflow\nwhenToUse: no description\n*/\n",
    );

    const { entries, invalid } = listSavedWorkflows({ cwd });

    expect(entries.map((entry) => entry.name)).toEqual(["good"]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.path).toBe(badPath);
    expect(invalid[0]!.reason).toContain("invalid_metadata");
  });

  it("ignores files that are not .dwf.ts", () => {
    const cwd = makeCwd();
    writeRaw(cwd, "README.md", "not a workflow");
    writeRaw(cwd, "helper.ts", "export const x = 1;");
    expect(listSavedWorkflows({ cwd })).toEqual({ entries: [], invalid: [] });
  });

  it("returns an empty list when the project has never saved a workflow", () => {
    expect(listSavedWorkflows({ cwd: makeCwd() })).toEqual({ entries: [], invalid: [] });
  });

  // 根是一个**数组**，按优先级排列 `[project, global]`。这条用例钉住"按序 first-wins"的形状。
  it("looks up roots in priority order, first match winning", () => {
    const cwd = makeCwd();
    const home = makeHome();
    const roots = savedWorkflowRoots(cwd, { homeDir: home });
    expect(roots).toHaveLength(2);
    expect(roots[0]).toEqual({ scope: "project", dir: join(cwd, ".zcode/workflows") });
    expect(roots[1]).toEqual({ scope: "global", dir: join(home, ".zcode/workflows") });

    saveSavedWorkflow({ cwd, name: "shadowed", meta: { description: "project" }, script: SCRIPT });
    const resolved = resolveSavedWorkflow({ cwd, name: "shadowed" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.scope).toBe(roots[0]!.scope);
    expect(resolved.path).toBe(join(roots[0]!.dir, "shadowed.dwf.ts"));
  });
});

describe("saved workflow global scope", () => {
  it("takes the global root from the injected home dir", () => {
    const cwd = makeCwd();
    const home = makeHome();
    const written = saveSavedWorkflow({
      cwd,
      name: "research",
      meta: { description: "deep research" },
      script: SCRIPT,
      scope: "global",
      homeDir: home,
    });

    expect(written.scope).toBe("global");
    expect(written.path).toBe(join(home, ".zcode/workflows/research.dwf.ts"));

    const resolved = resolveSavedWorkflow({ cwd, name: "research", homeDir: home });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.scope).toBe("global");
    expect(resolved.script).toBe(SCRIPT);
  });

  // first-wins：同名时 undirected 解析命中项目档，全局那份被遮蔽。
  it("resolves the project copy first when both scopes carry the same name", () => {
    const cwd = makeCwd();
    const home = makeHome();
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "the project one" },
      script: SCRIPT,
    });
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "the global one" },
      script: "return 9;",
      scope: "global",
      homeDir: home,
    });

    const resolved = resolveSavedWorkflow({ cwd, name: "dup", homeDir: home });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.scope).toBe("project");
    expect(resolved.meta.description).toBe("the project one");

    // 定向到 global：跳过遮蔽，直接命中全局那份。
    const directed = resolveSavedWorkflow({ cwd, name: "dup", scope: "global", homeDir: home });
    expect(directed.ok).toBe(true);
    if (!directed.ok) return;
    expect(directed.scope).toBe("global");
    expect(directed.meta.description).toBe("the global one");
  });

  // 定向 global 解析找不到项目档：只查那一根，不回落到项目。
  it("does not fall back to the other root when a scope is given", () => {
    const cwd = makeCwd();
    const home = makeHome();
    saveSavedWorkflow({ cwd, name: "only-project", meta: { description: "p" }, script: SCRIPT });
    expect(
      resolveSavedWorkflow({ cwd, name: "only-project", scope: "global", homeDir: home }),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("hides a shadowed global entry from the undirected list but shows it when directed", () => {
    const cwd = makeCwd();
    const home = makeHome();
    saveSavedWorkflow({ cwd, name: "dup", meta: { description: "project" }, script: SCRIPT });
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "global" },
      script: "return 1;",
      scope: "global",
      homeDir: home,
    });
    saveSavedWorkflow({
      cwd,
      name: "onlyglobal",
      meta: { description: "global only" },
      script: "return 2;",
      scope: "global",
      homeDir: home,
    });

    // undirected：dup 只出项目那份，onlyglobal 出全局那份。
    const both = listSavedWorkflows({ cwd, homeDir: home });
    expect(both.entries.map((entry) => `${entry.name}:${entry.scope}`)).toEqual([
      "dup:project",
      "onlyglobal:global",
    ]);

    // 定向 global：只扫全局根，不做遮蔽——被项目档遮蔽的 dup 也在。
    const globalOnly = listSavedWorkflows({ cwd, scope: "global", homeDir: home });
    expect(globalOnly.entries.map((entry) => `${entry.name}:${entry.scope}`)).toEqual([
      "dup:global",
      "onlyglobal:global",
    ]);

    // 定向 project：只项目那份。
    const projectOnly = listSavedWorkflows({ cwd, scope: "project", homeDir: home });
    expect(projectOnly.entries.map((entry) => entry.name)).toEqual(["dup"]);
  });

  it("reports savedWorkflowExists per scope", () => {
    const cwd = makeCwd();
    const home = makeHome();
    saveSavedWorkflow({
      cwd,
      name: "g",
      meta: { description: "g" },
      script: SCRIPT,
      scope: "global",
      homeDir: home,
    });
    expect(savedWorkflowExists({ cwd, name: "g", scope: "global", homeDir: home })).toBe(true);
    expect(savedWorkflowExists({ cwd, name: "g", scope: "project", homeDir: home })).toBe(false);
    // 默认作用域是 project（向后兼容）。
    expect(savedWorkflowExists({ cwd, name: "g", homeDir: home })).toBe(false);
  });
});

describe("findSavedWorkflowShadowing", () => {
  it("flags hides_global when saving a project name a global copy already has", () => {
    const cwd = makeCwd();
    const home = makeHome();
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "global" },
      script: SCRIPT,
      scope: "global",
      homeDir: home,
    });
    expect(findSavedWorkflowShadowing({ cwd, name: "dup", scope: "project", homeDir: home })).toBe(
      "hides_global",
    );
  });

  it("flags hidden_by_project when saving a global name a project copy already has", () => {
    const cwd = makeCwd();
    const home = makeHome();
    saveSavedWorkflow({ cwd, name: "dup", meta: { description: "project" }, script: SCRIPT });
    expect(findSavedWorkflowShadowing({ cwd, name: "dup", scope: "global", homeDir: home })).toBe(
      "hidden_by_project",
    );
  });

  it("returns undefined when the other scope has no same-named file", () => {
    const cwd = makeCwd();
    const home = makeHome();
    saveSavedWorkflow({ cwd, name: "solo", meta: { description: "project" }, script: SCRIPT });
    expect(
      findSavedWorkflowShadowing({ cwd, name: "solo", scope: "project", homeDir: home }),
    ).toBeUndefined();
  });
});

// 只有全局→项目一向（docs/dynamic-workflow/launch.md「Promote to global」）：项目→全局是模型的
// 概括（「提升为全局」），不是搬文件。
describe("moveSavedWorkflow (global → project)", () => {
  it("moves a global workflow to project byte-identically and removes the source", () => {
    const cwd = makeCwd();
    const home = makeHome();
    const written = saveSavedWorkflow({
      cwd,
      name: "landing",
      meta: { description: "now repo-specific", args: { q: { type: "string" } } },
      script: SCRIPT,
      scope: "global",
      homeDir: home,
    });
    const before = readFileSync(written.path, "utf8");

    const result = moveSavedWorkflow({ cwd, name: "landing", homeDir: home });
    expect(result).toEqual({
      ok: true,
      from: written.path,
      to: join(cwd, ".zcode/workflows/landing.dwf.ts"),
    });
    if (!result.ok) return;
    // 逐字节：move 不 parse、不 reserialize。
    expect(readFileSync(result.to, "utf8")).toBe(before);
    // 源已删除。
    expect(savedWorkflowExists({ cwd, name: "landing", scope: "global", homeDir: home })).toBe(
      false,
    );
    expect(savedWorkflowExists({ cwd, name: "landing", scope: "project", homeDir: home })).toBe(
      true,
    );
  });

  it("refuses to overwrite an existing project workflow", () => {
    const cwd = makeCwd();
    const home = makeHome();
    saveSavedWorkflow({ cwd, name: "dup", meta: { description: "project" }, script: SCRIPT });
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "global" },
      script: "return 1;",
      scope: "global",
      homeDir: home,
    });

    const result = moveSavedWorkflow({ cwd, name: "dup", homeDir: home });
    expect(result).toEqual({
      ok: false,
      reason: "target_exists",
      path: join(cwd, ".zcode/workflows/dup.dwf.ts"),
    });
    // 源与目标都还在（拒绝是原子的：什么都没搬）。
    expect(savedWorkflowExists({ cwd, name: "dup", scope: "project", homeDir: home })).toBe(true);
    expect(savedWorkflowExists({ cwd, name: "dup", scope: "global", homeDir: home })).toBe(true);
  });

  it("reports not_found when the global root has no such file (a project-only file is not a source)", () => {
    const cwd = makeCwd();
    const home = makeHome();
    saveSavedWorkflow({ cwd, name: "local-only", meta: { description: "p" }, script: SCRIPT });
    expect(moveSavedWorkflow({ cwd, name: "local-only", homeDir: home })).toEqual({
      ok: false,
      reason: "not_found",
    });
    // 项目档原样不动：move 绝不把项目档当源。
    expect(savedWorkflowExists({ cwd, name: "local-only", scope: "project", homeDir: home })).toBe(
      true,
    );
  });

  it("rejects an unusable name before touching the filesystem", () => {
    const cwd = makeCwd();
    const home = makeHome();
    expect(moveSavedWorkflow({ cwd, name: "../evil", homeDir: home })).toMatchObject({
      ok: false,
      reason: "invalid_name",
    });
  });
});

describe("workflow args validation", () => {
  const declaration = {
    pr: { type: "string" as const, required: true },
    depth: { type: "number" as const, default: 3 },
    dry: { type: "boolean" as const },
    extra: { type: "json" as const },
  };

  it("applies defaults for omitted arguments", () => {
    const result = validateWorkflowArgs(declaration, { pr: "42" });
    expect(result).toEqual({ ok: true, args: { pr: "42", depth: 3 } });
  });

  it("lets an explicit value win over the default", () => {
    const result = validateWorkflowArgs(declaration, { pr: "42", depth: 9 });
    expect(result).toEqual({ ok: true, args: { pr: "42", depth: 9 } });
  });

  it("reports a missing required argument", () => {
    const result = validateWorkflowArgs(declaration, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("missing required argument 'pr'");
  });

  it("reports an unknown argument and names what is declared", () => {
    const result = validateWorkflowArgs(declaration, { pr: "1", prNumber: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("unknown argument 'prNumber'");
    expect(result.errors[0]).toContain("pr, depth, dry, extra");
  });

  it("says so plainly when the workflow declares no arguments at all", () => {
    const result = validateWorkflowArgs(undefined, { anything: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("declares no arguments");
  });

  it("accepts a call with no arguments against no declaration", () => {
    expect(validateWorkflowArgs(undefined, undefined)).toEqual({ ok: true, args: {} });
  });

  it.each([
    ["pr", 42, "a string"],
    ["depth", "3", "a finite number"],
    ["dry", "yes", "a boolean"],
  ])("reports a type mismatch on %s", (key, value, expected) => {
    const result = validateWorkflowArgs(declaration, { pr: "ok", [key]: value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain(expected);
  });

  // NaN/Infinity 过不了 JSON，放行只会把可读的错误挪进沙箱变成一个 null。
  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects the non-finite number %p", (value) => {
    const result = validateWorkflowArgs({ n: { type: "number" } }, { n: value });
    expect(result.ok).toBe(false);
  });

  it("lets json accept objects, arrays, null and primitives alike", () => {
    for (const value of [{ a: 1 }, [1, 2], null, "s", 7, true]) {
      expect(validateWorkflowArgs({ j: { type: "json" } }, { j: value })).toEqual({
        ok: true,
        args: { j: value },
      });
    }
  });

  it("collects every violation in one pass", () => {
    const result = validateWorkflowArgs(declaration, { depth: "no", nope: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(3);
  });

  // 声明成 number 却默认写成字符串，错在保存那一刻，不该等到脚本读到它才炸。
  it("type-checks the declared default through the same rule", () => {
    const result = validateWorkflowArgs({ n: { type: "number", default: "3" } }, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("default value");
  });

  it("treats an explicit undefined as omitted", () => {
    expect(validateWorkflowArgs({ a: { type: "string", default: "d" } }, { a: undefined })).toEqual(
      {
        ok: true,
        args: { a: "d" },
      },
    );
  });
});
