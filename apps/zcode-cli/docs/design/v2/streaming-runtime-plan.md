# Streaming Runtime Production Plan

## Status

This is the implementation plan for upgrading ZCode from the current batch-style
agent loop to a production streaming runtime.

Implementation progress:

- Phase 0/1 initial slice is implemented: core can opt into `streamText()`,
  normalized model stream events are emitted as `model_streaming`, and TUI
  renders text deltas into the active assistant response.
- Stream-path tool calls are collected after a model step completes and then
  routed through the existing `ToolExecutor`.
- Streaming tool execution before model step completion remains future work.

Historical baseline before this plan:

- `packages/adapters/src/model/runner.ts` already has an AI SDK `streamText()`
  wrapper and maps a small subset of stream chunks into `ModelStreamEvent`.
- `packages/core/src/runtime.ts` still drives the main loop through
  `modelAdapter.generateText()`, then extracts complete tool calls after the
  model response finishes.
- `SessionEventType.ModelStreaming` exists, but the main runtime does not emit
  token-level deltas yet.
- TUI live updates and interactive permission approval exist, so the streaming
  plan can reuse the current event sink and permission broker instead of
  inventing a second UI channel.

## Goals

- Stream assistant text and reasoning deltas through `SessionEvent`.
- Keep tool execution inside ZCode `ToolExecutor`: schema validation,
  permission broker, trace, artifact storage, timeout, cancellation, and
  result budgeting must not be bypassed by AI SDK tool execution.
- Make streamed model output, tool calls, approvals, tool results, cancellation,
  retries, and final turn completion recoverable from session state.
- Preserve the current non-interactive `submitPrompt()` API shape.
- Keep provider-specific behavior in model adapter/transform code, not in core.

## Non-goals

- Do not implement provider wire protocols directly; AI SDK remains the adapter
  boundary.
- Do not require streaming tool execution before the first production streaming
  release. Running tools as soon as their complete input appears is a later
  optimization.
- Do not introduce a second event model for TUI or ZCode app-server. `SessionEvent` remains
  the fact model.

## Design Patterns

Stream loop and persistence:

- Treat `streamText()` as the only hot path for normal LLM calls.
- Convert stream chunks into persisted message parts: text, reasoning, tool,
  step start, step finish, retry, patch.
- Keep provider quirks in `ProviderTransform`, including message cleanup, tool
  call id normalization, provider options, and unsupported media handling.
- On resume, convert pending/running tool calls into interrupted tool results so
  the next provider request never contains dangling tool calls.
- Drive the loop from persisted message/part state rather than from transient
  in-memory stream objects only.

Stream events and tool orchestration:

- Split stream handling into item started, delta, item completed, and response
  completed events.
- Persist completed model output items immediately, then queue tool futures.
- Drain in-flight tool futures before deciding whether the model needs a
  follow-up sampling request.
- Use a central tool orchestrator for approval, sandbox selection, retry, and
  escalated execution.
- Propagate cancellation with a turn-level cancellation token and child tokens
  for model/tool work.

Streaming tool execution:

- The query loop is an async generator that yields model/tool/progress messages
  during execution.
- Streaming tool execution is feature-gated and can be introduced after the
  basic stream loop is correct.
- Concurrency-safe tools may run in parallel; unsafe tools run exclusively.
- Tool results are buffered so model-visible ordering remains valid.
- If streaming fallback or interruption creates orphaned tool calls, emit
  synthetic tool results or tombstones so transcript/history stay valid.

## Architecture Decisions

1. Core owns the streaming state machine.

   The adapter should normalize AI SDK stream chunks; core should decide when
   to emit events, persist parts, schedule tools, wait for permission, execute
   tools, and loop.

2. AI SDK tools are projection only.

   `toAiSdkTools()` must continue exposing schemas without provider-side
   `execute`. A model tool call becomes a ZCode `ExecutableToolCall` only after
   core validates and schedules it.

