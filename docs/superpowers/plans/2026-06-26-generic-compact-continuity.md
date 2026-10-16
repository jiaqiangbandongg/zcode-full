# 通用 Compact Provider-Visible 收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not auto-commit, do not push, and leave all implementation changes unstaged for review.

**Goal:** 收敛 ZCode 现有通用 compaction 流程的 provider-visible content（compact prompt、summary 后处理、post-compact 上下文组装），提升 compact 后继续任务的完整性。

**Architecture:** 不新增模型专用分支或模型专用配置；直接更新现有 compact prompt、summary 后处理、post-compact message 组装、recent-context 保留、read-state/file reminder 恢复和 compact summary output cap。实现只落本计划冻结的 compact 逻辑/策略，不自行新增策略、抽象或配置开关。UI 投影继续把 compact 展示成一根 `context_compaction` divider，底层 provider-visible 保留 recent messages 不应改变聊天 UI。

**Tech Stack:** TypeScript, Vitest, `apps/zcode-cli/packages/core`, `@zcode/contracts`, provider-visible request tests, existing compact/session persistence stores.

## Global Constraints

- 不实现 provider/server 侧 compaction 能力：跳过 Anthropic API 的 `context_management`、`compact_20260112`、SDK `compactionControl`、server compaction、cache edit/cache write/cache prefix sharing。
- 不过度设计，不灵机一动：每个行为改动都必须能指向本计划冻结的 provider-visible fixture/合同测试证据；证据不足时记录 gap 并停在最小实现，不新增计划外策略。
- 不新增“看起来更稳”的 fallback、heuristic、config switch、policy abstraction 或模型分支，除非它是本计划 compact 路径中已明确且未被 skip 的逻辑。
- 优先修改现有 compact 文件和现有 helper；只有当目标行为所需状态无法清晰落在既有边界内时才允许最小拆分，并在 task 中写明依据和调用点。
- 避免 patch on patch：如果同一处代码需要继续叠加 `if`/`else if`/`else` 分支才能实现目标行为，先把该处收敛成清晰的现有边界内 helper/数据流，再落目标行为；重构只服务于降低分支复杂度和表达目标策略，不做顺手架构升级。
- Compact summary request 需要保留正常工具列表，使 provider-visible shape 与普通轮一致并尽量复用 provider cache；禁止工具使用必须通过 compact-specific tool-call denial 实现，不能通过 `tools: []` 实现。
- 不引入新的环境变量名或内部 flag 名；若需要配置，复用 ZCode 现有 `compact` config。
- 不新建模型专用 policy 文件；所有改动进入现有通用 compact 路径。
- 不改变 UI compact 展示语义：summary user message 仍 model-only，UI 仍只渲染 divider。
- 实现时不自动 commit、不 push；完成后保持 unstaged，等待人工 review。
- 修改实现前先补测试；每个任务完成后运行对应 Vitest，最后运行 `pnpm typecheck` 和 `pnpm lint`。

---

## Explicit Skip List

- Server/API side compaction: Anthropic API 的 `compact_20260112`、`context_management`、`compaction_delta` 只作为排除项记录。
- Cache edit/cache write/cache sharing: 不做 request cache-control 之外的 cache 行为；但 compact request 保留正常 tools shape 是本计划范围内的 provider-visible 要求，不属于 cache edit/server 能力。
- 外部 compact hooks：`PreCompact`/`PostCompact` hook 的外部能力不做；只保留 ZCode 已有事件/日志。
- REPL VM 文案：ZCode 没有 REPL VM state，不新增虚假提示；只预留可选参数。
- Transcript recovery 文案：ZCode 当前没有 full transcript path 能力，post-compact summary message 不注入 `read the full transcript at: ...`。
- `context_hint`/server-assisted microcompact：ZCode 当前没有对应接口；local microcompact 不作为本轮 provider-visible 收敛的默认目标。

## File Map

