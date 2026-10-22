import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../run-affected-unit-tests.mjs", import.meta.url));
const legacyEntry = fileURLToPath(new URL("../run-lint-staged-vitest.mjs", import.meta.url));
const zero = "0".repeat(40);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "affected-official-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 外层 hook 的 SHA 和 Git local env 不属于夹具，必须用环境副本隔离。
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("GIT_") ||
      key.startsWith("ZCODE_PRE_PUSH_") ||
      key === "ZCODE_AFFECTED_TEST_BASE"
    )
      delete env[key];
  await symlink(
    resolve("node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const write = (path, content) => writeFile(join(root, path), content);
  const git = async (...args) =>
    (
      await exec(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: root, env },
      )
    ).stdout.trim();
  await write(".gitignore", "node_modules\nselected\n");
  await write("package.json", '{"type":"module"}');
  await write(
    "vitest.config.mjs",
    'export default {test:{include:["*.test.mjs"],maxWorkers:1,setupFiles:["./vitest.setup.ts"],forceRerunTriggers:["**/package.json/**","**/{vitest,vite}.config.*/**","**/{vitest,vite}.config.*","**/vitest.setup.ts"]}}',
  );
  await write("vitest.setup.ts", "// shared setup\n");
  await write("source.mjs", "export const value = 1;");
  await write(
    "a.test.mjs",
    'import {test,expect} from "vitest"; import {value} from "./source.mjs"; import {writeFile} from "node:fs/promises"; test("selected",async()=>{expect(value).toBe(2);await writeFile(new URL("./selected",import.meta.url),"yes")});',
  );
  await write("other.test.mjs", 'throw new Error("UNSELECTED_TEST_EXECUTED");');
  await git("init", "-b", "main");
  await git("add", ".");
  await git("commit", "-m", "base");
  const base = await git("rev-parse", "HEAD");
  const invoke = async (args = [], overrides = {}, script = entry) => {
    try {
      return {
        code: 0,
        ...(await exec(process.execPath, [script, ...args], {
          cwd: root,
          env: { ...env, ...overrides },
          maxBuffer: 2_000_000,
        })),
      };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const hook = (remote = base, local = "HEAD") =>
    git("rev-parse", local).then((sha) => ({
      ZCODE_PRE_PUSH_STDIN: `refs/heads/main ${sha} refs/heads/main ${remote}`,
    }));
  return { root, write, git, base, invoke, hook, env };
}
const paths = (result) => JSON.parse(result.stdout).map((spec) => spec.path);

test("官方预览与执行一致，不加载无关文件，不改写源码或 index", async (t) => {
  const { root, write, git, invoke } = await fixture(t);
  await write("source.mjs", "export const value = 2;");
  const index = await git("ls-files", "--stage");
  const preview = await invoke(["--dry-run", "--json"]);
  assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(paths(preview), ["a.test.mjs"]);
  await assert.rejects(readFile(join(root, "selected")), { code: "ENOENT" });
  const run = await invoke();
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.equal(await readFile(join(root, "selected"), "utf8"), "yes");
  assert.equal(await git("ls-files", "--stage"), index);
  assert.equal(await readFile(join(root, "source.mjs"), "utf8"), "export const value = 2;");
});

for (const file of ["vitest.config.mjs", "package.json", "vitest.setup.ts"]) {
  test(`${file} 由官方触发全量，预览与执行均成功跳过且不加载测试`, async (t) => {
    const { root, write, invoke } = await fixture(t);
    await write(file, (await readFile(join(root, file), "utf8")) + "\n");
    for (const args of [[], ["--dry-run"], ["--dry-run", "--json"]]) {
      const result = await invoke(args);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /跳过 UT/u);
      assert.ok(!result.stdout.includes("UNSELECTED_TEST_EXECUTED"));
    }
    await assert.rejects(readFile(join(root, "selected")), { code: "ENOENT" });
  });
}

test("共同源码依赖选中全部测试时成功跳过，不只检查配置文件", async (t) => {
  const { root, write, git, invoke } = await fixture(t);
  await write(
    "other.test.mjs",
    'import "./source.mjs"; throw new Error("UNSELECTED_TEST_EXECUTED");',
  );
  await git("add", ".");
  await git("commit", "-m", "shared dependency");
  await write("source.mjs", "export const value = 2;");
  const result = await invoke();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /跳过 UT/u);
  await assert.rejects(readFile(join(root, "selected")), { code: "ENOENT" });
});

