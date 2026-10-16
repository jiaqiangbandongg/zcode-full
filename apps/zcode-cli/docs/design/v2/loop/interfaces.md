# M1-M5 对外接口

本文档整理 @zcode/contracts 和 @zcode/core 包的所有对外接口（public API）。

---

## 一、@zcode/contracts

### 1.1 interfaces/shared.ts

```typescript
// Brand types
type SessionId = string & { readonly __brand: 'SessionId' };
type TurnId = string & { readonly __brand: 'TurnId' };
type EventId = string & { readonly __brand: 'EventId' };
type TraceId = string & { readonly __brand: 'TraceId' };
type ToolCallId = string & { readonly __brand: 'ToolCallId' };

// Factory functions
function createSessionId(id?: string): SessionId;
function createTurnId(id?: string): TurnId;
function createEventId(id?: string): EventId;
function createTraceId(): TraceId;
function createToolCallId(id?: string): ToolCallId;
```

### 1.2 interfaces/session.port.ts

```typescript
// === Enums ===

type CollaborationMode = 'plan' | 'build' | 'yolo' | 'auto';
type SessionStatus = 'idle' | 'running' | 'waiting' | 'paused' | 'completed' | 'error';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed' | 'denied';
type InputDelivery = 'auto' | 'start_turn' | 'steer_active_turn';
type TurnSteerRejectReason =
  | 'no_active_turn'
  | 'expected_turn_mismatch'
  | 'turn_not_steerable'
  | 'empty_input'
  | 'input_too_large';

// === Session Event Store Port ===

interface SessionEventStorePort {
  append(event: SessionEvent): Promise<void>;
  getEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]>;
  getLatestSequenceNumber(sessionId: SessionId): Promise<number>;
  deleteSession(sessionId: SessionId): Promise<void>;
}

// === Session Projection ===

interface SessionProjection {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  status: SessionStatus;
  turnCount: number;
  totalTokenCount: number;
  contextUsed: number;
  contextWindow: number;
  pendingPermissions: PendingPermission[];
  pendingSteerInputs: PendingSteerInputInfo[];
  activeToolCalls: ActiveToolCall[];
  currentTurnId?: TurnId;
  lastError?: ErrorInfo;
}

interface PendingSteerInputInfo {
  pendingInputId: string;
  input: string;
  inputPreview: string;
  inputSize: number;
  queuedAt: Date;
  targetTurnId: TurnId;
  traceId: TraceId;
}

interface PendingPermission {
  toolCallId: string;
  toolName: string;
  riskLevel: RiskLevel;
  requestedAt: Date;
}

interface ActiveToolCall {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  startedAt?: Date;
}

interface ErrorInfo {
  type: string;
  message: string;
}

// === Event Reducer Port ===

interface EventReducerPort {
  reduce(events: SessionEvent[]): SessionProjection;
  apply(projection: SessionProjection, event: SessionEvent): SessionProjection;
}

// === Session Manager Port ===

interface SessionManagerPort {
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: SessionId): Promise<Session>;
  forkSession(sessionId: SessionId, forkPoint?: number): Promise<Session>;
  getSession(sessionId: SessionId): Promise<Session | null>;
  listSessions(): Promise<SessionSummary[]>;
}

interface SessionConfig {
  mode?: CollaborationMode;
  contextWindow?: number;
  traceId?: TraceId;
}

interface Session {
  id: SessionId;
  config: SessionConfig;
  eventStore: SessionEventStorePort;
  projection: SessionProjection;
  eventReducer: EventReducerPort;
}

interface TurnSteerInput {
  input: string;
  expectedTurnId?: TurnId;
  traceContext?: TraceContext;
}

type TurnSteerResult =
  | { kind: 'queued'; turnId: TurnId; pendingInputId: string; queueLength: number }
  | { kind: 'rejected'; reason: TurnSteerRejectReason; activeTurnId?: TurnId };

type SendInputResult =
  | { kind: 'started_turn'; result: TurnResult }
  | { kind: 'queued'; turnId: TurnId; pendingInputId: string; queueLength: number }
  | { kind: 'rejected'; reason: TurnSteerRejectReason; activeTurnId?: TurnId };

interface SessionSummary {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  status: SessionStatus;
  turnCount: number;
}
```

