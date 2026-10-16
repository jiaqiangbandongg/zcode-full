# System Reminder Source/Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not move from one phase to the next without user confirmation after tests and code review. Do not create a commit unless the user explicitly asks after review.

**目标：** 在不实现 user-message `content[]` merge / provider projection 的前提下，梳理并确定 ZCode CLI provider-visible `<system-reminder>` 的来源、生命周期、文案语义、delivery channel 和测试证据。

**核心边界：** 这是 system-reminder source/content 计划，不是 user message 结构调整计划。实现过程中可以新增 source helper、formatter、descriptor 和 source-level tests，但不能把多条 user message 合并成同一条 `content[]`，不能改变 session store / UI transcript 结构，也不能实现 attachment bubble-up、cache-control finalization 或 provider request projection。

**Tech Stack：** TypeScript, Vitest, `@zcode/core`, `@zcode/contracts`, `@zcode/adapters`, prompt-trajectory.

**Phase completion gate:** 每个 phase / round 结束前必须跑 prompt-trajectory e2e，并检查输出目录里的 `trajectory.jsonl` 与派生 `*.openai_request_body.json`。该 e2e 必须包含覆盖当轮改动的 targeted testcase / fixture；只跑既有无关 testcase 不算验收。验收口径是最终 provider-visible messages 的内容、顺序、结构和 metadata stripping 符合本 phase 预期；不能只依赖 source diff、unit tests 或 runner 成功退出。因为 prompt-trajectory 读取 built `dist` artifacts，运行前需要先 build 相关 package（至少 `@zcode/core`）。如果某个动态行为当前无法被 prompt-trajectory 表达，必须在 phase 记录具体 runner 缺口，并用 focused tests 覆盖到位。

**当前状态：** Active system-reminder source/content 工作已完成。SR0-SR12 均已实现并完成 focused tests / prompt-trajectory evidence；剩余 ToolSearch/deferred tools、MCP instructions/resources、skill discovery、bubble-up、content merge、cache-control finalization 均保持独立或 postponed，不属于本 plan 未完成项。

---

## Scope

本 plan 负责：

- provider-visible system-reminder source taxonomy；
- source owner、delivery channel、lifecycle、meta/source provenance；
- ZCode 已有或明确 active feature 的 reminder 文案语义；
- `date_change` runtime-local 行为；
- Plan/target/Todo、hook、memory、skill listing、output style、tool-result warning、resume continuity、mid-turn system event 等 system-reminder source；
- attachment-origin system-reminder 内容盘点和 ZCode-supported 类型的文案补齐，但不做 attachment order / bubble-up；
- tests / prompt-trajectory evidence，证明 reminder 的存在、缺失、channel 边界和 provider JSON 不泄漏内部 descriptor。

本 plan 不负责：

- user-message `content[]` merge；
- provider request 前 projection / normalization；
- cache-control finalization；
- request-level `userContext` / instruction discovery；
- ToolSearch / deferred tools P-13；
- MCP instructions/resources P-14/P-15；
- skill discovery P-27；
- generalized attachment bubble-up / first-turn tail bubbling / attachment-before-prompt order P-16；
- task_reminder cadence：ZCode 当前没有对应 producer，不新增空壳；Todo reminder cadence 已在 SR5 active phase 实现，runtime_mode / plan mode content-cadence 在 SR9 完成；
- 为 ZCode 没有对应功能的 source 增加空壳 reminder。

## Reminder Source Constraints

`<system-reminder>` 不是一个全局字符串规则，而是由 source-specific producers 生成：

- request-level userContext 是独立 surface，本 plan 不处理；
- attachment normalization、queued command normalization、tool-result helpers、Todo/task/date sources 等会分别生成 reminder；
- synthetic/provider-visible context 在 runtime 内部带有 `isMeta` / source 语义，但最终 provider body 不携带这些内部字段；
- human queued input 即使文本长得像 `<system-reminder>`，也仍然是 user-authored content；
- provider order、consecutive user-message merge、attachment bubble-up 和 cache-control 都发生在 API/provider normalization boundary，本 plan 不实现这些结构性步骤。

对实现的约束：

- reminder source 必须在创建处显式声明，不从任意 user text 的 `<system-reminder>` prefix 反推；
- source helper 可以为后续 content merge plan 提供可消费的 descriptor，但本 plan 只使用它做 source ownership、文案和测试证据；
- 如果某个 source 后续被 user-message provider projection 消费，合并方向和 serialization 必须服从独立 provider projection plan：只允许 synthetic/meta 向前合入后续真实 user prompt；真实 prompt 后的 reminder 不能回填；单条 text message 不强制包成 `content[]`。
- provider-visible JSON 只能包含合法 provider fields，不能泄漏 descriptor / provenance / evidence metadata。

## Delivery Channel Taxonomy

| Channel | 含义 | 例子 |
| --- | --- | --- |
| `request_prefix` | session/request-wide context，位于 conversation 前，不属于当前用户 prompt | skill listing、generic context prefix、后续 request-level userContext |
| `current_turn` | 当前 request 生成或重发的动态 context | hook context、relevant memory、plan/auto mode、active goal/target、output_style、date_change、Todo reminder |
| `tool_result` | 附着在 tool result 输出中的 context | Read empty-file / short-read warnings |
| `history_continuity` | resume / compact 恢复出来的上下文 | restored todos、restored goal、post-compact continuity |
| `mid_turn_event` | tool loop / assistant turn 中途出现的 system-origin notification | background task status、diagnostics、system queued notification |
| `real_user` | 用户真实输入 | queued human input、用户 prompt 以 `<system-reminder>` 开头的 badcase |

## Source Descriptor Contract

Descriptor 是 core-local source contract，不是 provider payload。当前实现放在中性模块 `packages/core/src/system-reminder/source.ts`，避免 context/memory/tool 反向依赖 runtime helper；调用点应直接引用该中性模块，不再保留 runtime helper shim。

```ts
export type SystemReminderDeliveryChannel =
  | "request_prefix"
  | "current_turn"
  | "tool_result"
  | "history_continuity"
  | "mid_turn_event"
  | "real_user";

export type SystemReminderLifecycle =
  | "request_prefix"
  | "per_current_turn"
  | "runtime_local"
  | "tool_result"
  | "resume_history"
  | "mid_turn_event"
  | "real_user";

export type SystemReminderProviderVisibility =
  | "provider_visible"
  | "provider_hidden";

export type SystemReminderPrefixSource =
  | "context_prefix"
  | "skills_listing";

export type SystemReminderPersistedSource =
  | "todo_reminder"
  | "task_status"
  | "tool_result_warning"
  | "resume_todo_state"
  | "resume_goal_state"
  | "target_continuation"
  | "goal_completion_verification"
  | "rewind_notice"
  | "queued_system_notification";

export type SystemReminderPerRequestSource =
  | "hook_context"
  | "relevant_memory"
  | "runtime_mode"
  | "output_style"
  | "date_change"
  | "model_anomaly"
  | "prompt_attachment"
  | "diagnostics";

export type SystemReminderSource =
  | SystemReminderPrefixSource
  | SystemReminderPersistedSource
  | SystemReminderPerRequestSource;

export interface SystemReminderSourceDescriptor {
  source: SystemReminderSource;
  channel: SystemReminderDeliveryChannel;
  lifecycle: SystemReminderLifecycle;
  isMeta: boolean;
  providerVisibility: SystemReminderProviderVisibility;
  evidenceLabel: string;
}
```

