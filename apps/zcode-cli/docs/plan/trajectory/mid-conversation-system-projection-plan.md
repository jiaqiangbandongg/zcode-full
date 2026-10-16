# Mid-conversation System Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not move from one phase to the next without user confirmation after tests, code review, and prompt-trajectory evidence. Do not create a commit unless the user explicitly asks after review.

**目标：** 在不修改 Anthropic beta/header、不做 provider capability gate 的前提下，按 Anthropic Messages API 的 `mid-conversation-system-2026-04-07` 能力调整 ZCode provider-visible messages 形态：除 request-level userContext / real-user / tool-result 边界外，source-owned internal meta reminder 从 user `<system-reminder>` 投影为 mid-history `role: "system"` message。

**架构：** 采用 meta attachment -> request normalize -> system render 链路，在 ZCode 内部引入结构化 runtime attachment entry。Producer 表达语义和 raw body，provider request finalization 决定最终输出 `role: "system"` 还是 user `<system-reminder>` fallback；`RuntimeMessageMetadata` 仍保持 source-only。MCS1 已完成 provider-visible proof，但其实现仍以 wrapped user message 为中间态；MCS1.5 会把主路径改为结构化 attachment entry，避免 request finalizer 再从 `<system-reminder>` 字符串里取 body。当前 `ContextBuilder` 也不再产出 wrapped meta-user message，而是产出 `systemMessages` 和 raw `metaUserAttachments`，runtime 层统一转成 source-aware attachment entry。历史 session/hydrate 中已经持久化为 user synthetic text 的 system-reminder 不升级为 attachment entry，也不投影为 mid-conversation system；它们继续按旧 role:user provider-visible shape 发送。`prompt_attachment` 因当前嵌在真实 user `content[]` block 内，需要单独做 block-level 拆分，避免把真实用户文本误判为 meta reminder。

**Tech Stack：** TypeScript, Vitest, `@zcode/core`, `@zcode/contracts`, prompt-trajectory, model-io trajectory converter.

---

## Scope

本 plan 负责：

- 将以下 ZCode 已有 provider-visible reminder 在最终 provider request 中投影为 `role: "system"`：
  - `skills_listing`
  - `todo_reminder`
  - `runtime_mode`
  - `hook_context`
  - `relevant_memory`
  - `referenced_session_context`
  - `task_status`
  - `queued_system_notification`
  - `resume_todo_state`
  - `resume_goal_state`
  - `rewind_notice`
  - `model_anomaly`
  - `output_style`
  - `date_change`
  - `plan_mode_exit`
  - `diagnostics`
  - 若未来拆成独立 runtime attachment entry，`prompt_attachment` 也走 `role: "system"`。
- 保持 request-level userContext/currentDate/user instructions/project context 的 user `<system-reminder>` 形态，不迁移为 `role: "system"`。
- `target_continuation` 保持 model-only user 输入语义，`tool_result_warning` / `goal_completion_verification` 保持 tool-result / auxiliary-result 边界，不作为普通 MCS meta reminder。
- 最终 provider projection 无条件合并 adjacent user messages，避免连续 user shape 漂移；不再只在 MCS fallback 时合并。
- 保持 provider body 中 runtime metadata 不泄漏。
- 保持 cache-control 落点在最终 projection 后的最后一个非 system message。

本 plan 不负责：

- 不新增、修改或自动注入 `anthropic-beta` / provider header。
- 不做 provider/model capability gate；本轮 assumption 固定为 first-party + Opus 4.8 且 mid-conversation system 已启用。
- reminder 文案继续使用 ZCode 自身工具名和产品名；本 plan 只调整 channel 与 shape，不改文案语义。
- 不实现 ToolSearch/deferred tools、MCP instructions、完整 skills/compact reinjection。
- 不重构 session persistence schema。
- 不迁移或重写历史 session 里已持久化的 synthetic user system-reminder 消息；hydrate/replay 保持旧 role:user shape。

## Feature-complete Follow-up

| ID | 类型 | 记录 | 处理时机 |
| --- | --- | --- | --- |
| MCS-FU1 | legacy bugfix | 已修复：文本/文件附件读取失败时，`metadata.errorCode === "attachment_read_failed"` 的 text placeholder 不进入 provider-visible user content。过滤只覆盖 failed text stub，不影响 intentional `local_ref` 二进制/大文件句柄、URL/resource link、pasted image placeholder 或 source-less inline text attachment reminder。 | ✅ 已完成，覆盖 focused regression |
| MCS-FU2 | provider wire shape | mid-conversation system message 在最终 `messages[]` 中应保持 `{ role: "system", content: string }`；ZCode Core 产出 string，但 AI SDK Anthropic serializer 会转为单元素 text-block array。修复只在 Anthropic 最终 fetch boundary 将 `messages[].role === "system"` 的单个纯 text block 还原为 string；prompt-trajectory 导出原样保留已录制 MCS content；不修改顶层 `system[]`、其他 role、cache-control 或其他 provider。正式回归使用确定性的 Anthropic / Opus 4.8 SR12 fixture，直接断言最终 provider request 的 MCS `content` 为 string；SR11 fixture 同步当前 Agent 后台启动文案、`<task-notification>` 与自动 parent continuation 时序。 | ✅ 已完成，正式 trajectory fixture 已通过 |

## 当前代码事实

- `RuntimeMessageMetadata` 当前只有 `{ source }`，位于 `apps/zcode-cli/packages/core/src/agent/message-history.ts`。
- MCS1.5 当前分支中 `RuntimeMessageEntry` 已支持 message entry 与 attachment entry；attachment entry 保存 raw body，legacy message entry 不参与 mid-conversation system projection。
- `SystemReminderSource` 已拆为 prefix / persisted / per-request，位于 `apps/zcode-cli/packages/core/src/system-reminder/source.ts`。
- `ContextBuildResult` 当前只暴露 `systemMessages` 和 raw `metaUserAttachments`；`ContextBuilder` 不再把 skills/context prefix 预先 wrap 成 user `<system-reminder>`。
- provider-visible request finalization 入口是 `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts` 的 `buildProviderRequestMessages(...)`。
- `buildProviderRequestMessages(...)` 已对 attachment entry 使用 raw body 投影除 `context_prefix`、`target_continuation`、`tool_result_warning`、`goal_completion_verification` 之外的 source-owned meta reminders 为 `role: "system"`；legacy wrapped message 即使带 source metadata，也保持原 role:user shape。
- `skills_listing` / `context_prefix` 当前由 `ContextBuilder` 的 `metaUserAttachments` 交给 `buildContextHistoryEntries(...)` 创建 attachment entry；`skills_listing` 投影为 `role: "system"`，`context_prefix` 仍 fallback 为 user `<system-reminder>`。
- `todo_reminder` / `output_style` / `plan_mode_exit` 当前在 `runRegularTurnLoop(...)` 中作为 attachment entry 加入 `MessageHistory`；`todo_reminder` 仍持久化 wrapped synthetic notice 作为 resume/cadence marker。
- `date_change` 当前在 `executeTurn(...)` 入口处作为 attachment entry 加入 `MessageHistory`。
- `prompt_attachment` 当前由 `buildRuntimeUserEntriesFromTurn(...)` 从 live turn / hydrate 的 attachment source 边界拆成独立 raw attachment entry；provider projection 将它投影为 `role: "system"`，真实 user entry 只保留用户 prompt、URL/resource、image 等非 prompt-attachment context。
- AI SDK adapter 已允许 `messages[]` 内出现 system role；Anthropic 最终 fetch boundary 负责将其纯文本 `content` 还原为 string，本 plan 不改 adapter header。

## Product Decisions