- Modify: `apps/zcode-cli/packages/core/src/compact/prompt.ts`  
  负责 full/recent compact prompt、summary text 格式化、post-compact continuation message。
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts`  
  负责 compact entry selection、recent groups preservation、post-compact entries、todo/reminder placement、existing prompt-too-long handling reuse。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`  
  负责 active compact 主流程接入 recent selection、read-state restore、summary output cap、media handling evidence gate、compact request tool exposure。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active-helpers.ts`  
  负责 compact request assembly、summary validation、tool-call rejection。
- Modify: `apps/zcode-cli/packages/core/src/compact/policy.ts`  
  负责保留 ZCode 已验证的 auto threshold/output reserve 默认值，并只调整 compact summary request output cap。
- Modify only if needed: `apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts` and `apps/zcode-cli/packages/core/src/compact/microcompact.ts`  
  local microcompact 改动明确跳过；只允许保留现有 opt-in/安全修复，不把它扩大成本轮 compact provider-visible 收敛目标。
- Modify: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`  
  覆盖 provider-visible compact request/post-compact request、recent preservation、read-state restore、UI model-only invariants。
- Modify: `apps/zcode-cli/packages/core/tests/compact-policy.test.ts` and `apps/zcode-cli/packages/core/tests/microcompact.test.ts`  
  覆盖 threshold 与 microcompact 策略变化。
- Modify: `apps/zcode-cli/tools/prompt-trajectory/tests/derive.test.ts`  
  更新 compact summary message shape 的 trajectory expectation。

## Task 1: 收敛 Compact Prompt 与 Summary Message Shape

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/compact/prompt.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`
- Test: `apps/zcode-cli/tools/prompt-trajectory/tests/derive.test.ts`

**Interfaces:**
- Produce: `buildCompactPrompt(customInstructions, { mode?: "full" | "recent" | "up_to" })`
- Produce: `formatCompactSummary(text)` returns text shaped as `Summary:\n...` when `<summary>` exists.
- Produce: `buildCompactSummaryMessage(summary, options)` accepts `{ suppressFollowup?: boolean; transcriptPath?: string; recentMessagesPreserved?: boolean; replStateCleared?: boolean }`.

- [ ] Add tests asserting full prompt contains these exact semantic anchors:
  - `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.`
  - `Tool calls will be REJECTED and will waste your only turn`
  - `Preserve any security-relevant instructions or constraints verbatim`
  - `Current Work`
  - `Optional Next Step`
- [ ] Add tests asserting recent prompt contains:
  - `RECENT portion of the conversation`
  - `The earlier messages are being kept intact and do NOT need to be summarized`
  - `All user messages from the recent portion`
- [ ] Add tests asserting `formatCompactSummary("<analysis>x</analysis><summary>abc</summary>") === "Summary:\nabc"`.
- [ ] Add tests asserting `buildCompactSummaryMessage("Summary:\nabc", { suppressFollowup: true })` includes:
  - `ran out of context`
  - `covers the earlier portion`
  - `Resume directly`
  - does not include transcript recovery text unless a future ZCode transcript path capability is explicitly added.
- [ ] Implement prompt text in `prompt.ts` using existing file, not a new model-specific policy module.
- [ ] Run: `pnpm vitest run apps/zcode-cli/packages/core/tests/runtime-compact.test.ts apps/zcode-cli/tools/prompt-trajectory/tests/derive.test.ts`

## Task 2: Align Compact Request Tool Exposure and Tool Call Denial

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active-helpers.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`

**Interfaces:**
- Produce: `buildCompactSummaryRequestOptions(...)` or equivalent helper that returns normal `tools: this.getTools()` and compact metadata.
- Produce: compact-specific tool-call denial path: any model tool call during compact is rejected before tool execution and surfaces as `CoreErrorType.ModelError` with message `Compact summary model attempted to call tools`.
- Consume: existing `formatCompactSummaryOrThrow(runtime, result)` for final validation.

- [ ] Add failing test: compact summary request includes the same visible tool contracts as a normal turn when tools are registered.
- [ ] Add failing test: compact summary request does not execute a tool if the model returns a tool call; the runtime records compact failure and no tool result part is persisted.
- [ ] Add failing test: provider-visible compact prompt still contains the no-tools warning even though tools are present in the request.
- [ ] Replace `tools: []` in `compact-active.ts` with the normal compact-visible tool list, usually `this.getTools()`.
- [ ] Keep compact execution single-turn summary-only: if `runtime.extractToolCallsFromResult(result)` returns any tool call, fail/retry through existing compact error path; do not schedule `ToolExecutor`.
- [ ] Ensure `ModelRequest` event `toolCount` reflects the actual exposed compact tools, not zero.
- [ ] Run: `pnpm vitest run apps/zcode-cli/packages/core/tests/runtime-compact.test.ts -t "compact"`

