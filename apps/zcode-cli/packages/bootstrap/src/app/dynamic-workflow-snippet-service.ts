// ============================================================
// Dynamic Workflow Snippet Service（DynamicWorkflowSnippetPort 的生产实现）
// ============================================================
// EvalWorkflowSnippet 的执行侧：对 scratch facade
// 编译一次 → 同一条 lowering / 沙箱 / world-read 执行面 → 内存 journal → 同步结算。
//
// 三条不变式：
//   1. **同一执行面**。编译走 createWorkflowProgram（scratch facade 以同一个
//      FACADE_FILE_NAME 注入——facade 身份按声明文件名判定，换名字会让站点收集静默变空）；
//      world read 走生产 executeWorldRead（真文件系统 / 真 git、生产 caps）。snippet 的
//      存在理由是保真，任何「差不多」的第二实现都是它要消灭的东西。
//   2. **完全瞬态**。InMemoryJournalStore、随机 runId、不落 dwf_* 行、不进后台任务追踪器。
//      进程退出即消失是契约而非缺陷。
//   3. **asks 在编译期被排除**。scratch facade 没有 agent()，所以 driver 的 ask 族方法
//      不可达；它们抛 DriverError 只是纵深防御——运行期到达即接线 bug，大声失败。

import { randomUUID } from "node:crypto";
import type {
  DynamicWorkflowSnippetEvalOptions,
  DynamicWorkflowSnippetEvalRequest,
  DynamicWorkflowSnippetEvalResult,
  DynamicWorkflowSnippetPort,
  ExecutionPort,
  FileSystemPort,
  Logger,
} from "@zcode/contracts";
import {
  buildAskSpecs,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  InMemoryJournalStore,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
  validate,
  WorkflowError,
  type Caps,
  type JsonSchema,
  type RunEvent,
  type ValidateFn,
  type WorkflowDriver,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { dynamicWorkflowChildSpawn } from "./dynamic-workflow-run-launch.js";
import { resolveWorkflowDefaultConcurrency } from "./workflow-default-concurrency.js";
import { executeWorldRead, type WorldReadDeps } from "./workflow-world-read.js";

/** logs 的界（契约常量在 @zcode/contracts 的 eval-workflow-snippet.ts；这里避免反向依赖工具层）。 */
const MAX_LOGS = 100;
const MAX_LOG_CHARS = 2_048;
/** 顶层返回值序列化上限。harness 不量 artifact 体积（RunSettlement 原样交出），这道界在这里。 */
const MAX_ARTIFACT_BYTES = 256 * 1024;

const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

interface DynamicWorkflowSnippetServiceDeps {
  /** files.glob / files.read / files.grep 落到的文件系统端口。 */
  fileSystemPort: FileSystemPort;
  /** git.* world-read 落到的子进程执行端口。 */
  executionPort: ExecutionPort;
  logger?: Logger;
  /** 注入并发度探测，供测试固定（地板必须是 1，双核机器上 parallelism-2 == 0）。 */
  availableParallelism?: () => number;
}

/** 造 snippet 服务。返回 {@link DynamicWorkflowSnippetPort} 的实现。 */
export function createDynamicWorkflowSnippetService(
  deps: DynamicWorkflowSnippetServiceDeps,
): DynamicWorkflowSnippetPort {
  const caps = (): Caps => {
    return {
      // 并发上界与 run service / 治理器同一份实现（决策 30）。snippet 没有 ask，不接治理器。
      maxConcurrency: resolveWorkflowDefaultConcurrency(deps.availableParallelism),
    };
  };

  return {
    async evalSnippet(
      request: DynamicWorkflowSnippetEvalRequest,
      options?: DynamicWorkflowSnippetEvalOptions,
    ): Promise<DynamicWorkflowSnippetEvalResult> {
      // 编译一次：一个 ts.Program 同时喂诊断、站点表与 lowering（run service 不变式 2 的
      // snippet 版）。诊断带 TS1184 / index-access 改写——自修回路的可读性与 CreateWorkflow 同源。
      const workflow = createWorkflowProgram(request.code, { facadeDts: SNIPPET_FACADE_DTS });
      const diagnostics = collectDiagnostics(workflow.program);
      if (diagnostics.length > 0) {
        return { kind: "diagnostics", diagnostics };
      }

      const table = collectSites(workflow);
      // world.run：snippet 是这些调用的工作台（提交前先对真命令跑通 gate 逻辑）。
      // 非字面量 cmd 与生产同一诊断（授权面在编译期闭合，driver 不另持名单）。
      const worldRun = collectWorldRunCommands(workflow, table);
      if (worldRun.diagnostics.length > 0) {
        return { kind: "diagnostics", diagnostics: worldRun.diagnostics };
      }
      const lowered = lowerWorkflow(workflow, table);
      // scratch facade 没有 agent()，站点表里不可能有 ask 站点；空 schema 记录让
      // buildAskSpecs 交出空 askSpecs（引擎对缺席 spec 硬失败的保护对 snippet 自然为真）。
      const askSpecs = buildAskSpecs(table, {});

      const logs: string[] = [];
      let logsTruncated = false;
      const captureLog = (event: RunEvent): void => {
        if (event.type !== "log") return;
        if (logs.length >= MAX_LOGS) {
          logsTruncated = true;
          return;
        }
        const message = event.message;
        if (message.length > MAX_LOG_CHARS) {
          logs.push(message.slice(0, MAX_LOG_CHARS));
          logsTruncated = true;
          return;
        }
        logs.push(message);
      };

      const worldReadDeps: WorldReadDeps = {
        fileSystemPort: deps.fileSystemPort,
        executionPort: deps.executionPort,
        cwd: request.cwd,
      };
      const runId = `dwfeval-${randomUUID()}`;
      const childSpawn = dynamicWorkflowChildSpawn();

      const settlement = await runWorkflowScript({
        askSpecs,
        caps: caps(),
        ...(childSpawn === undefined ? {} : { childSpawn }),
        cwd: request.cwd,
        lowered: lowered.code,
        makeDriver: () => createSnippetDriver(worldReadDeps, captureLog),
        // 与 run-launch 同款：入口文件回落到 OS 临时目录时留一条 warn。
        onWarning: (warning) => {
          deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
            event: "dynamic_workflow.entry_file.fallback",
            module: "bootstrap.app",
            runId,
            ...warning,
          });
        },
        runId,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: request.timeoutMs,
        validate: validateFn,
      });

      deps.logger?.debug?.("Dynamic workflow snippet settled", {
        event: "dynamic_workflow.snippet.settled",
        module: "bootstrap.app",
        runId,
        // 日志上下文的 `status` 键是通用任务词汇，run 的三终态另起一键。
        runStatus: settlement.status,
        traceId: request.trace.traceId,
      });

      if (settlement.status === "completed") {
        const oversize = artifactOversize(settlement.artifact);
        if (oversize !== undefined) {
          return {
            kind: "failed",
            error: {
              code: "ArtifactTooLarge",
              message:
                `The snippet's return value serializes to ${oversize} bytes, over the cap of ` +
                `${MAX_ARTIFACT_BYTES} bytes. Return a summary (a count, the first few items) and ` +
                `leave the full data to log() or to the real run.`,
            },
            logs,
            logsTruncated,
          };
        }
        return {
          kind: "completed",
          ...(settlement.artifact === undefined ? {} : { artifact: settlement.artifact }),
          logs,
          logsTruncated,
        };
      }

      if (settlement.status === "errored") {
        return {
          kind: "failed",
          error: { code: settlement.error.code, message: settlement.error.message },
          logs,
          logsTruncated,
        };
      }

      // stopped：工具调用被取消（abort 信号）或沙箱故障。对调用方归一成结构化失败——snippet
      // 没有 resume 语义，「被停下的实验」与「失败的实验」的下一步动作相同（改了再跑一次）。
      // 带失败的停下（沙箱崩溃 / 超时）透出它的 code，否则给 Cancelled。
      return {
        kind: "failed",
        error:
          settlement.error === undefined
            ? { code: "Cancelled", message: "snippet evaluation was cancelled" }
            : { code: settlement.error.code, message: settlement.error.message },
        logs,
        logsTruncated,
      };
    },
  };
}

