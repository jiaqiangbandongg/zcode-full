# `/btw` Side Question

## Goal

`/btw <question>` lets the user ask a quick side question without interrupting the current coding task or adding the question/answer to the model-visible main conversation.

This is a sidecar model request, not a normal turn, not a tool call, not a subagent task, and not a workflow activity. It exists for small clarifying questions such as "btw what does this acronym mean?" while the main session is idle or while a long turn is still running.

The important part is not the UI shape. The core pattern is:

1. Reuse the latest cache-safe main request prefix when possible.
2. Fork a one-shot side request that can see conversation context.
3. Deny all tools so no side effects can happen.
4. Do not append the side question or answer to the main conversation.
5. Let dismissing/cancelling `/btw` cancel only the side request.

## Non-Goals

- Do not let `/btw` edit files, run commands, call tools, ask permissions, mutate goals, update todo state, or create checkpoints.
- Do not use `/btw` as a hidden continuation mechanism for the main agent.
- Do not treat `/btw` answers as target/goal completion evidence.
- Do not make `/btw` a background subagent. Background subagents have task lifecycle, notifications, and child sessions; `/btw` is a short local answer.
- Do not add a `ZCODE_*` environment variable for this feature. If a later version needs configuration, define it in this spec first.

## User Semantics

`/btw <question>`:

- answers in a separate side panel/result block;
- does not create a normal `TurnStarted` / user / assistant transcript pair;
- can run while a main turn is active, without steering or cancelling that turn;
- uses the same current session context snapshot that was most recently safe to share;
- returns a direct answer in one model response;
- clearly reports when context is not available or the model attempts a disallowed tool call.

Empty input returns local usage text:

```text
Usage: /btw <question>
```

If `/btw` is submitted before any normal model request exists, runtime falls back to a freshly built context snapshot for the current session. This may miss prompt cache but must still answer.

## Architecture

The side question boundary should live in core runtime because it needs access to model adapter, context builder, message projection, tool contracts, trace context, and event store. Bootstrap and TUI own command parsing and presentation.

```text
TUI / command center
  -> ZCodeApp.askSideQuestion()
       -> AgentRuntime.askSideQuestion()
            -> SideQuestionRuntime
                 -> latest cache-safe request snapshot
                 -> model adapter
                 -> side_question_* session events
```

The runtime method must not call filesystem, child process, network, config, or provider SDKs directly. Provider I/O still goes through the configured `modelAdapter`.

### Cache-Safe Snapshot

After every main model request is built, runtime records an in-memory `LatestModelRequestSnapshot`:

```ts
interface LatestModelRequestSnapshot {
  model: ModelRef
  messages: ModelMessage[]
  tools: ModelToolContract[]
  providerOptions?: Record<string, unknown>
  traceContext: TraceContext
  capturedAt: Date
  sourceTurnId?: TurnId
}
```

This snapshot is a copy, not a live reference into `MessageHistory`. The goal is to keep the provider-visible prefix byte-stable for prompt caching. It should be captured at the same boundary that emits/logs `ModelRequest`, before mutable runtime state can advance.

When `/btw` runs:

1. Start from `LatestModelRequestSnapshot` if present.
2. Strip any in-progress assistant tail or unrepaired partial tool-call tail if the snapshot source allows it.
3. Append one user message containing the side-question system reminder plus the user's question.
4. Send the request through the same model ref, tools, and provider options unless a later spec defines an explicit config override.

Using the same tool schema preserves cache characteristics. Tools remain impossible to execute because the side-question permission/tool execution path denies every tool call with a stable `side_question_tools_denied` reason.

### Side Prompt

The appended message should be provider-visible English and should say:

- this is a side question;
- answer directly in one response;
- the main agent is not interrupted;
- use only already-visible context;
- do not call tools or promise actions;
- say when the answer is unknown.

The exact wording should be centralized as a named constant so tests can assert it remains action-denying.

## Runtime Contract

```ts
interface SideQuestionRequest {
  question: string
  sessionId: SessionId
  traceContext?: TraceContext
  abortSignal?: AbortSignal
}

interface SideQuestionResult {
  sideQuestionId: string
  status: "completed" | "failed" | "cancelled"
  question: string
  answer?: string
  error?: string
  usage?: ModelUsage
  cache?: {
    usedSnapshot: boolean
    sourceTurnId?: TurnId
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}
```

`ZCodeApp` should expose:

```ts
askSideQuestion(
  question: string,
  options?: {
    abortSignal?: AbortSignal
    onEvent?: (event: SessionEvent) => void | Promise<void>
    traceContext?: TraceContext
  },
): Promise<SideQuestionResult>
```

This is separate from `submitPrompt()` so callers cannot accidentally create a normal turn.

