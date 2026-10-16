# Conversation Session V4 E2E Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the conversation-session E2E suite after the v4 refactor by retiring old ChatView-helper assertions, rewriting still-valid product semantics against v4 helpers, and keeping the case catalog plus coverage matrix ahead of executable test changes.

**Architecture:** Treat `docs/conversation-session-case-catalog.md` as the product-semantics source of truth and `docs/testing/conversation-session-e2e-coverage-matrix.md` as the automation coverage ledger. Formal v4 E2E must use `packages/desktop/test/e2e/helpers/v4-conversation.ts` and `TID_V4_*` for root/composer/message/queue/action state, plus case-local fixtures and deterministic replay. Specs that still call `prepareConversationE2E()` or import the old aggregate helper are migration corpus only after the 2026-07-05 v4 hard cut. Compatible tool/history/toolbar/summary-panel test ids and focused helper submodules may remain in V4 formal specs.

**Tech Stack:** WebdriverIO desktop E2E, v4 conversation projection protocol, provider replay fixtures, TypeScript, pnpm audit scripts, Docker headless verification.

## Global Constraints

- Update `docs/conversation-session-case-catalog.md` and `docs/testing/conversation-session-e2e-coverage-matrix.md` before creating, rewriting, or deleting conversation-session E2E specs.
- Do not leave old ChatView-helper specs in the default formal gate. A migrated case is either a v4 formal spec, a documented manual-review/pending item, or a documented product-semantics deletion.
- Preserve desktop `desktop-continuous` and mobile `web-remote-replayable` boundaries. Replayable recovery checks must not be asserted against the desktop continuous main chain unless the catalog explicitly says so.
- Use case-local fixtures under the relevant E2E fixture directory. Do not add new provider-basic style shared fixtures.
- Use absolute imports and existing helper APIs. Any missing helper should be added to the v4 helper layer first, not duplicated inside specs.
- For UI-affecting E2E work, read root `DESIGN.md` before touching `packages/ui`; this migration plan does not modify UI code.
- Final implementation must run `pnpm typecheck` and `pnpm lint`. Focused E2E rewrites must also run their replay fixture and, when promoted to gate, Docker headless verification.

## Current State Baseline

- 2026-07-11 Task 2 完成后共有 121 个 conversation-session spec：formal 29，`manual-review/pending` 92。
- 32 个实际调用 `prepareConversationE2E()` 的 legacy formal 已原样降回 pending；formal 中精确导入旧聚合 helper 和调用 `prepareConversationE2E()` 的文件均为 0。
- 2026-07-11 Task 3 完成后，29 个 V4-compatible formal 均具备精确 case manifest 与 case-local provider fixture：formal/manifest/case-local fixture = 29/29/29，逐 spec fixture check = 29 pass、0 error。29 份 fixture 共登记 32 个 case-specific title sidecar（3 个双 session split case 各 2 个），不再让默认 replay 的标题请求回退 legacy `provider-basic.json`。该 admission 只证明确定性输入合同齐备，不提升 coverage 状态。
- `manual-review/pending`（含本次移入的 32 个 legacy spec）只能作为迁移语料或人工 review 证据，不能表述成当前 V4 formal 门禁通过。
- 2026-07-11 Task 1 的 RED 基线是 `pnpm audit:conversation-session-coverage` 失败：roadmap 缺 A11/B08/B09/D11、E10 已 covered 仍残留且状态错位、4 个 generated Markdown stale。Task 1 只修文档事实与 audit，不移动 spec、不补 manifest、不改 CI/Docker 脚本。
- 旧版 111/56/55/28/28 统计、Task 1 的 121/61/60/29/32/25 盘点和下方 28 行初始 triage 表只保留历史分析价值；Task 2 后执行与验收统一以上述 121/29/92/0 legacy formal/25 admission 缺口口径为准。

## 2026-07-11 Execution Waves

本节是当前可拆 task brief 的执行顺序。它覆盖下方早期任务编号中的旧统计，但不改变 catalog-first、matrix-first 和 V4 helper 的总体约束。