| ID | 决策 | 影响 |
| --- | --- | --- |
| MCS-D1 | 默认视为 `mid-conversation-system-2026-04-07` 已启用，不做 header/capability gate | 实现只关注 provider-visible shape |
| MCS-D2 | 只迁移 source-owned runtime attachment entry；MCS source 使用排除表，不按 `<system-reminder>` literal tag 全局迁移 | 避免误伤用户文本和 request-level userContext |
| MCS-D3 | `context_prefix` 继续保持 user `<system-reminder>` | request-level userContext 保持 user context 形态 |
| MCS-D4 | `skills_listing` 在 provider body 中移动到首个真实 user prompt 后，转为 `role: "system"` | skills listing 作为 meta context 紧随首个真实 user prompt |
| MCS-D5 | 除 `context_prefix`、`target_continuation`、`tool_result_warning`、`goal_completion_verification` 外的 provider-visible meta source 保持当前触发 cadence/内容，只迁移 channel/wrapper/位置 | 降低行为风险 |
| MCS-D6 | `prompt_attachment` 优先通过 source/runtime entry 方式拆分；如果实现中发现 hydrate/replay 只能拿到旧 content block，再只对 ZCode 自己生成的严格 shape 做 fallback | 避免泛用 tag heuristic |
| MCS-D7 | cache-control 在 mid-system projection 后再 finalization，跳过所有 `role: "system"` message | cache anchor 始终落在最后一条非 system message |
| MCS-D8 | 每个 phase 结束必须跑 focused unit tests + prompt-trajectory e2e，并把输出放到 `apps/zcode-cli/out/` | 验收面是最终 provider request body |
| MCS-D9 | hydrate/replay 不把历史 synthetic user system-reminder 桥接成 attachment entry，也不通过 exact unwrap 升级为 mid-conversation system | 旧 session 保持旧 role:user shape；只有新 runtime attachment entry 参与 mid-system projection |
| MCS-D10 | projection 最后无条件合并 adjacent user messages | 主路径与 fallback 收尾统一合并，避免连续 user shape 漂移 |

## File Map

| 文件 | 责任 |
| --- | --- |
| `apps/zcode-cli/packages/core/src/agent/message-history.ts` | 新增 runtime attachment entry 类型、clone/render helper；保持 metadata source-only |
| `apps/zcode-cli/packages/core/src/context/builder.ts` | 组装 stable/dynamic `systemMessages` 与 raw `metaUserAttachments`，不在 builder 内 wrap system-reminder |
| `apps/zcode-cli/packages/core/src/context/types.ts` | 定义 `ContextBuildResult.systemMessages` / `metaUserAttachments` 边界 |
| `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts` | provider request projection 主入口；基于 attachment entry 做 mid-conversation system projection |
| `apps/zcode-cli/packages/core/src/system-reminder/source.ts` | 提供 mid-conversation source helper、body sanitizer 和 fallback wrapper；不提供 unwrap helper，历史 wrapped message 不会升级为 attachment 或 mid-conversation system |
| `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts` | `prompt_attachment` 从真实 user content 中拆出 runtime entry 的入口候选 |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts` | regular user turn 中写入 real user + prompt attachment runtime entries 的调用点 |
| `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts` | 确认 todo/output/plan-exit projection 后 provider request shape；原则上只改调用参数或注释 |
| `apps/zcode-cli/packages/core/tests/provider-request-messages.test.ts` | projection unit tests 主文件 |
| `apps/zcode-cli/packages/core/tests/prompt-attachments.test.ts` | prompt attachment content split tests |
| `apps/zcode-cli/packages/core/tests/runtime-reminders.test.ts` | reminder 文案/cadence regression tests |
| `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts` | provider request event / metadata stripping regression tests |
| `apps/zcode-cli/worklogs/trajectory-align-log.md` | 按当前 worklog 规则补一段 brief 记录 |

## Phase MCS0: Baseline Lock

**Phase goal:** 先锁当前 provider-visible 差异和测试入口，避免实现后不知道是行为变化还是 fixture 漂移。

**User confirmation gate:** MCS0 完成后停止，汇报 baseline evidence，等待用户确认进入 MCS1。

### Checklist

- [x] 确认当前工作区没有会影响 plan 的未提交实现改动。
- [x] 用现有 prompt-trajectory 跑一个包含 skills listing 的 first-turn case。
- [x] 跑一个可触发 `todo_reminder` 的 multi-turn/fixture case；如果现有 prompt-trajectory 不方便触发，用 focused unit test 覆盖并在文档记录 runner 缺口。
- [x] 跑一个包含 text file attachment 的 case，确认当前 provider body 中 attachment reminder 仍在 user content 内。
- [x] 把 baseline 输出路径记录到本 plan 的 “Execution Notes”。

### Steps

- [x] **Step 1: 检查工作区**

Run:

```bash
git status --short
```

Expected: 只看到用户已知/当前任务相关改动；如有不相关改动，不要修改。

- [x] **Step 2: 运行 provider projection tests baseline**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/runtime-reminders.test.ts
```

Expected: PASS。若失败，先定位是否已有本地漂移，不能在 mid-system implementation 中顺手掩盖。

- [x] **Step 3: 运行 prompt-trajectory baseline**

Run existing prompt-trajectory fixture that covers first-turn skills and attachment. If no existing fixture covers it, add a minimal fixture under `apps/zcode-cli/tools/prompt-trajectory/testcases/` before implementation.

Expected provider-visible baseline:

```json
[
  { "role": "user", "content": "<system-reminder>...skills...</system-reminder>" },
  { "role": "user", "content": "<system-reminder>...# currentDate...</system-reminder>" },
  { "role": "user", "content": "real user prompt or content[]" }
]
```

For text file attachment, expected current baseline includes a user text block shaped like:

```json
{
  "type": "text",
  "text": "<system-reminder>\nCalled the Read tool with the following input: ...\n</system-reminder>"
}
```

## Phase MCS1: Entry-level Mid-conversation System Projection

**Phase goal:** 对已经作为独立 `RuntimeMessageEntry` 存在的 meta reminders 做 source-aware projection，不处理嵌在真实 user content[] 里的 prompt attachment。

**User confirmation gate:** MCS1 完成 tests + prompt-trajectory + code review 后停止，等待用户确认进入 MCS2。

### Checklist

- [x] 新增 mid-conversation system candidate source helper，使用明确排除表。
- [x] `skills_listing` 从 prefix user message 移到首个真实 user prompt 后，并去掉 `<system-reminder>` wrapper。
- [x] `todo_reminder` / `runtime_mode` / hook/memory/resume/rewind/background notification / `output_style` / `date_change` / `plan_mode_exit` 等 provider-visible meta attachment 转成 `role: "system"`。
- [x] `context_prefix` / `target_continuation` / `tool_result_warning` / `goal_completion_verification` 不迁移。
- [x] projection finalization 无条件执行 adjacent user merge。
- [x] latest real user diagnostics 在 projection 后仍指向真实 user provider message。
- [x] cache-control 落到最终最后一条非 system message。
- [x] provider body 不包含 `runtimeMessage` / metadata。

### Task MCS1.1: Add candidate helper

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/system-reminder/source.ts`
- Test: `apps/zcode-cli/packages/core/tests/system-reminder-source.test.ts`

- [x] **Step 1: 写 failing tests**

Add tests covering:

```ts
const excluded = new Set([
  "context_prefix",
  "target_continuation",
  "tool_result_warning",
  "goal_completion_verification",
]);
for (const source of SYSTEM_REMINDER_SOURCES) {
  expect(isMidConversationSystemSource(source)).toBe(!excluded.has(source));
}
```

- [x] **Step 2: Run failing tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/system-reminder-source.test.ts
```

Expected: FAIL because helpers do not exist.

- [x] **Step 3: Implement helpers**

Add source-level mid-conversation system candidate helper only. Do not add an unwrap helper; legacy wrapped messages must keep their original role:user shape, and structured attachment entries already carry raw body content.

```ts
const MID_CONVERSATION_SYSTEM_SOURCES = new Set<SystemReminderSource>([
  "skills_listing",
  "todo_reminder",
  "output_style",
  "date_change",
  "plan_mode_exit",
]);

export function isMidConversationSystemSource(source: SystemReminderSource): boolean {
  return MID_CONVERSATION_SYSTEM_SOURCES.has(source);
}
```

Do not add `prompt_attachment` here yet unless Phase MCS2 has changed it into an independent runtime entry.

- [x] **Step 4: Run tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/system-reminder-source.test.ts
```

Expected: PASS.

### Task MCS1.2: Project entry-level candidates to `role: "system"`

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts`
- Test: `apps/zcode-cli/packages/core/tests/provider-request-messages.test.ts`

- [x] **Step 1: Add tests for entry-level projection**

Add tests with expected provider messages:

