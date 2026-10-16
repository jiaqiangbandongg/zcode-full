import { createTestAgentRuntime } from "./helpers/test-agent-runtime.js";
/**
 * bootstrap 集成测试装配（确定性层，CI 安全）：真实脚本 → 真实 schema 合成 + validate + lowering
 * → 沙箱子进程 → 引擎核心 → **真实 AgentRuntime driver**（本任务实现），actor runtime 注入
 * **脚本化 model adapter**（core/tests 的 generateText 模式）。整条 phase-1.5 管线跑通，只把「真模型」
 * 换成可预测的脚本，用以验证 submit 桥接、三值→二值裁决映射、turn-stop、同 turn repair、nudge。
 */

import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import {
  SUBMIT_RESULT_TOOL_NAME,
  type ExecutionPort,
  type FileSystemPort,
  type SessionStorePort,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";
import {
  InMemoryJournalStore,
  buildAskSpecs,
  collectSites,
  createWorkflowProgram,
  deriveActorSubmitProfilesFor,
  refToString,
  synthesizeAskSchemas,
  validate,
  type ActorSubmitProfile,
  type AskSpec,
  type Caps,
  type JsonSchema,
  type RunEvent,
  type RunSettlement,
  type ValidateFn,
} from "@zcode/dynamic-workflow";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import {
  createWorkflowEscalationRegistry,
  type WorkflowEscalationRegistry,
} from "../src/app/workflow-escalation-registry.js";
import {
  createAgentRuntimeWorkflowDriver,
  type ActorRuntimeFactory,
} from "../src/app/workflow-driver.js";
import type { AgentRuntimeWorkflowDriverDeps } from "../src/app/workflow-driver-types.js";
import type { WorkflowConcurrencyPort } from "../src/app/workflow-concurrency-governor.js";

/**
 * 独立的 run cwd：harness 把入口文件写到 `<cwd>/.zcode/workflow-runs/<runId>.mjs` 且保留，
 * 用 process.cwd() 会把存档留在包目录里，并让并行测试文件互相覆写同名入口文件。
 */
const TEST_CWD: string = mkdtempSync(join(tmpdir(), "dwf-bootstrap-test-cwd-"));

/** 适配真实校验器到引擎的 ValidateFn 契约。 */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

/**
 * 由脚本文本合成 ask 规格：走包里的规范构造器 {@link buildAskSpecs}（按站点表遍历，
 * untyped 站点显式记 `{typed:false}`——引擎把站点缺席当接线错误硬失败）。
 *
 * 同时演示「编译一次」：一个 ts.Program 同时喂站点表与 schema 合成。
 */
function askSpecsFor(scriptText: string): Map<string, AskSpec> {
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  const { schemas } = synthesizeAskSchemas(workflow, table);
  return buildAskSpecs(table, schemas);
}

/**
 * 由脚本文本推导每个 actor 站点的 submit profile（照 run 提交路径的 compileOnce：同一 Program 上的
 * 站点表 + schema 合成 + 站点图）。docs/execution-engine.md「Typed asks and `submit_result`」。
 */
export function actorSubmitProfilesFor(scriptText: string): Map<string, ActorSubmitProfile> {
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  const { schemas } = synthesizeAskSchemas(workflow, table);
  return deriveActorSubmitProfilesFor(workflow, table, buildAskSpecs(table, schemas));
}

/** 脚本化模型的一步计划：提交一个 payload、只发一段最终文本（不提交）、或挂起（永不返回）。 */
export type PlannedResponse =
  | { kind: "submit"; result: unknown }
  | { kind: "text"; text: string }
  // 挂起：模拟一个在飞的 turn（取消/恢复用例靠它把 run 停在可预测的节点上）。
  | { kind: "hang" };

/** 记录某 actor runtime 实际发生的模型请求数（供断言 repair 是否真的在 turn 内重试）。 */
interface ModelCallLog {
  calls: number;
  /** 每次 generateText 请求实际带上的工具名列表（供断言 actor 的工具面减法真的落到了模型请求上）。 */
  toolNames: string[][];
  /** 每次 generateText 请求里最后一条 user 消息的文本（供断言 ask 尾注真的到了模型面）。 */
  prompts: string[];
  /**
   * 每次 generateText 请求里 submit_result 的声明（inputSchema + strict 资格），没有该工具时为
   * undefined（供断言 submit profile 真的落到了工具面）。
   */
  submitTools: ({ inputSchema: unknown; strict: boolean | undefined } | undefined)[];
}

/** 取请求里最后一条 user 消息的文本；content 为分块时拼接其中的 text 块。 */
function lastUserPrompt(request: unknown): string {
  const messages = (request as { messages?: unknown[] } | undefined)?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    }
    return "";
  }
  return "";
}

/**
 * 造一个脚本化 model adapter：按 responses 顺序逐次应答每个 generateText 请求。
 * submit → 发一个 submit_result 工具调用（input.result = payload）；text → 发一段最终文本 stop。
 * 队列耗尽后兜底发一段文本，避免无限循环。
 */