test("任务起点覆盖已提交改动，旧 WIP、staged 和新增测试正常纳入", async (t) => {
  const { write, git, base, invoke } = await fixture(t);
  await write("source.mjs", "export const value = 2;");
  await git("add", "source.mjs");
  await git("commit", "-m", "task change");
  assert.deepEqual(paths(await invoke(["--base", base, "--dry-run", "--json"])), ["a.test.mjs"]);
  assert.deepEqual(paths(await invoke(["--dry-run", "--json"])), []);
  await write("new.test.mjs", 'import {test} from "vitest";test("new",()=>{});');
  assert.deepEqual(paths(await invoke(["--dry-run", "--json"])), ["new.test.mjs"]);
  await git("add", "new.test.mjs");
  assert.deepEqual(paths(await invoke(["--base", base, "--dry-run", "--json"])), [
    "a.test.mjs",
    "new.test.mjs",
  ]);
});

test("无改动、无关联、Node 测试都不执行，说明并成功退出", async (t) => {
  const { root, write, invoke } = await fixture(t);
  assert.match((await invoke()).stdout, /无选中测试/u);
  await write("resource.txt", "unrelated");
  await write(
    "tool.test.mjs",
    'import test from "node:test";test("node",()=>{throw new Error("NODE_EXECUTED")});',
  );
  // 夹具 root include 会包括此文件，放入 scripts/ 才符合根 Node 测试边界。
  const { mkdir, rename } = await import("node:fs/promises");
  await mkdir(join(root, "scripts"));
  await rename(join(root, "tool.test.mjs"), join(root, "scripts/tool.test.mjs"));
  const result = await invoke();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /无选中测试/u);
});

for (const kind of ["unstaged", "staged", "untracked"]) {
  test(`Push 阻止 ${kind} 改动，忽略 Git 已忽略的文件`, async (t) => {
    const { root, write, git, invoke, hook } = await fixture(t);
    await write("selected", "ignored");
    const clean = await invoke(["--scope", "push", "--dry-run"], await hook());
    assert.equal(clean.code, 0, clean.stderr);
    await write(kind === "untracked" ? "untracked.txt" : "source.mjs", "export const value = 2;");
    if (kind === "staged") await git("add", "source.mjs");
    const result = await invoke(["--scope", "push"], await hook());
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /工作区.*不干净/u);
    assert.equal(await readFile(join(root, "selected"), "utf8"), "ignored");
  });
}

test("Push 使用 remote SHA；新分支使用 staging 共同祖先；手动模式使用 upstream", async (t) => {
  const { write, git, base, invoke, hook } = await fixture(t);
  await git("update-ref", "refs/remotes/origin/staging", base);
  await git("update-ref", "refs/remotes/origin/main", base);
  await git("config", "branch.main.remote", "origin");
  await git("config", "branch.main.merge", "refs/heads/main");
  await git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  await write("source.mjs", "export const value = 2;");
  await git("add", ".");
  await git("commit", "-m", "task");
  for (const overrides of [await hook(), await hook(zero), {}]) {
    const result = await invoke(["--scope", "push", "--dry-run", "--json"], overrides);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(paths(result), ["a.test.mjs"]);
  }
});

test("无基线、无效基线、非 HEAD 推送均报错；删除 ref 不测试", async (t) => {
  const { invoke, hook, base } = await fixture(t);
  for (const [args, env] of [
    [["--scope", "push"], {}],
    [["--base", "missing"], {}],
    [["--scope", "push"], await hook("1".repeat(40))],
    [
      ["--scope", "push"],
      { ZCODE_PRE_PUSH_STDIN: `refs/heads/x ${"1".repeat(40)} refs/heads/x ${base}` },
    ],
    [["--scope", "invalid"], {}],
  ])
    assert.equal((await invoke(args, env)).code, 2);
  const deleted = await invoke(["--scope", "push"], {
    ZCODE_PRE_PUSH_STDIN: `(delete) ${zero} refs/heads/x ${base}`,
  });
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.match(deleted.stdout, /无选中测试/u);
});

