import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  changedFilesFromGit,
  checkArchitecture,
  loadPolicy,
  updateBaseline,
} from "../architecture/index.mjs";

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

const POLICY_UNDECLARED = POLICY.replace("requires: [beta]", "requires: []");

test("managed module documents satisfy artifacts without being checked as source", async () => {
  const files = { "architecture-policy.yaml": POLICY };
  for (const module of ["alpha", "beta"]) {
    for (const name of ["module.ts", "contract.ts", "contract.example.ts", "contract.test.ts"]) {
      files[`src/${module}/${name}`] = "export {};\n";
    }
    // 文档示例故意超过源码行数限制且含 import；它们不是可执行的跨模块依赖。
    files[`src/${module}/CONTRACT.md`] = 'import "../beta/internal.js";\n'.repeat(30);
  }
  await fixture(files, async (cwd) => {
    assert.deepEqual((await checkArchitecture({ cwd })).violations, []);
    await rm(join(cwd, "src/alpha/CONTRACT.md"));
    const missing = (await checkArchitecture({ cwd })).violations;
    assert.equal(missing.length, 1);
    assert.equal(missing[0].rule, "missing-module-artifact");
    assert.equal(missing[0].module, "alpha");
    assert.equal(missing[0].detail, "CONTRACT.md");
  });
});

test("repository policy discovers both refactored provider modules", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const policy = await loadPolicy(root);
  for (const id of ["provider", "provider-node"]) {
    // 新门禁若沿用旧仓库目录，会漏掉重构后的模块，使 context 无法找到其源码。
    const module = policy.modules.find((item) => item.id === id);
    assert.ok(module, `missing module: ${id}`);
    assert.deepEqual(module.roots, [join(root, "packages", id, "src")]);
  }
});

test("changed files exclude CI caches but retain tracked and untracked source paths", async () => {
  const ignore = await readFile(new URL("../../.gitignore", import.meta.url), "utf8");
  await fixture({ ".gitignore": ignore, "tracked.ts": "before" }, async (cwd) => {
    await initializeGit(cwd);
    await git(cwd, "add", ".gitignore", "tracked.ts");
    await git(cwd, "-c", "core.hooksPath=", "commit", "-m", "tracked files");
    await writeFile(join(cwd, "tracked.ts"), "after");
    const paths = [" 新文件 name.ts", "staged.ts"];
    if (process.platform !== "win32") paths.push('line\nbreak".ts');
    for (const file of paths) await writeFile(join(cwd, file), "export {};\n");
    await git(cwd, "add", "staged.ts");
    for (const cache of [
      ".electron-builder-cache",
      ".electron-cache",
      ".pnpm-store",
      ".npm-cache",
    ]) {
      await mkdir(join(cwd, cache));
      await writeFile(join(cwd, cache, "cached.ts"), "export {};\n");
    }
    assert.deepEqual((await changedFilesFromGit(cwd)).sort(), ["tracked.ts", ...paths].sort());
  });
});

test("changed files support Git output larger than 1 MiB for untracked and tracked files", async () => {
  await fixture({}, async (cwd) => {
    await initializeGit(cwd);
    await mkdir(join(cwd, "src"));
    const paths = Array.from(
      { length: 8192 },
      (_, i) => `src/${String(i).padStart(5, "0")}-${"x".repeat(120)}.ts`,
    );
    assert.ok(Buffer.byteLength(paths.join("\0")) > 1024 * 1024);
    // 真 Git 输出跨过原缓冲区上限；不能用忽略缓存或截断列表假装修复。
    for (let offset = 0; offset < paths.length; offset += 100) {
      await Promise.all(
        paths.slice(offset, offset + 100).map((file) => writeFile(join(cwd, file), "")),
      );
    }
    assert.deepEqual((await changedFilesFromGit(cwd)).sort(), paths);
    await git(cwd, "add", "src");
    await git(cwd, "-c", "core.hooksPath=", "commit", "--quiet", "-m", "large tracked tree");
    await rm(join(cwd, "src"), { recursive: true });
    assert.deepEqual((await changedFilesFromGit(cwd)).sort(), paths);
  });
});

test("Git enumeration failures reject instead of reporting an empty changed set", async () => {
  await fixture({}, async (cwd) => {
    await assert.rejects(changedFilesFromGit(cwd), /git/i);
  });
});

test("policy loader validates modules and global thresholds", async () => {
  await fixture({ "architecture-policy.yaml": POLICY }, async (cwd) => {
    const policy = await loadPolicy(cwd);
    assert.equal(policy.version, 1);
    assert.equal(policy.modules.length, 2);
    assert.equal(policy.global.maxFileLines, 20);
  });
});