/** 返回值序列化超限时给出字节数，否则 undefined。值已过 NDJSON 边界，必然 JSON-safe。 */
function artifactOversize(artifact: unknown): number | undefined {
  if (artifact === undefined) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(artifact), "utf8");
  return bytes > MAX_ARTIFACT_BYTES ? bytes : undefined;
}

/**
 * snippet 的无会话 driver：world read 走生产执行面，journal 是内存实现，ask 族不可达
 * （scratch facade 无 agent()）——到达即接线 bug，抛结构化 DriverError 大声失败。
 */
function createSnippetDriver(
  worldReadDeps: WorldReadDeps,
  onEvent: (event: RunEvent) => void,
): WorkflowDriver {
  const askUnreachable = (member: string): WorkflowError =>
    new WorkflowError(
      "DriverError",
      `Snippet driver received ${member}, but the scratch facade has no agent(), so the ask ` +
        `path must be unreachable. This is a wiring bug.`,
    );
  return {
    createActorSession: () => Promise.reject(askUnreachable("createActorSession")),
    startAsk: () => {
      throw askUnreachable("startAsk");
    },
    respondToSubmit: () => {
      throw askUnreachable("respondToSubmit");
    },
    cancelAsk: () => {
      // 取消收尾路径上的幂等清扫（引擎对在飞 ask 广播取消）；snippet 没有在飞 ask，无事可做。
    },
    executeWorldRead: (op, args) => executeWorldRead(worldReadDeps, op, args),
    journal: new InMemoryJournalStore(),
    emit: onEvent,
  };
}