test("合并集成带入的改动正常参与官方选择", async (t) => {
  const { write, git, base, invoke } = await fixture(t);
  await git("checkout", "-b", "integration");
  await write("source.mjs", "export const value = 2;");
  await git("add", ".");
  await git("commit", "-m", "integration change");
  await git("update-ref", "refs/remotes/origin/staging", "HEAD");
  await git("checkout", "main");
  await write("feature.txt", "feature");
  await git("add", ".");
  await git("commit", "-m", "feature");
  await git("merge", "--no-ff", "integration", "-m", "merge integration");
  const result = await invoke(["--base", base, "--dry-run", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(paths(result), ["a.test.mjs"]);
});

test("实际选中测试失败返回 1，无关测试不执行", async (t) => {
  const { write, invoke } = await fixture(t);
  await write("source.mjs", "export const value = 3;");
  const result = await invoke();
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.ok(!result.stdout.includes("UNSELECTED_TEST_EXECUTED"));
});

test("lint-staged manifest 使用官方 related，保留用户 manifest", async (t) => {
  const { root, write, invoke } = await fixture(t);
  await write("source.mjs", "export const value = 2;");
  await write(
    "user-manifest.json",
    JSON.stringify({ mode: "related", files: ["source.mjs", "source.mjs"] }),
  );
  const result = await invoke(
    ["related", "--files-manifest", "user-manifest.json"],
    {},
    legacyEntry,
  );
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await readFile(join(root, "selected"), "utf8"), "yes");
  await readFile(join(root, "user-manifest.json"));
});

test("根配置的公共 setup 通过官方 trigger 选中整个套件并成功跳过", async () => {
  const result = await exec(process.execPath, [entry, "--files", "vitest.setup.ts", "--dry-run"], {
    cwd: resolve("."),
    maxBuffer: 2_000_000,
  });
  assert.match(result.stderr, /跳过 UT/u);
  assert.ok(!result.stdout.includes("RUN  v"));
});

test("多个 Push ref 的官方选择合并去重，完整并集成功跳过", async (t) => {
  const { write, git, base, invoke, hook } = await fixture(t);
  await write("source.mjs", "export const value = 2;");
  await git("add", ".");
  await git("commit", "-m", "first");
  const middle = await git("rev-parse", "HEAD");
  await write("other.test.mjs", 'import {test} from "vitest";test("other",()=>{});');
  await git("add", ".");
  await git("commit", "-m", "second");
  const first = await hook(base);
  const second = await hook(middle);
  const result = await invoke(["--scope", "push", "--dry-run", "--json"], {
    ZCODE_PRE_PUSH_STDIN: `${first.ZCODE_PRE_PUSH_STDIN}\n${second.ZCODE_PRE_PUSH_STDIN}`,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /跳过 UT/u);
  assert.deepEqual(paths(result), ["a.test.mjs", "other.test.mjs"]);
  const notHead = await invoke(["--scope", "push"], await hook(base, middle));
  assert.equal(notHead.code, 2, notHead.stderr);
  assert.match(notHead.stderr, /不是当前 HEAD/u);
});

test("显式文件走官方模块关系，不再分析 readFile 字面量或自动选择 Node 测试", async (t) => {
  const { write, git, invoke } = await fixture(t);
  await write("resource.txt", "before");
  await write(
    "a.test.mjs",
    'import {test} from "vitest";import {readFile} from "node:fs/promises";test("resource",()=>readFile(new URL("./resource.txt",import.meta.url)));',
  );
  await git("add", ".");
  await git("commit", "-m", "resource test");
  await write("resource.txt", "after");
  const result = await invoke(["--files", "resource.txt", "--dry-run", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(paths(result), []);
});

test("hook Git local env 不污染真实 index，选择仍使用实际工作区", async (t) => {
  const { root, write, git, invoke } = await fixture(t);
  await write("source.mjs", "export const value = 2;");
  const index = await git("ls-files", "--stage");
  const result = await invoke(["--dry-run", "--json"], {
    GIT_INDEX_FILE: join(root, "missing-index"),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(paths(result), ["a.test.mjs"]);
  assert.equal(await git("ls-files", "--stage"), index);
});

test("真实 git push 在配置触发全量时继续推送，不执行 UT", async (t) => {
  const { root, write, git } = await fixture(t);
  const remote = await mkdtemp(join(tmpdir(), "affected-push-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await git("init", "--bare", remote);
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "main");
  const quote = (value) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(root, ".git/hooks/pre-push"),
    `#!/bin/sh\npre_push_stdin=$(cat)\nZCODE_PRE_PUSH_STDIN="$pre_push_stdin" ${quote(process.execPath)} ${quote(entry)} --scope push\n`,
    { mode: 0o755 },
  );
  await write("vitest.setup.ts", "// changed shared setup\n");
  await git("add", ".");
  await git("commit", "-m", "setup change");
  const output = await git("push", "origin", "main");
  assert.match(output, /选中 2\/2/u);
  assert.equal(await git("rev-parse", "origin/main"), await git("rev-parse", "HEAD"));
  await assert.rejects(readFile(join(root, "selected")), { code: "ENOENT" });
});

test("Push 显式 ref 优先于 hook 基线，首次推送也不依赖 staging", async (t) => {
  const { write, git, base, invoke, hook } = await fixture(t);
  await git("branch", "comparison-ref", base);
  await write("source.mjs", "export const value = 2;");
  await git("add", ".");
  await git("commit", "-m", "source change");
  const head = await git("rev-parse", "HEAD");
  for (const remote of [head, zero]) {
    const input = await hook(remote);
    for (const [args, override] of [
      [[], { ZCODE_AFFECTED_TEST_BASE: "comparison-ref" }],
      [[], { ZCODE_PRE_PUSH_BASE: base }],
      [["--base", base], { ZCODE_AFFECTED_TEST_BASE: "missing" }],
      [[], { ZCODE_AFFECTED_TEST_BASE: base, ZCODE_PRE_PUSH_BASE: "missing" }],
    ]) {
      const result = await invoke(["--scope", "push", "--dry-run", "--json", ...args], {
        ...input,
        ...override,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(paths(result), ["a.test.mjs"]);
    }
  }
  const invalid = await invoke(["--scope", "push"], {
    ...(await hook(head)),
    ZCODE_AFFECTED_TEST_BASE: "missing",
  });
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /missing/u);
  const notHead = await invoke(["--scope", "push"], {
    ...(await hook(head, base)),
    ZCODE_AFFECTED_TEST_BASE: base,
  });
  assert.equal(notHead.code, 2);
  assert.match(notHead.stderr, /不是当前 HEAD/u);
  await write("source.mjs", "export const value = 3;");
  const dirty = await invoke(["--scope", "push"], {
    ...(await hook(head)),
    ZCODE_AFFECTED_TEST_BASE: base,
  });
  assert.equal(dirty.code, 2);
  assert.match(dirty.stderr, /工作区.*不干净/u);
});

test("真实 git push 消费任意显式基线，而不是 remote SHA", async (t) => {
  const { root, write, git, env } = await fixture(t);
  const remote = await mkdtemp(join(tmpdir(), "affected-push-base-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await git("init", "--bare", remote);
  await git("remote", "add", "origin", remote);
  await write("source.mjs", "export const value = 2;");
  await git("add", ".");
  await git("commit", "-m", "source change");
  await git("branch", "comparison-ref", "HEAD");
  await git("push", "-u", "origin", "main");
  const quote = (value) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  await writeFile(
    join(root, ".git/hooks/pre-push"),
    `#!/bin/sh\npre_push_stdin=$(cat)\nZCODE_PRE_PUSH_STDIN="$pre_push_stdin" ${quote(process.execPath)} ${quote(entry)} --scope push\n`,
    { mode: 0o755 },
  );
  await write("vitest.setup.ts", "// setup changed on remote\n");
  await git("add", ".");
  await git("commit", "-m", "setup change");
  await git("push", "origin", "main");
  await write("feature.txt", "feature");
  await git("add", ".");
  await git("commit", "-m", "unrelated feature");
  // remote SHA 的范围只有无关联文本；显式 comparison-ref 的范围含公共 setup，应选中整个套件并跳过。
  const result = await exec("git", ["push", "origin", "main"], {
    cwd: root,
    env: { ...env, ZCODE_AFFECTED_TEST_BASE: "comparison-ref" },
  });
  assert.match(result.stdout, /选中 2\/2/u);
  assert.match(result.stderr, /跳过 UT/u);
  assert.equal(await git("rev-parse", "origin/main"), await git("rev-parse", "HEAD"));
  await assert.rejects(readFile(join(root, "selected")), { code: "ENOENT" });
});
