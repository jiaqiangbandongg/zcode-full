import type { Model, ModelInputMessage, ModelToolContract, TraceContext } from "../deps.js";
import type { AgentTelemetryCausation, ModelApiOperation } from "@zcode/contracts";
import {
  PermissionService,
  createDenyPermissionBroker,
  createToolExecutor,
  defaultPermissionConfig,
  traceContextToLogContext,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { buildRuntimeProviderRequestMessages } from "./runtime-provider-request-messages.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../methods/model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "../methods/runtime-model.js";

export interface ProjectMemoryAgentContext {
  causation?: AgentTelemetryCausation;
  memoryRoot: string;
  providerEntries: readonly RuntimeMessageEntry[];
  midConversationSystem: AgentRuntimeInternal["config"]["midConversationSystem"];
  model: Model;
  operation: ModelApiOperation;
  readFileState: ReadFileStateMap;
  tools: readonly ModelToolContract[];
  traceContext: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}

export function captureProjectMemoryAgentContext(
  runtime: AgentRuntimeInternal,
  input: {
    memoryRoot: string;
    /** Extraction 继承产生该工作的 Turn Model。 */
    model?: Model;
    operation: ModelApiOperation;
    traceContext: TraceContext;
  },
): ProjectMemoryAgentContext {
  const baseModel =
    input.model ??
    createRuntimeModel(runtime, {
      selection: runtime.getSessionModelSelection(),
    });
  const model = withModelInvocationContext(baseModel, (request) => ({
    // Extraction 是 transcript 的消费者；不把它自己的请求写回同一 model-io 目录，
    // 避免后台链路占用 rollout 槽位并在后续 Extraction 中自反馈。
    metadata: {
      ...traceContextToLogContext(input.traceContext),
      querySource: input.operation,
      skipTranscript: true,
    },
    modelCall: { operation: input.operation },
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: input.traceContext,
    }),
    traceContext: input.traceContext,
  }));
  return {
    causation: runtime.agentTelemetry.captureCausation(),
    memoryRoot: input.memoryRoot,
    // Extraction 会跨异步边界消费这份成员浅快照；它依赖 RuntimeMessageEntry
    // 进入 MessageHistory 后保持不可变。后续只能 append、整体 replace 或 copy-on-write，
    // 禁止原地修改共享的 entry/message/content，否则会污染已调度的 Memory 上下文。
    providerEntries: [...runtime.messageHistory.borrowReadOnlyRuntimeEntries()],
    midConversationSystem: runtime.config.midConversationSystem,
    model,
    operation: input.operation,
    readFileState: new Map(runtime.readFileState),
    tools: runtime.getTools(model).map((tool) => ({ ...tool })),
    traceContext: input.traceContext,
    workingDirectory: runtime.workingDirectory,
    workspaceRoot: runtime.workspaceRoot,
  };
}

export function buildProjectMemoryAgentProviderMessages(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  prompt: string,
): ModelInputMessage[] {
  const entries: RuntimeMessageEntry[] = [
    ...context.providerEntries,
    { message: { content: prompt, role: "user" } },
  ];
  return buildRuntimeProviderRequestMessages(
    {
      config: { midConversationSystem: context.midConversationSystem },
    },
    { applyCacheControl: true, entries, model: context.model },
  ).messages;
}

export function createProjectMemoryAgentToolExecutor(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
) {
  return createToolExecutor({
    artifactStore: runtime.artifactStore,
    emitEvent: async () => {},
    executionPort: runtime.executionPort,
    fileSystemPort: runtime.fileSystemPort,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    getMode: () => "yolo",
    getMemoryRoot: () => context.memoryRoot,
    getWorkingDirectory: () => context.workingDirectory,
    getWorkspaceRoot: () => context.workspaceRoot,
    imageProcessorPort: runtime.imageProcessorPort,
    pdfDocumentPort: runtime.pdfDocumentPort,
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
    model: context.model,
    permissionBroker: createDenyPermissionBroker(),
    permissionService: new PermissionService(defaultPermissionConfig),
    // Memory agent 必须继承 Main 已完成的 Read；否则 provider context 说文件已读，
    // Edit 执行边界却会拒绝同一文件，和基线的 cloned tool context 不一致。
    readFileState: new Map(context.readFileState),
    registry: runtime.registry,
    runtimeScope: "main",
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    skillPort: runtime.skillPort,
    traceContext: context.traceContext,
  });
}
