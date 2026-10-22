# TUI Model Selection

## Goal

The terminal UI needs a discoverable model switch path that stays scriptable.
The default interactive path is a command-shaped autocomplete popup in the
composer; explicit `/model <target>` commands remain the only execution
contract.

## User Contract

- Typing `/model` or `/model ` in the composer opens a model popup above the
  input area.
- Non-popup clients that submit `/model` show the current session model and
  configured selectable models as text.
- `/model list` is the explicit list form.
- `/model main` switches to `model.main`.
- `/model lite` switches to `model.lite` when it is configured.
- `/model <provider/model>` switches to a configured selectable model with that exact id.
- The selectable set includes `model.main`, optional `model.lite`, and every model declared under every configured `provider.*.models`.
- Picker rows are command-shaped. Selecting a row submits `/model <provider/model>`
  through the normal command center path.
- Picker rows prioritize the human model name on the left. The provider name
  is right-aligned and rendered with muted emphasis so users can scan models
  first while still seeing the provider boundary.
- Typing while the picker is open filters by model id, configured display name,
  alias, and generated command text.
- Up and Down move the highlighted model.
- Enter switches to the highlighted model.
- Tab completes the highlighted model into `/model <provider/model>` without
  submitting, matching the existing slash command autocomplete behavior.
- Esc cancels the picker and keeps the current model unchanged.
- Unknown models return a normal command response instead of being sent to the LLM.
- A model switch affects later turns only. Existing message history keeps the model metadata it was created with.

## State Boundary

TUI 不拥有选型状态，只渲染 Bootstrap 的每会话 `cliDefaultSelection`。CLI 装配显式使用
`modelSelectionMode: "cli-default"`；`/model` 和 `/effort` 修改并持久化下一条用户消息的默认选择，
不提前改变 Core Session Selection。CLI 用户消息在入口补齐 Selection，实际接受后成为 Session
续跑选择。App/Bot 的现有显式配置入口不因 CLI 装配改变语义。

新 CLI 会话从 Provider Config 的 `config.defaultModelSelection` 初始化默认值，恢复会话读现有
`runtime/model_selection` entry。全局保存继续复用现有命令路径，不引入新配置文件或迁移。
后台唤起和 Goal 直接使用 Session Selection；不会从 CLI 默认值补模型。闲时临时选择不写普通用户 entry。

The TUI sends `/model ...` through the same submit callback as other slash commands. The command center asks the app/server for current model state, available model options, and applies the selected model through an explicit app-level method. The TUI renders the returned command text and updates its session metadata projection from the returned `model` and `thoughtLevel` fields.

For composer autocomplete, the CLI passes a read-only list of selectable models
into TUI options. The TUI may recognize the draft shape `/model...` only to
filter and render local suggestions. It owns only the popup filter, highlighted
index, and completion behavior; it does not cache model catalog state or apply
model switches directly.

## Sidebar Projection

- The sidebar `Run` section renders `Provider` and `Model` as separate rows.
- The projection is derived from the canonical formatted model ref by splitting
  on the first `/`, matching the runtime `provider/model` contract where model
  ids may themselves contain `/`.
- If the current model projection is a bare model id, the `Provider` row renders
  `-` and the `Model` row renders the bare id.
- A `model_selected` session event with `modelRef.providerId` and
  `modelRef.modelId` refreshes the same display projection as a `/model` command
  result. The TUI still does not store provider and model as authoritative state.

## Module Boundary

- TUI does not execute `/model`. It receives optional `initialModel`,
  `initialThoughtLevel`, and read-only model options from the CLI bootstrap path
  before the first render and later updates active model display only from
  `TuiSubmitPromptResult` or live model request events.
- CLI command-center parses `/model` and dispatches to the app-level model contract.
- Config parsing materializes provider-declared models into a server-side `model.available` runtime catalog. It must preserve provider connection fields so switching to a model from another provider can run without TUI state.
- Bootstrap exposes `getModel`, `getThoughtLevel`, `listModels`, and `setModel`
  as narrow server-side APIs.
- Core owns the active `ModelRef` through `AgentRuntime.updateConfig({ modelRef, modelProviderOptions })`.
- Runtime startup must also seed `modelProviderOptions` from the configured main
  model target, or from the catalog default thought level when the target does
  not declare explicit options, so the first turn and first render reflect the
  same model provider settings as later `/model` switches.

## Errors

- If model switching is not available in the client, `/model` returns a command response.
- If `model.lite` is not configured, `/model lite` reports the available model ids and aliases.
- If no selectable models are configured, no composer model popup is shown and
  `/model` or `/model list` reports the condition in text.
- Model ids are case-sensitive after the `provider/` separator; command parsing must not lowercase full model refs.
- Switching clears or replaces model request provider options with the selected target's options, so stale options do not leak across models.
- Provider-declared models are only selectable when the provider connection is configured in the same merged runtime config. Catalog metadata alone still does not make a model runnable.

## Tests

- Command-center parses `/model`.
- Command-center lists and switches models without calling `submitPrompt`.
- CLI TUI wiring routes `/model` to the app/server contract.
- CLI TUI wiring passes read-only model options into the TUI.
- TUI model popup filters model options by id, alias, name, and command text.
- TUI model popup supports Up/Down navigation, Enter submission through
  `/model <id>`, Tab completion into the draft, and Esc dismissal.
- CLI TUI wiring passes the initial model and thought level into the first TUI
  render when they can be resolved.
- TUI sidebar tests assert that `provider/model` renders as separate `Provider`
  and `Model` rows, including model ids that contain `/`.
- TUI event tests assert `model_selected` payloads with `providerId` and
  `modelId` update the current model projection.
- Config parsing turns multiple providers and multiple provider models into `model.available`.
- Bootstrap startup and `setModel` update runtime `modelRef` and clear/replace
  `modelProviderOptions`, including catalog default thought provider options
  when a model has selectable reasoning but no explicit target options.
- `npm run lint` and `npm test` pass before completion.
