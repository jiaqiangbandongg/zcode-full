# Core 实现计划

## 目标

实现 Agent Loop 的最小可用核心：Turn 状态机 + Event 驱动的状态转换。

## 最小 CLI 入口

在 TUI 和交互式输入完成之前，CLI 先提供 `zcode --prompt "<text>"` 作为最薄的 headless 入口。

调用链固定为：

```text
packages/cli
  -> packages/bootstrap
  -> AgentRuntime.executeTurn()
```

`executeTurn()` 属于 `core` 的 application/runtime 层：它是一次用户 turn 的业务编排入口，负责推进 session event、turn state、context builder、model request 和 tool loop。CLI/TUI/SDK 不直接拼接上下文、不执行 tool，也不直接调用 provider；它们只把用户输入交给 bootstrap 装配出来的 runtime。

当前 `--prompt` 入口只要求跑通最小链路：创建 session、追加 turn event、调用 `executeTurn()`、输出 turn result。后续 context builder、model adapter 和 tool executor 接入后，保持同一入口不变。

## 里程碑

### M1: 基础数据结构

**目标**：定义 TurnState、SessionState、TurnPhase 等核心类型

**产出**：
```
packages/contracts/src/
├── interfaces/
│   └── session.port.ts      # SessionEventStorePort, EventReducerPort
├── events/
│   └── session.events.ts    # SessionEvent 类型
├── errors/
│   └── index.ts            # CoreError 类型
```

**测试**：类型检查 + 快照测试

---

### M2: Event 和 EventReducer

**目标**：实现 append-only event log 和 projection 更新

**产出**：
```
packages/contracts/src/events/
├── session.events.ts        # 完整 Event 类型
├── event-reducer.ts        # EventReducer 实现
```

**测试**：
- EventReducer 单测：给定事件序列，验证 projection 正确性
- Event 不可变测试：验证修改事件抛出错误

---

### M3: Turn 状态机

**目标**：实现 TurnPhase 状态转移逻辑

**产出**：
```
packages/core/src/
├── agent/
│   ├── turn-state.ts       # TurnState, TurnPhase
│   ├── turn-machine.ts      # 状态转移
│   └── index.ts
├── session/
│   ├── session-state.ts    # SessionState
│   └── session.ts          # Session 管理
```

**测试**：
- TurnMachine 单测：验证所有合法/非法状态转移
- Session 创建/恢复测试

---

### M4: Tool Scheduler

**目标**：实现基于依赖的 Tool 调度

**产出**：
```
packages/core/src/tool/
├── scheduler.ts            # ToolScheduler
├── types.ts               # ToolSchedule, ToolScheduleItem
```

**测试**：
- 拓扑排序测试
- 并行分组测试
- 循环依赖检测

---

### M5: Agent Runtime 骨架

**目标**：整合所有组件，实现最小 AgentRuntime

**产出**：
```
packages/core/src/
├── agent/
│   ├── runtime.ts          # AgentRuntime
│   └── index.ts
├── permission/
│   └── service.ts          # PermissionService (骨架)
```

**测试**：
- 模拟 Turn 流程：输入 → 状态转移 → 事件生成
- Hook 点测试

---

## 测试策略

### 测试层次

```
┌─────────────────────────────────────────────────────────────┐
│                    集成测试                                  │
│  AgentRuntime 端到端：模拟完整 Turn 流程                       │
│  Mock: ProviderAdapter, ToolRuntime, Storage                 │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    单元测试                                  │
│  EventReducer / TurnMachine / ToolScheduler                 │
│  无外部依赖，纯函数逻辑                                      │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    类型测试                                  │
│  TypeScript 类型正确性                                        │
│  tsd 或 type 快照                                           │
└─────────────────────────────────────────────────────────────┘
```

### Mock 策略

```typescript
// 所有 contracts 中定义的 port 用 Mock 替代
class MockSessionEventStore implements SessionEventStorePort {
  events: SessionEvent[] = [];

  append(event: SessionEvent): Promise<void> {
    this.events.push(event);
  }

  getEvents(sessionId: SessionId): Promise<SessionEvent[]> {
    return this.events.filter(e => e.sessionId === sessionId);
  }

  rebuildProjection(sessionId: SessionId): Promise<SessionProjection> {
    return this.events
      .filter(e => e.sessionId === sessionId)
      .reduce(reduce, initialProjection);
  }
}
```

### 测试框架

- **Vitest**：单测 + 集成测
- **tsd**：类型测试
- **自定义 Mock**：简单直接

---

## 实现顺序

```
Week 1: M1 + M2 (数据类型 + EventReducer)
         ↓
Week 2: M3 (Turn 状态机)
         ↓
Week 3: M4 (Tool Scheduler)
         ↓
Week 4: M5 (Agent Runtime 整合)
```

---

## 验证标准

每个 milestone 完成后：

1. `pnpm typecheck` 通过
2. `pnpm test` 通过（0 失败）
3. 关键路径有单测覆盖
4. 代码可读，可向他人解释

---

## 依赖

- `@zcode/contracts` - 必须先完成 M1
- 测试框架 - vitest（需添加到 workspace）
- 无外部 I/O 依赖

---

## 待定

- [ ] 是否需要 @zcode/contracts 作为独立包，或直接在 core 内定义
- [ ] ToolScheduler 的依赖检测算法细节
- [ ] AgentRuntime 的 public API 设计