Descriptor rules:

- `isMeta` / source ownership 只能来自 call site 或 source helper，不能来自字符串 prefix。
- `Prefix` bucket 表示 request/context prefix source；`Persisted` bucket 表示进入 conversation history、tool-result history 或 hydrate/replay 语义边界的 source，不等于全部都由 `persistSyntheticUserNoticeForSession(...)` 写入；`PerRequest` bucket 表示 request-time / turn-local source。
- `real_user` source 必须允许文本以 `<system-reminder>` 开头，但不能因此被当作 meta。
- `wrapSystemReminder(body: string | readonly string[])` 只负责 text wrapper；传入数组时内部用 `\n` join，传入 string 时保留现有 formatter 调用点；一次只生成一层 `<system-reminder>...</system-reminder>`。
- Provider serialization 前后都不能出现 descriptor fields。
- Source descriptor 本身不定义 `projectionPolicy`、`cachePolicy`、`mergeIntoCurrentTurn`、`cacheControl` 等 provider projection 语义。SR4 的 `MessageHistory` 内部 metadata 只保存 `source` identity，用于防止用户文本误判、hydrate/source 复原和 Todo cadence marker；未来 provider request merge 若需要 projection/cache 规则，应在 projector/helper 层基于 source catalog 决策，而不是把这些字段持久化到 message metadata。

## Phase SR0: Source Taxonomy + Wrapper Helper

**Phase goal:** 建立 system-reminder source taxonomy 和统一 wrapper helper，但不接入 provider projection。

**User confirmation gate:** Phase SR0 完成 tests + code review 后停止，等待用户确认。

### Task SR0.1: 新增 source helper

**Files:**
- Create: `apps/zcode-cli/packages/core/src/system-reminder/source.ts`
- Test: `apps/zcode-cli/packages/core/tests/system-reminder-source.test.ts`

- [x] 新增 `SystemReminderDeliveryChannel`、`SystemReminderLifecycle`、`SystemReminderSource`、`SystemReminderSourceDescriptor`。
- [x] 新增 `getSystemReminderDescriptor(source)` 或 source-specific descriptor helpers。
- [x] 新增 `wrapSystemReminder(body: string | readonly string[]): string`，输出 exactly one wrapper。
- [x] Tests 覆盖所有 active source 的 channel/lifecycle/isMeta/providerVisibility/evidenceLabel。
- [x] Tests 覆盖 nested wrapper 会被拒绝或 normalize 为单层 wrapper。
- [x] Tests 覆盖真实用户文本以 `<system-reminder>` 开头时不会被 helper 反推为 meta source。
- [x] Tests 覆盖 descriptor 不包含 provider projection/cache-control 字段。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/system-reminder-source.test.ts --run
pnpm --filter @zcode/core typecheck
```

## Phase SR1: Existing Reminder Source Inventory

**Phase goal:** 把 ZCode 现有 provider-visible system-reminder source 显式化，并保证文案语义不被重构破坏。

**User confirmation gate:** Phase SR1 完成 tests + code review 后停止，等待用户确认。

### Task SR1.1: Classify current-turn reminder sources

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/memory-recall.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-hooks.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-memory.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] Hook additional context 继续 provider-visible，使用 `hook_context` / `current_turn` descriptor。
- [x] Relevant memory 继续 provider-visible，使用 `relevant_memory` / `current_turn` descriptor；当前只完成 source/tag ownership，是否改为每条 memory 单独 message + 全文仍需单独决策。
- [x] Plan mode reminder 保留 ZCode 当前 read-only/plan-mode 语义，使用 `runtime_mode` / `current_turn` descriptor；本 task 只完成 source ownership，content/cadence 在 SR9 继续完善。
- [x] Auto mode 如果当前 ZCode 有真实 producer，则用 `runtime_mode` / `current_turn` descriptor；如果没有，记录 absent，不新增空壳。
- [x] Active goal/target request-time reminder 已按后续决策移除；不再保留 `runtime_target` source。`target_continuation` 自动续跑输入仍保留。
- [x] Output style reminder active 条件：只有当前 output style 非 default/非空时插入 `output_style` / `current_turn` system-reminder；default/空 style 不插入。Tail reminder 的 provider-visible content 在 SR9 继续完善，避免和 system prompt `output_style` section 重复暴露完整 style prompt。
- [x] 不改变这些 reminder 当前在 `messages` 中的 standalone / append 行为；只做 source ownership、formatter 和测试证据。

### Task SR1.2: Classify prefix/tool/history sources

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/context/sections/skills.ts`
- Modify: `apps/zcode-cli/packages/core/src/context/builder.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/read.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/target.ts`
- Test: `apps/zcode-cli/packages/core/tests/context-builder.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Test: relevant Read tool test file if present

- [x] Skill listing 保持 `request_prefix` / `skills_listing`，不合并到 current-turn；按新 skill 增量发送的 attachment 路径暂不实现。
- [x] Generic context meta-user system-reminder 保持 `request_prefix` / `context_prefix`，和 `skills_listing` 分开标注 source。
- [x] Read empty-file / short-read warning 保持 `tool_result` / `tool_result_warning`。
- [x] Resume restored todos 使用 `history_continuity` / `resume_todo_state`。
- [x] Resume restored goal 使用 `history_continuity` / `resume_goal_state`。
- [x] Target continuation prompt 作为独立 provider-visible source，使用 `target_continuation` wrapper；merge 后通过 `inputSource: "goal-continuation"` / `inputVisibility: "model-only"` 写入 session/protocol metadata，并在 runtime/persistence/hydrate 边界桥接为 `runtimeMessage.source: "target_continuation"`。Provider body 不携带 `source=` attribute。
- [x] Provider body 不泄漏 descriptor；tests 通过 formatter/helper 或 trace-side evidence 验证 source ownership。

### Task SR1.3: Classify ZCode-specific existing producers

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/model-anomaly.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/rewind.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/tools/target.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] Repeated tool call / tool call budget warnings 使用 `model_anomaly` source；channel 以实际插入路径为准，优先标成 `mid_turn_event`，若它是下一次 request 的 dynamic context 则标成 `current_turn`。
- [x] Conversation rewind、workspace rewind、workspace fork notice 使用 `rewind_notice` / `history_continuity` source。
- [x] Goal completion verification reminder 使用 `goal_completion_verification` / `tool_result` taxonomy，保持现有 provider-visible text semantics；formatter 位于 contracts/tool-result surface，失败反馈进入 GoalUpdate tool result，verifier auxiliary request 由 `querySource: target_completion_verification` 标记，不进入 `MessageHistory` runtime metadata。若未来要统一 source/evidence metadata，应单独设计 tool-result metadata envelope。
- [x] 这些 ZCode-specific sources 按自身语义归类；目标是避免 source taxonomy 漏掉现有 provider-visible reminder producer。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/system-reminder-source.test.ts tests/runtime-hooks.test.ts tests/runtime-memory.test.ts tests/runtime-trace.test.ts tests/context-builder.test.ts tests/runtime-tool-loop.test.ts --run
pnpm --filter @zcode/core typecheck
```

