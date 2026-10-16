# User Message Provider Request Ordering Plan

> **Status:** Complete for the 2026-06-06 ordering-only scope except the postponed first-turn attachment-vs-userContext ordering TODO. File path is kept for existing references, but the active scope is no longer adjacent user-message merge.

## Goal

在不改 session store / UI transcript / replay 存储 schema 的前提下，让最终发给 model provider 的 user messages 满足当前已确认的 provider-visible ordering 规则：

- attachment-like / system-reminder user context 在 request-local projection 中 bubble 到对应 real user prompt 前；
- 同一真实 user turn 内 ZCode 已支持的 file / image / url prompt attachments 位于真实 prompt 前；首轮 attachment 是否应越过 request-level userContext 进入 prompt 前方，作为 postponed TODO 单独跟进；
- direct pasted image 如果已经是同一条 real user `content[]` 里的 block，则保持原始 block 顺序，不按 attachment bubble-up 处理；
- 不做相邻 `role: "user"` messages 的通用合并；该能力保留为 postponed/future phase；
- provider request 输出前 strip runtime metadata，并只在最后一条非 system message 上 finalize cache-control marker。

## Current Scope

本 plan 负责：

- provider request 前的 user-message ordering/projection；
- attachment-like runtime user entries 的 request-local bubble-up；
- same-turn file/image/url prompt attachment 的 provider-visible block 顺序；
- source-only runtime metadata identity 判定，避免用户 literal `<system-reminder>` 被误判；
- projection 后 latest non-system message cache-control marker finalization；
- regular turn、compact summary request、goal completion verifier request 使用同一 provider projection；
- focused tests、prompt-trajectory E2E 与 repeat stability evidence。

本 plan 不负责：

- 相邻 user messages 合并成同一条 `content[]`；
- 新增 `ContentPart` 或重写 session 持久化 schema；
- 修改 UI/session transcript 展示顺序；
- 新增 system-reminder source 文案；
- ToolSearch/deferred tools、MCP instructions/resources、skill discovery；
- exact wording，或 ZCode 当前没有 producer 的 attachment 类型。

## Ordering Rules

- attachment-like message 在 request-local projection 中自底向上 bubble，直到遇到 assistant 或 tool-result user boundary。
- direct pasted image 属于 user message 自身 content block，不是 attachment message；其 block 顺序由原 user content 决定。
- ZCode 当前没有独立的 attachment message taxonomy；参与排序的 provider-visible producer 是 file / image / url prompt attachments，以及 runtime metadata 标记的 provider-visible synthetic user context。
- 用户真实 prompt 即使以 `<system-reminder>` 开头，也必须依赖 runtime metadata/source 判定为 real user，不能靠文本 tag heuristic。

## Stability Requirement

这是 P000 级约束：

- projection 必须 pure、deterministic、idempotent；
- 不读取时间、随机数、UUID、环境变量或其他非输入状态；
- 不 mutate `MessageHistory`、传入 entries、message content blocks、toolCalls 或 cacheControl object；
- 不 trim、normalize、escape 或重写已有 text；
- 不按 alphabetic / descriptor order 排序，只按 runtime/history 顺序和明确 bubble boundary 重排；
- direct pasted image block 不被 attachment bubble-up 逻辑移动；
- cache-control 在最终 provider messages 上清理并重设：保留 system prompt 自身 cacheControl，清理非 system message 的旧 cacheControl，并只标记最后一条非 system message；
- prompt-trajectory evidence 必须检查 exact provider-visible order/shape。

## Phases

### Phase A0: Runtime Metadata Prerequisite

**Status:** Completed by system-reminder work.

- [x] `RuntimeMessageMetadata` 只保留 `{ source }`。
- [x] `RuntimeMessageEntry = { message, metadata? }` 用于 request-local projection。
- [x] `toRuntimeEntries()` deep clone metadata-bearing entries。
- [x] `toModelMessages()` 保持 provider-clean，不泄漏 metadata。
- [x] synthetic notice persistence/hydration 可 roundtrip `metadata.runtimeMessage: { source }`。
- [x] real user / literal `<system-reminder>` badcase 依赖 source metadata 判断。

### Phase A1: Provider Request Ordering Helper

**Status:** Implemented in current WIP.

- [x] 新增 `buildProviderRequestMessages(...)`。
- [x] 输入 `RuntimeMessageEntry[]`，输出 provider-clean `ModelInputMessage[]`。
- [x] attachment-like entries bubble 到 assistant/tool-result boundary 后的 user run 前。
- [x] 不合并相邻 user messages。
- [x] metadata/source/descriptor 字段不进入 provider body。
- [x] `applyCacheControl: true` 时，projection 后最后一条非 system entry 获得 `{ type: "ephemeral" }`；cache-control 不再承载 real_user 身份信号。
- [x] direct pasted image blocks 在 real user content 内保持原始顺序。

