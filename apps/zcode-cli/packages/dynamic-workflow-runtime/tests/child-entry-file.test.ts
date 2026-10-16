/**
 * 沙箱入口文件的落盘契约（docs/dynamic-workflow/launch.md「Single-executable builds」）。
 *
 * Bug 根因：harness 原先把整份 lowered 脚本 base64 后放在子进程命令行上，Windows 的命令行上限是
 * 32,767 字符，脚本一过约 18 KB 就 `spawn ENAMETOOLONG`——Windows 上稍长的 run 一个都起不来。
 * 次生缺陷：这类 spawn 失败在 Node 里是**同步抛错**，绕过引擎，journal 行永远停在 running。
 *
 * 四件事钉住：
 *   1. 入口文件落在 `<cwd>/.zcode/workflow-runs/<runId>.mjs`，同目录有 `.gitignore`，run 结算后文件仍在；
 *   2. **回归护栏**：脚本再大，命令行长度也不变（与 200 KB 的 lowered 体无关）；
 *   3. 项目 `.zcode` 写不进 → 回落 tmpdir + onWarning，run 照常；
 *   4. spawn 同步抛错 → 经引擎结算 failed，journal 行 status 是 failed 而不是 running。
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawn as spawnType } from "node:child_process";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import {
  childEntryFileName,
  fallbackWorkflowRunsDir,
  runWorkflowScript,
  workflowRunsDir,
  writeChildEntryFile,
  type HarnessWarning,
} from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";

// 包一层真 spawn：截获 args，子进程照常启动；`spawnOverride` 存在时改为调用它（同步抛错用例）。
const spawnCalls: Array<{ args: readonly string[] }> = [];
let spawnOverride: ((...args: Parameters<typeof spawnType>) => ReturnType<typeof spawnType>) | undefined;
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped: typeof spawnType = ((...args: Parameters<typeof spawnType>) => {
    spawnCalls.push({ args: (args[1] ?? []) as readonly string[] });
    if (spawnOverride !== undefined) return spawnOverride(...args);
    return actual.spawn(...args);
  }) as typeof spawnType;
  return { ...actual, spawn: wrapped };
});

const roots: string[] = [];

afterEach(async () => {
  spawnCalls.length = 0;
  spawnOverride = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 跑一份手写 lowered 体（无 ask 站点），返回结算与 journal。 */
async function runLowered(
  lowered: string,
  extra: Partial<Parameters<typeof runWorkflowScript>[0]> = {},
): Promise<{ settlement: Awaited<ReturnType<typeof runWorkflowScript>>; journal: InMemoryJournalStore }> {
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal);
  const settlement = await runWorkflowScript({
    lowered,
    runId: "run",
    caps: { maxConcurrency: 4 },
    askSpecs: new Map(),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 20000,
    ...extra,
  });
  return { settlement, journal };
}

