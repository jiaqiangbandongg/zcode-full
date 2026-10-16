# Plan Mode Plan File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ZCode Plan mode 的 `ExitPlanMode(plan)` 设计改造成 plan-file 设计：计划正文写入 plan file，确保 compact / resume / pending approval replay 后仍能从 plan file 恢复完整计划。

**Architecture:** 以 provider-visible tool schema、tool prompt、runtime injected input、tool output、plan-file reminder 组成的 plan-file 合同为唯一目标。模型只看到 `ExitPlanMode({ allowedPrompts? })`；runtime 在 permission/hook/handler 之前从当前 plan file 注入 `{ plan, planFilePath }`；审批通过后的 tool output 使用 `{ plan, isAgent, filePath, hasTaskTool?, planWasEdited?, awaitingLeaderApproval?, requestId? }` shape。Plan file 本身是计划正文的事实来源，session event 只记录 plan file path/status 以支持 compact、resume 和 snapshot。

**Tech Stack:** TypeScript, Zod, Vitest, `@zcode/contracts`, ZCode core runtime/tool executor, session events/reducer, provider-visible prompt trajectory, desktop continuous and web-remote replayable session projection.

## Global Constraints

- 行为合同以下方「Target Contract」和 Task 0 写入的 `docs/plan-mode-plan-file.md` 为唯一事实源。
- 目标范围只包含 Plan mode plan-file 设计：`EnterPlanMode` / `ExitPlanMode` schema、prompt、plan file path、permission approval、tool result、compact/resume continuity、UI snapshot/replay。不要顺手改 Read/PDF、Agent.model、TodoWrite.activeForm、Bash dynamic fragments、server compact、team/agent swarm、ultraplan、auto-mode gate 等其它暂缓项。
- 不保留新的 provider-visible legacy `plan` 参数兼容路径。新的 provider-visible `ExitPlanMode.inputSchema` 只能包含 `allowedPrompts?`，不能包含 `plan`、`planFilePath`、`filePath`。
- Runtime 可以有 internal injected input schema：`allowedPrompts?` + `plan?` + `planFilePath?`。该 schema 只用于 normalize / permission / hooks / handler，不能泄漏到 `registry.toContracts()`。
- Output schema 字段固定为：`plan`, `isAgent`, `filePath`, `hasTaskTool?`, `planWasEdited?`, `awaitingLeaderApproval?`, `requestId?`。不要新增 `planFilePath` output 字段。
- Plan file path 使用 workspace root 下的 `.claude/plans/plan-session-id.md` 命名模式。实际实现用 `plan-<sanitized session id>.md` 和数字后缀保证唯一；这是本仓库已有的 plan artifact 位置。不要改成 `.zcode/plans`、artifact store、session sqlite、docs/superpowers/plans 或临时目录。
- Plan file 写入只允许当前 reserved plan file。Plan mode 仍禁止普通非只读修改；只对 `Write` / `Edit` 的 exact current plan file path 放行。不要允许 Bash redirect、ApplyPatch、任意 workspace write、任意 `.claude` 写入。
- `EnterPlanMode` 只 reserve plan file path，不预创建文件。这样模型可用 `Write` 创建该文件，且不会触发已有文件未 Read 的 Write stale guard。
- `ExitPlanMode` 不能在 handler 里才读 plan file，因为 permission、hooks、pending approval UI 都发生在 handler 之前。必须在 PreToolUse hook 之前完成 runtime input enrichment，让 PreToolUse、PermissionRequest、broker、pending snapshot、PostToolUse 都看到 injected input。
- 如果当前 plan file 不存在或内容为空，`ExitPlanMode` 返回可恢复工具错误并保持 plan mode；不要用 toolcall 参数、summary、read-state 或 artifact store 兜底。
- Compact / resume 必须通过 explicit `plan_file_reference` producer 恢复 plan file path 和完整内容。不要复用 generic read-state reminder，也不要移除 read-state 对 `docs/superpowers/plans/` 的 skip guard。
- Desktop `desktop-continuous` 与 mobile `web-remote-replayable` 边界保持不变：relay/main 只透传，不保存 plan 业务状态；session snapshot/replay payload 必须带足 pending approval 所需的 injected input。
- 远程 workspace 的文件操作使用 `workspacePath` / runtime working directory；身份隔离继续由 session/workspace owner 使用 `workspaceIdentity?.trim() || workspacePath`，不要把 `workspaceIdentity` 当文件路径。
- 修改 `packages/ui` 前必须先读取根目录 `DESIGN.md`。UI 只做字段解析和现有 block 展示，不新增大 UI 体验。
- 新增日志遵守现有 logger 规则：高频 provider/tool payload 细节只能走 debug/model-io，不走生产 info。
- 每个实现任务先写失败测试，再实现，再跑 focused tests。最后必须运行 `pnpm typecheck` 和 `pnpm lint`。
- 每个任务结束按 Conventional Commits 提交一个小 commit；不要 push。

---

## Explicit Skip List

- 不实现 team lead / teammate mailbox / agent swarm approval：`awaitingLeaderApproval` 和 `requestId` 只保留在 output schema，普通 ZCode main-agent flow 不设置。
- 不实现 agent 身份分支：普通 ZCode `ExitPlanMode` 输出 `isAgent: false`。
- 不实现 `Ctrl+G` plan editor UI；只实现文件已存在时用户可通过外部编辑器修改，runtime 以 disk content 为准。
- 不实现 plan file 内容摘要、截断版 approved snapshot 或 artifact fallback。传给模型的 tool result 仍受现有 result budget 控制，但 plan file 本身不被截断写入。
- 不改变 `ExitPlanMode` 审批边界：仍遵守 `docs/plan-mode-approval-boundary.md` 的用户确认、拒绝停轮、拒绝反馈继续修订语义。
- 不新增 `.gitignore` 规则隐藏 `.claude/plans`。本仓库已有 `.claude/plans/*.md` 被跟踪；是否版本化 plan artifact 属于现有仓库事实，不在本计划改。
- 不更新 conversation E2E case catalog，除非实现时实际修改 conversation/session E2E 行为。若只改 existing session snapshot/projection unit tests，不扩大到新的 conversation E2E matrix。

## Target Contract

这些合同在 Task 0 写入 spec，后续实现不得偏离：

- `ExitPlanMode` provider input schema 是 `strictObject({ allowedPrompts }).passthrough()`，不包含 provider-visible `plan`。
- internal schema 在此基础上 extend `{ plan?: string, planFilePath?: string }`，由 runtime 在 permission / hooks 之前从磁盘注入。
- output schema 是 `{ plan, isAgent, filePath, hasTaskTool?, planWasEdited?, awaitingLeaderApproval?, requestId? }`。
- 非 agent 普通 flow 的 tool result 文案包含：
  - `User has approved your plan. You can now start coding. Start with updating your todo list if applicable`
  - `Your plan has been saved to: ${filePath}`
  - `You can refer back to it if needed during implementation.`
  - `## ${planWasEdited ? "Approved Plan (edited by user)" : "Approved Plan"}:`