```ts
it("moves skills listing after the first real user as a system message", () => {
  const entries = [
    entry({ role: "system", content: "prefix" }),
    entry(user("<system-reminder>\nskills\n</system-reminder>"), "skills_listing"),
    entry(user("<system-reminder>\n# currentDate\nToday\n</system-reminder>"), "context_prefix"),
    entry(user("real prompt"), "real_user"),
  ] satisfies RuntimeMessageEntry[];

  const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

  expect(result.messages).toEqual([
    { role: "system", content: "prefix", cacheControl: { type: "ephemeral" } },
    { role: "user", content: "<system-reminder>\n# currentDate\nToday\n</system-reminder>" },
    { role: "user", content: "real prompt", cacheControl: { type: "ephemeral" } },
    { role: "system", content: "skills" },
  ]);
});

it("projects todo and output style reminders to system without moving context prefix", () => {
  const entries = [
    entry(user("follow up"), "real_user"),
    entry(user("<system-reminder>\ntodo\n</system-reminder>"), "todo_reminder"),
    entry(user("<system-reminder>\nstyle\n</system-reminder>"), "output_style"),
    entry(user("<system-reminder>\nmode\n</system-reminder>"), "runtime_mode"),
  ] satisfies RuntimeMessageEntry[];

  const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

  expect(result.messages).toEqual([
    { role: "user", content: "<system-reminder>\nmode\n</system-reminder>" },
    { role: "user", content: "follow up", cacheControl: { type: "ephemeral" } },
    { role: "system", content: "todo\n\nstyle" },
  ]);
});
```

If cache-control should land before the projected trailing system, expected `cacheControlIndex` must point at the real user message. This is intentional because system messages are skipped.
The `runtime_mode` message remains user `<system-reminder>` and can still be reordered by the existing attachment-like projection because this plan does not migrate plan-mode-active reminders.

- [x] **Step 2: Run failing tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts
```

Expected: FAIL because candidate reminders remain user messages.

- [x] **Step 3: Implement projection pass**

Implementation shape:

```ts
interface PendingMidSystemEntry {
  entry: RuntimeMessageEntry;
  text: string;
}

function projectMidConversationSystemEntries(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  const projected: RuntimeMessageEntry[] = [];
  const delayedUntilNextRealUser: PendingMidSystemEntry[] = [];
  const trailingCurrentUser: PendingMidSystemEntry[] = [];

  const emitSystem = (pending: PendingMidSystemEntry[]) => {
    if (pending.length === 0) return;
    projected.push({
      message: {
        role: "system",
        content: pending.map((item) => item.text).join("\n\n"),
      },
    });
    pending.length = 0;
  };

  const emitOriginalEntries = (pending: PendingMidSystemEntry[]) => {
    for (const item of pending) {
      projected.push(item.entry);
    }
    pending.length = 0;
  };

  const flushTrailingBefore = (nextEntry: RuntimeMessageEntry) => {
    if (trailingCurrentUser.length === 0) return;
    if (canKeepMidConversationSystemBefore(nextEntry)) {
      emitSystem(trailingCurrentUser);
      return;
    }

    // 无法形成 "user -> system -> assistant/end/system" 结构时，
    // 保留原始 user reminder，避免为了调整 shape 而改变语义或丢内容。
    emitOriginalEntries(trailingCurrentUser);
  };

  const lastProjectedEntry = () => projected[projected.length - 1];
  const lastProjectedCanAnchor = () => {
    const entry = lastProjectedEntry();
    return entry ? isRealUserAnchorEntry(entry) : false;
  };

  for (const entry of entries) {
    const projectedText = midConversationSystemText(entry);
    if (projectedText !== undefined) {
      const pending = { entry, text: projectedText };
      if (lastProjectedCanAnchor()) {
        trailingCurrentUser.push(pending);
      } else {
        delayedUntilNextRealUser.push(pending);
      }
      continue;
    }

    flushTrailingBefore(entry);
    projected.push(entry);

    if (isRealUserAnchorEntry(entry)) {
      emitSystem(delayedUntilNextRealUser);
    }
  }

  if (trailingCurrentUser.length > 0) emitSystem(trailingCurrentUser);
  if (delayedUntilNextRealUser.length > 0) emitOriginalEntries(delayedUntilNextRealUser);

  return projected;
}
```

Use the actual imports/types available in the file. The important behavior is:

- candidate source + exact wrapper + pure string content becomes system text when a real user anchor exists;
- `skills_listing` before the first real user is delayed until that first real user is emitted;
- unsupported, invalid-shape, or invalid-position candidates remain original user reminders;
- no fallback path should create fake metadata or rely on literal tag alone.

Helper semantics to implement in the same file:

```ts
function isRealUserAnchorEntry(entry: RuntimeMessageEntry): boolean {
  if (entry.message.role !== "user" || isToolResultUserMessage(entry.message)) return false;
  return entry.metadata?.source === "real_user" || entry.metadata === undefined;
}

function canKeepMidConversationSystemBefore(nextEntry: RuntimeMessageEntry): boolean {
  const next = nextEntry.message;
  return (
    next.role === "assistant" ||
    next.role === "system" ||
    next.role === "tool" ||
    isToolResultUserMessage(next)
  );
}

function midConversationSystemText(entry: RuntimeMessageEntry): string | undefined {
  if (entry.kind !== "attachment") return undefined;
  const source = entry.metadata?.source;
  if (!source || !isKnownSystemReminderSource(source)) return undefined;
  if (!isMidConversationSystemSource(source)) return undefined;
  return entry.content;
}
```

`canKeepMidConversationSystemBefore(...)` intentionally returns false before another ordinary user message. This keeps the placement invariant: projected system messages should sit after a user anchor and before assistant/tool/system/end, not between two unrelated user prompts.

- [x] **Step 4: Prevent candidate entries from old bubble-before-prompt behavior**

Update `isAttachmentLikeUserEntry(...)` so `isMidConversationSystemSource(source)` returns false there. Candidate entries should not be bubbled before the user prompt; they are handled by the new projection pass.

- [x] **Step 5: Wire order inside `buildProviderRequestMessages(...)`**

Required order:

```ts
const entries = input.entries.map(cloneRuntimeMessageEntry);
const reorderResult = reorderAttachmentLikeEntries(entries);
const midSystemEntries = projectMidConversationSystemEntries(reorderResult.entries);
const latestRealUserMessageIndex = findLatestRealUserEntryIndex(midSystemEntries);
const cacheControlIndex = input.applyCacheControl === true
  ? finalizeLatestNonSystemCacheControl(midSystemEntries)
  : undefined;
const messages = midSystemEntries.map((entry) => cloneModelInputMessage(entry.message));
```

- [x] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts tests/system-reminder-source.test.ts
```

Expected: PASS.

### Task MCS1.3: Runtime source regression coverage

**Files:**

- Test: `apps/zcode-cli/packages/core/tests/runtime-reminders.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] **Step 1: Add/adjust tests proving reminder builders still return wrapped text**

The builders should still produce `<system-reminder>` internally:

```ts
expect(buildDateChangeReminder("2026-06-16", "2026-06-17")).toContain("<system-reminder>");
expect(buildPlanModeExitReminder()).toContain("## Exited Plan Mode");
expect(buildTodoReminder([])).toContain("TodoWrite");
```

Projection, not producer text, owns the channel migration.

- [x] **Step 2: Add runtime trace expectation**

Use an existing trace/helper test to assert final `ModelRequest.payload.messages` contains:

```ts
expect(messages.some((message) => message.role === "system" && includesText(message, "TodoWrite"))).toBe(true);
expect(JSON.stringify(messages)).not.toContain("runtimeMessage");
```

- [x] **Step 3: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-reminders.test.ts tests/runtime-trace.test.ts
```

Expected: PASS.

### MCS1 Prompt-trajectory E2E

- [x] Build required packages before prompt-trajectory:

```bash
pnpm --filter @zcode/core build
pnpm --filter @zcode/prompt-trajectory build
```

- [x] Run a first-turn case with skills enabled.
- [x] Run or synthesize a due todo reminder case.
- [x] Inspect output under `apps/zcode-cli/out/`.

Expected provider-visible shape:

```json
[
  { "role": "user", "content": "<system-reminder>...# currentDate...</system-reminder>" },
  { "role": "user", "content": "real prompt" },
  { "role": "system", "content": "The following skills are available..." }
]
```

For todo/output/date/plan-exit:

```json
{ "role": "system", "content": "..." }
```

No migrated message should still include `<system-reminder>`.

## Phase MCS1.5: Structured Runtime Attachment Entry

**Phase goal:** 把 MCS1 的 provider-visible 行为保留不变，但把内部表达从 wrapped user message 主路径改成结构化 attachment entry。Producer/测试可直接创建 `{ kind: "attachment", content, metadata: { source } }`，provider finalizer 再选择 `role: "system"` 或 user `<system-reminder>` fallback。

**User confirmation gate:** MCS1.5 完成 tests + prompt-trajectory + code review 后停止，等待用户确认进入 MCS2。

### Checklist

