/* eslint-disable max-lines -- subagent runner 集中维护前台/后台生命周期、registry 与 notification 顺序，拆分前需要先稳定生命周期边界。 */
// ============================================================
// Subagent Runner
// ============================================================

import type { GetAgentDefinitions } from "./definitions.js";
import {
  AgentErrorCode,
  CoreErrorType,
  DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  createSessionEvent,
  createSessionId,
  createTraceId,
  getModelUsageTotalTokens,
  hasModelUsage,
  isCoreError,
  traceContextToLogContext,
  type AgentBackgroundedOutput,
  type BackgroundResultOriginMeta,
  type AgentCompletedOutput,
  type AgentOutput,
  type Logger,
  type ModelUsage,
  type SessionEvent,
  type SessionId,
  type SubagentLaunchOptions,
  type SubagentLaunchRequest,
  type SubagentPort,
  type SubagentRunOptions,
  type SubagentRunRequest,
  type SubagentSendMessageOptions,
  type SubagentSendMessageRequest,
  type SubagentSendMessageResult,
  type SubagentStartOptions,
  type SubagentStartRequest,
  type SubagentStopOptions,
  type SubagentTaskSnapshot,
  type SubagentWaitOptions,
  type TraceContext,
} from "@zcode/contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isBuiltInExploreAgentProfile,
  normalizeAgentProfiles,
  type AgentProfile,
} from "./profile.js";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "./explore-tools.js";
import { formatLocalAgentTaskNotification } from "./completion-notification.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import {
  ErrorPayloadRole,
  selectExecutionErrorMessage,
  withErrorPayloadRole,
} from "../errors/error-payload.js";
import {
  InMemoryRuntimeTaskRegistry,
  isTerminalRuntimeTask,
  type RuntimeTaskMessageSink,
  type RuntimeTaskPendingMessage,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";

export interface ExploreSubagentRuntimeRequest {
  agentId: string;
  agentType: string;
  allowedTools: readonly string[];
  /** 每次读取都返回 runtime task registry 的当前 foreground/background 状态。 */
  background: boolean;
  disallowedTools?: readonly string[];
  sessionId: SessionId;
  description: string;
  maxTurns?: number;
  /** child session 已持久化且可被 projection/query 读取后、首次模型执行前调用。 */
  onSessionReady?: () => Promise<void>;
  permissionMode?: AgentProfile["permissionMode"];
  prompt: string;
  profile: AgentProfile;
  registerMessageSink?: (sink: RuntimeTaskMessageSink) => void;
  reportActivity?: () => void;
  resumeFromStore?: boolean;
  systemPrompt?: string;
  workingDirectory: string;
  workspaceRoot: string;
  traceContext: TraceContext;
}

export interface ExploreSubagentRuntimeResult {
  response: string;
  traceId: TraceContext["traceId"];
  events: SessionEvent[];
}

export interface ParentTaskNotificationCommand {
  originMeta: BackgroundResultOriginMeta;
  text: string;
  traceContext: TraceContext;
  taskId: string;
}

export type EnqueueParentTaskNotification = (
  notification: ParentTaskNotificationCommand,
) => undefined;

export interface ExploreSubagentPortOptions {
  runExploreAgent: (
    request: ExploreSubagentRuntimeRequest,
    options?: SubagentRunOptions,
  ) => Promise<ExploreSubagentRuntimeResult>;
  emitParentEvent: (event: SessionEvent, traceContext: TraceContext) => Promise<void>;
  // background completion 必须同步写入父 runtime command queue；
  // 返回 undefined 可让 TypeScript 拒绝 async enqueue，避免 fake-notified。
  enqueueParentTaskNotification?: EnqueueParentTaskNotification;
  outputRootDir?: string;
  profiles?: readonly AgentProfile[];
  getAgentDefinitions?: GetAgentDefinitions;
  builtInModelSelectionOverrides?: Partial<
    Record<"general-purpose" | "Explore", import("@zcode/shared").ModelSelection>
  >;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  createAgentId?: () => string;
  getAllowedTools?: (profile: AgentProfile) => readonly string[];
  inactivityTimeoutMs?: number;
  autoBackgroundMs?: number;
  logger?: Logger;
}

export function createExploreSubagentPort(options: ExploreSubagentPortOptions): SubagentPort {
  const registry = options.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
  const abortControllers = new Map<string, AbortController>();
  const borrowedForegroundAgentIds = new Set<string>();
  const initialProfiles = normalizeAgentProfiles(options.profiles ?? [], {
    builtInModelSelectionOverrides: options.builtInModelSelectionOverrides,
  });
  const getProfiles = () => options.getAgentDefinitions?.().activeAgents ?? initialProfiles;
  const autoBackgroundMs = normalizeAutoBackgroundMs(options.autoBackgroundMs);

  const port: SubagentPort & { start: NonNullable<SubagentPort["start"]> } = {
    async launch(
      rawRequest: SubagentLaunchRequest,
      launchOptions?: SubagentLaunchOptions,
    ): Promise<AgentOutput> {
      const { profile, request } = resolveAgentProfileForRequest(getProfiles(), rawRequest);
      const executionRequest = toSubagentExecutionRequest(request);
      const backgroundRequested =
        rawRequest.runInBackground === true || profile.background === true;
      if (backgroundRequested) {
        if (launchOptions?.modelOverride?.background === "deny") {
          // 单次执行的模型与动态鉴权不能脱离父 loop 生命周期进入后台。
          throw createCoreError(
            CoreErrorType.ToolExecutionFailed,
            "Idle-time tasks do not support background agents. Run this agent in the foreground.",
            {
              context: {
                code: AgentErrorCode.BACKGROUND_UNAVAILABLE,
                agentType: rawRequest.agentType,
                parentToolCallId: rawRequest.parentToolCallId,
              },
              recoverable: true,
            },
          );
        }
        return port.start(executionRequest, {
          signal: launchOptions?.signal,
          ...(launchOptions?.model ? { model: launchOptions.model } : {}),
        });
      }
      return port.run(executionRequest, launchOptions);
    },

    async run(
      rawRequest: SubagentRunRequest,
      runOptions?: SubagentRunOptions,
    ): Promise<AgentOutput> {
      const { profile, request } = resolveAgentProfileForRequest(getProfiles(), rawRequest);
      const lifecycle = createSubagentLifecycle(options, request, profile);
      const startedAt = new Date(lifecycle.startedAt);

      registry.register(
        createRuntimeTaskSnapshot({
          isBackgrounded: false,
          lifecycle,
          request,
          startedAt,
          status: "running",
        }),
      );
      try {
        await writeAgentMetadataFile(lifecycle, request, "running");
      } catch (error) {
        // 启动元数据写入失败时，child runtime 还没有开始执行；
        // 保留 running task 会让父 runtime 误以为仍有后台任务并持续 defer。
        registry.remove(lifecycle.agentId);
        throw error;
      }

      const taskAbort = createSubagentTaskAbortController(
        abortControllers,
        lifecycle.agentId,
        runOptions?.signal,
      );
      const hasForegroundModelOverride = runOptions?.modelOverride !== undefined;
      if (hasForegroundModelOverride) {
        borrowedForegroundAgentIds.add(lifecycle.agentId);
      }
      const activityWatchdog = createSubagentActivityWatchdog({
        abort: taskAbort.abort,
        lifecycle,
        logger: options.logger,
        request,
        signal: taskAbort.signal,
        timeoutMs: options.inactivityTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
      });
      const readyGate = createSubagentSessionReadyGate();
      // child persistence/resume 可能在 onSessionReady 前永久挂起；watchdog 和
      // abort guard 必须覆盖完整 setup，而不能把 Ready 当成取消能力的安装边界。
      activityWatchdog.start();
      const completionPromise = runAgentToCompletion(
        options,
        request,
        lifecycle,
        registry,
        {
          signal: taskAbort.signal,
          ...(runOptions?.model ? { model: runOptions.model } : {}),
          ...(runOptions?.modelOverride ? { modelOverride: runOptions.modelOverride } : {}),
        },
        {
          reportActivity: activityWatchdog.reportActivity,
        },
        {
          onSessionReady: async () => {
            await emitSubagentEvent(
              options,
              SessionEventType.SubagentSpawned,
              request,
              lifecycle.runTraceContext,
              {
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                childSessionId: lifecycle.childSessionId,
                description: request.description,
                prompt: request.prompt,
                parentToolCallId: request.parentToolCallId,
                status: "running",
                allowedTools: [...resolveAllowedTools(profile, options)],
                model: profile.modelSelection
                  ? `${profile.modelSelection.providerId}/${profile.modelSelection.modelId}`
                  : undefined,
              },
            );
            readyGate.resolve();
          },
        },
      );
      void completionPromise.catch((error: unknown) => readyGate.reject(error));
      try {
        await guardSubagentPromiseWithAbort(
          readyGate.promise,
          request,
          lifecycle,
          taskAbort.signal,
        );
      } catch (error) {
        activityWatchdog.stop();
        taskAbort.abort(error);
        taskAbort.dispose();
        borrowedForegroundAgentIds.delete(lifecycle.agentId);
        registry.remove(lifecycle.agentId);
        throw error;
      }

      options.logger?.info("Explore subagent spawned", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        event: "subagent.spawned",
        module: "core.subagent",
        parentToolCallId: request.parentToolCallId,
        status: "started",
      });
      const guardedCompletionPromise = guardSubagentPromiseWithAbort(
        completionPromise,
        request,
        lifecycle,
        taskAbort.signal,
      );

      let autoBackgroundTimer: AutoBackgroundTimer | undefined;
      try {
        autoBackgroundTimer =
          !hasForegroundModelOverride && autoBackgroundMs !== undefined
            ? createAutoBackgroundTimer(
                registry,
                lifecycle.agentId,
                autoBackgroundMs,
                taskAbort.signal,
              )
            : undefined;
        const backgroundRequestPromise = !hasForegroundModelOverride
          ? registry
              .waitForBackgroundRequest(lifecycle.agentId, { signal: taskAbort.signal })
              .then((task) => ({
                kind: task ? ("backgrounded" as const) : ("ignored" as const),
              }))
          : undefined;
        const winner = await Promise.race([
          guardedCompletionPromise.then((completed) => ({
            completed,
            kind: "completed" as const,
          })),
          ...(backgroundRequestPromise ? [backgroundRequestPromise] : []),
          ...(autoBackgroundTimer ? [autoBackgroundTimer.promise] : []),
        ]);

        if (winner.kind === "backgrounded") {
          taskAbort.detachParent();
          activityWatchdog.stop();
          void completionPromise
            .then((completed) =>
              finalizeBackgroundCompletion(options, request, lifecycle, registry, completed),
            )
            .catch((error) =>
              finalizeBackgroundFailure(options, request, lifecycle, registry, error),
            )
            .finally(taskAbort.dispose);
          return createAgentBackgroundedOutput(request, lifecycle);
        }

        const completed =
          winner.kind === "completed" ? winner.completed : await guardedCompletionPromise;
        autoBackgroundTimer?.cancel();
        activityWatchdog.stop();
        taskAbort.dispose();
        borrowedForegroundAgentIds.delete(lifecycle.agentId);

        await writeCompletedAgentArtifacts(lifecycle, request, completed.output);
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: "completed",
          completedAt: new Date(),
          output: completed.output,
          usage: {
            durationMs: completed.output.totalDurationMs,
            modelUsage: completed.output.usage,
            toolUseCount: completed.output.totalToolUseCount,
            totalTokens: completed.output.totalTokens,
          },
        }));

        await emitSubagentEvent(
          options,
          SessionEventType.SubagentStopped,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            parentToolCallId: request.parentToolCallId,
            status: "completed",
            totalDurationMs: completed.output.totalDurationMs,
            totalToolUseCount: completed.output.totalToolUseCount,
            totalTokens: completed.output.totalTokens,
          },
        );

        options.logger?.info("Explore subagent completed", {
          ...traceContextToLogContext(lifecycle.runTraceContext),
          agentId: lifecycle.agentId,
          durationMs: completed.output.totalDurationMs,
          event: "subagent.completed",
          module: "core.subagent",
          status: "completed",
          totalToolUseCount: completed.output.totalToolUseCount,
          totalTokens: completed.output.totalTokens,
        });

        return completed.output;
      } catch (error) {
        activityWatchdog.stop();
        taskAbort.dispose();
        borrowedForegroundAgentIds.delete(lifecycle.agentId);
        const totalDurationMs = Date.now() - lifecycle.startedAt;
        const errorMessage = error instanceof Error ? error.message : String(error);
        await writeFailedAgentArtifacts(lifecycle, request, errorMessage);
        registry.update(lifecycle.agentId, (task) => ({
          ...withoutRuntimeMessageState(task),
          status: "failed",
          completedAt: new Date(),
          error: errorMessage,
          usage: {
            durationMs: totalDurationMs,
          },
        }));
        await emitSubagentEvent(
          options,
          SessionEventType.SubagentStopped,
          request,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: request.agentType,
            childSessionId: lifecycle.childSessionId,
            parentToolCallId: request.parentToolCallId,
            status: "failed",
            totalDurationMs,
            error: errorMessage,
          },
        );

        if (isCoreError(error)) {
          throw error;
        }

        throw createCoreError(CoreErrorType.ToolExecutionFailed, "Explore subagent failed", {
          cause: error instanceof Error ? error : undefined,
          // 这层只描述父 Agent toolcall 的生命周期失败；真实 provider/model
          // 错误在 cause 链里，应作为 UI hover 与父模型 tool result 的主摘要。
          context: withErrorPayloadRole(
            {
              code: AgentErrorCode.CHILD_RUNTIME_FAILED,
              agentId: lifecycle.agentId,
              agentType: request.agentType,
              parentToolCallId: request.parentToolCallId,
            },
            ErrorPayloadRole.Wrapper,
          ),
          recoverable: true,
        });
      } finally {
        activityWatchdog.stop();
        autoBackgroundTimer?.cancel();
      }
    },

    async start(
      rawRequest: SubagentStartRequest,
      startOptions?: SubagentStartOptions,
    ): Promise<AgentBackgroundedOutput> {
      const { profile, request } = resolveAgentProfileForRequest(getProfiles(), rawRequest);
      const lifecycle = createSubagentLifecycle(options, request, profile);
      const startedAt = new Date(lifecycle.startedAt);
      const output = createAgentBackgroundedOutput(request, lifecycle);

      registry.register(
        createRuntimeTaskSnapshot({
          isBackgrounded: true,
          lifecycle,
          request,
          startedAt,
          status: "running",
        }),
      );
      try {
        await writeAgentMetadataFile(lifecycle, request, "running");
      } catch (error) {
        // setup 失败时移除 registry 记录，避免 fake running background task。
        registry.remove(lifecycle.agentId);
        throw error;
      }

      const taskAbort = createSubagentTaskAbortController(abortControllers, lifecycle.agentId);
      if (startOptions?.signal?.aborted) {
        taskAbort.abort(startOptions.signal.reason);
      }
      const readyGate = createSubagentSessionReadyGate();
      void runBackgroundAgent(
        options,
        request,
        lifecycle,
        registry,
        {
          signal: taskAbort.signal,
          ...(startOptions?.model ? { model: startOptions.model } : {}),
        },
        {
          onSessionReady: async () => {
            await emitSubagentEvent(
              options,
              SessionEventType.SubagentSpawned,
              request,
              lifecycle.runTraceContext,
              {
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                background: true,
                childSessionId: lifecycle.childSessionId,
                description: request.description,
                prompt: request.prompt,
                parentToolCallId: request.parentToolCallId,
                status: "running",
                allowedTools: [...resolveAllowedTools(profile, options)],
                outputFile: lifecycle.outputFile,
                model: profile.modelSelection
                  ? `${profile.modelSelection.providerId}/${profile.modelSelection.modelId}`
                  : undefined,
              },
            );
            readyGate.resolve();
          },
          onSessionStartFailed: readyGate.reject,
        },
        taskAbort.dispose,
      );
      try {
        await readyGate.promise;
      } catch (error) {
        taskAbort.abort(error);
        registry.remove(lifecycle.agentId);
        throw error;
      }

      options.logger?.info("Explore subagent background task started", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        agentType: request.agentType,
        event: "subagent.background.started",
        module: "core.subagent",
        parentToolCallId: request.parentToolCallId,
        status: "started",
      });
      return output;
    },

    async getTask(taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      return registry.get(taskId);
    },

    async backgroundTask(taskId: string): Promise<SubagentTaskSnapshot | undefined> {
      if (borrowedForegroundAgentIds.has(taskId)) {
        return registry.get(taskId);
      }
      registry.requestBackground(taskId);
      return registry.get(taskId);
    },

    async waitForTask(
      taskId: string,
      waitOptions?: SubagentWaitOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      return registry.waitForTerminal(taskId, { signal: waitOptions?.signal });
    },

    async stopTask(
      taskId: string,
      stopOptions?: SubagentStopOptions,
    ): Promise<SubagentTaskSnapshot | undefined> {
      if (stopOptions?.signal?.aborted) {
        throw stopOptions.signal.reason ?? new Error("Subagent stop aborted");
      }
      const task = registry.get(taskId);
      if (!task || task.type !== "local_agent") return task;
      if (isTerminalRuntimeTask(task)) return task;

      const stopped = createBackgroundStoppedTask(registry, task);
      if (!stopped) return undefined;
      return finalizeBackgroundStopped(options, registry, stopped, () => {
        abortControllers
          .get(taskId)
          ?.abort(new Error(`${BACKGROUND_AGENT_STOPPED_STATE.message}: ${taskId}`));
        abortControllers.delete(taskId);
      });
    },

    async sendMessage(
      request: SubagentSendMessageRequest,
      sendOptions?: SubagentSendMessageOptions,
    ): Promise<SubagentSendMessageResult> {
      return sendMessageToLocalAgent(
        options,
        getProfiles,
        registry,
        abortControllers,
        request,
        sendOptions,
      );
    },
  };

  return port;
}

