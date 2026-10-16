# Agent Loop 设计

## 文档定位

本文档定义 ZCode CLI 的核心 agent loop 设计，作为 `architecture.md` 的子模块设计。Agent loop 是整个系统的核心引擎，其他模块（tool、provider、permission 等）都是为其服务的组件。

---

## 一、设计基础

### 1.1 核心循环

**核心循环**：`Gather → Act → Verify`

```
用户输入 → 模型评估 → Tool Calls 或最终响应 → 执行工具 → 结果反馈 → 重复
```

**权限模式**：
- `default` - 未覆盖的工具触发审批
- `acceptEdits` - 自动批准文件编辑
- `plan` - 只产生计划，不执行
- `dontAsk` - 不提示，只用规则
- `yolo` - 跳过 permission prompt，直接执行
- `auto` - 保留，暂不实现

**Hook 系统**：
- `PreToolUse` / `PostToolUse` / `PostToolUseFailure`
- `UserPromptSubmit`, `Stop`, `SubagentStart/Stop`
- `PreCompact`, `PermissionRequest`, `SessionStart/End`

---

### 1.2 设计模式

| 模式 | 描述 |
|------|------|
| **事件驱动 Loop** | 状态变化通过事件记录，loop 由事件推进 |
| **Session/Turn 层次** | Session 包含多个 Turn，每个 Turn 是完整请求-响应 |
| **Tool Contract 声明** | 工具必须声明 schema、权限、副作用、超时等 |
| **Permission 独立** | 权限检查与执行分离，不混入业务逻辑 |
| **Event Sourcing** | append-only event store，支持恢复和重放 |
| **Port/Adapter 分离** | core 不依赖具体实现 |

---

## 二、ZCode Agent Loop 设计

### 2.1 核心循环

ZCode 采用 **Event-first Agent Loop**：

```
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Loop                                   │
│                                                                   │
│  ┌─────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │  Turn   │───>│ Event        │───>│ State Transition      │  │
│  │  Input  │    │ Creation     │    │ (Reducer)             │  │
│  └─────────┘    └──────────────┘    └───────────────────────┘  │
│                                              │                   │
│                                              ▼                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                     Projection                              ││
│  │  ConversationView | ToolCallView | PendingPermissionView  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                              │                   │
│                                              ▼                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │   Provider   │    │    Tool      │    │  Permission  │    │
│  │   (LLM Call) │    │   Runtime    │    │    Service   │    │
│  └──────────────┘    └──────────────┘    └──────────────┘    │
│                                              │                   │
│                                              ▼                   │
│                                     ┌──────────────┐             │
│                                     │ Event Emit   │             │
│                                     └──────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Turn 生命周期

一个 Turn 包含以下阶段：

```
Turn Input
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Input Processing                                    │
│ - 解析用户输入                                               │
│ - 应用 permission mode                                       │
│ - 注入 context (memory, system prompt)                       │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Model Request                                       │
│ - 构建 prompt (system + context + history + input)           │
│ - 调用 ProviderAdapter                                        │
│ - 处理 streaming 事件                                        │
│ - 记录 model_request 事件                                    │
└─────────────────────────────────────────────────────────────┘
    │
    ├──▶ 如果有 Tool Calls
    │       │
    │       ▼
    │   ┌─────────────────────────────────────────────────────┐│
    │   │ Phase 3a: Tool Scheduling                           ││
    │   │ - 按依赖关系排序 (read-only 并行, write 串行)       ││
    │   │ - 权限预检查                                        ││
    │   │ - 注册 pending permission                           ││
    │   └─────────────────────────────────────────────────────┘│
    │       │
    │       ▼
    │   ┌─────────────────────────────────────────────────────┐│
    │   │ Phase 3b: Tool Execution                            ││
    │   │ - 执行工具                                          ││
    │   │ - 捕获结果或错误                                    ││
    │   │ - 发射 tool_result 事件                             ││
    │   └─────────────────────────────────────────────────────┘│
    │       │
    │       ▼
    │   ┌─────────────────────────────────────────────────────┐│
    │   │ Phase 3c: Result Aggregation                        ││
    │   │ - 汇总所有工具结果                                   ││
    │   │ - 准备下一轮 model request                          ││
    │   └─────────────────────────────────────────────────────┘│
    │       │
    │       └──▶ 回到 Phase 2 (继续调用模型)
    │
    └──▶ 如果是最终响应
            │
            ▼
        ┌─────────────────────────────────────────────────────┐
        │ Phase 4: Turn Completion                             │
        │ - 发射 turn_complete 事件                           │
        │ - 更新 projection                                   │
        │ - 检查是否需要 compact                               │
        └─────────────────────────────────────────────────────┘
