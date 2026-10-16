// 已保存工作流 GUI 中枢的五个 workspace 级协议方法（docs/dynamic-workflow/launch.md）。
// 真实 tmp 目录 + core 的真实 store / codec；只有 journal 用能力探测式的假实现。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  zcodeProtocolMethods,
  zcodeWorkflowsDeleteResultSchema,
  zcodeWorkflowsGetResultSchema,
  zcodeWorkflowsListResultSchema,
  zcodeWorkflowsMoveResultSchema,
  zcodeWorkflowsRunsParamsSchema,
  zcodeWorkflowsRunsResultSchema,
  zcodeWorkflowsUpdateMetaResultSchema,
} from "@zcode/shared";
import { SavedWorkflowEntrySchema, SavedWorkflowMetaSchema } from "@zcode/contracts";
import { parseSavedWorkflow, serializeSavedWorkflow } from "@zcode/core";
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "../src/zcode-protocol/saved-workflows.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const SCRIPT = [
  'const reviewer = agent("检查员");',
  "const found = await reviewer.ask<string>(`检查 ${String(args.target)}`);",
  "return found;",
  "",
].join("\n");

let cwd = "";
// 每个用例一份隔离的 HOME：全局档落在 `<HOME>/.zcode/workflows/`，core 恒取 `os.homedir()`
// （posix 上即 `$HOME`）。不隔离的话 list/get/move 的全局变体会读到真实家目录、结果非确定。
let home = "";
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function workspace() {
  return { workspacePath: cwd, workspaceKey: cwd };
}

function contextWith(sessionStore?: unknown): ZCodeProtocolAgentServerContext {
  return {
    deps: { env: {}, sessionStore },
    sessions: new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
}

function projectDir() {
  return join(cwd, ".zcode", "workflows");
}

function globalDir() {
  return join(home, ".zcode", "workflows");
}

async function seedWorkflow(name: string, meta: Parameters<typeof serializeSavedWorkflow>[0]) {
  await mkdir(projectDir(), { recursive: true });
  const path = join(projectDir(), `${name}.dwf.ts`);
  await writeFile(path, serializeSavedWorkflow(meta, SCRIPT), "utf8");
  return path;
}

async function seedGlobalWorkflow(
  name: string,
  meta: Parameters<typeof serializeSavedWorkflow>[0],
) {
  await mkdir(globalDir(), { recursive: true });
  const path = join(globalDir(), `${name}.dwf.ts`);
  await writeFile(path, serializeSavedWorkflow(meta, SCRIPT), "utf8");
  return path;
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "zcode-saved-workflows-protocol-"));
  home = await mkdtemp(join(tmpdir(), "zcode-saved-workflows-home-"));
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