interface SubagentLifecycle {
  agentId: string;
  childSessionId: SessionId;
  metadataFile: string;
  outputFile: string;
  taskOutputFile: string;
  profile: AgentProfile;
  startedAt: number;
  runTraceContext: TraceContext;
  childTraceContext: TraceContext;
}

type AgentProfileResolution =
  | { kind: "matched"; profile: AgentProfile }
  | { availableAgentTypes: readonly string[]; kind: "not_found" }
  | {
      availableAgentTypes: readonly string[];
      kind: "ambiguous";
      matches: readonly string[];
    };

interface AutoBackgroundTimer {
  cancel(): void;
  promise: Promise<{ kind: "backgrounded" | "ignored" }>;
}

interface SubagentTaskAbortHandle {
  abort(reason?: unknown): void;
  detachParent(): void;
  dispose(): void;
  signal: AbortSignal;
}

function createSubagentTaskAbortController(
  abortControllers: Map<string, AbortController>,
  agentId: string,
  parentSignal?: AbortSignal,
): SubagentTaskAbortHandle {
  const controller = new AbortController();
  abortControllers.set(agentId, controller);
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason ?? new Error(`Subagent task aborted: ${agentId}`));
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const detachParent = (): void => {
    parentSignal?.removeEventListener("abort", onParentAbort);
  };
  const dispose = (): void => {
    detachParent();
    if (abortControllers.get(agentId) === controller) {
      abortControllers.delete(agentId);
    }
  };

  return {
    abort: (reason?: unknown) => controller.abort(reason),
    detachParent,
    dispose,
    signal: controller.signal,
  };
}

function normalizeAutoBackgroundMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function createAutoBackgroundTimer(
  registry: RuntimeTaskRegistry,
  agentId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): AutoBackgroundTimer {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise!: (value: { kind: "backgrounded" | "ignored" }) => void;

  const complete = (value: { kind: "backgrounded" | "ignored" }): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolvePromise(value);
  };
  const onAbort = (): void => {
    complete({ kind: "ignored" });
  };
  const promise = new Promise<{ kind: "backgrounded" | "ignored" }>((resolve) => {
    resolvePromise = resolve;
    if (signal?.aborted) {
      complete({ kind: "ignored" });
      return;
    }

    timer = setTimeout(() => {
      complete({
        kind: registry.requestBackground(agentId) ? "backgrounded" : "ignored",
      });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  return {
    cancel: () => complete({ kind: "ignored" }),
    promise,
  };
}

function resolveAgentProfileForRequest(
  profiles: readonly AgentProfile[],
  request: SubagentRunRequest,
): { profile: AgentProfile; request: SubagentRunRequest } {
  const resolution = resolveAgentProfileByType(profiles, request.agentType);
  if (resolution.kind === "matched") {
    const { profile } = resolution;
    return {
      profile,
      request:
        profile.name === request.agentType
          ? request
          : {
              ...request,
              // 模型可能按大小写/分隔符近似写 subagent_type；后续
              // toolset、事件和 metadata 都依赖 canonical agentType，必须在入口统一收敛。
              agentType: profile.name,
            },
    };
  }

  if (resolution.kind === "ambiguous") {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      [
        `Agent type '${request.agentType}' is ambiguous`,
        `matches ${resolution.matches.join(", ")}`,
        `Use the exact name: ${resolution.matches.join(" or ")}`,
      ].join(" — "),
      {
        context: {
          code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
          agentType: request.agentType,
          matches: resolution.matches,
          parentToolCallId: request.parentToolCallId,
        },
        recoverable: true,
      },
    );
  }

  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Agent type '${request.agentType}' not found. Available agents: ${resolution.availableAgentTypes.join(", ")}`,
    {
      context: {
        code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
        agentType: request.agentType,
        availableAgentTypes: resolution.availableAgentTypes,
        parentToolCallId: request.parentToolCallId,
      },
      recoverable: true,
    },
  );
}

function resolveAgentProfileByType(
  profiles: readonly AgentProfile[],
  requestedAgentType: string,
): AgentProfileResolution {
  const exact = profiles.find((candidate) => candidate.name === requestedAgentType);
  if (exact) return { kind: "matched", profile: exact };

  const availableAgentTypes = profiles.map((profile) => profile.name);

  const requestedNormalized = normalizeAgentTypeForMatch(requestedAgentType);
  if (!requestedNormalized) return { availableAgentTypes, kind: "not_found" };

  const normalizedMatches = profiles.filter(
    (candidate) => normalizeAgentTypeForMatch(candidate.name) === requestedNormalized,
  );
  if (normalizedMatches.length === 1) {
    return { kind: "matched", profile: normalizedMatches[0] };
  }
  if (normalizedMatches.length > 1) {
    return {
      availableAgentTypes,
      kind: "ambiguous",
      matches: normalizedMatches.map((profile) => profile.name),
    };
  }

  return { availableAgentTypes, kind: "not_found" };
}

function normalizeAgentTypeForMatch(agentType: string): string | undefined {
  const normalized = agentType
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
  return normalized.length > 0 ? normalized : undefined;
}

function toSubagentExecutionRequest(request: SubagentLaunchRequest): SubagentRunRequest {
  const { runInBackground: _runInBackground, ...executionRequest } = request;
  return executionRequest;
}

function createSubagentLifecycle(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  profile: AgentProfile,
): SubagentLifecycle {
  const agentId = options.createAgentId?.() ?? `agent_${crypto.randomUUID()}`;
  const childSessionId = createSessionId(`subagent_${agentId}`);
  const startedAt = Date.now();
  const agentOutputDir = join(
    options.outputRootDir ?? join(tmpdir(), "zcode-agents"),
    request.sessionId,
    agentId,
  );
  const metadataFile = join(agentOutputDir, "metadata.json");
  const outputFile = join(agentOutputDir, "output.txt");
  const taskOutputFile = join(agentOutputDir, "task.output");
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentToolCallId: request.parentToolCallId,
    },
  });
  const childTraceContext = createChildTraceContext(runTraceContext, {
    sessionId: childSessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentSessionId: request.sessionId,
      parentToolCallId: request.parentToolCallId,
    },
  });

  return {
    agentId,
    childSessionId,
    metadataFile,
    outputFile,
    taskOutputFile,
    profile,
    startedAt,
    runTraceContext,
    childTraceContext,
  };
}

function createSubagentLifecycleFromTask(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  profile: AgentProfile,
  task: RuntimeTaskSnapshot,
): SubagentLifecycle | undefined {
  if (!task.childSessionId) return undefined;
  const agentId = task.agentId;
  const childSessionId = task.childSessionId;
  const startedAt = Date.now();
  const agentOutputDir = task.outputFile
    ? dirname(task.outputFile)
    : join(options.outputRootDir ?? join(tmpdir(), "zcode-agents"), request.sessionId, agentId);
  const metadataFile = join(agentOutputDir, "metadata.json");
  const outputFile = join(agentOutputDir, "output.txt");
  const taskOutputFile = join(agentOutputDir, "task.output");
  const runTraceContext = createChildTraceContext(request.trace, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentToolCallId: request.parentToolCallId,
      resumed: true,
    },
  });
  const childTraceContext = createChildTraceContext(runTraceContext, {
    sessionId: childSessionId,
    turnId: request.turnId,
    attributes: {
      agentId,
      agentType: request.agentType,
      parentSessionId: request.sessionId,
      parentToolCallId: request.parentToolCallId,
      resumed: true,
    },
  });

  return {
    agentId,
    childSessionId,
    metadataFile,
    outputFile,
    taskOutputFile,
    profile,
    startedAt,
    runTraceContext,
    childTraceContext,
  };
}

async function sendMessageToLocalAgent(
  options: ExploreSubagentPortOptions,
  getProfiles: () => readonly AgentProfile[],
  registry: RuntimeTaskRegistry,
  abortControllers: Map<string, AbortController>,
  request: SubagentSendMessageRequest,
  sendOptions?: SubagentSendMessageOptions,
): Promise<SubagentSendMessageResult> {
  if (sendOptions?.signal?.aborted) {
    return createSendMessageFailure(request, `SendMessage was aborted for ${request.to}.`);
  }

  const task = registry.get(request.to);
  if (!task || task.type !== "local_agent") {
    return createSendMessageFailure(
      request,
      `No active local_agent task found for target ${request.to}.`,
    );
  }

  const message = createRuntimeTaskPendingMessage(request);
  if (!isTerminalRuntimeTask(task)) {
    return deliverMessageToRunningAgent(registry, task, message);
  }

  return resumeTerminalAgentInBackground(
    options,
    getProfiles(),
    registry,
    abortControllers,
    task,
    request,
    message,
  );
}

async function deliverMessageToRunningAgent(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  message: RuntimeTaskPendingMessage,
): Promise<SubagentSendMessageResult> {
  if (task.messageSink) {
    try {
      const delivery = await task.messageSink.send(message);
      return createSendMessageSuccess(task, message, delivery);
    } catch {
      registry.queueMessage(task.taskId, message);
      return createSendMessageSuccess(task, message, "queued");
    }
  }

  registry.queueMessage(task.taskId, message);
  return createSendMessageSuccess(task, message, "queued");
}

async function resumeTerminalAgentInBackground(
  options: ExploreSubagentPortOptions,
  profiles: readonly AgentProfile[],
  registry: RuntimeTaskRegistry,
  abortControllers: Map<string, AbortController>,
  task: RuntimeTaskSnapshot,
  request: SubagentSendMessageRequest,
  message: RuntimeTaskPendingMessage,
): Promise<SubagentSendMessageResult> {
  const profile = profiles.find((candidate) => candidate.name === task.agentType);
  if (!profile) {
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: profile ${task.agentType} is unavailable.`,
    );
  }

  const resumeRequest: SubagentRunRequest = {
    sessionId: request.sessionId,
    turnId: request.turnId,
    parentToolCallId: request.parentToolCallId,
    agentType: task.agentType,
    description: request.summary || task.description,
    prompt: request.message,
    workingDirectory: request.workingDirectory,
    workspaceRoot: request.workspaceRoot,
    trace: request.trace,
  };
  const lifecycle = createSubagentLifecycleFromTask(options, resumeRequest, profile, task);
  if (!lifecycle) {
    return createSendMessageFailure(
      request,
      `Cannot resume local agent ${task.agentId}: missing child session id.`,
    );
  }
  const startedAt = new Date(lifecycle.startedAt);
  const previousTask = task;
  registry.register(
    createRuntimeTaskSnapshot({
      isBackgrounded: true,
      lifecycle,
      request: resumeRequest,
      startedAt,
      status: "running",
    }),
  );
  try {
    await writeAgentMetadataFile(lifecycle, resumeRequest, "running", {
      resumedAt: new Date().toISOString(),
      resumedFromMessageId: message.id,
    });
  } catch (error) {
    // SendMessage resume setup 失败不能覆盖原 terminal task；
    // 还原旧 snapshot，避免一个未启动的新 turn 卡成 running。
    registry.register(previousTask);
    throw error;
  }

  const taskAbort = createSubagentTaskAbortController(abortControllers, lifecycle.agentId);
  const readyGate = createSubagentSessionReadyGate();
  void runBackgroundAgent(
    options,
    resumeRequest,
    lifecycle,
    registry,
    { signal: taskAbort.signal },
    {
      resumeFromStore: true,
      onSessionReady: async () => {
        await emitSubagentEvent(
          options,
          SessionEventType.SubagentSpawned,
          resumeRequest,
          lifecycle.runTraceContext,
          {
            agentId: lifecycle.agentId,
            agentType: resumeRequest.agentType,
            background: true,
            childSessionId: lifecycle.childSessionId,
            description: resumeRequest.description,
            outputFile: lifecycle.outputFile,
            parentToolCallId: resumeRequest.parentToolCallId,
            prompt: resumeRequest.prompt,
            resumed: true,
            status: "running",
          },
        );
        readyGate.resolve();
      },
      onSessionStartFailed: readyGate.reject,
    },
    taskAbort.dispose,
  );
  try {
    await readyGate.promise;
  } catch (error) {
    taskAbort.abort(error);
    registry.register(previousTask);
    throw error;
  }
  // terminal 状态属于旧 snapshot，但 resume 输出路径属于新 lifecycle；
  // 旧 snapshot 的可选 outputFile 不能用于本次 provider-visible 结果。
  return createSendMessageSuccess(
    { ...task, outputFile: lifecycle.outputFile },
    message,
    "resumed_background",
  );
}

