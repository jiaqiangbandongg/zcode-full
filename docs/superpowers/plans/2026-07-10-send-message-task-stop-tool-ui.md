# SendMessage And TaskStop Tool UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `SendMessage` 和 `TaskStop` 增加与现有 ToolCall 体系一致的紧凑摘要和结构化详情，彻底避免 fallback raw JSON 展示。

**Architecture:** 在 `@zcode/shared` 固定 canonical tool name 到 presentation family 的映射，UI 的 `resolveToolCallRenderer` 只按 family 路由。Core 复用 `ToolResultDisplayPayload`，从 hook/model serialization 之前的原始 output 生成 `local_agent_message` / `task_stop` display；UI 用集中 reader 统一读取实时 event、持久化 metadata 和 provider 兼容形态，renderer 只消费已校验字段并保留明确的旧数据 fallback。

**Tech Stack:** TypeScript 6、React 19、Vitest 4、react-dom/server、Tailwind semantic tokens、lucide-react、FormatJS i18n。

## Global Constraints

- 先更新 `docs/ui/tool-display-rendering.md`，再修改实现。
- `SendMessage` 与 lowercase `send_message` 保持不同 identity；后者继续是 unknown/legacy mailbox surface。
- UI 只使用 semantic color token、`text-[13px]` 紧凑排版、lucide 图标和现有 `ToolLayout`。
- 同时兼容桌面、Web、手机窄屏、Zai Light/Zai Dark 和中英文。
- 允许扩展既有 `ToolResultDisplayPayload` schema 和 Core display 生成逻辑；不改变工具 input/output contract、model content、background task stop 行为、session mailbox 行为或 desktop continuous / web replayable 边界。
- 按用户工作流不自动提交；实现完成后保留本地分支 diff 供复核。
- Tasks 1-4 记录最初 renderer 落地过程且对应实现已经存在；最终字段与摘要语义以 Task 5 为准，本轮 review 修复与验证以 Task 6 为准。

---

### Task 1: Register The TaskStop Presentation Identity

**Files:**

- Modify: `packages/ui/test/toolIdentity.test.ts`
- Modify: `packages/shared/src/tool-identity.ts`

**Interfaces:**

- Consumes: `resolveToolCallIdentity(toolCall)` and `getZCodeToolFamilyForName(name)`.
- Produces: canonical `TaskStop` identity with family `task-control`.

- [x] **Step 1: Write the failing identity test**

```ts
it("recognizes current TaskStop as task control", () => {
  expect(resolveToolCallIdentity({ toolName: "TaskStop" })).toMatchObject({
    toolName: "TaskStop",
    family: "task-control",
    isLegacy: false,
  });
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `pnpm exec vitest run packages/ui/test/toolIdentity.test.ts`

Expected: FAIL because `TaskStop` is not in `ZCODE_KNOWN_TOOL_NAMES` and resolves to `unknown`.

- [x] **Step 3: Add the canonical name and family**

```ts
export const ZCODE_KNOWN_TOOL_NAMES = [
  // existing names
  "TaskStop",
] as const;

export type ZCodeToolFamily =
  // existing families
  "task-control";

const TOOL_FAMILY_BY_NAME = {
  // existing mappings
  TaskStop: "task-control",
} satisfies Record<ZCodeKnownToolName, ZCodeToolFamily>;
```

- [x] **Step 4: Run the identity test and verify GREEN**

Run: `pnpm exec vitest run packages/ui/test/toolIdentity.test.ts`

Expected: all tests pass, including the existing assertion that lowercase `send_message` remains `unknown`.

---

### Task 2: Route Both Tools To Dedicated Summary Renderers

**Files:**

- Create: `packages/ui/test/messageTaskControlToolCallBlock.test.ts`
- Create: `packages/ui/src/ToolCallBlocks/renderers/send-message.tsx`
- Create: `packages/ui/src/ToolCallBlocks/renderers/task-stop.tsx`
- Modify: `packages/ui/src/ToolCallBlocks.tsx`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`

**Interfaces:**

- Consumes: `ToolCallBlockRenderContext`, `ToolLayout`, `useZCodeIntl`.
- Produces: `SendMessageToolCallBlock(context)` and `TaskStopToolCallBlock(context)`.

- [x] **Step 1: Write failing route/summary tests through ToolCallBlock**