## Task 3: Implement Recent Group Preservation for Auto/Reactive Compact

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`

**Interfaces:**
- Produce: `selectCompactEntries(input)` returning:
  - `entriesForSummary: RuntimeMessageEntry[]`
  - `preservedEntries: RuntimeMessageEntry[]`
  - `groupsPreserved: number`
  - `totalGroups: number`
- Consume: `buildPostCompactRuntimeEntries(activeEntries, summaryEntry, { preservedEntries, postCompactReminderEntries })`.

- [ ] Add failing test: reactive compact after context overflow summarizes older turns but preserves latest assistant/tool/user group verbatim in the retry request.
- [ ] Add failing test: auto compact before a user request still excludes the pending user request from the summary request and includes it in the post-compact request.
- [ ] Update grouping helper to split conversation rounds by assistant turn boundary where available; if runtime entries lack assistant IDs, use stable role-order grouping that keeps assistant tool calls with their tool results.
- [ ] For `CompactTrigger.Auto` and `CompactTrigger.Reactive`, preserve at least the newest complete group plus any trailing pending user entries.
- [ ] Keep active/reactive compact summary requests on the full compact prompt even when recent groups are preserved; recent messages are preserved in the post-compact context, not by switching the summary prompt to a recent-only prompt.
- [ ] Persist `keptMessageCount`, `groupsPreserved`, and `totalGroups` in compact boundary metadata when available.
- [ ] Run: `pnpm vitest run apps/zcode-cli/packages/core/tests/runtime-compact.test.ts -t "compact"`

## Task 4: Restore Recent File Context After Compact

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/read-file-state-hydrator.test.ts`

**Interfaces:**
- Produce: `buildPostCompactReadStateReminderEntries(input)` returning model-only `RuntimeMessageEntry[]`.
- Input includes `readFileState`, `workspaceRoot`, `workingDirectory`, `maxFiles = 5`, `maxTotalApproxTokens = 50_000`, `maxFileApproxTokens = 5_000`.

- [ ] Add failing test: after reading a small file and compacting, the next provider request contains a model-only reminder with the file path and current contents, after the summary message.
- [ ] Add failing test: after reading a too-large file and compacting, the next provider request contains `Note: <path> was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`
- [ ] Add failing test: compact does not expose plan file, memory file, or denied path through recent-file reminders.
- [ ] Implement selection from current runtime `readFileState` before it is cleared/replaced.
- [ ] Sort by most recent read time, cap to 5 files, and enforce total/file token budgets.
- [ ] Keep read-state stale guard semantics intact; this task only adds model-visible continuity reminders.
- [ ] Run: `pnpm vitest run apps/zcode-cli/packages/core/tests/runtime-compact.test.ts apps/zcode-cli/packages/core/tests/read-file-state-hydrator.test.ts`

## Task 5: Remove ZCode Todo State From Post-Compact Context

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`

**Interfaces:**
- Do not append compact-specific todo state after compact. The generic todo reminder cadence still applies, but compact completion does not immediately restore the current todo list into provider-visible context.

- [ ] Update existing todo compact test to expect summary body does not contain `Current session todo state (authoritative):`.
- [ ] Add assertion that post-compact provider request does not contain the restored todo state reminder.
- [ ] Remove `appendTodoStateToCompactSummary` use from `compact-active.ts`.
- [ ] Remove compact-only `buildPostCompactTodoReminderEntries` wiring.
- [ ] Run: `pnpm vitest run apps/zcode-cli/packages/core/tests/runtime-compact.test.ts -t "todo"`

## Task 6: Investigate Current Auto Compact Budget Drift, Then Keep ZCode Threshold Defaults and Align Summary Output Cap

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/compact/policy.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts`
- Modify if needed: `apps/zcode-cli/packages/core/src/runtime/methods/context-usage.ts`
- Test: `apps/zcode-cli/packages/core/tests/compact-policy.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`

**Interfaces:**
- Produce: `AutoCompactDecision` diagnostics must expose enough budget facts to debug failures:
  - `contextWindow`
  - `effectiveContextWindow`
  - `threshold`
  - `tokenCount`
  - `tokenSource`
  - `providerContextUsageTokenCount`
  - `providerInputTokens`
  - `incrementalTokenCount`
  - `outputReserveTokens`
  - `summaryMaxOutputTokens`
