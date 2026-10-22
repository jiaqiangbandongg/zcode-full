import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  addedFilesFromGit,
  checkArchitecture,
  changedFilesFromGit,
  loadPolicy,
  resolveDiffBase,
  updateBaseline,
} from "../architecture/index.mjs";
import { adoptModule } from "../architecture/adopt.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function initializeGit(cwd) {
  await git(cwd, "init");
  await git(cwd, "config", "user.name", "Architecture Test");
  await git(cwd, "config", "user.email", "architecture-test@example.invalid");
  await git(cwd, "config", "commit.gpgsign", "false");
  await git(cwd, "-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "fixture");
}

async function fixture(files, fn) {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-architecture-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = join(cwd, relative);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content);
    }
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const POLICY = `version: 1
modules:
  - id: alpha
    roots: [src/alpha]
    managed: true
    requires: [beta]
    publicEntrypoints: [src/alpha/contract.ts]
  - id: beta
    roots: [src/beta]
    managed: true
    requires: []
    publicEntrypoints: [src/beta/contract.ts]
global:
  maxFileLines: 20
  maxContractLines: 10
`;

// ---------------------------------------------------------------------------
// 2026-09 review 补测：以下场景在首版检查器上全部"0 违规"通过，属于门禁失明。
// ---------------------------------------------------------------------------

const WORKSPACE_POLICY = `version: 1
modules:
  - id: alpha
    roots: [packages/alpha/src]
    managed: true
    requires: []
    publicEntrypoints: [packages/alpha/src/contract.ts]
    layers:
      domain: domain
      ui: ui
    layerOrder: [domain, ui]
  - id: beta
    roots: [packages/beta/src]
    managed: true
    requires: []
    publicEntrypoints: [packages/beta/src/contract.ts, packages/beta/src/index.ts]
global:
  maxFileLines: 100
  maxContractLines: 20
`;

const FIVE = (id, requires = []) => ({
  [`packages/${id}/src/module.ts`]: `export const m = { id: "${id}", requires: [${requires.map((r) => `"${r}"`).join(", ")}] } as const;\n`,
  [`packages/${id}/src/contract.ts`]: "export type T = string;\n",
  [`packages/${id}/src/contract.example.ts`]: "export {};\n",
  [`packages/${id}/src/contract.test.ts`]: "export {};\n",
  [`packages/${id}/src/CONTRACT.md`]: "# c\n",
});

test("workspace package specifiers resolve through package.json exports and deep paths", async () => {
  await fixture(
    {
      "architecture-policy.yaml": WORKSPACE_POLICY,
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/alpha/package.json": '{"name":"@fixture/alpha"}\n',
      "packages/beta/package.json":
        '{"name":"@fixture/beta","exports":{".":"./src/index.ts","./contract":"./src/contract.ts"}}\n',
      ...FIVE("alpha"),
      ...FIVE("beta"),
      "packages/beta/src/index.ts": "export const beta = 1;\n",
      "packages/beta/src/internal.ts": "export const secret = 1;\n",
      // 首版只解析 ./ ../，下面三种导入全部不建边：
      "packages/alpha/src/ui/a.ts":
        'import { beta } from "@fixture/beta";\nimport { secret } from "@fixture/beta/src/internal.js";\nimport type { T } from "@fixture/beta/contract";\nexport const x = [beta, secret] as T[];\n',
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd });
      const byRule = (rule) => result.violations.filter((v) => v.rule === rule);
      // 三条导入都是跨模块且未在 requires 声明
      assert.equal(byRule("module-dependency").length, 3, JSON.stringify(result.violations));
      // 只有 src/internal.js 不是公开入口
      assert.equal(byRule("deep-import").length, 1);
      assert.match(byRule("deep-import")[0].detail, /internal\.ts$/);
    },
  );
});