```ts
it("routes SendMessage to a semantic summary", () => {
  const html = renderToolCall({
    toolId: "send-1",
    toolName: "SendMessage",
    kind: "SendMessage",
    title: "SendMessage",
    input: { to: "agent_alpha", summary: "同步结论", message: "请复核结果" },
    output: { status: "success", messageId: "msg_1", delivery: "queued" },
    status: "completed",
    raw: {},
  });
  expect(html).toContain("已发送消息");
  expect(html).toContain("同步结论");
  expect(html).toContain("agent_alpha");
});

it("routes TaskStop to a semantic summary", () => {
  const html = renderToolCall({
    toolId: "stop-1",
    toolName: "TaskStop",
    kind: "TaskStop",
    title: "TaskStop",
    input: { task_id: "task_alpha" },
    output: JSON.stringify({
      message: "Successfully stopped task: task_alpha",
      task_id: "task_alpha",
      task_type: "local_agent",
    }),
    status: "completed",
    raw: {},
  });
  expect(html).toContain("已停止任务");
  expect(html).toContain("task_alpha");
  expect(html).toContain("local_agent");
});
```

- [x] **Step 2: Run the tests and verify RED**

Run: `pnpm exec vitest run packages/ui/test/messageTaskControlToolCallBlock.test.ts`

Expected: FAIL because both calls still route to `FallbackToolCallBlock`.

- [x] **Step 3: Add minimal summary renderers and family routes**

```ts
switch (identity.family) {
  case "message":
    return SendMessageToolCallBlock;
  case "task-control":
    return TaskStopToolCallBlock;
  // existing cases
}
```

`SendMessageToolCallBlock` uses `SendIcon`, localized sending/sent kind text, input `summary` as primary text, and input `to` as monospace secondary text. `TaskStopToolCallBlock` uses `CircleStopIcon`, localized stopping/stopped kind text, resolved task id as primary text, and output `task_type` as monospace secondary text.

- [x] **Step 4: Run the tests and verify GREEN**

Run: `pnpm exec vitest run packages/ui/test/messageTaskControlToolCallBlock.test.ts packages/ui/test/toolCallBlocks.test.ts`

Expected: all selected tests pass.

---

### Task 3: Render Structured Details Without Raw JSON

**Files:**

- Modify: `packages/ui/test/messageTaskControlToolCallBlock.test.ts`
- Modify: `packages/ui/src/ToolCallBlocks/renderers/send-message.tsx`
- Modify: `packages/ui/src/ToolCallBlocks/renderers/task-stop.tsx`

**Interfaces:**

- Consumes: `toolCall.input`, `toolCall.output`, `toolCall.raw.rawInput`, `toolCall.raw.rawOutput`, `toolCall.raw.result.content`.
- Produces: field-level details and snapshot field loading support.

- [x] **Step 1: Add failing force-open renderer tests**

This step was superseded by Task 5. The final `SendMessage` detail contract contains only target, summary, and message; delivery and all ids remain hidden. The final `TaskStop` detail contract contains task type, command, and result without repeating task id.

- [x] **Step 2: Run the tests and verify RED**

Run: `pnpm exec vitest run packages/ui/test/messageTaskControlToolCallBlock.test.ts`

Expected: FAIL because minimal renderers do not yet expose expanded fields.

- [x] **Step 3: Implement bounded payload extraction**

Each renderer must:

```ts
function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
```

Input precedence is `toolCall.input` then `raw.rawInput`/`raw.input`. Structured output precedence is `toolCall.output` then `raw.rawOutput`/`raw.output` and `raw.result.content`; non-JSON `toolCall.output` or `raw.result.content` is displayed only as the result text. Render only contract fields, use `whitespace-pre-wrap break-words` for prose, `font-mono` for ids/paths/commands, and append `ToolSnapshotFieldNotice` outside the detail panel.

- [x] **Step 4: Run the tests and verify GREEN**

Run: `pnpm exec vitest run packages/ui/test/messageTaskControlToolCallBlock.test.ts`

Expected: all renderer tests pass and no fallback raw JSON appears.

---

### Task 4: Verify The Complete UI Boundary

**Files:**

- Review: `docs/ui/tool-display-rendering.md`
- Review: all files changed by Tasks 1-3.

**Interfaces:**

- Consumes: repository lint/typecheck/test scripts.
- Produces: a verified worktree diff ready for user review.

- [x] **Step 1: Run focused regression tests**

Run: `pnpm exec vitest run packages/ui/test/toolIdentity.test.ts packages/ui/test/messageTaskControlToolCallBlock.test.ts packages/ui/test/toolCallBlocks.test.ts packages/ui/test/readSessionContextToolCallBlock.test.ts`

Expected: all selected tests pass with zero failures.

- [x] **Step 2: Run required mechanical checks**

Run: `pnpm typecheck`

Expected: exit code 0.

Run: `pnpm lint`

Expected: exit code 0.

- [x] **Step 3: Review the scoped diff**

Run: `git diff --check`

Expected: exit code 0 and no whitespace errors.

Run: `git status --short`

Expected: only the spec, plan, identity, renderer, locale, route, and focused test files from this plan are modified or added.

---

### Task 5: Reduce Message And Task Stop Summary Density

**Files:**