- Accepted current defaults after investigation/user decision: keep `DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 64_000` and `DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 0.9`.
- Summary request max output after investigation: `Math.min(20_000, capModelRequestMaxOutputTokens(config.maxOutputTokens))`.

- [ ] Add a regression test that reproduces the reported failure shape: auto compact decides to compact, then the compact summary request fails with context overflow because `requestInputTokens + maxOutputTokens > contextWindow`.
- [ ] In that test, model the user-observed workaround: after dropping/rewinding several older messages, compact summary succeeds. This proves the failure is budget calculation, not summary prompt semantics.
- [ ] Add assertions that log/decision diagnostics identify the bad budget terms: active provider token count, local incremental estimate, summary max output, output reserve, threshold, and context window.
- [ ] Check whether `buildProviderUsageTokenOverride` should prefer `contextUsageTokenCount` over `inputTokens`, or use `Math.max(inputTokens, contextUsageTokenCount)` when provider reports both. Add a failing test for the chosen truth-source rule before changing code.
- [ ] Check whether local incremental token estimation after the latest provider usage snapshot can undercount large tool results or non-Anthropic tokenization. Add a failing test where provider usage is old, incremental context is large, and current local estimate lets auto compact start too late.
- [ ] Check whether compact summary request budget must reserve compact prompt text and exposed normal tools, now that Task 2 intentionally keeps tools in compact requests. Add a failing test where exposed tool schemas push the compact request over context unless threshold leaves enough buffer.
- [ ] Check whether `providerPostCompactTokenCount = getUsageTotalTokens(result.usage)` is being interpreted as post-compact context size even though it is the summary request usage. If so, add a test that `truePostCompactTokenCount` is the only re-trigger guard until a real provider count for the next request exists.
- [ ] Keep default policy tests on the restored ZCode defaults: 64k output reserve and 90 percent threshold.
- [ ] Do not change unknown max output reserve to 20k; only compact summary request max output is capped at 20k.
- [ ] Keep explicit config compatibility where `bufferTokens`, `summaryReserveTokens`, or threshold overrides are provided.
- [ ] Update runtime compact test to assert summary generation request uses max output capped at 20k.
- [ ] Implement runtime summary-cap changes without adding new env vars.
- [ ] Run: `pnpm vitest run apps/zcode-cli/packages/core/tests/compact-policy.test.ts apps/zcode-cli/packages/core/tests/runtime-compact.test.ts -t "auto compact"`

## Task 7: Explicitly Skip Local Microcompact Changes

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts`
- Modify: `apps/zcode-cli/packages/core/src/compact/microcompact.ts`
- Test: `apps/zcode-cli/packages/core/tests/microcompact.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`

**Interfaces:**
- keep-recent/local replacement 依赖 `context_hint`/server fallback 能力，ZCode 当前没有对应接口；本轮不改 local microcompact 的 provider-visible 行为。
- Runtime compact 收敛路径默认不依赖 microcompact；local microcompact 只保留现有显式 opt-in/安全修复，避免在缺少 `context_hint` 的情况下破坏 cache hit 或污染 provider-visible context。

- [ ] Keep this as an explicit skip in review notes; do not add new microcompact requirements here until ZCode has a `context_hint`/server compact capability.
- [ ] Ensure full compact behavior does not depend on microcompact being enabled.

## Task 8: Media Handling Should Degrade on Failure, Not Always Strip

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`

**Interfaces:**
- First freeze the intended compact media handling with a provider-visible fixture. Only implement retry/degrade behavior if the frozen behavior keeps provider-supported media on the first compact attempt and strips/retries after a media/context failure.
- If the frozen behavior strips media before compact summary requests, keep the existing stripping direction and only adjust the provider-visible shape accordingly.

- [ ] Add an evidence note in this task before implementation: the fixture/contract test that proves whether media is preserved first or stripped before compact.
- [ ] If media is preserved first, add failing test: compact summary request preserves latest image/media content on first attempt when provider supports media.
- [ ] If media is preserved first, add failing test: on media-too-large error, compact retries once with media stripped and succeeds.
- [ ] If media is stripped before compact, add failing test for that exact provider-visible projection and do not add a retry path.
- [ ] Implement only the branch confirmed by the evidence.
- [ ] Preserve current prompt-too-long retry behavior only if it already exists in the compact flow; do not add a new retry tier.
- [ ] Run: `pnpm vitest run apps/zcode-cli/packages/core/tests/runtime-compact.test.ts -t "media"`