- [x] `RuntimeMessageEntry` 支持 `kind: "message"` 与 `kind: "attachment"`。
- [x] `MessageHistory.addAttachment(...)` 与 `systemReminderAttachmentEntry(...)` 可添加 source-aware attachment entry，raw body 不含 `<system-reminder>`。
- [x] `toModelMessages()` / legacy APIs 对 attachment entry 使用 user `<system-reminder>` fallback，保证现有调用方和存量 session 兼容。
- [x] `buildProviderRequestMessages(...)` 对 attachment entry 使用 raw body 投影为 `role: "system"`，不再依赖 request-time unwrap 作为主路径。
- [x] MCS1 sources 的 producers 迁移到 attachment entry：`skills_listing`、`todo_reminder`、`output_style`、`date_change`、`plan_mode_exit`。
- [x] `context_prefix`、`runtime_mode`、hook/memory/resume/rewind/background notification 继续保持 user `<system-reminder>`，不被本阶段迁移。
- [x] legacy wrapped synthetic entry 仍可 fallback 正常发送为 role:user；不从旧数据恢复 attachment，不做 exact unwrap 升级。
- [x] provider body 不泄漏 `kind`、`metadata.source` 或 attachment internal fields。

### Task MCS1.5.1: Add runtime attachment entry type

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/agent/message-history.ts`
- Test: `apps/zcode-cli/packages/core/tests/message-history.test.ts` or `apps/zcode-cli/packages/core/tests/provider-request-messages.test.ts`

- [x] **Step 1: 写 failing tests**

Add tests proving:

```ts
const history = createMessageHistory();
history.addAttachment("output_style", "style body");
expect(history.toRuntimeEntries()[0]).toMatchObject({
  kind: "attachment",
  metadata: { source: "output_style" },
  content: "style body",
});
expect(history.toModelMessages()[0]).toEqual({
  role: "user",
  content: "<system-reminder>\nstyle body\n</system-reminder>",
});
```

Expected: FAIL because attachment entry API/type does not exist.

- [x] **Step 2: Implement minimal type + clone/render helpers**

Target shape:

```ts
export type RuntimeMessageEntry =
  | {
      kind: "message";
      message: ModelInputMessage;
      metadata?: RuntimeMessageMetadata;
    }
  | {
      kind: "attachment";
      content: string;
      metadata: RuntimeMessageMetadata;
    };
```

Rules:

- `metadata.source` remains the only metadata field.
- Attachment entry `content` is raw body, never wrapped.
- `cloneRuntimeMessageEntry(...)` preserves `kind`.
- A helper such as `entryToModelInputMessage(...)` renders attachment entry to user `<system-reminder>` fallback for `toModelMessages()` and legacy provider paths.
- `countContextPrefixMessages(...)` treats prefix attachments with `source === "skills_listing"` the same as the old prefix user message.

- [x] **Step 3: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/message-history.test.ts tests/provider-request-messages.test.ts
```

Expected: PASS.

### Task MCS1.5.2: Project attachment entries without request-time unwrap

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts`
- Test: `apps/zcode-cli/packages/core/tests/provider-request-messages.test.ts`

- [x] **Step 1: 写 failing tests**

Update MCS1 projection tests to use attachment entries:

```ts
attachment("skills_listing", "skills")
attachment("todo_reminder", "todo")
attachment("output_style", "style")
```

Add explicit regression tests that use legacy message entries with `source: "output_style"` / `source: "todo_reminder"`; both non-wrapped and wrapped `<system-reminder>` content must stay as role:user. This proves mid-conversation system projection only accepts structured attachment entries.

- [x] **Step 2: Implement projection**

Update projection helpers:

- `midConversationSystemText(entry)` returns `entry.content` for `kind: "attachment"` + candidate source.
- For `kind: "message"`, do not project to mid-conversation system. Keep it provider-visible as its original message shape.
- `isAttachmentLikeUserEntry(...)`, `isRealUserAnchorEntry(...)`, `isToolResultUserMessage(...)`, cache-control finalization, and diagnostics must branch on `kind`.
- Provider-clean output maps attachment entry through final projection; unprojected attachment fallback becomes user `<system-reminder>`.

- [x] **Step 3: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts tests/system-reminder-source.test.ts
```

Expected: PASS.

### Task MCS1.5.3: Migrate MCS1 producers to attachment entries

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-reminders.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

- [x] **Step 1: 写 failing runtime trace tests**

Expect final provider body unchanged from MCS1:

- `skills_listing` appears as `role: "system"` after first real user.
- `todo_reminder` / `output_style` / `date_change` / `plan_mode_exit` appear as `role: "system"` when triggered.
- `runtime_mode` remains user `<system-reminder>`.
- No metadata/attachment internal fields leak.

- [x] **Step 2: Migrate producer calls**

Convert only the MCS1 white-list producers to attachment entries. Keep wrapper builders available for fallback and legacy paths.

- [x] **Step 3: Run focused tests + prompt-trajectory**

Run focused tests and regenerate:

```bash
pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts tests/runtime-reminders.test.ts tests/runtime-trace.test.ts
pnpm --filter @zcode/prompt-trajectory ...
```

Expected: provider-visible request bodies match MCS1 outputs; only internal implementation changed.

## Phase MCS1.6: Centralize Standalone System-reminder Wrapping

**Phase goal:** 继续 MCS1.5 的结构化 attachment 主路径，把仍然作为独立 synthetic/runtime user message 注入的 system-reminder source 迁移为 raw attachment entry。Producer 只产 raw body；最终 provider projection / legacy fallback 统一决定是否 wrap 成 user `<system-reminder>` 或投影为 `role: "system"`。

**User confirmation gate:** MCS1.6 完成 tests + prompt-trajectory + code review 后停止，等待用户确认进入 MCS2。

### Checklist

- [x] 迁移独立 message source：`context_prefix`、`runtime_mode`、`hook_context`、`relevant_memory`、`referenced_session_context`、`model_anomaly`、`resume_todo_state`、`resume_goal_state`、`rewind_notice`、`task_status`、`queued_system_notification`。
- [x] 保留 `prompt_attachment` 在 MCS2 单独处理，不在本阶段拆真实 user `content[]`。
- [x] 保留 wrapped formatter 作为 legacy/test/session fallback；新增 raw body formatter 给 attachment producer 使用。
- [x] session persistence / UI transcript 对 `task_status`、`queued_system_notification` 继续保存 raw notification payload，不改变展示文本。
- [x] provider-visible shape 与 MCS1.5 保持一致：非 mid-system source 仍是 user `<system-reminder>`；mid-system source 仍是 `role: "system"`。
- [x] `wrapSystemReminderForSource` 不再散落在上述 producer 注入点，只保留在 final fallback render、legacy wrapped formatter、tool-result/real content block 特例。
- [x] `ContextBuilder` 不再生成 wrapped meta-user messages；context prefix / skills listing 通过 raw `metaUserAttachments` 进入 runtime attachment projection。

### Task MCS1.6.1: Raw Body Builders for Standalone Sources

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts`
- Modify: `apps/zcode-cli/packages/core/src/memory/recall.ts`
- Modify: `apps/zcode-cli/packages/core/src/session-context/references.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/model-anomaly.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/rewind.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
- Test: existing focused tests plus new entry-shape assertions.

- [x] **Step 1: Write RED tests**

Add focused tests proving standalone producers store raw attachment entries while `toModelMessages()` keeps the same wrapped fallback.

- [x] **Step 2: Add raw body builders**

For each wrapped formatter used by a standalone producer, add a `*Body(...)` helper and keep the old wrapped function delegating to `wrapSystemReminderForSource(source, body)`.

- [x] **Step 3: Run focused tests**

Expected: body builders preserve existing provider-visible wording after fallback wrapping.

