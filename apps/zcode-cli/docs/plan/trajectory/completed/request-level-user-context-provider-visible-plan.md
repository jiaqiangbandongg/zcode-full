# Request-level UserContext Provider-visible Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not move from one phase to the next without user confirmation after tests, code review, and prompt-trajectory e2e. Do not create a commit unless the user explicitly asks after review.

**Goal:** 在不重构 `MessageHistory` prefix 生命周期的前提下，确定 request-level `userContext` 的最终 provider-visible 内容、顺序和关键请求面。

**Status:** ✅ Complete for the provider-visible active scope. Full request prefix projection / `MessageHistory` structural split remains a future reference, not part of this completed plan.

**Architecture:** 保持当前 `ContextBuilder -> MessageHistory` prefix 模型：system prompt blocks、skills listing、context meta-user 仍在初始化时进入内存 `MessageHistory`，reset/compact 继续依赖 `countContextPrefixMessages(...)` 保留 prefix。本 plan 只修改最终发送给 model provider 的 request-level userContext 文案结构、字段顺序、custom/compact/Explore 表现和验证覆盖。完整 request prefix projection 拆分（把 system / skills / userContext 移出 `MessageHistory`，改为每次 request 前投影）不在本计划内，作为未来可能的重构方向。

**Tech Stack:** TypeScript, Vitest, `@zcode/core`, prompt-trajectory.

---

## Scope

本 plan 负责：

- 保持 `MessageHistory` prefix 现状，不把 system / skills / userContext 从 history 中拆出。
- 保留 ZCode 现有 provider-visible title `# user_instructions`，并固定 request-level userContext 的前置结构和相对顺序。
- 保持 ZCode 当前 `AGENTS.md -> CLAUDE.md` 单文件 priority，作为明确的产品决策。
- 将 `project_context` 作为 ZCode extra 内容拼到 `# user_instructions` block 末尾，不再作为独立 provider-visible field。
- 锁定 userContext 顺序：`# user_instructions` block 在前，`# currentDate` 在后；无 instruction/project context 时不生成空 `# user_instructions`。
- 复核 custom system prompt、compact/reset、Explore subagent 的最终 provider body，按需做小范围 targeted fixes。
- 每个 phase 用 focused tests + prompt-trajectory e2e 验证最终 request body。

本 plan 不负责：

- 把 system / skills / request-level userContext 从 `MessageHistory` 移出。
- 删除 `countContextPrefixMessages(...)` 或重构 request assembly segments。
- 完整多层 `CLAUDE.md` / `.claude/rules` / include / conditional discovery。
- user-message `content[]` merge、attachment bubble-up、ToolSearch、MCP instructions。
- exact wording；目标是固定 provider-visible 结构、顺序与语义，同时保留 ZCode 自身的 section title。

## Current Baseline

- `ContextBuilder.build()` 当前输出 system messages、skills listing meta-user 和 context meta-user。
- context meta-user 当前包含 `# currentDate`、`# user_instructions`、`project_context`，并在初始化时写入内存 `MessageHistory`。
- custom `systemPrompt` 当前保留 skills/currentDate/userInstructions，但 `project_context` 仍因 custom path 被剔除；本 plan 会把它随 `# user_instructions` 归属恢复为默认保留。
- `date_change` reminder 已由 system-reminder slice 完成；本 plan 不重新设计跨日逻辑。
- 完整 prefix projection 方案（request-time 插入、不写入 history）曾作为独立方案讨论；当前 active plan 暂不执行该结构拆分。

## Product Decisions

| ID | 决策 | 当前 plan 口径 |
| --- | --- | --- |
| PVC-D1 | 内部结构 | 保持现状：prefix 继续在内存 `MessageHistory` 中。 |
| PVC-D2 | provider-visible title | 暂时沿用 ZCode 现有 `# user_instructions` title；不改用其他 section 名，也不按文件名动态生成 `# agentMd`。 |
| PVC-D3 | instruction source | 保持 `AGENTS.md -> CLAUDE.md` priority，作为明确的产品决策。 |
| PVC-D4 | project context | 默认拼到 `# user_instructions` block 末尾，作为 ZCode extra 内容；不新增独立 `# projectContext`。 |
| PVC-D5 | custom system prompt | custom body 跳过 default system/systemContext，但保留 userContext；`project_context` 因归入 `# user_instructions` 也应保留。 |
| PVC-D6 | compact/reset | 先保持现有 prefix 保留机制；只验证最终 provider body，不做 request-time projection 重构。 |
| PVC-D7 | Explore subagent | read-only omit 语义：Explore 子请求 omit instruction/project userContext block，保留 `currentDate`。 |
| PVC-D8 | full discovery | Postpone：不实现多层 `CLAUDE.md` / `.claude/rules` / local / include / conditional discovery。 |