3. `SessionEvent` is the durable streaming API.

   Every user-visible delta or lifecycle transition should first become a
   `SessionEvent`, then TUI/ZCode app-server/debug clients project from those events.

4. Production v1 executes tools after a streaming model step completes.

   This matches the current generate-text loop semantics while giving users
   token streaming and stream-path tool calls. Starting tools before model
   finish is an explicit later phase.

5. No transparent retry after committed stream output.

   Adapter retry is safe while it only holds discardable prelude events such as
   reasoning/tool-input deltas. Once text deltas, formal tool calls, or finish
   events are emitted or persisted, failures become stream errors and the runtime
   must close or recover the turn explicitly.

## Phase 0: Spec and Contract Cleanup

Add or refine contracts before runtime edits.

- Expand `ModelStreamEvent` to cover:
  - `start`
  - `text_start`
  - `text_delta`
  - `text_end`
  - `reasoning_start`
  - `reasoning_delta`
  - `reasoning_end`
  - `tool_input_start`
  - `tool_input_delta`
  - `tool_input_end`
  - `tool_call`
  - `finish`
  - `error`
- Extend `ModelStreamingPayload` so it can identify stream part kind, model
  request id, assistant message id, part id, tool call id, and delta text.
- Define a `StreamingModelStep` accumulator contract:
  - assistant text
  - reasoning text
  - completed tool calls
  - usage
  - finish reason
  - provider metadata
- Document when partial output is persisted and how interrupted output is marked.

Acceptance:

- Contracts compile without core depending on AI SDK types.
- Existing generate-text runtime tests continue to pass.

## Phase 1: Token Streaming Without Tool Execution Changes

Implement a streaming model step behind a runtime option, but preserve the
existing tool execution timing.

Tasks:

- Add `AgentRuntimeConfig.modelStreaming?: "off" | "on"` or equivalent.
- Add a runtime helper such as `runModelStepStreaming()`.
- Consume `modelAdapter.streamText()` and emit ordered events:
  - `model_request`
  - `model_streaming` for text/reasoning deltas
  - `model_complete`
- Persist assistant text parts with stable ids. For v1, text may be appended in
  memory during streaming and persisted at `text_end` or `finish`; live deltas
  still go through `SessionEvent`.
- Update TUI projection to append `model_streaming` deltas into the pending
  assistant message instead of waiting for `model_complete`.

Acceptance:

- A no-tool response appears token by token in TUI.
- `submitPrompt()` still resolves to the same final `TurnResult.response`.
- `--prompt` remains usable and does not require consuming live events.

## Phase 2: Stream-Path Tool Loop

Route tool calls produced by `streamText()` through the existing ZCode tool
runtime.

Tasks:

- Teach the adapter to preserve AI SDK tool input start/delta/end events when
  available.
- Accumulate completed `tool_call` events during a streaming step.
- After the model step finishes, reuse the current scheduling and execution
  path:
  - add assistant message with tool calls to `MessageHistory`
  - persist pending tool parts
  - emit `tool_call_scheduled`
  - execute through `ToolExecutor`
  - append model-visible tool results to history
  - continue the loop with another streaming model step
- Keep permission approval inside `ToolExecutor` and existing broker.
- Ensure tool result ids match provider tool call ids exactly.

Acceptance:

- A streamed model can call `Read`, receive the result, and continue streaming
  the final answer.
- A streamed model can call `Write` or `Bash`, pause for TUI approval, execute
  after approval, and continue the loop.
- Denied permission produces a model-visible tool error/result consistent with
  the generate-text path.

## Phase 3: Cancellation, Errors, and Resume Correctness

Make the stream path safe under failure.

Tasks:

- Abort model stream on user cancellation and emit a structured turn error.
- Abort pending permission requests when the turn is cancelled.
- Abort running tools through existing `AbortSignal`.
- Mark partial assistant text/reasoning as interrupted or errored in persisted
  session parts.
- On resume, transform pending/running tool calls into interrupted tool results
  before sending history to the model.
