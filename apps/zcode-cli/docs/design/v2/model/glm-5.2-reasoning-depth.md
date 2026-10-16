# GLM-5.2 Reasoning Depth (思考深度三档)

> **已被 Provider Refactor 取代（2026-08-24）**：本文描述的 modelId prefix matcher、
> `default-policy`、`providerOptionsByLevel` 和 Runtime 反向匹配均已删除。GLM-5.2 的有效行为
> 现在由 Built-in Model Config Rules 显式声明，再通过 Effective Model Config 交给 Adapter；
> 禁止恢复本文的按名称推断实现。当前契约见
> [Model Contract](../../../../../../docs/working-memory/provider-refactor/design/model/contract.md)。

## Status

Historical implementation record. The original design was written on 2026-06-02
and rechecked on 2026-07-15; it is no longer the active implementation contract.

GLM-5.2 needs three selectable reasoning depths instead of the binary
enabled/disabled thinking toggle that every other GLM model currently receives.
The three levels map to canonical AI SDK `reasoningEffort` options on the
OpenAI-compatible transport, and to native Anthropic `thinking` controls on the
Anthropic-compatible transport.

| Level     | OpenAI-compatible request body | Anthropic request body                                                    |
| --------- | ------------------------------ | ------------------------------------------------------------------------- |
| `max`     | `reasoning_effort: "max"`      | `thinking: { type: "enabled", budgetTokens: 32000 }` (+ `effort: "max"`)  |
| `high`    | `reasoning_effort: "high"`     | `thinking: { type: "enabled", budgetTokens: 16000 }` (+ `effort: "high"`) |
| `nothink` | `reasoning_effort: "none"`     | `thinking: { type: "disabled" }`                                          |

Default level is `max` when no app/session preference supplies a compatible
level. Match is by model-id **prefix** `glm-5.2` (case insensitive, applied to
the last `/`-separated id segment), so `glm-5.2`, `glm-5.2-pro`, `GLM-5.2`, and
`zai/glm-5.2` are all covered, while `glm-4.6` and `glm-5.1` keep the existing
thinking toggle.

## App Selection Preservation

The app must not force `thought_level=max` after a user switches away from and
back to a GLM-5.2-compatible model. User-selected levels such as `high` remain
valid for GLM-5.2 and are preserved by the app preference seed and V4
`switchModelConfig` / `createSession.config` paths when the returned capability
list still contains that level.

The `max` default only applies through normal capability defaulting when there
is no compatible app/session preference. Switching to a GLM-5.2-compatible model
must not issue an extra thought-level command solely because the model default is
`max`. Across models, the V4 handler lets the target model select a compatible
actual thought level; it only treats thought as an explicit write when the model
identity is unchanged.

GLM-5.2 also carries a **1,000,000-token context window**. This is a separate
default policy (`glm-5.2-context-window-1m`) in `default-policy.ts`, reusing the
same `isGlm52ModelId` prefix match and the shared `ONE_MILLION_CONTEXT_WINDOW`
constant, mirroring the existing DeepSeek-V4 / mimo 1M policies. It replaces the
context window (`replaceContextWindow: true`) so a stale `models.dev` value does
not win.

## Temporary Dated Aliases

`glm-<MMDD>` and `glm-<MMDD>[1m]` temporary ids (for example `glm-0531` and
`glm-0606[1m]`) behave like `glm-5.2`: three reasoning depths and a 1M context
window. `isDatedGlmTempModelId` uses an exact dated-id pattern, so names such as
`glm-0606x` do not match. `default-policy.ts` and `config/schema.ts` apply the
same rule, including provider-qualified ids.

## Why Two Factories

Reasoning provider options are transport-specific. `providerOptionsByLevel`
entries are namespaced by AI SDK provider kind (`openaiCompatible` vs
`anthropic`); the active provider only reads its own slice. Reusing an
`openaiCompatible` option set on an Anthropic-compatible model produces a request
with no thinking field while the UI still shows thinking enabled — the exact bug
already documented in `config/schema.ts:createConfiguredModelDefaultReasoning`.