### Task MCS1.6.2: Migrate Injection Sites to `addAttachment`

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/memory-recall.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-tool-warnings.ts`

- [x] **Step 1: Replace standalone `addUser(wrappedReminder, metadata)` with `addAttachment(source, rawBody)`**

Do not migrate `prompt_attachment`.

- [x] **Step 2: Preserve persistence payloads**

`task_status` and `queued_system_notification` continue persisting raw notification text, not wrapped provider fallback.

- [x] **Step 3: Run focused tests + prompt-trajectory**

Expected: provider-visible request body unchanged from MCS1.5 for non-mid sources, and no runtime metadata leaks.

## Phase MCS1.7: Single Canonical Provider-visible Assembly Boundary

**Phase goal:** 删除 `MessageHistory` / entry helper 中会绕过 provider projection 的 model-visible render 出口。所有最终发送给 model provider、记录 provider request body、或用于 provider-visible token estimate 的 messages 都必须通过 `buildProviderRequestMessages(...)` 生成；会写回 `MessageHistory` 的逻辑必须保持 `RuntimeMessageEntry[]`，不能把 projected model messages 写回 history。

**User confirmation gate:** MCS1.7 完成 tests + prompt-trajectory + code review 后停止，等待用户确认进入 MCS2。

### Checklist

- [x] 删除 public `entryToModelInputMessage`，把 fallback render 收口为 `provider-request-messages.ts` 内部私有逻辑。
- [x] 删除 `MessageHistory.toModelMessages()` / `getCacheableMessages()` / `getIncrementalMessages()` 这些旁路 provider render API。
- [x] 所有 provider-visible request message 生成统一走 `buildProviderRequestMessages(...)`。
- [x] microcompact 改为 runtime-entry aware：输入/输出均为 `RuntimeMessageEntry[]`，清理 tool result content 时保留 attachment source metadata。
- [x] compact token / enough-history 判断若需要 model messages，只能用 canonical builder 的 read-only projection，不能写回 history。
- [x] tests 不再通过 `toModelMessages()` 断言 provider-visible 行为；改用 `toRuntimeEntries()` 或 `buildProviderRequestMessages(...)`。

### Task MCS1.7.1: Lock API Boundary with RED Tests

**Files:**

- Modify: `apps/zcode-cli/packages/core/tests/message-history.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/microcompact.test.ts`

- [x] **Step 1: Write RED tests**

Add tests proving:

- `MessageHistory` no longer exposes model-message render helpers (`toModelMessages`, `getCacheableMessages`, `getIncrementalMessages`).
- runtime-entry microcompact keeps structured attachment entries intact while clearing old tool result content.

- [x] **Step 2: Run focused tests**

Expected: FAIL before implementation because old APIs still exist and microcompact only accepts projected model messages.

### Task MCS1.7.2: Move Fallback Render into Canonical Builder

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/agent/message-history.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: affected tests.

- [x] **Step 1: Remove public render APIs**

Keep `MessageHistory` focused on runtime entries: `init`, `addUser`, `addAttachment`, `addAssistant`, `addToolResult`, `toRuntimeEntries`, `replaceMessages`, cache stats/reset.

- [x] **Step 2: Add private projected-entry renderer inside provider builder**

`buildProviderRequestMessages(...)` remains the only final provider-visible renderer and owns fallback user `<system-reminder>` wrapping.

- [x] **Step 3: Migrate tests**

Tests that need provider-visible output call `buildProviderRequestMessages({ entries: history.toRuntimeEntries() })`.

### Task MCS1.7.3: Runtime-entry-aware Compact/Microcompact

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts`
- Test: compact/microcompact focused suites.

- [x] **Step 1: Add runtime-entry microcompact adapter**

Use canonical projection only for token estimates; keep mutation on cloned `RuntimeMessageEntry[]`.

- [x] **Step 2: Replace compact read-only `toModelMessages()` calls**

Use `buildProviderRequestMessages({ entries: this.messageHistory.toRuntimeEntries(), applyCacheControl: false }).messages`.

- [x] **Step 3: Replace compact helper role checks**

Use runtime-entry role helpers instead of rendering entries just to inspect role.

- [x] **Step 4: Run focused tests + prompt-trajectory**

Expected: provider-visible request body matches MCS1.6; no non-incremental trajectory; microcompact no longer destroys attachment source metadata.

## Phase MCS2: Prompt Attachment / Read-file Synthetic Context Projection

**Phase goal:** 将 ZCode 自己生成的纯文本 attachment/read-file synthetic context 从真实 user `content[]` 中拆出，并在 provider body 中转为 user prompt 后的 `role: "system"` message。

**User confirmation gate:** MCS2 完成 tests + prompt-trajectory + code review 后停止，等待用户确认进入 MCS3。

### Checklist

- [x] 不用泛用 `<system-reminder>` tag 判断真实用户输入。
- [x] 纯文本 Read-like attachment reminder 转为 `role: "system"`。
- [x] 真实 user prompt、图片、local_ref、URL/resource text 保持 provider-visible。
- [x] source-less inline text attachment 也从新 live/hydrate 主路径拆成 raw `prompt_attachment` entry；旧 persisted content-block shape 仍保持兼容。
- [x] 存量 session/replay 如果只有旧 content block shape，仍能正常发送，不崩溃。

### Task MCS2.1: Introduce runtime entry builder for user turn content

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/conversation.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`
- Test: `apps/zcode-cli/packages/core/tests/prompt-attachments.test.ts`

- [x] **Step 1: Write failing tests**

Add tests for a text file attachment:

```ts
const entries = buildRuntimeUserEntriesFromTurn("Summarize notes.", [textFileAttachment]);

