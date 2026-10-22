import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { addedFilesFromGit, checkArchitecture, loadPolicy } from "../architecture/index.mjs";

const exec = promisify(execFile);
const original = "export const value = 1;\n";
const file = "packages/legacy/imported.ts";

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture(run) {
  const cwd = await mkdtemp(join(tmpdir(), "architecture-upstream-"));
  try {
    await git(cwd, "init", "-b", "main");
    await git(cwd, "config", "user.name", "Architecture Test");
    await git(cwd, "config", "user.email", "architecture@example.invalid");
    await git(cwd, "config", "commit.gpgsign", "false");
    await git(cwd, "config", "core.filemode", "true");
    await git(cwd, "config", "core.autocrlf", "false");
    const commit = async () => {
      await git(cwd, "add", ".");
      await git(cwd, "-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "fixture");
      return git(cwd, "rev-parse", "HEAD");
    };
    const previousHead = await commit();
    await mkdir(join(cwd, "packages/legacy"), { recursive: true });
    await writeFile(join(cwd, file), original);
    const upstream = await commit();
    const acceptedUpstreamCommits = [
      { commit: upstream, previousHead, reason: "fixture admission" },
    ];
    const collect = (base = previousHead) =>
      addedFilesFromGit(cwd, { base, acceptedUpstreamCommits });
    await run({ cwd, previousHead, upstream, commit, collect, acceptedUpstreamCommits });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("原样上游存量可接纳，本地新增仍受管", async () => {
  await fixture(async ({ cwd, collect }) => {
    await writeFile(join(cwd, "packages/legacy/local.ts"), original);
    assert.deepEqual(await collect(), ["packages/legacy/local.ts"]);
  });
});

for (const state of ["committed", "staged", "unstaged", "staged-then-restored"]) {
  test(`${state}：改过的上游文件仍须登记`, async () => {
    await fixture(async ({ cwd, collect, commit }) => {
      await writeFile(join(cwd, file), "export const value = 2;\n");
      if (state === "committed") await commit();
      if (state.startsWith("staged")) await git(cwd, "add", file);
      if (state === "staged-then-restored") await writeFile(join(cwd, file), original);
      assert.deepEqual(await collect(), [file]);
    });
  });
}

test("首次推送后的后续修改仍要求模块登记", async () => {
  await fixture(async ({ cwd, upstream, collect }) => {
    await writeFile(join(cwd, file), "export const value = 2;\n");
    assert.deepEqual(await collect(upstream), [file]);
  });
});

test("再次合并指定上游原样更新的存量文件，仍接纳原样但拒绝本地修改", async () => {
  await fixture(async ({ cwd, upstream, collect, commit, acceptedUpstreamCommits }) => {
    await writeFile(join(cwd, file), "export const value = 2;\n");
    const updated = await commit();
    acceptedUpstreamCommits.push({
      commit: updated,
      previousHead: upstream,
      reason: "upstream update",
    });
    assert.deepEqual(await collect(upstream), []);
    await writeFile(join(cwd, file), "export const value = 3;\n");
    assert.deepEqual(await collect(upstream), [file]);
  });
});

test("同内容的重命名与重新生成的未跟踪路径不享受准入", async () => {
  await fixture(async ({ cwd, collect }) => {
    const moved = "packages/legacy/renamed.ts";
    await rename(join(cwd, file), join(cwd, moved));
    await git(cwd, "add", ".");
    assert.deepEqual(await collect(), [moved]);
    await writeFile(join(cwd, file), original);
    assert.deepEqual((await collect()).sort(), [file, moved].sort());
  });
});

test("文件模式变化不能当作原样上游", { skip: process.platform === "win32" }, async () => {
  await fixture(async ({ cwd, collect }) => {
    await chmod(join(cwd, file), 0o755);
    assert.deepEqual(await collect(), [file]);
  });
});

test("不允许用未合入或不存在的提交接纳文件", async () => {
  await fixture(async ({ cwd, previousHead, upstream, collect, acceptedUpstreamCommits }) => {
    await git(cwd, "checkout", "--detach", previousHead);
    await assert.rejects(collect(), /ancestor|祖先|合入/);
    await git(cwd, "checkout", "--detach", upstream);
    acceptedUpstreamCommits[0].commit = "f".repeat(40);
    await assert.rejects(collect(), /commit|提交/);
  });
});

test("未提交的当前合并可先校验，修改上游文件仍不能接纳", async () => {
  await fixture(async ({ cwd, previousHead, upstream, collect }) => {
    await git(cwd, "checkout", "--detach", previousHead);
    await git(cwd, "merge", "--no-commit", "--no-ff", upstream);
    assert.deepEqual(await collect(), []);
    await writeFile(join(cwd, file), "export const value = 2;\n");
    assert.deepEqual(await collect(), [file]);
    await git(cwd, "restore", file);
    await git(cwd, "merge", "--abort");
    await assert.rejects(collect(), /ancestor|祖先|合入/);
  });
});

test("准入不豁免 managed 模块的结构规则", async () => {
  await fixture(async ({ cwd, collect }) => {
    await writeFile(
      join(cwd, "architecture-policy.yaml"),
      `version: 1
modules:
  - id: legacy
    roots: [packages/legacy]
    managed: true
    requires: []
global:
  maxFileLines: 1
`,
    );
    const result = await checkArchitecture({ cwd, addedFiles: await collect() });
    assert.ok(result.newViolations.some((item) => item.rule === "max-file-lines"));
    assert.ok(result.newViolations.some((item) => item.rule === "missing-module-artifact"));
  });
});

test("策略只接受完整固定 SHA 和非空理由", async () => {
  await fixture(async ({ cwd, acceptedUpstreamCommits }) => {
    for (const patch of [{ commit: "main" }, { previousHead: "HEAD" }, { reason: " " }]) {
      await writeFile(
        join(cwd, "architecture-policy.yaml"),
        JSON.stringify({
          version: 1,
          modules: [],
          global: { acceptedUpstreamCommits: [{ ...acceptedUpstreamCommits[0], ...patch }] },
        }),
      );
      await assert.rejects(loadPolicy(cwd), /acceptedUpstreamCommits/);
    }
  });
});