test("tsconfig paths and package imports aliases resolve inside a module", async () => {
  await fixture(
    {
      "architecture-policy.yaml": WORKSPACE_POLICY,
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      // glob 中的 /* 与后续 */ 是字符串内容，不能当作块注释清理。
      "packages/alpha/package.json":
        '{"name":"@fixture/alpha","imports":{"#src/*":"./src/*"},"scripts":{"dev":"watch .cache-*/**"}}\n',
      "packages/alpha/tsconfig.json":
        '{\n  /* 真正的注释 */\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], },\n  }, // 行尾注释\n  "include": ["src/**/*.ts", "src/**/*.tsx"],\n}\n',
      ...FIVE("alpha"),
      "packages/beta/package.json": '{"name":"@fixture/beta"}\n',
      ...FIVE("beta"),
      "packages/alpha/src/ui/view.ts": "export const view = 1;\n",
      // domain 通过两种别名依赖更高的 ui 层：首版因为不建边而漏报 layer-direction
      "packages/alpha/src/domain/rule.ts":
        'import { view } from "@/ui/view.js";\nimport "#src/ui/view.js";\nexport const rule = view;\n',
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd });
      assert.equal(result.violations.filter((v) => v.rule === "layer-direction").length, 2);
    },
  );
});

test("conditional dist exports map back to src and type-only node imports are not domain IO", async () => {
  await fixture(
    {
      "architecture-policy.yaml": WORKSPACE_POLICY.replace(
        "requires: []\n    publicEntrypoints: [packages/alpha",
        "requires: [beta]\n    publicEntrypoints: [packages/alpha",
      ),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/alpha/package.json": '{"name":"@fixture/alpha"}\n',
      "packages/beta/package.json":
        '{"name":"@fixture/beta","exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js"}}}\n',
      ...FIVE("alpha", ["beta"]),
      ...FIVE("beta"),
      "packages/beta/src/index.ts": "export const beta = 1;\n",
      "packages/alpha/src/domain/pure.ts":
        'import type { Stats } from "node:fs";\nimport { beta } from "@fixture/beta";\nexport const pure = (s: Stats) => s.size + beta;\n',
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd });
      assert.equal(result.violations.filter((v) => v.rule === "domain-io").length, 0);
      // dist/index.js → src/index.ts 建边成功，但 index.ts 是公开入口，不算 deep-import
      assert.equal(result.violations.filter((v) => v.rule === "deep-import").length, 0);
      assert.equal(result.violations.filter((v) => v.rule === "module-dependency").length, 0);
    },
  );
});

test("ui layer of any managed module cannot import service or repo implementations", async () => {
  await fixture(
    {
      "architecture-policy.yaml": WORKSPACE_POLICY.replace(
        "requires: []\n    publicEntrypoints: [packages/alpha",
        "requires: [beta]\n    publicEntrypoints: [packages/alpha",
      ),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/alpha/package.json": '{"name":"@fixture/alpha"}\n',
      "packages/beta/package.json": '{"name":"@fixture/beta"}\n',
      ...FIVE("alpha", ["beta"]),
      ...FIVE("beta"),
      "packages/beta/src/services/botsService.ts": "export const svc = 1;\n",
      "packages/alpha/src/ui/panel.ts":
        'import { svc } from "@fixture/beta/src/services/botsService.js";\nexport const panel = svc;\n',
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd });
      assert.ok(result.violations.some((v) => v.rule === "ui-implementation-import"));
    },
  );
});

test("new source files outside managed modules are blocked; tests and managed files pass", async () => {
  const policy = `version: 1
modules:
  - id: legacy
    roots: [packages/legacy/src]
    managed: false
  - id: alpha
    roots: [packages/alpha/src]
    managed: true
    requires: []
    publicEntrypoints: [packages/alpha/src/contract.ts]
`;
  await fixture(
    {
      "architecture-policy.yaml": policy,
      ...FIVE("alpha"),
      "packages/legacy/src/old.ts": "export const old = 1;\n",
    },
    async (cwd) => {
      const added = [
        "packages/legacy/src/brandNew.ts",
        "packages/legacy/src/brandNew.test.ts",
        "packages/unregistered/src/orphan.ts",
        "packages/alpha/src/fine.ts",
        "scripts/tool.mjs",
      ];
      for (const file of added) {
        await mkdir(join(cwd, file, ".."), { recursive: true });
        await writeFile(join(cwd, file), "export {};\n");
      }
      const result = await checkArchitecture({ cwd, changedFiles: added, addedFiles: added });
      const flagged = result.newViolations
        .filter((v) => v.rule === "unmanaged-new-file")
        .map((v) => v.file)
        .sort();
      assert.deepEqual(flagged, [
        "packages/legacy/src/brandNew.ts",
        "packages/unregistered/src/orphan.ts",
      ]);
      assert.match(
        result.newViolations.find((v) => v.rule === "unmanaged-new-file").message,
        /architecture:adopt/,
      );
    },
  );
});