- Modify: `docs/ui/tool-display-rendering.md`
- Modify: `packages/ui/test/messageTaskControlToolCallBlock.test.ts`
- Modify: `packages/ui/src/ToolCallBlocks/renderers/send-message.tsx`
- Modify: `packages/ui/src/ToolCallBlocks/renderers/task-stop.tsx`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`

**Interfaces:**

- Consumes: existing `ToolLayout` primary/secondary summary slots and bounded input/output extraction.
- Produces: sentence-like `SendMessage` summaries and task-id-only `TaskStop` summaries with reduced expanded fields.

- [x] **Step 1: Update the renderer tests and verify RED**

The `SendMessage` route test must require `已发送`, input `summary`, connector `给`, and target agent in the collapsed summary. Its force-open test must require only target, summary, and message fields while rejecting delivery, ids, output path, and result text. The `TaskStop` route test must require `已停止` and task id while rejecting `task_type`; its force-open test must require task type, command, and result while rejecting the repeated `任务 ID` detail label.

Run: `pnpm exec vitest run packages/ui/test/messageTaskControlToolCallBlock.test.ts`

Expected: FAIL because the current renderers still expose output metadata, show `task_type` in the collapsed summary, and repeat task id in details.

- [x] **Step 2: Implement the minimal renderer and locale changes**

Change the successful/running SendMessage kind labels to `已发送`/`正在发送` (`Sent`/`Sending`), add a localized `给`/`to` connector before the monospace target, and retain output parsing only for failed status and tooltip text. Remove all output metadata fields from its detail panel. Change TaskStop kind labels to `已停止`/`正在停止` (`Stopped`/`Stopping`), remove `task_type` from `secondaryText`, and remove task id from its detail panel.

- [x] **Step 3: Verify GREEN and the repository boundary**

Run: `pnpm exec vitest run packages/ui/test/messageTaskControlToolCallBlock.test.ts packages/ui/test/toolIdentity.test.ts packages/ui/test/toolCallBlocks.test.ts packages/ui/test/readSessionContextToolCallBlock.test.ts`

Expected: all selected tests pass with zero failures.

Run: `pnpm typecheck && pnpm lint && git diff --check`

Expected: all commands exit 0; lint may report only pre-existing warnings outside the changed files.

---

### Task 6: Preserve Structured Results And Complete Terminal Semantics

**Files:**

- Modify: `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/result-display.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Create: `apps/zcode-cli/packages/core/tests/tool-result-display.test.ts`
- Create: `packages/ui/src/ToolCallBlocks/toolResultDisplay.ts`
- Modify: `packages/ui/src/ToolCallBlocks/renderers/send-message.tsx`
- Modify: `packages/ui/src/ToolCallBlocks/renderers/task-stop.tsx`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/test/messageTaskControlToolCallBlock.test.ts`
- Review: `packages/ui/test/reactStableReferences.test.ts`

**Interfaces:**

- Consumes: canonical tool name, original runtime output, `ToolCallResult.result.display`, completed tool part metadata, `ToolCallBlockRenderContext`.
- Produces: strict `local_agent_message` / `task_stop` display payloads and `readToolResultDisplay(raw)` for realtime/persisted/provider raw shapes.

- [x] **Step 1: Add RED tests for Core display generation**

Add focused tests that require `createToolResultDisplay("SendMessage", output)` to return only business status/error/message, require `createToolResultDisplay("TaskStop", output)` to return task id/type/command/message, and require lowercase `send_message` not to produce the local-agent display.

Run: `apps/zcode-cli/node_modules/.bin/vitest run packages/core/tests/tool-result-display.test.ts`

Expected: FAIL because only `file_diff` display exists and `createToolResultDisplay` does not accept a tool name.

- [x] **Step 2: Implement strict display schemas and Core generation**

Extend the discriminated union with `local_agent_message` and `task_stop`. Change `createToolResultDisplay` to receive the canonical tool name, validate the corresponding runtime output schema, and return only fields required by the UI. Keep the existing bounded `file_diff` path unchanged for all tools.

- [x] **Step 3: Verify Core GREEN and unchanged file diff behavior**

Run: `apps/zcode-cli/node_modules/.bin/vitest run packages/core/tests/tool-result-display.test.ts packages/core/tests/tool-executor-trace.test.ts`

Expected: all selected Core tests pass, including the existing `file_diff` event assertion.

- [x] **Step 4: Add RED tests for UI delivery shapes and terminal states**

Add renderer tests for live `raw.result.display`, persisted `raw.display`, provider `raw.rawOutput.display`, explicit legacy hook envelope parsing, SendMessage business failure, and both tools' `denied` / `stopped` labels. Add assertions that no non-success state renders the successful verb.

Run: `pnpm exec vitest run packages/ui/test/messageTaskControlToolCallBlock.test.ts packages/ui/test/reactStableReferences.test.ts`

Expected: FAIL on missing display reader, incomplete terminal labels, hook-augmented TaskStop output, and inline JSX props.

- [x] **Step 5: Implement the UI reader, status matrix, and stable JSX props**

Create one strict reader for the three raw display locations. Prefer display fields in both renderers, retain only explicit legacy output formats as fallback, add localized stopped/denied action labels, and memoize non-primitive `ToolLayout` props with `useMemo`.

- [x] **Step 6: Verify UI GREEN and compatibility**

Run: `pnpm exec vitest run packages/ui/test/messageTaskControlToolCallBlock.test.ts packages/ui/test/reactStableReferences.test.ts packages/ui/test/toolIdentity.test.ts packages/ui/test/toolCallBlocks.test.ts packages/ui/test/readSessionContextToolCallBlock.test.ts`

Expected: all selected tests pass; lowercase `send_message` remains unknown and existing renderers remain unchanged.

- [x] **Step 7: Run complete repository gates**

Run serially: full UI tests, relevant CLI package tests, `pnpm typecheck`, `pnpm lint`, and `git diff --check`. Then run the existing SendMessage/TaskStop Electron E2E cases without adding preview-only code.

Verification result: full UI tests passed (3810), relevant CLI tests passed (101), root and CLI typechecks passed, root lint passed with pre-existing warnings only, changed CLI sources passed targeted oxlint, and the two existing Electron E2E cases passed. The full nested CLI lint still fails on pre-existing max-lines and related errors outside this change.

---

### Task 7: Bound TaskStop Display And Remove Empty Terminal Details

**Files:**

- Modify: `docs/ui/tool-display-rendering.md`
- Modify: `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/result-display.ts`
- Modify: `apps/zcode-cli/packages/core/tests/tool-result-display.test.ts`
- Modify: `packages/ui/src/ToolCallBlocks/toolResultDisplay.ts`
- Modify: `packages/ui/src/ToolCallBlocks/renderers/task-stop.tsx`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/test/messageTaskControlToolCallBlock.test.ts`

