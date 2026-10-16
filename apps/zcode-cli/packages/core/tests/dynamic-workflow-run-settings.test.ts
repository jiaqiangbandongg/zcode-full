// GUI「配置」的 runtime 方法（docs/dynamic-workflow/launch.md「Changing a run's settings from the
// GUI」）。它是 `port.amend` 的第二个调用方，与 AmendWorkflow 工具共用三态归一，但不经模型轮、
// 不开确认窗，并用一条排队的 controlOnly「设置轮」记下这件事。
//
// 钉住的不变式：
//   1. 每一种拒绝都发生在 `port.amend` 之前——零 amend、零消息、零事件。
//   2. 成功路径：amend 入参（沿用脚本、inheritArgs、新设置、settings- 前缀）+ 合成 AmendWorkflow
//      追踪 + 设置轮（元数据带 amend 块、无 scope/path/script）。
//   2b. 新 run 记下脚本文件：前驱的文件仍是这份字节就继续记它，否则写一份新草稿（与工具沿用脚本
//      同一条规则，docs/dynamic-workflow/launch.md「Provenance」）。
//   3. 主代理在一轮里时，设置轮等这一轮结束；活动 turn 的吸收在它这里停下，后到的通知排在它后面。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SessionEventType,
  WORKFLOW_DRAFTS_DIR,
  createSessionId,
  type CreateSessionInput,
  type DynamicWorkflowRunAmendRequest,
  type DynamicWorkflowRunRetuneRequest,
  type DynamicWorkflowRunRetuneResult,
  type DynamicWorkflowRunSnapshot,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type ModelCatalogPort,
  type SessionEvent,
  type SessionInfo,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/index.js";
import { createRuntimeCommandId } from "../src/runtime/command-queue.js";
import { drainPendingRuntimeCommandsForActiveLoop } from "../src/runtime/methods/runtime-command-active-loop.js";
import { buildSettingsMessageText } from "../src/runtime/methods/dynamic-workflow-run-settings.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const STORED_SCRIPT = [
  'phase("plan");',
  'const plan = await agent("planner").ask<string>("plan it");',
  "return plan;",
].join("\n");
const BROKEN_SCRIPT = 'const x: number = "nope";\nreturn x;';
const PREVIOUS = "dwfrun-prev";

interface RecordingStore {
  createdSessions: CreateSessionInput[];
  savedMessages: MessageInfo[];
  savedParts: MessagePart[];
}

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

const CATALOG: ModelCatalogPort = {
  listModels: () => [
    { providerId: "bigmodel", modelId: "GLM-5.3", reasoningLevels: [], current: true },
    { providerId: "bigmodel", modelId: "GLM-5.3-Flash", reasoningLevels: [] },
  ],
};

// 成功路径会在工作目录下写草稿，所以工作目录必须是用完即删的临时目录，而不是一个共享的 /tmp 路径。
const SETTINGS_CWD = mkdtempSync(join(tmpdir(), "dwf-settings-"));
afterAll(() => rmSync(SETTINGS_CWD, { recursive: true, force: true }));