describe("child entry file", () => {
  it("lands under <cwd>/.zcode/workflow-runs/<runId>.mjs with a .gitignore, and stays after the run settles", async () => {
    const cwd = await tempRoot("dwf-entry-cwd-");

    const { settlement } = await runLowered("return __host.args.x;", {
      cwd,
      runId: "dwfrun-1234",
      args: { x: 7 },
    });

    expect(settlement).toEqual({ status: "completed", artifact: 7 });
    const entryPath = join(cwd, ".zcode", "workflow-runs", "dwfrun-1234.mjs");
    expect(spawnCalls[0]!.args).toEqual(["--max-old-space-size=256", entryPath]);
    // 保留是裁决：目录兼作每次 run 实际执行体的存档。
    const text = await readFile(entryPath, "utf8");
    expect(text).toContain("// zcode dynamic workflow run dwfrun-1234");
    expect(text).toContain('export const payload = {"lowered":"return __host.args.x;","args":{"x":7},"maxOldSpaceSizeMb":256}');
    expect(text).toContain("export const start = ");
    // 只由 harness 写一份 `*`，绝不碰项目自己的 .gitignore。
    await expect(readFile(join(cwd, ".zcode", "workflow-runs", ".gitignore"), "utf8")).resolves.toBe("*\n");
  });

  it("keeps the command line short no matter how large the script is (Windows ENAMETOOLONG guard)", async () => {
    const cwd = await tempRoot("dwf-entry-big-");
    // 200 KB 的 lowered 体：远超 Windows 32,767 字符的命令行上限，也超过 Linux 128 KB 的单参数上限。
    const lowered = `const pad = ${JSON.stringify("x".repeat(200_000))};\nreturn pad.length;`;

    const { settlement } = await runLowered(lowered, { cwd });

    expect(settlement).toEqual({ status: "completed", artifact: 200_000 });
    const argvChars = spawnCalls[0]!.args.reduce((sum, arg) => sum + arg.length, 0);
    expect(argvChars).toBeLessThan(1_000);
    expect(spawnCalls[0]!.args.every((arg) => arg.length < 32_767)).toBe(true);
  });

  it("falls back to os.tmpdir() and warns when the project .zcode cannot be created", async () => {
    const cwd = await tempRoot("dwf-entry-fallback-");
    // `.zcode` 是个普通文件：mkdir 必然 ENOTDIR/EEXIST，正是「项目里写不进」的一种。
    await writeFile(join(cwd, ".zcode"), "not a directory", "utf8");
    const warnings: HarnessWarning[] = [];

    const { settlement } = await runLowered("return 1;", {
      cwd,
      runId: "dwfrun-fallback",
      onWarning: (warning) => warnings.push(warning),
    });

    expect(settlement).toEqual({ status: "completed", artifact: 1 });
    const expectedPath = join(fallbackWorkflowRunsDir(), "dwfrun-fallback.mjs");
    expect(spawnCalls[0]!.args[1]).toBe(expectedPath);
    await expect(stat(expectedPath)).resolves.toBeDefined();
    expect(warnings).toEqual([
      {
        kind: "entry_file_fallback",
        projectDir: join(cwd, ".zcode", "workflow-runs"),
        fallbackDir: fallbackWorkflowRunsDir(),
        error: expect.stringMatching(/ENOTDIR|EEXIST|ENOENT/),
      },
    ]);
    await rm(expectedPath, { force: true });
  });

  it("settles a synchronous spawn failure as stopped(interrupted) through the engine, so the journal row is not left running", async () => {
    const cwd = await tempRoot("dwf-entry-throw-");
    spawnOverride = () => {
      // Node 对 ENAMETOOLONG / E2BIG 正是这样同步抛的（只有 EACCES/EAGAIN/EMFILE/ENFILE/ENOENT 走 error 事件）。
      const error = new Error("spawn ENAMETOOLONG") as Error & { code: string };
      error.code = "ENAMETOOLONG";
      throw error;
    };

    const { settlement, journal } = await runLowered("return 1;", { cwd });

    expect(settlement.status).toBe("stopped");
    expect(settlement.status === "stopped" ? settlement.error?.message : "").toContain(
      "spawn ENAMETOOLONG",
    );
    // 引擎结算过：journal 行是 stopped(interrupted)，不是永远 running 的孤儿（那会让 AmendWorkflow
    // 被「has not settled yet」拒绝）；宿主侧故障可 resume。
    expect(journal.getRun("run")).toMatchObject({ status: "stopped", stopReason: "interrupted" });
  });
});

describe("writeChildEntryFile", () => {
  it("sanitises the run id into the file name", () => {
    expect(childEntryFileName("dwfrun-1234-abcd")).toBe("dwfrun-1234-abcd.mjs");
    expect(childEntryFileName("../evil/run id")).toBe(".._evil_run_id.mjs");
  });

  it("reports where it wrote", async () => {
    const cwd = await tempRoot("dwf-entry-unit-");

    const written = writeChildEntryFile({ cwd, runId: "r1", source: "export const x = 1;\n" });

    expect(written).toEqual({ path: join(workflowRunsDir(cwd), "r1.mjs"), location: "project" });
    await expect(readFile(written.path, "utf8")).resolves.toBe("export const x = 1;\n");
  });

  it("leaves an existing .gitignore alone", async () => {
    const cwd = await tempRoot("dwf-entry-gitignore-");
    writeChildEntryFile({ cwd, runId: "r1", source: "" });
    await writeFile(join(workflowRunsDir(cwd), ".gitignore"), "custom\n", "utf8");

    writeChildEntryFile({ cwd, runId: "r2", source: "" });

    await expect(readFile(join(workflowRunsDir(cwd), ".gitignore"), "utf8")).resolves.toBe("custom\n");
  });
});
