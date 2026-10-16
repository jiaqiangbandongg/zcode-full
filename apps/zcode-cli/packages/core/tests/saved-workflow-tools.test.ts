import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREATE_WORKFLOW_SOURCE_ERROR,
  CreateWorkflowInputSchema,
  HookEventName,
  SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR,
  SessionEventType,
  WORKFLOW_DRAFTS_DIR,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSubmitRequest,
  type ListSavedWorkflowsOutput,
  type PermissionBrokerPort,
  type PermissionRequestedPayload,
  type SaveWorkflowOutput,
  type SessionEvent,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import { saveWorkflowToolEntry } from "../src/tool/handlers/save-workflow.js";
import { listSavedWorkflowsToolEntry } from "../src/tool/handlers/list-saved-workflows.js";
import { builtInTools } from "../src/tool/handlers/index.js";
import { saveSavedWorkflow } from "../src/tool/handlers/saved-workflows/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { HookRunner } from "../src/hooks/index.js";

const cwds: string[] = [];

function makeCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwf-tools-"));
  cwds.push(dir);
  return dir;
}

/** 一个隔离的家目录，供全局档用例注入。 */
function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dwf-tools-home-"));
  cwds.push(dir);
  return dir;
}

// 生产的全局根取 os.homedir()（POSIX 上认 $HOME）。handler 不接收 homeDir，所以把 HOME
// 指到一个空临时目录，让全局档落点与「哪都没有」的错误文案在测试里可控、可复现。
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let testHome: string;
beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  testHome = makeHome();
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  while (cwds.length > 0) rmSync(cwds.pop()!, { force: true, recursive: true });
});

/** 全局档落点（HOME 已被 beforeEach 指到 testHome）。 */
function globalSavedPath(name: string): string {
  return join(testHome, ".zcode/workflows", `${name}.dwf.ts`);
}

// 记忆槽是单槽、按脚本原文取键，所以每个用例用自己的脚本；否则上一个用例存下的分析
// 会直接满足下一个用例的断言。
function cleanScript(actor: string): string {
  return [
    "interface R { done: boolean }",
    `const r = await agent("${actor}").ask<R>("do");`,
    "return r.done;",
  ].join("\n");
}

interface RunOptions {
  broker?: PermissionBrokerPort;
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  hookRunner?: HookRunner;
  input: Record<string, unknown>;
  name: string;
  toolName: string;
  workingDirectory: string;
}

interface RunOutcome {
  events: SessionEvent[];
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

function stubRunPort(runId: string): {
  port: DynamicWorkflowRunPort;
  submits: DynamicWorkflowRunSubmitRequest[];
} {
  const submits: DynamicWorkflowRunSubmitRequest[] = [];
  return {
    port: {
      async submit(request) {
        submits.push(request);
        // submit 的结果是判别联合（amend-resume 的三道门可以拒绝一次提交）；桩恒接受。
        return { ok: true, runId };
      },
    } as unknown as DynamicWorkflowRunPort,
    submits,
  };
}

async function run(options: RunOptions): Promise<RunOutcome> {
  const sessionId = createSessionId(options.name);
  const turnId = createTurnId(options.name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];

  const registry = createToolRegistry();
  registry.register(createWorkflowToolEntry);
  registry.register(saveWorkflowToolEntry);
  registry.register(listSavedWorkflowsToolEntry);

  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    ...(options.dynamicWorkflowRunPort
      ? { dynamicWorkflowRunPort: options.dynamicWorkflowRunPort }
      : {}),
    ...(options.hookRunner ? { hookRunner: options.hookRunner } : {}),
    mode: "build",
    permissionBroker: options.broker ?? {
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
    events,
    permissionRequested: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload),
    result,
  };
}

const DENY: PermissionBrokerPort = {
  async requestPermission() {
    return { decision: "deny", reason: "User declined" };
  },
};

function savedPath(cwd: string, name: string): string {
  return join(cwd, ".zcode/workflows", `${name}.dwf.ts`);
}