```text
Task 1 文档/audit 基线
        |
        v
Task 2 32 个 legacy formal -> manual-review/pending
        |
        v
Task 3 29 个 V4 formal admission（其中 25 个补 manifest/fixture）
        |
        v
Task 4 audit guard：阻止 legacy/pending 被计为 V4 formal
        |
        v
Task 5 CI / Docker 路径修正（本轮不运行 Docker）
        |
        v
Task 6 非 Docker replay + typecheck + lint + 全门禁
```

| 波次 | 状态 | 边界与产出 |
| --- | --- | --- |
| Task 1：文档基线 | completed（2026-07-11） | 已修正 catalog/matrix/roadmap 事实并机械再生成 decision 文档；`pnpm audit:conversation-session-coverage` 通过。未改测试代码、CI、Docker，未运行 Docker。 |
| Task 2：legacy formal 降级 | completed（2026-07-11） | 32 个实际调用 `prepareConversationE2E()` 的 legacy formal 已原样移到 `manual-review/pending`；`conversation-session-v4-load-older` 改用 V4 helper 的安全 task selection，`conversation-session-fork-merged-assistant` 保留 formal。 |
| Task 3：V4 admission | completed（2026-07-11） | 29 个 V4-compatible formal 已逐一通过 fixture check；25 个缺口补为真实 case manifest，共登记 72 条 case-local synthetic 请求（63 `fast-text`、9 `controlled-stream`，含 28 条 title）；全量 29 份 manifest 为 85 requests（75 `fast-text`、10 `controlled-stream`，含 32 条 title），formal/manifest/case-local fixture = 29/29/29。未运行 WDIO replay/Docker，未因 admission 提升 coverage 状态。 |
| Task 4：audit guard | completed（2026-07-11） | 新增可复用 formal admission inspector 与真实临时目录 focused tests；direct-root formal 的 legacy helper、manifest/fixture/path/policy/synthetic reason 和 request ledger id/order/metadata 缺口会阻断 `pnpm audit:conversation-session-coverage --check`。当前 29 admitted / 0 rejected / 92 pending，pending/legacy 不计 formal admission；未提升任何 coverage 状态，未运行 WDIO/Docker。 |
| Task 5：CI / Docker 路径 | completed（2026-07-11） | macOS/Windows 手动 CI 改为 direct-root formal glob 且删除旧 quarantine；Docker 默认 smoke 删除旧 conversation 路径，历史 diagnostic preset 退出，`conversation-session-verified` 在没有当前 V4 Docker 证据时明确不可用；空集合可由 admission 工具原子写入 preset 与文档表格。31 个 focused tests 与独立复审通过。本执行轮不运行 Docker，也不把 29 个 non-Docker admitted formal 写成 Docker verified。 |
| Task 6：非 Docker 验证 | pending | 运行 case-local/default replay、fixture check、coverage audit、`pnpm typecheck`、`pnpm lint` 及适用的非 Docker 全门禁；Docker 风险和待补验证单列。 |

## State And Evidence Flow

```text
catalog product semantics
        |
        v
coverage matrix row status
        |
        v
old formal / pending spec inventory
        |
        +--> obsolete product behavior ----> catalog/matrix deletion note
        |
        +--> still-valid behavior ---------> v4 helper rewrite
        |
        +--> covered by newer v4 spec -----> matrix evidence merge
        |
        v
focused replay fixture run
        |
        v
desktop continuous gate evidence
        |
        v
optional mobile replayable check where catalog requires it
```

## P0 Formal Old-Helper Triage Matrix（初始 28 行历史清单）

这张表形成于旧基线，只覆盖当时识别出的 28 个 formal legacy。2026-07-11 执行 Task 2 时必须以 32 个 legacy formal 的新盘点为全集，先生成完整 inventory，再决定降级路径；不能只处理本表 28 行后宣称 formal gate 已清洁。

