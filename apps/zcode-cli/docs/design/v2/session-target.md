# Session Goal

## Goal

Add a session-local long-running goal that lets the user or model persist one objective for the current session, inspect it after resume, and mark it complete when real evidence shows the objective is achieved.

## Non-Goals

- Goal is not a cross-session scheduler and does not create worker sessions.
- Goal continuation is runtime-triggered only when the current session is idle; it is not a wall-clock timer or polling loop.
- The first automatic-continuation version does not create worker sessions or fan out work.
- The runtime does not semantically decide that a goal is complete; completion is model/user driven.

## User Model

A goal belongs to the current session. A session has zero or one current goal. Setting a new goal replaces the current slot and creates a new stored `targetId` version. Clearing the goal removes the slot. DB table names, event names, and ZCode app-server `_meta.zcode.target` remain target-shaped compatibility surfaces; user-facing commands and model-visible tools use goal naming.

The TUI command surface is:

- `/goal` reads the current goal.
- `/goal <objective>` sets the current goal as `active`; when a goal already exists, it replaces the old goal and starts goal continuation on the replacement.
- `/goal replace <objective>` is an explicit compatibility spelling for the same replacement behavior.
- `/goal pause` sets the current goal to `paused`.
- `/goal resume` sets the current goal to `active`; when plan mode prevents continuation, it uses the same explicit response note as `/goal <objective>`.
- `/goal clear` deletes the current goal.

The headless prompt surface is:

- `zcode --target "<objective>"` is the headless compatibility equivalent of `/goal <objective>` and starts goal continuation through the same command-center path used by the TUI goal command, except that the headless CLI keeps explicit overwrite protection for automation safety.
- `zcode --target "<objective>" --resume <sessionId>` and `zcode --target "<objective>" --continue` apply the same command semantics to the resumed session.
- `--target` does not combine with `--prompt`; mixed usage is rejected at the CLI boundary so headless goal intent stays unambiguous.
- If a goal already exists, headless mode requires an explicit `--target-replace`; otherwise the CLI returns a local error and does not submit a model turn.
- `--target` is a compatibility CLI flag only. It does not introduce a new `ZCODE_*` environment variable or change the session goal storage contract.

Plain prompts do not implicitly create goals. The user must use `/goal` or explicitly ask the model to create one. If the model creates a goal during a normal prompt, the runtime may continue it after the current turn completes.

## Status Model

Goal status values are:

- `active`: the goal is available to guide future turns.
- `paused`: the goal remains persisted but should not drive continuation.
- `budget_limited`: the goal reached its configured token budget and should not start new substantive continuation work.
- `complete`: the goal has been achieved and should not drive continuation.

Only user-facing control surfaces can set, pause, resume, replace, or clear a goal. The initial surfaces are TUI `/goal ...` and headless CLI `--target ...` for set/replace. Model tools may read the active goal but cannot create, update, or complete it. Runtime may set `paused` on user cancellation, `budget_limited` when goal accounting reaches the configured budget, and `complete` only after the completion verifier passes.

## Continuation

Goal continuation uses normal turns for work and a separate no-tool verifier request for completion decisions. Active target post-turn continuation is owned by the runtime. Bootstrap can request the runtime to enqueue the active target loop for manual `/goal` continuation, but bootstrap does not own the loop. Accepted user prompts and background notifications run the same loop from inside the runtime command executor after their command finishes. When an active goal exists and the runtime is idle, the runtime first decides whether it should verify the just-finished turn. If verification is not requested (for example, immediately after `/goal` starts the first iteration), the runtime injects the normal continuation prompt. If verification is requested, the runtime sends a no-tool verifier request with `querySource: "target_completion_verification"` before starting another continuation turn.

When an active goal exists and the session has running background tasks, goal completion verification is deferred. Background task completion notifications are model-only synthetic user inputs and must be delivered to the model before the verifier decides whether the goal is complete. Background task notifications reuse the same runtime-owned active target loop after their model-only notification turn completes. The loop reads current runtime/session facts each iteration. Automatic post-command loops stop before continuation when the runtime command queue already has pending work; a queued manual `/goal` loop owns its first queue slot and yields before later iterations if another command arrives. A notification-triggered goal check follows the normal goal loop: if the verifier fails and starts a continuation turn, the runtime continues verification after that turn until a verifier passes, no usable continuation remains, another runtime command is pending, or background work is running again.