describe("SaveWorkflow", () => {
  it("writes the file after the confirmation, with the metadata block ahead of the script", async () => {
    const cwd = makeCwd();
    const script = cleanScript("save-clean");

    const outcome = await run({
      input: {
        name: "pr-review",
        description: "Review a pull request",
        whenToUse: "When the user asks for a PR review",
        args: { pr: { type: "string", required: true, description: "PR number" } },
        script,
        scope: "project",
      },
      name: "save-clean",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.result.success).toBe(true);

    const output = outcome.result.output as SaveWorkflowOutput;
    expect(output.ok).toBe(true);
    expect(output.overwritten).toBe(false);
    expect(output.scope).toBe("project");
    expect(output.path).toBe(savedPath(cwd, "pr-review"));

    // 逐字节：脚本本体是 run 的 script_hash 的基准，序列化不许顺手规范化它。
    expect(readFileSync(output.path, "utf8")).toBe(
      [
        "/* zcode-workflow",
        "description: Review a pull request",
        "whenToUse: When the user asks for a PR review",
        "args:",
        "  pr:",
        "    type: string",
        "    description: PR number",
        "    required: true",
        "*/",
        script,
      ].join("\n"),
    );
  });

  // 归一化 (c)：确认窗要展示的一切都在**入参**里，display 一个字段都不加。入参通道对每个
  // 客户端版本都是无 schema 的透传，所以旧桌面与 legacy v3 也拿得到完整内容。
  it("asks with no display, carrying path/overwrite/scope and the full script in the input", async () => {
    const cwd = makeCwd();
    const script = cleanScript("save-preview");

    const outcome = await run({
      input: { name: "preview", description: "shows up in the window", script, scope: "project" },
      name: "save-preview",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    const payload = outcome.permissionRequested[0]!;
    expect(payload.display).toBeUndefined();
    // 持久项目规则记不住"这一次的决定"，只会把这道确认永久关掉。
    expect(payload.optionsPolicy).toBe("no-always-allow");
    expect(payload.input).toEqual({
      name: "preview",
      description: "shows up in the window",
      script,
      scope: "project",
      path: savedPath(cwd, "preview"),
      overwrite: false,
    });
  });

  // 「覆盖」与「新建」必须是窗口上两句不同的话：批准一次覆盖就是同意丢掉磁盘上那一份。
  it("flags an overwrite in the gate input when the name is already taken", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({ cwd, name: "taken", meta: { description: "old" }, script: "return 1;" });

    const outcome = await run({
      input: {
        name: "taken",
        description: "new",
        script: cleanScript("save-overwrite"),
        scope: "project",
      },
      name: "save-overwrite",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect((outcome.permissionRequested[0]!.input as { overwrite: boolean }).overwrite).toBe(true);
    const output = outcome.result.output as SaveWorkflowOutput;
    expect(output.overwritten).toBe(true);
    expect(readFileSync(output.path, "utf8")).toContain("description: new");
  });

  // 让用户批准一段编不过的代码，只会用一个不产生任何效果的决策打断改错回路。
  it("returns diagnostics for a broken script without asking and without writing", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "broken",
        description: "will not compile",
        script: 'const x: number = "s";',
        scope: "project",
      },
      name: "save-broken",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as SaveWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    expect(output.overwritten).toBeUndefined();
    expect(existsSync(savedPath(cwd, "broken"))).toBe(false);
  });

  it("rejects an unusable name before the gate and without touching the disk", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "../evil",
        description: "traversal",
        script: cleanScript("save-traversal"),
        scope: "project",
      },
      name: "save-traversal",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain("not a usable workflow name");
    expect(existsSync(join(cwd, ".zcode"))).toBe(false);
  });

  // encode 的幂等性（文件里永远只有一个 frontmatter 块）靠这条守：不做「检测到就替换」的
  // 聪明合并，否则模型无从分辨自己传的元数据和文件里那个哪一个生效。
  it("rejects a script that already carries a metadata block", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "double",
        description: "already has frontmatter",
        script: `/* zcode-workflow\ndescription: smuggled\n*/\n${cleanScript("save-sentinel")}`,
        scope: "project",
      },
      name: "save-sentinel",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toBe(SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR);
    expect(existsSync(savedPath(cwd, "double"))).toBe(false);
  });

  it("writes nothing when the confirmation is denied", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      broker: DENY,
      input: {
        name: "denied",
        description: "not this time",
        script: cleanScript("save-deny"),
        scope: "project",
      },
      name: "save-deny",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.type).toBe("permission_denied");
    expect(existsSync(savedPath(cwd, "denied"))).toBe(false);
  });

  // 作用域是模型必填：没有默认值，schema 直接拒。
  it("fails schema validation when scope is omitted", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "no-scope",
        description: "missing scope",
        script: cleanScript("save-no-scope"),
      },
      name: "save-no-scope",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(existsSync(savedPath(cwd, "no-scope"))).toBe(false);
  });

  // 全局档：落点在注入的 HOME 下，resolveInput 按 scope 选根算出它。
  it("backfills the global path and writes under the home dir for scope global", async () => {
    const cwd = makeCwd();
    const script = cleanScript("save-global");

    const outcome = await run({
      input: { name: "research", description: "deep research", script, scope: "global" },
      name: "save-global",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.permissionRequested[0]!.input).toEqual({
      name: "research",
      description: "deep research",
      script,
      scope: "global",
      path: globalSavedPath("research"),
      overwrite: false,
    });

    const output = outcome.result.output as SaveWorkflowOutput;
    expect(output.scope).toBe("global");
    expect(output.path).toBe(globalSavedPath("research"));
    expect(output.response).toContain("Saved global workflow 'research'");
    // 项目目录一个字节都没被建出来。
    expect(existsSync(join(cwd, ".zcode"))).toBe(false);
    expect(existsSync(globalSavedPath("research"))).toBe(true);
  });

  // shadowing 回填 hides_global：保存项目档而全局档已有同名。
  it("backfills shadowing=hides_global when a global copy already exists", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "global one" },
      script: "return 1;",
      scope: "global",
    });

    const outcome = await run({
      input: {
        name: "dup",
        description: "project one",
        script: cleanScript("save-shadow-p"),
        scope: "project",
      },
      name: "save-shadow-project",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect((outcome.permissionRequested[0]!.input as { shadowing?: string }).shadowing).toBe(
      "hides_global",
    );
  });

  // shadowing 回填 hidden_by_project：保存全局档而项目档已有同名。
  it("backfills shadowing=hidden_by_project when a project copy already exists", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "project one" },
      script: "return 1;",
    });

    const outcome = await run({
      input: {
        name: "dup",
        description: "global one",
        script: cleanScript("save-shadow-g"),
        scope: "global",
      },
      name: "save-shadow-global",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect((outcome.permissionRequested[0]!.input as { shadowing?: string }).shadowing).toBe(
      "hidden_by_project",
    );
  });

  // 无同名时 shadowing 键缺席（不挂噪音字段）。
  it("omits the shadowing key when no other scope has the name", async () => {
    const cwd = makeCwd();

    const outcome = await run({
      input: {
        name: "solo",
        description: "unique",
        script: cleanScript("save-solo"),
        scope: "project",
      },
      name: "save-solo",
      toolName: "SaveWorkflow",
      workingDirectory: cwd,
    });

    expect("shadowing" in (outcome.permissionRequested[0]!.input as object)).toBe(false);
  });
});