function scriptedModelAdapter(responses: PlannedResponse[], log: ModelCallLog): unknown {
  let index = 0;
  return {
    async generateText(request?: {
      tools?: readonly { name: string; inputSchema?: unknown; strict?: boolean }[];
    }) {
      log.calls++;
      log.toolNames.push((request?.tools ?? []).map((tool) => tool.name));
      log.prompts.push(lastUserPrompt(request));
      const submit = (request?.tools ?? []).find((tool) => tool.name === SUBMIT_RESULT_TOOL_NAME);
      log.submitTools.push(
        submit === undefined
          ? undefined
          : { inputSchema: submit.inputSchema, strict: submit.strict },
      );
      const planned = responses[index++] ?? { kind: "text", text: "(no further scripted response)" };
      if (planned.kind === "hang") return new Promise(() => {});
      const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };
      if (planned.kind === "submit") {
        return {
          finishReason: "tool-calls",
          model: "scripted",
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            { id: `submit-call-${index}`, name: SUBMIT_RESULT_TOOL_NAME, input: { result: planned.result } },
          ],
          usage,
        };
      }
      return {
        finishReason: "stop",
        model: "scripted",
        providerMetadata: undefined,
        text: planned.text,
        usage,
      };
    },
  };
}

/** 极简内存 fs 端口：仅实现 world-read 用到的 searchFiles / readTextFile，其余抛错（不该被触及）。 */
export function fakeFileSystemPort(files: {
  glob?: string[];
  read?: string;
}): FileSystemPort {
  const unsupported = (name: string) => () => {
    throw new Error(`fakeFileSystemPort.${name} 不应被 world-read 触及`);
  };
  return {
    async searchFiles(request: { path: string; pattern: string }) {
      const list = files.glob ?? [];
      return { path: request.path, pattern: request.pattern, durationMs: 0, files: list, numFiles: list.length, truncated: false };
    },
    async readTextFile(request: { path: string }) {
      return {
        path: request.path,
        content: files.read ?? "",
        encoding: "utf-8",
        bytesRead: (files.read ?? "").length,
        sizeBytes: (files.read ?? "").length,
        truncated: false,
      };
    },
    createDirectory: unsupported("createDirectory"),
    stat: unsupported("stat"),
    readBinaryFile: unsupported("readBinaryFile"),
    readTextFileRange: unsupported("readTextFileRange"),
    writeTextFile: unsupported("writeTextFile"),
    removeFile: unsupported("removeFile"),
    listDirectory: unsupported("listDirectory"),
    searchText: unsupported("searchText"),
  } as unknown as FileSystemPort;
}

interface RunDriverScriptOptions {
  /** 按 actor ref 串（如 "actor#1@1"）的模型计划序列；每个 actor 一个持久 runtime。 */
  actorScripts: Record<string, PlannedResponse[]>;
  caps?: Caps;
  timeoutMs?: number;
  journal?: InMemoryJournalStore;
  files?: { glob?: string[]; read?: string };
  runId?: string;
  /**
   * 覆盖内部的脚本化 runtime 工厂（live 层用它注入真实 model adapter 的 runtime）。
   * 提供时 actorScripts 被忽略，modelCalls 不再记录（由调用方自证）。
   */
  runtimeFactory?: ActorRuntimeFactory;
  /**
   * 真实会话存储。接上它，actor runtime 才真的把消息落库，driver 也才拿得到转录存取面——
   * amend-resume 的边界记账与转录截断两族用例的前提（缺省不接：其余用例不需要，也不该为它们
   * 付一次 sqlite 的代价）。默认工厂随之照生产的样子先把会话行落库（FK 要求）。
   */
  sessionStore?: SessionStorePort;
  /**
   * 升级问答的停驻表。传进来即可在用例里扮演 run service 的应答侧（`registry.resolve(...)`）；
   * 缺省新建一张，于是既有用例一字不改（没有 actor 会调 escalate）。
   */
  escalationRegistry?: WorkflowEscalationRegistry;
  /**
   * 默认工厂每造一个 actor runtime 就回调一次（键为 actor ref 串）。用例靠它拿到 runtime 的
   * 弱引用 / 关闭链 spy，而不必复制整个脚本化工厂；runtimeFactory 被覆盖时不回调。
   */
  onRuntimeCreated?: (runtime: AgentRuntime, actorKey: string) => void;
  /**
   * 每个 actor 站点的 submit profile（docs/execution-engine.md「Submit profiles」）。`"derive"` 照
   * 生产从脚本推导；给一张表则原样使用（守卫用例靠它喂一份**错误**的静态 profile）；缺省不传 =
   * 2026-09-13 之前的行为（每个 actor generic），既有用例因此一字不改。
   */
  actorSubmitProfiles?: "derive" | ReadonlyMap<string, ActorSubmitProfile>;
  /**
   * 进程级并发治理器的窄端口（故障矩阵用真 governor 让闸门生效；缺省不接，行为与既有用例同）。
   */
  concurrency?: WorkflowConcurrencyPort;
  /** driver 的时钟与定时器（故障矩阵把重驱曲线与 stall 窗缩到毫秒级）；缺省真时间。 */
  clock?: AgentRuntimeWorkflowDriverDeps["clock"];
}