### 1.3 events/session.events.ts

```typescript
// === Event Type ===

const SessionEventType = {
  SessionCreated: 'session_created',
  SessionResumed: 'session_resumed',
  SessionForked: 'session_forked',
  SessionCompacted: 'session_compacted',
  SessionEnded: 'session_ended',
  TurnStarted: 'turn_started',
  TurnInputReceived: 'turn_input_received',
  TurnSteerQueued: 'turn_steer_queued',
  TurnSteerDrained: 'turn_steer_drained',
  TurnSteerRejected: 'turn_steer_rejected',
  TurnSteerDiscarded: 'turn_steer_discarded',
  TurnComplete: 'turn_complete',
  TurnError: 'turn_error',
  UserMessage: 'user_message',
  AssistantMessage: 'assistant_message',
  SystemMessage: 'system_message',
  ModelRequest: 'model_request',
  ModelSelected: 'model_selected',
  ModelStreaming: 'model_streaming',
  ModelComplete: 'model_complete',
  ModelError: 'model_error',
  ToolCallScheduled: 'tool_call_scheduled',
  ToolCallStarted: 'tool_call_started',
  ToolCallResult: 'tool_call_result',
  ToolCallError: 'tool_call_error',
  ToolBatchComplete: 'tool_batch_complete',
  PermissionRequested: 'permission_requested',
  PermissionResolved: 'permission_resolved',
  PermissionDenied: 'permission_denied',
  CompactBoundary: 'compact_boundary',
  RewindTriggered: 'rewind_triggered',
  CheckpointCreated: 'checkpoint_created',
  SubagentSpawned: 'subagent_spawned',
  SubagentMessage: 'subagent_message',
  SubagentStopped: 'subagent_stopped',
  Interrupt: 'interrupt',
  Cancel: 'cancel',
  Resume: 'resume',
  Error: 'error',
} as const;

type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];

// === Base Event ===

interface SessionEvent {
  id: EventId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: SessionEventType;
  timestamp: Date;
  traceId: TraceId;
  sequenceNumber: number;
  payload: unknown;
}

// === Event Payloads ===

interface SessionCreatedPayload {
  mode: CollaborationMode;
  contextWindow: number;
}

interface TurnStartedPayload {
  turnNumber: number;
  input: string;
}

interface TurnCompletePayload {
  response: string;
  tokenCount: number;
  toolCallCount: number;
  duration: number;
  resultType: TurnResultType;
}

interface TurnErrorPayload {
  error: ErrorPayload;
  turnPhase: string;
}

interface ToolCallScheduledPayload {
  toolCallId: ToolCallId;
  toolName: string;
  input: unknown;
  schedule: ToolSchedulePayload;
}

interface ToolCallResultPayload {
  toolCallId: ToolCallId;
  result: ToolResultPayload;
  duration: number;
}

interface PermissionRequestedPayload {
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  input: unknown;
}

interface PermissionResolvedPayload {
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
}

// === Supporting Types ===

type TurnResultType =
  | 'success'
  | 'error_max_turns'
  | 'error_max_budget'
  | 'error_during_execution'
  | 'error_max_tool_calls';

type PermissionDecision = 'allow' | 'deny' | 'escalate' | 'modify';

interface ToolSchedulePayload {
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

interface ToolResultPayload {
  success: boolean;
  content: string;
  error?: ErrorPayload;
}

interface ErrorPayload {
  type: string;
  message: string;
  stack?: string;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheTokens?: number;
}

// === Event Factory ===

function createSessionEvent<T>(
  type: SessionEventType,
  sessionId: SessionId,
  payload: T,
  options?: { turnId?: TurnId; traceId?: TraceId; sequenceNumber?: number }
): SessionEvent;
```

### 1.4 events/event-reducer.ts

```typescript
// === Event Reducer ===

class EventReducer {
  reduce(events: SessionEvent[]): SessionProjection;
  apply(projection: SessionProjection, event: SessionEvent): SessionProjection;
}

// === Utility Functions ===

function reduce(events: SessionEvent[]): SessionProjection;
function apply(projection: SessionProjection, event: SessionEvent): SessionProjection;
```