describe("workflows/* protocol methods", () => {
  it("registers the method names", () => {
    expect(zcodeProtocolMethods.workflowsList).toBe("workflows/list");
    expect(zcodeProtocolMethods.workflowsGet).toBe("workflows/get");
    expect(zcodeProtocolMethods.workflowsUpdateMeta).toBe("workflows/updateMeta");
    expect(zcodeProtocolMethods.workflowsDelete).toBe("workflows/delete");
    expect(zcodeProtocolMethods.workflowsRuns).toBe("workflows/runs");
    expect(zcodeProtocolMethods.workflowsMove).toBe("workflows/move");
  });

  it("list：目录不存在回空（带 dir）；坏文件进 invalid；legacy .workflow.js 不可见；不回脚本正文", async () => {
    expect(await listSavedWorkflowsOp(contextWith(), { workspace: workspace() })).toEqual({
      workflows: [],
      invalid: [],
      dir: projectDir(),
    });

    await seedWorkflow("release-check", {
      description: "发布前检查",
      whenToUse: "要发版时",
      args: { target: { type: "string", required: true } },
    });
    await writeFile(join(cwd, ".zcode", "workflows", "broken.dwf.ts"), "const x = 1;\n", "utf8");
    await writeFile(
      join(cwd, ".zcode", "workflows", "legacy.workflow.js"),
      "export const meta = {};\n",
    );

    const result = await listSavedWorkflowsOp(contextWith(), { workspace: workspace() });
    // 协议 schema（shared）与 contracts 的 entry schema 都要认同一份结果——两边形状互相钉住。
    expect(() => zcodeWorkflowsListResultSchema.parse(result)).not.toThrow();
    for (const entry of result.workflows) {
      expect(() => SavedWorkflowEntrySchema.parse(entry)).not.toThrow();
    }
    expect(result.workflows.map((entry) => entry.name)).toEqual(["release-check"]);
    expect(result.workflows[0]).toMatchObject({
      description: "发布前检查",
      whenToUse: "要发版时",
      scope: "project",
      path: join(cwd, ".zcode", "workflows", "release-check.dwf.ts"),
    });
    expect(JSON.stringify(result)).not.toContain("reviewer.ask");
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.path).toBe(join(cwd, ".zcode", "workflows", "broken.dwf.ts"));
    expect(result.invalid[0]?.reason).toContain("missing_frontmatter");
  });

  it("get：命中回 meta + 脚本本体；invalid_name / not_found / parse_error 各自可分辨", async () => {
    await seedWorkflow("release-check", { description: "发布前检查" });
    await writeFile(
      join(cwd, ".zcode", "workflows", "broken.dwf.ts"),
      "/* zcode-workflow\nx: [\n*/\n",
    );

    const hit = await getSavedWorkflowOp(contextWith(), {
      workspace: workspace(),
      name: "release-check",
    });
    expect(() => zcodeWorkflowsGetResultSchema.parse(hit)).not.toThrow();
    expect(hit).toMatchObject({
      ok: true,
      name: "release-check",
      scope: "project",
      meta: { description: "发布前检查" },
      script: SCRIPT,
    });

    expect(
      await getSavedWorkflowOp(contextWith(), { workspace: workspace(), name: "../etc" }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_name",
    });
    expect(
      await getSavedWorkflowOp(contextWith(), { workspace: workspace(), name: "missing" }),
    ).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      await getSavedWorkflowOp(contextWith(), { workspace: workspace(), name: "broken" }),
    ).toMatchObject({
      ok: false,
      reason: "parse_error",
    });
  });

  it("updateMeta：覆写后可读回新 meta，脚本正文逐字节不变；strict 拒未知键；不存在 → not_found 且不建文件", async () => {
    const path = await seedWorkflow("release-check", {
      description: "旧说明",
      args: { target: { type: "string", required: true } },
    });
    const scriptHashBefore = createHash("sha256").update(SCRIPT).digest("hex");

    const meta = {
      description: "新说明",
      whenToUse: "要发版、release、上线前检查时",
      args: {
        target: { type: "string", required: true, description: "要检查的包名或路径" },
        skipTests: { type: "boolean", default: false },
      },
    };
    const updated = await updateSavedWorkflowMetaOp(contextWith(), {
      workspace: workspace(),
      name: "release-check",
      meta,
    });
    expect(() => zcodeWorkflowsUpdateMetaResultSchema.parse(updated)).not.toThrow();
    expect(updated).toEqual({ ok: true, path });

    const parsed = parseSavedWorkflow(await readFile(path, "utf8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.meta).toEqual(SavedWorkflowMetaSchema.parse(meta));
    expect(createHash("sha256").update(parsed.script).digest("hex")).toBe(scriptHashBefore);

    await expect(
      updateSavedWorkflowMetaOp(contextWith(), {
        workspace: workspace(),
        name: "release-check",
        meta: { description: "x", permissionMode: "yolo" },
      }),
    ).rejects.toThrow();

    expect(
      await updateSavedWorkflowMetaOp(contextWith(), {
        workspace: workspace(),
        name: "ghost",
        meta: { description: "x" },
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    await expect(readFile(join(cwd, ".zcode", "workflows", "ghost.dwf.ts"))).rejects.toThrow();
  });

  it("delete：删后 list 不再列出；not_found；非法名字在触盘前拒绝；不删同名 .workflow.js", async () => {
    const path = await seedWorkflow("release-check", { description: "发布前检查" });
    const legacyPath = join(cwd, ".zcode", "workflows", "release-check.workflow.js");
    await writeFile(legacyPath, "export const meta = {};\n");

    const deleted = await deleteSavedWorkflowOp(contextWith(), {
      workspace: workspace(),
      name: "release-check",
    });
    expect(() => zcodeWorkflowsDeleteResultSchema.parse(deleted)).not.toThrow();
    expect(deleted).toEqual({ ok: true, path });
    expect(
      (await listSavedWorkflowsOp(contextWith(), { workspace: workspace() })).workflows,
    ).toEqual([]);
    await expect(readFile(legacyPath, "utf8")).resolves.toContain("export const meta");

    expect(
      await deleteSavedWorkflowOp(contextWith(), { workspace: workspace(), name: "release-check" }),
    ).toEqual({
      ok: false,
      reason: "not_found",
    });
    for (const name of ["..", "../x", "a/b", "a\\b", "."]) {
      expect(await deleteSavedWorkflowOp(contextWith(), { workspace: workspace(), name })).toEqual({
        ok: false,
        reason: "invalid_name",
      });
    }
  });

  it("runs：journal 缺席回空页；有 journal 时按 cwd + name 下推、多取一条判 truncated、行带归属字段", async () => {
    expect(
      await listSavedWorkflowRunsOp(contextWith(undefined), { workspace: workspace(), limit: 5 }),
    ).toEqual({
      runs: [],
    });

    const queries: unknown[] = [];
    const rows = [
      {
        runId: "run_2",
        name: "release-check",
        status: "completed",
        spentTokens: 38_200,
        timeCreated: 100,
        timeUpdated: 400,
        parentSessionId: "session-a",
        toolCallId: "call-2",
        args: { target: "packages/ui" },
        caps: { maxConcurrency: 1 },
      },
      {
        runId: "run_1",
        status: "errored",
        spentTokens: 6_100,
        timeCreated: 10,
        timeUpdated: 20,
        caps: { maxConcurrency: 1 },
      },
      {
        runId: "run_0",
        status: "stopped",
        spentTokens: 0,
        timeCreated: 1,
        timeUpdated: 2,
        caps: { maxConcurrency: 1 },
      },
    ];
    const journal = {
      countNodesByStatus: () => ({ completed: 0, failed: 0, running: 0 }),
      getRunRow: () => undefined,
      listRecentLogEvents: () => [],
      listRuns: (query: unknown) => {
        queries.push(query);
        return rows.slice(0, (query as { limit: number }).limit);
      },
    };
    const sessionStore = { workflowJournalStore: () => journal };

    const params = zcodeWorkflowsRunsParamsSchema.parse({
      workspace: workspace(),
      name: "release-check",
      limit: 2,
    });
    const result = await listSavedWorkflowRunsOp(contextWith(sessionStore), params);
    expect(() => zcodeWorkflowsRunsResultSchema.parse(result)).not.toThrow();
    expect(queries).toEqual([{ cwd, limit: 3, name: "release-check" }]);
    expect(result).toEqual({
      runs: [
        {
          runId: "run_2",
          name: "release-check",
          status: "completed",
          createdAt: 100,
          updatedAt: 400,
          spentTokens: 38_200,
          parentSessionId: "session-a",
          toolCallId: "call-2",
          args: { target: "packages/ui" },
        },
        { runId: "run_1", status: "errored", createdAt: 10, updatedAt: 20, spentTokens: 6_100 },
      ],
      truncated: true,
    });

    // 恰好 limit 条：没有探测行 → 不带 truncated 键。
    const exact = await listSavedWorkflowRunsOp(contextWith(sessionStore), {
      workspace: workspace(),
      limit: 3,
    });
    expect(exact).not.toHaveProperty("truncated");
    expect(exact.runs).toHaveLength(3);
    expect(queries.at(-1)).toEqual({ cwd, limit: 4 });
    // 上面那个假 journal 没有 listArtifactRows：能力缺席 ⇒ 每行的 artifacts 整字段缺席
    // （老 CLI / 注入的测试 store 逐字不变）。上面的 toEqual 已经把这一点钉死了。
  });

  // 用户面产物的中枢摘要（docs/dynamic-workflow/authoring.md「How the user sees them」）。
  // ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是脚本的顶层返回值。
  it("runs：能力在场时按 runId 逐行汇总 artifacts，只取 completed 行、取最新版、≤ 8 件", async () => {
    const artifactRow = (
      runId: string,
      id: string,
      version: number,
      overrides: Record<string, unknown> = {},
    ) => ({
      runId,
      siteId: `artifact#${version}`,
      ordinal: version,
      kind: "artifact" as const,
      inputHash: "h",
      status: "completed" as const,
      artifactId: id,
      result: { id, version, publishedAt: version, ...overrides },
    });
    const artifactRows: Record<string, unknown[]> = {
      run_2: [
        artifactRow("run_2", "audit", 1, { kind: "file", title: "旧版", bytes: 10 }),
        artifactRow("run_2", "audit", 2, {
          kind: "file",
          title: "审计报告",
          contentType: "application/pdf",
          bytes: 4_096,
        }),
        // 失败的发布不占版本号，也不该进 chips。
        {
          runId: "run_2",
          siteId: "artifact#3",
          ordinal: 3,
          kind: "artifact",
          inputHash: "h",
          status: "errored",
          artifactId: "broken",
          error: { code: "ArtifactSourceMissing", message: "gone" },
        },
        artifactRow("run_2", "perf", 1, { kind: "chart", spec: { x: { field: "round" } } }),
      ],
      run_1: [],
    };
    const journal = {
      countNodesByStatus: () => ({ completed: 0, failed: 0, running: 0 }),
      getRunRow: () => undefined,
      listRecentLogEvents: () => [],
      listRuns: (query: unknown) =>
        [
          { runId: "run_2", status: "completed", spentTokens: 1, timeCreated: 1, timeUpdated: 2 },
          { runId: "run_1", status: "errored", spentTokens: 1, timeCreated: 1, timeUpdated: 2 },
        ].slice(0, (query as { limit: number }).limit),
      listArtifactRows: (runId: string) => artifactRows[runId] ?? [],
      // 预置看板在场时才会被调到：标签 report 行的计数。
      listNodes: (runId: string) =>
        runId === "run_2"
          ? [
              { runId, siteId: "report#1", ordinal: 1, kind: "report", inputHash: "h", status: "completed", artifactId: "perf", result: {} },
              { runId, siteId: "report#2", ordinal: 2, kind: "report", inputHash: "h", status: "completed", artifactId: "perf", result: {} },
              // 无标签的 report 不计入任何产物。
              { runId, siteId: "report#3", ordinal: 3, kind: "report", inputHash: "h", status: "completed", result: {} },
            ]
          : [],
    };
    const sessionStore = { workflowJournalStore: () => journal };

    const result = await listSavedWorkflowRunsOp(contextWith(sessionStore), {
      workspace: workspace(),
      limit: 5,
    });
    expect(() => zcodeWorkflowsRunsResultSchema.parse(result)).not.toThrow();
    // 顶层字段取最新版（title 是 v2 的「审计报告」而不是 v1 的「旧版」）；失败行不出现。
    expect(result.runs[0]?.artifacts).toEqual([
      { id: "audit", kind: "file", title: "审计报告", version: 2, contentType: "application/pdf" },
      { id: "perf", kind: "chart", version: 1 },
    ]);
    // 字节 / 条目 / spec 刻意不进中枢载荷：chip 上放不下，点开侧板即可。
    expect(JSON.stringify(result.runs[0]?.artifacts)).not.toContain("4096");
    expect(JSON.stringify(result.runs[0]?.artifacts)).not.toContain("round");
    // 零件的 run：整字段缺席，不是空数组。
    expect(result.runs[1]).not.toHaveProperty("artifacts");
  });
});

// 全局作用域（docs/dynamic-workflow/launch.md）：五个方法的定向 `scope` 变体 + workflows/move。
// 全局档落在隔离的 `<HOME>/.zcode/workflows/`（见顶部 beforeEach）；同名的项目档不受牵连。
describe("workflows/* 全局作用域与 workflows/move", () => {
  it("list：项目变体只列项目档 + dir=项目根（即使目录不存在）；全局变体只列全局档 + dir=全局根", async () => {
    // 项目根不存在也回 dir（GUI 靠它 watch）。
    expect(
      await listSavedWorkflowsOp(contextWith(), { workspace: workspace(), scope: "project" }),
    ).toEqual({
      workflows: [],
      invalid: [],
      dir: projectDir(),
    });
    expect(
      await listSavedWorkflowsOp(contextWith(), { workspace: workspace(), scope: "global" }),
    ).toEqual({
      workflows: [],
      invalid: [],
      dir: globalDir(),
    });

    await seedWorkflow("proj-only", { description: "本项目档" });
    await seedGlobalWorkflow("global-only", { description: "全局档" });

    const proj = await listSavedWorkflowsOp(contextWith(), {
      workspace: workspace(),
      scope: "project",
    });
    expect(() => zcodeWorkflowsListResultSchema.parse(proj)).not.toThrow();
    expect(proj.dir).toBe(projectDir());
    expect(proj.workflows.map((entry) => entry.name)).toEqual(["proj-only"]);
    expect(proj.workflows[0]).toMatchObject({ scope: "project" });

    const glob = await listSavedWorkflowsOp(contextWith(), {
      workspace: workspace(),
      scope: "global",
    });
    expect(() => zcodeWorkflowsListResultSchema.parse(glob)).not.toThrow();
    expect(glob.dir).toBe(globalDir());
    expect(glob.workflows.map((entry) => entry.name)).toEqual(["global-only"]);
    expect(glob.workflows[0]).toMatchObject({
      scope: "global",
      path: join(globalDir(), "global-only.dwf.ts"),
    });
  });

  it("list：同名在两档都在时——项目变体只见项目档、全局变体只见全局档（定向列表不做遮蔽）", async () => {
    await seedWorkflow("shared", { description: "项目那份" });
    await seedGlobalWorkflow("shared", { description: "全局那份" });

    const proj = await listSavedWorkflowsOp(contextWith(), {
      workspace: workspace(),
      scope: "project",
    });
    expect(proj.workflows).toMatchObject([
      { name: "shared", description: "项目那份", scope: "project" },
    ]);

    const glob = await listSavedWorkflowsOp(contextWith(), {
      workspace: workspace(),
      scope: "global",
    });
    expect(glob.workflows).toMatchObject([
      { name: "shared", description: "全局那份", scope: "global" },
    ]);
  });

  it("get：scope:global 读全局档、不被同名项目档遮蔽；默认（无 scope）读项目档", async () => {
    await seedWorkflow("shared", { description: "项目那份" });
    await seedGlobalWorkflow("shared", { description: "全局那份" });

    const glob = await getSavedWorkflowOp(contextWith(), {
      workspace: workspace(),
      name: "shared",
      scope: "global",
    });
    expect(() => zcodeWorkflowsGetResultSchema.parse(glob)).not.toThrow();
    expect(glob).toMatchObject({
      ok: true,
      name: "shared",
      scope: "global",
      path: join(globalDir(), "shared.dwf.ts"),
      meta: { description: "全局那份" },
    });

    const def = await getSavedWorkflowOp(contextWith(), { workspace: workspace(), name: "shared" });
    expect(def).toMatchObject({ ok: true, scope: "project", meta: { description: "项目那份" } });

    // 只在全局档存在：项目变体 not_found，全局变体命中。
    await seedGlobalWorkflow("global-only", { description: "只全局" });
    expect(
      await getSavedWorkflowOp(contextWith(), {
        workspace: workspace(),
        name: "global-only",
        scope: "project",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await getSavedWorkflowOp(contextWith(), {
        workspace: workspace(),
        name: "global-only",
        scope: "global",
      }),
    ).toMatchObject({ ok: true, scope: "global" });
  });

  it("updateMeta：scope:global 改全局档、同名项目档逐字不动", async () => {
    const projPath = await seedWorkflow("shared", { description: "项目原样" });
    await seedGlobalWorkflow("shared", { description: "全局旧说明" });
    const projBefore = await readFile(projPath, "utf8");

    const updated = await updateSavedWorkflowMetaOp(contextWith(), {
      workspace: workspace(),
      name: "shared",
      meta: { description: "全局新说明" },
      scope: "global",
    });
    expect(() => zcodeWorkflowsUpdateMetaResultSchema.parse(updated)).not.toThrow();
    expect(updated).toEqual({ ok: true, path: join(globalDir(), "shared.dwf.ts") });

    const globParsed = parseSavedWorkflow(
      await readFile(join(globalDir(), "shared.dwf.ts"), "utf8"),
    );
    expect(globParsed.ok).toBe(true);
    if (!globParsed.ok) throw new Error("unreachable");
    expect(globParsed.meta.description).toBe("全局新说明");
    // 项目档逐字不变。
    expect(await readFile(projPath, "utf8")).toBe(projBefore);
  });

  it("delete：scope:global 删全局档、同名项目档留存；按 scope 选根（不写死 roots[0]）", async () => {
    const projPath = await seedWorkflow("shared", { description: "项目那份" });
    const globPath = await seedGlobalWorkflow("shared", { description: "全局那份" });

    const deleted = await deleteSavedWorkflowOp(contextWith(), {
      workspace: workspace(),
      name: "shared",
      scope: "global",
    });
    expect(() => zcodeWorkflowsDeleteResultSchema.parse(deleted)).not.toThrow();
    expect(deleted).toEqual({ ok: true, path: globPath });
    await expect(readFile(globPath, "utf8")).rejects.toThrow();
    // 项目档留存。
    await expect(readFile(projPath, "utf8")).resolves.toContain("项目那份");
    expect(
      (await listSavedWorkflowsOp(contextWith(), { workspace: workspace(), scope: "project" }))
        .workflows,
    ).toHaveLength(1);
    expect(
      (await listSavedWorkflowsOp(contextWith(), { workspace: workspace(), scope: "global" }))
        .workflows,
    ).toEqual([]);
  });

  it("runs：全局变体跨 cwd（省 cwd 谓词）、每行带 cwd；项目变体仍按 cwd 过滤", async () => {
    const queries: unknown[] = [];
    const rows = [
      {
        runId: "run_b",
        name: "research",
        status: "completed",
        spentTokens: 100,
        timeCreated: 20,
        timeUpdated: 30,
        cwd: "/repos/beta",
        caps: { maxConcurrency: 1 },
      },
      {
        runId: "run_a",
        name: "research",
        status: "errored",
        spentTokens: 50,
        timeCreated: 5,
        timeUpdated: 10,
        cwd: "/repos/alpha",
        caps: { maxConcurrency: 1 },
      },
    ];
    const journal = {
      countNodesByStatus: () => ({ completed: 0, failed: 0, running: 0 }),
      getRunRow: () => undefined,
      listRecentLogEvents: () => [],
      listRuns: (query: unknown) => {
        queries.push(query);
        return rows.slice(0, (query as { limit: number }).limit);
      },
    };
    const sessionStore = { workflowJournalStore: () => journal };

    const glob = await listSavedWorkflowRunsOp(contextWith(sessionStore), {
      workspace: workspace(),
      name: "research",
      limit: 10,
      scope: "global",
    });
    expect(() => zcodeWorkflowsRunsResultSchema.parse(glob)).not.toThrow();
    // 全局变体：查询袋没有 cwd 键（跨所有项目）。
    expect(queries).toEqual([{ limit: 11, name: "research" }]);
    expect(glob.runs).toEqual([
      {
        runId: "run_b",
        name: "research",
        status: "completed",
        createdAt: 20,
        updatedAt: 30,
        spentTokens: 100,
        cwd: "/repos/beta",
      },
      {
        runId: "run_a",
        name: "research",
        status: "errored",
        createdAt: 5,
        updatedAt: 10,
        spentTokens: 50,
        cwd: "/repos/alpha",
      },
    ]);

    // 项目变体：仍带 cwd 谓词。
    await listSavedWorkflowRunsOp(contextWith(sessionStore), {
      workspace: workspace(),
      name: "research",
      limit: 10,
      scope: "project",
    });
    expect(queries.at(-1)).toEqual({ cwd, limit: 11, name: "research" });
  });

  // move 只有全局→项目一向（docs/dynamic-workflow/launch.md「Promote to global」）：项目→全局
  // 是模型的概括「提升为全局」，协议上没有那一向。
  it("move：全局→项目成功——逐字节相同、源删除、结果 {ok, from, to}（无 to 参数）", async () => {
    const globPath = await seedGlobalWorkflow("mover", {
      description: "回项目",
      args: { target: { type: "string", required: true } },
    });
    const before = await readFile(globPath, "utf8");

    const result = await moveSavedWorkflowOp(contextWith(), {
      workspace: workspace(),
      name: "mover",
    });
    expect(() => zcodeWorkflowsMoveResultSchema.parse(result)).not.toThrow();
    const projPath = join(projectDir(), "mover.dwf.ts");
    expect(result).toEqual({ ok: true, from: globPath, to: projPath });
    // 源已删。
    await expect(readFile(globPath, "utf8")).rejects.toThrow();
    // 目标逐字节相同。
    expect(await readFile(projPath, "utf8")).toBe(before);
  });

  it("move：带 to 参数被 -32602 拒（那一向已不存在）", async () => {
    await seedWorkflow("mover", { description: "项目那份" });
    await expect(
      moveSavedWorkflowOp(contextWith(), { workspace: workspace(), name: "mover", to: "global" }),
    ).rejects.toThrow();
    // 项目档原样不动。
    await expect(readFile(join(projectDir(), "mover.dwf.ts"), "utf8")).resolves.toContain(
      "项目那份",
    );
  });

  it("move：target_exists（项目里已有同名，不覆盖）带项目落点 path", async () => {
    const projPath = await seedWorkflow("dup", { description: "项目那份" });
    const globPath = await seedGlobalWorkflow("dup", { description: "全局那份" });

    const result = await moveSavedWorkflowOp(contextWith(), {
      workspace: workspace(),
      name: "dup",
    });
    expect(() => zcodeWorkflowsMoveResultSchema.parse(result)).not.toThrow();
    expect(result).toEqual({ ok: false, reason: "target_exists", path: projPath });
    // 两份都还在。
    await expect(readFile(join(projectDir(), "dup.dwf.ts"), "utf8")).resolves.toContain("项目那份");
    await expect(readFile(globPath, "utf8")).resolves.toContain("全局那份");
  });

  it("move：not_found（全局根没有这个名字；项目档不是源）与 invalid_name（名字先验）", async () => {
    await seedWorkflow("ghost", { description: "只在项目里" });
    expect(
      await moveSavedWorkflowOp(contextWith(), {
        workspace: workspace(),
        name: "ghost",
      }),
    ).toEqual({ ok: false, reason: "not_found" });

    const invalid = await moveSavedWorkflowOp(contextWith(), {
      workspace: workspace(),
      name: "../etc",
    });
    expect(invalid).toMatchObject({ ok: false, reason: "invalid_name" });
    expect(() => zcodeWorkflowsMoveResultSchema.parse(invalid)).not.toThrow();
  });
});