| # | Old formal spec | Current semantics | Migration action |
|---|---|---|---|
| 1 | `conversation-session-agent-step-message-scope.test.ts` | Same-session second completion should only count agent steps for the current user message. | Rewrite as v4 formal with projection/timeline evidence and provider request assertions. Keep as independent case because it guards turn scoping. |
| 2 | `conversation-session-ask-user-question-custom-click-multi-question.test.ts` | Multi-question custom answers submitted by click should preserve every answer. | Merge into a v4 AskUserQuestion custom-answer spec that drives `V4InteractionDialogs`. Preserve the click path as one row in the new spec. |
| 3 | `conversation-session-ask-user-question-custom-enter-manual-multi-question.test.ts` | Multi-question custom answers submitted by Enter should preserve manual typing. | Merge into the same v4 AskUserQuestion custom-answer spec. Keep manual typing because it catches IME/text-control regressions. |
| 4 | `conversation-session-ask-user-question-custom-enter-multi-question.test.ts` | Enter on a non-final custom question advances rather than prematurely submitting. | Rewrite with v4 keyboard semantics and explicit dialog step assertions. |
| 5 | `conversation-session-ask-user-question-custom-enter-single-question.test.ts` | Enter on a single custom question submits immediately. | Rewrite with v4 single-question fixture; can live beside the multi-question v4 spec. |
| 6 | `conversation-session-ask-user-question-custom-mixed-manual-multi-question.test.ts` | Mixed mouse and Enter custom answers should not drop middle questions. | Merge into v4 AskUserQuestion keyboard/mouse spec; keep as a distinct scenario inside that file. |
| 7 | `conversation-session-ask-user-question-keyboard-navigation.test.ts` | Custom Enter, Escape return, arrow preselect, Space/Enter option selection. | Rewrite as v4 dialog keyboard-navigation spec. Do not rely on old ChatView focus order. |
| 8 | `conversation-session-background.test.ts` | Background Agent/Bash, task notification, queue/send-now, goal verifier, child tool updates, stop behavior. | Split. Keep notification/queue/stop/goal semantics, but divide into smaller v4 specs and native projection tests. Remove obsolete old-row rendering assertions. |
| 9 | `conversation-session-bash-read-state.test.ts` | Bash read followed by Edit should surface stale-read protection and formatter hint. | Rewrite against v4 tool cards plus filesystem evidence. Keep as formal because it protects tool-state correctness. |
| 10 | `conversation-session-built-in-subagent-model-overrides.test.ts` | Built-in subagent model override should reach the child provider request. | Rewrite as v4 send helper plus provider request inspection. UI assertions are secondary. |
| 11 | `conversation-session-composer-prefix-routing.test.ts` | `@`, `$`, slash, subagent, and skill mentions route through composer suggestions. | Compare against `conversation-session-v4-composer-toolbar.test.ts`; rewrite only uncovered `@`/`$`/subagent/skill routing. Merge duplicated slash coverage into the matrix. |
| 12 | `conversation-session-file-tools-atomic-write.test.ts` | Write/Edit must preserve POSIX executable bit. | Rewrite as v4 formal with filesystem mode assertions. Keep provider fixture local. |
| 13 | `conversation-session-fork-merged-assistant.test.ts` | Fork after tool-call final visible assistant should preserve final reply and handoff file. | Rewrite as v4 fork spec and keep marked as bug-candidate until `E10` passes. This is a priority failing probe. |
| 14 | `conversation-session-markdown-table-layout.test.ts` | Markdown table layout, copy, download, and preview behavior. | Rewrite only v4 `MessageResponse` behaviors still present in product. Move pure visual parity into UI component tests if E2E is brittle. |
| 15 | `conversation-session-model-switch-image-strip.test.ts` | Switching to a non-image model strips image input before provider request. | Rewrite with v4 composer/model controls and provider request verification. Keep because it protects model-capability projection. |
| 16 | `conversation-session-native-file-picker-attachments.test.ts` | Native file picker attachment boundaries for text/image/file selection. | Rewrite with v4 composer attachment surfaces. Desktop-only native picker behavior remains formal. |
| 17 | `conversation-session-oversized-inline-image-attachment.test.ts` | Oversized image attachment limits and error surface. | Rewrite with v4 composer attachment validation. Keep provider non-send assertion for rejected input. |
| 18 | `conversation-session-plan-approval-feedback-user-message.test.ts` | Custom `ExitPlanMode` feedback persists as a visible user message. | Rewrite with v4 plan approval dialog and user row assertion. |
| 19 | `conversation-session-plan-file-compact-continuity.test.ts` | Plan file produced by `ExitPlanMode` remains visible after manual compact. | Rewrite with v4 compact flow. Ensure desktop continuous compact does not adopt mobile replayable gap recovery semantics. |
| 20 | `conversation-session-plan-mode-capabilities.test.ts` | Plan mode blocks mutating tools, permits reads, and decline stops the current turn. | Split into runtime policy assertions and one v4 UI decline-flow spec. |
| 21 | `conversation-session-plan-mode-mcp-permission.test.ts` | Plan mode allows non-destructive MCP and rejects destructive MCP. | Rewrite or move to native protocol test if no UI behavior is required. Keep permission dialog evidence only for the visible user path. |
| 22 | `conversation-session-read-session-context-timeout.test.ts` | Slow lite extraction over 45s still lets current turn complete. | Prefer native runtime/protocol test plus one v4 timeline completion assertion. Avoid relying on old spinner text. |
| 23 | `conversation-session-subagent-interaction-delegate.test.ts` | Child AskUserQuestion and permission requests delegate to parent. | Rewrite against v4 interaction and permission dialogs. Preserve owner/delegation semantics. |
| 24 | `conversation-session-subagent-prompt-assembly.test.ts` | Subagent system prompt assembly shape. | Rewrite as v4 send/provider request evidence. UI timeline assertion is unnecessary unless catalog says visible content matters. |
| 25 | `conversation-session-subagent-provider-registry-cold-start.test.ts` | Alternate provider cold start should work for subagent. | Rewrite with v4 send helper and provider registry evidence. Keep cold-start isolation fixture. |
| 26 | `conversation-session-title-generation-timeout.test.ts` | Skill-link starting message and slow title sidecar writes task title within timeout. | Rewrite with v4 title/sidebar evidence. Keep timeout generous and fixture deterministic. |
| 27 | `conversation-session-tool-error-surface.test.ts` | Failed tool card shows real provider root cause and does not block sibling tool. | Rewrite with v4 tool card selectors and sibling completion assertion. |
| 28 | `conversation-session-webfetch.test.ts` | `WebFetch` `HttpClientPort` success injects tool result into the turn. | Rewrite with v4 tool card plus provider/tool-result evidence. |