- [x] **Step 1: Add RED coverage for an oversized TaskStop display**

Require the projected command and message to stay within 16 KiB UTF-8 each and expose `truncated: true` when either field is shortened.

- [x] **Step 2: Implement byte-bounded TaskStop display projection**

Bound both fields before the display leaves Core, preserve valid UTF-8 code points, append an explicit truncation marker, and extend the display schema/reader with the optional flag.

- [x] **Step 3: Add RED coverage for terminal details**

Require denied/stopped reasons to appear as the result when available, and require a terminal TaskStop with no detail fields to have no expand affordance or empty panel.

- [x] **Step 4: Implement terminal detail availability**

Reuse `context.errorText` for all unsuccessful terminal states and enable `ToolLayout` toggling only when at least one visible detail or truncation notice exists.

- [x] **Step 5: Run focused and repository verification**

Run Core/UI focused tests, typechecks, lint, `git diff --check`, and review the final scoped diff.

---

### Task 8: Remove Repeated TaskStop Command From The Result Row

**Files:**

- Modify: `docs/ui/tool-display-rendering.md`
- Modify: `apps/zcode-cli/packages/core/tests/tool-result-display.test.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/result-display.ts`
- Modify: `packages/ui/test/messageTaskControlToolCallBlock.test.ts`
- Modify: `packages/ui/src/ToolCallBlocks/renderers/task-stop.tsx`

**Interfaces:**

- Consumes: `TaskStopOutput`, `task_stop` display payload, and the explicit legacy TaskStop JSON envelope.
- Produces: a concise successful display result while preserving the original tool output/model content and arbitrary provider result messages.

- [x] **Step 1: Add RED coverage for Core display projection**

Require an output containing `message: "Successfully stopped task: task_alpha (pnpm test)"` and `command: "pnpm test"` to keep `command` unchanged but project `message: "Successfully stopped task: task_alpha"`.

- [x] **Step 2: Implement exact standard-message compaction in Core**

Compare the original message with the full generated success template. Compact only an exact match; then apply the existing UTF-8 display budget. Do not mutate the TaskStop output or model content.

- [x] **Step 3: Add RED coverage for persisted legacy output**

Render a TaskStop without display metadata whose JSON output contains the standard success message and command. Require the command text to appear once, the concise result to remain visible, and a custom result message to remain unchanged.

- [x] **Step 4: Implement exact legacy normalization in the UI renderer**

Normalize only the exact `Successfully stopped task: <taskId> (<command>)` message before rendering the successful result field. Failure, denied, stopped, and custom successful result messages remain untouched.

- [x] **Step 5: Run focused and repository verification**

Run Core/UI focused tests, both typechecks, lint, `git diff --check`, and review the final scoped diff.