A plan, proposed plan, todo/checklist update, completed planning phase, elapsed effort, or plausible final response is not completion evidence by itself. These signals only support completion when the user objective was explicitly to produce that plan/checklist, or when they are backed by concrete artifacts, command output, test results, PR state, user confirmation, or other evidence that covers every objective requirement. Before passing, the verifier must inspect todo evidence in the conversation context; if any todo remains pending or in progress, it fails verification and prioritizes completing that unfinished todo.

The verifier returns a structured pass/fail result:

- pass: runtime updates the goal to `complete` and skips further continuation;
- fail with a usable `nextAction`: keep the goal `active` and inject `Continue working toward the active session goal. <nextAction>` into the next model-only continuation turn.
- invalid verifier JSON: treat the verification as passed, update the goal to `complete`, and skip further continuation.
- verifier request/system error: keep the goal `active` but do not invent a continuation step when there is no usable `nextAction`.

The verifier JSON shape is `{"passed": boolean, "reason": string, "nextAction": string}`. The parser accepts a raw JSON object and tolerates model responses that wrap that object in a Markdown fenced code block with a `json` language marker. If the verifier emits malformed JSON, the runtime treats that verifier output as a pass because there is no trustworthy continuation condition to drive another goal iteration. If the verifier concludes the goal cannot be satisfied in the current session, it still returns `passed: false`, explains the blocker in `reason`, and puts the smallest useful user-facing unblock step in `nextAction`. `nextAction` is also projected to the ZCode app runtime snapshot so the summary panel can replace the next iteration title. The verifier result is runtime projection data, not goal business state. A dynamic switch can disable the verifier by setting the compatibility config key `targetCompletionVerification.enabled` to `false`; when disabled, runtime skips the verifier and continues the active goal until another control surface pauses, clears, or replaces it.

Continuation is skipped when:

- the goal is missing, paused, complete, or budget-limited;
- the runtime is in plan mode;
- another turn is active;
- the user has queued or steered input that should run first;
- the session is not persisted yet and cannot safely attach goal state.

`/goal <objective>` and `/goal replace <objective>` are therefore both goal-setting commands and the first prompt for long-running goal work. The command stores the objective, then asks the runtime to continue that goal if the session is idle.

On cancellation, an active goal is paused before the turn unwinds. On resume, a paused goal is restored to active outside plan mode so it can continue only after the client explicitly asks for continuation or submits/resumes through a surface that supports continuation events.

Goal business state and model-visible state-change reminders have different timing guarantees. The session store update and durable `target_changed` event remain inside the initiating command mutation and complete before that command aborts the active turn; they are not deferred to turn finalization. The runtime opens turn-local reminder deferral only around the regular model/tool loop. A pause in that scope keeps one pending `goal_state_change` reminder; the loop's single `finally` first closes deferral, then materializes the reminder after cancelled tool results have been persisted and appended to live model history but before the turn terminal event. A state change arriving after deferral closes materializes immediately even while the broader active-turn accounting lifecycle is still finishing. This prevents both a provider-visible `tool_use -> reminder -> tool_result` sequence and a late pending reminder from being discarded with the active turn. The reminder remains a normal persisted attachment and provider projection still owns only its MCS-versus-legacy representation; projection must not compensate for an early producer write by reordering this goal reminder.

The pending reminder is intentionally in-memory and scoped to the active model/tool loop. A hard process exit before loop finalization may omit that exact transition notice, while the authoritative paused goal remains durable and cold resume still injects the current goal state. Pending-reminder materialization is best-effort: a synthetic notice persistence failure is logged and does not suppress the turn terminal event because the target store and `target_changed` event have already committed. There is no retry or reminder cursor. Stop followed by resume after turn finalization remains append-only: both pause and resume reminders are retained rather than coalesced.

