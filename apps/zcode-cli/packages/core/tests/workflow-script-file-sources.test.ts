import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionEventType,
  WORKFLOW_DRAFTS_DIR,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunAmendRequest,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSnapshot,
  type DynamicWorkflowRunSubmitRequest,
  type PermissionRequestedPayload,
  type SaveWorkflowOutput,
  type SessionEvent,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { amendWorkflowToolEntry } from "../src/tool/handlers/amend-workflow.js";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import { saveWorkflowToolEntry } from "../src/tool/handlers/save-workflow.js";
import {
  saveSavedWorkflow,
  serializeSavedWorkflow,
} from "../src/tool/handlers/saved-workflows/index.js";
import { createToolRegistry } from "../src/tool/registry.js";

// docs/dynamic-workflow/launch.md「Script files」：每一段脚本都有个盘上的家，而那个文件就是
// 模型两次提交之间的把手。这里端到端地钉四件事：草稿真的被写下来、诊断按文件行报、`path`
// 回程真的能跑、以及「文件没改过」的修订被挡在任何窗口之前。

const cwds: string[] = [];

function makeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwf-file-sources-"));
  cwds.push(dir);
  return dir;
}

afterEach(() => {
  while (cwds.length > 0) rmSync(cwds.pop()!, { force: true, recursive: true });
});

/** 记忆槽按脚本原文取键，所以每个用例用自己的脚本。 */
function cleanScript(actor: string): string {
  return [
    "interface R { done: boolean }",
    `const r = await agent("${actor}").ask<R>("do");`,
    "return r.done;",
  ].join("\n");
}

const BROKEN_SCRIPT = 'const broken: number = "not a number";';

function draftPath(cwd: string, fileName: string): string {
  return join(cwd, WORKFLOW_DRAFTS_DIR, fileName);
}

interface StubPort {
  port: DynamicWorkflowRunPort;
  submits: DynamicWorkflowRunSubmitRequest[];
  amends: DynamicWorkflowRunAmendRequest[];
  getScriptCalls: string[];
}

/** run 端口桩。`runScript` 缺席即端口**没有** `getScript`（老宿主的形状）。 */
function stubRunPort(
  options: { runScript?: string; snapshot?: Partial<DynamicWorkflowRunSnapshot> } = {},
): StubPort {
  const submits: DynamicWorkflowRunSubmitRequest[] = [];
  const amends: DynamicWorkflowRunAmendRequest[] = [];
  const getScriptCalls: string[] = [];
  const port = {
    async submit(request: DynamicWorkflowRunSubmitRequest) {
      submits.push(request);
      return { ok: true, runId: "dwfrun-new" };
    },
    async amend(request: DynamicWorkflowRunAmendRequest) {
      amends.push(request);
      return { ok: true, runId: "dwfrun-amended" };
    },
    async getTask(taskId: string) {
      return {
        runId: taskId,
        taskId,
        startedAt: new Date(0),
        status: "running",
        ...options.snapshot,
      } as DynamicWorkflowRunSnapshot;
    },
    ...(options.runScript === undefined
      ? {}
      : {
          async getScript(runId: string) {
            getScriptCalls.push(runId);
            return options.runScript;
          },
        }),
  } as unknown as DynamicWorkflowRunPort;
  return { port, submits, amends, getScriptCalls };
}

interface RunOutcome {
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

async function run(options: {
  input: Record<string, unknown>;
  name: string;
  port?: DynamicWorkflowRunPort;
  toolName: string;
  workingDirectory: string;
}): Promise<RunOutcome> {
  const sessionId = createSessionId(options.name);
  const turnId = createTurnId(options.name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];

  const registry = createToolRegistry();
  registry.register(createWorkflowToolEntry);
  registry.register(amendWorkflowToolEntry);
  registry.register(saveWorkflowToolEntry);

  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    ...(options.port ? { dynamicWorkflowRunPort: options.port } : {}),
    mode: "build",
    permissionBroker: {
      async requestPermission() {
        return { decision: "allow" as const };
      },
    },
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    turnId,
    traceContext,
    workingDirectory: options.workingDirectory,
  });

  const result = await executor.execute(
    { id: createToolCallId(options.name), input: options.input, name: options.toolName },
    { traceContext },
  );
  return {
    permissionRequested: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload),
    result,
  };
}