describe("ListSavedWorkflows", () => {
  it("lists definitions with their arguments and never the script body", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "triage",
      meta: {
        description: "Triage the inbox",
        whenToUse: "Every morning",
        args: { limit: { type: "number", default: 10 } },
      },
      script: cleanScript("list-triage"),
    });

    const outcome = await run({
      input: {},
      name: "list-saved",
      toolName: "ListSavedWorkflows",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    const output = outcome.result.output as ListSavedWorkflowsOutput;
    expect(output.workflows).toHaveLength(1);
    expect(output.workflows[0]!.name).toBe("triage");
    expect(output.invalid).toBeUndefined();

    const modelContent = String(outcome.result.modelContent ?? "");
    expect(modelContent).toContain('name="triage"');
    expect(modelContent).toContain("Triage the inbox");
    expect(modelContent).toContain("arg limit (number, default 10)");
    expect(modelContent).not.toContain("agent(");
  });

  it("says so in a sentence when the project has no saved workflows", async () => {
    const outcome = await run({
      input: {},
      name: "list-saved-empty",
      toolName: "ListSavedWorkflows",
      workingDirectory: makeCwd(),
    });

    expect((outcome.result.output as ListSavedWorkflowsOutput).workflows).toEqual([]);
    expect(String(outcome.result.modelContent ?? "")).toContain("No workflows are saved");
  });

  // 与 ListWorkflowRuns 同一条收敛：工具恒查会话工作目录，模型无权跨项目扫盘。
  it("rejects a cwd input outright", async () => {
    const outcome = await run({
      input: { cwd: "/etc" },
      name: "list-saved-cwd",
      toolName: "ListSavedWorkflows",
      workingDirectory: makeCwd(),
    });

    expect(outcome.result.success).toBe(false);
  });
});