### Reminder finalization boundaries

- The only interrupting goal mutations exposed by the protocol are `/goal pause` and `session/stop`. They update the target store, register the reminder, persist `target_changed`, and only then abort the active controller. Resume, clear, set, and replace remain rejected while a prompt is active; duplicate status writes do not register another reminder. This makes one turn-local pending slot sufficient without introducing a cursor or request-boundary state machine.
- Deferral belongs only to a regular model/tool loop. Idle mutations and changes during manual compact or rewind keep the existing immediate-materialization behavior. A late pause after the loop closes also materializes immediately instead of being left on an active-turn object that is still finishing accounting.
- Once an assistant tool call has entered history, cancellation is passed through the existing tool executor. A handler that has not started receives a synthetic cancelled result and is not invoked. Each result part is persisted and appended to live history; cancellation from an optional file-mutation checkpoint is rethrown only after all sibling results are closed. The loop `finally` then materializes the pending reminder before the terminal event.
- Persistence, cold hydration, compact selection, and provider projection continue to use the shared synthetic attachment path. `goal_state_change` remains model-only in UI projections, and the provider layer still decides MCS `system` versus legacy `<system-reminder>` representation without goal-specific ordering logic.
- The protocol keeps `activeAbortController` until `sendInput` has completed turn finalization. A desktop-continuous prompt or web-remote-replayable host-queue item therefore cannot overtake the cancelled tool results or pending reminder. This change adds no `clientMode`, `deliveryKind`, workspace identity, or renderer queue behavior.

## Events

Every successful goal mutation emits a durable compatibility `target_changed` session event after the session store write succeeds. The event is the stable notification surface for TUI, ZCode app-server, replay, debug, and future session projection consumers; clients must not infer goal state by parsing command text or model-visible tool output.

`/goal clear` is idempotent for client synchronization. If the session store already has no current goal, the command may still emit a `cleared` event with `target: null` and `previousTarget: null` so ZCode app-server/TUI clients that restored stale local goal metadata can converge back to the authoritative empty state.

```ts
interface TargetChangedPayload {
  action: "set" | "status_updated" | "cleared" | "usage_accounted" | "summary_updated";
  source: "command" | "tool" | "runtime";
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}
```

Mutation sources are:

- `command`: `/goal ...`, headless `--target ...`, and ZCode app-server command equivalents.
- `tool`: legacy historical events only; current model-visible goal tools do not mutate goal state.
- `runtime`: cancellation pause, resume activation, goal usage accounting, budget limiting, completion verifier completion, and generated goal summary title writeback.

`set` covers both first creation and replacement. `cleared` sets `target` to `null` and includes `previousTarget` when one existed. `usage_accounted` is emitted only when accounting applies to the same `targetId` that started the turn. Completion verifier passes emit a `status_updated` event from `runtime` when the goal becomes `complete`. `summary_updated` is emitted after the asynchronous title sidecar writes `summaryTitle`; it does not reset completion verifier state.

ZCode app-server projects `target_changed` as a standard `session_info_update` with private legacy `_meta.zcode.target`. TUI may render a transient line, but the durable business state remains in core/session events and `SessionProjection.target` until a future protocol migration.

## Storage

The session store owns goal persistence. The TUI must not hold goal state as business state.

SQLite migration `0004_session_target` creates:

```sql
create table if not exists session_target (
  session_id text primary key references session(id) on delete cascade,
  target_id text not null,
  objective text not null,
  summary_title text,
  status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
  token_budget integer,
  tokens_used integer not null default 0,
  time_used_seconds integer not null default 0,
  time_created integer not null,
  time_updated integer not null
);
```

`session_id` is the relationship key (`session 1 -> 0..1 goal`). `target_id` is a retained DB column and version identifier so future automatic continuation/accounting can reject stale updates after the user replaces the goal.

SQLite migration `0005_session_target_accounting` rebuilds the table to add `budget_limited`, token budget, token usage, and elapsed-time accounting while preserving existing goal rows.