- `plan_file_reference` system reminder 文案是：
  - `A plan file exists from plan mode at: ${planFilePath}`
  - blank line
  - `Plan contents:`
  - blank line
  - `${planContent}`
  - blank line
  - `If this plan is relevant to the current work and not already complete, continue working on it.`
- `plan_mode_exit` 在 plan exists 时追加：` The plan file is located at ${planFilePath} if you need to reference it.`
- 本仓库已有 `.claude/plans/*.md`，作为 plan-file artifact 的本地位置。

## File Map

- Create: `docs/plan-mode-plan-file.md`
  - 语义 spec：plan file path、provider schema、runtime injected input、approval、compact/resume、UI/replayable 边界。
- Modify: `apps/zcode-cli/docs/design/v2/tool/16-plan-mode.md`
  - 删除旧的“计划正文通过 `ExitPlanMode.plan` 直接传入、不引入 plan file”contract，替换为 plan-file contract。
- Modify: `docs/plan-mode-approval-boundary.md`
  - 保留审批边界，补充审批内容来源从 `input.plan` 改为 injected plan file content。
- Modify: `apps/zcode-cli/packages/contracts/src/tools/plan-mode.ts`
  - 拆分 provider input schema 与 internal injected input schema；output 加 plan-file 字段。
- Modify: `apps/zcode-cli/packages/contracts/src/events/session.events.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/events/event-reducer.ts`
- Modify: `packages/shared/src/zcode-protocol/index.ts`
  - 增加 plan file state / snapshot 字段，保留 pending permission input。
- Modify: `apps/zcode-cli/packages/core/src/tool/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/validation.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts`
  - 增加 provider input validation、pre-hook input preparation、execution input validation，并让 permission request 使用 injected input。
- Modify: `apps/zcode-cli/packages/core/src/permission/service.ts`
  - 增加 exact current plan file write exception。
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/write.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts`
  - 只在 plan mode 且 exact current plan file path 时放行 Write/Edit。
- Create: `apps/zcode-cli/packages/core/src/runtime/helpers/plan-file.ts`
  - plan file path 生成、slug 生成、跨 POSIX/Windows path join、disk read、system reminder formatter。
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/session-mode-port.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
  - 维护当前 / approved plan file path，注入 plan mode / exit reminders。
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/compact-post-reminders.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
  - compact 后 explicit plan file reference。
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode-prompts.ts`
  - `ExitPlanMode` 读取 injected input，输出 `filePath`。
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts`
- Modify: `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
- Modify: `packages/ui/src/lib/zcodeSessionProjection.ts`
- Modify: `packages/ui/src/lib/toolDisplay.ts`
- Modify: `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx`
  - snapshot/replay/UI 使用 `filePath`，pending approval schema 保留 injected input。
- Test: `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/permission-service.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`
- Test: `packages/ui/test/toolDisplay.test.ts`
- Test: `packages/ui/test/zcodeSessionProjection.test.ts`
- Test: `packages/services/test/zcodeAgentService.test.ts`
- Test: `packages/services/test/zcodeSessionService.test.ts`
- Test: prompt trajectory fixture under `apps/zcode-cli/tools/prompt-trajectory/testcases/`

---

### Task 0: 写入 Plan File 合同 Spec

**Files:**
- Create: `docs/plan-mode-plan-file.md`

**Interfaces:**
- Produces: `docs/plan-mode-plan-file.md` 中的 `## Tool Contract`，后续任务只能引用这里的合同。

- [ ] **Step 1: 写 spec 文档**

Create `docs/plan-mode-plan-file.md` with this content:

```markdown
# Plan Mode Plan File

## Target

ZCode Plan mode keeps the plan body in a reserved plan file; `ExitPlanMode` reads the plan from disk instead of taking it as a tool parameter.

## Tool Contract

- Provider-visible `ExitPlanMode` input has only `allowedPrompts?`.
- Internal runtime input may include `plan?` and `planFilePath?`, injected from disk before permission and hooks.
- Output schema includes `plan`, `isAgent`, `filePath`, `hasTaskTool?`, `planWasEdited?`, `awaitingLeaderApproval?`, and `requestId?`.
- Normal main-agent approval output uses `isAgent: false`, `filePath`, and the plan content read from the plan file.
- `plan_file_reference` re-injects the plan file path and complete plan contents after compact/resume.
- `plan_mode_exit` tells the model that edits/tools are allowed and includes the plan file path when a plan exists.

## ZCode Contract

- `EnterPlanMode` reserves a unique plan file path under the workspace root, using the `.claude/plans/plan-session-id.md` naming pattern.
- `EnterPlanMode` does not create the file.
- Plan mode allows only read-only tools plus `Write` or `Edit` targeting the exact reserved plan file path.
- `ExitPlanMode` provider input does not contain plan text.
- Before PreToolUse hooks, runtime reads the reserved plan file and injects `{ plan, planFilePath }`.
- User approval sees the injected plan content and plan file path.
- Approval exits plan mode and returns `{ plan, isAgent: false, filePath }`.
- Rejection without feedback stops the current turn and keeps plan mode.
- Rejection with `reasonSource: "plan_approval_feedback"` keeps plan mode and lets the model revise the same plan file.
- Compact and resume re-inject `plan_file_reference` from the plan file. If a referenced plan file is missing or empty, the operation fails explicitly instead of silently dropping the plan.
- Desktop continuous and web remote replayable both consume session events/snapshots; relay and main process do not own plan state.

## Out Of Scope

- Team lead / teammate mailbox approval.
- Agent swarm `isAgent: true` behavior.
- Ctrl+G or web UI plan editor.
- Plan summary fallback.
- Other postponed surfaces unrelated to plan files.
```

- [ ] **Step 2: Commit Task 0**

Run:

```bash
git add docs/plan-mode-plan-file.md
git commit -m "docs: record plan file contract"
```

Expected: commit succeeds.

---

### Task 1: 更新现有 Plan Mode 语义文档

**Files:**
- Modify: `apps/zcode-cli/docs/design/v2/tool/16-plan-mode.md`
- Modify: `docs/plan-mode-approval-boundary.md`

**Interfaces:**
- Consumes: `docs/plan-mode-plan-file.md`.
- Produces: docs no longer claim `ExitPlanMode.plan` is current contract.

- [ ] **Step 1: Update `16-plan-mode.md`**

Replace the old first-version scope with:

```markdown
ZCode 当前版本采用 plan-file 语义：计划正文写入 workspace root 下的 `.claude/plans/plan-session-id.md`，`ExitPlanMode` 的 provider-visible 输入只包含 `allowedPrompts?`，runtime 在 permission / hook / handler 前从 plan file 注入 `plan` 与 `planFilePath`。
```

In the `ExitPlanMode` section, make the input/output bullets:

```markdown
- Provider-visible 输入：
  - `allowedPrompts?: { tool: "Bash"; prompt: string }[]`
- Runtime injected 输入：
  - `plan?: string`：从当前 plan file 读取，供 permission、hooks、approval UI 和 handler 使用。
  - `planFilePath?: string`：当前 plan file 的绝对路径。
- 输出：
  - `plan: string | null`
  - `isAgent: false`
  - `filePath?: string`
  - `hasTaskTool?: boolean`
  - `planWasEdited?: boolean`
  - `awaitingLeaderApproval?: boolean`
  - `requestId?: string`
```

Remove all statements that say:

```text
工具必须通过 plan 参数传入完整计划
模型不要假设存在 plan file
ExitPlanMode 的 plan 留在 tool input / result payload
从 yolo 进入 plan mode 时直接 allow
```

Keep the current approval boundary from `docs/plan-mode-approval-boundary.md`: `ExitPlanMode` still asks user approval in plan mode.

- [ ] **Step 2: Update `docs/plan-mode-approval-boundary.md`**

Add this paragraph under `## 语义`:

```markdown
审批内容来源是 runtime injected `ExitPlanMode` input：runtime 在进入 permission broker 前读取当前 plan file，将 `{ plan, planFilePath }` 注入 tool input。UI、hook、pending snapshot 和 tool result 均消费这个 injected input，而不是 provider-visible toolcall 参数。
```

- [ ] **Step 3: Verify docs no longer contain stale contract**

Run:

```bash
rg -n 'DOES take the plan content|required plan parameter|计划正文通过 `ExitPlanMode.plan` 直接传入|不做 `ExitPlanMode` V2|保留 ZCode 当前 `ExitPlanMode\\(plan\\)`|工具必须通过 `plan` 参数' apps/zcode-cli/docs docs
```

Expected: no hits except historical completed-plan files under `apps/zcode-cli/docs/plan/trajectory/completed/` if those files are explicitly describing old completed work. Do not edit completed historical plans.

- [ ] **Step 4: Commit Task 1**

Run:

```bash
git add apps/zcode-cli/docs/design/v2/tool/16-plan-mode.md docs/plan-mode-approval-boundary.md
git commit -m "docs: align plan mode docs with plan files"
```

Expected: commit succeeds.

---

### Task 2: 拆分 Provider Schema 与 Runtime Injected Schema

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/tools/plan-mode.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/validation.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Test: `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts`

**Interfaces:**
- Produces: `ExitPlanModeInputSchema` for provider input: `{ allowedPrompts? }`.
- Produces: `ExitPlanModeInjectedInputSchema` for runtime input: `{ allowedPrompts?, plan?, planFilePath? }`.
- Produces: `ToolEntry.executionInputSchema?: JsonSchema`.
- Produces: `ToolEntry.prepareInput?: (input, context) => Promise<unknown>`.

- [ ] **Step 1: Write failing contract test**

In `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`, replace the current ExitPlanMode contract test with:

```ts
it("matches the ExitPlanMode plan-file provider contract", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry);
  const contract = registry.toContracts().find((item) => item.name === "ExitPlanMode");

  expect(contract?.description).toContain("finished writing your plan to the plan file");
  expect(contract?.description).toContain("does NOT take the plan content as a parameter");
  expect(contract?.description).toContain("read the plan from the file you wrote");
  expect(contract?.description).not.toContain("required plan parameter");
  expect(contract?.inputSchema).toHaveProperty("properties.allowedPrompts");
  expect(contract?.inputSchema).not.toHaveProperty("properties.plan");
  expect(contract?.inputSchema).not.toHaveProperty("properties.planFilePath");
});
```

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/tool-contracts.test.ts -t "ExitPlanMode plan-file provider contract"
```

Expected: FAIL because current schema exposes `plan`.

- [ ] **Step 2: Write failing injected schema test**

In `apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts`, add:

```ts
it("keeps injected ExitPlanMode plan fields out of provider schema", () => {
  expect(exitPlanModeToolEntry.inputSchema).toHaveProperty("properties.allowedPrompts");
  expect(exitPlanModeToolEntry.inputSchema).not.toHaveProperty("properties.plan");
  expect(exitPlanModeToolEntry.inputSchema).not.toHaveProperty("properties.planFilePath");
  expect(exitPlanModeToolEntry.executionInputSchema).toHaveProperty("properties.plan");
  expect(exitPlanModeToolEntry.executionInputSchema).toHaveProperty("properties.planFilePath");
});
```

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/plan-mode-tool.test.ts -t "injected ExitPlanMode plan fields"
```

Expected: FAIL because `executionInputSchema` does not exist.

- [ ] **Step 3: Implement contract schemas**

In `apps/zcode-cli/packages/contracts/src/tools/plan-mode.ts`, replace the current `ExitPlanModeInputSchema` with:

```ts
export const ExitPlanModeInputSchema = z
  .object({
    allowedPrompts: z
      .array(ExitPlanModeAllowedPromptSchema)
      .optional()
      .describe(
        "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
      ),
  })
  .strict()
  .catchall(z.unknown());
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>;
export const ExitPlanModeInputJsonSchema = toToolJsonSchema(ExitPlanModeInputSchema);

export const ExitPlanModeInjectedInputSchema = ExitPlanModeInputSchema.extend({
  plan: z.string().optional().describe("The plan content (injected by the runtime from the plan file)"),
  planFilePath: z.string().optional().describe("The plan file path (injected by the runtime)"),
});
export type ExitPlanModeInjectedInput = z.infer<typeof ExitPlanModeInjectedInputSchema>;
export const ExitPlanModeInjectedInputJsonSchema = toToolJsonSchema(
  ExitPlanModeInjectedInputSchema,
);
```

Update output schema to the plan-file shape:

```ts
export const ExitPlanModeOutputSchema = z
  .object({
    plan: z.string().nullable().describe("The plan that was presented to the user"),
    isAgent: z.boolean(),
    filePath: z.string().optional().describe("The file path where the plan was saved"),
    hasTaskTool: z.boolean().optional().describe("Whether the Agent tool is available in the current context"),
    planWasEdited: z
      .boolean()
      .optional()
      .describe("True when the user edited the plan; determines whether the plan is echoed back in tool_result"),
    awaitingLeaderApproval: z
      .boolean()
      .optional()
      .describe("When true, the teammate has sent a plan approval request to the team leader"),
    requestId: z.string().optional().describe("Unique identifier for the plan approval request"),
  })
  .strict();
```

Do not export `PLAN_MODE_MAX_PLAN_CHARS`; it no longer applies to provider input.

- [ ] **Step 4: Add execution input schema plumbing**

In `apps/zcode-cli/packages/core/src/tool/types.ts`, add:

```ts
export interface ToolInputPreparationContext {
  abortSignal: AbortSignal;
  fileSystemPort?: FileSystemPort;
  getCurrentPlanFilePath?: () => string | undefined;
  logger?: Logger;
  sessionId: SessionId;
  toolCallId: string;
  traceContext: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}
```

Add to `ToolEntry`:

```ts
executionInputSchema?: JsonSchema;
prepareInput?: (
  input: unknown,
  context: ToolInputPreparationContext,
) => Promise<unknown>;
```