function createRuntimeTaskPendingMessage(
  request: SubagentSendMessageRequest,
): RuntimeTaskPendingMessage {
  return {
    id: `msg_${crypto.randomUUID()}`,
    isMeta: true,
    message: request.message,
    origin: {
      kind: "coordinator",
      toolCallId: String(request.parentToolCallId),
    },
    queuedAt: new Date(),
    summary: request.summary,
    traceContext: request.trace,
  };
}

function createSendMessageSuccess(
  task: Pick<RuntimeTaskSnapshot, "agentId" | "outputFile" | "status" | "taskId">,
  message: RuntimeTaskPendingMessage,
  delivery: NonNullable<SubagentSendMessageResult["delivery"]>,
): SubagentSendMessageResult {
  const providerMessage =
    delivery === "queued"
      ? `Message queued for delivery to ${task.agentId} at its next tool round.`
      : delivery === "resumed_background"
        ? `Agent "${task.agentId}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${task.outputFile}`
        : `Message ${message.id} was sent to its active turn for local agent ${task.agentId}.`;
  return {
    status: "success",
    messageId: message.id,
    delivery,
    agentId: task.agentId,
    taskId: task.taskId,
    outputFile: task.outputFile,
    message: providerMessage,
  };
}

function createSendMessageFailure(
  request: SubagentSendMessageRequest,
  error: string,
): SubagentSendMessageResult {
  return {
    status: "failed",
    messageId: `msg_${crypto.randomUUID()}`,
    agentId: request.to,
    error,
    message: error,
  };
}

