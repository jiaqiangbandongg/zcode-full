import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type CollaborationMode,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSubmitRequest,
  type ModelCatalogEntry,
  type ModelCatalogPort,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionRequestedPayload,
  type SessionEvent,
  type SessionStorePort,
  type ToolExecutionResult,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { HookRunner } from "../src/hooks/index.js";
import type { ToolEntry } from "../src/tool/types.js";

// 统计真实编译次数，让"把 gate 前分析折叠进 handler 自身分析"的记忆槽变得可断言。
// 用 importOriginal 保持分析本身是真的——下面的 display 断言依赖真实因果图。
const { analyzedScripts } = vi.hoisted(() => ({ analyzedScripts: [] as string[] }));

vi.mock("@zcode/dynamic-workflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/dynamic-workflow")>();
  return {
    ...actual,
    analyzeWorkflowScript: (script: string) => {
      analyzedScripts.push(script);
      return actual.analyzeWorkflowScript(script);
    },
  };
});

// 记忆槽是单槽、按脚本原文取键，所以每个用例用自己的脚本；否则上一个用例存下的分析
// 会直接满足下一个用例的断言。
function cleanScript(actor: string): string {
  return [
    "interface R { done: boolean }",
    `const r = await agent("${actor}").ask<R>("do");`,
    "return r.done;",
  ].join("\n");
}