### 1.5 errors/index.ts

```typescript
// === Error Type ===

const CoreErrorType = {
  SessionNotFound: 'session_not_found',
  SessionAlreadyExists: 'session_already_exists',
  SessionCorrupted: 'session_corrupted',
  TurnNotFound: 'turn_not_found',
  TurnInProgress: 'turn_in_progress',
  InvalidTurnPhase: 'invalid_turn_phase',
  ModelError: 'model_error',
  ModelTimeout: 'model_timeout',
  ModelRateLimited: 'model_rate_limited',
  ModelContextExceeded: 'model_context_exceeded',
  ToolNotFound: 'tool_not_found',
  ToolExecutionFailed: 'tool_execution_failed',
  ToolTimeout: 'tool_timeout',
  ToolCancelled: 'tool_cancelled',
  PermissionDenied: 'permission_denied',
  PermissionEscalation: 'permission_escalation',
  PermissionTimeout: 'permission_timeout',
  InvalidStateTransition: 'invalid_state_transition',
  EventOutOfOrder: 'event_out_of_order',
  ProjectionCorrupted: 'projection_corrupted',
  StorageError: 'storage_error',
  ConfigurationError: 'configuration_error',
  UnknownError: 'unknown_error',
} as const;

type CoreErrorType = (typeof CoreErrorType)[keyof typeof CoreErrorType];

// === Core Error ===

interface CoreError extends Error {
  type: CoreErrorType;
  code: string;
  message: string;
  cause?: Error;
  context?: Record<string, unknown>;
  recoverable: boolean;
  retryable: boolean;
  timestamp: Date;
}

// === Error Factory ===

function createCoreError(
  type: CoreErrorType,
  message: string,
  options?: {
    cause?: Error;
    context?: Record<string, unknown>;
    recoverable?: boolean;
    retryable?: boolean;
  }
): CoreError;

// === Error Creators ===

function sessionNotFound(sessionId: string): CoreError;
function invalidTurnPhase(current: string, expected: string[]): CoreError;
function toolNotFound(toolName: string): CoreError;
function toolExecutionFailed(toolName: string, cause?: Error): CoreError;
function permissionDenied(toolName: string, reason?: string): CoreError;

// === Predicates ===

function isCoreError(error: unknown): error is CoreError;
function isRetryable(error: CoreError): boolean;
function isRecoverable(error: CoreError): boolean;
```

### 1.6 model/index.ts

```typescript
// === Model Ref ===

interface ModelRef {
  providerId: ModelProviderId;
  modelId: ModelId;
  role?: ModelRole;
  source?: ModelRefSource;
  variant?: string;
}

type ModelProviderId = string & { readonly __brand: 'ModelProviderId' };
type ModelId = string & { readonly __brand: 'ModelId' };

const ModelRole = {
  Main: 'main',
  Lite: 'lite',
  Compact: 'compact',
  Review: 'review',
  Subagent: 'subagent',
} as const;

const ModelRefSource = {
  Default: 'default',
  Config: 'config',
  Env: 'env',
  Cli: 'cli',
  Session: 'session',
  Agent: 'agent',
  Tool: 'tool',
} as const;
```

---

## 二、@zcode/core

### 2.1 agent/turn-state.ts

