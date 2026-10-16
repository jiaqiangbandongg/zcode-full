// 中枢直接启动已保存工作流的 runtime 方法（docs/dynamic-workflow/launch.md「On the agent」
// 与「启动轮」行）。它是 `port.submit` 的第二个调用方，与 CreateWorkflow 工具路径同构：复用
// resolveSavedWorkflow + validateWorkflowArgs 归一化、trackExternalBackgroundTask 追踪，但绕开
// 权限判定 + alwaysAsk，并以一条 controlOnly 启动轮把用户真实动作落进会话。
//
// 两组不变式被钉在这里：
//   1. 失败在任何持久化之前——not_found / invalid_name / invalid_args / compile_failed /
//      session_busy 任一都零 submit、零消息、零事件、零追踪。
//   2. 成功路径 submit 参数 + 启动轮消息（source/visibility/metadata）+ TurnStarted/TurnComplete
//      （controlOnly、workflowLaunch）+ trackExternalBackgroundTask 合成 CreateWorkflow 形状 +
//      会话标题 = 工作流名。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionEventType,
  WORKFLOW_DRAFTS_DIR,
  createSessionId,
  type CreateSessionInput,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type SavedWorkflowMeta,
  type SessionEvent,
  type SessionInfo,
  type ModelCatalogPort,
} from "@zcode/contracts";
import { AgentRuntime, saveSavedWorkflow } from "../src/index.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const OK_SCRIPT = "return 42;";
/** 分析器语料里的脚本（与 create-workflow-tool.test.ts 同一份 corpus、同一条读法）。 */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../dynamic-workflow/tests/graphs/${name}`, import.meta.url),
    "utf8",
  );
}
// 带阶段标记与两个子代理的脚本：显示图必须三层齐全（站点 / 阶段词汇表 / 子代理卡）。
const PHASED_SCRIPT = [
  'phase("plan");',
  'const plan = await agent("planner").ask<string>("plan it");',
  'phase("verify");',
  'await agent("checker").ask<string>(`check ${plan}`);',
  "return plan;",
].join("\n");
const BAD_SCRIPT = 'const x: number = "nope";\nreturn x;';
const MODEL_CATALOG: ModelCatalogPort = {
  listModels: () => [
    { providerId: "acme", modelId: "gpt-5", reasoningLevels: [], current: true },
  ],
};

const dirs: string[] = [];
function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// 全局根默认取 os.homedir()：把 HOME 指到空临时目录，避免扫到开发机真实的 ~/.zcode/workflows。
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  const home = makeDir("dwf-launch-home-");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  while (dirs.length > 0) rmSync(dirs.pop()!, { force: true, recursive: true });
});

interface RecordingStore {
  createdSessions: CreateSessionInput[];
  savedMessages: MessageInfo[];
  savedParts: MessagePart[];
}

/** 最小录制会话 store：够 ensureSessionPersisted + 启动轮消息落库与断言用。 */
function createRecordingStore(): RecordingStore & Record<string, unknown> {
  const createdSessions: CreateSessionInput[] = [];
  const savedMessages: MessageInfo[] = [];
  const savedParts: MessagePart[] = [];
  const sessions = new Map<string, SessionInfo>();
  return {
    createdSessions,
    savedMessages,
    savedParts,
    async createSession(input: CreateSessionInput) {
      createdSessions.push(input);
      const now = Date.now();
      const session = {
        ...input,
        taskType: input.taskType ?? "interactive",
        time: { created: now, updated: now },
      } as SessionInfo;
      sessions.set(input.id, session);
      return session;
    },
    async getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    async listSessions() {
      return Array.from(sessions.values());
    },
    async updateSession(input: { id: string }) {
      return sessions.get(input.id) ?? null;
    },
    async saveMessage(input: MessageInfo) {
      savedMessages.push(input);
    },
    async savePart(input: MessagePart) {
      savedParts.push(input);
    },
    async messages(input: { sessionID: string }): Promise<MessageWithParts[]> {
      return savedMessages
        .filter((message) => message.sessionID === input.sessionID)
        .map((info) => ({
          info,
          parts: savedParts.filter((part) => part.messageID === info.id),
        }));
    },
  };
}

interface SubmitCall {
  scriptText: string;
  cwd: string;
  name?: string;
  args?: Record<string, unknown>;
  parentSessionId?: string;
  toolCallId?: string;
  /** 侧栏迷你轨道的两张表；中枢直接启动与 CreateWorkflow 工具路径必须画出同一条轨道。 */
  phaseNames?: string[];
  phaseAlongside?: number[][];
  /** 工作副本的落点（docs/dynamic-workflow/launch.md「Script files」）。 */
  scriptPath?: string;
  /** 脚本点名的模型（docs/dynamic-workflow/launch.md「Models the script names」）。 */
  modelBindings?: Record<string, unknown>;
  /** 测试侧记录：submit 那一刻 store 里已落的会话行数（父会话必须先于 submit 落行）。 */
  sessionsPersistedAtSubmit?: number;
}

function makeRuntime(options: {
  name: string;
  cwd: string;
  modelCatalogPort?: ModelCatalogPort;
  submit?: (request: SubmitCall) => { ok: true; runId: string } | { ok: false; reason: string };
}): {
  runtime: AgentRuntime;
  events: SessionEvent[];
  store: RecordingStore;
  submitCalls: SubmitCall[];
} {
  const submitCalls: SubmitCall[] = [];
  const store = createRecordingStore();
  const runtime = new AgentRuntime(
    createSessionId(options.name),
    { agentName: "dwf-launch-test", workingDirectory: options.cwd },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: store as never,
      modelAdapter: {} as never,
      ...(options.modelCatalogPort === undefined
        ? {}
        : { modelCatalogPort: options.modelCatalogPort }),
      dynamicWorkflowRunPort: {
        async submit(request: SubmitCall) {
          submitCalls.push({ ...request, sessionsPersistedAtSubmit: store.createdSessions.length });
          return options.submit ? options.submit(request) : { ok: true, runId: "dwfrun-launch-1" };
        },
        // 追踪器会挂一个 waiter；永不 settle，测试不等完成。
        async getTask() {
          return {
            runId: "dwfrun-launch-1",
            taskId: "dwfrun-launch-1",
            startedAt: new Date(),
            status: "running",
          };
        },
        waitForTask: () => new Promise(() => {}),
        async cancel() {
          return true;
        },
        async listEvents() {
          return [];
        },
      } as never,
    },
  );
  const events: SessionEvent[] = [];
  runtime.subscribeEvents({ onSessionEvent: (event) => events.push(event) });
  return { runtime, events, store, submitCalls };
}

function seed(cwd: string, name: string, script: string, meta?: Partial<SavedWorkflowMeta>): void {
  saveSavedWorkflow({
    cwd,
    name,
    scope: "project",
    script,
    meta: { description: meta?.description ?? `${name} workflow`, ...meta },
  });
}

describe("startSavedWorkflowRun — 失败在任何持久化之前", () => {
  it("session_busy：有活动 turn 时零 submit、零持久化、零事件", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT);
    const { runtime, events, store, submitCalls } = makeRuntime({ name: "busy", cwd });
    // 制造忙碌：hasActiveOrQueuedTurnWork 读 activeTurn。
    (runtime as unknown as { activeTurn: unknown }).activeTurn = { pendingInputs: [] };

    const result = await runtime.startSavedWorkflowRun({ name: "reporter" });

    expect(result).toEqual({ ok: false, reason: "session_busy" });
    expect(submitCalls).toHaveLength(0);
    expect(store.createdSessions).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("not_found：无此定义时零副作用", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    const { runtime, events, store, submitCalls } = makeRuntime({ name: "missing", cwd });

    const result = await runtime.startSavedWorkflowRun({ name: "ghost" });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "not_found" });
    expect(submitCalls).toHaveLength(0);
    expect(store.createdSessions).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("invalid_name：路径穿越形状的名字被名字校验挡下", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    const { runtime, submitCalls, store } = makeRuntime({ name: "badname", cwd });

    const result = await runtime.startSavedWorkflowRun({ name: "../../etc/passwd" });

    expect(result).toMatchObject({ ok: false, reason: "invalid_name" });
    expect(submitCalls).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
  });

  it("invalid_args：多传未声明参数即拒绝，零 submit", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT); // 无 args 声明
    const { runtime, submitCalls, store, events } = makeRuntime({ name: "badargs", cwd });

    const result = await runtime.startSavedWorkflowRun({ name: "reporter", args: { pr: "12" } });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "invalid_args" });
    expect((result as { message?: string }).message).toContain("pr");
    expect(submitCalls).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("compile_failed：编不过的脚本拒绝，诊断进 message，零 submit", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "broken", BAD_SCRIPT);
    const { runtime, submitCalls, store, events } = makeRuntime({ name: "compilefail", cwd });

    const result = await runtime.startSavedWorkflowRun({ name: "broken" });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "compile_failed" });
    expect((result as { message?: string }).message).toContain("not assignable");
    expect(submitCalls).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  // docs/dynamic-workflow/launch.md「On the agent」：脚本点名的模型与 CreateWorkflow 同一段代码解析，
  // 解不出来的名字是 9011，按 compile_failed 拒绝。
  it("compile_failed：脚本点名的模型在本机目录里解析不出来（9011），零 submit", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "judged", 'await agent("评审员", { model: "gemini-3" }).ask("x");\nreturn 1;');
    const { runtime, submitCalls, store } = makeRuntime({
      name: "modelfail",
      cwd,
      modelCatalogPort: MODEL_CATALOG,
    });

    const result = await runtime.startSavedWorkflowRun({ name: "judged" });

    expect(result).toMatchObject({ ok: false, reason: "compile_failed" });
    expect((result as { message?: string }).message).toContain('The model "gemini-3"');
    expect((result as { message?: string }).message).toContain("acme/gpt-5");
    expect(submitCalls).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
  });

  it("start_failed：端口缺席 → 能力不支持面（干净编译之后）", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT);
    const store = createRecordingStore();
    const runtime = new AgentRuntime(
      createSessionId("noport"),
      { agentName: "dwf-launch-test", workingDirectory: cwd },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: store as never,
        modelAdapter: {} as never,
        // 无 dynamicWorkflowRunPort。
      },
    );
    const result = await runtime.startSavedWorkflowRun({ name: "reporter" });
    expect(result).toMatchObject({ ok: false, reason: "start_failed" });
    expect((result as { message?: string }).message).toContain("port unavailable");
    expect(store.savedMessages).toHaveLength(0);
  });
});

describe("startSavedWorkflowRun — 成功路径", () => {
  it("启动轮元数据的显示图三层齐全：站点、阶段词汇表、子代理卡（与 CreateWorkflow 同一投影）", async () => {
    // 2026-09-14 实机根因：启动路径手拼 boundCausalityGraph 实参而只传了因果图，display 有站点
    // 却没有 phases / participants，run 详情侧板只剩一条空脊线、没有子代理。零 ask 的 OK_SCRIPT
    // 看不出这一层缺失，所以这里用带阶段与两个子代理的脚本钉住三层。
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "phased", PHASED_SCRIPT);
    const { runtime, store } = makeRuntime({
      name: "ok-phased",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-phased" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "phased" });
    expect(result).toMatchObject({ ok: true, runId: "dwfrun-phased" });

    const launchMessage = store.savedMessages.find((m) => m.source === "workflow_launch");
    const display = (
      launchMessage?.metadata?.workflowLaunch as
        | {
            display?: {
              causalityGraph?: {
                steps: unknown[];
                phases?: { name?: string }[];
                participants: { lane: string; phase: string }[];
              };
            };
          }
        | undefined
    )?.display;
    const graph = display?.causalityGraph;
    expect(graph).toBeDefined();
    expect(graph!.steps).toHaveLength(2);
    expect(graph!.phases?.map((phase) => phase.name)).toEqual(["plan", "verify"]);
    expect(graph!.participants).toHaveLength(2);
    expect(new Set(graph!.participants.map((participant) => participant.lane)).size).toBe(2);
    for (const participant of graph!.participants) {
      expect(
        graph!.phases!.some((phase) => (phase as { id?: string }).id === participant.phase),
      ).toBe(true);
    }
  });

  // 侧栏迷你轨道的两张表（docs/dynamic-workflow/presentation.md「The sidebar run line」）：
  // 中枢直接启动与 CreateWorkflow 工具路径读同一个投影、同一对函数，同一脚本画同一条轨道。
  it("submit 带上声明阶段表与「同时在跑」表", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "parallel", fixture("strand-fanout-two-phases-join.ts"));
    const { runtime, submitCalls } = makeRuntime({
      name: "ok-alongside",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-alongside" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "parallel" });

    expect(result.ok).toBe(true);
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]!.phaseNames).toEqual(["A", "B", "C"]);
    expect(submitCalls[0]!.phaseAlongside).toEqual([[], [0], []]);
  });

  // docs/dynamic-workflow/launch.md「Script files」：中枢直接启动与 CreateWorkflow 的 saved 来源
  // 是同一件事，所以工作副本也按同一条规矩写——逐字节，保存的定义本身一个字都不动。
  it("submit 带上工作副本的落点，拷贝逐字节等于保存的文件", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT, { description: "Write a daily report" });
    const { runtime, submitCalls } = makeRuntime({
      name: "ok-scriptpath",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-scriptpath" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "reporter" });

    expect(result.ok).toBe(true);
    const draft = join(cwd, WORKFLOW_DRAFTS_DIR, "reporter.dwf.ts");
    expect(submitCalls[0]!.scriptPath).toBe(draft);
    expect(readFileSync(draft, "utf8")).toBe(
      readFileSync(join(cwd, ".zcode/workflows/reporter.dwf.ts"), "utf8"),
    );
  });

  it("submit 带上脚本点名的模型，已解析成结构化选择；没点名时整个键缺席", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "judged", 'await agent("评审员", { model: "GPT-5" }).ask("x");\nreturn 1;');
    seed(cwd, "plain", OK_SCRIPT);
    const { runtime, submitCalls } = makeRuntime({
      name: "ok-models",
      cwd,
      modelCatalogPort: MODEL_CATALOG,
      submit: () => ({ ok: true, runId: "dwfrun-models" }),
    });

    expect((await runtime.startSavedWorkflowRun({ name: "judged" })).ok).toBe(true);
    expect(submitCalls[0]!.modelBindings).toEqual({
      "GPT-5": { providerId: "acme", modelId: "gpt-5" },
    });
  });

  it("submit 参数 + 启动轮消息 + turn 边界 + 追踪 + 会话标题（无实参）", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT, { description: "Write a daily report" });
    const { runtime, events, store, submitCalls } = makeRuntime({
      name: "ok-noargs",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-ok" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "reporter" });

    expect(result.ok).toBe(true);
    const toolCallId = (result as { toolCallId: string }).toolCallId;
    expect(result).toMatchObject({ ok: true, runId: "dwfrun-ok" });
    expect(toolCallId).toMatch(/^launch-/);
    // 协议层据此让会话离开 draft（进 session/list 与 sessions-index，侧栏才看得见）。
    expect(runtime.isSessionPersisted()).toBe(true);

    // submit：脚本逐字、name = 解析名、parentSessionId = 会话、toolCallId = launch- 前缀；无 args 键。
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toMatchObject({
      scriptText: OK_SCRIPT,
      cwd,
      name: "reporter",
      parentSessionId: "sess_ok-noargs",
      toolCallId,
    });
    expect(submitCalls[0]!.args).toBeUndefined();
    // 父会话行必须先于 submit 落库（actor 的 session_task_link.parent_session_id 对 session(id)
    // 有外键；2026-09-03 实机首启即以 DriverError「创建 actor 会话失败」结算的根因）。
    expect(submitCalls[0]!.sessionsPersistedAtSubmit).toBe(1);
    expect(store.createdSessions[0]).toMatchObject({ id: "sess_ok-noargs" });

    // 启动轮消息：role=user、synthetic、source/visibility、real_user 语义、workflowLaunch 元数据。
    const launchMessage = store.savedMessages.find((m) => m.source === "workflow_launch");
    expect(launchMessage).toBeDefined();
    expect(launchMessage).toMatchObject({
      role: "user",
      synthetic: true,
      source: "workflow_launch",
      visibility: "user-visible",
    });
    expect(launchMessage?.semantics).toMatchObject({
      origin: "real_user",
      kind: "user_prompt",
      source: "workflow_launch",
      transcriptVisibility: "visible",
    });
    expect(launchMessage?.metadata?.workflowLaunch).toMatchObject({
      runId: "dwfrun-ok",
      toolCallId,
      name: "reporter",
      scope: "project",
      description: "Write a daily report",
    });
    // 图与脚本随启动轮走（侧板按 toolCallId 找发起行取图/脚本，直接启动没有工具行）。
    // OK_SCRIPT 是零 ask 的最小脚本：图可为空，但 display 本体（同一构造函数）与脚本原文必须在。
    const launchMeta = launchMessage?.metadata?.workflowLaunch as
      | { display?: { kind?: string; ok?: boolean; diagnostics?: unknown[] }; script?: string }
      | undefined;
    expect(launchMeta?.display).toMatchObject({
      kind: "create_workflow",
      ok: true,
      diagnostics: [],
    });
    expect(launchMeta?.script).toBe(OK_SCRIPT);

    // 消息正文 = 规范英文句（旧客户端降级呈现），劝阻重复启动。
    const part = store.savedParts.find(
      (p) => p.messageID === launchMessage?.id && p.type === "text",
    );
    expect((part as { text?: string } | undefined)?.text).toContain(
      'Started the saved workflow "reporter" (project)',
    );
    expect((part as { text?: string } | undefined)?.text).toContain("do not start it again");
    expect((part as { text?: string } | undefined)?.text).not.toContain("Arguments:");

    // TurnStarted：controlOnly + inputSource + workflowLaunch。
    const turnStarted = events.find((e) => e.type === SessionEventType.TurnStarted);
    expect(turnStarted?.payload).toMatchObject({
      executionKind: "controlOnly",
      inputSource: "workflow_launch",
      workflowLaunch: { runId: "dwfrun-ok", name: "reporter", scope: "project" },
    });
    expect(events.some((e) => e.type === SessionEventType.TurnComplete)).toBe(true);

    // 追踪：合成 CreateWorkflow 描述子 → BackgroundTaskStarted（workflow 面板、可取消、subject=名）。
    const started = events.find((e) => e.type === SessionEventType.BackgroundTaskStarted);
    expect(started?.payload).toMatchObject({
      cancellable: true,
      description: "reporter",
      status: "running",
      taskId: "dwfrun-ok",
      taskKind: "workflow",
      toolCallId,
      toolName: "CreateWorkflow",
    });
    expect(runtime.hasRunningBackgroundTasks()).toBe(true);

    // 会话标题 = 工作流名（first_input）。
    expect(store.createdSessions[0]?.title).toBe("reporter");
    expect(store.createdSessions[0]?.titleSource).toBe("first_input");
  });

  it("有实参：submit.args + 元数据 args + 消息正文附 JSON 块", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "review", OK_SCRIPT, {
      description: "Review a PR",
      args: { pr: { type: "string", required: true }, deep: { type: "boolean", default: false } },
    });
    const { runtime, events, store, submitCalls } = makeRuntime({
      name: "ok-args",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-args" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "review", args: { pr: "42" } });

    expect(result.ok).toBe(true);
    // validateWorkflowArgs 回填默认值 deep=false。
    expect(submitCalls[0]!.args).toEqual({ pr: "42", deep: false });

    const launchMessage = store.savedMessages.find((m) => m.source === "workflow_launch");
    expect(launchMessage?.metadata?.workflowLaunch).toMatchObject({
      args: { pr: "42", deep: false },
    });
    const part = store.savedParts.find(
      (p) => p.messageID === launchMessage?.id && p.type === "text",
    );
    expect((part as { text?: string } | undefined)?.text).toContain("Arguments:");
    expect((part as { text?: string } | undefined)?.text).toContain('"pr": "42"');

    const turnStarted = events.find((e) => e.type === SessionEventType.TurnStarted);
    const startedPayload = turnStarted?.payload as
      | { workflowLaunch?: { args?: unknown } }
      | undefined;
    expect(startedPayload?.workflowLaunch?.args).toEqual({
      pr: "42",
      deep: false,
    });
  });
});