## Phase PVC0: Normalize Plan State

**Phase goal:** 将 active plan 切换为 provider-visible only 路线，并把旧 full projection plan 标记为 future reference。

**User confirmation gate:** PVC0 文档更新完成后停止，等待用户确认再进入 PVC1。

### Checklist

- [x] 旧的完整 prefix projection 计划标注为 future structural split reference，不作为当前 active plan。
- [x] 口径改为“双路径”：当前 active 是 provider-visible formatting，完整 request prefix projection postponed/reference。
- [x] worklog 合并更新同一条 request-level userContext record，不新增重复 action block。
- [x] 旧 UC1 split runtime 代码已由用户回退；当前实现基线恢复为 prefix-in-MessageHistory。

### Verification

```bash
rg -n "UC1 expanded|完整 request prefix assembly" apps/zcode-cli/docs/plan/trajectory apps/zcode-cli/worklogs/trajectory-align-log.md
```

Expected: 旧 full projection plan 只作为 reference 出现；active plan 指向 `request-level-user-context-provider-visible-plan.md`。

## Phase PVC1: UserContext Content And Order Formatting

**Phase goal:** 在保持 `MessageHistory` prefix 生命周期不变的情况下，调整 context meta-user 的 provider-visible text。

**User confirmation gate:** PVC1 完成 tests + prompt-trajectory e2e 后停止，等待用户 review。

### Checklist

- [x] 写本 phase 的 RED tests 前，先用 `git status --short` 确认没有旧 UC1 split runtime 代码残留。
- [x] `# user_instructions` 继续作为 provider-visible title。
- [x] instruction/project 内容进入同一个 `# user_instructions` block。
- [x] `project_context` 拼到 `# user_instructions` block 末尾；没有 instruction 但有 project context 时仍生成 `# user_instructions`。
- [x] 没有 instruction 且没有 project context 时不生成空 `# user_instructions`。
- [x] `# user_instructions` 位于 `# currentDate` 前。
- [x] `AGENTS.md -> CLAUDE.md` priority 保持不变。

### Target Shape

```text
<system-reminder>
As you answer the user's questions, you can use the following context:
# user_instructions
Codebase and project instructions are shown below.

Source: /path/to/AGENTS.md
...

Project context:
...

# currentDate
Today's date is YYYY-MM-DD.

IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
```

### Files

- Modify: `apps/zcode-cli/packages/core/src/context/builder.ts`
- Modify: `apps/zcode-cli/packages/core/src/context/types.ts`
- Add: `apps/zcode-cli/packages/core/src/context/sections/request-user-context.ts`
- Test: `apps/zcode-cli/packages/core/tests/context-builder.test.ts`
- Testcase: `apps/zcode-cli/tools/prompt-trajectory/testcases/request-user-context/`

### Tests

- [x] ContextBuilder: no instruction/project -> only `# currentDate`.
- [x] ContextBuilder: AGENTS.md + CLAUDE.md -> provider body contains `# user_instructions` with AGENTS.md content and not CLAUDE.md content.
- [x] ContextBuilder: only CLAUDE.md -> provider body contains `# user_instructions` with CLAUDE.md content.
- [x] ContextBuilder: projectContext only -> provider body contains `# user_instructions` and no empty instruction source.
- [x] ContextBuilder: instruction + projectContext -> project context appears at the end of `# user_instructions`, before `# currentDate`.

### Verification

```bash
pnpm --filter @zcode/core exec vitest tests/context-builder.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/core build
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases/request-user-context --out-root out/request-user-context-pvc1
```

Expected: final request body has `# user_instructions` before `# currentDate`; no other instruction section title; no standalone `# projectContext` / `## 项目信息` outside `# user_instructions`.

## Phase PVC2: Custom And Compact Surface Verification

**Phase goal:** 保持现有 prefix lifecycle，验证 custom/compact/reset 后 provider body 没有丢失、重复或错序；只做 targeted fixes。