## Phase SR2: Runtime-Local Date Change

**Phase goal:** 按 runtime-local 语义补齐 `date_change` system-reminder，不刷新 request-level current date prefix。

**User confirmation gate:** Phase SR2 完成 tests + code review 后停止，等待用户确认。

### Task SR2.1: 共享 local `YYYY-MM-DD` helper

**Files:**
- Create: `apps/zcode-cli/packages/contracts/src/time/local-date.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/index.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/context/index.ts`
- Test: `apps/zcode-cli/packages/contracts/tests/local-date.test.ts`

- [x] 抽出 shared local date formatter，返回本地 `YYYY-MM-DD`。
- [x] Context source adapter 的 `currentDate` 使用同一 helper。
- [x] Tests 覆盖 local date formatting，不引入 UTC-only path。

### Task SR2.2: Add `date_change` reminder source

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`

- [x] Runtime 内维护 `lastEmittedLocalDate` 或等价 state。
- [x] Fresh runtime first turn：记录当前 local date，不发送 reminder。
- [x] Resume first turn：记录当前 local date，不发送 reminder。
- [x] Same runtime 跨本地日期：发送一次 `date_change` / `current_turn` system-reminder。
- [x] `/clear` / equivalent reset 如当前 ZCode 有对应 runtime reset path，则重置 date-change state；没有则记录为 absent。当前未发现独立 `/clear` runtime reset path，本 phase 记录为 absent。
- [x] `date_change` 不刷新、重建或修改 request-level `current_date` prefix。
- [x] 本 phase 不关心 `date_change` 与 human prompt 是否合并成同一条 `content[]`。

**Verification:**

```bash
pnpm --filter @zcode/contracts exec vitest tests/local-date.test.ts --run
pnpm --filter @zcode/core exec vitest tests/system-reminder-source.test.ts tests/runtime-trace.test.ts tests/runtime-persistence.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/contracts typecheck
pnpm --filter @zcode/adapters typecheck
pnpm --dir apps/zcode-cli/packages/core exec oxlint src/runtime/deps.ts src/runtime/types.ts src/runtime/internal.ts src/runtime/agent-runtime.ts src/runtime/helpers/conversation.ts src/runtime/methods/turn.ts src/runtime/methods/resume.ts src/system-reminder/source.ts tests/runtime-trace.test.ts tests/runtime-persistence.test.ts
pnpm --dir apps/zcode-cli/packages/contracts exec oxlint src/index.ts src/time/local-date.ts tests/local-date.test.ts
pnpm --dir apps/zcode-cli/packages/adapters exec oxlint src/context/index.ts
```

## Phase SR3: Todo / Task / Goal Reminder Semantics

**Phase goal:** 确定 ZCode-supported planning state reminders 的 provider-visible text semantics 和 lifecycle。SR3 曾有 per-request todo-state baseline，但当前 regular turn 已由 SR5 的 `todo_reminder` cadence 替换；`todo_state` 不再保留为 active source，保留本 phase 记录是为了说明为什么 regular turn 不再发送 per-request todo-state reminder。

**User confirmation gate:** Phase SR3 完成 tests + code review 后停止，等待用户确认。

### Task SR3.1: Todo state reminder

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts` or a new Todo reminder helper after confirming current best location
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] Resume restored todo state 继续作为 provider-visible system-reminder，descriptor 为 `resume_todo_state` / `history_continuity`。
- [x] 历史 SR3 曾在 active regular turn 能读取非空 todos 时新增 per-request todo-state / current-turn reminder，提醒模型将 TodoRead/TodoWrite 状态作为当前短期计划来源。
- [x] 历史 SR3 文案语义：当前 todo state 是短期计划上下文，后续 TodoRead/TodoWrite tool result 可以更新它。
- [x] SR3 不实现 cadence；该 per-request / non-empty todo 行为已在 SR5 停用并替换为 cadence 版本。
- [x] 当前 regular turn 无论 todos 是否为空，都不再发送 per-request todo-state reminder；仅在 SR5 cadence due 时发送 `todo_reminder`。

### Task SR3.2: Goal / target state reminder

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/target.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] Active target state request-time reminder 已移除；不再向 regular model request 追加目标状态 system-reminder。
- [x] Resume restored goal state 继续作为 `resume_goal_state` / `history_continuity`。
- [x] Target continuation prompt 继续作为独立 turn/source，不被误归到普通 current-turn reminder。
- [x] Tests 覆盖目标文本作为 untrusted/user-provided data，不升级为 system instruction。

### Task SR3.3: Task status source

**Files:**
- Modify: background task / task status producer after confirming current source path
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] 如果当前 ZCode 有 provider-visible task/background status notification，使用 `task_status` / `mid_turn_event` descriptor。
- [x] Background task notification 的 session store 持久化保持 raw `<task-notification>`；当前 request 和 session hydrate 重建 provider history 时再补 `task_status` system-reminder 外层。
- [x] 如果没有 provider-visible producer，不新增空壳；在本计划中记录 absent / postponed。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/runtime-tool-loop.test.ts tests/runtime-trace.test.ts --run
pnpm --filter @zcode/core typecheck
```

## Phase SR4: MessageHistory Semantic Metadata

**Phase goal:** 为后续 Todo cadence 和 user-message provider request merge 建立通用 runtime metadata 基础设施，但不改变本 phase 的最终 provider request body。

**User confirmation gate:** Phase SR4 完成 tests + code review 后停止，等待用户确认。

**Design note:** 该 phase 采用 MessageHistory internal entry metadata，而不是把 metadata 直接泄漏到 provider message shape。`toModelMessages()` 必须继续返回 provider-clean `ModelInputMessage[]`；新增 runtime/internal API 供 cadence、projection、cache-control finalization 等后续逻辑读取 metadata。

### Task SR4.1: Add MessageHistory entry metadata envelope

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/agent/message-history.ts`
- Test: `apps/zcode-cli/packages/core/tests/message-history.test.ts`

- [x] 新增 core-local `RuntimeMessageMetadata` / `RuntimeMessageEntry` 类型，内部 entry 形态为 `{ message: ModelInputMessage; metadata?: RuntimeMessageMetadata }`。
- [x] `RuntimeMessageMetadata` 只包含 `source: RuntimeMessageSource`；不保存 `origin`、`channel`、`lifecycle`、`projectionPolicy`、`cachePolicy`、`turnId`、`messageId` 或 descriptor evidence 字段。
- [x] 需要 channel/lifecycle/evidence 时从 `SystemReminderSourceDescriptor` 查，不随 message entry 流转；需要 provider projection/cache finalization 时由后续 projector 基于 source 决策。
- [x] `MessageHistory.addUser(...)` 支持可选 metadata；assistant/tool/system messages 可以保持 metadata optional，但 cloning / reset / replace 不得丢失已有 entry metadata。
- [x] 新增 `toRuntimeEntries()` 或等价 internal API，返回 deep-cloned entries 给 Todo cadence / provider projection 使用。
- [x] `toModelMessages()` 继续只返回 provider-safe messages，不包含 metadata / descriptor / provenance fields。
- [x] `countContextPrefixMessages(...)` 优先使用 metadata source 判断 leading `context_prefix` / `skills_listing`；仅在 metadata 缺失时保留 legacy leading `<system-reminder>` fallback。
- [x] Tests 覆盖：metadata deep clone、`toModelMessages()` 不泄漏 metadata、real user 文本以 `<system-reminder>` 开头但带 `real_user` metadata 时不被当作 prefix、legacy leading `<system-reminder>` fallback 仍工作。