```typescript
// === Turn Phase ===

const TurnPhase = {
  Idle: 'idle',
  ProcessingInput: 'processing_input',
  AwaitingModelResponse: 'awaiting_model_response',
  Streaming: 'streaming',
  SchedulingTools: 'scheduling_tools',
  ExecutingTools: 'executing_tools',
  AggregatingResults: 'aggregating_results',
  AwaitingPermission: 'awaiting_permission',
  Completing: 'completing',
  Error: 'error',
} as const;

type TurnPhase = (typeof TurnPhase)[keyof typeof TurnPhase];

// === Turn State ===

interface TurnState {
  id: TurnId;
  sessionId: SessionId;
  turnNumber: number;
  phase: TurnPhase;
  traceId: TraceId;
  input: string;
  attachments?: TurnAttachment[];
  modelRequest?: ModelRequestState;
  streamingContent: string;
  finalResponse?: string;
  toolCalls: ToolCallState[];
  toolResults: ToolResultState[];
  scheduledTools: ToolScheduleState;
  pendingPermissions: PermissionRequestState[];
  resolvedPermissions: PermissionResultState[];
  resultType: TurnResultType;
  error?: TurnErrorState;
  startedAt: Date;
  completedAt?: Date;
}

// === Sub-types ===

interface ModelRequestState {
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  stopReason?: string;
  usage?: TokenUsageState;
}

interface ToolCallState {
  id: ToolCallId;
  name: string;
  input: unknown;
  status: ToolCallStateStatus;
  scheduledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: ToolResultState;
}

type ToolCallStateStatus =
  | 'scheduled'
  | 'waiting_permission'
  | 'permission_denied'
  | 'running'
  | 'completed'
  | 'failed';

interface ToolResultState {
  success: boolean;
  content: string;
  error?: TurnErrorState;
}

interface ToolScheduleState {
  items: ToolScheduleItem[];
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

interface PermissionRequestState {
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: string;
  requestedAt: Date;
}

interface PermissionResultState {
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
  resolvedAt: Date;
}

type PermissionDecision = 'allow' | 'deny' | 'escalate' | 'modify';

// === Factory ===

function createTurnState(
  id: TurnId,
  sessionId: SessionId,
  turnNumber: number,
  traceId: TraceId,
  input: string,
  attachments?: TurnAttachment[]
): TurnState;

// === Predicates ===

function isTerminalPhase(phase: TurnPhase): boolean;
function isWaitingPhase(phase: TurnPhase): boolean;
function canTransitionTo(current: TurnPhase, next: TurnPhase): boolean;
```

### 2.2 agent/turn-machine.ts

```typescript
// === Turn Machine ===

interface TurnMachine {
  state: TurnState;

  start(): TurnState;
  startModelRequest(model: string, messages: ModelMessage[]): TurnState;
  addStreamingContent(content: string): TurnState;
  scheduleTools(toolCalls: ToolCall[], schedule: ToolScheduleState): TurnState;
  startToolExecution(): TurnState;
  completeTool(toolCallId: ToolCallId, result: { success: boolean; content: string }): TurnState;
  requestPermission(request: PermissionRequestState): TurnState;
  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecision, modifiedInput?: unknown): TurnState;
  aggregateResults(): TurnState;
  complete(response: string, resultType?: TurnResultType): TurnState;
  fail(error: TurnErrorState): TurnState;
  getNextPhase(): TurnPhase;
  isComplete(): boolean;
}

class TurnMachineImpl implements TurnMachine {
  static create(sessionId: SessionId, turnNumber: number, input: string, traceId?: TraceId): TurnMachineImpl;
}
```

### 2.3 tool/scheduler.ts

```typescript
// === Tool Schedule ===

interface ToolSchedule {
  items: ToolScheduleItem[];
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

interface ToolScheduleItem {
  toolCallId: ToolCallId;
  dependencies: ToolCallId[];
  canRunParallel: boolean;
}

interface ToolDependency {
  toolCallId: ToolCallId;
  dependsOn: ToolCallId[];
}

// === Scheduler ===

class ToolScheduler {
  schedule(tools: ToolDependency[], readOnlyTools: Set<string>): ToolSchedule;
}

// === Default Instance ===

const defaultToolScheduler: ToolScheduler;
const READ_ONLY_TOOLS: Set<string>;  // Read, Glob, Grep, WebFetch, TodoRead, TodoWrite, AskUserQuestion
```

### 2.4 permission/service.ts

```typescript
// === Permission Context ===

interface PermissionContext {
  toolName: string;
  input: unknown;
  riskLevel: RiskLevel;
  mode: CollaborationMode;
}

interface PermissionDecisionResult {
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  escalated: boolean;
}

// === Permission Service ===

class PermissionService {
  constructor(config?: PermissionConfig);

  checkPermission(context: PermissionContext, toolCapability?: { riskLevel?: RiskLevel }): PermissionDecisionResult;
  requiresApproval(context: PermissionContext, toolCapability?: { riskLevel?: RiskLevel }): boolean;
  getRiskLevel(toolName: string, toolCapability?: { riskLevel?: RiskLevel }): RiskLevel;
}

// === Permission Config ===

interface PermissionConfig {
  allowedTools: Set<string>;
  disallowedTools: Set<string>;
  autoApproveHighRisk: boolean;
  allowMediumRiskInAutoMode: boolean;
}

const defaultPermissionConfig: PermissionConfig;
```