Add matching fields to `ToolExecutorOptions` / `ToolExecutorDeps` in `executor/types.ts`:

```ts
getCurrentPlanFilePath?: () => string | undefined;
```

- [ ] **Step 5: Split validation phases**

In `apps/zcode-cli/packages/core/src/tool/executor/validation.ts`, change `validateInput` to:

```ts
export function validateInput(
  input: unknown,
  entry: ToolEntry,
  phase: "provider" | "execution" = "execution",
): Error | undefined {
  const schema = phase === "provider" ? entry.inputSchema : entry.executionInputSchema ?? entry.inputSchema;
  const validation = validateJsonSchemaValue(input, schema);
  if (validation.valid) return undefined;

  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Tool input failed ${phase} schema validation`,
    {
      context: {
        errors: validation.errors.slice(0, 20),
        toolName: entry.metadata.name,
      },
      recoverable: true,
    },
  );
}
```

- [ ] **Step 6: Call `prepareInput` before hooks and permission**

In `call-runner.ts`, use this order:

```ts
let executionInput = normalizeToolExecutionInput({ entry, input: toolCall.input, logger: deps.logger, source: "initial" });
const providerInputValidation = validateInput(executionInput, entry, "provider");
if (providerInputValidation) return createErrorResult(toolCall, providerInputValidation);

if (entry.prepareInput) {
  executionInput = await entry.prepareInput(executionInput, {
    abortSignal: options?.signal ?? new AbortController().signal,
    fileSystemPort: deps.fileSystemPort,
    getCurrentPlanFilePath: deps.getCurrentPlanFilePath,
    logger: deps.logger,
    sessionId: deps.sessionId,
    toolCallId: toolCall.id,
    traceContext,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
  });
  executionInput = normalizeToolExecutionInput({ entry, input: executionInput, logger: deps.logger, source: "initial" });
}

const executionInputValidation = validateInput(executionInput, entry, "execution");
if (executionInputValidation) return createErrorResult(toolCall, executionInputValidation);
```

When PreToolUse or permission modify input, normalize and validate with phase `"execution"`.

- [ ] **Step 7: Wire ExitPlanMode entry**

In `plan-mode.ts`, set:

```ts
inputSchema: ExitPlanModeInputJsonSchema,
executionInputSchema: ExitPlanModeInjectedInputJsonSchema,
runtimeInputSchema: ExitPlanModeInjectedInputSchema,
```

Do not implement `prepareInput` yet; Task 3 adds it.

- [ ] **Step 8: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/tool-contracts.test.ts tests/plan-mode-tool.test.ts
```

Expected: only tests that require actual plan file enrichment may still fail; schema tests pass.

- [ ] **Step 9: Commit Task 2**

Run:

```bash
git add apps/zcode-cli/packages/contracts/src/tools/plan-mode.ts apps/zcode-cli/packages/core/src/tool/types.ts apps/zcode-cli/packages/core/src/tool/executor/types.ts apps/zcode-cli/packages/core/src/tool/executor/validation.ts apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts apps/zcode-cli/packages/core/tests/tool-contracts.test.ts apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts
git commit -m "feat: split plan mode provider and injected schemas"
```

Expected: commit succeeds.

---

### Task 3: 实现 Plan File Path 生命周期与 Plan Mode 写入例外

**Files:**
- Create: `apps/zcode-cli/packages/core/src/runtime/helpers/plan-file.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/session-mode-port.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/permission/service.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/write.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts`
- Test: `apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/permission-service.test.ts`

**Interfaces:**
- Produces: `runtime.currentPlanFilePath?: string`.
- Produces: `runtime.approvedPlanFilePath?: string`.
- Produces: `buildPlanFilePath({ workspaceRoot, sessionId, now, exists })`.
- Produces: `PermissionToolCapability.allowInPlanMode?: boolean`.

- [ ] **Step 1: Write failing plan file path tests**

In `plan-mode-tool.test.ts`, add:

```ts
it("reserves a .claude/plans markdown file when entering plan mode", async () => {
  const result = await enterPlanModeHandler({}, createPlanModeToolContextWithFileSystem({
    mode: "build",
    workspaceRoot: "/workspace/project",
  }));

  expect(result.mode).toBe("plan");
  expect(testRuntime.currentPlanFilePath).toMatch(/^\/workspace\/project\/\.claude\/plans\/[a-z0-9-]+\.md$/u);
});

it("does not create the plan file when entering plan mode", async () => {
  await enterPlanModeHandler({}, createPlanModeToolContextWithFileSystem({
    mode: "build",
    workspaceRoot: "/workspace/project",
  }));

  expect(fakeFileSystem.writeTextFile).not.toHaveBeenCalled();
});
```

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/plan-mode-tool.test.ts -t "plan file"
```

Expected: FAIL because no plan path is reserved.

- [ ] **Step 2: Implement plan file helper**

Create `apps/zcode-cli/packages/core/src/runtime/helpers/plan-file.ts`:

```ts
import path from "node:path";
import type { FileSystemPort, SessionId } from "@zcode/contracts";

export interface PlanFilePathInput {
  fileSystemPort: FileSystemPort;
  sessionId: SessionId;
  workspaceRoot: string;
}

export function workspacePathApi(workspaceRoot: string): typeof path.posix | typeof path.win32 {
  return /^[A-Za-z]:[\\/]/u.test(workspaceRoot) || workspaceRoot.includes("\\")
    ? path.win32
    : path.posix;
}

export function buildPlanFileCandidate(workspaceRoot: string, slug: string): string {
  const pathApi = workspacePathApi(workspaceRoot);
  return pathApi.join(workspaceRoot, ".claude", "plans", `${slug}.md`);
}

export function slugFromSessionId(sessionId: SessionId): string {
  return `plan-${String(sessionId).replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase()}`;
}

