# TodoRead / TodoWrite Tool 设计

## 目标

Todo 工具把长任务计划变成 session 级一等状态，而不是只靠 assistant 文本里的 markdown 列表。它服务三个生产化目标：

- 长任务可继续：resume 后仍能读取当前任务列表。
- 进度可观察：TUI、ZCode app-server、日志和后续 session projection 可以从同一个状态源渲染计划。
- 模型可约束：同一时间最多一个 `in_progress`，避免并行叙述和真实执行脱节。

## Tool 划分

### TodoRead

读取当前 session 的 todo 列表。

输入：

```ts
{}
```

输出：

```ts
{
  todos: TodoItem[];
}
```

权限与副作用：

- `readOnly: true`
- `sideEffectScope: "none"`
- `riskLevel: "low"`
- 不需要审批。

### TodoWrite

用完整列表替换当前 session 的 todo 状态。模型应每次提交完整列表，而不是增量 patch。

输入：

```ts
{
  todos: TodoItem[];
}
```

输出：

```ts
{
  oldTodos: TodoItem[];
  todos: TodoItem[];
  summary: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
  };
}
```

权限与副作用：

- `readOnly: true`：不触碰 workspace、git、network 或 system，只更新 session state。
- `sideEffectScope: "session"`
- `riskLevel: "low"`
- 不需要审批。
- 不并发安全：同一 session 内后写覆盖前写。

## TodoItem schema

```ts
type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
};
```

字段取舍：

- `content` + `status` 是计划条目的最小字段。
- `priority` 与 ZCode v2 `session-persistence.md` 的 session `todo` 表一致。
- 暂不引入进行中展示文案字段（`activeForm`），避免第一版存储 schema 和模型 schema 分叉；后续 UI 需要进行中展示文案时再作为 L2 扩展字段加入。

## 校验规则

- `content` 必须是非空字符串。
- `status` 必须是 `pending`、`in_progress` 或 `completed`。
- `priority` 必须是 `high`、`medium` 或 `low`。
- 同一列表最多一个 `in_progress`。
- 空列表合法，表示清空 session todo 状态。

## 存储契约

Todo 状态落在 `SessionStorePort`，由 storage adapter 实现，不由 tool handler 直接访问数据库或文件系统。

候选 port：

```ts
readTodos({ sessionID }): Promise<TodoItem[]>
updateTodos({ sessionID, todos }): Promise<void>
```

SQLite adapter 继续使用 `session-persistence.md` 已定义的 `todo` 表。`TodoWrite` 使用事务先删除该 session 的旧 todo，再按列表位置写入新 todo，保证读取顺序稳定。

## 失败路径

- 未配置 `SessionStorePort`：`configuration_error`。
- storage 写入失败：向上冒泡为 storage/configuration 相关错误，executor 记录 tool error event。
- schema 校验失败：executor 返回结构化 tool error，不更新 session 状态。

## L2 落地范围

### 实现核对（2026-05-08）

本轮核对确认 Todo 工具链已经从最小契约推进到完整 projection 闭环，后续不要再把这些能力当作纯计划项重复实现：

- contracts 已在 `packages/contracts/src/tools/todo.ts` 落地 Zod runtime schema、由统一 helper 派生的 JSON Schema、`todoItemsFromToolResultContent()` 和 `formatTodoStateForModel()`。
- core 已在 `packages/core/src/tool/handlers/todo.ts` 落地 `TodoRead` / `TodoWrite` tool entry、session store port 调用、重复 `in_progress` 校验和公共 tool contract 声明。
- storage adapter 已在 `packages/adapters/src/storage/session-store.ts` 落地 SQLite todo 替换写入和稳定顺序读取。
- TUI 已按 `docs/design/v2/tui-todo-display.md` 从 `ToolCallResult` runtime event 投影 todo panel；TUI 不直接读 session store。
- ZCode app-server 已在 bootstrap 层把成功的 `TodoRead` / `TodoWrite` 结果投影为结构化 `sessionUpdate: "plan"`，并在 `resumeSession` 和普通 `prompt` 前重放 persisted todo plan。
- resume 已从 `SessionStorePort.readTodos()` 读取 todo，注入不落库的 `<system-reminder>`，并在 `SessionResumed` payload 中携带 `resumedTodoCount`。
- manual、auto 和 reactive compact 共用 `compactActiveConversation()`，在持久化 summary 前读取当前 todo 并把非空 todo 状态追加到 summary body。