### 2.5 runtime.ts

```typescript
// === Agent Runtime Config ===

interface AgentRuntimeConfig {
  mode?: CollaborationMode;
  contextWindow?: number;
  maxTurns?: number;
}

// === Agent Runtime Deps ===

interface AgentRuntimeDeps {
  eventStore: SessionEventStorePort;
  permissionService?: PermissionService;
  toolScheduler?: ToolSchedule;
}

// === Turn Result ===

interface TurnResult {
  response: string;
  turnId: TurnId;
  events: SessionEvent[];
  projection: SessionProjection;
}

// === Agent Runtime ===

class AgentRuntime {
  constructor(sessionId: SessionId, config: AgentRuntimeConfig, deps: AgentRuntimeDeps);

  executeTurn(input: string, attachments?: TurnAttachment[]): Promise<TurnResult>;
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;
  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecisionResult): Promise<void>;
  getProjection(): Promise<SessionProjection>;
  getSessionId(): SessionId;
}

// === Runtime Factory ===

interface RuntimeFactory {
  create(config: AgentRuntimeConfig): Promise<AgentRuntime>;
}
```

---

## 三、接口依赖图

```
┌─────────────────────────────────────────────────────────────────┐
│                        @zcode/core                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐│
│  │ AgentRuntime│  │ TurnMachine │  │ PermissionService        ││
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘│
│         │                  │                     │               │
│         └──────────────────┼─────────────────────┘               │
│                            │                                     │
│         ┌─────────────────▼─────────────────┐                  │
│         │           @zcode/contracts           │                  │
│         │  ┌─────────────┬────────────────┐  │                  │
│         │  │    ports    │    events      │  │                  │
│         │  │  SessionPort │ SessionEvent   │  │                  │
│         │  │  EventReducer│ EventReducer   │  │                  │
│         │  └─────────────┴────────────────┘  │                  │
│         │  ┌─────────────┬────────────────┐  │                  │
│         │  │   errors    │     model      │  │                  │
│         │  │  CoreError  │   ModelRef     │  │                  │
│         │  └─────────────┴────────────────┘  │                  │
│         └─────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 四、Context Builder

### 4.1 设计目标

Context Builder 负责组装发送给模型的 system/context prefix。核心要求：

1. **结构化输出** — 每个 section 独立记录，方便调试和测试
2. **Token 估算** — 方便监控 context window 使用
3. **静默容错** — 文件不存在时静默跳过，不报错
4. **缓存友好** — stable system、dynamic system、meta user context 分块输出，由 adapter 翻译 provider cache intent

### 4.2 Section 组成

| Section | source | 状态 | 说明 |
|---------|--------|------|------|
| CLI Prefix | `cli_prefix` | ✅ 已完成 | 固定产品身份前缀 |
| Agent Identity | `identity` | ✅ 已完成 | fixed `zcode-agent` identity |
| Dynamic Behavior | `dynamic_behavior` | ✅ 已完成 | communication 与 action-caution 内容 |
| Environment Info | `env_info` | ✅ 已完成 | cwd, platform, git status |
| Skills | `skills` | ✅ 已完成 | 以 `<system-reminder>` user 前缀注入 |
| Request User Context | `request_user_context` | ✅ 已完成 | 聚合 resolved instruction files 与 project-memory index |
| Current Date | `current_date` | ✅ 已完成 | 当前日期 |

Provider-visible copy inside dynamic system sections must stay English-only.
This applies to Environment Info headings, field labels, and enum-like status
text so the system prompt remains language-consistent across locales.

Provider-visible copy inside stable behavior sections must also stay
English-only. See `docs/design/v2/loop/system-prompt-contract.md` for the full
stable prompt contract. The stable system prompt must include guidance
equivalent to:

- The main coding agent identity is fixed as `zcode-agent`; runtime agent
  metadata must not be string-spliced into the identity sentence.
- Do not guess or invent repository facts. Read relevant files and inspect
  existing patterns before proposing or making code changes.
- Tool results and user messages may include `<system-reminder>` or other tags;
  those tags carry system context and are not inherently tied to the specific
  tool result or user message that contains them.
- Fix root causes when possible, keep changes focused, update documentation when
  needed, and verify meaningful changes with focused checks.
- Ask for confirmation before destructive, hard-to-reverse, shared-system, or
  externally visible actions.
- Responses should stay brief and concise.
- When referencing a specific function or code snippet, use
  `file_path:line_number`.
- When the user types `/<skill-name>`, call `Skill` only if that exact skill is
  listed in the available skills metadata. Never guess missing skill names.

### 4.3 核心类型

```typescript
// === Context Source ===
type ContextSource =
  | 'cli_prefix'
  | 'identity'
  | 'env_info'
  | 'system_context'
  | 'skills'
  | 'tools'
  | 'request_user_context'
  | 'memory'
  | 'current_date'
  | 'custom_system_prompt'
  | 'subagent_agent_prompt'
  | 'subagent_notes'
  | 'subagent_environment'
  | 'dynamic_behavior'
  | 'session_guidance'
  | 'output_style'
  | 'context_management';