test("module.ts requires must agree with policy and reference known modules", async () => {
  await fixture(
    {
      "architecture-policy.yaml": WORKSPACE_POLICY,
      ...FIVE("alpha"),
      ...FIVE("beta"),
      "packages/alpha/src/module.ts":
        'export const m = { id: "alpha", requires: ["beta", "gamma"] } as const;\n',
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd });
      const mismatch = result.violations.filter((v) => v.rule === "manifest-policy-mismatch");
      assert.equal(mismatch.length, 1);
      assert.match(mismatch[0].message, /beta/);
      assert.match(mismatch[0].message, /gamma/);
    },
  );
});

test("scoped baseline update keeps entries outside the changed closure", async () => {
  await fixture(
    {
      "architecture-policy.yaml": POLICY,
      "src/alpha/contract.ts": "export type Alpha = string;\n",
      "src/alpha/one.ts": 'import "../beta/internal.js";\n',
      "src/alpha/two.ts": 'import "../beta/internal.js";\n',
      "src/beta/contract.ts": "export type Beta = string;\n",
      "src/beta/internal.ts": "export const value = 1;\n",
    },
    async (cwd) => {
      const full = await checkArchitecture({ cwd });
      await updateBaseline({ cwd, violations: full.violations });
      const before = JSON.parse(await readFile(join(cwd, ".architecture-baseline.json"), "utf8"));
      const scoped = await checkArchitecture({ cwd, changedFiles: ["src/alpha/one.ts"] });
      // 首版 bug：带 --changed 更新 baseline 会用 scoped 结果覆盖全部条目
      await updateBaseline({ cwd, violations: scoped.violations, scope: scoped.changedClosure });
      const after = JSON.parse(await readFile(join(cwd, ".architecture-baseline.json"), "utf8"));
      assert.equal(after.violations.length, before.violations.length);
    },
  );
});

test("diff base prefers explicit, then CI, then pre-push stdin, then default branch merge-base", async () => {
  await fixture({ "a.ts": "export {};\n" }, async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, "add", "a.ts");
    await git(cwd, "-c", "core.hooksPath=", "commit", "-m", "base");
    const baseSha = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
    await git(cwd, "branch", "-M", "main");
    await git(cwd, "checkout", "-b", "feature");
    await writeFile(join(cwd, "b.ts"), "export {};\n");
    await git(cwd, "add", "b.ts");
    await git(cwd, "-c", "core.hooksPath=", "commit", "-m", "feature");
    const headSha = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
    // 模拟远端默认分支
    await git(cwd, "update-ref", "refs/remotes/origin/main", baseSha);
    await git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const pick = (env, explicit) => resolveDiffBase(cwd, { explicit, env });
    assert.equal((await pick({}, baseSha)).base, baseSha);
    assert.equal((await pick({ CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha })).base, baseSha);
    const stdin = `refs/heads/feature ${headSha} refs/heads/feature ${baseSha}\n`;
    assert.equal((await pick({ ZCODE_PRE_PUSH_STDIN: stdin })).base, baseSha);
    const fallback = await pick({});
    assert.equal(fallback.base, baseSha);
    assert.match(fallback.label, /merge-base/);

    // 干净工作树下：首版 `git diff HEAD` 为空，新实现要拿到已提交的新增文件
    const added = await addedFilesFromGit(cwd, { base: baseSha });
    assert.deepEqual(added, ["b.ts"]);
    assert.deepEqual(await changedFilesFromGit(cwd, { base: baseSha }), ["b.ts"]);
  });
});

