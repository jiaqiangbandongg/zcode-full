import {
  createTurnAgentDefinitions,
  createAgentDefinitionsReader,
  type GetAgentDefinitions,
} from "../subagent/definitions.js";
import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY, resolveExecutionState } from "@zcode/shared";
import type { BackgroundBashOutputResult } from "@zcode/shared";
import {
  createDenyPermissionBroker,
  createRootTraceContext,
  createToolRegistry,
  defaultPermissionConfig,
  EventReducer,
  MessageHistoryImpl,
  PermissionService,
  ToolScheduler,
  traceContextToLogContext,
} from "./deps.js";
import type {
  CollaborationMode,
  Logger,
  BackgroundTaskCancelResult,
  SessionEvent,
  MessageId,
  Model,
  ModelSelection,
  ModelSelectionOrigin,
  ModelToolContract,
  PermissionBrokerPort,
  PermissionBrokerRequest,
  ProjectId,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  SessionStorePort,
  SessionGoal,
  SavedWorkflowScope,
  TargetChangedPayload,
  DynamicWorkflowRunProgressPayload,
  UserInputAutoResolutionUpdatedPayload,
  ContextSourcePort,
  ExecutionPort,
  FileSystemPort,
  ImageProcessorPort,
  PdfDocumentPort,
  McpConnectionSnapshot,
  SkillLoadOutcome,
  SkillPort,
  McpPort,
  DynamicWorkflowRunPort,
  ModelCatalogPort,
  SubagentPort,
  ToolArtifactStorePort,
  ToolCallId,
  TraceContext,
  TurnSteerInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  ToolCall,
  TurnState,
  MessageHistory,
  ReadFileStateMap,
  ToolSchedule,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
  ContextSourceSnapshot,
  ExecutionShellSelection,
  HookRunner,
  TurnId,
} from "./deps.js";
import { installAgentRuntimeMethods } from "./methods/index.js";
import type { StartSavedWorkflowRunResult } from "./methods/dynamic-workflow-run-start.js";
import type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./methods/dynamic-workflow-run-settings.js";
import { createRuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type {
  ModelConnectivityTestInput,
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "./methods/workspace-generate-text.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";
import { initializeRuntimeTooling } from "./helpers/runtime-tools.js";
import {
  resolveInitialDynamicWorkflowToolsActivated,
  type DynamicWorkflowActivationSource,
} from "./methods/dynamic-workflow-activation.js";
import type {
  ActiveTurnInfo,
  ActiveForegroundExecutionState,
  AcquireForegroundPromotionLeaseResult,
  ActiveTurnStartReservation,
  ActiveTurnSteeringState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ContinueActiveTargetLoopOptions,
  ConversationBeforeInputForkOptions,
  ConversationRewindResult,
  ExecuteToolsOptions,
  ExecuteToolsResult,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ForegroundPromotionLeaseMode,
  ForegroundPromotionLeaseState,
  PendingModelChangeTimeline,
  PermissionDecisionResult,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
  ResumeSessionOptions,
  ResumeSessionResult,
  SelectionSideChatCreateOptions,
  StableConversationForkOptions,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
} from "./types.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { InMemoryRuntimeTaskRegistry, type RuntimeTaskRegistry } from "../runtime-task/registry.js";
import { createMemoryRecallState } from "../memory/recall/index.js";
import type { MemoryRecallState } from "../memory/recall/index.js";
import type { ChildClientPortsContext, ClientFacingPorts } from "./helpers/child-client-ports.js";
import type { ProjectMemoryRecallPrefetch } from "./helpers/project-memory-recall.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { ProjectMemoryUpdate } from "./helpers/project-memory-dream.js";
import { projectPersistentAgentMemoryTools } from "../subagent/persistent-memory.js";
import { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";
import { disposeNodeReplSession } from "../tool/handlers/node-repl.js";
import { cloneModelSelection } from "./model-selection.js";

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging
export class AgentRuntime {
  private sessionId: SessionId;
  private turnNumber: number;
  private config: AgentRuntimeConfig;
  private appVersion: string;
  private permissionService: PermissionService;
  private permissionBroker: PermissionBrokerPort;
  private toolScheduler: ToolScheduler;
  private eventReducer: EventReducer;
  private eventStore: SessionEventStorePort;
  private rootTraceContext: TraceContext;
  private logger?: Logger;
  private eventSinks = new Set<SessionEventSink>();
  private now: () => Date;
  private isRemoteWorkspace: () => boolean;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private hookRunner?: HookRunner;
  private workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  private modelFactory: AgentRuntimeDeps["modelFactory"];
  private modelIoDir?: string;
  private providerRuntimeHeadersPort?: AgentRuntimeDeps["providerRuntimeHeadersPort"];
  private browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  /** 模型请求准入端口；随每次模型请求进调用上下文。 */
  private modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  private sessionModelSelection: ModelSelection | undefined;
  private messageHistory: MessageHistory;
  private readFileState: ReadFileStateMap;
  private cachedTools: ModelToolContract[] | null = null;
  /** launch.md「On demand: activation」：onDemand 会话出生为 false，`activateDynamicWorkflowTools` 翻为 true。 */
  private dynamicWorkflowToolsActivated: boolean;
  private dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  private contextBuilder: ContextBuilder | null = null;
  private contextInitialized = false;
  private contextSourceSnapshot?: ContextSourceSnapshot;
  private latestContextBuildResult?: ContextBuildResult;
  private memoryRoot?: string;
  private memoryIndexContent?: string;
  private memoryRecallState: MemoryRecallState;
  private memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  private memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  private memoryDreamLastScanAtMs = 0;
  private pendingMemoryUpdate?: ProjectMemoryUpdate;
  private contextSourcePort?: ContextSourcePort;
  private skillPort?: SkillPort;
  private mcpPort?: McpPort;
  private mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  private residencyBlockingWorkCount = 0;
  private mcpInitialized = false;
  private mcpToolsRegistered = false;
  private registeredMcpToolNames?: string[];
  private mcpToolsSignature?: string;
  private mcpToolListRevision?: number;
  private subagentPort?: SubagentPort;
  private readonly getAgentDefinitions: GetAgentDefinitions;
  private readonly prepareAgentDefinitions: ReturnType<
    typeof createTurnAgentDefinitions
  >["prepare"];
  private dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  private modelCatalogPort?: ModelCatalogPort;
  private runtimeTaskRegistry: RuntimeTaskRegistry;
  private branchGeneration = 0;
  private artifactStore?: ToolArtifactStorePort;
  private executionPort?: ExecutionPort;
  private fileSystemPort?: FileSystemPort;
  private imageProcessorPort?: ImageProcessorPort;
  private pdfDocumentPort?: PdfDocumentPort;
  private skillLoadOutcome?: SkillLoadOutcome;
  private workingDirectory: string;
  private workspaceRoot: string;
  private sessionStore?: SessionStorePort;
  private sessionPersisted = false;
  private needsPlanModeExitReminder = false;
  private latestConversationMessageId?: MessageId;
  private latestAssistantMessageId?: MessageId;
  private latestAssistantTurnId?: TurnId;
  private mainTurnCacheHitAggregate: MainTurnCacheHitAggregate = {
    requestCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };
  private currentTurnFileChanges: RuntimeTurnFileChangeMap = new Map();
  private lastAssistantCompletedAtMs?: number;
  private lastEmittedLocalDate?: string;
  private autoCompactConsecutiveFailures = 0;
  private runtimeCommandQueue: RuntimeCommandQueue;
  private runtimeCommandDrainActive = false;
  private activeForegroundExecution?: ActiveForegroundExecutionState;
  /** sendQueuedNow 的 Core 调度权；只活在当前进程，匹配 runtime command 出队即消费。 */
  private foregroundPromotionLease?: ForegroundPromotionLeaseState;
  private activeTurn?: ActiveTurnSteeringState;
  private activeTurnStartReservation?: ActiveTurnStartReservation;
  private pendingInputSequence = 0;
  /** sendQueuedNow reservation；只活在当前 CLI 进程，防 drain/多端重复提升。 */
  private pendingInputReservations = new Map<string, string>();
  // v4 setAutoDrain：false 时排队输入不自动消费
  // （turn-stop 不续跑、roundtrip 间不 drain），保留成 held 供显式消费。
  private queueAutoDrain = true;
  // 暂停队列恢复后由 CLI 按投影 FIFO 逐项提升。这个窗口内禁止 core 只看当前
  // activeTurn.pendingInputs 做行内 drain，否则新入队消息会越过仍留在投影中的旧暂停项。
  private queueExternalDrainActive = false;
  private shuttingDown = false;
  private backgroundTaskNotificationsSealed = false;
  private backgroundTaskNotificationSealReason?: "subagent_terminal" | "subagent_cancelled";
  private pendingModelChangeTimeline?: PendingModelChangeTimeline;
  private sessionStartHookRan = false;
  private sessionTitleGenerationAttempted = false;
  private agentTelemetry: RuntimeTelemetryFacade;

  constructor(sessionId: SessionId, config: AgentRuntimeConfig, deps: AgentRuntimeDeps) {
    const runtime = this as unknown as AgentRuntimeInternal;
    this.sessionId = sessionId;
    this.turnNumber = 0;
    // 3.12.2：兼容旧 Host/内部调用传入 legacy，但本版本 Runtime、日志和子 Agent 只使用 preflight。
    this.config = projectPersistentAgentMemoryTools({
      ...config,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    });
    Object.assign(this.config, resolveExecutionState(config));
    const definitions = createTurnAgentDefinitions(
      deps.getAgentDefinitions ??
        createAgentDefinitionsReader(this.config.subagents?.profiles ?? [], {
          builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
        }),
      deps.loadAgentDefinitions,
    );
    this.getAgentDefinitions = definitions.get;
    this.prepareAgentDefinitions = definitions.prepare;
    this.agentTelemetry = new RuntimeTelemetryFacade({
      agentName: config.agentName,
      causation: deps.agentTelemetryCausation,
      causationMode: deps.agentTelemetryCausationMode,
      parentSessionId: config.parentSessionId,
      port: deps.agentTelemetry,
      sessionId,
      taskType: config.taskType,
    });
    this.permissionService =
      deps.permissionService ?? new PermissionService(defaultPermissionConfig);
    this.permissionBroker = deps.permissionBroker ?? createDenyPermissionBroker();
    this.toolScheduler =
      deps.toolScheduler ??
      new ToolScheduler({
        maxConcurrency: this.config.toolConcurrency?.maxConcurrency,
      });
    this.eventReducer = new EventReducer();
    this.eventStore = deps.eventStore;
    this.sessionStore = deps.sessionStore;
    this.rootTraceContext = deps.traceContext ?? createRootTraceContext({ sessionId });
    this.appVersion = deps.appVersion ?? "0.0.0";
    this.logger = deps.logger?.child({
      ...traceContextToLogContext(this.rootTraceContext),
      module: "core.runtime",
    });
    if (deps.eventSink) {
      this.eventSinks.add(deps.eventSink);
    }
    this.now = deps.now ?? (() => new Date());
    this.isRemoteWorkspace = deps.isRemoteWorkspace ?? (() => false);
    this.modelFactory = deps.modelFactory;
    this.modelIoDir = deps.modelIoDir;
    this.providerRuntimeHeadersPort = deps.providerRuntimeHeadersPort;
    this.browserControlPort = deps.browserControlPort;
    this.modelRequestAdmission = deps.modelRequestAdmission;
    // 旧会话的选择缺失不能阻断历史恢复；不在这里制造默认模型。
    this.sessionModelSelection =
      config.modelSelection && cloneModelSelection(config.modelSelection);
    this.messageHistory = new MessageHistoryImpl();
    this.readFileState = new Map();
    this.memoryRecallState = createMemoryRecallState();
    this.runtimeCommandQueue = createRuntimeCommandQueue();
    this.workingDirectory = config.workingDirectory ?? ".";
    this.contextSourcePort = deps.contextSourcePort;
    this.skillPort = deps.skillPort;
    this.mcpPort = deps.mcpPort;
    this.runtimeTaskRegistry = deps.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
    this.runtimeTaskRegistry.setActiveBranchGeneration?.(this.branchGeneration);
    this.artifactStore = deps.artifactStore;
    this.executionPort = deps.executionPort;
    this.fileSystemPort = deps.fileSystemPort;
    this.imageProcessorPort = deps.imageProcessorPort;
    this.pdfDocumentPort = deps.pdfDocumentPort;
    this.subagentPort = deps.subagentPort ?? runtime.createDefaultSubagentPort(deps);
    this.dynamicWorkflowRunPort = deps.dynamicWorkflowRunPort;
    // GUI「配置」解析子代理模型用的目录（与工具上下文拿的是同一个端口）。
    this.modelCatalogPort = deps.modelCatalogPort;
    this.registry = deps.toolRegistry ?? createToolRegistry();
    this.workspaceRoot = this.workingDirectory;
    // 必须先于工具装配：registerRuntimeBuiltInTools 的灰度门读的就是这个状态。
    this.dynamicWorkflowToolsActivated = resolveInitialDynamicWorkflowToolsActivated(this.config);
    const tooling = initializeRuntimeTooling(runtime, deps, sessionId);
    this.hookRunner = tooling.hookRunner;
    this.workspaceHookAdmission = deps.workspaceHookAdmission;
    this.executor = tooling.executor;

    this.contextBuilder = deps.contextBuilder ?? null;
    if (this.contextBuilder) {
      runtime.initializeMessageHistoryFromContext(this.contextBuilder, this.rootTraceContext);
      this.contextInitialized = true;
    }
    runtime.startMcpStartup(this.rootTraceContext);
  }

  async closeBrowserSession(): Promise<void> {
    this.beginShutdown();
    disposeNodeReplSession(this.sessionId);
    try {
      await this.browserControlPort?.closeSession?.({
        sessionId: this.sessionId,
        traceContext: this.rootTraceContext,
      });
    } catch (error) {
      // browser backend 清理失败不能阻断 execution/MCP/session store 的主关闭链路。
      this.logger?.warn("Browser session cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.session_cleanup.failed",
      });
    }
  }

  beginShutdown(): void {
    // ExecutionPort.close() 会把后台 Bash 收口为 cancelled；若允许
    // teardown terminal event 再唤醒模型，并与随后关闭的 session store 竞态。
    this.shuttingDown = true;
    // 关闭单个 session 后进程仍存活，
    // 因此必须先终止该 runtime 的 Extraction，不能只在超时后放弃等待。
    this.memoryExtractionScheduler?.shutdown();
  }
}

export interface AgentRuntime {
  lastPermissionGrantId?: string;
  beginShutdown(): void;
  closeBrowserSession(): Promise<void>;
  updateConfig(
    patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
  ): void;
  initializeSessionShellEnvironmentIfNeeded(
    selection: ExecutionShellSelection | (() => ExecutionShellSelection),
  ): boolean;
  getSessionShellSelection(): ExecutionShellSelection | undefined;
  getMode(): CollaborationMode;
  getPlanEnabled(): boolean;
  grantPermissionFullAccess(interactionId: string, signal?: AbortSignal): Promise<string>;
  setExecutionState(
    input: { mode?: string; planEnabled?: boolean },
    traceContext?: TraceContext,
  ): Promise<void>;
  getSessionModelSelection(): ModelSelection | undefined;
  setSessionModelSelection(selection: ModelSelection | undefined): void;
  getProjectId(): ProjectId;
  ensureSessionPersistedForExternalActivity(
    input: string,
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  maybeStartSessionTitleGenerationFromExternalInput(
    input: string,
    options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
  ): void;
  /** renameSession：用户显式重命名（titleSource=custom，发 SessionTitleUpdated）。 */
  setCustomSessionTitle(input: { title: string; traceContext: TraceContext }): Promise<void>;
  maybeStartGoalSummaryTitleGeneration(
    input: string,
    targetID: string,
    options?: { traceContext?: TraceContext },
  ): boolean;
  recordExternalUserPrompt(
    input: string,
    options?: {
      goalSummaryTargetID?: string;
      traceContext?: TraceContext;
      intent?: TurnInputIntentMetadata;
    },
  ): Promise<MessageId>;
  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;
  getActiveTurnInfo(): ActiveTurnInfo | undefined;
  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;
  /** Session 常驻池使用的 runtime busy 权威事实，包含 queue/drain/reservation。 */
  hasActiveOrQueuedTurnWork(): boolean;
  /** Session 常驻池使用的后台 Bash/Agent/Workflow running 权威事实。 */
  hasRunningBackgroundTasks(): boolean;
  /**
   * Session 常驻池唯一消费的 runtime owned-work 聚合事实。
   * 包含前台/队列、registry background task、detached sidecar 和 memory work。
   */
  hasResidencyBlockingWork(): boolean;
  /**
   * 登记一段会越过当前同步调用栈的 runtime-owned work，计数在**本同步片**增加、在 promise 的
   * finally 释放（实现见 runtime/methods/residency.ts）。
   *
   * 公开在这一面上，是因为 runtime 之外的 sidecar 也要经同一个口登记：dwf 引擎跑在会话 App 里、
   * 不进 runtime task registry，因此出现「引擎在飞时会话被按 idle 关掉」。
   * 新增 sidecar 一律登记到这里，而不是在 bootstrap 侧另加一条猜测。
   */
  trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T>;
  /**
   * 会话是否已落进持久化 store。协议层 record 的 draft（deferred）判定以此为事实源：任何经 runtime
   * 首次持久化的路径（首条输入、外部活动、中枢直接启动的启动轮）都会让会话离开 draft。
   */
  isSessionPersisted(): boolean;
  getActiveForegroundExecutionId(): string | undefined;
  acquireForegroundPromotionLease(options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  }): AcquireForegroundPromotionLeaseResult;
  releaseForegroundPromotionLease(leaseId: string): boolean;
  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  /** v4 queue 单项删除：按 pendingInputId 移除当前 active turn 的一条排队输入。 */
  removePendingInputById(options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  reservePendingInputById(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  markPendingInputPromoting(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  releasePendingInputReservation(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue 单项编辑：按 pendingInputId 替换排队输入文本（保位）。 */
  editPendingInputById(options: {
    pendingInputId: string;
    newText: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue 重排：移动 pendingInputId 到 beforePendingInputId 之前（null=队尾）。 */
  reorderPendingInput(options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /**
   * v4 heldQueueDisposition=clearQueueAndSend 执行件：
   * 清空全部排队输入（active turn 内存项 + held 投影残留），返回丢弃条数。
   */
  clearAllPendingInputs(traceContext: TraceContext): Promise<number>;
  /** v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级）。 */
  setQueueAutoDrain(options: { autoDrain: boolean; traceContext?: TraceContext }): Promise<void>;
  /** 暂停队列外层 FIFO 已消费到空，恢复后续 running queue 的行内 drain。 */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode：翻转 followup 路由模式（queue/guide，会话级）。 */
  setFollowupMode(options: { mode: "queue" | "guide"; traceContext?: TraceContext }): Promise<void>;
  /** v4 switchModelConfig：模型选型变化后补发 ModelSelected（config/marker 投影）。 */
  emitModelSelected(options: {
    modelSelection: ModelSelection;
    model?: Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext?: TraceContext;
  }): Promise<void>;
  /** v4 switchCollaborationMode：协作模式切换后补发 SessionModeChanged（config.mode 投影）。 */
  emitModeChanged(options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  }): Promise<void>;
  getToolRegistry(): ToolRegistry;
  /**
   * 注册表被外部改写后让 getTools 重算。公开它的唯一使用者是 dwf driver 的 submit profile 运行时
   * 守卫：静态 profile 与实际 ask 不符时把
   * typed 的 submit_result 换回通用声明——改的是同一个注册表，缓存不失效就会继续把旧声明发给模型。
   */
  invalidateToolCache(): void;
  getToolExecutor(): ToolExecutor;
  subscribeEvents(sink: SessionEventSink): () => void;
  /** Bootstrap-owned lifecycle producers append only validated session events through this durable path. */
  appendEvent(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  /**
   * 外部子 runtime 的接缝（一）：交出本 runtime 的会话事件 store，供 class 外构造的子
   * runtime 共享（照 `subagent.ts` 的 `eventStore: this.eventStore`）。理由见
   * `methods/config.ts` 的实现注释。
   */
  getSessionEventStore(): SessionEventStorePort;
  /**
   * 外部子 runtime 的接缝（二）：把子会话的原始事件扇出给本 runtime 的外部 sink 集
   * （保留子 sessionId、只通知不 append）。**必须在子 runtime 构造期装成它的
   * `deps.eventSink`**——理由见 `methods/config.ts` 的实现注释。
   */
  notifyExternalChildSessionEvent(input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
    /**
     * 子 runtime 的交互归属（与 `createChildClientPorts` 同一份）。在场时交互事件
     * （PermissionRequested / Resolved / Denied）另镜像一份到本会话，确认窗才能在父界面出现。
     */
    interactionOrigin?: ChildClientPortsContext;
  }): Promise<void>;
  /**
   * 外部子 runtime 的接缝（三）：铸造子 runtime 的对外交互端口（permission broker +
   * provider runtime headers），已绑定本 runtime 的客户端路由身份。class 外构造的子 runtime
   * **必须**经这里取这两个端口，不能自行从 appOptions 取——理由见 `methods/config.ts` 的实现注释。
   */
  createChildClientPorts(context: ChildClientPortsContext): ClientFacingPorts;
  getContextBuilder(): ContextBuilder;
  /** Composer 使用的 Session Skill 快照；同一 runtime 冻结，runtime 重建后重新发现。 */
  getSkillCatalog(traceContext: TraceContext): Promise<SkillLoadOutcome>;
  resumeFromStore(options?: ResumeSessionOptions): Promise<ResumeSessionResult>;
  recordTargetChanged(input: TargetChangedPayload & { traceContext: TraceContext }): Promise<void>;
  recordUserInputAutoResolutionUpdate(
    input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** workflow run 进度的出回合追加（事件源在 bootstrap 的 run service）。 */
  recordDynamicWorkflowRunProgress(
    input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** 恢复的 dwf run 的追踪重臂（registry 登记 + started 事件 + waiter + 结算通知）。 */
  /**
   * onDemand 会话注册十个工作流工具（docs/dynamic-workflow/launch.md「On demand: activation」）。
   * 已激活时 no-op 返回 false。触发点：`/workflow` 展开、GUI 的 Resume / 配置 / 直接启动、冷恢复。
   */
  activateDynamicWorkflowTools(input: {
    source: DynamicWorkflowActivationSource;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  trackResumedDynamicWorkflowRun(input: {
    runId: string;
    toolCallId?: string;
    name?: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  /**
   * 中枢直接启动一个已保存的工作流：解析 + 校验 + 编译，
   * 干净则 submit 启动 run、落 controlOnly 启动轮、登记后台追踪。`app.startSavedWorkflow` 能力的
   * 落地实现（端口在场时注册）。
   */
  startSavedWorkflowRun(input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * GUI「配置」改一个 run 的子代理模型与并发上界：以同一份脚本修订出新 run、登记后台追踪、把设置轮排进队列。
   * `app.amendWorkflowRunSettings` 能力的落地实现。
   */
  amendWorkflowRunSettings(
    input: AmendWorkflowRunSettingsInput,
  ): Promise<AmendWorkflowRunSettingsResult>;
  recordGoalStateChangeReminder(input: {
    text: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  continueActiveTargetIfIdle(options?: {
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TurnInputIntentMetadata;
    traceContext?: TraceContext;
    verifyBeforeContinue?: boolean;
  }): Promise<TurnResult | null>;
  continueActiveTargetLoop(options: ContinueActiveTargetLoopOptions): Promise<TurnResult | null>;
  stopActiveForegroundExecution(
    options?: StopActiveForegroundExecutionOptions,
  ): StopActiveForegroundExecutionResult;
  activatePausedTargetAfterResume(traceContext: TraceContext): Promise<SessionGoal | null>;
  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;
  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;
  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecisionResult): Promise<void>;
  getPendingPermissionRequests(): PermissionBrokerRequest[];
  getProjection(): Promise<SessionProjection>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  stopBackgroundTask(
    taskId: string,
    options: RuntimeBackgroundStopOptions,
  ): Promise<RuntimeBackgroundStopResult>;
  cancelRunningRuntimeBackgroundTasks(input: {
    reason: "subagent_cancelled";
    traceContext?: TraceContext;
  }): Promise<void>;
  sealBackgroundTaskNotifications(input: {
    reason: "subagent_terminal" | "subagent_cancelled";
    traceContext?: TraceContext;
  }): void;
  getSessionId(): SessionId;
  listWorkspaceCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkWorkspaceFromCheckpoint(options?: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  forkStableConversationAtMessage(
    options: StableConversationForkOptions,
  ): Promise<WorkspaceForkResult>;
  createSelectionSideConversation(
    options: SelectionSideChatCreateOptions,
  ): Promise<WorkspaceForkResult>;
  forkConversationBeforeMessage(
    options: ConversationBeforeInputForkOptions,
  ): Promise<WorkspaceForkResult>;
  /**
   * conversation edit/retry 的 same-session branch cut primitive。
   *
   * 该入口故意不经过 executeTurn command queue：组合文件 rewind 会在文件事务的
   * commit gate 内调用它；若再排队 `/rewind`，当前 edit command 会等待自己释放队列。
   */
  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;
  previewWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceFileRewindPreview>;
  applyWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    commitAfterApply?: () => Promise<void>;
  }): Promise<WorkspaceFileRewindApplyResult>;
  sampleModel(
    input: import("./methods/sample-model.js").SampleModelInput,
    options: { abortSignal: AbortSignal; traceContext?: TraceContext },
  ): Promise<import("@zcode/shared/mcp-apps").McpAppsSamplingResult>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<WorkspaceGenerateTextResult>;
  testModelConnectivity(
    input: ModelConnectivityTestInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  isProjectMemoryEnabled(): boolean;
  /** 缺省等待最多 60 秒；null 等待全部已调度提取结束，不设置 drain deadline。 */
  drainMemoryExtractions(timeoutMs?: number | null): Promise<void>;
}

installAgentRuntimeMethods(AgentRuntime);
