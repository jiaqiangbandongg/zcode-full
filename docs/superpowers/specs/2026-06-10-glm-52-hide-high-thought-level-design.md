# GLM-5.2 Default Max Thought Level

## Status

Updated behavior, 2026-06-17.

## Goal

For ZAI, BigModel, ZAPI, custom, and dynamic GLM-5.2-like models, and for every GLM dated temporary model, keep the `high` thought level visible and selectable, but default model switches into these models to `max`. The behavior must be consistent across frontend configOptions, model switching, workspace defaults, active task config, zcode-cli model capability, and provider request mapping.

## Scope

- GLM-5.2 model matching continues to compare the final model id segment, so `glm-5.2`, `GLM-5.2`, `glm-5.2-pro`, and provider-prefixed forms like `zai/glm-5.2` are covered.
- GLM dated temporary models continue to match final model id segment prefix `glm-` followed by digits, for example `glm-0606[1m]`.
- The visible thought-level list for GLM-5.2-like and GLM dated temporary models is `max`, `high`, and `nothink`, with `max` as the default.
- OpenAI-compatible transport maps `high` to canonical `reasoningEffort = "high"`, which the
  AI SDK serializes as top-level `reasoning_effort = "high"`.
- Anthropic-compatible transport maps `high` to `effort = "high"` and `thinking.type = "enabled"` with a fixed budget lower than `max`.
- Frontend configOptions must preserve incoming `currentValue: "high"` instead of normalizing it away.
- Model switching into a GLM-5.2-like or GLM dated temporary model must set thought level to `max` when `max` is available.
- Draft task initialization for a GLM-5.2-like or GLM dated temporary model must also set thought level to `max` when `max` is available.
- Model switching into any other model must continue using the existing thought-level preference and configOptions behavior.
- After the switch or draft initialization, users can still manually select `high`; this rule only controls the automatic default.

## Data Flow

The frontend stores the thought-level options returned by the agent without a GLM-specific `high` filter. General normalization still applies: if the current value is missing from the available option list, the store falls back to the first legal option.

The zcode-cli reasoning metadata is the source of truth for runtime usage. GLM-5.2-like and GLM dated temporary model capability must include `high`; the providerOptions for `high` must be present so runtime model snapshots and session updates can pass the selected level through to the actual provider request.

When the toolbar receives authoritative configOptions after a successful model switch, the UI detects whether the selected model is GLM-5.2-like or a GLM dated temporary model. If so, and the returned thought-level option includes `max`, the toolbar updates the active task or workspace default thought level to `max`. This keeps runtime state aligned with the visible default instead of only changing local display state.

When creating or reading a draft session for a new task, the workspace prepare path performs the same detection after projecting the session settings to configOptions. If the draft model is GLM-5.2-like or a GLM dated temporary model and `max` is available, the prepare path uses `max` instead of replaying a previously stored `high` preference. The automatic `max` selection is not written back to the global last-thought localStorage preference.

## Testing

- Update UI store tests to prove `setConfigOptions` preserves `high` for built-in GLM-5.2 and providerless GLM dated temporary models.
- Update model switch tests to prove switching to a GLM dated temporary model forces runtime/workspace thought level from `high` to `max`.
- Update workspace prepare tests to prove new draft sessions for GLM-5.2-like and GLM dated temporary models prefer `max` over a stored `high` preference.
- Add neighbor coverage proving non-GLM-5.2-like models do not get forced to `max`.
- Update zcode-cli adapter and bootstrap tests to prove GLM-5.2-like and GLM dated temporary capability includes `max`, `high`, and `nothink`, including generated OpenAI-compatible and Anthropic-compatible providerOptions.
- Run targeted UI and zcode-cli tests, then repository `pnpm typecheck` and `pnpm lint`.