test("adopt scaffolds the five artifacts, registers the module and infers requires", async () => {
  await fixture(
    {
      "architecture-policy.yaml": `version: 1\n# 顶部注释要保留\nmodules:\n  - id: beta\n    roots: [packages/beta/src]\n    managed: true\n    requires: []\n    publicEntrypoints: [packages/beta/src/contract.ts]\nglobal:\n  maxFileLines: 400\n`,
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/beta/package.json": '{"name":"@fixture/beta"}\n',
      ...FIVE("beta"),
      "packages/alpha/package.json": '{"name":"@fixture/alpha"}\n',
      "packages/alpha/src/index.ts": 'import "@fixture/beta/contract";\nexport const a = 1;\n',
    },
    async (cwd) => {
      const summary = await adoptModule({
        cwd,
        id: "alpha",
        roots: ["packages/alpha/src"],
        layer: "adapters",
        owner: "test",
      });
      assert.deepEqual(summary.requires, ["beta"]);
      for (const file of [
        "module.ts",
        "contract.ts",
        "contract.example.ts",
        "contract.test.ts",
        "CONTRACT.md",
      ]) {
        await readFile(join(cwd, "packages/alpha/src", file), "utf8");
      }
      const yaml = await readFile(join(cwd, "architecture-policy.yaml"), "utf8");
      assert.match(yaml, /# 顶部注释要保留/);
      const policy = await loadPolicy(cwd);
      const alpha = policy.modules.find((m) => m.id === "alpha");
      assert.ok(alpha?.managed);
      assert.deepEqual(alpha.requires, ["beta"]);
      // 幂等：再跑一次不报错、不重复登记
      await adoptModule({ cwd, id: "alpha", roots: ["packages/alpha/src"], layer: "adapters" });
      assert.equal((await loadPolicy(cwd)).modules.filter((m) => m.id === "alpha").length, 1);
      const result = await checkArchitecture({ cwd });
      assert.equal(result.violations.filter((v) => v.rule === "missing-module-artifact").length, 0);
    },
  );
});

test("context package inlines CONTRACT.md and dependency contracts instead of listing file names", async () => {
  const { generateContext } = await import("../architecture/index.mjs");
  await fixture(
    {
      "architecture-policy.yaml": WORKSPACE_POLICY.replace(
        "requires: []\n    publicEntrypoints: [packages/alpha",
        "requires: [beta]\n    publicEntrypoints: [packages/alpha",
      ),
      ...FIVE("alpha", ["beta"]),
      ...FIVE("beta"),
      "packages/alpha/src/CONTRACT.md": "# alpha\n\n不变量：只此一处。\n",
      "packages/beta/src/contract.ts": "export interface BetaPort { ping(): Promise<void>; }\n",
    },
    async (cwd) => {
      const text = await generateContext({ cwd, moduleId: "alpha" });
      assert.match(text, /不变量：只此一处/);
      assert.match(text, /export interface BetaPort/);
      assert.match(text, /layers: domain < ui/);
    },
  );
});

test("newFilesEnforcedSince grandfathers files first committed before the date; untracked always count", async () => {
  await fixture({ "a.ts": "export {};\n" }, async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, "add", "a.ts");
    await git(cwd, "-c", "core.hooksPath=", "commit", "-m", "base");
    const base = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
    const oldDate = "2020-01-01T00:00:00Z";
    await writeFile(join(cwd, "old.ts"), "export {};\n");
    await git(cwd, "add", "old.ts");
    await execFileAsync("git", ["-c", "core.hooksPath=", "commit", "-m", "old file"], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate },
    });
    await writeFile(join(cwd, "fresh.ts"), "export {};\n");
    await git(cwd, "add", "fresh.ts");
    await git(cwd, "-c", "core.hooksPath=", "commit", "-m", "fresh file");
    await writeFile(join(cwd, "untracked.ts"), "export {};\n");

    assert.deepEqual((await addedFilesFromGit(cwd, { base })).sort(), [
      "fresh.ts",
      "old.ts",
      "untracked.ts",
    ]);
    assert.deepEqual((await addedFilesFromGit(cwd, { base, since: "2025-01-01" })).sort(), [
      "fresh.ts",
      "untracked.ts",
    ]);
  });
});