function makeRuntime(options: {
  name: string;
  snapshot?: Partial<DynamicWorkflowRunSnapshot> | null;
  script?: string | null;
  defaultConcurrency?: number;
  catalog?: ModelCatalogPort | null;
  amend?: (
    request: DynamicWorkflowRunAmendRequest,
  ) =>
    | { ok: true; runId: string; supersededRunId?: string }
    | { ok: false; reason: "run_not_found" | "missing_boundaries" };
  /**
   * `retuneConcurrency` 的答复（docs/dynamic-workflow/launch.md「The fork」）。缺席即端口没有这个
   * 方法（老宿主的形状）——那时只改并发的「配置」照旧落成一次修订。
   */
  retune?: DynamicWorkflowRunRetuneResult;
}): {
  runtime: AgentRuntime;
  events: SessionEvent[];
  store: RecordingStore;
  amends: DynamicWorkflowRunAmendRequest[];
  retunes: DynamicWorkflowRunRetuneRequest[];
  getScriptCalls: string[];
  sessionId: string;
} {
  const sessionId = createSessionId(options.name);
  const amends: DynamicWorkflowRunAmendRequest[] = [];
  const retunes: DynamicWorkflowRunRetuneRequest[] = [];
  const getScriptCalls: string[] = [];
  const store = createRecordingStore();
  const snapshot: DynamicWorkflowRunSnapshot | undefined =
    options.snapshot === null
      ? undefined
      : ({
          runId: PREVIOUS,
          taskId: PREVIOUS,
          startedAt: new Date(),
          status: "running",
          name: "triage",
          parentSessionId: sessionId,
          ...options.snapshot,
        } as DynamicWorkflowRunSnapshot);
  const runtime = new AgentRuntime(
    sessionId,
    { agentName: "dwf-settings-test", workingDirectory: SETTINGS_CWD },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: store as never,
      modelAdapter: {} as never,
      ...(options.catalog === null ? {} : { modelCatalogPort: options.catalog ?? CATALOG }),
      dynamicWorkflowRunPort: {
        async submit() {
          throw new Error("settings never submit");
        },
        async amend(request: DynamicWorkflowRunAmendRequest) {
          amends.push(request);
          return options.amend
            ? options.amend(request)
            : { ok: true, runId: "dwfrun-next", supersededRunId: PREVIOUS };
        },
        async getTask(runId: string) {
          if (runId === PREVIOUS) return snapshot;
          // 新 run 在追踪器眼里一直在跑（waiter 永不 settle），不产生任何通知。
          return {
            runId,
            taskId: runId,
            startedAt: new Date(),
            status: "running",
            parentSessionId: sessionId,
          } as DynamicWorkflowRunSnapshot;
        },
        async getScript(runId: string) {
          getScriptCalls.push(runId);
          if (runId !== PREVIOUS || options.script === null) return undefined;
          return options.script ?? STORED_SCRIPT;
        },
        ...(options.retune === undefined
          ? {}
          : {
              async retuneConcurrency(request: DynamicWorkflowRunRetuneRequest) {
                retunes.push(request);
                return options.retune as DynamicWorkflowRunRetuneResult;
              },
            }),
        defaultConcurrency: () => options.defaultConcurrency ?? 13,
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
  return { runtime, events, store, amends, retunes, getScriptCalls, sessionId };
}

/** 设置轮经运行时队列落下；空闲会话里入队即跑，等到它的 TurnComplete。 */
async function settleQueue(events: SessionEvent[]): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (events.some((event) => event.type === SessionEventType.TurnComplete)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("amendWorkflowRunSettings — 拒绝在 port.amend 之前", () => {
  it.each([
    ["not_found：没有这个 run", { snapshot: null }, { maxConcurrency: 4 }, "not_found"],
    [
      "not_found：run 属于别的会话",
      { snapshot: { parentSessionId: "sess_other" } },
      { maxConcurrency: 4 },
      "not_found",
    ],
    [
      "not_configurable：已完成",
      { snapshot: { runStatus: "completed", status: "completed" } },
      { maxConcurrency: 4 },
      "not_configurable",
    ],
    [
      "not_configurable：已被替代",
      { snapshot: { runStatus: "stopped", supersededBy: "dwfrun-x" } },
      { maxConcurrency: 4 },
      "not_configurable",
    ],
    ["script_missing：没有存下的脚本", { script: null }, { maxConcurrency: 4 }, "script_missing"],
    [
      "model_unavailable：目录里没有这个模型",
      {},
      { subagentModel: "bigmodel/GLM-9" },
      "model_unavailable",
    ],
    [
      "model_unavailable：没有目录却要换模型",
      { catalog: null },
      { subagentModel: "bigmodel/GLM-5.3-Flash" },
      "model_unavailable",
    ],
    ["unchanged：什么都没传", {}, {}, "unchanged"],
    [
      "unchanged：设成现在的值",
      { snapshot: { maxConcurrency: 4, subagentModel: "bigmodel/GLM-5.3-Flash" } },
      { maxConcurrency: 4, subagentModel: "bigmodel/GLM-5.3-Flash" },
      "unchanged",
    ],
    [
      "unchanged：停在默认并发上 = 本来就没有自己的界",
      { defaultConcurrency: 13 },
      { maxConcurrency: 13 },
      "unchanged",
    ],
    [
      "compile_failed：存下的脚本编不过",
      { script: BROKEN_SCRIPT },
      { maxConcurrency: 4 },
      "compile_failed",
    ],
  ] as const)("%s", async (_case, setup, change, reason) => {
    const { runtime, amends, store, events } = makeRuntime({
      name: `reject-${reason}`,
      ...(setup as Parameters<typeof makeRuntime>[0]),
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, ...change });

    expect(result).toMatchObject({ ok: false, reason });
    expect(amends).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("编译诊断与模型解析诊断随 message 走", async () => {
    const broken = makeRuntime({ name: "diag-compile", script: BROKEN_SCRIPT });
    const compile = await broken.runtime.amendWorkflowRunSettings({
      runId: PREVIOUS,
      maxConcurrency: 4,
    });
    expect((compile as { message?: string }).message).toContain("not assignable");

    const unknown = makeRuntime({ name: "diag-model" });
    const model = await unknown.runtime.amendWorkflowRunSettings({
      runId: PREVIOUS,
      subagentModel: "bigmodel/GLM-9",
    });
    expect((model as { message?: string }).message).toBeTruthy();
  });

  it.each([
    ["run_not_found", "not_found"],
    ["missing_boundaries", "missing_boundaries"],
  ] as const)("端口拒绝 %s → %s，不记设置轮", async (portReason, reason) => {
    const { runtime, store, events } = makeRuntime({
      name: `port-${portReason}`,
      amend: () => ({ ok: false, reason: portReason }),
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(result).toEqual({ ok: false, reason });
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("端口抛错 → start_failed，message 是原因", async () => {
    const { runtime } = makeRuntime({
      name: "port-throw",
      amend: () => {
        throw new Error("journal locked");
      },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(result).toEqual({ ok: false, reason: "start_failed", message: "journal locked" });
  });
});

// docs/dynamic-workflow/launch.md「On the agent」：重跑的是 run 自己的脚本，脚本点名的模型沿用
// launch 时那张绑定表（用户在确认窗里换过的模型因此留得住），并对着目录再解析一遍。
describe("amendWorkflowRunSettings — 脚本点名的模型", () => {
  const JUDGED_SCRIPT = [
    'phase("judge");',
    'const verdict = await agent("评审员", { model: "GLM-5.3-Flash" }).ask<string>("judge");',
    "return verdict;",
  ].join("\n");

  it("沿用前驱的绑定（不是按名字重新解析）交给 port.amend", async () => {
    const { runtime, amends } = makeRuntime({
      name: "models-kept",
      script: JUDGED_SCRIPT,
      // 用户在前驱确认窗里把 "GLM-5.3-Flash" 这一行换成了 GLM-5.3。
      snapshot: { modelBindings: { "GLM-5.3-Flash": "bigmodel/GLM-5.3" } },
    });
    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });
    expect(result).toMatchObject({ ok: true });
    expect(amends[0]!.modelBindings).toEqual({
      "GLM-5.3-Flash": { providerId: "bigmodel", modelId: "GLM-5.3" },
    });
  });

  it("沿用的模型已不在目录里：model_unavailable，诊断随 message 走，零 amend", async () => {
    const { runtime, amends, store } = makeRuntime({
      name: "models-gone",
      script: JUDGED_SCRIPT,
      snapshot: { modelBindings: { "GLM-5.3-Flash": "retired/GLM-4" } },
    });
    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });
    expect(result).toMatchObject({ ok: false, reason: "model_unavailable" });
    expect((result as { message?: string }).message).toContain("retired/GLM-4");
    expect(amends).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
  });
});

describe("amendWorkflowRunSettings — 成功路径", () => {
  it("沿用脚本与实参、带上新设置，登记合成 AmendWorkflow，并落一条设置轮", async () => {
    const { runtime, amends, store, events, sessionId } = makeRuntime({
      name: "ok",
      snapshot: { maxConcurrency: 8 },
    });

    const result = await runtime.amendWorkflowRunSettings({
      runId: PREVIOUS,
      subagentModel: "bigmodel/GLM-5.3-Flash",
      maxConcurrency: 4,
    });

    expect(result).toMatchObject({ ok: true, runId: "dwfrun-next", supersededRunId: PREVIOUS });
    const toolCallId = (result as { toolCallId: string }).toolCallId;
    expect(toolCallId).toMatch(/^settings-/);

    expect(amends).toHaveLength(1);
    expect(amends[0]).toMatchObject({
      scriptText: STORED_SCRIPT,
      predecessorRunId: PREVIOUS,
      parentSessionId: sessionId,
      toolCallId,
      maxConcurrency: 4,
      subagentModel: { providerId: "bigmodel", modelId: "GLM-5.3-Flash" },
      inheritArgs: true,
      phaseNames: ["plan"],
    });
    // 展示名不传：service 沿用前驱的名字。
    expect(amends[0]!.name).toBeUndefined();

    // 追踪：合成 AmendWorkflow 描述子 → BackgroundTaskStarted（workflow 面板、可取消）。
    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect(started?.payload).toMatchObject({
      cancellable: true,
      taskId: "dwfrun-next",
      taskKind: "workflow",
      toolCallId,
      toolName: "AmendWorkflow",
    });

    await settleQueue(events);
    const message = store.savedMessages.find((m) => m.source === "workflow_launch");
    expect(message).toMatchObject({ role: "user", synthetic: true, visibility: "user-visible" });
    const meta = message?.metadata?.workflowLaunch as Record<string, unknown> | undefined;
    expect(meta).toMatchObject({
      runId: "dwfrun-next",
      toolCallId,
      name: "triage",
      amend: {
        predecessorRunId: PREVIOUS,
        subagentModel: { to: "bigmodel/GLM-5.3-Flash" },
        maxConcurrency: { from: 8, to: 4 },
        ceiling: 13,
      },
    });
    // 设置轮不指保存文件，也不带脚本（脚本是前驱的，侧板要的只是图）。
    expect(meta).not.toHaveProperty("scope");
    expect(meta).not.toHaveProperty("path");
    expect(meta).not.toHaveProperty("script");
    expect((meta?.display as { kind?: string } | undefined)?.kind).toBe("create_workflow");

    const turnStarted = events.find((event) => event.type === SessionEventType.TurnStarted);
    expect(turnStarted?.payload).toMatchObject({
      executionKind: "controlOnly",
      inputSource: "workflow_launch",
      workflowLaunch: { runId: "dwfrun-next", amend: { predecessorRunId: PREVIOUS } },
    });
    const part = store.savedParts.find(
      (candidate) => candidate.messageID === message?.id && candidate.type === "text",
    );
    expect((part as { text?: string } | undefined)?.text).toContain(
      `Changed the settings of workflow run ${PREVIOUS} ("triage") from the GUI`,
    );
  });

  it("null 回到默认：模型回会话模型、界回默认并发；端口两个键都缺席", async () => {
    const { runtime, amends, store, events } = makeRuntime({
      name: "reset",
      snapshot: { maxConcurrency: 4, subagentModel: "bigmodel/GLM-5.3-Flash" },
    });

    const result = await runtime.amendWorkflowRunSettings({
      runId: PREVIOUS,
      subagentModel: null,
      maxConcurrency: null,
    });

    expect(result.ok).toBe(true);
    expect(amends[0]).not.toHaveProperty("maxConcurrency");
    expect(amends[0]).not.toHaveProperty("subagentModel");
    await settleQueue(events);
    const meta = store.savedMessages.find((m) => m.source === "workflow_launch")?.metadata
      ?.workflowLaunch as { amend?: Record<string, unknown> } | undefined;
    expect(meta?.amend).toEqual({
      predecessorRunId: PREVIOUS,
      subagentModel: { from: "bigmodel/GLM-5.3-Flash" },
      maxConcurrency: { from: 4 },
      ceiling: 13,
    });
  });

  it("只改并发时模型沿用前驱的那一个（重新解析一遍），设置轮只记改了的那一项", async () => {
    const { runtime, amends, store, events } = makeRuntime({
      name: "keep-model",
      snapshot: { subagentModel: "bigmodel/GLM-5.3-Flash" },
    });

    await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 2 });

    expect(amends[0]).toMatchObject({
      maxConcurrency: 2,
      subagentModel: { providerId: "bigmodel", modelId: "GLM-5.3-Flash" },
    });
    await settleQueue(events);
    const meta = store.savedMessages.find((m) => m.source === "workflow_launch")?.metadata
      ?.workflowLaunch as { amend?: Record<string, unknown> } | undefined;
    expect(meta?.amend).not.toHaveProperty("subagentModel");
    expect(meta?.amend).toMatchObject({ maxConcurrency: { to: 2 } });
  });

  it("主代理在一轮里：设置轮排队，活动轮的吸收在它这里停下，后到的通知排在它后面", async () => {
    const { runtime, store } = makeRuntime({ name: "busy" });
    const internal = runtime as unknown as {
      runtimeCommandDrainActive: boolean;
      runtimeCommandQueue: { snapshot(): readonly { mode: string }[] };
      enqueueRuntimeCommand(command: unknown): void;
      branchGeneration: number;
      rootTraceContext: unknown;
    };
    // 制造「正在一轮里」：队列的 drain 被占着，新命令只能排队。
    internal.runtimeCommandDrainActive = true;

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });
    expect(result.ok).toBe(true);
    // 新 run 的通知在设置轮之后入队。
    internal.enqueueRuntimeCommand({
      branchGeneration: internal.branchGeneration,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      taskId: "dwfrun-next",
      text: "run dwfrun-next completed",
      traceContext: internal.rootTraceContext,
    });

    expect(store.savedMessages).toHaveLength(0);
    expect(internal.runtimeCommandQueue.snapshot().map((command) => command.mode)).toEqual([
      "control-only-turn",
      "task-notification",
    ]);
    // 活动轮的吸收不越过设置轮：通知要留给外层队列，排在设置轮之后。
    const drained = await drainPendingRuntimeCommandsForActiveLoop.call(runtime as never);
    expect(drained.drained).toBe(0);
    expect(internal.runtimeCommandQueue.snapshot()).toHaveLength(2);
  });
});

describe("amendWorkflowRunSettings — 新 run 的脚本文件", () => {
  it("前驱的脚本文件仍是这份字节：新 run 继续记它，不写新草稿", async () => {
    const dir = join(SETTINGS_CWD, WORKFLOW_DRAFTS_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "kept-by-settings.dwf.ts");
    writeFileSync(file, STORED_SCRIPT, "utf8");
    const { runtime, amends } = makeRuntime({ name: "keep-file", snapshot: { scriptPath: file } });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(result).toMatchObject({ ok: true });
    expect(amends[0]!.scriptPath).toBe(file);
  });

  it("前驱的文件已被改过（或没记过文件）：写一份装着存档脚本的新草稿并记它", async () => {
    const dir = join(SETTINGS_CWD, WORKFLOW_DRAFTS_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "edited-since.dwf.ts");
    writeFileSync(file, `${STORED_SCRIPT}\n// edited\n`, "utf8");
    const { runtime, amends } = makeRuntime({
      name: "diverged-file",
      snapshot: { scriptPath: file, name: "settings diverged" },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(result).toMatchObject({ ok: true });
    const recorded = amends[0]!.scriptPath;
    expect(recorded).toBe(join(dir, "settings-diverged.dwf.ts"));
    expect(readFileSync(recorded!, "utf8")).toBe(STORED_SCRIPT);
    expect(readFileSync(file, "utf8")).toContain("// edited");
  });

  it("拒绝的调用不落草稿：直到 port.amend 之前都是零副作用", async () => {
    const { runtime, amends } = makeRuntime({
      name: "unchanged-no-draft",
      snapshot: { name: "never written", maxConcurrency: 4 },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(result).toMatchObject({ ok: false, reason: "unchanged" });
    expect(amends).toHaveLength(0);
    expect(() =>
      readFileSync(join(SETTINGS_CWD, WORKFLOW_DRAFTS_DIR, "never-written.dwf.ts")),
    ).toThrow();
  });
});

describe("amendWorkflowRunSettings — 无名 run", () => {
  // 2026-09-18 实机：无名 run 的设置轮曾兜底成名字 `run <id>`，卡片与侧板标题成了一串 run id。
  it("前驱没有名字：设置轮元数据与合成追踪都不带名字，规范句也不编一个", async () => {
    const { runtime, store, events } = makeRuntime({
      name: "unnamed",
      snapshot: { name: undefined },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });
    expect(result.ok).toBe(true);

    const started = events.find((event) => event.type === SessionEventType.BackgroundTaskStarted);
    expect((started?.payload as { description?: string } | undefined)?.description).not.toContain(
      "run dwfrun",
    );
    await settleQueue(events);
    const message = store.savedMessages.find((m) => m.source === "workflow_launch");
    expect(message?.metadata?.workflowLaunch).not.toHaveProperty("name");
    const part = store.savedParts.find(
      (candidate) => candidate.messageID === message?.id && candidate.type === "text",
    );
    expect((part as { text?: string } | undefined)?.text).toContain(
      `Changed the settings of workflow run ${PREVIOUS} from the GUI`,
    );
  });
});

// 只改并发、run 还活着 ⇒ 就地生效（docs/dynamic-workflow/launch.md「On the agent」的分叉行）：
// 同一个 runId、没有 supersededRunId、不登记第二个后台任务，设置轮的 amend 块不带
// predecessorRunId（缺席即「就地生效」）。脚本读挪到分叉之后，所以没有存档脚本的 run 也能调。
describe("amendWorkflowRunSettings — 只改并发即就地生效", () => {
  it("同一个 runId、无 supersededRunId、不 amend、不读脚本，设置轮记下这一手", async () => {
    const { runtime, amends, retunes, getScriptCalls, store, events } = makeRuntime({
      name: "retune-ok",
      snapshot: { maxConcurrency: 8 },
      retune: { ok: true, maxConcurrency: 4, previous: 8, defaultConcurrency: 13 },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(result).toEqual({ ok: true, runId: PREVIOUS, toolCallId: expect.any(String) });
    expect((result as { toolCallId: string }).toolCallId).toMatch(/^settings-/);
    expect(retunes).toEqual([{ runId: PREVIOUS, maxConcurrency: 4 }]);
    expect(amends).toHaveLength(0);
    // 分叉在脚本读之前：这条路一份脚本都不需要。
    expect(getScriptCalls).toHaveLength(0);
    // run 本来就在追踪器里，不再登记第二个后台任务。
    expect(events.find((event) => event.type === SessionEventType.BackgroundTaskStarted)).toBe(
      undefined,
    );

    await settleQueue(events);
    const message = store.savedMessages.find((m) => m.source === "workflow_launch");
    const meta = message?.metadata?.workflowLaunch as Record<string, unknown> | undefined;
    expect(meta).toMatchObject({
      runId: PREVIOUS,
      name: "triage",
      amend: { maxConcurrency: { from: 8, to: 4 }, ceiling: 13 },
    });
    // 缺席即「就地生效」；这条路不编译，所以也没有 display。
    expect(meta?.amend).not.toHaveProperty("predecessorRunId");
    expect(meta).not.toHaveProperty("display");
    const part = store.savedParts.find(
      (candidate) => candidate.messageID === message?.id && candidate.type === "text",
    );
    const text = (part as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain(
      `Changed the settings of workflow run ${PREVIOUS} ("triage") from the GUI`,
    );
    expect(text).toContain("at most 4 of its subagents run at once");
    expect(text).toContain("keeps running under the new limit");
    expect(text).not.toContain("supersedes");
  });

  it("回到默认并发：等于默认的那一端缺席，文案说上限回到默认", async () => {
    const { runtime, retunes, store, events } = makeRuntime({
      name: "retune-default",
      snapshot: { maxConcurrency: 4 },
      retune: { ok: true, maxConcurrency: 13, previous: 4, defaultConcurrency: 13 },
    });

    const result = await runtime.amendWorkflowRunSettings({
      runId: PREVIOUS,
      maxConcurrency: null,
    });

    expect(result).toMatchObject({ ok: true, runId: PREVIOUS });
    // 弹层的 `null` 原样走到端口：默认并发那个数只有端口知道。
    expect(retunes).toEqual([{ runId: PREVIOUS, maxConcurrency: null }]);
    await settleQueue(events);
    const message = store.savedMessages.find((m) => m.source === "workflow_launch");
    const meta = message?.metadata?.workflowLaunch as { amend?: Record<string, unknown> };
    expect(meta.amend).toEqual({ maxConcurrency: { from: 4 }, ceiling: 13 });
    const part = store.savedParts.find(
      (candidate) => candidate.messageID === message?.id && candidate.type === "text",
    );
    expect((part as { text?: string } | undefined)?.text).toContain(
      "the limit on subagents at once is back to the default",
    );
  });

  it("调到默认并发之上：就地生效，两端都是数", async () => {
    const { runtime, retunes, store, events } = makeRuntime({
      name: "retune-raise",
      snapshot: {},
      retune: { ok: true, maxConcurrency: 40, previous: 13, defaultConcurrency: 13 },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 40 });

    expect(result).toMatchObject({ ok: true, runId: PREVIOUS });
    expect(retunes).toEqual([{ runId: PREVIOUS, maxConcurrency: 40 }]);
    await settleQueue(events);
    const message = store.savedMessages.find((m) => m.source === "workflow_launch");
    const meta = message?.metadata?.workflowLaunch as { amend?: Record<string, unknown> };
    expect(meta.amend).toEqual({ maxConcurrency: { to: 40 }, ceiling: 13 });
  });

  it("没有存档脚本的 run 照样能调并发（脚本读在分叉之后）", async () => {
    const { runtime, retunes, amends } = makeRuntime({
      name: "retune-no-script",
      script: null,
      snapshot: { maxConcurrency: 8 },
      retune: { ok: true, maxConcurrency: 4, previous: 8, defaultConcurrency: 13 },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(result).toMatchObject({ ok: true, runId: PREVIOUS });
    expect(retunes).toHaveLength(1);
    expect(amends).toHaveLength(0);
  });

  it("端口答 unchanged（值在分叉之后被挪过）→ 既有的 unchanged 拒绝", async () => {
    const { runtime, amends, store, events } = makeRuntime({
      name: "retune-unchanged",
      snapshot: { maxConcurrency: 8 },
      retune: { ok: false, reason: "unchanged", current: 4 },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(result).toMatchObject({ ok: false, reason: "unchanged" });
    expect(amends).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("端口答 not_live → 平平落回今天的修订", async () => {
    const { runtime, amends, retunes, getScriptCalls } = makeRuntime({
      name: "retune-not-live",
      snapshot: { maxConcurrency: 8 },
      retune: { ok: false, reason: "not_live" },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(retunes).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, runId: "dwfrun-next", supersededRunId: PREVIOUS });
    expect(getScriptCalls).toEqual([PREVIOUS]);
    expect(amends).toHaveLength(1);
    expect(amends[0]?.maxConcurrency).toBe(4);
  });

  it("同时换模型 → 仍是一次修订，端口的 retuneConcurrency 一次都不碰", async () => {
    const { runtime, amends, retunes } = makeRuntime({
      name: "retune-with-model",
      snapshot: { maxConcurrency: 8 },
      retune: { ok: true, maxConcurrency: 4, previous: 8, defaultConcurrency: 13 },
    });

    const result = await runtime.amendWorkflowRunSettings({
      runId: PREVIOUS,
      maxConcurrency: 4,
      subagentModel: "bigmodel/GLM-5.3-Flash",
    });

    expect(retunes).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, runId: "dwfrun-next" });
    expect(amends).toHaveLength(1);
  });

  it("端口没有 retuneConcurrency（老宿主）→ 照旧一次修订", async () => {
    const { runtime, amends } = makeRuntime({
      name: "retune-old-host",
      snapshot: { maxConcurrency: 8 },
    });

    const result = await runtime.amendWorkflowRunSettings({ runId: PREVIOUS, maxConcurrency: 4 });

    expect(result).toMatchObject({ ok: true, runId: "dwfrun-next" });
    expect(amends).toHaveLength(1);
  });
});

describe("buildSettingsMessageText", () => {
  it("只说改过的设置；两个 null 各有一句；已结算的前驱读作 takes over from", () => {
    const text = buildSettingsMessageText({
      name: "triage",
      previous: "dwfrun-a",
      runId: "dwfrun-b",
      superseded: false,
      amend: {
        predecessorRunId: "dwfrun-a",
        subagentModel: { from: "bigmodel/GLM-5.3" },
        maxConcurrency: { from: 4 },
      },
    });
    expect(text).toContain("its subagents are back on the session model");
    expect(text).toContain("the limit on subagents at once is back to the default");
    expect(text).toContain("which takes over from run dwfrun-a");
    expect(text).toContain("do not amend, resume or restart it");
  });

  // 缺席的 predecessorRunId 即「就地生效」：上面那句会让模型去找一个不存在的 run B。
  it("就地生效：只点名一个 run，说它继续在跑、没有新 run", () => {
    const text = buildSettingsMessageText({
      name: "triage",
      previous: "dwfrun-a",
      runId: "dwfrun-a",
      superseded: false,
      amend: { maxConcurrency: { from: 8, to: 2 }, ceiling: 13 },
    });
    expect(text).toContain('Changed the settings of workflow run dwfrun-a ("triage") from the GUI');
    expect(text).toContain("at most 2 of its subagents run at once");
    expect(text).toContain("Run dwfrun-a keeps running under the new limit");
    expect(text).toContain("nothing was stopped and no new run was started");
    expect(text).not.toContain("dwfrun-b");
    expect(text).not.toContain("takes over from");
    expect(text).toContain("do not amend, resume or restart it");
  });
});