DeepSeek-V4 already solves this with a pair of factories
(`createDeepSeekV4Reasoning` + `createDeepSeekV4AnthropicReasoning`) wired into
the two resolution paths. GLM-5.2 follows the same precedent.

## Resolution Paths

Reasoning capability is resolved through two seams; GLM-5.2 wires into both:

1. **`adapters/src/model/default-policy.ts`** — `resolveModelCapabilityDefaults`
   matches by model id only (no transport kind) and supplies the
   **OpenAI-compatible** option set. A new policy entry `glm-5.2-reasoning-depth`
   is inserted **after** the generic `glm-thinking-toggle` entry so that, since
   `resolveModelCapabilityDefaults` does an ordered `Object.assign`, the GLM-5.2
   `reasoning` replaces the toggle for matching ids.

2. **`adapters/src/config/schema.ts`** — `createConfiguredModelDefaultReasoning`
   is transport-kind aware. In the `kind === "anthropic"` branch a new
   `isGlm52ConfiguredModelId(modelId)` check is added **before** the generic
   thinking-toggle check, returning the **Anthropic** option set.

The selected level's `providerOptionsByLevel[level]` flows unchanged through
`bootstrap/src/runtime-model-metadata.ts` →
`adapters/src/model/runner-options.ts:mergeProviderOptions` → AI SDK
`providerOptions`. For OpenAI-compatible providers, the runner copies the canonical
`openaiCompatible.reasoningEffort` field into the SDK's resolved provider-name
namespace. The SDK then serializes it once as top-level `reasoning_effort`; ZCode does
not generate `extra_body` or `chat_template_kwargs` for these levels.

## Level Display

`bootstrap/src/zcode-protocol/session-mapper.ts` maps each capability level
string straight to `{ value: level, label: level }`. The displayed labels are
therefore literally `max` / `high` / `nothink`, consistent with existing levels
(`enabled`/`disabled`, `low`/`high`). No new i18n surface is introduced in the
agent.

## Round-Trip

`resolveRuntimeThoughtLevel` reverse-maps the active `providerOptions` back to a
level via deep equality (`recordsEqual`). The three option objects are mutually
distinct on each transport, so the selected level round-trips correctly.

## Testing

- `adapters/tests/model-default-policy.test.ts`: GLM-5.2 yields levels
  `[max, high, nothink]`, default `max`, and the exact OpenAI-compatible
  `providerOptionsByLevel`; prefix variants (`glm-5.2-pro`, `GLM-5.2`,
  `zai/glm-5.2`) match; `glm-4.6` / `glm-5.1` remain on the enabled/disabled
  toggle.
- `adapters/tests/config.test.ts`: with `kind === "anthropic"`, GLM-5.2 resolves
  to the Anthropic option set; `nothink` produces `thinking: { type: "disabled" }`
  and no `chat_template_kwargs`.
- `packages/ui/test/composerRecent.test.ts`: Recent 记录的旧格式兼容、model/mode
  独立校验、accepted 写入、提交顺序和 workspace 隔离。
- `packages/ui/test/v4ModelConfigPreferenceConfirmation.test.ts`: V4 snapshot
  confirmation preserves a selected GLM-5.2 `high` configuration.

## External Verification Boundary

Whether the GLM Anthropic-compatible endpoint distinguishes `max` vs `high` via
`effort` passthrough or via `budgetTokens` is a backend contract detail. The
Anthropic factory mirrors the existing DeepSeek-V4 Anthropic mapping (`effort` +
`thinking` budget) as the precedent. A backend compatibility claim still requires
capturing the outgoing request body for both transports through the runner's
`experimental_include.requestBody` model-IO debug path; unit tests prove the
local mapping, not acceptance by every deployed endpoint.