/** 分析器语料里的脚本（与 create-workflow-tool.test.ts 同一份 corpus、同一条读法）。 */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../dynamic-workflow/tests/graphs/${name}`, import.meta.url),
    "utf8",
  );
}

const BROKEN_SCRIPT = 'const x: number = "s";';

// 每次 CreateWorkflow 调用都会把脚本落成 `<cwd>/.zcode/workflow-drafts/` 下的草稿（编不过也写）。
// executor 缺省的工作目录是 "."，会解析到 vitest 进程的 cwd——也就是本包目录——于是每跑一遍
// 就往源码树里漏几十个草稿（该目录自带 `*` 的 .gitignore，git status 看不见）。所以每个调用都
// 落在这个临时目录里，跑完删掉。
const TEST_CWD = mkdtempSync(join(tmpdir(), "zcode-create-workflow-permission-"));

afterAll(() => {
  rmSync(TEST_CWD, { recursive: true, force: true });
});

interface RunOptions {
  broker?: PermissionBrokerPort;
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  entry?: ToolEntry;
  hookRunner?: HookRunner;
  /** 工具输入里的并发上界（模型面字段 `max_concurrency`）。 */
  maxConcurrency?: number;
  /** 宿主的模型目录；缺席即「这台机器不能选子代理模型」。 */
  modelCatalogPort?: ModelCatalogPort;
  mode?: CollaborationMode;
  /** 工具输入里的子代理模型（模型面字段 `subagent_model`），按用户说的原样传。 */
  subagentModel?: string;
  name: string;
  /** 跨调用共享的权限服务实例（会话免确认的载体，见第 7 轮用例）。 */
  permissionService?: PermissionService;
  script: string;
  /** session store 桩：用来断言会话授权绝不落到项目级规则。 */
  sessionStore?: SessionStorePort;
  /** 工具输入里的可选展示名（`options.name` 已被会话/调用 id 占用）。 */
  workflowName?: string;
  workingDirectory?: string;
}

interface RunOutcome {
  brokerRequests: PermissionBrokerRequest[];
  events: SessionEvent[];
  permissionRequested: PermissionRequestedPayload[];
  result: ToolExecutionResult;
}

/**
 * 记录 submit 请求的桩端口。只实现 submit（handler 唯一触达的方法），其余方法在被调用时
 * 抛错——本文件测的是提交路径，任何对 getTask/cancel 的触达都说明接线跑偏了。
 *
 * `defaultConcurrency` 缺省不提供端口的 `defaultConcurrency`：那正是「老宿主的端口没有这个方法」的形状，
 * 也是绝大多数用例不该关心并发的形状。
 */
function stubRunPort(
  runId: string,
  defaultConcurrency?: number,
): {
  port: DynamicWorkflowRunPort;
  submits: DynamicWorkflowRunSubmitRequest[];
} {
  const submits: DynamicWorkflowRunSubmitRequest[] = [];
  const unreachable = (name: string) => () => {
    throw new Error(`stubRunPort.${name} 不应被 CreateWorkflow handler 触及`);
  };
  return {
    port: {
      async submit(request) {
        submits.push(request);
        return { ok: true, runId };
      },
      ...(defaultConcurrency === undefined ? {} : { defaultConcurrency: () => defaultConcurrency }),
      getTask: unreachable("getTask"),
      waitForTask: unreachable("waitForTask"),
      cancel: unreachable("cancel"),
      listEvents: unreachable("listEvents"),
    } as unknown as DynamicWorkflowRunPort,
    submits,
  };
}

async function run(options: RunOptions): Promise<RunOutcome> {
  const sessionId = createSessionId(options.name);
  const turnId = createTurnId(options.name);
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const events: SessionEvent[] = [];
  const brokerRequests: PermissionBrokerRequest[] = [];
  const permissionBroker: PermissionBrokerPort = {
    async requestPermission(request, requestOptions) {
      brokerRequests.push(request);
      return (
        options.broker?.requestPermission(request, requestOptions) ?? { decision: "allow" as const }
      );
    },
  };

  const registry = createToolRegistry();
  registry.register(options.entry ?? createWorkflowToolEntry);
  const executor = createToolExecutor({
    emitEvent: async (event) => {
      events.push(event);
    },
    ...(options.dynamicWorkflowRunPort
      ? { dynamicWorkflowRunPort: options.dynamicWorkflowRunPort }
      : {}),
    ...(options.hookRunner ? { hookRunner: options.hookRunner } : {}),
    ...(options.modelCatalogPort ? { modelCatalogPort: options.modelCatalogPort } : {}),
    mode: options.mode ?? "build",
    permissionBroker,
    permissionService: options.permissionService ?? new PermissionService(defaultPermissionConfig),
    registry,
    sessionId,
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
    turnId,
    traceContext,
    workingDirectory: options.workingDirectory ?? TEST_CWD,
  });

  const result = await executor.execute(
    {
      id: createToolCallId(options.name),
      input: {
        script: options.script,
        ...(options.workflowName === undefined ? {} : { name: options.workflowName }),
        ...(options.maxConcurrency === undefined
          ? {}
          : { max_concurrency: options.maxConcurrency }),
        ...(options.subagentModel === undefined
          ? {}
          : { subagent_model: options.subagentModel }),
      },
      name: "CreateWorkflow",
    },
    { traceContext },
  );

  return {
    brokerRequests,
    events,
    permissionRequested: events
      .filter((event) => event.type === SessionEventType.PermissionRequested)
      .map((event) => event.payload as PermissionRequestedPayload),
    result,
  };
}

describe("CreateWorkflow run confirmation", () => {
  it("asks with a causality-graph preview and the session-scoped always-allow policy for a clean script", async () => {
    const script = cleanScript("preview");
    analyzedScripts.length = 0;

    const outcome = await run({ name: "create-workflow-ask", script });

    expect(outcome.permissionRequested).toHaveLength(1);
    const payload = outcome.permissionRequested[0]!;
    // 第 7 轮：项目级 always allow 仍被裁掉，换成会话作用域的免确认选项。
    expect(payload.optionsPolicy).toBe("session-always-allow");
    expect(payload.display?.kind).toBe("create_workflow");
    const display = payload.display as { causalityGraph?: { steps: unknown[] }; ok?: boolean };
    expect(display.ok).toBe(true);
    expect(display.causalityGraph?.steps).toHaveLength(1);

    // broker 请求同样要带上策略：legacy 反向 RPC 自己合成选项列表，不带就仍会给出
    // "始终允许本项目"。
    expect(outcome.brokerRequests).toHaveLength(1);
    expect(outcome.brokerRequests[0]!.optionsPolicy).toBe("session-always-allow");

    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(true);
    expect(output.causalityGraph?.steps).toHaveLength(1);

    // gate 与 handler 共用一次编译。
    expect(analyzedScripts.filter((entry) => entry === script)).toHaveLength(1);
  });

  it("skips the confirmation for a script that does not typecheck and returns diagnostics", async () => {
    const outcome = await run({ name: "create-workflow-broken", script: BROKEN_SCRIPT });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.events.map((event) => event.type)).toEqual([
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    expect(output.causalityGraph).toBeUndefined();
  });

  // 第 2 轮用户复议：workflow 是一大块执行 + 模型调用，任何模式都要问。yolo 的直通
  // 放行和 plan 的 readOnly 放行都压不过 alwaysAsk。
  for (const mode of ["yolo", "plan", "edit"] as const) {
    it(`${mode} 模式同样弹窗并携带预览`, async () => {
      const script = cleanScript(`mode-${mode}`);
      analyzedScripts.length = 0;

      const outcome = await run({ mode, name: `create-workflow-${mode}`, script });

      expect(outcome.permissionRequested).toHaveLength(1);
      const payload = outcome.permissionRequested[0]!;
      expect(payload.display?.kind).toBe("create_workflow");
      expect(payload.optionsPolicy).toBe("session-always-allow");
      expect(outcome.brokerRequests).toHaveLength(1);
      // 弹窗既然要出，gate 前分析在这些模式下当然也要跑；仍然只编译一次。
      expect(analyzedScripts.filter((entry_) => entry_ === script)).toHaveLength(1);
      expect(outcome.result.success).toBe(true);
      expect((outcome.result.output as CreateWorkflowOutput).ok).toBe(true);
    });
  }

  // 刻意保留的例外，且不分模式：编不过的脚本没有可确认的东西，直接回诊断。
  it("yolo 模式下坏脚本仍然不弹窗，直接回诊断", async () => {
    const outcome = await run({
      mode: "yolo",
      name: "create-workflow-broken-yolo",
      script: 'const y: number = "still broken";',
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(outcome.brokerRequests).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
  });

  it("PreToolUse hook 的 allow 不能抹掉这道确认", async () => {
    const hookRunner: HookRunner = {
      async run(input) {
        return input.hookEventName === HookEventName.PreToolUse
          ? { additionalContexts: [], permissionBehavior: "allow" }
          : { additionalContexts: [] };
      },
    };

    const outcome = await run({
      hookRunner,
      mode: "yolo",
      name: "create-workflow-pretooluse-allow",
      script: cleanScript("pretooluse"),
    });

    // 对普通工具这个 hook 会把 ask 提升成 allow；alwaysAsk 的工具不受影响。
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.brokerRequests).toHaveLength(1);
    expect(outcome.result.success).toBe(true);
  });

  it("PermissionRequest hook 仍可自动应答这道确认", async () => {
    const hookRunner: HookRunner = {
      async run(input) {
        return input.hookEventName === HookEventName.PermissionRequest
          ? {
              additionalContexts: [],
              permissionRequestResult: { behavior: "allow" },
            }
          : { additionalContexts: [] };
      },
    };

    const outcome = await run({
      // rebase 语义修正（2026-08-27）：staging 引入 responder race 后 broker 请求总是与
      // hook 链并发发起（docs/design/v2/permission-responder-race.md），不再是"hook 先答
      // 则 broker 不被触达"。这里让 broker 悬置不应答，成功只能来自 hook 的自动应答，
      // 用例仍然证明 hook 是有效的自动化出口。
      broker: {
        requestPermission: () => new Promise<never>(() => {}),
      },
      hookRunner,
      name: "create-workflow-permissionrequest-hook",
      script: cleanScript("auto-answer"),
    });

    // 正规自动化出口：弹窗事件照常发出（UI 会看到并随 resolved 收口），
    // broker 请求也照常发起，但用户无须应答——hook 赢下竞速。
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.brokerRequests).toHaveLength(1);
    expect(outcome.events.some((event) => event.type === SessionEventType.PermissionResolved)).toBe(
      true,
    );
    expect(outcome.result.success).toBe(true);
    expect((outcome.result.output as CreateWorkflowOutput).ok).toBe(true);
  });

  it("still asks, without a preview, when the approval hook throws", async () => {
    const entry: ToolEntry = {
      ...createWorkflowToolEntry,
      prepareApproval: () => {
        throw new Error("preview build failed");
      },
    };

    const outcome = await run({
      entry,
      name: "create-workflow-hook-throws",
      script: cleanScript("throws"),
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    const payload = outcome.permissionRequested[0]!;
    expect(payload.display).toBeUndefined();
    // 策略来自工具声明而不是钩子，所以钩子抛错后它依然在。
    expect(payload.optionsPolicy).toBe("session-always-allow");
    expect(outcome.brokerRequests).toHaveLength(1);
    expect(outcome.result.success).toBe(true);
  });

  // 对照组：alwaysAsk 是逐工具声明的，不能顺手改掉其他工具的模式语义。
  // 普通只读工具在 yolo 下仍应静默放行。
  it("不影响其他工具：普通只读工具在 yolo 下仍静默放行", async () => {
    const sessionId = createSessionId("control-readonly");
    const turnId = createTurnId("control-readonly");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const requestPermission = vi.fn(async () => ({ decision: "allow" as const }));
    const registry = createToolRegistry();
    registry.register({
      capability: "Echo a value back without touching the outside world",
      metadata: {
        name: "ControlEcho",
        description: "Echo for permission-mode regression",
        readOnly: true,
        destructive: false,
        concurrentSafe: true,
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        sideEffectScope: "none",
        riskLevel: "low",
        needsApproval: false,
      },
      handler: async (input) => input,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      permission: {
        permission: "read",
        reason: "ControlEcho has no side effects",
        riskLevel: "low",
        sideEffectScope: "none",
        needsApproval: false,
        patternSources: ["toolName"],
        denyPriority: "beforeAsk",
      },
      resultBudget: { maxInlineBytes: 1_000, maxModelBytes: 1_000, strategy: "truncate" },
      timeout: { defaultMs: 1_000, maxMs: 1_000, allowCallOverride: false },
      cancellation: { supported: false, cleanup: "none", userVisibleMessage: "n/a" },
      trace: {
        required: true,
        propagateToAdapters: false,
        recordInput: "summary",
        recordOutput: "summary",
      },
    });
    const executor = createToolExecutor({
      emitEvent: async (event) => {
        events.push(event);
      },
      mode: "yolo",
      permissionBroker: { requestPermission },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      { id: createToolCallId("control-echo"), input: { ok: true }, name: "ControlEcho" },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === SessionEventType.PermissionRequested)).toBe(false);
  });

  it("returns a permission error when the confirmation is denied", async () => {
    const outcome = await run({
      broker: {
        async requestPermission() {
          return { decision: "deny", reason: "User declined to run the workflow" };
        },
      },
      name: "create-workflow-deny",
      script: cleanScript("deny"),
    });

    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.type).toBe("permission_denied");
    expect(outcome.result.error?.message).toContain("User declined to run the workflow");
    expect(outcome.events.some((event) => event.type === SessionEventType.ToolCallResult)).toBe(
      false,
    );
  });
});

// 会话免确认（docs/dynamic-workflow/launch.md「Always allow in this session」）：broker 应答带
// sessionPermissionUpdates → 同一 PermissionService 实例内后续 CreateWorkflow 不再问；
// 授权纯内存、绝不落项目规则；新实例（重启 / 冷恢复 / /new）从零开始。
describe("CreateWorkflow always allow in this session", () => {
  const sessionAllow: PermissionBrokerPort = {
    async requestPermission(request) {
      return {
        decision: "allow",
        reason: "Approved for this session",
        sessionPermissionUpdates: [
          { behavior: "allow", rules: [{ toolName: request.toolName }], type: "addRules" },
        ],
      };
    },
  };

  function projectStoreSpy(): { sessionStore: SessionStorePort; saves: unknown[] } {
    const saves: unknown[] = [];
    const sessionStore = {
      async getSession() {
        return { projectID: "proj-1" };
      },
      async getProjectPermission() {
        return null;
      },
      async saveProjectPermission(input: unknown) {
        saves.push(input);
      },
    } as unknown as SessionStorePort;
    return { sessionStore, saves };
  }

  it("第一次弹窗选会话免确认后，同一会话的第二次 CreateWorkflow 不再问，也不发 permission 事件", async () => {
    const permissionService = new PermissionService(defaultPermissionConfig);
    const { sessionStore, saves } = projectStoreSpy();

    const first = await run({
      broker: sessionAllow,
      name: "session-allow-first",
      permissionService,
      script: cleanScript("first"),
      sessionStore,
    });
    expect(first.permissionRequested).toHaveLength(1);
    expect(first.brokerRequests).toHaveLength(1);
    expect(first.result.success).toBe(true);

    // 脚本不同也免确认：授权的是这个工具，不是某一段脚本。
    const second = await run({
      broker: {
        async requestPermission() {
          throw new Error("第二次不该再向 broker 要确认");
        },
      },
      mode: "plan",
      name: "session-allow-second",
      permissionService,
      script: cleanScript("second"),
      sessionStore,
    });
    expect(second.permissionRequested).toHaveLength(0);
    expect(second.brokerRequests).toHaveLength(0);
    expect(second.events.map((event) => event.type)).toEqual([
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallResult,
    ]);
    expect(second.result.success).toBe(true);
    expect((second.result.output as CreateWorkflowOutput).ok).toBe(true);

    // 会话授权绝不落项目级规则。
    expect(saves).toHaveLength(0);
  });

  it("授权不跨 PermissionService 实例：新实例（重启 / 冷恢复）第一次照常弹窗", async () => {
    const granted = new PermissionService(defaultPermissionConfig);
    await run({
      broker: sessionAllow,
      name: "session-allow-restart-a",
      permissionService: granted,
      script: cleanScript("restart-a"),
    });

    const fresh = await run({
      name: "session-allow-restart-b",
      permissionService: new PermissionService(defaultPermissionConfig),
      script: cleanScript("restart-b"),
    });
    expect(fresh.permissionRequested).toHaveLength(1);
    expect(fresh.brokerRequests).toHaveLength(1);
  });

  it("坏脚本在授权后仍走诊断路径（gate 之前就 proceed，与授权无关）", async () => {
    const permissionService = new PermissionService(defaultPermissionConfig);
    await run({
      broker: sessionAllow,
      name: "session-allow-broken-a",
      permissionService,
      script: cleanScript("broken-a"),
    });

    const outcome = await run({
      name: "session-allow-broken-b",
      permissionService,
      script: BROKEN_SCRIPT,
    });
    expect(outcome.permissionRequested).toHaveLength(0);
    expect((outcome.result.output as CreateWorkflowOutput).ok).toBe(false);
  });
});

// Refine 应答（docs/dynamic-workflow/launch.md「Refine」）：deny + workflow_refine_feedback 的
// 反馈要升级为 followUpUserInput（steer 成真实 user message），tool_result 只留桥接文案。
describe("CreateWorkflow Refine feedback", () => {
  it("Refine deny 把反馈升级为 followUpUserInput，tool_result 换桥接文案", async () => {
    const { port, submits } = stubRunPort("dwfrun-refine");
    const outcome = await run({
      broker: {
        async requestPermission() {
          return {
            decision: "deny",
            reason: "只保留三个 finder，去掉 verify 阶段",
            reasonSource: "workflow_refine_feedback",
          };
        },
      },
      dynamicWorkflowRunPort: port,
      name: "create-workflow-refine",
      script: cleanScript("refine"),
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.type).toBe("permission_denied");
    // 反馈全文既在 error.message（errors.ts 对该 source 不截断）也在 followUpUserInput。
    expect(outcome.result.error?.reasonSource).toBe("workflow_refine_feedback");
    expect(outcome.result.error?.message).toBe("只保留三个 finder，去掉 verify 阶段");
    expect(outcome.result.followUpUserInput).toEqual({
      input: "只保留三个 finder，去掉 verify 阶段",
      reasonSource: "workflow_refine_feedback",
    });
    // 桥接文案不承诺反馈一定跟随（steer 可能被拒），只表达未获批准。
    expect(outcome.result.modelContent).toBe("The workflow run was not approved by the user.");
    // Refine 是拒绝：端口绝不能被触达。
    expect(submits).toHaveLength(0);
    // Refine 不停 turn：反馈在同一 turn 内引导模型修订重提。
    expect(outcome.result.turnControl).toBeUndefined();
  });

  it("普通 deny 不带 followUpUserInput，也不换桥接文案", async () => {
    const outcome = await run({
      broker: {
        async requestPermission() {
          return { decision: "deny", reason: "User declined to run the workflow" };
        },
      },
      name: "create-workflow-plain-deny",
      script: cleanScript("plain-deny"),
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.followUpUserInput).toBeUndefined();
    expect(outcome.result.modelContent).toBeUndefined();
  });

  it("deny + reason 但没有专用 source（hook/规则形态）不被升级", async () => {
    const outcome = await run({
      broker: {
        async requestPermission() {
          return { decision: "deny", reason: "denied by project rule" };
        },
      },
      name: "create-workflow-rule-deny",
      script: cleanScript("rule-deny"),
    });

    expect(outcome.result.followUpUserInput).toBeUndefined();
  });

  it("空白反馈不升级（broker 不该发出，但 turn-control 兜底 trim）", async () => {
    const outcome = await run({
      broker: {
        async requestPermission() {
          return {
            decision: "deny",
            reason: "   ",
            reasonSource: "workflow_refine_feedback",
          };
        },
      },
      name: "create-workflow-blank-refine",
      script: cleanScript("blank-refine"),
    });

    expect(outcome.result.followUpUserInput).toBeUndefined();
  });

  // 升级按 toolName 键入：其他工具的 deny 即便伪造该 source 也不得变成用户消息。
  it("非 CreateWorkflow 工具带该 source 的 deny 不被升级", async () => {
    const sessionId = createSessionId("refine-other-tool");
    const turnId = createTurnId("refine-other-tool");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    registry.register({
      capability: "Write a marker file",
      metadata: {
        name: "ControlWrite",
        description: "Ask-gated control tool for refine-source regression",
        readOnly: false,
        destructive: false,
        concurrentSafe: true,
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
        sideEffectScope: "workspace",
        riskLevel: "high",
        needsApproval: true,
      },
      handler: async (input) => input,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      permission: {
        permission: "write",
        reason: "ControlWrite mutates the workspace",
        riskLevel: "high",
        sideEffectScope: "workspace",
        needsApproval: true,
        patternSources: ["toolName"],
        denyPriority: "beforeAsk",
      },
      resultBudget: { maxInlineBytes: 1_000, maxModelBytes: 1_000, strategy: "truncate" },
      timeout: { defaultMs: 1_000, maxMs: 1_000, allowCallOverride: false },
      cancellation: { supported: false, cleanup: "none", userVisibleMessage: "n/a" },
      trace: {
        required: true,
        propagateToAdapters: false,
        recordInput: "summary",
        recordOutput: "summary",
      },
    });
    const executor = createToolExecutor({
      emitEvent: async () => {},
      mode: "build",
      permissionBroker: {
        async requestPermission() {
          return {
            decision: "deny" as const,
            reason: "spoofed refine feedback",
            reasonSource: "workflow_refine_feedback" as const,
          };
        },
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      { id: createToolCallId("control-write"), input: { ok: true }, name: "ControlWrite" },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.followUpUserInput).toBeUndefined();
  });
});

// 引擎接线后的提交路径。gate 的 Allow 之后 handler 不再回占位，而是经窄端口启动一个后台 run。
describe("CreateWorkflow backgrounded submit", () => {
  it("Allow 之后经端口启动 run，输出 backgrounded + runId 并告知模型等通知", async () => {
    const { port, submits } = stubRunPort("dwfrun-alpha");
    const script = cleanScript("submit-allow");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      name: "create-workflow-submit-allow",
      script,
      workingDirectory: TEST_CWD,
    });

    // 弹窗照旧：提交路径挂在 Allow 之后，不绕过确认。
    expect(outcome.permissionRequested).toHaveLength(1);
    expect(outcome.result.success).toBe(true);

    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(true);
    expect(output.status).toBe("backgrounded");
    // runId ≡ backgroundTaskId ≡ workId：三条路径同一个键。
    expect(output.backgroundTaskId).toBe("dwfrun-alpha");
    // 因果图仍随输出走（工具卡的入口与摘要靠它）。
    expect(output.causalityGraph?.steps).toHaveLength(1);

    // 面向模型的文案：告知已在后台启动、结果以通知形式回来；占位提示必须消失，
    // 否则模型会以为什么都没发生而重复提交。
    expect(output.response).toContain("dwfrun-alpha");
    expect(output.response).toMatch(/background/i);
    expect(output.response).toMatch(/notified/i);
    // 异步引导（桌面实测：模型拿到 backgrounded 输出后立刻 TaskOutput 阻塞等待）：
    // 文案必须劝阻等待/轮询并点名 TaskOutput。钉住存在性，不钉逐字。
    expect(output.response).toMatch(/do not wait/i);
    expect(output.response).toContain("TaskOutput");
    expect(output.response).not.toContain("NOT executed");
    expect(output.response).not.toContain("still under development");

    // 端口拿到的是脚本原文与执行上下文，且带 trace（端口契约要求 trace 非可选）。
    expect(submits).toHaveLength(1);
    const request = submits[0]!;
    expect(request.scriptText).toBe(script);
    expect(request.cwd).toBe(TEST_CWD);
    expect(request.parentSessionId).toBe(createSessionId("create-workflow-submit-allow"));
    expect(request.toolCallId).toBe(createToolCallId("create-workflow-submit-allow"));
    expect(request.trace?.traceId).toBeTruthy();
  });

  // input.name 的持久化路：handler → port.submit → EngineConfig → createRun → dwf_run.name。
  // 此前这个字段只活在工具行与任务标题的兜底链上，于是跨会话枚举出来的 run 只能是一串裸
  // runId（docs/dynamic-workflow/launch.md「`ListWorkflowRuns`」）。
  it("把 input.name 递给端口（run 标签的唯一来源）", async () => {
    const { port, submits } = stubRunPort("dwfrun-named");

    await run({
      dynamicWorkflowRunPort: port,
      name: "create-workflow-submit-named",
      script: cleanScript("submit-named"),
      workflowName: "nightly triage",
    });

    expect(submits).toHaveLength(1);
    expect(submits[0]!.name).toBe("nightly triage");
  });

  // 侧栏迷你轨道的两张表（docs/dynamic-workflow/presentation.md「The sidebar run line」）：
  // 站点名与「哪两站是并行的」必须来自同一次分析、同一张图，否则下标会指错站。
  it("声明阶段表与「同时在跑」表同车递给端口", async () => {
    const { port, submits } = stubRunPort("dwfrun-alongside");

    await run({
      dynamicWorkflowRunPort: port,
      name: "create-workflow-submit-alongside",
      script: fixture("strand-fanout-two-phases-join.ts"),
    });

    expect(submits).toHaveLength(1);
    expect(submits[0]!.phaseNames).toEqual(["A", "B", "C"]);
    // B 是在 A 的 strand 还在跑时进入的；下标指向的正是上面那张 phaseNames。
    expect(submits[0]!.phaseAlongside).toEqual([[], [0], []]);
  });

  it("没有阶段并行的脚本不给端口造 phaseAlongside 键（缺席 = 一条直线）", async () => {
    const { port, submits } = stubRunPort("dwfrun-straight");

    await run({
      dynamicWorkflowRunPort: port,
      name: "create-workflow-submit-straight",
      script: fixture("strand-fanout-awaited-per-phase.ts"),
    });

    expect(submits).toHaveLength(1);
    expect(submits[0]!.phaseNames).toEqual(["A", "B", "C"]);
    expect("phaseAlongside" in submits[0]!).toBe(false);
  });

  it("未命名的调用不给端口造 name 键（读侧据此走脚本首行兜底）", async () => {
    const { port, submits } = stubRunPort("dwfrun-unnamed");

    await run({
      dynamicWorkflowRunPort: port,
      name: "create-workflow-submit-unnamed",
      script: cleanScript("submit-unnamed"),
    });

    expect(submits).toHaveLength(1);
    expect("name" in submits[0]!).toBe(false);
  });

  /**
   * 端口缺席（未接线宿主 / 单测）的降级路径。这条钉子原先叫「占位行为逐字不变」并按逐字节钉
   * 文案；占位文案真化后改钉**语义**：字段缺席照旧，文案要说清「本会话没有执行能力」，且不再
   * 自述成开发中的占位实现。
   */ it("端口缺席时降级语义不变，文案改说本会话无执行能力", async () => {
    const outcome = await run({
      name: "create-workflow-submit-no-port",
      script: cleanScript("submit-no-port"),
    });

    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(true);
    // 没有端口就没有 run：两个新字段必须整个缺席（.strict() 的输出不带空壳键）。
    expect(output.status).toBeUndefined();
    expect(output.backgroundTaskId).toBeUndefined();
    expect(output.response).toContain("The workflow script compiled cleanly.");
    expect(output.response).toContain("NOT executed");
    // 真化后这条路径为真的那句：能力缺席是本会话的事实，不是工具还没做完。
    expect(output.response).toContain("not available in this session");
    expect(output.response).not.toContain("under development");
    expect(output.response).not.toContain("placeholder");
  });

  // 坏脚本路径完全不变：不弹窗、不启动、不建 run。端口在场也不能改变这一点。
  it("坏脚本即便端口在场也不提交，只回诊断", async () => {
    const { port, submits } = stubRunPort("dwfrun-should-not-start");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      name: "create-workflow-submit-broken",
      script: 'const broken: number = "not a number";',
    });

    expect(outcome.permissionRequested).toHaveLength(0);
    expect(submits).toHaveLength(0);
    expect(outcome.result.success).toBe(true);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.ok).toBe(false);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    expect(output.status).toBeUndefined();
    expect(output.backgroundTaskId).toBeUndefined();
  });

  // Deny 早于 handler：端口在场也绝不能启动。
  it("Deny 时端口不被触达", async () => {
    const { port, submits } = stubRunPort("dwfrun-denied");

    const outcome = await run({
      broker: {
        async requestPermission() {
          return { decision: "deny", reason: "User declined to run the workflow" };
        },
      },
      dynamicWorkflowRunPort: port,
      name: "create-workflow-submit-deny",
      script: cleanScript("submit-deny"),
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.type).toBe("permission_denied");
    expect(submits).toHaveLength(0);
  });

  // 提交失败是一等失败：端口抛错不能被吞成"看起来启动了"的成功输出。
  it("端口 submit 抛错时工具调用失败，不伪造 backgrounded", async () => {
    const failing = {
      async submit() {
        throw new Error("journal unavailable");
      },
    } as unknown as DynamicWorkflowRunPort;

    const outcome = await run({
      dynamicWorkflowRunPort: failing,
      name: "create-workflow-submit-throws",
      script: cleanScript("submit-throws"),
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain("journal unavailable");
  });

  // metadata 的只读声明随执行语义一并翻面（前置 spec 的遗留项）。
  it("工具不再声明 readOnly", () => {
    expect(createWorkflowToolEntry.metadata.readOnly).toBe(false);
  });
});

// 每 run 的并发上界（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）。这里走完整
// executor，所以钉的是接线本身：取整发生在确认窗**之前**，handler 再把归一化后的那个数递给端口。
// 默认并发是起点不是上限：高于它的数原样生效。
describe("CreateWorkflow max_concurrency", () => {
  it("把上界递给端口，并在文案里说出生效的数", async () => {
    const { port, submits } = stubRunPort("dwfrun-capped", 8);

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      maxConcurrency: 3,
      name: "create-workflow-maxconc",
      script: cleanScript("maxconc"),
    });

    expect(submits).toHaveLength(1);
    expect(submits[0]!.maxConcurrency).toBe(3);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.response).toContain("At most 3 subagents run at once.");
    // 不等于默认就不提默认——那会让模型以为 3 与没设一样。
    expect(output.response).not.toContain("(the default)");
  });

  it("高于默认并发的请求原样生效，确认窗与端口看到同一个数", async () => {
    const { port, submits } = stubRunPort("dwfrun-raised", 8);

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      maxConcurrency: 32,
      name: "create-workflow-maxconc-raised",
      script: cleanScript("maxconc-raised"),
    });

    // 用户批准的必须是将要生效的那个数：确认窗读的是归一化后的入参。
    expect(outcome.permissionRequested[0]!.input).toMatchObject({ max_concurrency: 32 });
    expect(submits[0]!.maxConcurrency).toBe(32);
    const output = outcome.result.output as CreateWorkflowOutput;
    expect(output.response).toContain("At most 32 subagents run at once.");
  });

  it("正好等于默认并发时注明「（默认）」", async () => {
    const { port } = stubRunPort("dwfrun-at-default", 8);

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      maxConcurrency: 8,
      name: "create-workflow-maxconc-default",
      script: cleanScript("maxconc-default"),
    });

    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "At most 8 subagents run at once (the default).",
    );
  });

  it("没给上界就不造键，也不在文案里凭空多一句", async () => {
    const { port, submits } = stubRunPort("dwfrun-default", 8);

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      name: "create-workflow-maxconc-absent",
      script: cleanScript("maxconc-absent"),
    });

    expect("maxConcurrency" in submits[0]!).toBe(false);
    expect((outcome.result.output as CreateWorkflowOutput).response).not.toContain("At most");
  });

  it("端口说不出默认并发时照样原样下传", async () => {
    const { port, submits } = stubRunPort("dwfrun-no-default");

    await run({
      dynamicWorkflowRunPort: port,
      maxConcurrency: 32,
      name: "create-workflow-maxconc-no-default",
      script: cleanScript("maxconc-no-default"),
    });

    expect(submits[0]!.maxConcurrency).toBe(32);
  });
});

// 每 run 的子代理模型（docs/dynamic-workflow/launch.md）。同样走完整 executor：钉的是接线
// ——目录经 resolveInput 的上下文读到，解析发生在确认窗**之前**，handler 再把规范形拆成结构化
// 选型递给端口。
describe("CreateWorkflow subagent_model", () => {
  function entry(
    providerId: string,
    modelId: string,
    extra: Partial<ModelCatalogEntry> = {},
  ): ModelCatalogEntry {
    return { providerId, modelId, reasoningLevels: [], current: false, ...extra };
  }

  const CATALOG: ModelCatalogPort = {
    listModels: () => [
      entry("bigmodel", "GLM-4.6", {
        reasoningLevels: ["low", "high"],
        defaultReasoningLevel: "high",
        current: true,
      }),
      entry("openai", "gpt-5"),
    ],
  };

  it("把解析后的选型递给端口，确认窗显示的是同一个规范形", async () => {
    const { port, submits } = stubRunPort("dwfrun-model");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      modelCatalogPort: CATALOG,
      name: "create-workflow-subagent-model",
      script: cleanScript("subagent-model"),
      // 用户说的是裸名，大小写也不同。
      subagentModel: "glm-4.6",
    });

    // 用户批准的必须是将要生效的那个模型：确认窗读的是归一化后的入参。
    expect(outcome.permissionRequested[0]!.input).toMatchObject({
      subagent_model: "bigmodel/GLM-4.6$high",
    });
    expect(submits).toHaveLength(1);
    expect(submits[0]!.subagentModel).toEqual({
      providerId: "bigmodel",
      modelId: "GLM-4.6",
      options: { reasoningLevel: "high" },
    });

    const output = outcome.result.output as CreateWorkflowOutput;
    // 括号里那半句是给模型自己听的：它最容易把「子代理换了模型」读成「我也换了」。
    expect(output.response).toContain(
      "Subagents run on bigmodel/GLM-4.6$high (the main agent stays on the session model).",
    );
  });

  it("没选模型就不造键，也不在文案里凭空多一句", async () => {
    const { port, submits } = stubRunPort("dwfrun-model-absent");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      modelCatalogPort: CATALOG,
      name: "create-workflow-subagent-model-absent",
      script: cleanScript("subagent-model-absent"),
    });

    expect("subagentModel" in submits[0]!).toBe(false);
    expect((outcome.result.output as CreateWorkflowOutput).response).not.toContain("Subagents run on");
  });

  it("解不出来的模型名在确认窗之前就退回：没弹窗、没启动", async () => {
    const { port, submits } = stubRunPort("dwfrun-model-unresolved");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      modelCatalogPort: CATALOG,
      name: "create-workflow-subagent-model-miss",
      script: cleanScript("subagent-model-miss"),
      subagentModel: "gemini-3",
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(submits).toHaveLength(0);
  });

  it("宿主没有目录时给了字段即被拒，同样不弹窗不启动", async () => {
    const { port, submits } = stubRunPort("dwfrun-model-no-catalog");

    const outcome = await run({
      dynamicWorkflowRunPort: port,
      name: "create-workflow-subagent-model-no-catalog",
      script: cleanScript("subagent-model-no-catalog"),
      subagentModel: "gpt-5",
    });

    expect(outcome.result.success).toBe(false);
    expect(outcome.permissionRequested).toHaveLength(0);
    expect(submits).toHaveLength(0);
  });
});

// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」
describe("CreateWorkflow settings adjusted in the confirmation window", () => {
  const CATALOG: ModelCatalogPort = {
    listModels: () => [
      {
        providerId: "bigmodel",
        modelId: "GLM-4.6",
        reasoningLevels: ["low", "high"],
        defaultReasoningLevel: "high",
        current: true,
      },
      { providerId: "openai", modelId: "gpt-5", reasoningLevels: [], current: false },
    ],
  };

  /** 放行应答带着窗里改过的字段（broker 从 v4 answer.content 收成的形状）。 */
  function allowWith(inputAdjustments: Record<string, unknown>): PermissionBrokerPort {
    return {
      async requestPermission() {
        return { decision: "allow", reason: "Approved once", inputAdjustments };
      },
    };
  }

  it("回填 adjustable_settings：确认窗读得到目录在不在、默认并发是多少", async () => {
    const { port } = stubRunPort("dwfrun-adjustable", 13);
    const outcome = await run({
      dynamicWorkflowRunPort: port,
      modelCatalogPort: CATALOG,
      name: "create-workflow-adjustable-block",
      script: cleanScript("adjustable-block"),
    });
    expect(outcome.permissionRequested[0]!.input).toMatchObject({
      adjustable_settings: { subagent_model: true, concurrency_ceiling: 13 },
    });
  });

  it("没有目录时块里说模型不可调；端口说不出默认并发时不造键", async () => {
    const { port } = stubRunPort("dwfrun-adjustable-no-catalog");
    const outcome = await run({
      dynamicWorkflowRunPort: port,
      name: "create-workflow-adjustable-no-catalog",
      script: cleanScript("adjustable-no-catalog"),
    });
    const input = outcome.permissionRequested[0]!.input as Record<string, unknown>;
    expect(input.adjustable_settings).toEqual({ subagent_model: false });
  });

  it("没有 run 端口就没有块：什么都不会跑，窗里也没什么可调", async () => {
    const outcome = await run({
      name: "create-workflow-adjustable-no-port",
      script: cleanScript("adjustable-no-port"),
    });
    const input = outcome.permissionRequested[0]!.input as Record<string, unknown>;
    expect("adjustable_settings" in input).toBe(false);
  });

  it.each(["build", "guarded"] as const)(
    "%s：窗里改的模型与上界在 handler 之前落进入参，端口收到的就是它们，文案先把调整说出来",
    async (mode) => {
      const { port, submits } = stubRunPort("dwfrun-adjusted", 13);
      const outcome = await run({
        broker: allowWith({ subagent_model: "openai/gpt-5", max_concurrency: 4 }),
        dynamicWorkflowRunPort: port,
        modelCatalogPort: CATALOG,
        name: "create-workflow-adjusted",
        mode,
        script: cleanScript("adjusted"),
      });

      expect(outcome.result.success).toBe(true);
      expect(submits).toHaveLength(1);
      expect(submits[0]!.subagentModel).toEqual({ providerId: "openai", modelId: "gpt-5" });
      expect(submits[0]!.maxConcurrency).toBe(4);
      const response = (outcome.result.output as CreateWorkflowOutput).response;
      expect(response).toContain(
        "Before approving, the user adjusted the settings in the confirmation window: subagents run on openai/gpt-5 (the main agent stays on the session model); at most 4 subagents run at once (the default is 13).",
      );
      // 调整句已经替两项说过了：普通的设置句不再重复一遍。
      expect(response).not.toContain("At most 4 subagents run at once.");
      expect(response).not.toContain("Subagents run on");
    },
  );

  it("两个 null 把模型提议的值清掉：会话模型、默认并发", async () => {
    const { port, submits } = stubRunPort("dwfrun-adjusted-null", 13);
    const outcome = await run({
      broker: allowWith({ subagent_model: null, max_concurrency: null }),
      dynamicWorkflowRunPort: port,
      maxConcurrency: 8,
      modelCatalogPort: CATALOG,
      name: "create-workflow-adjusted-null",
      script: cleanScript("adjusted-null"),
      subagentModel: "glm-4.6",
    });

    expect("subagentModel" in submits[0]!).toBe(false);
    expect("maxConcurrency" in submits[0]!).toBe(false);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "Before approving, the user adjusted the settings in the confirmation window: subagents are back on the session model; the limit on subagents at once is back to the default.",
    );
  });

  it("窗里高于默认并发的上界原样生效：默认不是上限", async () => {
    const { port, submits } = stubRunPort("dwfrun-adjusted-raise", 13);
    const outcome = await run({
      broker: allowWith({ max_concurrency: 50 }),
      dynamicWorkflowRunPort: port,
      name: "create-workflow-adjusted-raise",
      script: cleanScript("adjusted-raise"),
    });
    expect(submits[0]!.maxConcurrency).toBe(50);
    expect((outcome.result.output as CreateWorkflowOutput).response).toContain(
      "at most 50 subagents run at once (the default is 13).",
    );
  });

  it("用户没动的那一项保留它自己的句子", async () => {
    const { port } = stubRunPort("dwfrun-adjusted-model-only", 13);
    const outcome = await run({
      broker: allowWith({ subagent_model: "openai/gpt-5" }),
      dynamicWorkflowRunPort: port,
      maxConcurrency: 8,
      modelCatalogPort: CATALOG,
      name: "create-workflow-adjusted-model-only",
      script: cleanScript("adjusted-model-only"),
    });
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).toContain(
      "Before approving, the user adjusted the settings in the confirmation window: subagents run on openai/gpt-5 (the main agent stays on the session model).",
    );
    expect(response).toContain("At most 8 subagents run at once.");
  });

  it("与提议相同的「改动」不算调整，文案不说空话", async () => {
    const { port, submits } = stubRunPort("dwfrun-adjusted-same", 13);
    const outcome = await run({
      broker: allowWith({ max_concurrency: 8 }),
      dynamicWorkflowRunPort: port,
      maxConcurrency: 8,
      name: "create-workflow-adjusted-same",
      script: cleanScript("adjusted-same"),
    });
    expect(submits[0]!.maxConcurrency).toBe(8);
    const response = (outcome.result.output as CreateWorkflowOutput).response;
    expect(response).not.toContain("Before approving");
    expect(response).toContain("At most 8 subagents run at once.");
  });

  it("窗里选的模型此刻解不出来：整次调用失败，什么都不启动", async () => {
    const { port, submits } = stubRunPort("dwfrun-adjusted-miss", 13);
    const outcome = await run({
      broker: allowWith({ subagent_model: "gemini-3" }),
      dynamicWorkflowRunPort: port,
      modelCatalogPort: CATALOG,
      name: "create-workflow-adjusted-miss",
      script: cleanScript("adjusted-miss"),
    });
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error?.message).toContain("workflow_subagent_model_unresolved");
    expect(submits).toHaveLength(0);
  });

  it("本会话始终允许 + 调整：授权照常写进会话规则，调整只属于这一次", async () => {
    const permissionService = new PermissionService(defaultPermissionConfig);
    const { port, submits } = stubRunPort("dwfrun-adjusted-session", 13);
    await run({
      broker: {
        async requestPermission(request) {
          return {
            decision: "allow",
            reason: "Approved for this session",
            sessionPermissionUpdates: [
              { behavior: "allow", rules: [{ toolName: request.toolName }], type: "addRules" },
            ],
            inputAdjustments: { max_concurrency: 2 },
          };
        },
      },
      dynamicWorkflowRunPort: port,
      name: "create-workflow-adjusted-session-a",
      permissionService,
      script: cleanScript("adjusted-session-a"),
    });
    const second = await run({
      broker: {
        async requestPermission() {
          throw new Error("第二次不该再向 broker 要确认");
        },
      },
      dynamicWorkflowRunPort: port,
      name: "create-workflow-adjusted-session-b",
      permissionService,
      script: cleanScript("adjusted-session-b"),
    });
    expect(submits.map((submit) => submit.maxConcurrency)).toEqual([2, undefined]);
    expect((second.result.output as CreateWorkflowOutput).response).not.toContain(
      "Before approving",
    );
  });
});
