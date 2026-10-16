import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { resolveSpawnRuntimeOptions } from "../spawn-command.mjs";

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cli release-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cliRoot = join(root, "apps/zcode-cli");
  await mkdir(cliRoot, { recursive: true });
  for (const [relative, version] of [
    ["package.json", "9.9.9"],
    ["apps/zcode-cli/package.json", "1.2.3"],
  ]) {
    const original = JSON.parse(await readFile(join(repoRoot, relative), "utf8"));
    const scripts = Object.fromEntries(
      Object.entries(original.scripts).filter(([key]) => key.startsWith("release")),
    );
    await writeFile(
      join(root, relative),
      `${JSON.stringify({ name: original.name, private: true, version, scripts }, null, 2)}\n`,
    );
  }
  await writeFile(
    join(cliRoot, ".release-it.json"),
    await readFile(join(repoRoot, "apps/zcode-cli/.release-it.json")),
  );
  await writeFile(
    join(root, ".release-it.mjs"),
    'throw new Error("Desktop release config must not load");\n',
  );
  await writeFile(join(root, "CHANGELOG.md"), "desktop changelog\n");
  await writeFile(join(root, ".gitignore"), "node_modules\n");
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  await symlink(
    join(repoRoot, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout;
  const run = (script, args, cwd = root) =>
    exec("npm", ["run", script, "--", ...args], {
      cwd,
      env: {
        ...process.env,
        PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
        npm_config_update_notifier: "false",
      },
      ...resolveSpawnRuntimeOptions("npm"),
      timeout: 30000,
    });
  return { root, cliRoot, head, run };
}

async function assertIsolated({ root, head }, expectedStatus) {
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout, head);
  assert.equal((await exec("git", ["tag", "--list"], { cwd: root })).stdout.trim(), "");
  assert.equal(
    (await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.trim(),
    expectedStatus,
  );
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "9.9.9");
  assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), "desktop changelog\n");
}

test("独立 release-it 通过根脚本支持 patch/minor/显式版本，只修改 CLI manifest", async (t) => {
  const f = await fixture(t);
  for (const [increment, expected] of [
    ["patch", "1.2.4"],
    ["minor", "1.3.0"],
    ["2.0.0", "2.0.0"],
  ]) {
    await f.run("release:cli", [increment, "--ci"]);
    assert.equal(
      JSON.parse(await readFile(join(f.cliRoot, "package.json"), "utf8")).version,
      expected,
    );
    await assertIsolated(f, "M apps/zcode-cli/package.json");
  }
});

test("根与 CLI dry-run 入口不修改文件或创建 commit/tag", async (t) => {
  const f = await fixture(t);
  await f.run("release:cli:dry", ["patch", "--ci"]);
  await f.run("release:dry", ["minor", "--ci"], f.cliRoot);
  assert.equal(
    JSON.parse(await readFile(join(f.cliRoot, "package.json"), "utf8")).version,
    "1.2.3",
  );
  await assertIsolated(f, "");
});

test("CLI 直接入口支持独立升级版本", async (t) => {
  const f = await fixture(t);
  await f.run("release", ["major", "--ci"], f.cliRoot);
  assert.equal(
    JSON.parse(await readFile(join(f.cliRoot, "package.json"), "utf8")).version,
    "2.0.0",
  );
  await assertIsolated(f, "M apps/zcode-cli/package.json");
});