expect(entries).toEqual([
  {
    message: { role: "user", content: "Summarize notes." },
    metadata: { source: "real_user" },
  },
  {
    kind: "attachment",
    source: "prompt_attachment",
    body: "Called the Read tool ...",
  },
]);
```

For pasted images:

```ts
expect(entries[0]!.message.content).toEqual([
  { type: "text", text: "Describe screenshot." },
  { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,..." },
]);
expect(entries).toHaveLength(1);
```

- [x] **Step 2: Run failing tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/prompt-attachments.test.ts
```

Expected: FAIL because helper does not exist and attachment reminder is embedded in real user content.

- [x] **Step 3: Implement helper without changing persistence schema**

Add a helper that returns runtime entries for in-memory provider history. Build from `ResolvedTurnAttachment[]` directly instead of parsing the final `content[]`, so generated prompt attachment reminders carry `prompt_attachment` metadata from the source boundary.

Implemented shape:

- `buildRuntimeUserEntriesFromTurn(...)` returns one real-user message entry plus zero or more `systemReminderAttachmentEntry("prompt_attachment", rawBody)` entries.
- `prompt_attachment` raw bodies come from `buildPromptAttachmentReminderBodies(...)`; wrapping happens only in final provider projection fallback/legacy paths.
- `buildUserContentFromTurn(...)` remains a compatibility helper for existing persistence/model-only paths and keeps old provider-visible user content shape when called directly.

For hydrate/replay paths that only have old persisted `content[]` without attachment source metadata, do not block the main implementation. Add a narrow fallback only for exact ZCode-generated prompt attachment text if tests reveal a real regression. The fallback must not classify arbitrary user text solely because it starts with `<system-reminder>`.

- [x] **Step 4: Wire regular turn in-memory history**

In `executeTurn(...)`, replace:

```ts
this.messageHistory.addUser(userContent, realUserRuntimeMetadata());
```

with explicit addition of entries from `buildRuntimeUserEntriesFromTurn(...)`. If `MessageHistory` lacks a bulk append API, add a narrow `addEntries(entries)` method or append via existing `addUser(...)` calls while preserving metadata.

Do not change `persistUserPrompt(...)`; persistent session store should still store user prompt and attachments as before.

- [x] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/prompt-attachments.test.ts tests/runtime-trace.test.ts
```

Expected: PASS.

### Task MCS2.2: Project `prompt_attachment` entry to system

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/system-reminder/source.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts`
- Test: `apps/zcode-cli/packages/core/tests/provider-request-messages.test.ts`

- [x] **Step 1: Add `prompt_attachment` to candidate tests**

Update source helper test:

```ts
expect(isMidConversationSystemSource("prompt_attachment")).toBe(true);
```

Add provider projection test:

```ts
const entries = [
  entry(user("Summarize notes."), "real_user"),
  entry(
    user("<system-reminder>\nCalled the Read tool with the following input: {\"file_path\":\"notes.md\"}\n</system-reminder>"),
    "prompt_attachment",
  ),
];

const result = buildProviderRequestMessages({ entries });

expect(result.messages).toEqual([
  { role: "user", content: "Summarize notes." },
  {
    role: "system",
    content: "Called the Read tool with the following input: {\"file_path\":\"notes.md\"}",
  },
]);
```

- [x] **Step 2: Run failing tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/system-reminder-source.test.ts tests/provider-request-messages.test.ts
```

Expected: FAIL until `prompt_attachment` candidate is enabled.

- [x] **Step 3: Enable candidate**

Add `"prompt_attachment"` to `MID_CONVERSATION_SYSTEM_SOURCES`.

- [x] **Step 4: Run tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/system-reminder-source.test.ts tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts
```

Expected: PASS.

### MCS2 Prompt-trajectory E2E

Run a case with:

- real user prompt: `Summarize the attached notes and mention whether the URL is present.`
- text file attachment content
- URL/resource attachment if fixture supports it

Expected provider-visible shape:

```json
[
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "Summarize the attached notes and mention whether the URL is present."
      },
      {
        "type": "text",
        "text": "[Resource: https://example.com/ref]"
      }
    ]
  },
  {
    "role": "system",
    "content": "Called the Read tool with the following input: {\"file_path\":\"notes.md\"}\n\nResult of calling the Read tool:\n..."
  }
]
```

If URL/resource remains inside the real user content, that is expected because URL/resource is not a synthetic attachment surface and ZCode should not break it. The important part is that Read-like synthetic attachment context no longer appears as a user `<system-reminder>` block.

## Phase MCS3: Auxiliary Request Surface Audit

**Phase goal:** 确认 regular turn 之外的 provider request surfaces 没有绕过 projection，尤其 compact、target completion verification、prompt enhance、session title 等。

**User confirmation gate:** MCS3 完成后停止，汇报 remaining intentional gaps。

### Checklist

- [x] 所有使用 `buildProviderRequestMessages(...)` 的路径获得相同 projection。
- [x] 直接传 `historyEntriesToModelMessages(...)` 或 raw messages 的路径被审计；必要时补 projection 或说明为何不需要。
- [x] session title sidecar 不受影响。
- [x] compact active/manual request 中如包含 migrated sources，最终 provider body 也迁移。
- [x] target completion verification 中 `goal_completion_verification` 不被误迁移。

### Steps

- [x] **Step 1: 搜索 provider request construction**

Run:

```bash
rg -n "buildProviderRequestMessages|historyEntriesToModelMessages|runModelTextRequest\\(|messages:" apps/zcode-cli/packages/core/src/runtime apps/zcode-cli/packages/core/src/compact
```

Expected: 列出 regular turn、compact、target verification、prompt enhance、session title 等路径。

- [x] **Step 2: Audit each path**

For each path, record:

| Path | Uses projection? | Should migrate mid-system? | Action |
| --- | --- | --- | --- |
| regular turn | yes | yes | covered by MCS1/MCS2 |
| compact active/manual | yes | yes if conversation history includes candidate sources | covered by `buildCompactSummaryRequestMessages(...)` / active compact projection |
| target completion verification | yes | history attachments yes; verifier prompt no | verifier prompt remains plain transient user entry; no `goal_completion_verification` source migration |
| session title | direct system prompt | no | no change |
| prompt enhance | direct short request | no | no conversation runtime attachment source; no change |

- [x] **Step 3: Add targeted regression tests**

Add tests only for paths that can carry migrated sources. Do not over-test auxiliary requests that never include these sources.

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/compact-active.test.ts tests/runtime-tool-loop.test.ts tests/provider-request-messages.test.ts
```

Expected: PASS or adjust command to exact existing test files discovered in Step 1.

## Phase MCS4: Docs + Status Update

**Phase goal:** 更新本计划状态，明确哪些 source 已完成投影、哪些是 deliberate gap/postponed。

### Checklist

- [x] 更新本计划中 `skills_listing`、`todo_reminder`、`output_style`、`date_change`、`plan_mode_exit`、`prompt_attachment` 的状态。
- [x] 把已完成项标记为 completed，未来 feature 可扩展的项单独列出。
- [x] worklog 按天聚合补一段 brief，不新增碎片化 action part。
- [x] plan 中记录最终 prompt-trajectory out path。

### Steps

- [x] **Step 1: Update plan status**

Expected wording:

```md
在 first-party Opus 4.8 / mid-conversation-system enabled assumption 下，ZCode 已在 provider request projection 阶段把 source-aware meta reminders 投影为 `messages[].role = "system"`。request-level userContext/currentDate/user instructions 仍保持 user `<system-reminder>`，这是有意保留的形态。
```

- [x] **Step 2: Update worklog**

Append/update the current day section with one compact paragraph:

```md
- Mid-conversation system projection：在不改 provider header 的前提下，把 skills/todo/output/date/plan-exit/prompt attachment 等 provider-visible meta reminders 从 user `<system-reminder>` 投影为 mid-history `role: system`；request-level userContext 和未确认 surfaces 保持现状。
```

- [x] **Step 3: Run docs diff check**

Run:

```bash
git diff -- apps/zcode-cli/docs/plan/trajectory apps/zcode-cli/worklogs/trajectory-align-log.md
```

Expected: 只有本 feature 相关文档变化。

## Final Verification

Before asking for user review, run:

```bash
pnpm --filter @zcode/core exec vitest run tests/system-reminder-source.test.ts tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/runtime-reminders.test.ts tests/runtime-trace.test.ts
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/core lint
```

Then run prompt-trajectory e2e cases and place outputs under:

```text
apps/zcode-cli/out/mid-conversation-system-projection-<timestamp>/
```

Final provider-visible acceptance checklist:

- [x] `skills_listing` appears as `role: "system"` after the first real user prompt.
- [x] request-level `context_prefix` remains user `<system-reminder>`.
- [x] `todo_reminder` appears as `role: "system"` and no longer includes `<system-reminder>`.
- [x] `output_style` appears as `role: "system"` when active and no longer includes `<system-reminder>`.
- [x] `date_change` appears as `role: "system"` on follow-up after local date changes and no longer includes `<system-reminder>`.
- [x] `plan_mode_exit` appears as `role: "system"` when triggered and no longer includes `<system-reminder>`.
- [x] text-file `prompt_attachment` / Read synthetic context appears as `role: "system"` after the real user prompt.
- [x] URL/resource and non-text attachments are not broken or dropped.
- [x] cache-control is on the final last non-system message.
- [x] provider body contains no `runtimeMessage`, `metadata.source`, or internal projection markers.
- [x] no Anthropic beta/header logic was added.

## Execution Notes

Fill this section during implementation:

| Phase | Tests | Prompt-trajectory output | Review result |
| --- | --- | --- | --- |
| MCS0 | `node node_modules/.pnpm/vitest@4.1.5_@opentelemetry+api@1.9.1_@types+node@24.12.3_@vitest+coverage-v8@4.1.5_vit_ab68c939272bc583e30e7d15e0f45a30/node_modules/vitest/vitest.mjs run packages/core/tests/provider-request-messages.test.ts packages/core/tests/prompt-attachments.test.ts packages/core/tests/runtime-reminders.test.ts` PASS: 3 files / 31 tests. `pnpm --filter @zcode/core ... vitest` 当前因本地 `node_modules/.bin/vitest` 指向缺失包而失败，未安装依赖。`runtime-reminders.test.ts` 覆盖 todo reminder cadence/文案；prompt-trajectory 暂不硬造 10-turn TodoWrite cadence。 | `apps/zcode-cli/out/mid-conversation-system-projection-mcs0/sr9-runtime/trajectories/0001.anthropic_request_body.json`; `apps/zcode-cli/out/mid-conversation-system-projection-mcs0/sr12-attachments/trajectories/0001.anthropic_request_body.json`. 临时 mock fixtures 放在 `apps/zcode-cli/out/mid-conversation-system-projection-mcs0/fixtures/`，只用于 baseline evidence。 | 当前 baseline：Anthropic 派生体中 `skills_listing` / `currentDate` / `plan_mode active` / `output_style` 仍作为 user `<system-reminder>` content；follow-up 中 `output_style` 在真实 follow-up prompt 前；text file attachment 的 Read call/result 仍在真实 user `content[]` 内，URL resource 未被破坏。MCS0 不改实现代码，等待进入 MCS1。 |
| MCS1 | RED/GREEN: `system-reminder-source.test.ts` failed on missing helpers, then PASS 12 tests; `provider-request-messages.test.ts` failed on user-wrapped candidates and delayed-prefix/current-turn anchor bug, then PASS 13 tests; `runtime-reminders.test.ts` + `runtime-trace.test.ts` PASS 33 tests. Final focused set: `node node_modules/.pnpm/vitest@4.1.5_@opentelemetry+api@1.9.1_@types+node@24.12.3_@vitest+coverage-v8@4.1.5_vit_ab68c939272bc583e30e7d15e0f45a30/node_modules/vitest/vitest.mjs run packages/core/tests/system-reminder-source.test.ts packages/core/tests/provider-request-messages.test.ts packages/core/tests/runtime-reminders.test.ts packages/core/tests/runtime-trace.test.ts` PASS: 4 files / 58 tests. Build/typecheck: `node node_modules/typescript/lib/tsc.js -p apps/zcode-cli/packages/core/tsconfig.json` PASS. `pnpm --filter @zcode/core lint` failed because local package bin could not resolve `oxlint`; direct root oxlint also matched 0 files under current ignore/path rules. | `apps/zcode-cli/out/mid-conversation-system-projection-mcs1/sr9-runtime/trajectories/0001.openai_request_body.json`; `apps/zcode-cli/out/mid-conversation-system-projection-mcs1/sr12-attachments/trajectories/0001.openai_request_body.json`; `apps/zcode-cli/out/mid-conversation-system-projection-mcs1/todo-reminder-cadence/trajectories/0001.openai_request_body.json`. Temporary MCS1 todo fixture is under `apps/zcode-cli/out/mid-conversation-system-projection-mcs1/fixtures/`. | `skills_listing`、`output_style`、`todo_reminder` 在 mock provider body 中均为 `role: "system"` 且不含 `<system-reminder>`；`context_prefix` / `runtime_mode` 仍保持 user `<system-reminder>`；MCS2 范围内的 Read attachment synthetic context 仍在 user `content[]`，URL resource 保持可见；provider body 未泄漏 `runtimeMessage` / descriptor fields。 |
| MCS1.5 | RED/GREEN: `message-history.test.ts` failed on missing `addAttachment`, then PASS 4 tests; `runtime-reminders.test.ts` failed on missing raw body builders, then PASS 16 tests. Final focused set: `node node_modules/.pnpm/vitest@4.1.5_@opentelemetry+api@1.9.1_@types+node@24.12.3_@vitest+coverage-v8@4.1.5_vit_ab68c939272bc583e30e7d15e0f45a30/node_modules/vitest/vitest.mjs run packages/core/tests/message-history.test.ts packages/core/tests/provider-request-messages.test.ts packages/core/tests/runtime-reminders.test.ts packages/core/tests/runtime-trace.test.ts packages/core/tests/system-reminder-source.test.ts` PASS: 5 files / 64 tests. `runtime-tool-loop.test.ts` PASS: 59 tests. Core typecheck: `node node_modules/typescript/lib/tsc.js -p apps/zcode-cli/packages/core/tsconfig.json --noEmit` PASS. | `apps/zcode-cli/tools/prompt-trajectory/out/mid-conversation-system-mcs15/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`; no `*-non-incremental-change*` files. Because prompt-trajectory loads `@zcode/core/dist`, e2e used direct `node ../../node_modules/typescript/lib/tsc.js -p packages/core/tsconfig.json` to refresh core dist; recursive pnpm build remains blocked by missing package-script `tsc` shim. | `skills_listing` and both `output_style` entries are `role: "system"` raw body; `runtime_mode` and request-level `context_prefix` remain user `<system-reminder>`; provider body does not leak `kind` / `metadata.source` / runtime descriptor fields. `todo_reminder` and `date_change` producer/body/projector paths are covered by focused tests; SR9 fixture does not naturally trigger them. |
| MCS1.6 | RED/GREEN: `runtime-reminders.test.ts` failed on unsafe raw rewind body containing literal system-reminder tags, then PASS after shared body sanitization; focused set `runtime-reminders.test.ts` / `read-session-context-tool.test.ts` / `message-history.test.ts` / `session-history-hydrator.test.ts` PASS: 4 files / 44 tests. Wider set `runtime-tool-loop.test.ts` / `runtime-trace.test.ts` / `provider-request-messages.test.ts` / `system-reminder-source.test.ts` / `subagent-explore.test.ts` PASS: 5 files / 112 tests. Core typecheck: `node ../../node_modules/typescript/lib/tsc.js -p packages/core/tsconfig.json --noEmit` PASS. `git diff --check` PASS. `pnpm --filter @zcode/core lint` still fails because package script cannot resolve `oxlint`; direct `../../node_modules/oxlint/bin/oxlint packages/core/src` matches 0 files under current ignore/path rules. | `apps/zcode-cli/tools/prompt-trajectory/out/mid-conversation-system-mcs16/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`; no `*non-incremental*` files. Core dist refreshed with `node ../../node_modules/typescript/lib/tsc.js -p packages/core/tsconfig.json` before recording. | Standalone producer injection points now add raw attachment entries for `context_prefix`、`runtime_mode`、`hook_context`、`relevant_memory`、`referenced_session_context`、`model_anomaly`、`resume_todo_state`、`resume_goal_state`、`rewind_notice`、`task_status`、`queued_system_notification`; `prompt_attachment` remains MCS2. Provider body shape stays stable: `context_prefix` / `runtime_mode` remain user `<system-reminder>` fallback, `skills_listing` / `output_style` remain raw `role: "system"`, and request body does not leak `runtimeMessage` / `kind` / system-reminder source metadata. |
| MCS1.7 | RED/GREEN: `message-history.test.ts` failed while `toModelMessages` / `getCacheableMessages` / `getIncrementalMessages` still existed; `microcompact.test.ts` failed while runtime-entry microcompact helper did not exist. After implementation, focused set `message-history.test.ts` / `microcompact.test.ts` / `session-history-hydrator.test.ts` / `session-history-rewind.test.ts` PASS: 4 files / 32 tests. Wider set `message-history.test.ts` / `microcompact.test.ts` / `session-history-hydrator.test.ts` / `session-history-rewind.test.ts` / `provider-request-messages.test.ts` / `runtime-reminders.test.ts` / `runtime-trace.test.ts` / `runtime-tool-loop.test.ts` / `runtime-compact.test.ts` / `system-reminder-source.test.ts` / `subagent-explore.test.ts` PASS: 11 files / 186 tests. Core typecheck and dist build PASS with `node ../../node_modules/typescript/lib/tsc.js -p packages/core/tsconfig.json`. `git diff --check` PASS. `pnpm --filter @zcode/core lint` still fails because package script cannot resolve `oxlint`; direct `../../node_modules/oxlint/bin/oxlint packages/core/src` matches 0 files under current ignore/path rules. | `apps/zcode-cli/tools/prompt-trajectory/out/mid-conversation-system-mcs17/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`; no `*non-incremental*` files. | `MessageHistory` no longer exposes provider-visible render helpers; public `entryToModelInputMessage` and `historyEntriesToModelMessages` are removed. Final provider-visible messages are generated only by `buildProviderRequestMessages(...)`. Microcompact now writes back `RuntimeMessageEntry[]` and preserves attachment source metadata while clearing old tool results. Provider body shape stays stable against MCS1.6: `context_prefix` / `runtime_mode` remain user `<system-reminder>` fallback, `skills_listing` / `output_style` remain raw `role: "system"`, and runtime metadata does not leak. |
| MCS1.7 follow-up | TDD RED: `session-history-hydrator.test.ts` failed while persisted `task_status` / `queued_system_notification` synthetic text still hydrated into attachment entries. GREEN: `provider-request-messages.test.ts` / `session-history-hydrator.test.ts` PASS: 2 files / 35 tests. Wider focused set `message-history.test.ts` / `provider-request-messages.test.ts` / `session-history-hydrator.test.ts` / `runtime-reminders.test.ts` / `runtime-trace.test.ts` / `runtime-tool-loop.test.ts` / `system-reminder-source.test.ts` / `subagent-explore.test.ts` PASS: 8 files / 154 tests. Core typecheck PASS with `node ../../node_modules/typescript/lib/tsc.js -p packages/core/tsconfig.json --noEmit`; dist refresh PASS with `node ../../node_modules/typescript/lib/tsc.js -p packages/core/tsconfig.json`; `git diff --check` PASS. `pnpm --filter @zcode/core lint` still fails because package script cannot resolve `oxlint`. | `apps/zcode-cli/tools/prompt-trajectory/out/mid-conversation-system-no-hydrate-bridge/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`; no `*non-incremental*` files. Direct `tsx` path was used because package script could not resolve local `tsx` bin. | Latest decision: hydrate/replay does not bridge old synthetic user system-reminder text into runtime attachment entries and provider projection does not exact-unwrap legacy message entries into mid-conversation system. Only new runtime attachment entries participate in mid-system projection; old session data keeps role:user shape. |
| MCS1.7 context-builder cleanup | TDD RED: `context-builder.test.ts` / `message-history.test.ts` failed while `ContextBuilder` still exposed meta-user context through wrapped user messages. GREEN focused set `context-builder.test.ts` / `message-history.test.ts` / `skill-tool.test.ts` PASS: 3 files / 33 tests. Wider focused set `message-history.test.ts` / `context-builder.test.ts` / `skill-tool.test.ts` / `provider-request-messages.test.ts` / `runtime-reminders.test.ts` / `runtime-trace.test.ts` / `runtime-tool-loop.test.ts` / `session-history-hydrator.test.ts` / `subagent-explore.test.ts` PASS: 9 files / 170 tests. Core typecheck and dist refresh PASS with `node ../../node_modules/typescript/lib/tsc.js -p packages/core/tsconfig.json`; `git diff --check` PASS. `pnpm --filter @zcode/core lint` still fails because package script cannot resolve `oxlint`. | `apps/zcode-cli/tools/prompt-trajectory/out/mid-conversation-system-context-builder-raw-attachments/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`; no `*non-incremental*` files. | `ContextBuilder` now returns `systemMessages` plus raw `metaUserAttachments`; runtime converts those attachments with `systemReminderAttachmentEntry(...)`. This removes the old context-prefix metadata shift and prevents builder-level wrapped reminder producers from becoming a parallel projection path. Provider body shape stays expected: `context_prefix` remains user `<system-reminder>`, while `skills_listing` / `output_style` remain `role: "system"`. |
| MCS1.8 source expansion + generic adjacent user merge | TDD RED: `provider-request-messages.test.ts` / `system-reminder-source.test.ts` failed while MCS source set still excluded `runtime_mode`/hook/memory/history/meta-event sources and adjacent user merge only ran on fallback. GREEN focused set `provider-request-messages.test.ts` / `system-reminder-source.test.ts` PASS: 2 files / 31 tests. Wider focused set `provider-request-messages.test.ts` / `system-reminder-source.test.ts` / `message-history.test.ts` / `context-builder.test.ts` / `runtime-reminders.test.ts` / `runtime-trace.test.ts` / `microcompact.test.ts` / `session-history-hydrator.test.ts` PASS: 8 files / 117 tests. Core typecheck PASS with `node /Users/dev/Desktop/Z/z-code/apps/zcode-cli/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json`; dist refresh PASS with the same TypeScript entry without `--noEmit`; `git diff --check` PASS. | `apps/zcode-cli/tools/prompt-trajectory/out/mcs-expanded-sources-adjacent-merge-single/test20260618-030559/system-reminder-sr9-runtime/trajectories/0001.openai_request_body.json`; no `*non-incremental*` files. | `context_prefix` remains merged into the current user message as user `<system-reminder>`; `skills_listing`、`runtime_mode`、`output_style` project as `role: "system"` after the first user prompt; final projection now always merges adjacent user messages. |
| MCS2 | RED/GREEN: `prompt-attachments.test.ts` failed while `buildRuntimeUserEntriesFromTurn(...)` did not exist, then PASS after adding source-owned runtime entries; follow-up RED/GREEN covered source-less inline text live turn and hydrate drift. Focused set `provider-request-messages.test.ts` / `prompt-attachments.test.ts` / `runtime-persistence.test.ts` PASS: 3 files / 57 tests; `prompt-attachments.test.ts` / `session-history-hydrator.test.ts` / `runtime-persistence.test.ts` PASS after the source-less fix: 3 files / 55 tests. Additional focused set `provider-request-messages.test.ts` / `prompt-attachments.test.ts` / `system-reminder-source.test.ts` and runtime reminder/trace/persistence sets pass in this phase. Core dist refreshed with `node ../../node_modules/typescript/lib/tsc.js -p packages/core/tsconfig.json` before recording. | `apps/zcode-cli/out/mid-conversation-system-mcs2-20260619-015308/sr12-attachments/trajectories/0001.openai_request_body.json`; `apps/zcode-cli/out/mid-conversation-system-mcs2-20260619-015308/sr12-attachments/trajectories/0001.anthropic_request_body.json`; no `*non-incremental*` or diff artifact files. | New regular turns and session hydrate split Read-like text file attachments and source-less inline text attachments into raw `prompt_attachment` attachment entries. Final provider-visible shape: real user message keeps prompt + URL/resource placeholder, followed by `role: "system"` attachment context without `<system-reminder>` wrapper. Pasted inline images remain in the real user entry; legacy/persisted old content-block shape is not upgraded and remains compatible. |
| MCS3 | Focused set `../../node_modules/.bin/vitest run --config vitest.config.ts packages/core/tests/system-reminder-source.test.ts packages/core/tests/provider-request-messages.test.ts packages/core/tests/prompt-attachments.test.ts packages/core/tests/runtime-reminders.test.ts packages/core/tests/runtime-trace.test.ts packages/core/tests/runtime-persistence.test.ts packages/core/tests/session-history-hydrator.test.ts` PASS: 7 files / 123 tests. Core typecheck `../../node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit` PASS. `git diff --check` PASS. Recursive `pnpm --filter @zcode/bootstrap^... build` remains blocked by local package-script `tsc` resolution under Node v25.6.0, so core dist was refreshed directly with `../../node_modules/.bin/tsc -p packages/core/tsconfig.json` before prompt-trajectory. | `apps/zcode-cli/out/mid-conversation-system-mcs3-audit/sr12-attachments/trajectories/0001.anthropic_request_body.json`; no `*non-incremental*` files. | Auxiliary request audit complete. Regular turn、compact active/manual、compact helper、target completion verification 均走 `buildProviderRequestMessages(...)`；session title sidecar 与 prompt enhance 是独立短请求，不携带 runtime attachment entries。新增 compact migrated-source regression 和 target verifier plain-user regression；本 phase 无需生产逻辑改动。SR12 trajectory 确认 Read-like attachment context 在 Anthropic `system[]` 中，真实 user content 保留 currentDate、用户 prompt 与 URL resource。 |
| MCS4 | Docs-only phase; no production code changed after MCS3. Final focused set `../../node_modules/.bin/vitest run --config vitest.config.ts packages/core/tests/system-reminder-source.test.ts packages/core/tests/provider-request-messages.test.ts packages/core/tests/prompt-attachments.test.ts packages/core/tests/runtime-reminders.test.ts packages/core/tests/runtime-trace.test.ts packages/core/tests/runtime-persistence.test.ts packages/core/tests/session-history-hydrator.test.ts` PASS: 7 files / 123 tests. Core typecheck `../../node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit` PASS. `git diff --check` PASS. | Final evidence remains `apps/zcode-cli/out/mid-conversation-system-mcs3-audit/sr12-attachments/trajectories/0001.anthropic_request_body.json`; no `*non-incremental*` files. | Updated system trajectory diff、system-reminder report、overall prompt assembly Active/Future/Readiness tables, and worklog to the first-party Opus 4.8 / MCS enabled status. `P-27` moved out of Active into current-scope-resolved / future feature gaps; current active MCS surfaces are documented as `role: "system"` / Anthropic `system[]`, while request-level `context_prefix` remains user `<system-reminder>`. |
| MCS-FU1 | TDD RED: `prompt-attachments.test.ts` failed while legacy `buildUserContentFromTurn(...)` still emitted `[Attached text/plain: missing.md]` for text file read failure. GREEN focused set `../../node_modules/.bin/vitest run --config vitest.config.ts packages/core/tests/prompt-attachments.test.ts packages/core/tests/provider-request-messages.test.ts` PASS: 2 files / 32 tests. | No prompt-trajectory run needed; this is a focused legacy helper regression and the runtime entry path was already source-aware. | A file attachment that fails read/validation is dropped from the attachment list instead of becoming a provider-visible placeholder. ZCode now applies this to failed text file placeholders while preserving image placeholders, URL/resource links, local_ref file references, and source-less inline text attachment reminders. |
| MCS-FU2 | Adapter MCS/provider-body focused set PASS: 3 files / 34 tests；prompt-trajectory tool unit set PASS；fixture JSON 与最终 provider-body 机器断言 PASS。 | `apps/zcode-cli/out/mid-conversation-system-fixture-fix-ucUXfD/sr11/trajectories/0004-non-incremental-change.openai_request_body.json`；`apps/zcode-cli/out/mid-conversation-system-fixture-fix-ucUXfD/sr12/trajectories/0001.anthropic_request_body.json`。 | SR11 使用当前 `Async agent launched successfully.`、固定 Explore 继承 main model，并分别响应自动 notification continuation 与后续 user turn；SR12 使用 Anthropic / `claude-opus-4-8-cc`，最终 `messages[].role === "system"` 的 `content` 为 string，顶层 `system[]`、user content blocks 与 URL resource 保持不变。 |