// === Context Section ===
interface ContextSection {
  name: string;           // 人类可读的 section 名称
  source: ContextSource; // 来源标识
  injectionTarget: 'system' | 'meta_user';
  cacheHint: 'stable' | 'dynamic';
  chars: number;         // 字符数
  tokens: number;        // 估算 token 数
  content: string;       // 完整内容
  preview: string;       // 前 100 字符预览
}

// === Context Build Result ===
interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  messages: ModelInputMessage[];  // stable system + dynamic system + optional meta_user prefix messages
}

interface ModelCacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
  scope?: 'global' | 'org';
}

interface ModelInputMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  cacheControl?: ModelCacheControl; // provider-neutral cache intent, translated by adapters
}

// === Environment Info ===
interface EnvInfo {
  cwd: string;
  platform: string;     // 'darwin' | 'linux' | 'win32'
  shell: string;       // 'zsh' | 'bash' | 'powershell'
  osVersion: string;
  nodeVersion: string;
  currentModel?: string; // active runtime model id, refreshed after /model changes
  isGitRepository?: boolean;
  gitBranch?: string;
  gitMainBranch?: string;
  gitUser?: string;
  gitStatus?: 'clean' | 'dirty' | 'not_repo';
  gitStatusLines?: string[]; // session-start status snapshot
  recentCommits?: string[];  // 最近 5 条 commit
}

// === User Instructions ===
interface UserInstructionsOptions {
  workingDirectory: string;  // 起始查找目录
  projectRoot?: string;     // 项目根目录（用于限制向上查找）
  priorityFiles?: string[]; // 优先级顺序，默认 ['AGENTS.md', 'CLAUDE.md']
  maxBytes?: number;        // 最大字节数限制
}

// === Project Context ===
interface ProjectContext {
  type: 'node' | 'python' | 'rust' | 'go' | 'java' | 'unknown';
  packageManager?: 'npm' | 'yarn' | 'pnpm';
  scripts?: Record<string, string>;  // package.json scripts
  buildFiles?: string[];  // Makefile, docker-compose.yml 等
  rootPackage?: string;   // 根目录的 package.json 内容（可选）
}

// === Session Context ===
interface SessionContextOptions {
  sessionId: string;
  mode: 'plan' | 'build' | 'yolo' | 'auto';
  userName?: string;
  userRole?: string;
}