async function runAgentToCompletion(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  runOptions?: SubagentRunOptions,
  monitorOptions: { reportActivity?: () => void } = {},
  executionOptions: SubagentExecutionOptions = {},
): Promise<{ events: SessionEvent[]; output: AgentCompletedOutput }> {
  let sessionReady = false;
  const notifySessionReady = async () => {
    if (sessionReady) return;
    await executionOptions.onSessionReady?.();
    sessionReady = true;
  };
  const childResult = await options.runExploreAgent(
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      allowedTools: resolveAllowedTools(lifecycle.profile, options),
      // 显式 background Agent 的 child tool 会被镜像到父会话；
      // 过去丢失这个来源会让父 turn 把仍在运行的 child tool 误当前台孤儿收口。这里必须
      // 保留 getter，foreground 后续转后台时，每条 mirror event 才会读取 registry 当前值，
      // 而不是继续携带 child 启动时的 false 快照。
      get background() {
        return registry.get(lifecycle.agentId)?.isBackgrounded === true;
      },
      disallowedTools: lifecycle.profile.disallowedTools,
      sessionId: lifecycle.childSessionId,
      description: request.description,
      maxTurns: lifecycle.profile.maxTurns,
      onSessionReady: notifySessionReady,
      permissionMode: lifecycle.profile.permissionMode,
      prompt: request.prompt,
      profile: lifecycle.profile,
      registerMessageSink: createMessageSinkRegistration(options, lifecycle, registry),
      reportActivity: monitorOptions.reportActivity,
      resumeFromStore: executionOptions.resumeFromStore,
      systemPrompt: lifecycle.profile.systemPrompt,
      workingDirectory: request.workingDirectory,
      workspaceRoot: request.workspaceRoot,
      traceContext: lifecycle.childTraceContext,
    },
    runOptions,
  );
  // 测试桩和旧注入实现可能尚未主动调用 readiness hook；真实 AgentRuntime 会在
  // persist 后调用。回落只保证兼容，不改变生产链路的 persist-before-spawn 顺序。
  await notifySessionReady();

  const usage = aggregateModelUsage(childResult.events);
  const totalTokens = usage?.totalTokens;
  const totalToolUseCount = resolveSubagentToolUseCount(childResult.events);
  const totalDurationMs = Date.now() - lifecycle.startedAt;

  const output: AgentCompletedOutput = {
    status: "completed",
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    content: [
      {
        type: "text",
        text: childResult.response,
      },
    ],
    totalToolUseCount,
    totalDurationMs,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(usage === undefined ? {} : { usage }),
  };

  return { events: childResult.events, output };
}

function createSubagentActivityWatchdog(options: {
  abort: (reason?: unknown) => void;
  lifecycle: SubagentLifecycle;
  logger?: Logger;
  request: SubagentRunRequest;
  signal: AbortSignal;
  timeoutMs: number;
}): {
  reportActivity: () => void;
  start: () => void;
  stop: () => void;
} {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      reportActivity: () => {},
      start: () => {},
      stop: () => {},
    };
  }

  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    stop();
    if (options.signal.aborted) return;
    timer = setTimeout(() => {
      const idleMs = Date.now() - lastActivityAt;
      const error = createCoreError(
        CoreErrorType.ToolTimeout,
        `Subagent was inactive for ${options.timeoutMs}ms`,
        {
          context: {
            code: AgentErrorCode.CHILD_RUNTIME_FAILED,
            agentId: options.lifecycle.agentId,
            agentType: options.request.agentType,
            idleMs,
            parentToolCallId: options.request.parentToolCallId,
            timeoutMs: options.timeoutMs,
          },
          recoverable: true,
          retryable: true,
        },
      );
      options.logger?.warn("Explore subagent activity watchdog fired", {
        ...traceContextToLogContext(options.lifecycle.runTraceContext),
        agentId: options.lifecycle.agentId,
        agentType: options.request.agentType,
        event: "subagent.activity_timeout",
        idleMs,
        module: "core.subagent",
        parentToolCallId: options.request.parentToolCallId,
        status: "failed",
        timeoutMs: options.timeoutMs,
      });
      options.abort(error);
    }, options.timeoutMs);
  };

  const reportActivity = () => {
    lastActivityAt = Date.now();
    schedule();
  };

  return {
    reportActivity,
    start: reportActivity,
    stop,
  };
}

function guardSubagentPromiseWithAbort<T>(
  promise: Promise<T>,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;

  // 子运行时或模型适配器在 abort 后可能永不 settle；外层 Agent 必须自己监听
  // 父 signal，否则 `Agent` 工具会一直停在 running，直到用户手动 Stop。
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abortHandler);
      callback();
    };

    const abortHandler = () => {
      if (isCoreError(signal.reason)) {
        settle(() => reject(signal.reason));
        return;
      }
      settle(() =>
        reject(
          createCoreError(
            CoreErrorType.ToolCancelled,
            "Agent was cancelled before the subagent returned findings or background launch completed",
            {
              cause: signal.reason instanceof Error ? signal.reason : undefined,
              context: {
                code: AgentErrorCode.CHILD_RUNTIME_FAILED,
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                parentToolCallId: request.parentToolCallId,
              },
              recoverable: true,
            },
          ),
        ),
      );
    };

    promise.then(
      (completed) => settle(() => resolve(completed)),
      (error: unknown) => settle(() => reject(error)),
    );

    if (signal.aborted) {
      abortHandler();
      return;
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}