### Phase A2: Request Wiring

**Status:** Implemented in current WIP.

- [x] regular turn 使用 provider projection 后的 messages。
- [x] compact summary auxiliary request 使用 provider projection 后的 messages。
- [x] goal completion verifier auxiliary request 使用 provider projection 后的 messages。
- [x] `ModelRequest` event 与 adapter call 使用同一份 projected messages。

### Phase A3: Same-turn Prompt Attachment Order

**Status:** Implemented in current WIP.

- [x] live turn `buildUserContentFromTurn(...)` 输出 attachment blocks before prompt。
- [ ] TODO: 首轮 / 无 assistant boundary 时，同一 real user `content[]` 内的 prompt attachment 仍不能越过 request-level userContext；仅调转 `content[]` push order 不能修复该问题，后续需要单独设计 provider-only split 或 request-local content projection。
- [x] text file/source attachment 继续使用 SR12 synthetic Read reminder text。
- [x] image attachment 保留 image block，并位于 prompt 前。
- [x] URL/resource attachment 保留 resource block，并位于 prompt 前。
- [x] direct pasted image 不纳入 attachment sorting；如果未来 ZCode 支持 paste image 独立入口，应单独建 producer 分支。

### Phase A4: Validation

**Status:** Complete for ordering-only scope.

- [x] Focused tests: `provider-request-messages.test.ts`、`prompt-attachments.test.ts`、`runtime-reminders.test.ts`、`runtime-tool-loop.test.ts`、`runtime-trace.test.ts`、`runtime-compact.test.ts`、`session-history-hydrator.test.ts`。
- [x] `@zcode/core` typecheck。
- [x] Touched-file lint gate: provider projection / conversation / turn-loop / compact / verifier / hydrator files passed oxlint.
- [x] prompt-trajectory E2E for `user-message-provider-request-order` with both OpenAI-compatible and Anthropic Messages snapshots.
- [x] prompt-trajectory E2E for `user-message-pasted-image-order` verifies pasted inline image placeholder stays after the real prompt text.
- [x] Review generated request bodies for exact ordering and absence of runtime metadata.

Validation note: package-level `pnpm --filter @zcode/core lint` still fails on pre-existing `max-lines` errors in `src/workflow/lifecycle.ts` and `src/subagent/runner.ts`; touched files pass targeted oxlint.

## Postponed

| Item | Why postponed |
| --- | --- |
| Adjacent user-message merge | 暂时移除，避免 provider-visible shape churn 和 cache instability；未来如果重新启用，需要单独 phase、单独 cache-stability E2E 和 Anthropic Messages 请求形态 review。 |
| First-turn attachment vs request-level userContext ordering | 暂时不改；当前同一 real user `content[]` 内的 file/url/local-image attachment 可以位于真实 prompt 前，但无法越过前置 request-level userContext。仅调转 push order 会变成 `userContext -> prompt -> attachment`，更不对；未来需要独立 provider-only split 或 request-local content projection 方案。 |
| 完整 attachment taxonomy | 只处理当前 ZCode-supported file/image/url/system-reminder context；其他 attachment 类型等有对应 producer 后再纳入。 |
| Native session store content[] refactor | 当前目标是 request-local provider projection，不改持久化/UI transcript。 |

## Prompt-trajectory Evidence

Current testcase:

```bash
pnpm --filter @zcode/prompt-trajectory record -- --fixture testcases/user-message-provider-request-order/fixture.json --out out/user-message-provider-request-order/integration-e2e-final
pnpm --filter @zcode/prompt-trajectory record -- --fixture testcases/user-message-pasted-image-order/fixture.json --out out/user-message-pasted-image-order-latest
```

Expected derived snapshots per trajectory:

- `*.openai_request_body.json`
- `*.anthropic_request_body.json`

The expected provider-visible shape is attachment/context before real prompt, adjacent user messages still separate, and cache-control follows the latest non-system provider message rule.

Observed evidence:

- `out/user-message-provider-request-order/integration-e2e-final/trajectories/0001.openai_request_body.json`
- `out/user-message-provider-request-order/integration-e2e-final/trajectories/0001.anthropic_request_body.json`
- `out/user-message-pasted-image-order-latest/trajectories/0001.openai_request_body.json`
- `out/user-message-pasted-image-order-latest/trajectories/0001.anthropic_request_body.json`
- OpenAI-compatible snapshot keeps adjacent user messages separate.
- Anthropic Messages snapshot represents the provider-normalized adjacent-user content block shape.
- Pasted image order snapshot keeps the real prompt text before the pasted image placeholder.
