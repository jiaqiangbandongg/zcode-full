# Elicitation Keyboard Behavior

## Scope

`ElicitationDialog` renders blocking user-input requests for both `AskUserQuestion` and the
`ExitPlanMode` plan approval flow. They share the same visual surface, but their Enter-key
semantics are intentionally different.

## Behavior

- `AskUserQuestion`
  - Pressing `Enter` in the custom answer input advances to the next question when another question
    exists.
  - Pressing `Enter` on the final question does not submit the answer. The user must click the
    submit button or use an explicit submit shortcut.
  - `Ctrl+Enter` / `Cmd+Enter` submits explicitly.
  - Pressing `Esc` returns to the previous question when the dialog is not on the first question.
  - Pressing `Esc` on the first question cancels the request.
- `ExitPlanMode`
  - Pressing `Enter` in the custom feedback input submits the plan approval response.
  - Pressing `Esc` cancels the plan approval request.
- IME composition
  - Pressing `Enter` while an IME composition is active must not advance or submit, because the key
    is confirming the candidate text.

## Reason

`AskUserQuestion` is a clarification workflow, so bare `Enter` should not accidentally send the
final answer to the agent, and `Esc` should let the user step back through a multi-question flow
before cancelling. `ExitPlanMode` is a plan approval boundary with a single approval action, so bare
`Enter` can submit there and `Esc` keeps its normal cancel behavior.