## Pending Old-Helper Batch Order

| Batch | Count | Scope | Decision |
|---|---:|---|---|
| main-queue-stop | 11 | Queue, Send Now, stop, interrupted/running actions. | Triage immediately after P0 because many semantics now have v4 coverage and some old cases should merge into `conversation-session-v4-queue*` or `conversation-session-v4-stop-queue*`. |
| compact | 7 | Manual compact, context continuity, plan continuity. | Migrate after plan-mode P0 cases so compact assertions share helpers. |
| goal | 6 | Goal state, verifier, reminders. | Migrate with background split because goal verifier interacts with background work. |
| fork-edit | 3 | Edit/fork branch behavior. | Handle with `E10` failing fork case first, then port remaining pending rows. |
| model-provider | 22 | Provider/model selection, media capability, registry. | Migrate after model switch image-strip and subagent provider P0 cases establish fixture patterns. |
| tools-subagent-plan | 21 | Tool cards, subagents, permissions, plan mode. | Migrate in small semantic groups; avoid one giant resurrection PR. |
| composer-rendering | 5 | Composer routing and markdown/rendering. | Migrate only uncovered rows after v4 composer/toolbar/table audit. |
| other | 7 | Misc runtime/session continuity. | Triage after formal gate is clean. |
| multi-session-config | 1 | Config and multiple sessions. | Keep pending until v4 multi-pane/session binding coverage is confirmed. |

## Task 1: Normalize Documentation Baseline

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Modify: `docs/testing/conversation-session-decision-review-queue.md`
- Modify: `docs/testing/conversation-session-next-decision-review.md`
- Modify: `docs/testing/conversation-session-next-decision-answer-template.md`

**Interfaces:**
- Consumes: current audit output from `pnpm audit:conversation-session-coverage`.
- Produces: catalog and matrix counts that match the audit script, with known missing rows explicitly listed.

- [x] **Step 1: Fix abbreviation drift**

Replace unknown `MR` references for `I22`/`I23` with an abbreviation defined in the matrix legend or add a documented abbreviation entry if `MR` is the intended canonical evidence source.

