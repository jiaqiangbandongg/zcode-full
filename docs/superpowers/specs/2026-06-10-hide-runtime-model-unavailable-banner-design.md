# Hide Runtime Model Unavailable Banner Design

## Background

Historical ZCode tasks can carry a persisted model reference whose provider or model is no longer available in the current provider registry. The service layer reports this as `ZCODE_RUNTIME_MODEL_UNAVAILABLE` and keeps the guard in place so desktop continuous sessions do not silently resume with a different runtime model.

The current UI shows that guard as a chat error banner with the message:

`历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。`

The desired product behavior is to keep the internal guard, logs, restore handling, and task state intact, but stop rendering this message as a user-visible chat error banner.

## Goals

- Hide the chat error banner for `ZCODE_RUNTIME_MODEL_UNAVAILABLE`.
- Keep the service error code and runtime protection unchanged.
- Keep logs and task state available for diagnostics.
- Preserve normal error banner behavior for all other error codes.
- Avoid adding replacement UI, text, or new interaction states.

## Non-Goals

- Do not remove `ZCODE_RUNTIME_MODEL_UNAVAILABLE` from service or protocol logic.
- Do not change model restore, fallback, or setModel semantics.
- Do not remove tests that validate service-side unavailable-model protection.
- Do not add a softer toast, inline hint, or toolbar warning.

## Design

The narrowest safe boundary is the chat error presentation layer. `ChatErrorBanner` should treat `ZCODE_RUNTIME_MODEL_UNAVAILABLE` as a non-renderable UI error and return `null`. This keeps upstream state and diagnostics unchanged while preventing the visible banner from appearing.

The component-level boundary is preferable to clearing the task error in `useTaskRestore`, because restore and model-switch flows still depend on that code to identify and clear historical unavailable-model state after a successful model switch.

## Testing

Add or update UI tests for `ChatErrorBanner`:

- Rendering with `code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE"` should not include the historical-model message in the HTML.
- Rendering a normal error should still show the error message.

No browser visual regression is required because the requested behavior removes an existing banner for one code path and does not add layout or styling.

## Compatibility

The change is UI-only and does not affect desktop, web remote, mobile remote, service process, relay, task snapshot, or stream recovery semantics. Desktop continuous and web remote replayable paths continue to receive and persist the same error code; only the visible chat banner is suppressed.