interface RunDriverScriptResult {
  settlement: RunSettlement;
  journal: InMemoryJournalStore;
  events: RunEvent[];
  /** 各 actor runtime 的模型请求计数，键为 actor ref 串。 */
  modelCalls: Record<string, ModelCallLog>;
  /** 本次跑用的停驻表（调用方没传时是这里新建的那一张）。 */
  escalationRegistry: WorkflowEscalationRegistry;
}

const DEFAULT_CAPS: Caps = { maxConcurrency: 16 };

/**
 * 用真实管线跑一份脚本：真实 driver + 真实 AgentRuntime（脚本化模型）+ 内存 journal。
 * 返回结算、journal、Boundary C 事件、各 actor 的模型调用计数。
 */
/**
 * 世界读取用不到子进程的用例里的 ExecutionPort 占位：被触及即失败。
 *
 * deps 里 executionPort 是**必填**（见 workflow-driver.ts 的字段注释：可选会给出一条静默
 * 降级的运行路径），所以这里不能省；而一个会抛的占位比一个空实现好——它让"本用例其实跑了
 * 一次 git"变成一次显式失败，而不是一个被忽略的空结果。
 */
export function unsupportedExecutionPort(): ExecutionPort {
  return {
    run: () => {
      throw new Error("本用例不应触及 ExecutionPort（git.* world-read）");
    },
  };
}

export async function runDriverScript(
  scriptText: string,
  opts: RunDriverScriptOptions,
): Promise<RunDriverScriptResult> {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const events: RunEvent[] = [];
  const modelCalls: Record<string, ModelCallLog> = {};
  const fileSystemPort = fakeFileSystemPort(opts.files ?? {});
  const escalationRegistry = opts.escalationRegistry ?? createWorkflowEscalationRegistry();

  const makeDriver = createAgentRuntimeWorkflowDriver({
    journal,
    emit: (event) => events.push(event),
    executionPort: unsupportedExecutionPort(),
    escalationRegistry,
    fileSystemPort,
    cwd: process.cwd(),
    // driver 与 harness 必须看到同一个 runId：actor 会话 id 以它为作用域，
    // 只传给 harness 会让测试里的会话 id 永远落在兜底的 "run" 上。
    runId: opts.runId ?? "run",
    ...(opts.sessionStore === undefined ? {} : { actorTranscriptStore: opts.sessionStore }),
    ...(opts.actorSubmitProfiles === undefined
      ? {}
      : {
          actorSubmitProfiles:
            opts.actorSubmitProfiles === "derive"
              ? actorSubmitProfilesFor(scriptText)
              : opts.actorSubmitProfiles,
        }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
    runtimeFactory:
      opts.runtimeFactory ??
      (async ({ sessionId, actor, persona, submitPort, submitProfile }) => {
      const key = refToString(actor);
      const log: ModelCallLog = { calls: 0, toolNames: [], prompts: [], submitTools: [] };
      modelCalls[key] = log;
      const responses = opts.actorScripts[key] ?? [];
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          systemPrompt: persona.system ?? "You are a workflow actor.",
          mode: "yolo",
          taskType: "workflow_child",
          subagents: { enabled: false },
          // actor 的工具面：全集减去会悬挂/越权的交互工具。
          ...workflowActorToolPolicy(),
        },
        {
          eventStore: createInMemorySessionEventStore(),
          modelAdapter: scriptedModelAdapter(responses, log) as never,
          // 照生产工厂（create-app.ts）：untyped 不注入端口（无工具）；mono 注入端口 + typed 声明。
          ...(submitProfile.kind === "untyped" ? {} : { workflowSubmitPort: submitPort }),
          ...(submitProfile.kind === "mono" ? { workflowSubmitSchema: { ...submitProfile.schema } } : {}),
          fileSystemPort,
          ...(opts.sessionStore === undefined ? {} : { sessionStore: opts.sessionStore }),
        },
      );
      // 照生产（dynamic-workflow-run-launch.ts 的 persistActorSession）：会话行必须先落库，
      // `message.session_id` 对 `session(id)` 有 FK，否则第一条消息就写不进去。
      if (opts.sessionStore !== undefined) {
        await runtime.ensureSessionPersistedForExternalActivity(`workflow actor ${key}`);
      }
      opts.onRuntimeCreated?.(runtime, key);
      return runtime;
    }),
  });

  const settlement = await runWorkflowScript({
    scriptText,
    cwd: TEST_CWD,
    runId: opts.runId ?? "run",
    caps: opts.caps ?? DEFAULT_CAPS,
    askSpecs: askSpecsFor(scriptText),
    validate: validateFn,
    makeDriver,
    timeoutMs: opts.timeoutMs ?? 30000,
  });

  return { settlement, journal, events, modelCalls, escalationRegistry };
}