### Task SR4.2: Annotate existing provider-visible reminder producers with metadata

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/memory-recall.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/rewind-message.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-tool-warnings.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/media-budget.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-reminders.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/media-budget.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

- [x] Request-prefix context messages 使用 source-only metadata：`source: "context_prefix"` 或 `source: "skills_listing"`。
- [x] Config refresh 复用 `buildContextHistoryEntries(...)` 重建 context prefix metadata，并用 `toRuntimeEntries()` 保留 conversation metadata，避免 refresh 后回退到 `<system-reminder>` 文本判断。
- [x] Real user prompt 使用 source-only metadata：`source: "real_user"`；不把本轮 `turnId/messageId` 写入 runtime metadata。
- [x] Hook additional context、relevant memory、date_change、runtime mode/target/output_style 使用各自 source-only metadata；channel/lifecycle 只从 source descriptor 查询。
- [x] Resume todo/goal 使用 `resume_todo_state` / `resume_goal_state` source；不改变当前 provider-visible body。
- [x] Background task notification 在 provider-visible history 中使用 `task_status` source；session store 继续 raw `<task-notification>`，provider history 继续补 `task_status` wrapper。
- [x] Synthetic user notice 持久化保留旧 `metadata.source` 给 UI/兼容查询，同时在 `metadata.runtimeMessage` 下只写 `{ source }`；如果调用方未提供有效 `runtimeMessage` 则补默认 source-only metadata；request-time overlay / request prefix 不落库。
- [x] 本 phase 只标注 metadata，不做 content merge，不移动 reminder 顺序；regular turn、compact、goal completion verification 的 latest user cache-control 均改为 source-aware entries finalization；media-budget 在 provider-clean fallback 中优先使用 latest real user cache-control 身份信号，不再单靠 `<system-reminder>` 文本判断。
- [x] Tests 覆盖 metadata 存在于 `toRuntimeEntries()`，但 `ModelRequest` / adapter request / `toModelMessages()` 不包含 metadata。

### Task SR4.3: Restore metadata from persisted synthetic parts during hydration

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`
- Test: `apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/session-history-rewind.test.ts`

- [x] Hydrator 对 `TextPart.synthetic === true` 派生 runtime metadata；优先读取 `metadata.runtimeMessage.source`，忽略旧持久化里可能存在的 `origin/channel/projection/cache/turnId/messageId/evidence` 字段。
- [x] 如果没有 `metadata.runtimeMessage`，fallback 到旧 `metadata.source`：`background_task` 派生为 `task_status`；`subagent` 派生为 `queued_system_notification`；`rewind` / `fork` 派生为 `rewind_notice`；未知 synthetic 使用 `legacy_synthetic` source。
- [x] 非 synthetic user text 即使以 `<system-reminder>` 开头，也必须保持 real user metadata 或 metadata absence，不得被反推成 meta。
- [x] Hydration 后 provider-visible body 保持 source 语义：metadata 不进入 provider JSON；background task raw persisted text 仍在 provider history 中补 `task_status` wrapper；`todo_reminder` marker 保持 wrapped provider-visible text 并能继续参与 cadence 判断。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/message-history.test.ts tests/runtime-reminders.test.ts tests/session-history-hydrator.test.ts tests/session-history-rewind.test.ts tests/runtime-trace.test.ts tests/runtime-tool-loop.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --dir apps/zcode-cli/packages/core exec oxlint src/agent/message-history.ts src/agent/session-history-hydrator.ts src/runtime/helpers/conversation.ts src/runtime/methods/context.ts src/runtime/methods/hooks.ts src/runtime/methods/memory-recall.ts src/runtime/methods/turn.ts src/runtime/methods/turn-loop.ts src/runtime/methods/resume.ts src/runtime/methods/background-notifications.ts src/runtime/methods/steering.ts src/runtime/methods/rewind.ts src/runtime/methods/rewind-message.ts src/runtime/methods/turn-tool-warnings.ts tests/message-history.test.ts tests/runtime-reminders.test.ts tests/session-history-hydrator.test.ts tests/runtime-trace.test.ts tests/runtime-tool-loop.test.ts
```

## Phase SR5: Todo Reminder Cadence

**Phase goal:** 用 cadence 机制替换 SR3 的 per-request non-empty `todo_state` reminder：只有 TodoWrite 可用且长期未使用/未提醒时才发送 TodoWrite reminder，并用 MessageHistory metadata 识别 last reminder marker。

**User confirmation gate:** Phase SR5 完成 tests + code review 后停止，等待用户确认。

### Task SR5.1: Add Todo reminder source and cadence helpers

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/system-reminder/source.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Test: `apps/zcode-cli/packages/core/tests/system-reminder-source.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-reminders.test.ts`

- [x] 新增 `todo_reminder` source descriptor，`channel: "current_turn"`、`lifecycle: "per_current_turn"`、`isMeta: true`、`providerVisibility: "provider_visible"`。
- [x] 新增 `TODO_REMINDER_CONFIG`：`TURNS_SINCE_WRITE = 10`，`TURNS_BETWEEN_REMINDERS = 10`。
- [x] 新增 `getTodoReminderTurnCounts(entries)`：倒序扫描 `RuntimeMessageEntry[]`，统计最近 TodoWrite assistant tool call 后的 assistant turns，以及最近 `source === "todo_reminder"` 后的 assistant turns。
- [x] Assistant thinking/reasoning-only message 如在 ZCode 中没有独立 role/type，不新增特殊跳过逻辑；如已有 provider-visible assistant message，则按 assistant turn 计数。
- [x] 新增 `buildTodoReminder(todos)`，文案语义：提醒 TodoWrite 很久没用、可考虑使用/清理 todo list、仅在 relevant 时使用、不要向用户提及 reminder；如果 todos 非空，附上现有 todo list。
- [x] Tests 覆盖计数 helper：无 TodoWrite、最近 TodoWrite、最近 todo_reminder、满足/不满足两个阈值。

### Task SR5.2: Replace per-request todo-state reminder with cadence injection

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] 移除或停用 `buildRuntimeRequestEntries(...)` 内的 SR3 per-request non-empty todo-state append 路径。
- [x] 在 regular turn request assembly 前调用 `maybeInjectTodoReminder(...)` 或等价 internal method；该方法只在当前 exposed tools 包含 `TodoWrite` 时继续。
- [x] ZCode 当前没有 brief / 直接向用户发消息类工具；gate 保留扩展点，但当前不额外 skip。
- [x] 当 `turnsSinceLastTodoWrite >= 10` 且 `turnsSinceLastReminder >= 10` 时，将 wrapped `todo_reminder` 加入 `messageHistory`，并带 source-only metadata：`source: "todo_reminder"`；当前不做 provider projection，先保持 standalone。
- [x] 如果 sessionStore 存在，使用 synthetic notice persistence 记录 provider-visible wrapped reminder text + `metadata.source = "todo_reminder"` / `metadata.runtimeMessage.source = "todo_reminder"`；hydrate 后可恢复 marker，避免 resume 后重复提醒。
- [x] 当前 provider request 中不再出现 SR3 的 authoritative todo-state reminder；仅在 cadence due 时出现 `todo_reminder` 文案。
- [x] Tests 覆盖：未满 10 assistant turns 不插、满 10 turns 插、插入后 10 turns 内不重复、TodoWrite 后计数 reset、TodoWrite tool 不暴露时不插、empty todos 时仍可提醒但不附 todo list、non-empty todos 时附 todo list。