describe("CreateWorkflow saved source", () => {
  it("normalizes the gate input to the resolved script, the saved name and the checked args", async () => {
    const cwd = makeCwd();
    const script = cleanScript("saved-happy");
    saveSavedWorkflow({
      cwd,
      name: "nightly",
      meta: { description: "nightly triage", args: { depth: { type: "number", default: 3 } } },
      script,
    });
    const { port, submits } = stubRunPort("dwfrun-saved");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "nightly" } },
      name: "create-saved-happy",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    // 归一化 (b) 的核心：旧桌面的 readWorkflowScript(raw.script) / readWorkflowName(raw.name)
    // 就是读这两个键——它们命中是**构造上**成立的，不是兼容处理。
    expect(outcome.permissionRequested[0]!.input).toEqual({
      name: "nightly",
      script,
      saved: {
        name: "nightly",
        args: { depth: 3 },
        path: savedPath(cwd, "nightly"),
        scope: "project",
        // 工作副本在 resolveInput 里随这次读一起写下（docs/dynamic-workflow/launch.md
        // 「Script files」）：模型要改的是这份拷贝，保存的定义一个字都不动。
        draft: join(cwd, WORKFLOW_DRAFTS_DIR, "nightly.dwf.ts"),
      },
      // 拷贝带着元数据块，所以诊断的文件行要跳过块的那几行。
      script_line_offset: expect.any(Number),
      // 确认窗可调的设置（docs/dynamic-workflow/launch.md「Adjusting the settings in the window」）：
      // 桩 run port 没有模型目录、也报不出天花板，所以只能调上界、没有上限。
      adjustable_settings: { subagent_model: false },
    });
    // 拷贝逐字节等于定义文件本身。
    expect(readFileSync(join(cwd, WORKFLOW_DRAFTS_DIR, "nightly.dwf.ts"), "utf8")).toBe(
      readFileSync(savedPath(cwd, "nightly"), "utf8"),
    );

    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.status).toBe("backgrounded");
    expect(submits).toHaveLength(1);
    expect(submits[0]!.scriptText).toBe(script);
    expect(submits[0]!.name).toBe("nightly");
    // 实参走 name / scriptText 同一条元数据路，落 dwf_run.args_json 并注入沙箱。
    expect(submits[0]!.args).toEqual({ depth: 3 });
  });

  // 不变式 8 的钉子：saved 与内联产出的 display 必须逐字节相同，本特性一个字段都不加。
  it("produces a display byte-identical to the same script run inline", async () => {
    const cwd = makeCwd();
    const script = cleanScript("saved-parity");
    saveSavedWorkflow({ cwd, name: "parity", meta: { description: "parity" }, script });
    const { port } = stubRunPort("dwfrun-parity");

    const viaSaved = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "parity" } },
      name: "create-parity-saved",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });
    const viaInline = await run({
      dynamicWorkflowRunPort: port,
      input: { script },
      name: "create-parity-inline",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    const savedDisplay = viaSaved.permissionRequested[0]!.display;
    expect(savedDisplay).toEqual(viaInline.permissionRequested[0]!.display);
    expect(Object.keys(savedDisplay as object).sort()).toEqual([
      "causalityGraph",
      "diagnostics",
      "errorCount",
      "kind",
      "ok",
    ]);
  });

  // 归一化 (e)：策略不被保存绕开。一条扫描脚本的 PreToolUse hook 在 saved run 上必须
  // 看到真正的脚本——否则保存就成了一条策略盲区。
  it("gives PreToolUse hooks the resolved script, not just the saved name", async () => {
    const cwd = makeCwd();
    const script = cleanScript("saved-hook");
    saveSavedWorkflow({ cwd, name: "policed", meta: { description: "policed" }, script });
    const seen: unknown[] = [];
    const hookRunner: HookRunner = {
      async run(input) {
        if (input.hookEventName === HookEventName.PreToolUse) {
          seen.push((input as unknown as { toolInput?: unknown }).toolInput);
        }
        return { additionalContexts: [] };
      },
    };

    await run({
      dynamicWorkflowRunPort: stubRunPort("dwfrun-hook").port,
      hookRunner,
      input: { saved: { name: "policed" } },
      name: "create-saved-hook",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(seen).toHaveLength(1);
    expect((seen[0] as { script?: string }).script).toBe(script);
  });

  // 不变式 5：确认与执行同字节。解析只发生一次，批准之后不再读盘。
  it("runs the bytes shown at the gate even if the file changes after resolution", async () => {
    const cwd = makeCwd();
    const approved = cleanScript("saved-toctou");
    saveSavedWorkflow({ cwd, name: "swapped", meta: { description: "swapped" }, script: approved });
    const { port, submits } = stubRunPort("dwfrun-toctou");

    const outcome = await run({
      broker: {
        async requestPermission() {
          // 用户思考的这段时间里，磁盘上的文件被换掉了。
          saveSavedWorkflow({
            cwd,
            name: "swapped",
            meta: { description: "swapped" },
            script: cleanScript("saved-toctou-evil"),
          });
          return { decision: "allow" };
        },
      },
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "swapped" } },
      name: "create-saved-toctou",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.result.success).toBe(true);
    expect(submits[0]!.scriptText).toBe(approved);
    expect(submits[0]!.scriptText).not.toContain("saved-toctou-evil");
  });

  it("lets an explicit name override the saved name as the run label", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "generic",
      meta: { description: "generic" },
      script: cleanScript("saved-label"),
    });
    const { port, submits } = stubRunPort("dwfrun-label");

    await run({
      dynamicWorkflowRunPort: port,
      input: { name: "tuesday run", saved: { name: "generic" } },
      name: "create-saved-label",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(submits[0]!.name).toBe("tuesday run");
  });

  // 参数传错没有任何值得用户裁决的东西：弹一个注定失败的窗只是打断模型的改错回路。
  it("rejects bad arguments before the gate, naming the declaration", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "strict-args",
      meta: {
        description: "takes args",
        args: { pr: { type: "string", required: true, description: "PR number" } },
      },
      script: cleanScript("saved-bad-args"),
    });
    const { port, submits } = stubRunPort("dwfrun-bad-args");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "strict-args", args: { pull: "42" } } },
      name: "create-saved-bad-args",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(submits).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    const message = outcome.result.error?.message ?? "";
    expect(message).toContain("unknown argument 'pull'");
    expect(message).toContain("missing required argument 'pr'");
    // 声明复述让模型一次改对，而不是再猜一轮。
    expect(message).toContain("PR number");
  });

  // 猜错名字之后最有用的下一步信息就是正确的那一批。
  it("names the available workflows when the requested one does not exist", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "actual",
      meta: { description: "the real one" },
      script: cleanScript("saved-missing"),
    });
    const { port, submits } = stubRunPort("dwfrun-missing");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "typo" } },
      name: "create-saved-missing",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(submits).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    const message = outcome.result.error?.message ?? "";
    expect(message).toContain("No saved workflow named 'typo'");
    expect(message).toContain("Available saved workflows: actual");
  });

  it("points at SaveWorkflow when the project has no saved workflows at all", async () => {
    const outcome = await run({
      input: { saved: { name: "anything" } },
      name: "create-saved-none",
      toolName: "CreateWorkflow",
      workingDirectory: makeCwd(),
    });

    expect(outcome.result.error?.message ?? "").toContain("no saved workflows yet");
  });

  // saved.scope 定向：同名两档时指定 global 跳过遮蔽，跑的是全局那份。
  it("takes the global copy when saved.scope is global despite a project shadow", async () => {
    const cwd = makeCwd();
    const projectScript = cleanScript("saved-scope-project");
    const globalScript = cleanScript("saved-scope-global");
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "project" },
      script: projectScript,
    });
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "global" },
      script: globalScript,
      scope: "global",
    });
    const { port, submits } = stubRunPort("dwfrun-scope-global");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "dup", scope: "global" } },
      name: "create-saved-scope-global",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    const gateSaved = (
      outcome.permissionRequested[0]!.input as { saved: { scope: string; path: string } }
    ).saved;
    expect(gateSaved.scope).toBe("global");
    expect(gateSaved.path).toBe(globalSavedPath("dup"));
    expect(submits[0]!.scriptText).toBe(globalScript);
  });

  // 缺省走 first-wins：同名两档时项目档遮蔽全局档，跑的是项目那份。
  it("takes the project copy by default when both scopes carry the name", async () => {
    const cwd = makeCwd();
    const projectScript = cleanScript("saved-default-project");
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "project" },
      script: projectScript,
    });
    saveSavedWorkflow({
      cwd,
      name: "dup",
      meta: { description: "global" },
      script: cleanScript("saved-default-global"),
      scope: "global",
    });
    const { port, submits } = stubRunPort("dwfrun-scope-default");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "dup" } },
      name: "create-saved-scope-default",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    const gateSaved = (outcome.permissionRequested[0]!.input as { saved: { scope: string } }).saved;
    expect(gateSaved.scope).toBe("project");
    expect(submits[0]!.scriptText).toBe(projectScript);
  });

  // 定向找不到：文案说「该作用域下没有」，并列出两档可用名字（带标签）。
  it("names the scope and lists both archives when a directed lookup misses", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "in-project",
      meta: { description: "p" },
      script: cleanScript("saved-directed-p"),
    });
    saveSavedWorkflow({
      cwd,
      name: "in-global",
      meta: { description: "g" },
      script: cleanScript("saved-directed-g"),
      scope: "global",
    });

    const outcome = await run({
      input: { saved: { name: "ghost", scope: "global" } },
      name: "create-saved-directed-miss",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.result.success).toBe(false);
    const message = outcome.result.error?.message ?? "";
    expect(message).toContain("No global workflow named 'ghost'");
    expect(message).toContain("in-project (project)");
    expect(message).toContain("in-global (global)");
  });

  it("surfaces a hand-broken metadata block as a fixable file, not a missing workflow", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "mangled",
      meta: { description: "fine" },
      script: cleanScript("saved-mangled"),
    });
    writeFileSync(savedPath(cwd, "mangled"), "return 1;\n", "utf8");

    const outcome = await run({
      input: { saved: { name: "mangled" } },
      name: "create-saved-mangled",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    const message = outcome.result.error?.message ?? "";
    expect(message).toContain("could not be read");
    expect(message).toContain("hand-edited");
  });

  // 保存的定义编不过是**它的**问题；不点名文件的话模型会以为是自己写错了然后原样重试。
  it("blames the saved file when the stored script no longer compiles", async () => {
    const cwd = makeCwd();
    saveSavedWorkflow({
      cwd,
      name: "rotten",
      meta: { description: "was fine once" },
      script: 'const rotten: number = "not a number";',
    });
    const { port, submits } = stubRunPort("dwfrun-rotten");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { saved: { name: "rotten" } },
      name: "create-saved-rotten",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(submits).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.response).toContain("The saved workflow 'rotten'");
    expect(output.response).toContain(savedPath(cwd, "rotten"));
    // 改动之后这条路径也有文件可改了：拷贝的落点被点名，诊断按**拷贝的文件行**报，
    // 而改定义本身仍要走 SaveWorkflow（docs/dynamic-workflow/launch.md「Script files」）。
    const draft = join(WORKFLOW_DRAFTS_DIR, "rotten.dwf.ts");
    expect(output.response).toContain(`A working copy of the saved workflow 'rotten'`);
    expect(output.response).toContain(`was written to ${draft}`);
    expect(output.response).toContain("use SaveWorkflow");
    // 正文第 1 行的诊断 = 文件第 4 行（起始标记 + description + 终止行）。
    expect(output.diagnostics[0]!.line).toBe(1);
    expect(output.response).toContain(`${draft}:L4:C7`);
  });

  // 内联路径零回归：模型写的字段一个字节不变（resolveInput 只补确认窗可调设置这条解析事实），且一次盘操作都不做。
  it("leaves the inline path byte-for-byte untouched", async () => {
    const cwd = makeCwd();
    const script = cleanScript("inline-regression");
    const { port, submits } = stubRunPort("dwfrun-inline");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      input: { script },
      name: "create-inline",
      toolName: "CreateWorkflow",
      workingDirectory: cwd,
    });

    expect(outcome.permissionRequested[0]!.input).toEqual({
      script,
      adjustable_settings: { subagent_model: false },
    });
    expect(submits[0]!.scriptText).toBe(script);
    expect("name" in submits[0]!).toBe(false);
    expect("args" in submits[0]!).toBe(false);
    // 归一化仍是恒等函数——确认窗看到的入参逐字节就是模型发出的那一份（上面那条断言）。
    // 盘上唯一多出来的是 handler 写的那份草稿：脚本的家，模型下一次据它走 `path`
    // （docs/dynamic-workflow/launch.md「Script files」）。
    const draft = join(cwd, WORKFLOW_DRAFTS_DIR, "workflow.dwf.ts");
    expect(readFileSync(draft, "utf8")).toBe(script);
    expect(submits[0]!.scriptPath).toBe(draft);
    expect(existsSync(join(cwd, ".zcode", "workflows"))).toBe(false);
  });

  it.each([
    ["neither", {}],
    ["both", { script: "return 1;", saved: { name: "x" } }],
  ])("ends a %s-source call before the gate with one actionable message", async (label, input) => {
    const outcome = await run({
      input,
      name: `create-source-${label}`,
      toolName: "CreateWorkflow",
      workingDirectory: makeCwd(),
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain(CREATE_WORKFLOW_SOURCE_ERROR);
  });
});