// === Context Builder Config ===
interface ContextBuilderConfig {
  workingDirectory: string;
  envInfo: EnvInfo;
  currentDate?: string;                 // YYYY-MM-DD，由 adapter 解析
  userInstructions?: UserInstructionsOptions;  // L2
  projectContext?: ProjectContext;             // TODO - P2
  sessionContext?: SessionContextOptions;      // TODO - P3
}
```

`Environment Info` mixes one live field with a frozen git snapshot. The runtime
must refresh `currentModel` from the active session model selection whenever the
dynamic system block is rebuilt, including after `/model` changes and on resume.
All git-derived fields (`isGitRepository`, branch metadata, git user, status
lines, recent commits) are a session-start snapshot. They must be persisted and
reused for the rest of the session, and must not be recomputed later in the
same session, otherwise normal repository changes would invalidate prompt cache
identity.

### 4.4 User Instructions (L2)

项目指令必须在默认 prompt/TUI 路径自动进入模型上下文，而不是要求调用方手动传参：

```typescript
// 按顺序查找，第一个存在就停止
const PRIORITY_FILES = ['AGENTS.md', 'CLAUDE.md'];

// 层级查找：从 CWD 向上直到项目根目录
// 第一个匹配就停止，不堆叠多个文件
```

**规则：**
- AGENTS.md 优先级高于 CLAUDE.md
- 向上查找直到项目根目录
- 第一个匹配就停止
- 文件不存在时静默跳过
- bootstrap 默认启用 `userInstructions: { workingDirectory }`
- 文件读取仍由 context source adapter 完成，core 只消费 `ResolvedUserInstructions`
- 注入模型上下文时必须带 source path，便于审计和排查为什么某条规则生效
- 读取失败只进入 diagnostics，不阻断 session 启动

### 4.5 Project Context (P2)

启动时收集项目基础信息：

```typescript
interface ProjectContext {
  type: 'node' | 'python' | 'rust' | 'go' | 'java' | 'unknown';
  packageManager?: 'npm' | 'yarn' | 'pnpm';
  scripts?: Record<string, string>;
  buildFiles?: string[];
}
```

**检测内容：**
| 检测项 | 文件 |
|--------|------|
| Node.js | package.json |
| 包管理器 | yarn.lock, pnpm-lock.yaml, package-lock.json |
| 构建工具 | Makefile, docker-compose.yml |
| Python | requirements.txt, pyproject.toml |
| Rust | Cargo.toml |
| Go | go.mod |

### 4.6 Context Builder 接口

```typescript
interface ContextBuilder {
  config: ContextBuilderConfig;

  // 构建 context
  build(): ContextBuildResult;

  // 添加自定义 section
  addSection(section: Omit<ContextSection, 'chars' | 'tokens'>): this;

  // 兼容入口；工具说明不进入 context，由 model request tools 承载
  setTools(registry: ToolRegistry): this;
}
```

### 4.7 调试用法

```typescript
const ctx = builder.build();

// 打印 section 统计
console.table(ctx.sections.map(s => ({
  name: s.name,
  chars: s.chars,
  tokens: s.tokens,
})));

// 查看某 section 内容
console.log(ctx.sections.find(s => s.source === 'request_user_context')?.content);

// 测试 context 大小
expect(ctx.totalTokens).toBeLessThan(100000);
```

---

## 五、待实现的 Port

以下 Port 已在 contracts 中定义，但需要 adapter 层实现：

| Port | 用途 | 状态 |
|------|------|------|
| `SessionEventStorePort` | Session 事件持久化 | 待实现 |
| `EventReducerPort` | 事件到投影的转换 | 已实现 (EventReducer) |
| `SessionManagerPort` | Session 生命周期管理 | 待实现 |

---

## 五、接口成熟度

| 接口 | 成熟度 | 说明 |
|------|--------|------|
| `SessionEvent` / `SessionEventType` | L2 | 已实现，有测试 |
| `SessionEventStorePort` | L1 | 接口已定义，待实现 |
| `EventReducer` | L2 | 已实现，有测试 |
| `TurnState` / `TurnPhase` | L2 | 已实现，有测试 |
| `TurnMachine` | L2 | 已实现，有测试 |
| `ToolScheduler` | L2 | 已实现，有测试 |
| `PermissionService` | L2 | 已实现，待集成测试 |
| `AgentRuntime` | L1 | 骨架实现，待完整实现 |
| `CoreError` | L2 | 已实现 |
| `ModelRef` | L1 | 已定义，待扩展 |
