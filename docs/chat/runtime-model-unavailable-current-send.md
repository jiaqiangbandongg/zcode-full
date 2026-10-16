# Current Send Runtime Model Unavailable Handling

## Background

When the BigModel Team Plan project API key cannot be projected into a runtime key, the local model provider registry no longer contains `builtin:bigmodel-coding-plan`. A draft session may recover by creating a fallback session on another available provider, but the UI can still keep an older local `last selected model` value such as `custom:builtin%3Abigmodel-coding-plan:GLM-5.2`.

If first send later reuses that stale value, the service rejects the request with `ZCODE_RUNTIME_MODEL_UNAVAILABLE` before any model request is sent.

## Expected Behavior

- Historical task restore errors that only say the old task model is unavailable remain hidden by the chat banner.
- Current draft/send failures with `ZCODE_RUNTIME_MODEL_UNAVAILABLE` must be visible so the user can switch models or report the issue.
- Repeating the same send action after a failure must produce a fresh visible error; dismissing or retrying the previous banner must not suppress the next failure with the same message.
- If the unavailable runtime model is BigModel Team Plan Coding Plan, the error must concisely ask the user to check whether the current account has been added to the project member list instead of using a generic model-unavailable message.
- Once provider snapshot hydration proves a local agent model preference points to a provider that no longer exists, prepare must not reapply that stale preference over the agent session settings.
- Desktop continuous and web remote replayable paths keep the same service guard; the change is limited to UI selection reconciliation and error presentation.

## Fix Shape

The model selection reconciliation uses the hydrated provider snapshot as the boundary. A custom local preference is reapplied only while providers are not hydrated yet, or when the referenced provider still exists in the snapshot. If it is missing, the agent returned config options remain the source of truth.

`ChatErrorBanner` suppresses `ZCODE_RUNTIME_MODEL_UNAVAILABLE` only for historical-task messages. Current session or current selection messages are rendered like other actionable chat errors.

Current first-send failures attach a local trace id when upstream does not provide one. That keeps the visible error key distinct across repeated failures with the same code and message.

BigModel Team Plan uses a dedicated error code only when the current BigModel family selected key is a `team-plan:*` connection and the selected runtime model cannot be projected from the current registry. A missing `builtin:bigmodel-coding-plan` provider alone is not enough to classify the error as Team Plan because personal BigModel Coding Plan reuses the same provider id. Product copy should stay short and guide the user to check whether the current account has been added to the project member list.

If a draft session was previously created with a fallback provider, a later send or set-model operation can fail because that cached fallback runtime model has also disappeared from the registry. When the current request is trying to switch back to BigModel Team Plan, the service must classify the visible error by the requested Team Plan model instead of the stale fallback session model. This keeps the banner actionable for the account/project membership problem the user can fix.