对应测试覆盖：`packages/core/tests/todo-tool.test.ts`、`packages/adapters/tests/session-store.test.ts`、`packages/core/tests/runtime-tool-loop.test.ts`、`packages/core/tests/runtime-compact.test.ts`、`packages/tui/tests/tui.unit.test.ts`、`packages/bootstrap/tests/zcode-protocol.test.ts` 和 `packages/core/tests/tool-contracts.test.ts`。

第一版已实现：

- contracts: runtime schema、JSON schema、output 类型、session store todo port。
- core: `TodoRead` / `TodoWrite` tool entry、schema 校验、session store 调用。
- adapters: SQLite todo read/write。
- tests: storage 持久化、tool handler 成功路径、重复 `in_progress` 失败路径、tool contract projection。

TUI 投影：

- `docs/design/v2/tui-todo-display.md` 定义 TUI 如何从 `TodoRead` / `TodoWrite` 的 `tool_call_result` 事件投影当前 todo。
- TUI 不直接读取 session store；它只消费 runtime event 中已序列化的 `{ todos }` 输出。
- 第一版把 todo panel 放在普通 input 下方，并保持高度有界。

ZCode app-server 投影：

- ZCode protocol client 的 `plan` 更新只接受结构化 `entries`，不能依赖通用 `tool_call_update.rawOutput` 自行解析 `TodoRead` / `TodoWrite` 的 JSON 字符串。
- bootstrap 层记录 `toolCallId -> toolName`，在成功的 `TodoRead` / `TodoWrite` tool result 后解析序列化输出，并额外发送完整的 `sessionUpdate: "plan"`：

```ts
{
  sessionUpdate: "plan";
  entries: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
  }>;
}
```

- `tool_call_update` 仍正常发送，便于日志和通用 tool UI 保持完整；`plan` 是给 ZCode app-server todo/plan UI 的专用投影。
- 如果 tool result 被截断、JSON 非法或 schema 不匹配，则不发送 `plan`，避免把不完整状态投影为权威计划。
- `loadSession` / `resumeSession` 成功恢复 session 后，如果 session store 内已有 todo，也发送一次 persisted `plan`，让 ZCode protocol client 在没有新 tool call 的情况下恢复计划面板。
- 普通 `prompt` 开始执行前也会重新发送 persisted `plan`。ZCode protocol client 会在用户继续提问时先清空上一轮 plan UI，因此 agent 必须主动重放当前 session todo，避免第二条消息没有触发 TodoRead/TodoWrite 时面板消失。

模型上下文恢复：

- `resumeFromStore` 从 `SessionStorePort.readTodos` 读取当前 todo，并注入一个不落库的 `<system-reminder>` 用户消息。
- 注入内容使用 `Current session todo state (authoritative):` 作为机器可识别标题，逐项包含 `[status][priority] content`，提醒模型除非后续 `TodoRead` / `TodoWrite` 更新，否则把它当作权威短期计划。
- `SessionResumed` 事件携带 `resumedTodoCount`，用于日志和 UI 观察。
- todo 读取失败时记录 `todo.context.read.failed`，resume 本身继续执行。

Compact：

- 手动、自动和 reactive compact 在持久化 summary 前读取当前 todo。
- 非空 todo 会追加到 compact summary body，保证压缩后重新 resume 或继续对话时不会丢失计划状态。
- 没有 session store、todo 为空或读取失败时保持原 summary 不变。