```

### 2.3 状态模型

#### 2.3.1 SessionState

```typescript
interface SessionState {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  status: SessionStatus;

  // 事件相关
  eventLog: SessionEvent[];
  turnCount: number;
  totalTokenCount: number;

  // Context 管理
  contextWindow: number;
  contextUsed: number;
  compactBoundaries: CompactBoundary[];

  // 并发
  pendingPermissions: PendingPermission[];
  activeToolCalls: ToolCall[];
}
```

#### 2.3.2 TurnState

```typescript
interface TurnState {
  id: TurnId;
  sessionId: SessionId;
  turnNumber: number;

  // Phase
  phase: TurnPhase;

  // Model 相关
  modelRequest?: ModelRequest;
  modelResponse?: ModelResponse;
  streamingParts: StreamingPart[];

  // Tool 相关
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  toolSchedule: ToolSchedule;

  // Permission 相关
  pendingPermissions: PermissionRequest[];
  resolvedPermissions: PermissionResult[];

  // 结果
  finalResponse?: string;
  error?: TurnError;
  resultType: TurnResultType;
}
```

#### 2.3.3 TurnPhase 枚举

```typescript
enum TurnPhase {
  Idle = 'idle',                    // 等待输入
  ProcessingInput = 'processing_input',
  AwaitingModelResponse = 'awaiting_model_response',
  Streaming = 'streaming',
  SchedulingTools = 'scheduling_tools',
  ExecutingTools = 'executing_tools',
  AggregatingResults = 'aggregating_results',
  AwaitingPermission = 'awaiting_permission',
  Completing = 'completing',
  Error = 'error',
}
```

---

## 三、Event 设计

### 3.1 Event 分类

| 类别 | Event | 描述 |
|------|-------|------|
| **Session** | `session_created`, `session_resumed`, `session_forked`, `session_compacted` | Session 生命周期 |
| **Turn** | `turn_started`, `turn_input_received`, `turn_complete`, `turn_error` | Turn 生命周期 |
| **Message** | `user_message`, `assistant_message`, `system_message` | 消息 |
| **Model** | `model_request`, `model_streaming`, `model_complete`, `model_error` | 模型调用 |
| **Tool** | `tool_call_scheduled`, `tool_call_started`, `tool_call_result`, `tool_call_error`, `tool_batch_complete` | 工具执行 |
| **Permission** | `permission_requested`, `permission_resolved`, `permission_denied` | 权限 |
| **State** | `compact_boundary`, `rewind_triggered`, `checkpoint_created` | 状态管理 |
| **Subagent** | `subagent_spawned`, `subagent_message`, `subagent_stopped` | 子 Agent |
| **System** | `interrupt`, `cancel`, `resume`, `error` | 系统事件 |

### 3.2 Event 结构

```typescript
// 基础 Event
interface SessionEvent {
  id: EventId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: SessionEventType;
  timestamp: Date;
  traceId: TraceId;
  sequenceNumber: number;
  payload: EventPayload;
  metadata?: EventMetadata;
}

// Tool Call Event 示例
interface ToolCallScheduledEvent extends SessionEvent {
  type: 'tool_call_scheduled';
  payload: {
    toolCallId: ToolCallId;
    toolName: string;
    input: unknown;
    dependencies: ToolCallId[];
    parallelGroupIndex: number;
    canRunParallel: boolean;
    schedule: {
      parallelGroups: ToolCallId[][];
      executionOrder: ToolCallId[];
    };
  };
}