describe("CreateWorkflow — source XOR and args", () => {
  it.each([
    ["all three", { script: "return 1;", saved: { name: "x" }, path: "a.dwf.ts" }],
    ["script and path", { script: "return 1;", path: "a.dwf.ts" }],
    ["saved and path", { saved: { name: "x" }, path: "a.dwf.ts" }],
    ["none", {}],
  ])("refuses a %s call before the gate", async (label, input) => {
    const outcome = await run({
      input,
      name: `xor-${label.replace(/\s/gu, "-")}`,
      toolName: "CreateWorkflow",
      workingDirectory: makeCwd(),
    });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message ?? "").toContain("exactly one workflow source");
  });

  it("refuses `args` without `path`: a saved call has `saved.args`, an inline script has none", async () => {
    const outcome = await run({
      input: { script: "return 1;", args: { pr: "1" } },
      name: "args-without-path",
      toolName: "CreateWorkflow",
      workingDirectory: makeCwd(),
    });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message ?? "").toContain("`args` belongs to the `path` source");
  });
});

describe("CreateWorkflow — inline drafts", () => {
  it("a non-compiling inline script still lands on disk, and the diagnostics point at that file", async () => {
    const cwd = makeCwd();
    const { port, submits } = stubRunPort();
    const outcome = await run({
      input: { name: "triage", script: BROKEN_SCRIPT },
      name: "inline-broken",
      port,
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(submits).toHaveLength(0);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    const draft = draftPath(cwd, "triage.dwf.ts");
    expect(readFileSync(draft, "utf8")).toBe(BROKEN_SCRIPT);
    // 文案给的是工作区相对写法，行号按文件数（无元数据块，所以与正文行相同）。
    const described = join(WORKFLOW_DRAFTS_DIR, "triage.dwf.ts");
    expect(output.response).toContain(`${described}:L1:C`);
    expect(output.response).toContain(`The script is saved at ${described}.`);
    expect(output.response).toContain(`resubmit with \`path: "${described}"\``);
    expect(output.response).toContain("do not paste the script inline again");
    // display / 输出里的诊断数组仍按**正文行**：转录面画的是正文。
    expect(output.diagnostics[0]!.line).toBe(1);
  });

  it("a launched inline run records the draft and tells the model to edit it next time", async () => {
    const cwd = makeCwd();
    const script = cleanScript("inline-launch");
    const { port, submits } = stubRunPort();
    const outcome = await run({
      input: { name: "nightly", script },
      name: "inline-launch",
      port,
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    const draft = draftPath(cwd, "nightly.dwf.ts");
    expect(submits[0]!.scriptPath).toBe(draft);
    expect(readFileSync(draft, "utf8")).toBe(script);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.status).toBe("backgrounded");
    expect(output.response).toContain(
      `The script is saved at ${join(WORKFLOW_DRAFTS_DIR, "nightly.dwf.ts")}; to revise it later, edit that file and pass \`path\` to AmendWorkflow.`,
    );
  });

  it("falls back to the old note, and to no scriptPath, when the draft cannot be written", async () => {
    const cwd = makeCwd();
    // `.zcode` 是个普通文件 → 草稿目录建不出来。尽力而为：调用照常完成。
    writeFileSync(join(cwd, ".zcode"), "not a directory", "utf8");
    const { port, submits } = stubRunPort();

    const broken = await run({
      input: { script: BROKEN_SCRIPT },
      name: "draft-write-failed",
      port,
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });
    const brokenOutput = broken.result.output as CreateWorkflowOutput;
    expect(brokenOutput.response).toContain(
      "NOTE: The workflow was NOT executed — fix the errors above and resubmit.",
    );
    expect(brokenOutput.response).not.toContain("workflow-drafts");
    expect(brokenOutput.response).toContain("L1:C");

    const clean = await run({
      input: { script: cleanScript("no-draft") },
      name: "draft-write-failed-clean",
      port,
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });
    expect(submits).toHaveLength(1);
    expect("scriptPath" in submits[0]!).toBe(false);
    expect((clean.result.output as CreateWorkflowOutput).response).not.toContain("edit that file");
  });
});

describe("CreateWorkflow — the `path` source", () => {
  it("accepts a workspace-relative path and runs the file's bytes", async () => {
    const cwd = makeCwd();
    const script = cleanScript("path-relative");
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "scripts", "check.dwf.ts"), script, "utf8");
    const { port, submits } = stubRunPort();

    const outcome = await run({
      input: { path: "scripts/check.dwf.ts" },
      name: "path-relative",
      port,
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    // 归一化把文件读成 `script`，路径写成绝对形；确认窗看到的就是将要执行的字节。
    expect(outcome.permissionRequested[0]!.input).toEqual({
      script,
      path: join(cwd, "scripts", "check.dwf.ts"),
      // 确认窗可调的设置（docs/dynamic-workflow/launch.md「Adjusting the settings in the window」）。
      adjustable_settings: { subagent_model: false },
    });
    expect(submits[0]!.scriptText).toBe(script);
    expect(submits[0]!.scriptPath).toBe(join(cwd, "scripts", "check.dwf.ts"));
    // `path` 来源的文件不是工具写下的，所以说的是「脚本文件是 …」而不是「已保存到 …」。
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      `The script file is ${join("scripts", "check.dwf.ts")};`,
    );
    // 已经是工作副本了，不再抄一份。
    expect(() => readFileSync(draftPath(cwd, "check.dwf.ts"), "utf8")).toThrow();
  });

  it("accepts an absolute path outside the workspace and reports it absolute", async () => {
    const cwd = makeCwd();
    const elsewhere = makeCwd();
    const script = cleanScript("path-absolute");
    const file = join(elsewhere, "outside.dwf.ts");
    writeFileSync(file, script, "utf8");
    const { port, submits } = stubRunPort();

    const outcome = await run({
      input: { path: file },
      name: "path-absolute",
      port,
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(submits[0]!.scriptPath).toBe(file);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      `The script file is ${file};`,
    );
  });

  it("parses a metadata block, validates `args` against it and reports diagnostics in file lines", async () => {
    const cwd = makeCwd();
    const body =
      'const depth: number = args.depth as number;\nconst bad: number = "x";\nreturn depth;';
    const file = join(cwd, "with-meta.dwf.ts");
    writeFileSync(
      file,
      serializeSavedWorkflow(
        { description: "declared", args: { depth: { type: "number", default: 2 } } },
        body,
      ),
      "utf8",
    );
    const { port } = stubRunPort();

    const outcome = await run({
      input: { path: "with-meta.dwf.ts", args: { depth: 5 } },
      name: "path-meta",
      port,
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    // 正文第 2 行的诊断 = 文件第 2 + offset 行；offset 由元数据块的行数决定。
    const fileLines = readFileSync(file, "utf8").split("\n");
    const offset = fileLines.findIndex(
      (line) => line === "const depth: number = args.depth as number;",
    );
    expect(output.diagnostics[0]!.line).toBe(2);
    expect(output.response).toContain(`with-meta.dwf.ts:L${2 + offset}:C`);
  });

  it("runs a declared file with its arguments, defaults filled in", async () => {
    const cwd = makeCwd();
    writeFileSync(
      join(cwd, "declared.dwf.ts"),
      serializeSavedWorkflow(
        {
          description: "declared",
          args: {
            depth: { type: "number", default: 2 },
            target: { type: "string", required: true },
          },
        },
        cleanScript("declared"),
      ),
      "utf8",
    );
    const { port, submits } = stubRunPort();

    await run({
      input: { path: "declared.dwf.ts", args: { target: "pkg" } },
      name: "path-args",
      port,
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(submits[0]!.args).toEqual({ depth: 2, target: "pkg" });
  });

  it("rejects `args` for a file with no metadata block, before the gate", async () => {
    const cwd = makeCwd();
    writeFileSync(join(cwd, "plain.dwf.ts"), cleanScript("plain"), "utf8");
    const outcome = await run({
      input: { path: "plain.dwf.ts", args: { depth: 1 } },
      name: "path-args-undeclared",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.error?.message ?? "").toContain("declares no arguments");
  });

  it("names the file when it cannot be read", async () => {
    const cwd = makeCwd();
    const outcome = await run({
      input: { path: "missing.dwf.ts" },
      name: "path-missing",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.error?.message ?? "").toContain("missing.dwf.ts could not be read");
  });
});

describe("AmendWorkflow — file sources", () => {
  it("refuses a `path` submission whose bytes are the predecessor's script", async () => {
    const cwd = makeCwd();
    const script = cleanScript("amend-unchanged");
    writeFileSync(join(cwd, "run.dwf.ts"), script, "utf8");
    const { port, amends, getScriptCalls } = stubRunPort({ runScript: script });

    const outcome = await run({
      input: { run_id: "dwfrun-prev", path: "run.dwf.ts" },
      name: "amend-unchanged",
      port,
      toolName: "AmendWorkflow",
      workingDirectory: cwd,
    });

    expect(getScriptCalls).toEqual(["dwfrun-prev"]);
    expect(amends).toHaveLength(0);
    expect(outcome.permissionRequested).toHaveLength(0);
    const error = outcome.result.error?.message ?? "";
    expect(error).toContain("workflow_script_unchanged");
    expect(error).toContain("run.dwf.ts");
    expect(error).toContain("Edit the file first");
    expect(error).toContain("ResumeWorkflowRun");
    expect(error).toContain("Nothing was stopped or created.");
  });

  it("lets an unchanged script through when the call changes the limit or the model", async () => {
    const cwd = makeCwd();
    const script = cleanScript("amend-knob");
    writeFileSync(join(cwd, "run.dwf.ts"), script, "utf8");
    const { port, amends } = stubRunPort({ runScript: script });

    await run({
      input: { run_id: "dwfrun-prev", path: "run.dwf.ts", max_concurrency: 2 },
      name: "amend-knob",
      port,
      toolName: "AmendWorkflow",
      workingDirectory: cwd,
    });
    expect(amends).toHaveLength(1);
    expect(amends[0]!.maxConcurrency).toBe(2);

    await run({
      input: { run_id: "dwfrun-prev", path: "run.dwf.ts", subagent_model: null },
      name: "amend-knob-model",
      port,
      toolName: "AmendWorkflow",
      workingDirectory: cwd,
    });
    expect(amends).toHaveLength(2);
  });

  it("skips the check on a port without getScript", async () => {
    const cwd = makeCwd();
    const script = cleanScript("amend-no-read");
    writeFileSync(join(cwd, "run.dwf.ts"), script, "utf8");
    const { port, amends } = stubRunPort();

    await run({
      input: { run_id: "dwfrun-prev", path: "run.dwf.ts" },
      name: "amend-no-getrunscript",
      port,
      toolName: "AmendWorkflow",
      workingDirectory: cwd,
    });

    expect(amends).toHaveLength(1);
    expect(amends[0]!.scriptPath).toBe(join(cwd, "run.dwf.ts"));
  });

  it("never compares an inline script, and writes it to a draft the response names", async () => {
    const cwd = makeCwd();
    const script = cleanScript("amend-inline");
    const { port, amends } = stubRunPort({
      runScript: script,
      snapshot: { name: "前驱" },
    });

    const outcome = await run({
      input: { run_id: "dwfrun-prev", script },
      name: "amend-inline",
      port,
      toolName: "AmendWorkflow",
      workingDirectory: cwd,
    });

    // 内联提交从不比字节：这道网抓的是「忘了编辑」，而贴一遍脚本不是那个错误。
    expect(amends).toHaveLength(1);
    // 没有 `name` 时草稿沿用前驱的名字，中文原样进文件名（2026-09-18：ASCII slug 把每份草稿都
    // 压成 `workflow-N`，目录里分不出哪个是哪个）。
    const draft = draftPath(cwd, "前驱.dwf.ts");
    expect(readFileSync(draft, "utf8")).toBe(script);
    expect(amends[0]!.scriptPath).toBe(draft);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      `The revision's script is at ${join(WORKFLOW_DRAFTS_DIR, "前驱.dwf.ts")}; edit it there for a further revision.`,
    );
  });

  it("refuses a call that gives both a script and a path", async () => {
    const cwd = makeCwd();
    const outcome = await run({
      input: { run_id: "dwfrun-prev", script: "return 1;", path: "run.dwf.ts" },
      name: "amend-both-sources",
      toolName: "AmendWorkflow",
      workingDirectory: cwd,
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message ?? "").toContain("at most one revised script");
  });

  // 两个来源都不给 = 沿用前驱的脚本（docs/dynamic-workflow/launch.md「Keeping the predecessor's
  // script」）。沿用的脚本同样要有个家：前驱的脚本文件此刻仍是这份字节就继续记它，否则写新草稿。
  describe("neither source: the predecessor's script is kept, and so is its file when it still matches", () => {
    it("records the predecessor's script file again when its bytes are still the kept script", async () => {
      const cwd = makeCwd();
      const script = cleanScript("amend-keep-file");
      const file = draftPath(cwd, "kept.dwf.ts");
      mkdirSync(join(cwd, WORKFLOW_DRAFTS_DIR), { recursive: true });
      writeFileSync(file, script, "utf8");
      const { port, amends } = stubRunPort({ runScript: script, snapshot: { scriptPath: file } });

      const outcome = await run({
        port,
        input: { run_id: "dwfrun-prev", max_concurrency: 2 },
        name: "amend-keep-file",
        toolName: "AmendWorkflow",
        workingDirectory: cwd,
      });

      expect(outcome.result.success).toBe(true);
      expect(amends).toHaveLength(1);
      expect(amends[0]!.scriptText).toBe(script);
      expect(amends[0]!.scriptPath).toBe(file);
      // 没有新草稿：目录里仍只有那一个脚本文件（外加 .gitignore 与否都不算脚本）。
      expect(
        readdirSync(join(cwd, WORKFLOW_DRAFTS_DIR)).filter((entry) => entry.endsWith(".dwf.ts")),
      ).toEqual(["kept.dwf.ts"]);
      const output = outcome.result.output as CreateWorkflowOutput;
      expect(output.response).toContain("started unchanged in the background");
      expect(output.response).toContain(`${WORKFLOW_DRAFTS_DIR}/kept.dwf.ts`);
    });

    it("writes a fresh draft when the predecessor's file has been edited since", async () => {
      const cwd = makeCwd();
      const script = cleanScript("amend-keep-diverged");
      const file = draftPath(cwd, "edited.dwf.ts");
      mkdirSync(join(cwd, WORKFLOW_DRAFTS_DIR), { recursive: true });
      writeFileSync(file, `${script}\n// edited after the run started\n`, "utf8");
      const { port, amends } = stubRunPort({
        runScript: script,
        snapshot: { scriptPath: file, name: "diverged" },
      });

      const outcome = await run({
        port,
        input: { run_id: "dwfrun-prev", max_concurrency: 2 },
        name: "amend-keep-diverged",
        toolName: "AmendWorkflow",
        workingDirectory: cwd,
      });

      expect(outcome.result.success).toBe(true);
      // 跑的是存档的那一份，不是盘上被改过的那一份；记下的文件装的也必须是存档的那一份。
      expect(amends[0]!.scriptText).toBe(script);
      expect(amends[0]!.scriptPath).toBe(draftPath(cwd, "diverged.dwf.ts"));
      expect(readFileSync(amends[0]!.scriptPath!, "utf8")).toBe(script);
      // 用户正在改的那个文件一个字节都没动。
      expect(readFileSync(file, "utf8")).toContain("// edited after the run started");
    });

    it("writes a draft when the predecessor never recorded a file", async () => {
      const cwd = makeCwd();
      const script = cleanScript("amend-keep-no-file");
      const { port, amends } = stubRunPort({ runScript: script, snapshot: { name: "nofile" } });

      const outcome = await run({
        port,
        input: { run_id: "dwfrun-prev", subagent_model: null },
        name: "amend-keep-no-file",
        toolName: "AmendWorkflow",
        workingDirectory: cwd,
      });

      expect(outcome.result.success).toBe(true);
      expect(amends[0]!.scriptPath).toBe(draftPath(cwd, "nofile.dwf.ts"));
      expect(readFileSync(amends[0]!.scriptPath!, "utf8")).toBe(script);
    });
  });
});

describe("SaveWorkflow — `script_path`", () => {
  it("saves a draft's body and drops the metadata block it carries", async () => {
    const cwd = makeCwd();
    const body = cleanScript("save-from-draft");
    // 从保存定义抄来的草稿带着块；块要被丢掉，元数据以本次调用的字段为准。
    saveSavedWorkflow({ cwd, name: "origin", meta: { description: "old words" }, script: body });
    const draft = draftPath(cwd, "origin.dwf.ts");
    mkdirSync(join(cwd, WORKFLOW_DRAFTS_DIR), { recursive: true });
    writeFileSync(draft, readFileSync(join(cwd, ".zcode/workflows/origin.dwf.ts"), "utf8"), "utf8");

    const outcome = await run({
      input: {
        name: "from-draft",
        description: "new words",
        script_path: join(WORKFLOW_DRAFTS_DIR, "origin.dwf.ts"),
        scope: "project",
      },
      name: "save-script-path",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    const output = outcome.result.output as SaveWorkflowOutput;
    expect(output.ok).toBe(true);
    const saved = readFileSync(output.path, "utf8");
    expect(saved).toBe(serializeSavedWorkflow({ description: "new words" }, body));
    // 块只出现一次：草稿里那一份被丢掉了，而不是被叠在新块后面。
    expect(saved.split("/* zcode-workflow")).toHaveLength(2);
  });

  it("refuses a call that gives both sources, and one that gives neither", async () => {
    const cwd = makeCwd();
    for (const [label, extra] of [
      ["both", { script: "return 1;", script_path: "a.dwf.ts" }],
      ["neither", {}],
    ] as const) {
      const outcome = await run({
        input: { name: "x", description: "d", scope: "project", ...extra },
        name: `save-xor-${label}`,
        toolName: "SaveWorkflow",
        workingDirectory: cwd,
      });
      expect(outcome.result.success).toBe(false);
      expect(outcome.result.error?.message ?? "").toContain("exactly one script source");
    }
  });
});
