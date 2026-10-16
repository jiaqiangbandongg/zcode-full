// 完成卡的两个协议方法（docs/dynamic-workflow/transcript-and-notifications.md「Saving the run,
// and running it again」；docs/dynamic-workflow/launch.md「Data path」）：`workflows/save` 按 runId
// 取 journal 里的脚本原文落盘，`workflows/forRun` 回答「这次 run 对应哪个已保存工作流」。
// 真实 tmp 目录 + core 的真实 store / codec / 类型检查器；只有 journal 用能力探测式的假实现。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  zcodeProtocolMethods,
  zcodeWorkflowsForRunResultSchema,
  zcodeWorkflowsSaveResultSchema,
} from "@zcode/shared";
import { parseSavedWorkflow, serializeSavedWorkflow } from "@zcode/core";
import {
  findSavedWorkflowForRunOp,
  saveSavedWorkflowFromRunOp,
} from "../src/zcode-protocol/saved-workflows-run.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const SCRIPT = [
  'const reviewer = agent("检查员");',
  "const found = await reviewer.ask<string>(`检查 ${String(args.target)}`);",
  "return found;",
  "",
].join("\n");

const OTHER_SCRIPT = ['const a = agent("另一个");', 'return await a.ask<string>("hi");', ""].join(
  "\n",
);

let cwd = "";
let home = "";
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

interface FakeRun {
  runId: string;
  name?: string;
  scriptText?: string;
  args?: Record<string, unknown>;
}

function workspace() {
  return { workspacePath: cwd, workspaceKey: cwd };
}