interface ToolCallResultEvent extends SessionEvent {
  type: 'tool_call_result';
  payload: {
    toolCallId: ToolCallId;
    result: ToolResult;
    duration: number;
    outputSize: number;
  };
}
```

### 3.3 Event 约束

1. **不可变性**：Event 一旦创建不可修改
2. **可重放**：Event store 支持从任意 point 重放
3. **有序性**：sequenceNumber 保证顺序
4. **可传播**：包含 traceId 支持分布式追踪
5. **版本化**：Event schema 支持演进

---

## 四、Projection 设计

### 4.1 Projection 类型

| Projection | 用途 | 更新时机 |
|------------|------|----------|
| `SessionProjection` | Session 整体状态 | 任何 session 事件 |
| `ConversationView` | 对话历史（用于 prompt 构建） | message 事件 |
| `ToolCallView` | 工具调用状态 | tool 事件 |
| `PendingPermissionView` | 待审批权限 | permission 事件 |
| `ContextBudgetView` | Token 预算 | model 事件 |

### 4.2 Projection 更新

```typescript
// EventReducer
function reduce(state: SessionProjection, event: SessionEvent): SessionProjection {
  switch (event.type) {
    case 'turn_started':
      return { ...state, currentTurn: createTurnProjection(event.payload) };

    case 'tool_call_result':
      return updateToolCallView(state, event.payload);

    case 'permission_resolved':
      return updatePendingPermissionView(state, event.payload);

    case 'compact_boundary':
      return applyCompactBoundary(state, event.payload);

    default:
      return state;
  }
}
```

### 4.3 Prompt 构建

```typescript
// ConversationView 用于构建 model prompt
interface ConversationView {
  messages: Message[];
  systemPrompt: string;
  compactBoundaries: CompactBoundary[];
  contextBudget: ContextBudget;

  // 构建方法
  toModelMessages(): ModelMessage[];
  estimateTokenCount(): number;
  shouldCompact(): boolean;
}
```

---

## 五、Tool 调度

### 5.1 调度策略

```typescript
interface ToolSchedule {
  items: ToolScheduleItem[];
  parallelGroups: ToolCallId[][];  // 可以并行的组
  executionOrder: ToolCallId[];   // 最终执行顺序
}

interface ToolScheduleItem {
  toolCallId: ToolCallId;
  toolName: string;
  dependencies: ToolCallId[];
  canRunParallel: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  sideEffectScope?: ToolSideEffectScope;
  estimatedDuration?: number;
}
```

### 5.2 调度规则

1. **Read-only / concurrentSafe 工具可以并行**：`Read`, `Glob`, `Grep`、`WebSearch`，以及 metadata 明确声明 `concurrentSafe: true` 的工具；只有 `WebSearch` handler 内部的 provider-native `web_search` side request 不进入本地 tool 调度
2. **Write / destructive / 非 concurrentSafe 工具必须串行**：例如 `Write`, `Edit`, `Bash`
3. **依赖必须先执行**：如果 Tool B 依赖 Tool A 的结果，B 必须在 A 之后
4. **Pending Permission 阻塞**：如果有未批准的权限请求，阻塞相关工具
5. **调度必须被消费**：runtime 必须调用 `executor.executeSchedule(toolCalls, schedule, { signal })`，不能忽略 schedule 后用全量 `executeBatch`

### 5.3 调度算法

```typescript
function scheduleTools(toolCalls: ToolCall[]): ToolSchedule {
  // 1. 拓扑排序
  const sorted = topologicalSort(toolCalls, getDependencies);

  // 2. 分组：同一依赖层内只把 read-only/concurrentSafe 工具放入并行组；
  //    有副作用或未声明并发安全的工具独立成组。
  const groups = groupByParallelSafety(sorted);

  // 3. 验证无循环依赖
  validateNoCycles(groups);

  return {
    items: sorted,
    parallelGroups: groups,
    executionOrder: flatten(groups),
  };
}
```

---

## 六、Permission 集成

### 6.1 Permission 流程

```
Tool Call 请求
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ PermissionService.check(toolCall)                           │
│                                                               │
│ 1. 检查 permission mode (plan/build/yolo/auto)              │
│ 2. 检查 allowed_tools / disallowed_tools                   │
│ 3. 检查 risk level                                         │
│ 4. 如果需要询问，emit permission_requested 事件              │
│ 5. 等待用户响应或自动决策                                    │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 决策结果                                                     │
│                                                               │
│ - allow: 继续执行                                           │
│ - deny: 发射 tool_call_error，返回拒绝信息                   │
│ - escalate: 触发更高层级审批                                │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Permission Mode

```typescript
enum CollaborationMode {
  Plan = 'plan',      // 只读，产生计划
  Build = 'build',    // 正常执行
  Yolo = 'yolo',      // 跳过 permission prompt
  Auto = 'auto',      // 保留，暂不实现
}
```

### 6.3 Permission Event