describe("CreateWorkflow input schema", () => {
  // XOR 刻意**不**在 schema 上：归一化输入同时带 script 与 saved，是合法执行态。
  // 一条 superRefine 会在 handler 的 parse 与 hook 改写后的二次校验上把它炸掉。
  it("accepts the normalized shape carrying both script and saved", () => {
    const parsed = CreateWorkflowInputSchema.safeParse({
      name: "nightly",
      script: "return 1;",
      saved: {
        name: "nightly",
        args: { a: 1 },
        path: "/p/.zcode/workflows/nightly.dwf.ts",
        scope: "project",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("still rejects unknown top-level keys", () => {
    expect(CreateWorkflowInputSchema.safeParse({ script: "return 1;", cwd: "/tmp" }).success).toBe(
      false,
    );
  });
});

describe("built-in tool registry", () => {
  it("registers the two new saved-workflow tools", () => {
    const names = builtInTools.map((entry) => entry.metadata.name);
    expect(names).toContain("SaveWorkflow");
    expect(names).toContain("ListSavedWorkflows");
  });

  // SaveWorkflow 写用户的仓库：与 CreateWorkflow 同档，任何权限模式都要先问。
  it("gates SaveWorkflow in every permission mode, without an always-allow option", () => {
    expect(saveWorkflowToolEntry.permission?.alwaysAsk).toBe(true);
    expect(saveWorkflowToolEntry.permission?.askOptions?.allowAlways).toBe(false);
    // CreateWorkflow 当年的 "none" 是占位期遗留，不该被抄：这个工具真的往工作区写文件。
    expect(saveWorkflowToolEntry.metadata.sideEffectScope).toBe("workspace");
    expect(saveWorkflowToolEntry.permission?.sideEffectScope).toBe("workspace");
  });

  // 读清单不写不跑：那两道 gate 的理由（写仓库 / 执行代码）都不适用。
  it("leaves ListSavedWorkflows ungated and read-only", () => {
    expect(listSavedWorkflowsToolEntry.metadata.readOnly).toBe(true);
    expect(listSavedWorkflowsToolEntry.metadata.needsApproval).toBe(false);
    expect(listSavedWorkflowsToolEntry.permission?.alwaysAsk).toBeUndefined();
  });

  // 引导文案的存在性（钉关键词，不钉逐字）。
  it("tells the model to ask before saving, and to consider saved workflows first", () => {
    expect(saveWorkflowToolEntry.metadata.description).toContain(
      "NEVER call this tool unsolicited",
    );
    expect(saveWorkflowToolEntry.metadata.description).toContain(
      "suggest saving it in one sentence and wait",
    );
    expect(createWorkflowToolEntry.metadata.description).toContain("ListSavedWorkflows");
    expect(createWorkflowToolEntry.metadata.description).toContain("exactly one source");
  });
});