- [x] **Step 2: Regenerate stale review docs**

Use the existing repository script that generated the decision-review docs. If the script name is unclear, locate it with:

```bash
rg "decision-review|next-decision|conversation-session-coverage" package.json packages docs scripts
```

- [x] **Step 3: Run the audit**

```bash
pnpm audit:conversation-session-coverage
```

- [x] **Step 4: Commit docs baseline**

```bash
git add docs/conversation-session-case-catalog.md docs/testing/conversation-session-e2e-coverage-matrix.md docs/testing/conversation-session-decision-review-queue.md docs/testing/conversation-session-next-decision-review.md docs/testing/conversation-session-next-decision-answer-template.md
git commit -m "docs(testing): normalize conversation session coverage matrix"
```

## Task 2: Remove Old Formal Specs From The Gate

**Files:**
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Move or rewrite: `packages/desktop/test/e2e/conversation-session/conversation-session-*.test.ts`
- Modify: `packages/desktop/test/e2e/conversation-session/manual-review/pending/*` as needed

**Interfaces:**
- Consumes: the 28-row P0 triage matrix above.
- Produces: zero default formal specs that precisely import old `helpers/conversation-session.js` or call `prepareConversationE2E()`; root/composer/message/queue/action state comes from the V4 helper.

- [x] **Step 1: Generate the old formal list**

```bash
rg -l 'prepareConversationE2E\s*\(' packages/desktop/test/e2e/conversation-session -g '*.test.ts' -g '!**/manual-review/**'
```

- [x] **Step 2: Move the 32 legacy formal specs without rewriting assertions**

The 2026-07-11 execution ruling chose one action for the complete mechanical set: move all 32
specs that call `prepareConversationE2E()` to `manual-review/pending` unchanged. Preserve
`conversation-session-fork-merged-assistant.test.ts` as formal. Keep
`conversation-session-v4-load-older.test.ts` formal and replace its lone legacy
`selectTaskById` import with `selectV4TaskById` from the V4 helper.

- [x] **Step 3: Run the gate hygiene check**

```bash
rg -n "from ['\"][^'\"]*helpers/conversation-session\\.js['\"]" packages/desktop/test/e2e/conversation-session -g '*.test.ts' -g '!**/manual-review/**'
rg -n 'prepareConversationE2E\s*\(' packages/desktop/test/e2e/conversation-session -g '*.test.ts' -g '!**/manual-review/**'
```

Expected output after this task: both commands have no matches. Do not use all `TID_CHAT_*`
as a guard: V4-compatible formal specs still safely reuse tool/history/toolbar/summary-panel
test ids and helper submodules.

## Task 3: Rewrite AskUserQuestion Interaction Cases

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-ask-user-question*.test.ts`
- Modify: `packages/desktop/test/e2e/helpers/v4-conversation.ts`

**Interfaces:**
- Consumes: v4 interaction dialogs, custom input control, keyboard event dispatch, provider replay fixtures.
- Produces: v4 coverage for P0 rows 2 through 7.

- [ ] **Step 1: Add catalog rows or map old rows to existing rows**

Record single-question custom Enter, multi-question Enter, click submit, mixed mouse/keyboard, Escape return, arrow preselect, and Space/Enter option selection as accepted semantics.

- [ ] **Step 2: Add missing v4 helper selectors**

Expose helpers for dialog question index, custom input, option buttons, continue/submit button, and dialog close/return behavior.

- [ ] **Step 3: Write focused v4 specs**

Split into two files: one for custom answer persistence and one for keyboard navigation.

- [ ] **Step 4: Run focused replay**

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec packages/desktop/test/e2e/conversation-session/conversation-session-v4-ask-user-question*.test.ts
```

## Task 4: Split Background, Queue, Stop, And Goal Coverage

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-background*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-queue*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-stop*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-goal*.test.ts`

**Interfaces:**
- Consumes: v4 projection active work, queue state, stop state, goal state, desktop notification surface.
- Produces: smaller deterministic specs replacing `conversation-session-background.test.ts` and related pending queue/goal cases.

- [ ] **Step 1: Split the old monolith by state owner**

Use projection/native tests for pure state transitions and WDIO only for visible UI behavior.

- [ ] **Step 2: Preserve delivery boundaries**

Document for every migrated row whether it is desktop continuous only, web remote replayable only, or shared semantic coverage.

- [ ] **Step 3: Run focused specs**

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-background*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-queue*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-stop*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-goal*.test.ts"
```

