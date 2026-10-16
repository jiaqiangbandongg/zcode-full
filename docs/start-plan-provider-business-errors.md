# Start Plan Provider Business Errors

## Scope

Start Plan provider business errors are surfaced through the existing provider
business error pipeline. The adapter preserves the upstream business code in
`context.providerCode`, the runtime promotes that code into the task error
summary, and the UI localizes the final message from
`packages/ui/src/lib/providerBusinessError.ts`.

This document records the UI behavior for the currently productized Start Plan
business codes.

## Error Codes

| Code | Meaning | UI behavior |
| --- | --- | --- |
| `1005` | Start Plan quota exhausted | For Start Plan providers, show the quota upgrade banner. This is a quota-exhausted state, not a system-busy state, and remains non-retryable at the model adapter layer. The banner remains visible as guidance but does not block submit; the next request is allowed to re-check server state and surface the latest result. |
| `3007` | Security verification rejected | Show the normal chat error banner. Official builds may first apply their own bounded security-verification recovery; the error stays visible when that recovery does not succeed. |
| `3008` | Concurrent request limit reached | For Start Plan providers, show the system-busy upgrade banner. On the first turn of a new session, do not automatically retry and show `当前系统繁忙，请稍后再试或升级账户。`. After the session has already completed at least one visible user turn, a `main_turn` admission busy failure may retry with a short bounded backoff. If the query is already running and stream recovery is active, allow automatic recovery retries. When recovery reaches its maximum retry count, show `当前系统繁忙，当前自动重试已达到最大次数，请稍后再试或升级账户。`. |
| `3009` | Current model request concurrent limit reached | Same as `3008`. |
| `3010` | Current model request concurrent limit reached | Same as `3008`. Goal completion verification is an exception: after a visible assistant turn has already completed, `target_completion_verification` may retry Start Plan busy codes (`3008` / `3009` / `3010`) with a short bounded backoff before failing closed. |

## Boundary

Start Plan quota and concurrent-limit banners must not disable the composer.
The banner is guidance and upgrade entry; the next request is allowed to
re-check server state. `3008` / `3009` / `3010` share the same system-busy
copy. `1005` keeps quota-exhausted copy and must not be folded into the
system-busy wording.

Goal completion verification runs after the user has already seen assistant
output such as `第 1 次迭代 · 目标未完成，任务继续`. A transient Start Plan busy
code (`3008` / `3009` / `3010`) at that point must not immediately stop the
goal loop. The verifier retries only this Start Plan busy case with a fixed
small retry budget.

Main-turn admission failures are different from stream recovery: no token or
tool call has arrived, so there is no stream anchor to recover from. Once a
session has already completed a visible turn, a later `main_turn` Start Plan
busy admission failure may close the empty assistant placeholder and retry the
same provider request with a small bounded backoff. Ordinary first-admission
failures, title generation, and non-Start Plan providers keep the normal
non-retryable behavior.

## Dynamic-workflow exception

Inside a dynamic-workflow run (`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`) the adapter-layer
classification above is not the retry authority. Subagent and tool-side requests carry an
unbounded retry budget and consult a workflow-specific policy table instead:

- `3008` / `3009` / `3010` are **retried inside the run** with the normal backoff and
  Retry-After, and each one feeds the process-wide concurrency governor as a throttle
  signal. They never fail a subagent and never show the system-busy banner.
- `1005` (quota exhausted) **stops the run** as `stopped(provider)` with a quota message;
  the run is resumable once the user's quota allows.
- `3007` (security verification rejected) stops the run as an authentication problem
  (official builds first apply their own bounded recovery).

Main-turn behaviour in the chat is unchanged.