### Task SR5.3: Resume/hydrate cadence continuity

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`
- Test: `apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] Hydrated `todo_reminder` synthetic part 恢复 MessageHistory metadata marker，后续 `getTodoReminderTurnCounts(...)` 能识别它。
- [x] Hydrated assistant TodoWrite tool calls 继续作为 cadence reset marker。
- [x] Resume 后如果上次 todo_reminder 之后未满 10 assistant turns，不重复插入。
- [x] Resume 后如果上次 TodoWrite 和上次 todo_reminder 都满足阈值，允许插入新的 `todo_reminder`。
- [x] Provider-visible request body 不泄漏 MessageHistory metadata。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/system-reminder-source.test.ts tests/runtime-reminders.test.ts tests/runtime-tool-loop.test.ts tests/runtime-trace.test.ts tests/session-history-hydrator.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --dir apps/zcode-cli/packages/core exec oxlint src/system-reminder/source.ts src/runtime/helpers/conversation.ts src/runtime/methods/turn-loop.ts src/runtime/internal-methods.ts src/runtime/methods/index.ts src/agent/session-history-hydrator.ts tests/runtime-reminders.test.ts tests/runtime-tool-loop.test.ts tests/runtime-trace.test.ts tests/session-history-hydrator.test.ts
```

## Phase SR6: Attachment-Origin Reminder Content

**Phase goal:** 盘点并补齐 ZCode-supported attachment-origin system-reminder 文案，不改变 attachment order / bubble-up。

**User confirmation gate:** Phase SR6 完成 tests + code review 后停止，等待用户确认。

### Task SR6.1: Supported attachment inventory

**Files:**
- Create: `apps/zcode-cli/packages/core/src/system-reminder/prompt-attachment.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`

- [x] 列出当前 ZCode 支持且 provider-visible 的 prompt attachment 类型：`file` text preview / local text file、`image` image block、`url` resource surface、read-failure/too-large placeholders；当前 `TurnAttachment` 不支持 directory attachment。
- [x] 对每种类型标记 system-reminder 处理方式：text/file 使用 ZCode generic `prompt_attachment` reminder；image 保持原 provider block；URL 在 runtime pre-adapter 为 `resource_link`，OpenAI-compatible final body 为 `[Resource: ...]` text placeholder；placeholder 只有 text mime 时补 reminder。
- [x] UI-only / control-only / telemetry-only attachment 不生成 provider reminder。
- [x] MCP resources 保持 P-15 postponed，不在本 phase 处理。

### Task SR6.2: Add reminder text for ZCode-supported text attachments where needed

**Files:**
- Create: `apps/zcode-cli/packages/core/src/system-reminder/prompt-attachment.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`

- [x] 对 ZCode 已支持且当前 provider body 缺少 explanatory context 的 text/file attachment，补充 `prompt_attachment` source-owned system-reminder text；live turn 与 session hydrate 均恢复同一语义。
- [x] 非文本 blocks（image、resource_link、file data block 等）必须保持原样，不被 wrapper 吃掉。
- [x] Active slice 不断言 attachment block 在 human prompt 前；只断言 reminder text / non-text block 保真。
- [x] 不实现 synthetic Read tool call/result shape；该形态作为 attachment taxonomy follow-up 保留（后续在 SR12 落地）。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/runtime-persistence.test.ts tests/session-history-hydrator.test.ts tests/runtime-trace.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --dir apps/zcode-cli/packages/core exec oxlint src/system-reminder/prompt-attachment.ts src/runtime/helpers/conversation.ts src/agent/session-history-hydrator.ts tests/runtime-persistence.test.ts tests/session-history-hydrator.test.ts
```

## Phase SR7: Mid-Turn System Events

**Phase goal:** 区分 system-origin notification 和 human queued input，避免把真实用户输入误判成 meta reminder。

**User confirmation gate:** Phase SR7 完成 tests + code review 后停止，等待用户确认。

### Task SR7.1: Classify queued system events and diagnostics

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/system-reminder-source.test.ts`

- [x] Queued human input 保持 `real_user`，即使文本以 `<system-reminder>` 开头也不能被标为 meta；focused runtime test 覆盖 literal tag steered input 仍作为 latest real user 拿到 cache-control。
- [x] System-origin queued notification 如存在，使用 `queued_system_notification` / `mid_turn_event`；当前 producer 是 subagent notification，runtime metadata/persistence/hydrate source 已覆盖，provider-visible wrapper/content gap 已由 SR11 在 live/hydrate provider projection 中补齐。
- [x] Diagnostics 如 provider-visible，使用 `diagnostics` / `mid_turn_event`；当前只发现 context/skill/plugin/model runner 内部 diagnostics/logging，没有 provider-visible diagnostics system-reminder producer，记录为 absent。
- [x] Background task status 已在 SR3/SR4 作为 `task_status` / `mid_turn_event` 完成并带 runtime metadata；本 phase 不重复处理。
- [x] 不存在的 producer 记录为 absent，不新增空壳 reminder。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/runtime-tool-loop.test.ts tests/session-history-hydrator.test.ts tests/system-reminder-source.test.ts --run
pnpm --filter @zcode/core typecheck
```

## Phase SR8: Evidence + Docs

**Phase goal:** 用 prompt-trajectory 和 focused tests 证明 system-reminder source/content 符合预期，并更新本计划状态。

**User confirmation gate:** Phase SR8 完成 tests + code review 后停止，等待用户确认。

### Task SR8.1: Prompt trajectory evidence

**Files:**
- Create: `apps/zcode-cli/tools/prompt-trajectory/testcases/system-reminder-sources/prompt.txt`
- Create: `apps/zcode-cli/tools/prompt-trajectory/testcases/system-reminder-sources/expect.json`
- Modify: `apps/zcode-cli/worklogs/trajectory-align-log.md`