## Task 5: Rewrite Tool, Runtime, And Filesystem Cases

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-tool*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-bash*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-webfetch.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-file-tools*.test.ts`

**Interfaces:**
- Consumes: v4 tool cards, provider replay, filesystem mode checks, `HttpClientPort`, timeout controls.
- Produces: v4 coverage for P0 rows 1, 9, 12, 22, 27, and 28.

- [ ] **Step 1: Add helper assertions for v4 tool cards**

Expose stable selectors for tool status, tool error text, sibling tool completion, and injected tool result text.

- [ ] **Step 2: Port filesystem-sensitive specs**

Assert actual file mode and content on disk in addition to visible v4 completion state.

- [ ] **Step 3: Run focused specs**

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-tool*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-bash*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-webfetch.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-file-tools*.test.ts"
```

## Task 6: Rewrite Provider, Model, And Subagent Cases

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-model*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-subagent*.test.ts`

**Interfaces:**
- Consumes: v4 composer model controls, provider registry, provider request capture, subagent parent/child interaction routing.
- Produces: v4 coverage for P0 rows 10, 15, 23, 24, and 25.

- [ ] **Step 1: Establish provider request fixtures**

Create one fixture per semantic row so model override, image strip, prompt assembly, and cold-start assertions do not share mutable state.

- [ ] **Step 2: Port visible delegation paths**

Use WDIO only for child AskUserQuestion and permission delegation because those are user-visible parent dialog behaviors.

- [ ] **Step 3: Run focused specs**

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-model*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-subagent*.test.ts"
```

## Task 7: Rewrite Composer, Attachment, Markdown, Plan, Compact, Fork, And Title Cases

**Files:**
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-composer*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-attachment*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-markdown*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-plan*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-compact*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-fork*.test.ts`
- Create or modify: `packages/desktop/test/e2e/conversation-session/conversation-session-v4-title*.test.ts`

**Interfaces:**
- Consumes: v4 composer, attachment store, `MessageResponse`, plan approval dialog, compact command, fork command, title sidecar.
- Produces: v4 coverage for P0 rows 11, 13, 14, 16, 17, 18, 19, 20, 21, and 26.

- [ ] **Step 1: Resolve overlap with existing v4 specs**

Use the matrix to merge behavior already covered by `conversation-session-v4-composer-toolbar`, `conversation-session-v4-fork*`, `conversation-session-v4-compact*`, and `conversation-session-v4-permission*`.

- [ ] **Step 2: Keep `E10` visible as a failing probe until fixed**

Do not mark fork merged-assistant accepted/covered until the v4 spec passes with provider replay and handoff file evidence.

- [ ] **Step 3: Run focused specs**

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-composer*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-attachment*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-markdown*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-plan*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-compact*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-fork*.test.ts" \
  --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-title*.test.ts"
```

## Task 8: Promote And Verify

**Files:**
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `packages/desktop/test/e2e/conversation-session/**`

**Interfaces:**
- Consumes: all migrated specs and fixtures.
- Produces: a clean formal gate and an explicit remaining manual-review queue.

- [ ] **Step 1: Run coverage audit**

```bash
pnpm audit:conversation-session-coverage
```

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck
pnpm lint
```

- [ ] **Step 3: Run focused E2E group**

```bash
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec "packages/desktop/test/e2e/conversation-session/conversation-session-v4-*.test.ts"
```

- [ ] **Step 4: Run Docker headless gate before broad promotion**

Use the existing desktop E2E Docker command documented in the repository. If the exact command has drifted, locate it with:

```bash
rg "docker.*e2e|wdio.*docker|conversation-session-v4" package.json packages docs scripts
```

- [ ] **Step 5: Commit migration**

```bash
git add docs/conversation-session-case-catalog.md docs/testing/conversation-session-e2e-coverage-matrix.md packages/desktop/test/e2e/conversation-session
git commit -m "test(e2e): migrate conversation session cases to v4"
```