- Add synthetic tool result behavior for stream failure after a tool call was
  emitted but before a real tool result exists.
- Ensure stream fallback cannot leak orphaned tool results from a previous
  attempt.

Acceptance:

- Cancelling during model streaming does not leave a dangling assistant/tool
  state.
- Cancelling during permission wait resolves or rejects the broker request.
- Cancelling during tool execution does not produce an unmatched tool call in
  the next model request.
- Resuming a cancelled/interrupted session produces valid model messages.

## Phase 4: Production Observability and Backpressure

Make streaming observable and bounded.

Tasks:

- Add trace spans for model stream, stream part handling, tool scheduling,
  permission wait, and tool execution.
- Add bounded buffering for live deltas so slow sinks cannot grow memory without
  limit.
- Add model stream idle timeout and emit `model_stream_stalled`.
- Redact debug records for request headers, API keys, and high-risk content.
- Record usage and first-token timing when available.

Acceptance:

- Stream events carry the same `traceId` and turn/session identifiers.
- Slow or failing live sinks cannot corrupt persisted facts.
- Debug logs do not include raw authorization secrets.

## Phase 5: Optional Streaming Tool Execution

Start executing completed tool calls before the model stream fully finishes.

This phase should be feature-gated at first, behind a dedicated streaming tool
executor.

Tasks:

- Add a `StreamingToolScheduler` that can accept tool calls incrementally.
- Start concurrency-safe tools immediately once their complete input is known.
- Keep non-concurrent or destructive tools exclusive.
- Buffer tool results so model-visible ordering remains provider-valid.
- If a Bash/system tool fails, cancel dependent or sibling tools according to
  tool policy.
- Keep permission prompts stable even when multiple tool calls appear quickly.

Acceptance:

- Consecutive read-only tool calls can run in parallel.
- Unsafe tools do not overlap with other side-effecting tools.
- Model-visible transcript remains deterministic and valid.

## Test Plan

Adapter tests:

- maps AI SDK `text-delta`, reasoning deltas, tool input deltas, final tool
  calls, finish, and error chunks into provider-neutral events.
- retries stream setup failures only before any event is emitted.
- does not retry after a visible stream event.

Core tests:

- no-tool streaming event order.
- streamed tool call followed by tool execution and follow-up model step.
- permission request/resolution order in stream path.
- permission denial creates valid tool result/history.
- abort during model stream.
- abort during permission wait.
- abort during tool execution.
- resume converts pending/running streamed tool calls into interrupted results.
- live sink failure does not prevent event store append.

TUI tests:

- renders `model_streaming` deltas into the active assistant message.
- renders approval prompt while a streamed turn is active.
- Confirmed double Ctrl+C cancels model stream, permission wait, and active tool
  work while exiting the fullscreen TUI.

Persistence tests:

- assistant text/reasoning/tool parts created by the stream path hydrate into
  valid `MessageHistory`.
- incomplete streamed parts are marked interrupted and never sent as dangling
  provider tool calls.

## Suggested Implementation Order

1. Update contracts and tests for the richer stream event vocabulary.
2. Implement adapter stream chunk normalization.
3. Add runtime `runModelStepStreaming()` for no-tool responses.
4. Wire TUI `ModelStreaming` rendering.
5. Reuse existing generate-text scheduling/execution code for streamed tool
   calls after model finish.
6. Harden cancellation/resume/error paths.
7. Turn streaming on by default for TUI, keep `--prompt` compatible.
8. Consider feature-gated streaming tool execution.

## Release Gate

Streaming runtime is production-ready only when:

- TUI shows token deltas.
- Streamed tool calls run only through `ToolExecutor`.
- Write/Edit/Bash still require approval according to permission mode.
- Cancellation leaves no dangling model/tool state.
- Resume after interruption produces valid provider messages.
- `npm run lint`, `npm test`, and typecheck pass.
- Debug output redacts secrets.