- [x] Add trajectory testcase 覆盖真实 user prompt 以 `<system-reminder>` 开头的 provider-visible badcase。
- [x] 记录 prompt-trajectory runner 当前边界：`run:testcases` 只从 `prompt.txt` 生成 single-turn `submitPrompt`，`expect.json` 是 manual inspection contract，不负责 multi-turn 自动断言。
- [x] 用 focused Vitest 覆盖至少一个 current-turn source、一个 prefix source、一个 tool-result source、一个 history-continuity source。
- [x] 用 focused Vitest 覆盖 `date_change` multi-turn 行为。
- [x] 用 focused Vitest 覆盖 output style：non-default/非空时出现 `output_style` reminder，default/空时不出现。
- [x] 用 focused Vitest 覆盖 Todo reminder cadence：未满足阈值不出现，满足阈值时出现 `todo_reminder`，并确认不再出现 per-request todo-state authoritative reminder。
- [x] Export derived provider request body 到 `out/system-reminder-sources/`，仅保留最终一次输出。
- [x] Assert provider body 包含/不包含对应 reminder text。
- [x] Assert provider body 不包含 descriptor/provenance/evidence metadata。
- [x] Update 本计划中 system-reminder 相关状态；只标记 source/content 完成，不把 content merge / bubble-up 标成完成。
- [x] Update worklog under current date-level entry。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/system-reminder-source.test.ts tests/runtime-trace.test.ts tests/runtime-hooks.test.ts tests/runtime-memory.test.ts tests/runtime-tool-loop.test.ts --run
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases --out-root out/system-reminder-sources --model test/fake --upstream-base-url <local-fake-openai-base-url> --api-key fake
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/contracts typecheck
pnpm typecheck
pnpm lint
```

如果 repo-wide `pnpm typecheck` 或 `pnpm lint` 因无关既有问题失败，记录具体 failing files，并补跑 focused package checks。

## Phase SR9: Current-Turn Reminder Content Polish

**Phase goal:** 按最终 provider-visible content 完善 current-turn system-reminder 的语义和 cadence；本 phase 只处理 `runtime_mode`、`output_style`、`date_change`、`todo_reminder`，不实现 content merge / provider projection。

**User confirmation gate:** Phase SR9 完成 tests + code review 后停止，等待用户确认。

### Task SR9.1: `runtime_mode` / plan mode content and cadence

**Files:**
- Add/Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-reminders.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`
- E2E: `apps/zcode-cli/tools/prompt-trajectory/testcases/system-reminder-sr9-runtime/fixture.json`

- [x] Plan mode reminder cadence：首个 plan turn 发送 full reminder；已有 plan reminder 后，未满 5 个 human turns 不重复发送；第 1、6、11... 次 attachment 使用 full reminder，其余使用 sparse reminder。
- [x] ZCode `runtime_mode` full reminder 继续保留 ZCode 自身工具名和模式语义，provider-visible content 覆盖核心语义：plan mode active、禁止非只读修改/非 read-only tool、等待用户切换/确认后再实现；不引入 ZCode 当前不存在的 plan-file/edit-boundary 工具名。
- [x] 新增 sparse reminder 文案：提醒 plan mode still active、read-only 限制仍生效、不要把 plan approval 当成普通文本问题；不要求 exact wording。
- [x] 不硬编码 ZCode 当时不存在的 tool name（如 `ExitPlanModeV2`、`AskUserQuestion`）；如 ZCode 没有对应 tool，则使用 ZCode 当前 mode-switch / clarification 语义表达。
- [x] Tests 覆盖：首次 plan request 有 full reminder；连续 plan follow-up 未满 5 个 human turns 不重复；满足 cadence 后出现 sparse/full；普通 mode 不出现 `runtime_mode`。

### Task SR9.2: `output_style` tail reminder content

**Files:**
- Add/Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-reminders.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] 保持 active 条件不变：`outputStyle` 非空且 prompt 非空时才发送；default/空 style 不发送。
- [x] Tail system-reminder content 只提醒 `<style name> output style is active` 以及需要遵循该 style 的 guidelines。
- [x] 不在 tail reminder 中重复输出完整 `outputStyle.prompt`；完整 style prompt 已由 system prompt dynamic `output_style` section 承载。
- [x] `output_style` 作为每个用户 turn 的 in-memory runtime history marker 注入，不作为 session persistent synthetic notice；同一 turn 的 tool-loop 后续 model request 不重复追加。
- [x] Tests 覆盖 provider-visible body：active style 时 tail reminder 只包含 style name / active hint，不包含完整 style prompt；default/空 style 不出现 reminder；第二轮 request 能看到上一轮 runtime history 中的 output_style reminder，session store 不持久化该 reminder。

### Task SR9.3: `date_change` reminder wording

**Files:**
- Add/Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] 保持 SR2 lifecycle：fresh/resume first turn 只记录 local date；same runtime 跨本地日期时发送一次；不刷新 request-level current date prefix。
- [x] Provider-visible content 说明日期已经变化、今天日期现在是新日期，并明确不要向用户显式提及这个 reminder。
- [x] 继续使用同一套 local `YYYY-MM-DD` helper，避免 prefix date 和 date_change date 来源分裂。
- [x] Tests 覆盖跨日 reminder 文案包含新日期和“不向用户显式提及”的语义。

### Task SR9.4: Supplement `todo_reminder` wording