**User confirmation gate:** PVC2 完成 tests + prompt-trajectory e2e 后停止，等待用户 review。

### Checklist

- [x] custom `systemPrompt` path 保留 context meta-user。
- [x] custom `systemPrompt` path 中 `project_context` 随 `# user_instructions` 保留。
- [x] compact/reset 后继续提问时，provider body 中 userContext prefix 不重复、不缺失。
- [x] compact auxiliary request 若发 provider request，按当前产品决策包含 userContext；若现有路径无该能力，记录为 targeted follow-up，不扩大成 prefix projection 重构。

### Files

- Modify as needed: `apps/zcode-cli/packages/core/src/context/builder.ts`
- Modify as needed: `apps/zcode-cli/packages/core/src/runtime/helpers/compact.ts`
- Modify as needed: `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`
- Testcase: `apps/zcode-cli/tools/prompt-trajectory/testcases/request-user-context/`

### Tests

- [x] Runtime trace: custom system prompt + projectContext -> request body contains CLI prefix + custom system + context meta-user with `# user_instructions` and `# currentDate`, no default dynamic system.
- [x] Runtime trace: reset/compact-like history preservation -> context meta-user appears once.
- [x] Prompt-trajectory: custom-system-project case exports expected request body.
- [x] Prompt-trajectory: multi-round/compact case exports no duplicate context meta-user.

### Verification

```bash
pnpm --filter @zcode/core exec vitest tests/context-builder.test.ts tests/runtime-trace.test.ts tests/runtime-compact.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/core build
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases/request-user-context --out-root out/request-user-context-pvc2
```

Evidence: `apps/zcode-cli/tools/prompt-trajectory/out/request-user-context-pvc2/test20260605-142700`；`custom-system-project`、`compact-prefix` 的 derived request body 均为 `# user_instructions -> Project context -> # currentDate`，且每个 provider request 中 userContext prefix 只出现一次。

## Phase PVC3: Explore Subagent Context Trimming

**Phase goal:** 实现 read-only agent 的 userContext 裁剪语义：Explore 子请求 omit instruction/project userContext block，保留 `currentDate`。

**User confirmation gate:** PVC3 完成 tests + prompt-trajectory e2e 后停止，等待用户 review。

### Checklist

- [x] 找到 ZCode Explore subagent request 构造路径。
- [x] Explore 子请求不包含 `# user_instructions`。
- [x] Explore 子请求保留 `# currentDate`。
- [x] 主会话 request 不受影响。
- [x] prompt-trajectory 可表达 subagent child request，并已补 focused runtime tests 覆盖。

### Files

- Modify as needed: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Modify as needed: `apps/zcode-cli/packages/core/src/context/builder.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`
- Test as available: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

### Tests

- [x] Explore child request: no `# user_instructions`.
- [x] Explore child request: has `# currentDate`.
- [x] Parent main request: still has both `# user_instructions` and `# currentDate` when instruction/project context exists.

### Verification

```bash
pnpm --filter @zcode/core exec vitest tests/subagent-explore.test.ts tests/runtime-trace.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/core build
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases/request-user-context --out-root out/request-user-context-pvc3
```

Evidence: `apps/zcode-cli/tools/prompt-trajectory/out/request-user-context-pvc3/test20260605-144412`；`explore-trim/0002-non-incremental-change.openai_request_body.json` 是 Explore child request，包含 `# currentDate`，不包含 `# user_instructions` / `Project context:`；parent initial/final request 仍保留完整 request-level userContext。

## Final Acceptance

- [x] Final provider body keeps ZCode `# user_instructions` title with the request-level userContext order/structure defined above.
- [x] ZCode `AGENTS.md -> CLAUDE.md` priority remains intact and documented as a deliberate product decision.
- [x] `project_context` is appended inside `# user_instructions`, not a standalone provider field.
- [x] `# user_instructions` precedes `# currentDate`.
- [x] Empty `# user_instructions` is not emitted.
- [x] custom system prompt keeps userContext.
- [x] compact/reset does not duplicate or drop userContext.
- [x] Explore child request omits instruction/project userContext but keeps currentDate, with focused test and prompt-trajectory evidence.
- [x] Full prefix projection / MessageHistory cleanup remains future reference, not current active scope.