## Events

Add session events for observability without polluting the conversation transcript:

- `side_question_started`
- `side_question_completed`
- `side_question_failed`
- `side_question_cancelled`

Payloads should include:

- `sideQuestionId`
- `questionPreview`
- `answerPreview` or artifact reference when output is large
- `status`
- `usage`
- `cache.usedSnapshot`
- `sourceTurnId`
- `durationMs`

The full question/answer may be persisted in the event store only through the same bounded payload/artifact policy used by tool results. Main `MessageHistory` must not receive a user or assistant message for `/btw`.

All events carry the current session `traceId`. If `/btw` runs while another turn is active, its `spanId` must be a sibling of the active turn span, not a child of the active turn's abort scope.

## UI and Command Surface

Register `/btw` as a local command:

```text
/btw <question>
```

TUI behavior:

- Highlight `/btw` in the input as a known slash command.
- Submit through command center, not as a normal prompt.
- Render a bounded side result with loading, completed, failed, and cancelled states.
- Allow dismissing the result without changing the main transcript.
- If a main turn is active, keep main progress visible and do not steer the active turn.

Headless `--prompt "/btw ..."` may print the side answer and exit with normal command status, but must still avoid creating a normal turn.

ZCode app-server should not broadcast `/btw` as a normal available command until ZCode protocol clients have a side-result presentation. The structured future surface should be an extension method:

```text
zcode.dev/session/sideQuestion
```

Request fields: `sessionId`, `question`.

Response fields: `SideQuestionResult`.

ZCode protocol clients that do not implement this extension can keep using normal prompts; they should not receive `/btw` in command suggestions.

## Safety

- The side question can see model-visible context but has no tool execution capability.
- Any tool call emitted by the model is converted into a denied tool result or a clear local failure; no permission prompt is shown.
- The side request has its own abort controller. User dismissal or side-request timeout never aborts the main turn.
- The main turn's abort controller never automatically aborts an already-running `/btw` unless the whole session is closing.
- Side question events are marked as side-channel data so compact, target accounting, todo projection, and checkpoint creation ignore them.
- Logs must avoid full raw question/answer text unless the controlled debug path already allows comparable model payloads.

## Implementation Plan

### M0: Spec and Contract Tests

- Add this spec and register `/btw` in `commands.md`.
- Add contract types and event names for `SideQuestionRequest`, `SideQuestionResult`, and side-question events.
- Add tests proving side-question events are not reduced into main transcript messages.

### M1: Runtime Side Request

- Capture `LatestModelRequestSnapshot` when a model request is made.
- Add `AgentRuntime.askSideQuestion()`.
- Build the side prompt from the latest snapshot, with first-turn fallback.
- Run a one-shot model request with all tool execution denied.
- Extract answer text from all assistant text blocks, not only the first block.

### M2: Bootstrap and TUI Command

- Add `ZCodeApp.askSideQuestion()`.
- Route `/btw <question>` through command center.
- Record input history as `slash_command` for P0 to avoid schema churn.
- Render side-result loading/completed/failed/cancelled states in TUI.

### M3: Active Turn Behavior

- Allow `/btw` while `runtime.getActiveTurnInfo()` returns an active turn.
- Ensure side request uses a copied context snapshot and never mutates active turn state.
- Add cancellation tests where the side request is cancelled and the main turn continues.

### M4: ZCode app-server Extension

- Add `zcode.dev/session/sideQuestion`.
- Validate `sessionId` and non-empty `question`.
- Return structured result without broadcasting `/btw` in `available_commands_update` unless client capability negotiation later asks for it.

## Test Plan

- `/btw` with empty args returns usage and does not call the model.
- `/btw` with args calls `askSideQuestion()` instead of `submitPrompt()`.
- Side question does not append user/assistant messages to `MessageHistory` and does not emit normal turn lifecycle events.
- Side question reuses the latest cache-safe snapshot when available.
- First-turn fallback works when no model request snapshot exists.
- Tool calls during side question are denied and produce a clear response/failure.
- Cancelling `/btw` does not abort an active normal turn.
- A running normal turn can continue to stream while `/btw` is answering.
- Side question emits started/completed/failed/cancelled events with the parent trace id.
- Large answers are bounded or artifact-backed.
- ZCode app-server command suggestions do not include `/btw` by default.
- Future ZCode app-server side-question extension rejects malformed requests with structured invalid-params errors.

## Open Questions

- Whether P0 should persist full side-question answers or only previews plus optional artifacts.
- Whether a future config should allow `model.lite` for `/btw`; cache reuse argues for main model by default.
- Whether side questions should appear in input history recall. P0 records them as slash commands; a later `side_question` history kind can be added if UX needs filtering.