async function runBackgroundAgent(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  runOptions?: SubagentRunOptions,
  executionOptions: SubagentExecutionOptions = {},
  onSettled?: () => void,
): Promise<void> {
  let sessionReady = false;
  try {
    if (isTerminalRuntimeTask(registry.get(lifecycle.agentId) ?? { status: "lost" })) {
      return;
    }
    const completed = await runAgentToCompletion(
      options,
      request,
      lifecycle,
      registry,
      runOptions,
      {},
      {
        ...executionOptions,
        onSessionReady: async () => {
          await executionOptions.onSessionReady?.();
          sessionReady = true;
        },
      },
    );
    await finalizeBackgroundCompletion(options, request, lifecycle, registry, completed);
  } catch (error) {
    if (!sessionReady) {
      executionOptions.onSessionStartFailed?.(error);
      return;
    }
    await finalizeBackgroundFailure(options, request, lifecycle, registry, error);
  } finally {
    onSettled?.();
  }
}

interface SubagentExecutionOptions {
  resumeFromStore?: boolean;
  onSessionReady?: () => Promise<void>;
  onSessionStartFailed?: (error: unknown) => void;
}

function createSubagentSessionReadyGate(): {
  promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  let settled = false;
  return {
    promise,
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

function createMessageSinkRegistration(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
): (sink: RuntimeTaskMessageSink) => void {
  return (sink) => {
    registry.update(lifecycle.agentId, (task) => ({
      ...task,
      messageSink: sink,
    }));
    void flushPendingMessages(options, lifecycle, registry, sink);
  };
}

async function flushPendingMessages(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  sink: RuntimeTaskMessageSink,
): Promise<void> {
  const pending = registry.drainMessages(lifecycle.agentId);
  for (let index = 0; index < pending.length; index++) {
    const message = pending[index];
    if (!message) continue;
    try {
      await sink.send(message);
    } catch (error) {
      for (const undelivered of pending.slice(index)) {
        registry.queueMessage(lifecycle.agentId, undelivered);
      }
      options.logger?.warn("Failed to flush pending subagent message", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent.message.flush.failed",
        module: "core.subagent",
        status: "failed",
      });
      return;
    }
  }
}

function createRuntimeTaskSnapshot(input: {
  isBackgrounded: boolean;
  lifecycle: SubagentLifecycle;
  request: SubagentRunRequest;
  startedAt: Date;
  status: RuntimeTaskSnapshot["status"];
}): RuntimeTaskSnapshot {
  return {
    taskId: input.lifecycle.agentId,
    agentId: input.lifecycle.agentId,
    agentType: input.request.agentType,
    childSessionId: input.lifecycle.childSessionId,
    description: input.request.description,
    isBackgrounded: input.isBackgrounded,
    outputFile: input.lifecycle.outputFile,
    parentToolCallId: input.request.parentToolCallId,
    parentSessionId: input.request.sessionId,
    prompt: input.request.prompt,
    startedAt: input.startedAt,
    status: input.status,
    taskType: "local_agent",
    traceContext: input.lifecycle.runTraceContext,
    type: "local_agent",
    turnId: input.request.turnId,
  };
}

function withoutRuntimeMessageState(task: RuntimeTaskSnapshot): RuntimeTaskSnapshot {
  const { messageSink: _messageSink, pendingMessages: _pendingMessages, ...snapshot } = task;
  return snapshot;
}

function createAgentBackgroundedOutput(
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
): AgentBackgroundedOutput {
  return {
    status: "async_launched",
    isAsync: true,
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    childSessionId: lifecycle.childSessionId,
    backgroundTaskId: lifecycle.agentId,
    outputFile: lifecycle.outputFile,
    canReadOutputFile: request.callerCanReadOutputFile === true,
  };
}

async function finalizeBackgroundCompletion(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  completed: { output: AgentCompletedOutput },
): Promise<void> {
  const current = registry.get(lifecycle.agentId);
  if (current && isTerminalRuntimeTask(current)) return;

  await writeCompletedAgentArtifacts(lifecycle, request, completed.output);
  const notification = formatLocalAgentTaskNotification({
    agentId: completed.output.agentId,
    agentType: completed.output.agentType,
    description: completed.output.description,
    outputFile: lifecycle.outputFile,
    parentToolCallId: String(request.parentToolCallId),
    result: completed.output.content.map((block) => block.text).join("\n\n"),
    status: "completed",
    totalDurationMs: completed.output.totalDurationMs,
    totalTokens: completed.output.totalTokens,
    totalToolUseCount: completed.output.totalToolUseCount,
    usage: completed.output.usage,
  });
  const completedAt = new Date();
  const task = registry.update(lifecycle.agentId, (current) => ({
    ...withoutRuntimeMessageState(current),
    status: "completed",
    completedAt,
    output: completed.output,
    usage: {
      durationMs: completed.output.totalDurationMs,
      modelUsage: completed.output.usage,
      toolUseCount: completed.output.totalToolUseCount,
      totalTokens: completed.output.totalTokens,
    },
  }));
  enqueueBackgroundNotification(
    options,
    registry,
    lifecycle.agentId,
    notification,
    lifecycle.runTraceContext,
  );
  if (task) {
    await emitBackgroundTaskCompletedEvent(options, request, lifecycle.runTraceContext, task);
  }

  await emitSubagentEvent(
    options,
    SessionEventType.SubagentStopped,
    request,
    lifecycle.runTraceContext,
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      background: true,
      childSessionId: lifecycle.childSessionId,
      parentToolCallId: request.parentToolCallId,
      status: "completed",
      outputFile: lifecycle.outputFile,
      totalDurationMs: completed.output.totalDurationMs,
      totalToolUseCount: completed.output.totalToolUseCount,
      totalTokens: completed.output.totalTokens,
    },
  );

  options.logger?.info("Subagent background task completed", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    durationMs: completed.output.totalDurationMs,
    event: "subagent.background.completed",
    module: "core.subagent",
    status: "completed",
    totalToolUseCount: completed.output.totalToolUseCount,
    totalTokens: completed.output.totalTokens,
  });
}

async function finalizeBackgroundFailure(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  error: unknown,
): Promise<void> {
  const current = registry.get(lifecycle.agentId);
  if (current && isTerminalRuntimeTask(current)) return;

  // background runner 收到的通常是 Turn failure wrapper，直接读 message
  // 会把 provider 的 429 原文替换成通用的 “Turn execution failed”；这里只选择
  // wrapper 下的根因 message，不压缩空白或截断 provider 原文。
  const errorMessage = error instanceof Error ? selectExecutionErrorMessage(error) : String(error);
  const completedAt = new Date();
  const totalDurationMs = Date.now() - lifecycle.startedAt;
  await writeFailedAgentArtifacts(lifecycle, request, errorMessage);
  const notification = formatLocalAgentTaskNotification({
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    error: errorMessage,
    outputFile: lifecycle.outputFile,
    parentToolCallId: String(request.parentToolCallId),
    status: "failed",
    totalDurationMs,
  });
  const task = registry.update(lifecycle.agentId, (current) => ({
    ...withoutRuntimeMessageState(current),
    status: "failed",
    completedAt,
    error: errorMessage,
    usage: {
      durationMs: totalDurationMs,
    },
  }));
  enqueueBackgroundNotification(
    options,
    registry,
    lifecycle.agentId,
    notification,
    lifecycle.runTraceContext,
  );
  if (task) {
    await emitBackgroundTaskCompletedEvent(options, request, lifecycle.runTraceContext, task);
  }

  await emitSubagentEvent(
    options,
    SessionEventType.SubagentStopped,
    request,
    lifecycle.runTraceContext,
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      background: true,
      childSessionId: lifecycle.childSessionId,
      parentToolCallId: request.parentToolCallId,
      status: "failed",
      outputFile: lifecycle.outputFile,
      totalDurationMs,
      error: errorMessage,
    },
  );

  options.logger?.warn("Subagent background task failed", {
    ...traceContextToLogContext(lifecycle.runTraceContext),
    agentId: lifecycle.agentId,
    errorMessage,
    event: "subagent.background.failed",
    module: "core.subagent",
    status: "failed",
  });
}