/** 只实现 `getRun`：两个方法从 journal 读的就只有这一行。 */
function contextWithRuns(runs: readonly FakeRun[]): ZCodeProtocolAgentServerContext {
  const journal = {
    getRun: (runId: string) => {
      const run = runs.find((candidate) => candidate.runId === runId);
      return run === undefined
        ? undefined
        : { caps: { maxConcurrency: 1 }, spentTokens: 0, status: "completed", ...run };
    },
  };
  return {
    deps: { env: {}, sessionStore: { workflowJournalStore: () => journal } },
    sessions: new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
}

function projectDir() {
  return join(cwd, ".zcode", "workflows");
}

function globalDir() {
  return join(home, ".zcode", "workflows");
}

async function seed(dir: string, name: string, script: string, description = "已有") {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.dwf.ts`);
  await writeFile(path, serializeSavedWorkflow({ description }, script), "utf8");
  return path;
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "zcode-saved-workflows-run-"));
  home = await mkdtemp(join(tmpdir(), "zcode-saved-workflows-run-home-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("workflows/save", () => {
  it("registers the method names", () => {
    expect(zcodeProtocolMethods.workflowsSave).toBe("workflows/save");
    expect(zcodeProtocolMethods.workflowsForRun).toBe("workflows/forRun");
  });

  it("按 runId 取 journal 里的脚本原文逐字节写下去；元数据按 SaveWorkflow 同一套规则落 frontmatter", async () => {
    const context = contextWithRuns([{ runId: "run-1", scriptText: SCRIPT }]);
    const result = await saveSavedWorkflowFromRunOp(context, {
      workspace: workspace(),
      runId: "run-1",
      name: "pr-review",
      meta: { description: "分层评审" },
    });
    expect(() => zcodeWorkflowsSaveResultSchema.parse(result)).not.toThrow();
    expect(result).toEqual({
      ok: true,
      name: "pr-review",
      scope: "project",
      path: join(projectDir(), "pr-review.dwf.ts"),
      overwritten: false,
    });
    const parsed = parseSavedWorkflow(
      await readFile(join(projectDir(), "pr-review.dwf.ts"), "utf8"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta.description).toBe("分层评审");
    // 逐字节：「按 run 跑的那一份认出已保存」这条规则的前提就是它。
    expect(parsed.script).toBe(SCRIPT);
  });

  it("全局档落在 agent 机器的家目录；另一档同名时回遮蔽方向", async () => {
    await seed(projectDir(), "pr-review", OTHER_SCRIPT);
    const context = contextWithRuns([{ runId: "run-1", scriptText: SCRIPT }]);
    const result = await saveSavedWorkflowFromRunOp(context, {
      workspace: workspace(),
      runId: "run-1",
      name: "pr-review",
      meta: { description: "全局那一份" },
      scope: "global",
    });
    expect(result).toMatchObject({
      ok: true,
      scope: "global",
      path: join(globalDir(), "pr-review.dwf.ts"),
      shadowing: "hidden_by_project",
    });
  });

  it("覆盖是用户的决定：目标已存在且没说覆盖就拒绝、一个字节都不动；说了才写并回 overwritten", async () => {
    const path = await seed(projectDir(), "pr-review", OTHER_SCRIPT);
    const before = await readFile(path, "utf8");
    const context = contextWithRuns([{ runId: "run-1", scriptText: SCRIPT }]);
    const params = {
      workspace: workspace(),
      runId: "run-1",
      name: "pr-review",
      meta: { description: "新的" },
    };
    expect(await saveSavedWorkflowFromRunOp(context, params)).toEqual({
      ok: false,
      reason: "target_exists",
      path,
    });
    expect(await readFile(path, "utf8")).toBe(before);

    const result = await saveSavedWorkflowFromRunOp(context, { ...params, overwrite: true });
    expect(result).toMatchObject({ ok: true, overwritten: true });
    expect(await readFile(path, "utf8")).toContain("reviewer.ask");
  });

  it("失败分支都是业务结果而不是协议错误：非法名字、查无此 run、老记录没存脚本、类型检查不过", async () => {
    const context = contextWithRuns([
      { runId: "old", name: "老 run" },
      { runId: "broken", scriptText: "const x: number = 'nope';\nreturn x;\n" },
    ]);
    const base = { workspace: workspace(), meta: { description: "d" } };
    expect(
      await saveSavedWorkflowFromRunOp(context, { ...base, runId: "old", name: "../escape" }),
    ).toEqual({ ok: false, reason: "invalid_name" });
    expect(
      await saveSavedWorkflowFromRunOp(context, { ...base, runId: "missing", name: "a" }),
    ).toEqual({ ok: false, reason: "run_not_found" });
    expect(await saveSavedWorkflowFromRunOp(context, { ...base, runId: "old", name: "a" })).toEqual(
      {
        ok: false,
        reason: "script_missing",
      },
    );
    const failed = await saveSavedWorkflowFromRunOp(context, {
      ...base,
      runId: "broken",
      name: "broken",
    });
    expect(failed).toMatchObject({ ok: false, reason: "compile_failed" });
    if (failed.ok) return;
    expect(failed.detail).toMatch(/^L\d+:C\d+ /u);
    // 编译失败一个字节都不写。
    await expect(readFile(join(projectDir(), "broken.dwf.ts"), "utf8")).rejects.toThrow();
  });
});

describe("workflows/forRun", () => {
  it("三条规则按序命中：对话认领的候选 → 脚本逐字节相同 → 名字相同；都不中只回实参", async () => {
    await seed(projectDir(), "distilled", OTHER_SCRIPT);
    await seed(projectDir(), "verbatim", SCRIPT);
    await seed(projectDir(), "named-run", OTHER_SCRIPT);
    const context = contextWithRuns([
      { runId: "r", name: "named-run", scriptText: SCRIPT, args: { target: "main" } },
    ]);

    const byCandidate = await findSavedWorkflowForRunOp(context, {
      workspace: workspace(),
      runId: "r",
      candidates: [{ name: "gone" }, { name: "distilled", scope: "project" }],
    });
    expect(() => zcodeWorkflowsForRunResultSchema.parse(byCandidate)).not.toThrow();
    expect(byCandidate).toMatchObject({
      entry: { name: "distilled", scope: "project" },
      match: "candidate",
      runArgs: { target: "main" },
    });

    const byScript = await findSavedWorkflowForRunOp(context, {
      workspace: workspace(),
      runId: "r",
    });
    expect(byScript).toMatchObject({ entry: { name: "verbatim" }, match: "script" });
    // entry 与 list 的行同形：不带脚本正文。
    expect(JSON.stringify(byScript)).not.toContain("reviewer.ask");

    await rm(join(projectDir(), "verbatim.dwf.ts"));
    expect(
      await findSavedWorkflowForRunOp(context, { workspace: workspace(), runId: "r" }),
    ).toMatchObject({ entry: { name: "named-run" }, match: "name" });

    await rm(join(projectDir(), "named-run.dwf.ts"));
    expect(
      await findSavedWorkflowForRunOp(context, { workspace: workspace(), runId: "r" }),
    ).toEqual({
      runArgs: { target: "main" },
    });
  });

  it("脚本比对项目档先于全局档；用户删掉了那份就不再是事实", async () => {
    await seed(globalDir(), "global-copy", SCRIPT);
    await seed(projectDir(), "project-copy", SCRIPT);
    const context = contextWithRuns([{ runId: "r", scriptText: SCRIPT }]);
    expect(
      await findSavedWorkflowForRunOp(context, { workspace: workspace(), runId: "r" }),
    ).toMatchObject({ entry: { name: "project-copy", scope: "project" }, match: "script" });

    await rm(join(projectDir(), "project-copy.dwf.ts"));
    expect(
      await findSavedWorkflowForRunOp(context, { workspace: workspace(), runId: "r" }),
    ).toMatchObject({ entry: { name: "global-copy", scope: "global" }, match: "script" });

    await rm(join(globalDir(), "global-copy.dwf.ts"));
    expect(
      await findSavedWorkflowForRunOp(context, { workspace: workspace(), runId: "r" }),
    ).toEqual({});
  });

  it("查不到 run 记录时只跳过脚本与名字两条规则：候选仍然算数，也不回实参", async () => {
    await seed(projectDir(), "distilled", OTHER_SCRIPT);
    const context = contextWithRuns([]);
    expect(
      await findSavedWorkflowForRunOp(context, {
        workspace: workspace(),
        runId: "evicted",
        candidates: [{ name: "distilled" }],
      }),
    ).toEqual({
      entry: expect.objectContaining({ name: "distilled" }),
      match: "candidate",
    });
    expect(
      await findSavedWorkflowForRunOp(context, { workspace: workspace(), runId: "evicted" }),
    ).toEqual({});
  });

  it("run 名不是合法文件名（用户语言起的标签）时名字规则不参与，不抛错", async () => {
    const context = contextWithRuns([
      { runId: "r", name: "PR 分层评审 · 安全", scriptText: SCRIPT },
    ]);
    expect(
      await findSavedWorkflowForRunOp(context, { workspace: workspace(), runId: "r" }),
    ).toEqual({});
  });
});