export async function reservePlanFilePath(input: PlanFilePathInput): Promise<string> {
  const baseSlug = slugFromSessionId(input.sessionId);
  for (let index = 0; index < 100; index += 1) {
    const slug = index === 0 ? baseSlug : `${baseSlug}-${index + 1}`;
    const candidate = buildPlanFileCandidate(input.workspaceRoot, slug);
    const stat = await input.fileSystemPort.stat({ path: candidate }).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "not_found") {
        return undefined;
      }
      throw error;
    });
    if (!stat || stat.kind === "missing") return candidate;
  }
  throw new Error("Unable to reserve a unique plan file path after 100 attempts");
}
```

Use deterministic `plan-<sessionId>.md` instead of whimsical random names. The invariant is the `.claude/plans/*.md` location; random word naming is cosmetic and not provider-visible.

- [ ] **Step 3: Add runtime state**

In `AgentRuntimeInternal` add:

```ts
currentPlanFilePath?: string;
approvedPlanFilePath?: string;
```

Initialize both as `undefined` in `agent-runtime.ts`.

Pass to `createToolExecutor`:

```ts
getCurrentPlanFilePath: () => runtime.currentPlanFilePath,
```

- [ ] **Step 4: Reserve path on enter**

In `session-mode-port.ts`, before switching mode to `plan`, require `runtime.fileSystemPort` and call `reservePlanFilePath`. Store:

```ts
runtime.currentPlanFilePath = reservedPath;
runtime.approvedPlanFilePath = undefined;
```

If already in plan mode and `currentPlanFilePath` exists, keep the same path.

- [ ] **Step 5: Write failing permission test for plan file write**

In `permission-service.test.ts`, add:

```ts
it("allows Write to the exact current plan file while in plan mode", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      input: { file_path: "/workspace/.claude/plans/plan-session.md", content: "# Plan" },
      mode: "plan",
      riskLevel: "medium",
      toolName: "Write",
    },
    {
      allowInPlanMode: true,
      destructive: false,
      needsApproval: false,
      readOnly: false,
      riskLevel: "medium",
      sideEffectScope: "workspace",
    },
  );

  expect(decision).toMatchObject({
    allowed: true,
    decision: "allow",
    ruleId: "mode.plan.planFileWrite",
  });
});

it("still denies non-plan-file writes while in plan mode", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    {
      input: { file_path: "/workspace/src/app.ts", content: "x" },
      mode: "plan",
      riskLevel: "medium",
      toolName: "Write",
    },
    {
      destructive: false,
      needsApproval: true,
      readOnly: false,
      riskLevel: "medium",
      sideEffectScope: "workspace",
    },
  );

  expect(decision).toMatchObject({
    allowed: false,
    decision: "deny",
    ruleId: "mode.plan.nonReadOnly",
  });
});
```

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/permission-service.test.ts -t "plan file"
```

Expected: FAIL because `allowInPlanMode` does not exist.

- [ ] **Step 6: Add permission capability field**

In `PermissionToolCapability` add:

```ts
allowInPlanMode?: boolean;
```

In `checkPlanMode`, before read-only allow:

```ts
if (capability.allowInPlanMode === true) {
  return this.allow(
    context,
    capability,
    "mode.plan.planFileWrite",
    "Plan mode allows writing the current plan file",
  );
}
```

- [ ] **Step 7: Add mode and current plan file to permission capability context**

In `ToolRuntimePermissionCapabilityContext`, add:

```ts
currentPlanFilePath?: string;
mode?: CollaborationMode;
```

In `resolveRuntimePermissionCapability`, pass:

```ts
currentPlanFilePath: deps.getCurrentPlanFilePath?.(),
mode: deps.getMode(),
```

- [ ] **Step 8: Mark Write/Edit exact plan path as allowed**

In `write.ts` and `edit.ts`, add `resolvePermissionCapability` to the tool entries:

```ts
resolvePermissionCapability: (input, context) => {
  const currentPlanFilePath = context?.currentPlanFilePath;
  if (context?.mode !== "plan" || !currentPlanFilePath) return undefined;
  const parsed = WriteInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const filePath = resolveWorkspacePath({
    inputPath: parsed.data.file_path,
    operation: "write",
    workingDirectory: context.workingDirectory ?? ".",
    workspaceRoot: context.workspaceRoot ?? ".",
  });
  if (filePath !== currentPlanFilePath) return undefined;
  return {
    allowInPlanMode: true,
    needsApproval: false,
    permission: { needsApproval: false },
    riskLevel: "medium",
    sideEffectScope: "workspace",
  };
},
```

Use `EditInputSchema` in `edit.ts`. Do not add this to `ApplyPatch` or `Bash`.

- [ ] **Step 9: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/plan-mode-tool.test.ts tests/permission-service.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 3**

Run:

```bash
git add apps/zcode-cli/packages/core/src/runtime/helpers/plan-file.ts apps/zcode-cli/packages/core/src/runtime/internal.ts apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts apps/zcode-cli/packages/core/src/runtime/session-mode-port.ts apps/zcode-cli/packages/core/src/tool/executor/types.ts apps/zcode-cli/packages/core/src/tool/executor/impl.ts apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts apps/zcode-cli/packages/core/src/permission/service.ts apps/zcode-cli/packages/core/src/tool/handlers/write.ts apps/zcode-cli/packages/core/src/tool/handlers/edit.ts apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts apps/zcode-cli/packages/core/tests/permission-service.test.ts
git commit -m "feat: reserve plan files in plan mode"
```

Expected: commit succeeds.

---

### Task 4: 从 Plan File 注入 ExitPlanMode Input 并输出 Plan-File Tool Result

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode-prompts.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/session-mode-port.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts`
- Test: `apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`

**Interfaces:**
- Produces: `prepareExitPlanModeInput(input, context)`.
- Produces: model result content for the normal main-agent flow.

- [ ] **Step 1: Write failing test for input enrichment before approval**

In `plan-mode-tool.test.ts`, add:

```ts
it("injects plan and planFilePath from disk before requesting approval", async () => {
  const permissionRequests: unknown[] = [];
  const executor = createPlanModeExecutor({
    fileSystemFiles: {
      "/workspace/.claude/plans/plan-session.md": "# Build plan\n\n1. Add tests.",
    },
    getCurrentPlanFilePath: () => "/workspace/.claude/plans/plan-session.md",
    mode: "plan",
    permissionBroker: {
      requestPermission: async (request) => {
        permissionRequests.push(request.input);
        return { decision: "allow", reason: "approved" };
      },
    },
  });

  const result = await executor.execute({
    id: "toolu_exit",
    name: "ExitPlanMode",
    input: { allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] },
  });

  expect(permissionRequests[0]).toMatchObject({
    allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
    plan: "# Build plan\n\n1. Add tests.",
    planFilePath: "/workspace/.claude/plans/plan-session.md",
  });
  expect(result.output).toMatchObject({
    filePath: "/workspace/.claude/plans/plan-session.md",
    isAgent: false,
    plan: "# Build plan\n\n1. Add tests.",
  });
});
```

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/plan-mode-tool.test.ts -t "injects plan"
```

Expected: FAIL because `prepareInput` is not implemented.

- [ ] **Step 2: Implement `prepareExitPlanModeInput`**

In `plan-mode.ts`, add:

```ts
async function prepareExitPlanModeInput(
  input: unknown,
  context: ToolInputPreparationContext,
): Promise<ExitPlanModeInjectedInput> {
  const parsed = ExitPlanModeInputSchema.parse(input);
  const planFilePath = context.getCurrentPlanFilePath?.();
  if (!planFilePath) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "No plan file is registered for the current plan mode session.", {
      context: { toolCallId: context.toolCallId, toolName: EXIT_PLAN_MODE_TOOL_NAME },
      recoverable: true,
    });
  }
  if (!context.fileSystemPort) {
    throw createCoreError(CoreErrorType.ConfigurationError, "FileSystemPort is not configured for ExitPlanMode", {
      context: { toolCallId: context.toolCallId, toolName: EXIT_PLAN_MODE_TOOL_NAME },
      recoverable: false,
    });
  }
  const read = await context.fileSystemPort.readTextFile(
    { path: planFilePath, trace: context.traceContext },
    { signal: context.abortSignal },
  ).catch((error) => {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `No plan file found at ${planFilePath}. Please write your plan to this file before calling ExitPlanMode.`,
      { cause: error instanceof Error ? error : undefined, recoverable: true },
    );
  });
  const plan = read.content.trim();
  if (!plan) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, `No plan file found at ${planFilePath}. Please write your plan to this file before calling ExitPlanMode.`, {
      recoverable: true,
    });
  }
  return { ...parsed, plan, planFilePath };
}
```

Set on the entry:

```ts
prepareInput: prepareExitPlanModeInput,
```

- [ ] **Step 3: Update handler**

Change `exitPlanModeHandler` to parse `ExitPlanModeInjectedInputSchema`, require `parsed.plan?.trim()` and `parsed.planFilePath`, then return:

```ts
return {
  filePath: parsed.planFilePath,
  isAgent: false,
  plan: parsed.plan,
} satisfies ExitPlanModeOutput;
```

After transition, set:

```ts
context.sessionModePort.approvePlanFile?.({
  planFilePath: parsed.planFilePath,
  toolCallId: context.toolCallId,
  traceContext: { traceId: context.traceId, spanId: context.spanId, parentSpanId: context.parentSpanId, turnId: context.turnId },
});
```

If adding `approvePlanFile` to `SessionModePort` is too large, extend `exitPlanMode(input)` to accept `planFilePath?: string` and update runtime state there.

- [ ] **Step 4: Update result formatter**

Replace `formatExitPlanModeModelContent` with the normal main-agent content:

```ts
function formatExitPlanModeModelContent(output: unknown): string {
  const result = output as ExitPlanModeOutput;
  const plan = result.plan?.trim();
  if (!plan) {
    return "User has approved exiting plan mode. You can now proceed.";
  }

  const taskNote = result.hasTaskTool
    ? `\n\nIf this plan can be broken down into multiple independent tasks, consider using the Agent tool to create a team and parallelize the work.`
    : "";
  return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${result.filePath}
You can refer back to it if needed during implementation.${taskNote}

## ${result.planWasEdited ? "Approved Plan (edited by user)" : "Approved Plan"}:
${plan}`;
}
```

Use `Agent tool` only if `hasTaskTool` is true; otherwise omit `taskNote`.

- [ ] **Step 5: Update ExitPlanMode prompt text**

In `plan-mode-prompts.ts`, replace the current prompt with the plan-file prompt:

```text
Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it
...
```

Keep the trailing newline.

- [ ] **Step 6: Update plan mode exit reminder**

Change `buildPlanModeExitReminderBody` to accept `{ planFilePath?: string }` and emit:

```ts
export function buildPlanModeExitReminderBody(input: { planFilePath?: string } = {}): string {
  const suffix = input.planFilePath
    ? ` The plan file is located at ${input.planFilePath} if you need to reference it.`
    : "";
  return `## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${suffix}`;
}
```

Update `turn-loop.ts` to pass `this.approvedPlanFilePath`.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/plan-mode-tool.test.ts tests/tool-contracts.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

Run:

```bash
git add apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts apps/zcode-cli/packages/core/src/tool/handlers/plan-mode-prompts.ts apps/zcode-cli/packages/core/src/runtime/session-mode-port.ts apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts apps/zcode-cli/packages/core/tests/plan-mode-tool.test.ts apps/zcode-cli/packages/core/tests/tool-contracts.test.ts
git commit -m "feat: read exit plans from plan files"
```

Expected: commit succeeds.

---

### Task 5: 用 Session Event / Snapshot 恢复 Plan File State

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/events/session.events.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/events/event-reducer.ts`
- Modify: `packages/shared/src/zcode-protocol/index.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/session-mode-port.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`
- Test: `packages/services/test/zcodeSessionService.test.ts`

**Interfaces:**
- Produces: `SessionEventType.PlanFileChanged`.
- Produces: `SessionProjection.planFile?: { currentPath?: string; approvedPath?: string; status: "none" | "draft" | "approved" }`.
- Produces: protocol snapshot field `planFile`.

- [ ] **Step 1: Write failing reducer test**

Add a reducer test near existing session event reducer tests:

```ts
it("projects current and approved plan file paths", () => {
  const reducer = new EventReducer();
  const projection = reducer.reduce([
    makeEvent(SessionEventType.PlanFileChanged, {
      planFilePath: "/workspace/.claude/plans/plan-session.md",
      status: "draft",
    }),
    makeEvent(SessionEventType.PlanFileChanged, {
      planFilePath: "/workspace/.claude/plans/plan-session.md",
      status: "approved",
    }),
  ]);

  expect(projection.planFile).toEqual({
    approvedPath: "/workspace/.claude/plans/plan-session.md",
    currentPath: undefined,
    status: "approved",
  });
});
```

Run the exact reducer test file. Expected: FAIL because event does not exist.

- [ ] **Step 2: Add event contract**

In `session.events.ts`:

```ts
PlanFileChanged: "plan_file_changed",
```

Payload:

```ts
export interface PlanFileChangedPayload {
  planFilePath: string;
  status: "draft" | "approved" | "cleared";
  toolCallId?: ToolCallId;
}
```

Add to payload union.

- [ ] **Step 3: Add projection state**

In event reducer projection types, add:

```ts
planFile?: {
  approvedPath?: string;
  currentPath?: string;
  status: "none" | "draft" | "approved";
};
```

Reducer behavior:

```ts
if (payload.status === "draft") {
  planFile = { currentPath: payload.planFilePath, approvedPath: p.planFile?.approvedPath, status: "draft" };
}
if (payload.status === "approved") {
  planFile = { approvedPath: payload.planFilePath, currentPath: undefined, status: "approved" };
}
if (payload.status === "cleared") {
  planFile = { approvedPath: undefined, currentPath: undefined, status: "none" };
}
```

- [ ] **Step 4: Emit events**

In `session-mode-port.ts`:

- After reserving path on enter, append `PlanFileChanged(status: "draft")`.
- On approved exit, append `PlanFileChanged(status: "approved")`.

Do not emit content in the event.

- [ ] **Step 5: Resume runtime state**

In `resume.ts`, after reducing projection:

```ts
this.currentPlanFilePath = projection.planFile?.currentPath;
this.approvedPlanFilePath = projection.planFile?.approvedPath;
```

- [ ] **Step 6: Map protocol snapshot**

In shared protocol schema and bootstrap session mapper, expose:

```ts
planFile: z.object({
  approvedPath: z.string().optional(),
  currentPath: z.string().optional(),
  status: z.enum(["none", "draft", "approved"]),
}).optional()
```

The UI and services must receive this under session projection, not as relay/main state.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm --filter @zcode/contracts exec vitest run
pnpm --filter @zcode/core exec vitest run tests/plan-mode-tool.test.ts tests/runtime-persistence.test.ts
pnpm vitest run packages/services/test/zcodeSessionService.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

Run:

```bash
git add apps/zcode-cli/packages/contracts/src/events/session.events.ts apps/zcode-cli/packages/contracts/src/events/event-reducer.ts packages/shared/src/zcode-protocol/index.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts apps/zcode-cli/packages/core/src/runtime/session-mode-port.ts apps/zcode-cli/packages/core/src/runtime/methods/resume.ts
git commit -m "feat: persist plan file session state"
```

Expected: commit succeeds.

---

### Task 6: Compact / Resume 注入 `plan_file_reference`

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/plan-file.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/compact-post-reminders.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`

**Interfaces:**
- Produces: `buildPlanFileReferenceEntry({ planFilePath, planContent })`.
- Produces: `buildPostCompactPlanFileReminderEntries(runtime)`.

- [ ] **Step 1: Write failing compact preservation test**

In `runtime-compact.test.ts`, add:

```ts
it("re-injects approved plan file contents after compact", async () => {
  const runtime = createRuntimeForCompactTest({
    approvedPlanFilePath: "/workspace/.claude/plans/plan-session.md",
    files: {
      "/workspace/.claude/plans/plan-session.md": "# Approved plan\n\n1. Keep this exact plan.",
    },
  });

  await runtime.compactActiveConversation({ trigger: CompactTrigger.Manual });
  const entries = runtime.messageHistory.toRuntimeEntries();
  const planReference = entries.find((entry) => entry.metadata?.source === "plan_file_reference");

  expect(planReference?.message.content).toContain("A plan file exists from plan mode at: /workspace/.claude/plans/plan-session.md");
  expect(planReference?.message.content).toContain("# Approved plan\n\n1. Keep this exact plan.");
});
```

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-compact.test.ts -t "approved plan file"
```

Expected: FAIL because no plan reminder exists.

- [ ] **Step 2: Add formatter**

In `plan-file.ts`, add:

```ts
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export function formatPlanFileReference(input: {
  planFilePath: string;
  planContent: string;
}): string {
  return `A plan file exists from plan mode at: ${input.planFilePath}

Plan contents:

${input.planContent}

If this plan is relevant to the current work and not already complete, continue working on it.`;
}

export function buildPlanFileReferenceEntry(input: {
  planFilePath: string;
  planContent: string;
}): RuntimeMessageEntry {
  return systemReminderAttachmentEntry("plan_file_reference", formatPlanFileReference(input));
}
```

- [ ] **Step 3: Read plan file during compact**

In `compact-active.ts`, when building `postCompactReminderEntries`, append plan file reference before generic read-state reminders:

```ts
const postCompactPlanEntries = await buildPostCompactPlanFileReminderEntries.call(this, {
  traceContext: modelTraceContext,
});
const postCompactReminderEntries = [
  ...postCompactPlanEntries,
  ...buildPostCompactReadStateReminderEntries({
    preservedEntries,
    readFileState: this.readFileState,
  }),
];
```

Helper behavior:

```ts
async function buildPostCompactPlanFileReminderEntries(this: AgentRuntimeInternal, input: { traceContext: TraceContext }) {
  const planFilePath = this.currentPlanFilePath ?? this.approvedPlanFilePath;
  if (!planFilePath) return [];
  if (!this.fileSystemPort) {
    throw createCoreError(CoreErrorType.ConfigurationError, "FileSystemPort is required to restore plan file context after compact", { recoverable: false });
  }
  const read = await this.fileSystemPort.readTextFile({ path: planFilePath, trace: input.traceContext });
  const planContent = read.content.trim();
  if (!planContent) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, `Plan file is empty at ${planFilePath}`, { recoverable: true });
  }
  return [buildPlanFileReferenceEntry({ planFilePath, planContent })];
}
```

Do not catch and downgrade missing/empty file.

- [ ] **Step 4: Preserve existing read-state skip guard**

Keep `shouldSkipPostCompactReadStatePath()` unchanged for `.codex/memories`, `docs/superpowers/plans`, and `.git`. Do not add `.claude/plans` there; explicit plan-file producer owns plan file continuity.

- [ ] **Step 5: Add active plan mode compact test**

Add:

```ts
it("re-injects draft plan file contents when compact runs during plan mode", async () => {
  const runtime = createRuntimeForCompactTest({
    currentPlanFilePath: "/workspace/.claude/plans/plan-session.md",
    files: {
      "/workspace/.claude/plans/plan-session.md": "# Draft plan\n\nStill planning.",
    },
    mode: "plan",
  });

  await runtime.compactActiveConversation({ trigger: CompactTrigger.Manual });
  expect(runtime.messageHistory.toRuntimeEntries().some((entry) =>
    entry.metadata?.source === "plan_file_reference" &&
    String(entry.message.content).includes("# Draft plan")
  )).toBe(true);
});
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-compact.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

Run:

```bash
git add apps/zcode-cli/packages/core/src/runtime/helpers/plan-file.ts apps/zcode-cli/packages/core/src/runtime/helpers/compact-post-reminders.ts apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts apps/zcode-cli/packages/core/tests/runtime-compact.test.ts
git commit -m "feat: restore plan files after compact"
```

Expected: commit succeeds.

---

### Task 7: 修复 Pending Approval / UI / Replayable Snapshot 的 Plan Payload

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts`
- Modify: `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
- Modify: `packages/ui/src/lib/zcodeSessionProjection.ts`
- Modify: `packages/ui/src/lib/toolDisplay.ts`
- Modify: `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx`
- Test: `packages/ui/test/zcodeSessionProjection.test.ts`
- Test: `packages/ui/test/toolDisplay.test.ts`
- Test: `packages/services/test/zcodeAgentService.test.ts`
- Test: `packages/services/test/zcodeSessionService.test.ts`

**Interfaces:**
- Produces: pending ExitPlanMode elicitation `schema` includes original injected input plus `{ interaction: "plan_approval", toolName }`.
- Produces: UI plan result reads `output.filePath`.

- [ ] **Step 1: Read DESIGN.md before UI edit**

Run:

```bash
sed -n '1,220p' DESIGN.md
```

Expected: file is read. Apply only field/display changes; do not redesign the plan block.

- [ ] **Step 2: Write failing pending snapshot test**

In `packages/ui/test/zcodeSessionProjection.test.ts`, update the pending ExitPlanMode approval test to assert:

```ts
expect(elicitation.schema).toMatchObject({
  interaction: "plan_approval",
  toolName: "ExitPlanMode",
  plan: "# Plan",
  planFilePath: "/workspace/.claude/plans/plan-session.md",
});
```

Run:

```bash
pnpm vitest run packages/ui/test/zcodeSessionProjection.test.ts -t "ExitPlanMode"
```

Expected: FAIL because schema currently drops `permission.input`.

- [ ] **Step 3: Preserve injected input in UI projection**

In `pendingExitPlanModeToElicitationEvent`, change schema to:

```ts
schema: {
  ...(isRecord(permission.input) ? permission.input : {}),
  interaction: "plan_approval",
  toolName: permission.toolName,
},
```

Use the existing local `isRecord` helper or add one in the file.

- [ ] **Step 4: Preserve injected input in services adapter**

Apply the same schema merge in `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`.

- [ ] **Step 5: Update interaction broker**

In `interaction-broker.ts`, keep `input: request.input`, and change schema to:

```ts
schema: {
  ...(typeof request.input === "object" && request.input !== null && !Array.isArray(request.input)
    ? request.input as Record<string, unknown>
    : {}),
  interaction: "plan_approval",
  toolName: request.toolName,
},
```

This keeps approval replay self-contained.

- [ ] **Step 6: Update tool display to use `filePath`**

In `toolDisplay.ts`, change extraction:

```ts
const rawPlanFilePath = value["filePath"];
```

Keep the local display model property named `planFilePath` if that avoids component churn; the source field must be `filePath`.

Update `packages/ui/test/toolDisplay.test.ts`:

```ts
output: { plan: "# Plan", filePath: ".claude/plans/plan-session.md", isAgent: false }
```

Expected display path resolves to `/workspace/.claude/plans/plan-session.md`.

- [ ] **Step 7: Run focused UI/services tests**

Run:

```bash
pnpm vitest run packages/ui/test/zcodeSessionProjection.test.ts packages/ui/test/toolDisplay.test.ts
pnpm vitest run packages/services/test/zcodeAgentService.test.ts packages/services/test/zcodeSessionService.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 7**

Run:

```bash
git add packages/ui/src/lib/zcodeSessionProjection.ts packages/ui/src/lib/toolDisplay.ts packages/ui/src/ToolCallBlocks/ToolCallBody.tsx packages/ui/test/zcodeSessionProjection.test.ts packages/ui/test/toolDisplay.test.ts packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts packages/services/test/zcodeAgentService.test.ts packages/services/test/zcodeSessionService.test.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts
git commit -m "fix: preserve plan approval payloads in snapshots"
```

Expected: commit succeeds.

---

### Task 8: Provider-Visible Trajectory 和 Request 验收

**Files:**
- Modify: `apps/zcode-cli/tools/prompt-trajectory/testcases/system-reminder-sr9-runtime/expect.json`
- Create: `apps/zcode-cli/tools/prompt-trajectory/testcases/plan-file-exit/fixture.json`
- Create: `apps/zcode-cli/tools/prompt-trajectory/testcases/plan-file-exit/expect.json`
- Test: `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`
- Test: prompt trajectory tests

**Interfaces:**
- Produces: provider-visible evidence that `ExitPlanMode` schema has no `plan`.
- Produces: provider-visible evidence that post-compact request includes `plan_file_reference`.

- [ ] **Step 1: Add prompt trajectory fixture**

Create a fixture that enters plan mode, writes `.claude/plans/plan-session-id.md`, calls `ExitPlanMode({ allowedPrompts })`, approves, then compacts.

Expected assertions in `expect.json`:

```json
{
  "mustContain": [
    "finished writing your plan to the plan file",
    "does NOT take the plan content as a parameter",
    "Your plan has been saved to:",
    "A plan file exists from plan mode at:"
  ],
  "mustNotContain": [
    "DOES take the plan content as the required plan parameter",
    "\"plan\":{\"type\":\"string\"",
    "required plan parameter"
  ]
}
```

- [ ] **Step 2: Rebuild trajectory dependencies**

Run:

```bash
pnpm --filter @zcode/contracts build
pnpm --filter @zcode/core build
pnpm --filter @zcode/bootstrap build
```

Expected: all build commands exit `0`.

- [ ] **Step 3: Run trajectory tests**

Run:

```bash
pnpm --filter @zcode/prompt-trajectory run:testcases -- plan-file-exit
```

Expected: new plan-file fixture passes and old SR9 runtime fixture is updated for plan file wording.

- [ ] **Step 4: Verify final provider tool contract directly**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/tool-contracts.test.ts -t "ExitPlanMode"
```

Expected: PASS and no provider-visible `properties.plan`.

- [ ] **Step 5: Commit Task 8**

Run:

```bash
git add apps/zcode-cli/tools/prompt-trajectory/testcases/system-reminder-sr9-runtime apps/zcode-cli/tools/prompt-trajectory/testcases/plan-file-exit apps/zcode-cli/packages/core/tests/tool-contracts.test.ts
git commit -m "test: cover plan file provider trajectory"
```

Expected: commit succeeds.

---

### Task 9: Full Validation

**Files:**
- No planned source edits.

**Interfaces:**
- Produces: final validation evidence.

- [ ] **Step 1: Check working tree**

Run:

```bash
git status --short
```

Expected: no unrelated uncommitted changes from this plan. If user WIP exists, leave it untouched and mention it in final handoff.

- [ ] **Step 2: Run focused test suite**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/tool-contracts.test.ts tests/plan-mode-tool.test.ts tests/permission-service.test.ts tests/runtime-compact.test.ts
pnpm vitest run packages/ui/test/zcodeSessionProjection.test.ts packages/ui/test/toolDisplay.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run required repo checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit `0`.

- [ ] **Step 4: Inspect provider-visible diff**

Run:

```bash
rg -n "DOES take the plan content|required plan parameter|properties\\.plan|planFilePath.*output|ExitPlanMode\\(plan" apps/zcode-cli/packages apps/zcode-cli/docs docs packages
```

Expected:

- No active code/provider prompt hits for stale `ExitPlanMode(plan)` contract.
- Historical completed docs may mention the old state only when clearly labeled completed/history.

- [ ] **Step 5: Confirm validation did not edit files**

Run:

```bash
git status --short
```

Expected: clean working tree except pre-existing user WIP. Task 9 must not introduce edits; if validation reveals a required fixture or doc update, stop and add a new focused task rather than committing ad hoc changes from this validation task.

---

## Acceptance Checklist

- [ ] Provider-visible `ExitPlanMode.inputSchema` has `allowedPrompts?` and no `plan`.
- [ ] `ExitPlanMode` prompt says the plan was written to the plan file and the tool reads it from file.
- [ ] Runtime injected input includes `plan` and `planFilePath` before PreToolUse hooks, PermissionRequest hooks, permission broker, and pending approval snapshot.
- [ ] `ExitPlanMode` fails in plan mode when the reserved plan file is missing or empty.
- [ ] `Write` / `Edit` can write only the exact reserved plan file while in plan mode.
- [ ] `Bash`, `ApplyPatch`, arbitrary `Write`, and arbitrary `Edit` remain blocked in plan mode.
- [ ] Approval output shape uses `filePath`, `isAgent: false`, and approved plan content.
- [ ] Tool result model content includes `Your plan has been saved to:`.
- [ ] `plan_mode_exit` includes plan file path when a plan exists.
- [ ] Compact after approval injects `plan_file_reference` with full plan file content.
- [ ] Compact during draft plan mode injects `plan_file_reference` with current draft content.
- [ ] Resume rehydrates current/approved plan file path from session projection.
- [ ] Pending approval replay in desktop and web-remote snapshot preserves plan and plan file path.
- [ ] UI plan block reads `filePath` and shows the existing plan display without redesign.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint` passes.