**Files:**
- Add/Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-reminders.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] 保持 SR5 cadence 不变：TodoWrite exposed、最近 TodoWrite 和最近 reminder 都达到 10 assistant turns 才发送；不恢复 per-request todo-state baseline。
- [x] Provider-visible content 补齐语义：TodoWrite 很久没用；如当前任务适合追踪进度可考虑使用；如果 todo list stale 可清理；仅在 relevant 时使用；不适用就忽略；不要向用户提及 reminder。
- [x] 非空 todos 时附当前 todo list；空 todos 时仍允许 gentle reminder 但不输出空列表。
- [x] Tests 覆盖 due reminder 文案包含 “ignore if not applicable” / “only if relevant” / “never mention” 等语义，以及非空 todos 附列表。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/runtime-reminders.test.ts tests/runtime-trace.test.ts tests/runtime-persistence.test.ts tests/runtime-tool-loop.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --dir apps/zcode-cli/packages/core exec oxlint src/runtime/helpers/conversation.ts src/runtime/helpers/runtime-reminders.ts src/runtime/helpers/index.ts src/runtime/methods/turn-loop.ts tests/runtime-reminders.test.ts tests/runtime-trace.test.ts tests/runtime-persistence.test.ts
pnpm --filter @zcode/core build
pnpm --filter @zcode/prompt-trajectory exec node --import tsx --test tests/*.test.ts
pnpm --filter @zcode/prompt-trajectory typecheck
pnpm --filter @zcode/prompt-trajectory lint
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases --out-root out/system-reminder-sr9
```

After prompt-trajectory finishes, inspect the latest `apps/zcode-cli/tools/prompt-trajectory/out/system-reminder-sr9/test*/**/trajectory.jsonl` and `apps/zcode-cli/tools/prompt-trajectory/out/system-reminder-sr9/test*/**/trajectories/*.openai_request_body.json`; confirm every provider-visible message matches SR9 expectations before asking for user confirmation.

SR9 prompt-trajectory coverage boundary:
- Covered by `system-reminder-sr9-runtime`: first-turn full `runtime_mode`, non-repeat before 5 human turns, `output_style` tail reminder without full style prompt, and output_style in-memory history tracking. The latest validated output is `apps/zcode-cli/tools/prompt-trajectory/out/system-reminder-output-style-memory/test20260604-161114`; it exports a single incremental-derived `0001.openai_request_body.json` for the two-turn run, with two output_style reminders and no `0002-non-incremental-change` file.
- Covered by focused Vitest, not prompt-trajectory yet: `date_change` and `todo_reminder`, because the current prompt-trajectory fixture runner does not expose deterministic local date injection or seeded TodoWrite/tool-call history.

## Phase SR10: System-Reminder Tag Wrap Audit

**Phase goal:** 盘点所有最终 provider-visible `<system-reminder>` attachment/tool-result/userContext source，确认 ZCode active source 都有 tag wrap；只按最终 content 判断，不把 implementation path 差异当 diff。

**User confirmation gate:** Phase SR10 完成 audit doc + tests/code review 后停止，等待用户确认。

### Task SR10.1: Build tag-wrap matrix

**Files:**
- Modify: `apps/zcode-cli/docs/plan/trajectory/system-reminder-source-alignment-plan.md`
- Test: `apps/zcode-cli/packages/core/tests/system-reminder-source.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-reminders.test.ts`

- [x] 列出会输出 `<system-reminder>` 的 active / postponed / ignored source 候选：plan_mode、output_style、date_change、todo_reminder、task_reminder、diagnostics、queued_command、task_status、hook family、relevant_memories、skill_listing、file/directory attachment、deferred_tools_delta、agent_listing_delta、mcp_instructions_delta、compaction/context-efficiency、verify_plan_reminder 等。
- [x] 对每项标记 ZCode 状态：`active wrapped`、`active unwrapped`、`active different structure`、`ZCode-specific`、`postponed`、`absent by decision`。
- [x] 对 active source 增加或复用 focused tests，断言 provider-visible text 包含 exactly one `<system-reminder>` wrapper，且不泄漏 source/descriptor metadata。
- [x] 对 `tool_result_warning` 保持 tool result inline wrapper，不要求进入 synthetic user notice。
- [x] 对 `model_anomaly`、`rewind_notice`、`resume_goal_state`、`goal_completion_verification` 等 ZCode-specific source 只验收自身 wrapper，按自身语义归类；`runtime_target` 已移除，不再作为 active source 验收。

SR10 implementation evidence:

- 已完成 tag-wrap 盘点，状态分为 active wrapped / active unwrapped / active different structure / ZCode-specific / postponed / absent by decision，只按最终 provider-visible content 判断。
- `system-reminder-source.test.ts` 覆盖所有 registered provider-visible source exactly-one wrapper、nested tag escaping 和 descriptor metadata 不泄漏。
- `runtime-reminders.test.ts` 覆盖 `rewind_notice` conversation fork producer 改走统一 wrapper 后能 escape nested tag-like text。
- `target-tool.test.ts` 覆盖 `goal_completion_verification` tool-result content exactly-one wrapper；该函数位于 contracts 层，保持手写 tag 以避免 contracts 反向依赖 core helper。
- Prompt trajectory e2e 输出到 `apps/zcode-cli/tools/prompt-trajectory/out/system-reminder-sr10-tag-wrap/test20260604-163037`；`system-reminder-sources` 与 `system-reminder-sr9-runtime` request body 无 `source=` / `runtimeMessage` / descriptor 泄漏，且无 `*-non-incremental-change.openai_request_body.json`。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/system-reminder-source.test.ts tests/runtime-reminders.test.ts tests/runtime-trace.test.ts tests/runtime-tool-loop.test.ts --run
pnpm --filter @zcode/core typecheck
```

## Phase SR11: Queued System Notification / Subagent Notification Wrapper

**Phase goal:** 将 `queued_system_notification` 中的 subagent notification provider-visible content 统一为 `<system-reminder>` wrapper，同时保持 session store / UI transcript 的 raw `<subagent-notification>` 不变。

**User confirmation gate:** Phase SR11 完成 research + implementation + tests + prompt-trajectory e2e 后停止，等待用户确认再进入 SR12。

### Task SR11.1: Research queued notification wrapper before implementation

**Files:**
- Modify: `apps/zcode-cli/docs/plan/trajectory/system-reminder-source-alignment-plan.md`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`
- Modify: `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`
- Test: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`
- Modify: `apps/zcode-cli/tools/prompt-trajectory/src/fixture.ts`
- Modify: `apps/zcode-cli/tools/prompt-trajectory/src/record.ts`
- Modify: `apps/zcode-cli/tools/prompt-trajectory/src/openai-provider-proxy.ts`
- Testcase: `apps/zcode-cli/tools/prompt-trajectory/testcases/system-reminder-sr11-subagent-notification/`

- [x] 确定 queued command provider-visible content 规则：human queued input 保持 user-authored；system-origin / task-notification origin 使用 `<system-reminder>` wrapper；array content 只 wrap text blocks，image blocks 保留。
- [x] 对照 ZCode subagent notification producer：`formatBackgroundCompletionNotification(...)` / `formatBackgroundFailureNotification(...)` 当前输出 `<subagent-notification>` raw text，`drainPendingSubagentNotifications(...)` 只打 `queued_system_notification` metadata，不在 drain 点统一 wrap。
- [x] 判断最终 provider body 是否应改为 `<system-reminder><subagent-notification>...</subagent-notification></system-reminder>`；如果改，确认不会导致 hydrate 后 double wrap，也不会改变 UI transcript raw notification 展示。
- [x] Live drain 时只把 provider-visible `MessageHistory` text 包 `wrapSystemReminderForSource("queued_system_notification", rawText)`，persisted raw notification 保持 `<subagent-notification>`。
- [x] Session hydrate 对 `runtimeMessage.source === "queued_system_notification"` 和 legacy `metadata.source === "subagent"` 补同一 provider-visible wrapper。
- [x] 补 live turn + hydrate tests：subagent completion notification 在 provider body 中有 exactly one `<system-reminder>` wrapper；persisted raw text 兼容旧 session；human queued input 仍不被 wrapper 包裹。
- [x] Prompt-trajectory 新增 request-matched mock response 和 event-wait step，deterministic mocked subagent fixture 等待 `subagent_stopped` 后提交 follow-up，覆盖最终 parent request 中 wrapped notification。

SR11 research conclusion:

- system-origin / task-notification queued input 在 provider-visible 边界加 system-origin 前缀并统一包 `<system-reminder>`；human queued input 不包。
- ZCode background Bash `<task-notification>` 已符合该规则：live provider history 包 `task_status` system-reminder，session store 保持 raw notification，hydrate 再补 wrapper。
- ZCode subagent background notification 曾经只写 raw `<subagent-notification>` 到 provider history，虽然 metadata source 是 `queued_system_notification`；这是 SR11 唯一 active wrapper/content gap。
- 已按确认实现：保持 `formatBackgroundCompletionNotification(...)` / `formatBackgroundFailureNotification(...)` 和 persisted session part raw；只在 live drain + hydrate provider projection 边界用 `wrapSystemReminderForSource("queued_system_notification", rawText)`。这样不改变 UI transcript，不改变 persisted raw text，并能沿用已有 source metadata 防误判。
- Prompt-trajectory e2e 输出：`tools/prompt-trajectory/out/system-reminder-sr11-subagent-notification/test20260604-sr11`。最终 parent follow-up request 是 `trajectories/0004-non-incremental-change.openai_request_body.json`；`non-incremental` 来自 parent tool-loop、child subagent request、parent follow-up 的多 request 形态交错，不是 provider-visible SR11 content mismatch。该 request 中 `<system-reminder>` / `<subagent-notification>` open/close 均 exactly one，且无 `runtimeMessage` / `providerVisibility` / `evidenceLabel` / `source=` 泄漏。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/subagent-explore.test.ts tests/session-history-hydrator.test.ts tests/runtime-tool-loop.test.ts tests/system-reminder-source.test.ts --run
pnpm --filter @zcode/prompt-trajectory record -- --fixture testcases/system-reminder-sr11-subagent-notification/fixture.json --out out/system-reminder-sr11-subagent-notification/test20260604-sr11
pnpm --filter @zcode/core typecheck
```

## Phase SR12: Synthetic Attachment Meta Text Shape

**Phase goal:** 在 SR6 generic `prompt_attachment` reminder 之外，单独评估 attachment-origin synthetic Read / Bash tool call/result 的 meta-user text shape。

**Why last:** 这不是单纯补一段 `<system-reminder>` 文案，而是改变 text/file attachment 的 provider-visible 表达形态。synthetic tool call/result 是 meta-user text（例如 “Called the ... tool...” / “Result of calling ...”），不是真 provider tool_use/tool_result boundary；仍需单独处理 live/hydrate、summary/compact、prompt trajectory 验证和后续 provider projection。

**User confirmation gate:** Phase SR12 开始前重新 review 当前 attachment implementation；完成 shape proposal、tests 和 code review 后停止，等待用户确认。

### Task SR12.1: Decide exact provider-visible shape

**Files:**
- Modify: `apps/zcode-cli/docs/plan/trajectory/system-reminder-source-alignment-plan.md`

- [x] 设计 synthetic Read / Bash tool call/result 的最终 provider-visible meta-user text body 形态。
- [x] 对照 ZCode 当前 attachment model：live turn `buildUserContentFromTurn(...)`、session `FilePart` persistence、hydrate `filePartToContentBlock(...)`、tool-result summary/compact/media-budget 边界。
- [x] 明确采用 `text-simulated`：在 `prompt_attachment` `<system-reminder>` 文本中模拟 ZCode `Read` call/result，不生成真实 provider tool result boundary。
- [x] text-simulated 策略风险已收敛：只覆盖 ZCode-supported file-source text attachment；source-less inline text 保持中性 wrapper，directory/Bash、bubble-up 和 content merge 继续 out of scope。

### Task SR12.2: Implement chosen shape for ZCode-supported file-source text attachments

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/system-reminder/prompt-attachment.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/session-history-hydrator.test.ts`

- [x] 只覆盖 ZCode-supported file-source text attachment；live turn 和 hydrate 都优先使用用户提交的附件引用作为 `file_path`，避免 nested path 被 basename 截断；source-less inline text 保持中性 `prompt_attachment` wrapper；image/file data block 继续保真，URL/resource surface 继续作为 ZCode-specific wrapper 外内容处理，不被 synthetic Read wrapper 吃掉。
- [x] live turn 和 session hydrate 生成一致的 provider-visible shape。
- [x] 不改变 session store/UI transcript 结构；如果需要额外 metadata，只能放在 runtime/provider projection 边界，不写入 UI-facing message body。
- [x] 不把 synthetic attachment shape 计入真实 tool execution ledger、Todo/tool cadence 或 permission flow。
- [x] Tests 覆盖 live turn nested path、hydrate nested path、source-less inline text neutral wrapper、truncated text file、read-failure placeholder、image/resource surface 不变。

### Task SR12.3: Prompt trajectory evidence

**Files:**
- Modify: `apps/zcode-cli/tools/prompt-trajectory/testcases/system-reminder-sources/...`
- Modify: `apps/zcode-cli/worklogs/trajectory-align-log.md`

- [x] 导出至少一个 nested file-source text attachment testcase 的 provider request body，证明 chosen shape 与 SR12 决策一致。
- [x] 导出至少一个 URL/resource attachment testcase，证明 URL/resource surface 保持 ZCode-specific wrapper 外 provider-visible content。
- [x] 在本计划中分开记录 SR6 generic reminder 与 SR12 synthetic Read shape 的状态。
- [x] 更新 worklog under current date-level entry。

**Verification:**

```bash
pnpm --filter @zcode/core exec vitest tests/runtime-persistence.test.ts tests/session-history-hydrator.test.ts tests/runtime-trace.test.ts --run
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases --out-root out
pnpm --filter @zcode/core typecheck
pnpm typecheck
pnpm lint
```

## Final Acceptance Checklist

- [x] 每个 active system-reminder source 都有明确 source owner、channel、lifecycle、isMeta、providerVisibility、evidenceLabel。
- [x] Existing hook/memory/plan/target/skill listing/tool-result/resume reminder 仍 provider-visible，且 source ownership 清晰。
- [x] `runtime_mode` / plan mode 采用 content/cadence 规则：首轮 full、后续 human-turn cadence、full/sparse 循环，且不引入 ZCode 不存在的 tool name。
- [x] `date_change` 按 runtime-local 行为实现并补齐 provider-visible wording：fresh/resume 首轮只记录日期，同 runtime 跨日才发送，不刷新 request-level prefix，且提醒不要显式告诉用户。
- [x] `output_style` 只有 non-default/非空时发送 system-reminder；default/空 style 不发送；tail reminder 只提示 active style，不重复完整 style prompt。
- [x] Goal/target request-time reminder 已移除；`target_continuation` model-only continuation 仍保留。Todo regular turn 已用 SR5 `todo_reminder` cadence，不再保留 per-request todo-state baseline；`todo_reminder` 文案已在 SR9 补齐 only-if-relevant / ignore-if-not-applicable / never-mention 语义。
- [x] Skill listing 保持 request-prefix source；attachment 增量 listing 暂不实现；skill discovery 保持 postponed。
- [x] Tool-result warnings 保持 tool-result source。
- [x] ZCode-specific existing producers 覆盖完整：context prefix、model anomaly、rewind/fork notice、goal completion verification 都有 source taxonomy。
- [x] Human queued input 保持 real user source，不能靠 `<system-reminder>` 文本误判。
- [x] Attachment-origin system-reminder 只覆盖 ZCode-supported provider-visible 类型；不做 order / bubble-up。
- [x] 所有带 `<system-reminder>` tag 的 active / postponed / ZCode-specific 功能点均完成 tag-wrap audit；active source 有 focused tests 证明 exactly one wrapper。
- [x] `queued_system_notification` / subagent notification 已完成 SR11 调研、live/hydrate wrapper implementation、focused tests 和 prompt-trajectory e2e；session/UI raw notification 保持不变。
- [x] Synthetic Read/Bash tool call/result meta-user text shape 作为 SR12 最终 phase 单独处理；ZCode-supported file-source text attachment 已采用 synthetic `Read` meta-user text shape，source-less inline text 不虚构 tool name，directory/Bash 无 active producer。
- [x] ToolSearch/deferred tools、MCP instructions/resources、skill discovery、bubble-up、content merge、cache-control finalization 均不在本 plan 实现。
- [x] Provider JSON 不泄漏 descriptor/provenance/evidence metadata。
- [x] Prompt-trajectory evidence 存在，并只验收 system-reminder source/content/channel，不验收 `content[]` merge shape。
- [x] 每个 phase 完成测试和 code review 后都经过用户确认再进入下一 phase。