test("undeclared cross-module import is reported", async () => {
  await fixture(
    {
      "architecture-policy.yaml": POLICY_UNDECLARED,
      "src/alpha/contract.ts": "export type Alpha = string;\n",
      "src/alpha/index.ts": 'import { beta } from "../beta/index.js";\nexport { beta };\n',
      "src/beta/contract.ts": "export const beta = 1;\n",
      "src/beta/index.ts": "export const beta = 1;\n",
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd });
      assert.ok(result.violations.some((v) => v.rule === "module-dependency"));
    },
  );
});

test("deep import and cycle are reported with stable fingerprints", async () => {
  await fixture(
    {
      "architecture-policy.yaml": POLICY,
      "src/alpha/contract.ts": "export type Alpha = string;\n",
      "src/alpha/a.ts": 'import "../beta/internal.js";\n',
      "src/alpha/b.ts": 'import "./a.js";\n',
      "src/beta/contract.ts": "export type Beta = string;\n",
      "src/beta/internal.ts": 'import "../alpha/b.js";\n',
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd });
      const rules = new Set(result.violations.map((v) => v.rule));
      assert.ok(rules.has("deep-import"));
      assert.ok(rules.has("cycle"));
      for (const violation of result.violations) {
        assert.match(violation.fingerprint, /^[a-f0-9]{16}$/);
      }
    },
  );
});

test("baseline suppresses existing violations but rejects new ones", async () => {
  await fixture(
    {
      "architecture-policy.yaml": POLICY,
      "src/alpha/contract.ts": "export type Alpha = string;\n",
      "src/alpha/index.ts": 'import "../beta/internal.js";\n',
      "src/beta/contract.ts": "export type Beta = string;\n",
      "src/beta/internal.ts": "export const value = 1;\n",
    },
    async (cwd) => {
      const initial = await checkArchitecture({ cwd });
      await updateBaseline({ cwd, violations: initial.violations });
      const baseline = JSON.parse(await readFile(join(cwd, ".architecture-baseline.json"), "utf8"));
      assert.equal(baseline.violations.length, initial.violations.length);

      await writeFile(join(cwd, "src/alpha/new.ts"), 'import "../beta/internal.js";\n');
      const changed = await checkArchitecture({ cwd, changedFiles: ["src/alpha/new.ts"] });
      assert.ok(changed.newViolations.length >= 1);
      assert.equal(changed.baselineViolations.length, 0);
    },
  );
});

test("managed modules require contract artifacts and enforce layer and domain boundaries", async () => {
  const policy = `version: 1
modules:
  - id: alpha
    roots: [src/alpha]
    managed: true
    layers:
      contract: contract
      domain: domain
      ui: ui
    layerOrder: [contract, domain, ui]
    publicEntrypoints: [contract.ts]
global:
  maxFileLines: 100
  maxContractLines: 20
`;
  await fixture(
    {
      "architecture-policy.yaml": policy,
      "src/alpha/module.ts": "export const alphaModule = { id: 'alpha' } as const;\n",
      "src/alpha/contract.ts": "export type Alpha = string;\n",
      "src/alpha/domain/value.ts":
        "import { readFile } from 'node:fs';\nimport '../ui/view.js';\nexport const value = readFile;\n",
      "src/alpha/ui/view.ts": "import '../domain/value.js';\n",
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd });
      const rules = new Set(result.violations.map((v) => v.rule));
      assert.ok(rules.has("missing-module-artifact"));
      assert.ok(rules.has("domain-io"));
      assert.ok(rules.has("layer-direction"));
    },
  );
});

test("relative public entrypoints resolve from a module root", async () => {
  await fixture(
    {
      "architecture-policy.yaml": POLICY,
      "src/alpha/contract.ts": "export type Alpha = string;\n",
      "src/alpha/index.ts": 'import { beta } from "../beta/contract.js";\nexport { beta };\n',
      "src/beta/contract.ts": "export const beta = 1;\n",
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd });
      assert.equal(result.violations.filter((v) => v.rule === "deep-import").length, 0);
    },
  );
});

test("expired exceptions are global blocking violations", async () => {
  const policy = `${POLICY}\nexceptions:\n  - id: old\n    rule: deep-import\n    paths: [src/**]\n    expires: 2020-01-01\n`;
  await fixture(
    {
      "architecture-policy.yaml": policy,
      "src/alpha/contract.ts": "export type Alpha = string;\n",
      "src/beta/contract.ts": "export type Beta = string;\n",
    },
    async (cwd) => {
      const result = await checkArchitecture({ cwd, changedFiles: [] });
      assert.ok(result.newViolations.some((v) => v.rule === "expired-exception"));
    },
  );
});