interface StoppedBackgroundAgentTask {
  previousTask: RuntimeTaskSnapshot;
  task: RuntimeTaskSnapshot;
  totalDurationMs: number;
  traceContext: TraceContext;
}

const BACKGROUND_AGENT_STOPPED_STATE = {
  backgroundEventStatus: "cancelled",
  message: "Background agent task stopped.",
  notificationStatus: "stopped",
  registryStatus: "killed",
  subagentEventStatus: "stopped",
} as const;

function createBackgroundStoppedTask(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
): StoppedBackgroundAgentTask | undefined {
  const current = registry.get(task.taskId);
  if (!current || isTerminalRuntimeTask(current)) return undefined;

  const completedAt = new Date();
  const totalDurationMs = Math.max(0, completedAt.getTime() - current.startedAt.getTime());
  const stopped: RuntimeTaskSnapshot = {
    ...withoutRuntimeMessageState(current),
    status: BACKGROUND_AGENT_STOPPED_STATE.registryStatus,
    completedAt,
    error: BACKGROUND_AGENT_STOPPED_STATE.message,
    usage: {
      durationMs: totalDurationMs,
    },
  };

  const traceContext = traceContextFromRuntimeTask(stopped);
  return { previousTask: current, task: stopped, totalDurationMs, traceContext };
}

async function finalizeBackgroundStopped(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  stopped: StoppedBackgroundAgentTask,
  onCommitted?: () => void,
): Promise<RuntimeTaskSnapshot | undefined> {
  const notification = formatLocalAgentTaskNotification({
    agentId: stopped.task.agentId,
    agentType: stopped.task.agentType,
    description: stopped.task.description,
    outputFile: stopped.task.outputFile ?? "",
    parentToolCallId: String(stopped.task.parentToolCallId ?? stopped.task.taskId),
    status: BACKGROUND_AGENT_STOPPED_STATE.notificationStatus,
    totalDurationMs: stopped.totalDurationMs,
  });
  await writeStoppedAgentArtifacts(stopped.task);
  registry.update(stopped.task.taskId, (current) => ({
    ...stopped.task,
    notified: current.notified,
  }));
  const enqueued = enqueueBackgroundNotification(
    options,
    registry,
    stopped.task.taskId,
    notification,
    stopped.traceContext,
  );
  if (!enqueued) {
    registry.register(stopped.previousTask);
    throw new Error(
      `Background agent task stopped notification was not enqueued: ${stopped.task.taskId}`,
    );
  }

  const committed = registry.get(stopped.task.taskId);
  if (!committed) return undefined;
  onCommitted?.();

  await emitRuntimeTaskBackgroundCompletedEvent(options, committed, stopped.traceContext);
  await emitRuntimeTaskSubagentStoppedEvent(
    options,
    committed,
    stopped.traceContext,
    stopped.totalDurationMs,
  );
  options.logger?.info("Subagent background task stopped", {
    ...traceContextToLogContext(stopped.traceContext),
    agentId: stopped.task.agentId,
    event: "subagent.background.stopped",
    module: "core.subagent",
    status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
  });
  return committed;
}

async function emitBackgroundTaskCompletedEvent(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  traceContext: TraceContext,
  task: RuntimeTaskSnapshot,
): Promise<void> {
  if (!isTerminalRuntimeTask(task)) return;
  await emitSubagentEvent(
    options,
    SessionEventType.BackgroundTaskCompleted,
    request,
    traceContext,
    {
      taskId: task.taskId,
      toolCallId: String(request.parentToolCallId),
      toolName: "Agent",
      taskKind: "subagent",
      childSessionId: task.childSessionId,
      cancellable: false,
      description: task.description,
      status: task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? new Date(),
      outputPath: task.outputFile,
      terminalId: task.taskId,
    },
  );
}

async function emitRuntimeTaskBackgroundCompletedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
): Promise<void> {
  if (!task.parentSessionId) return;
  const event = createSessionEvent(
    SessionEventType.BackgroundTaskCompleted,
    task.parentSessionId,
    {
      taskId: task.taskId,
      toolCallId: String(task.parentToolCallId ?? task.taskId),
      toolName: "Agent",
      taskKind: "subagent",
      childSessionId: task.childSessionId,
      cancellable: false,
      description: task.description,
      status: BACKGROUND_AGENT_STOPPED_STATE.backgroundEventStatus,
      startedAt: task.startedAt,
      completedAt: task.completedAt ?? new Date(),
      outputPath: task.outputFile,
      terminalId: task.taskId,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

async function emitRuntimeTaskSubagentStoppedEvent(
  options: ExploreSubagentPortOptions,
  task: RuntimeTaskSnapshot,
  traceContext: TraceContext,
  totalDurationMs: number,
): Promise<void> {
  if (!task.parentSessionId) return;
  const event = createSessionEvent(
    SessionEventType.SubagentStopped,
    task.parentSessionId,
    {
      agentId: task.agentId,
      agentType: task.agentType,
      background: true,
      childSessionId: task.childSessionId,
      parentToolCallId: task.parentToolCallId,
      status: BACKGROUND_AGENT_STOPPED_STATE.subagentEventStatus,
      outputFile: task.outputFile,
      totalDurationMs,
      error: task.error,
    },
    {
      turnId: task.turnId,
      traceId: traceContext.traceId,
    },
  );
  await options.emitParentEvent(event, traceContext);
}

function enqueueBackgroundNotification(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  taskId: string,
  message: string,
  traceContext: TraceContext,
): boolean {
  if (!options.enqueueParentTaskNotification) {
    options.logger?.warn("Skipped subagent background notification without parent queue", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.skipped",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  const task = registry.get(taskId);
  if (!task || task.notified) {
    options.logger?.debug("Skipped duplicate subagent background notification", {
      ...traceContextToLogContext(traceContext),
      event: "subagent.background.notification.duplicate",
      module: "core.subagent",
      reason: task ? "already_notified" : "task_missing",
      taskId,
    });
    return false;
  }

  try {
    options.enqueueParentTaskNotification({
      originMeta: {
        backgroundSource: "subagent",
        title: task.description.trim() || taskId,
        workId: taskId,
      },
      taskId,
      text: message,
      traceContext,
    });
  } catch (error) {
    options.logger?.warn("Failed to enqueue subagent background notification", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.background.notification.failed",
      module: "core.subagent",
      taskId,
    });
    return false;
  }

  registry.update(taskId, (current) =>
    current.notified
      ? current
      : {
          ...current,
          notified: true,
        },
  );
  options.logger?.info?.("Subagent background notification enqueued", {
    ...traceContextToLogContext(traceContext),
    event: "subagent.background.notification.enqueued",
    module: "core.subagent",
    taskId,
  });
  return true;
}

function traceContextFromRuntimeTask(task: RuntimeTaskSnapshot): TraceContext {
  return (
    task.traceContext ?? {
      traceId: createTraceId(),
      spanId: `span_${task.taskId}`,
      sessionId: task.parentSessionId,
      turnId: task.turnId,
    }
  );
}

async function emitSubagentEvent(
  options: ExploreSubagentPortOptions,
  type: SessionEventType,
  request: SubagentRunRequest,
  traceContext: TraceContext,
  payload: Record<string, unknown>,
): Promise<void> {
  const event = createSessionEvent(type, request.sessionId, payload, {
    turnId: request.turnId,
    traceId: traceContext.traceId,
  });
  await options.emitParentEvent(event, traceContext);
}

async function writeCompletedAgentArtifacts(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  output: AgentCompletedOutput,
): Promise<void> {
  const text = output.content.map((block) => block.text).join("\n\n");
  await writeAgentOutputFiles(lifecycle, text);
  // 子 agent 事件已由 session event store 持久化，不再重复写入 transcript sidecar。
  await writeAgentMetadataFile(lifecycle, request, "completed", {
    completedAt: new Date().toISOString(),
    totalDurationMs: output.totalDurationMs,
    totalTokens: output.totalTokens,
    totalToolUseCount: output.totalToolUseCount,
    usage: output.usage,
  });
}

async function writeFailedAgentArtifacts(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  errorMessage: string,
): Promise<void> {
  await writeAgentOutputFiles(lifecycle, errorMessage);
  await writeAgentMetadataFile(lifecycle, request, "failed", {
    completedAt: new Date().toISOString(),
    error: errorMessage,
  });
}

async function writeStoppedAgentArtifacts(task: RuntimeTaskSnapshot): Promise<void> {
  if (!task.outputFile) return;
  const outputDir = dirname(task.outputFile);
  const content = `${BACKGROUND_AGENT_STOPPED_STATE.message}\n`;
  await writeTextFile(task.outputFile, content);
  await writeTextFile(join(outputDir, "task.output"), content);
  await writeTextFile(
    join(outputDir, "metadata.json"),
    `${JSON.stringify(
      {
        agentId: task.agentId,
        childSessionId: task.childSessionId,
        completedAt: new Date().toISOString(),
        description: task.description,
        outputFile: task.outputFile,
        parentSessionId: task.parentSessionId,
        parentToolUseId: task.parentToolCallId,
        profileId: task.agentType,
        prompt: task.prompt,
        status: BACKGROUND_AGENT_STOPPED_STATE.subagentEventStatus,
        taskOutputFile: join(outputDir, "task.output"),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function writeAgentOutputFiles(
  lifecycle: Pick<SubagentLifecycle, "outputFile" | "taskOutputFile">,
  content: string,
): Promise<void> {
  await writeTextFile(lifecycle.outputFile, content);
  await writeTextFile(lifecycle.taskOutputFile, content);
}

async function writeAgentMetadataFile(
  lifecycle: SubagentLifecycle,
  request: SubagentRunRequest,
  status: "running" | "completed" | "failed" | "stopped",
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeTextFile(
    lifecycle.metadataFile,
    `${JSON.stringify(
      {
        agentId: lifecycle.agentId,
        childSessionId: lifecycle.childSessionId,
        createdAt: new Date(lifecycle.startedAt).toISOString(),
        cwd: request.workingDirectory,
        description: request.description,
        metadataFile: lifecycle.metadataFile,
        outputFile: lifecycle.outputFile,
        parentSessionId: request.sessionId,
        parentToolUseId: request.parentToolCallId,
        profileId: request.agentType,
        profileSnapshot: lifecycle.profile,
        prompt: request.prompt,
        status,
        taskOutputFile: lifecycle.taskOutputFile,
        updatedAt: new Date().toISOString(),
        workspaceRoot: request.workspaceRoot,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

function aggregateModelUsage(events: SessionEvent[]): ModelUsage | undefined {
  let usage: ModelUsage | undefined;

  for (const event of events) {
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload;
    if (!isRecord(payload) || !isRecord(payload.usage)) {
      continue;
    }

    const modelUsage = payload.usage as ModelUsage;
    if (!hasModelUsage(modelUsage)) continue;
    usage ??= {};
    addUsage(usage, modelUsage);
  }

  return usage;
}

function resolveSubagentToolUseCount(events: SessionEvent[]): number {
  let turnCompleteToolCallCount = 0;
  let sawTurnCompleteToolCallCount = false;

  for (const event of events) {
    if (event.type !== SessionEventType.TurnComplete || !isRecord(event.payload)) {
      continue;
    }
    const toolCallCount = event.payload.toolCallCount;
    if (typeof toolCallCount !== "number" || !Number.isFinite(toolCallCount)) {
      continue;
    }
    sawTurnCompleteToolCallCount = true;
    turnCompleteToolCallCount += toolCallCount;
  }

  if (sawTurnCompleteToolCallCount) {
    return turnCompleteToolCallCount;
  }

  // ToolCallResult/ToolCallError 会直接 append 到 event store，
  // 不一定回填进 child TurnResult.events；child TurnComplete 里的 toolCallCount
  // 才是运行时 loopState 累计出的权威子 agent 工具调用数。
  return events.filter(
    (event) =>
      event.type === SessionEventType.ToolCallResult ||
      event.type === SessionEventType.ToolCallError,
  ).length;
}

function addUsage(target: ModelUsage, next: ModelUsage): void {
  addOptionalUsageNumber(target, "inputTokens", next.inputTokens);
  addOptionalUsageNumber(target, "outputTokens", next.outputTokens);
  addOptionalUsageNumber(target, "totalTokens", resolveTotalTokens(next));
  addOptionalUsageNumber(target, "cacheReadTokens", next.cacheReadTokens);
  addOptionalUsageNumber(target, "cacheWriteTokens", next.cacheWriteTokens);
  addOptionalUsageNumber(target, "reasoningTokens", next.reasoningTokens);
  const webSearchRequests = next.serverToolUse?.webSearchRequests ?? 0;
  const webFetchRequests = next.serverToolUse?.webFetchRequests ?? 0;
  if (webSearchRequests > 0 || webFetchRequests > 0) {
    target.serverToolUse ??= {};
    target.serverToolUse.webSearchRequests =
      (target.serverToolUse.webSearchRequests ?? 0) + webSearchRequests;
    target.serverToolUse.webFetchRequests =
      (target.serverToolUse.webFetchRequests ?? 0) + webFetchRequests;
  }
}

function addOptionalUsageNumber(
  target: ModelUsage,
  key: keyof Pick<
    ModelUsage,
    | "inputTokens"
    | "outputTokens"
    | "totalTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "reasoningTokens"
  >,
  value: number | undefined,
): void {
  if (value === undefined) return;
  target[key] = (target[key] ?? 0) + value;
}

function resolveTotalTokens(usage: ModelUsage): number | undefined {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return getModelUsageTotalTokens(usage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAllowedTools(
  profile: AgentProfile,
  options: ExploreSubagentPortOptions,
): readonly string[] {
  const profileTools = isBuiltInExploreAgentProfile(profile)
    ? (options.getAllowedTools?.(profile) ?? EXPLORE_AGENT_ALLOWED_TOOLS)
    : profile.tools;
  const baseTools = [...(profileTools ?? [])];
  const disallowed = new Set(profile.disallowedTools ?? []);
  if (profile.skills && profile.skills.length > 0 && !disallowed.has("Skill")) {
    baseTools.push("Skill");
  }
  return filterSubagentChildToolNames(baseTools, profile.disallowedTools);
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