SQLite migration `0011_session_target_summary_title` adds nullable `summary_title`. This is display metadata generated from the user-provided objective with the same title-generation prompt used for session titles. It is not injected into goal prompts or verifier prompts. The async writeback is guarded by `session_id + target_id` so a title generated for a replaced/cleared goal cannot overwrite the current goal.

## Tool Contract

Built-in model tools:

- `GoalRead`: read the current session goal.

`GoalRead` is read-only. Goal creation, replacement, pause/resume, clear, and completion are control/runtime operations rather than model tool mutations.

## Completion Verification

Goal creation only validates shape: objective is non-empty and within the length limit. The working model should continue implementing and verifying real evidence such as files, command output, tests, PR state, or user confirmation, but it does not mark completion itself.

When completion verification is enabled, the runtime issues a separate no-tool verifier model request after a turn ends and before injecting the next continuation prompt. Automatic continuation still uses normal turns for work; the verifier is the runtime gate that decides whether the active goal is complete.

## Goal Iterations

Goal iterations are bounded only by completion verifier lifecycle. User prompts, manual continue actions, TodoWrite calls, assistant message boundaries, and model-only `goal-continuation` turns do not create goal iterations by themselves.

Iteration ownership rules:

- Before the first completion verifier runs, all active-goal work belongs to iteration 1.
- Completion verifier N closes iteration N.
- If verifier N passes, the goal becomes `complete` and no iteration N+1 is opened.
- If verifier N fails, is cancelled, or fails closed with a usable continuation action, subsequent active-goal work belongs to iteration N+1 until verifier N+1 closes it.
- If a user sends one or more visible prompts between verifier boundaries, those prompts and the resulting assistant/tool work stay in the currently open goal iteration.
- Creating or replacing a goal resets iteration ownership for the new `targetId`; old verifier and todo ownership must not leak across target replacement.

The UI-facing iteration model must distinguish:

- `verifiedIterationCount`: how many verifier lifecycle records have closed or attempted to close an iteration.
- `activeIteration`: the iteration that new active-goal work belongs to. It is 1 before the first verifier and `verifiedIterationCount + 1` after a non-passing verifier that continues the goal.

`goalStats.iterationCount` must not be used as a hard clamp that forces current post-failure work back into the last verified iteration. Any snapshot or summary projection that needs an upper bound must use the active iteration boundary, not only the completed verifier count.

### Iteration Titles

Iteration titles are display metadata and do not affect model prompts or goal verification.

- If the first visible user query creates the goal and the normal session title generator produces a title from that query, iteration 1 uses that session title.
- If the session title is unavailable, iteration 1 may fall back to the goal `summaryTitle`, then to a compact objective-derived label.
- Iteration N+1 uses verifier N's `nextAction` as its title when verifier N did not pass.
- The title belongs to the next work iteration, not to the verifier divider that closed the previous iteration.
- Passing verifiers do not create a next iteration title.

### Iteration Persistence

Verifier lifecycle is durable business state. Reopening a session, rebuilding a snapshot, and replayable remote recovery must restore the same goal iteration boundaries and divider rows without relying on renderer memory or a live in-process event store.

Preferred storage is the existing `session_entry` table using typed entries for `target_completion_verification` lifecycle data. This does not require a SQLite schema migration because the table already exists. If implementation finds `session_entry` unsuitable and needs a new table or new columns, that migration must be specified before code changes.

Persisted verifier lifecycle records must include:

- `sessionId`
- `targetId`
- `verificationId`
- lifecycle status: `started`, `completed`, `failed_closed`, or `cancelled`
- `goalIteration`
- `startedAt` and `updatedAt`
- optional verifier result: `passed`, `reason`, and `nextAction`

Snapshot builders must reconstruct `goalVerificationTimeline` from persisted verifier lifecycle records on cold resume. Live event-store projection may remain an optimization, but it cannot be the only source of truth.

## Goal Todo Ownership

Todo ownership is based on where the todo first appears, not where it is later completed.

In goal sessions:

- Each TodoWrite snapshot is evaluated against the active goal iteration at the time of the assistant/tool message.
- A todo is assigned to the iteration where its content first appears.
- Later TodoWrite snapshots may update that todo's status or priority, but the todo remains displayed under its original iteration.
- Completing a todo in a later iteration must not move it into that later iteration.
- A todo can appear under only one goal iteration for a given `targetId`.
- Todo identity is the normalized content fingerprint for compatibility with existing TodoWrite data that has no stable todo id.

The content fingerprint must be stable across common formatting noise:

- trim leading/trailing whitespace;
- collapse internal whitespace;
- use a case-insensitive comparison for ASCII text;
- preserve non-ASCII content after whitespace normalization.

The grouped todo display must keep all statuses visible:

- completed todos: already done;
- in-progress todos: currently doing;
- pending todos: planned or upcoming.

In non-goal sessions:

- TodoWrite continues to work as a standalone session plan.
- Todos are not assigned to goal iterations.
- The UI still displays completed, in-progress, and pending todos instead of hiding completed items.
- Existing session-level todo recovery remains valid.

When a goal is replaced, todo ownership for the new target starts fresh. Historical todo groups for old targets may remain in history, but current goal summaries must filter by the active `targetId`.

## Resume Context

On session resume, runtime reads the current goal and injects a system-reminder style user message into model history. This mirrors the todo state recovery path and keeps goal continuity without adding TUI-owned state.

## Error Behavior

### Verifier model options

The verifier binds the Session ModelSelection once when verification starts. It inherits that
Model's reasoning options and requests `optionSpecs.maxOutputTokens.max`, like a normal Turn.
It does not use the low-cost auxiliary-call policy (lowest reasoning / 5,000-token cap).
Retries and usage attribution retain the same Model even if the Session selection changes;
no verifier-specific options are persisted back to the Session. Title and other auxiliary
calls retain their own existing policy.

- Empty objective is rejected before storage mutation.
- Objective over the configured limit is rejected before storage mutation.
- Model-visible `GoalCreate` and `GoalUpdate` tools are not registered.
- When completion verification is enabled and the verifier fails, runtime keeps the goal active and injects the verifier `nextAction` into the next continuation turn.
- If completion verification is disabled, runtime skips the verifier and continues the active goal.
- Active goals are paused when a turn is cancelled.
- Active-turn pause reminders are materialized after cancelled tool results and before the turn terminal event; idle goal reminders remain immediate.
- Budget-limited goals do not start new continuation turns.
- Pause, resume, and clear are TUI/control operations only.

## Test Coverage

- Migration list includes `0004_session_target`, `0005_session_target_accounting`, and `0011_session_target_summary_title`, and remains reopen-idempotent.
- Store can set, read, update status, update summary title, reject stale summary title writes, replace with a new `targetId`, and clear goals.
- Tool registry exposes `GoalRead` only; create/update completion tools are not registered.
- Goal prompts escape user-provided objectives before embedding them in system-reminder XML and explicitly say that plans, todos, checklists, proxy signals, and elapsed effort are not completion evidence by themselves. The verifier prompt also requires unfinished todos to be completed before the goal can pass.
- Successful goal mutations emit `target_changed`; projection updates `SessionProjection.target`; ZCode app-server forwards the event through `_meta.zcode.target`.
- Runtime verifies post-turn goal completion through a separate no-tool model request; tests cover verifier pass, verifier fail continuation, disabled verifier, and prompt/query source projection.
- Verifier malformed JSON is treated as pass so an unparseable verifier response cannot leave an otherwise finished goal active without a continuation condition.
- Resume injects goal state into model history.
- Runtime accounts goal usage for turns that started with an active goal.
- Runtime generates goal summary titles with the title sidecar and emits `summary_updated` without blocking goal continuation.
- Command center parses `/goal` commands locally, then starts goal continuation for set/resume when available.
- Headless `--target ...` reuses `/goal ...` command semantics and rejects silent replacement without `--target-replace`.
- Active-turn pause coverage asserts that all completed/cancelled sibling tool results persist before `goal_state_change`, the reminder persists before `TurnComplete(cancelled)`, and a subsequent request retains append-only pause/resume reminders.