## Task 9: Preserve UI Divider Invariant

**Files:**
- Modify only if tests expose breakage: `packages/shared/src/zcode-session-visible-content.ts`
- Modify only if tests expose breakage: `packages/ui/src/lib/zcodeSessionProjection.ts`
- Modify only if tests expose breakage: `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
- Test: existing UI/projection tests or add focused unit coverage near projection tests.

**Interfaces:**
- `isZCodeCompactSummaryMessage` must continue filtering model-only compact summary messages.
- `synthesizeCompactionTimeline` must continue rendering only lifecycle compaction parts as `context_compaction` divider.

- [ ] Add regression test with summary message + preserved recent messages + compact lifecycle part.
- [ ] Assert visible chat contains exactly one `context_compaction` divider.
- [ ] Assert compact summary model-only message is not rendered as user bubble.
- [ ] Do not hide real preserved user messages unless product explicitly wants UI to collapse them; current desired behavior is divider replacing historical compacted content.
- [ ] Run targeted UI/projection tests available in repo.

## Task 10: Provider-Visible Golden/Trajectory Verification

**Files:**
- Modify: `apps/zcode-cli/tools/prompt-trajectory/tests/derive.test.ts`
- Optional generated artifact review only: `apps/zcode-cli/tools/prompt-trajectory/out/...`

**Scenarios:**
- Manual full compact.
- Auto compact with pending user tail.
- Reactive compact after provider context overflow.
- Compact after reading a small file.
- Compact after reading a too-large file.

- [ ] Generate or update deterministic test fixtures rather than relying on stale `out/compact-*` artifacts.
- [ ] Assert compact request exposes normal tool contracts for provider-visible/cache shape, while compact tool calls are denied before execution.
- [ ] Assert compact request final user message is the frozen compact prompt.
- [ ] Assert post-compact request order is: context prefix, compact summary message, preserved recent entries, post-compact reminders, pending user input.
- [ ] Assert UI/session visible projection still hides compact summary body.

## Final Verification

- [ ] Run: `pnpm vitest run apps/zcode-cli/packages/core/tests/runtime-compact.test.ts apps/zcode-cli/packages/core/tests/compact-policy.test.ts apps/zcode-cli/packages/core/tests/microcompact.test.ts apps/zcode-cli/packages/core/tests/read-file-state-hydrator.test.ts apps/zcode-cli/tools/prompt-trajectory/tests/derive.test.ts`
- [ ] Run: `pnpm typecheck`
- [ ] Run: `pnpm lint`
- [ ] Run: `git status --short` and confirm changes are unstaged.
- [ ] Manually inspect one captured provider-visible request body for each main scenario before handing off.

## Acceptance Criteria

- Compact summary prompt and continuation message match the local compact semantics frozen in this plan, excluding explicit skip list.
- Every non-skip behavior change has a direct evidence pointer (fixture or contract test) in test names, test comments, or plan notes; no ZCode-only fallback/heuristic/config/abstraction is introduced as a “nice to have”.
- Touched compact code does not accumulate patch-on-patch branch chains; any necessary refactor is minimal, local to existing compact boundaries, and reduces branching while preserving the target behavior.
- Compact request no longer uses `tools: []`; it exposes normal tools but rejects any compact-time tool call before execution.
- Auto/reactive compact no longer only preserves trailing user entries; recent assistant/tool/user groups needed for continuity survive verbatim.
- Post-compact provider-visible content includes recent file continuity reminders from read state.
- Todo state, if present, is a separate model-only reminder and not appended into summary text.
- Auto compact budget diagnostics are covered, while the accepted default threshold keeps 64k output reserve and 90 percent threshold; compact summary request output is capped at 20k.
- Compact summary requests reserve enough budget for compact prompt text, exposed normal tools, and summary max output, so auto compact does not trigger into a predictable context-overflow failure.
- Local microcompact changes are explicitly skipped until ZCode has a `context_hint`/server compact capability; full compact provider-visible behavior must not depend on microcompact.
- UI continues to show compact as a single divider and does not expose compact summary as a chat bubble.