```typescript
interface PermissionRequestedEvent extends SessionEvent {
  type: 'permission_requested';
  payload: {
    toolCallId: ToolCallId;
    toolName: string;
    riskLevel: RiskLevel;
    reason: string;
    input: unknown;
  };
}

interface PermissionResolvedEvent extends SessionEvent {
  type: 'permission_resolved';
  payload: {
    toolCallId: ToolCallId;
    decision: PermissionDecision;
    reason?: string;
    userModifiedInput?: unknown;
  };
}
```

---

## 七、Context 管理

### 7.1 Context Budget

```typescript
interface ContextBudget {
  maxTokens: number;
  usedTokens: number;
  reservedTokens: number;  // system prompt, tool definitions 等固定开销

  // 各部分预算
  systemPromptBudget: number;
  conversationBudget: number;
  toolResultBudget: number;
  memoryBudget: number;
}
```

### 7.2 Compact 触发条件

```typescript
interface CompactTrigger {
  condition: 'token_threshold' | 'turn_count' | 'manual';
  threshold: number;  // 如 0.85 (85%)
  priority: CompactPriority;
}
```

### 7.3 Compact 流程

```
触发条件满足
    │
    ▼
emit PreCompact Event
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 构建 Compact Boundary                                       │
│                                                               │
│ - 识别需要保留的消息                                         │
│ - 生成摘要                                                   │
│ - 标记 compact 范围                                          │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
emit CompactBoundary Event (不可变)
    │
    ▼
重建 ConversationView
    │
    ▼
emit SessionCompacted Event
```

---

## 八、Error 处理

### 8.1 Error 类型

```typescript
enum TurnErrorType {
  ModelError = 'model_error',
  ToolError = 'tool_error',
  PermissionDenied = 'permission_denied',
  ContextExceeded = 'context_exceeded',
  Timeout = 'timeout',
  Canceled = 'canceled',
  Unknown = 'unknown',
}

interface TurnError {
  type: TurnErrorType;
  message: string;
  cause?: Error;
  recoverable: boolean;
  retryable: boolean;
}
```

### 8.2 Error 处理策略

| Error 类型 | 策略 |
|------------|------|
| `ModelError` | 重试 N 次，指数退避 |
| `ToolError` | 检查是否可重试，可能跳过或降级 |
| `PermissionDenied` | 返回拒绝信息给用户 |
| `ContextExceeded` | 触发 compact 或结束 session |
| `Timeout` | 取消操作，尝试恢复 |
| `Canceled` | 清理状态，优雅退出 turn |

---

## 九、候选命名

| 概念 | 候选名称 | 状态 |
|------|----------|------|
| Agent Runtime | `AgentRuntime`, `AgentEngine`, `TurnCoordinator` | L1 |
| Turn State | `TurnState`, `TurnContext`, `TurnRecord` | L1 |
| Event Reducer | `EventReducer`, `StateReducer`, `ProjectionUpdater` | L1 |
| Conversation View | `ConversationView`, `PromptBuilder`, `MessageHistory` | L1 |
| Tool Scheduler | `ToolScheduler`, `ToolCoordinator`, `ExecutionPlanner` | L1 |
| Permission Service | `PermissionService`, `ApprovalService`, `AccessController` | L1 |

---

## 十、与其他模块的关系

```
Agent Loop (本文档)
    │
    ├──▶ ToolSystem
    │       ├── ToolRegistry
    │       ├── ToolRuntime
    │       └── ToolContract (见 ToolContract RFC)
    │
    ├──▶ Provider
    │       ├── ProviderAdapter
    │       └── ProviderCapabilities (见 ProviderCapability RFC)
    │
    ├──▶ PermissionService
    │       └── Permission/Mode/Risk Policy
    │
    ├──▶ Storage (EventStore)
    │       └── SessionEventStore, ProjectionStorage
    │
    ├──▶ MemoryPipeline
    │       └── 跨 session 知识提取
    │
    └──▶ SubagentRuntime
            └── Mailbox, InterAgentMessage
```

---

## 十一、待细化

- [ ] Tool Scheduler 的具体算法实现
- [ ] Permission Risk Level 的具体分类
- [ ] Context Budget 的具体分配策略
- [ ] Compact Boundary 的具体 schema
- [ ] Error Recovery 的具体重试策略
- [ ] Hook System 与 Loop 的集成点

---

## 十二、参考来源

- [Model Context Protocol](https://modelcontextprotocol.io)
