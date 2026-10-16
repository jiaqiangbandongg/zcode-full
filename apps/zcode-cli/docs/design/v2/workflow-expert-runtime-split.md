# Expert Workflow Runtime Split

## 目的

`packages/core/src/workflow/expert.ts` 是 expert workflow 的公共入口，但不能继续承载所有职责。
本次拆分只调整内部模块边界，不改变 workflow 行为、store contract、事件 payload、graph record
形态、artifact 路径或 public export。

## 边界

- `expert.ts` 保留兼容 facade，继续导出 `ExpertWorkflowRuntime`、`WorkflowRuntime`、
  `formatExpertWorkflowStatus`、`DEFAULT_EXPERT_WORKFLOW_STRATEGY` 和
  `createExpertWorkflowDefinition`。
- Runtime public API 只负责命令入口和运行态 orchestration，不直接解析模型 JSON。
- Parser 只把模型文本归一化为 workflow contract 数据，不写 store、不发事件、不修改 snapshot。
- Prompt/formatter/report builder 只生成文本，不读取 adapter，也不写 artifact。
- Snapshot helper 只做不可变状态变换；store 写入和 graph record/event 发射集中在 runtime service。
- Phase runner 只负责普通 agent phase 的状态、artifact 和 session link。
- Scheduled phase bridge 只负责把 `WorkflowGraphScheduler` 接到 agent runner/store，不能修改 scheduler contract。
- Critic loop 只负责 final critic verdict、node reopen 和 rerun 决策，不直接解析 loose JSON。
- 所有异步执行必须继续传播 `AbortSignal` 和 `TraceContext`。

## 不变式

- Built-in expert workflow phase 顺序、默认 strategy、artifact 默认路径不变。
- `sessionLinks` 仍由 `deriveWorkflowSessionLinks` 从 activities 派生。
- `graph_seeded`、`node_prompts_updated`、`reopen_node`、`update_status` 等 graph record
  payload 与旧版本保持兼容。
- `run_started`、`phase_started`、`workflow_session_linked`、`artifact_written`、
  `phase_completed`、`critic_*`、`run_completed`、`workflow_paused` 等 workflow event 保持原语义。
- `startBackground` 仍返回 backgrounded run snapshot，并用内部 abort registry 管理后续取消。
- parser 必须保留 legacy/loose 字段兼容，例如 `node_name`、`reopen_proposals`、
  `collection_node_ids`、`nodePrompts`、fenced JSON。

## 验证

- `pnpm --filter @zcode/core test -- tests/expert-workflow.test.ts tests/workflow-lifecycle.test.ts`
- `pnpm --filter @zcode/core typecheck`
- `npm run lint:count`
- `npm run lint`
- `npm test`
