# V4 Goal Command Parity Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use systematic debugging for any failed runtime verification, and update this plan before changing code if product semantics change.

**Goal:** Restore v4 `/goal` parity with z-code-2 for the visible composer command path: draft-first `/goal` must set or replace the session target through the goal command channel, queued `/goal` must stay a goal command, and no `/goal` command may be downgraded into an ordinary model prompt.

**Architecture:** Keep goal state owned by the agent/session runtime and surfaced through v4 conversation snapshots. UI parses visible slash commands at the send boundary, then routes them through `v4/command`. Running or compacting sessions keep the existing command barrier for immediate target writes, but enqueue `/goal` as a command-aware pending item and consume it only through the goal command path.

**Tech Stack:** React UI in `packages/ui/src/v4`, protocol schemas in `packages/shared/src/zcode-protocol-v4`, bootstrap command handlers in `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4`, core queue/runtime contracts in `apps/zcode-cli/packages/contracts` and `apps/zcode-cli/packages/core`.

## Scope

This plan covers `/goal`, `/target`, `/goal replace`, and `/goal resume` on the v4 chat composer and queue paths.

Out of scope for this pass:

- The `Multiple system messages that are separated by user/assistant messages` failure. That is a provider SDK/version issue and should not be mixed into this fix.
- Full standalone goal setup mode parity (`direct` / `quick` / `grill` and `ExitGoalSetup` approval cards). z-code-2 added that later, but current v4 protocol only exposes `sendGoalCommand(text)` and `resumeGoal`.
- `/goal show`, `/goal pause`, and `/goal clear` protocol behavior. The old parser recognized these actions, but v4 has no matching command payloads yet.
- UI redesign of the goal card/sidebar. The target of this plan is command semantics and queue preservation.

## Source Review

Current v4 source of truth:

- `docs/conversation-protocol-declaration.md`: `/goal xxx` sets or updates the session goal; running and compacting `/goal xxx` append to the queue.
- `docs/testing/conversation-session-goal-specific-coverage-matrix.md`: G0/G1/G2 define completed replacement, running queue, queue edit/delete/reorder, send-now, and compact interaction expectations.
- `packages/shared/src/zcode-protocol-v4/command.ts`: v4 currently has `sendGoalCommand({ text, heldQueueDisposition? })` and `resumeGoal({})`.
- `packages/shared/src/zcode-protocol-v4/snapshot.ts`: queue items already have `kind: "sendText" | "sendGoalCommand"`, with a comment saying `/goal` stores the user original.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/goal-compact.ts`: `sendGoalCommand` already implements set/replace by reading existing target, but rejects active turns.
- `packages/ui/src/v4/SessionPane.tsx`: slash parsing only runs when `sessionId` exists, so draft-first `/goal` falls through to `createSession(firstInput)` + `sendText`.

z-code-2 evidence:

- `0e3ad860b fix: route visible slash commands`: parsed visible `/compact`, `/goal`, and `/target` at submit boundary; draft/no-task slash commands created or resumed a session first, then ran the session control command instead of sending ordinary prompt text.
- `ea2848b5e fix(ui): preserve queued goal semantics`: classified queued prompt kind as goal/compact/text and restored `/goal` prefix when a queued goal was edited to objective-only text.
- `670951d25 fix(ui): wait for session ready before queue drain`: delayed queued command drain until the session active lock actually released.
- `588278603 fix(ui): gate queued prompts on goal completion`: active/incomplete goal target blocked queued prompt drain until the goal was complete.
- `2382ca8a2 fix(ui): block active goal queued send now`: send-now during active goal output acted like stop/pause first; it did not interleave another command into the active goal turn.
- `d1ac21ceb fix: block goal command while task is running`: useful bug rationale that `/goal` writes `session_target` and must not bypass a running turn. Its old product decision "block while running" has since been superseded by current docs, which require queueing.
- `9eadd7211` and `696139694`: full standalone setup/verifier parity. These are future parity references, not Phase 1 requirements.

## Current Gaps

1. Draft-first `/goal` is not parsed.
   `SessionPane.handleSendText` only calls `handleSlashCommand` when `sessionId` exists. In a new draft, `/goal ...` becomes first input and is submitted as ordinary `sendText`.

2. Current parser is too narrow.
   It recognizes `/goal <text>` but not `/target`, `/goal replace <text>`, or `/goal resume`.

3. Running `/goal` has no command-aware queue path.
   `sendGoalCommand` rejects when `record.activeAbortController` exists. That barrier is correct for immediate target writes, but running/compacting product semantics require enqueueing the command instead of failing or sending ordinary prompt text.

4. Queue kind is declared but not preserved from core events.
   `queueItemSchema` supports `sendGoalCommand`, but `product-projection.ts` hardcodes `TurnSteerQueued` items to `kind: "sendText"`.

5. Core pending-input drain currently injects everything as a user prompt.
   `drainPendingInput` calls `persistUserPrompt` and `messageHistory.addUser` for the pending input text. A queued `/goal` must not pass through this path.

6. `sendQueuedNow` always replays as prompt text.
   The v4 queue handler reads item text, removes the item, waits idle, then calls `startPromptTurn`. For a goal queue item, this would again become an ordinary user prompt.

7. Queue editing can lose command syntax.
   z-code-2 restored `/goal` when a queued goal was edited to just the objective. v4 needs the same behavior, preferably using `queueItem.kind` as authority.

## Target Behavior

The composer submit boundary must classify visible slash commands before normal send logic:

```text
composer text + attachments
  |
  v
slash parser
  |-- attachments present --------------------------> sendText
  |-- not /goal|/target|/compact --------------------> sendText
  |-- /goal or /target -----------------------------> goal command route
  |-- /goal resume ----------------------------------> resumeGoal route
```

For supported goal commands:

- `/goal <objective>` sets a target when none exists.
- `/goal <objective>` replaces the existing target when one exists.
- `/goal replace <objective>` maps to the same replace-capable `sendGoalCommand` payload with objective text stripped of `replace`.
- `/target <objective>` is an alias for `/goal <objective>`.
- `/goal resume` maps to `resumeGoal`.
- Attachments disable slash parsing; the input remains ordinary `sendText`.
- Empty `/goal` is consumed as an unsupported/empty goal command with a UI warning; it must not create an ordinary prompt.

State and queue order:

```text
idle/completed, queue empty
  /goal A
    -> sendGoalCommand(A)
    -> set or replace session target
    -> start goal continuation when mode allows

running or compacting
  /goal B
    -> enqueue queue item { kind: sendGoalCommand, text: original or canonical /goal B }
    -> no target write yet
    -> no model request for B yet

active work becomes ready
  queue head sendText
    -> existing text drain behavior
  queue head sendGoalCommand
    -> remove queue item
    -> sendGoalCommand(objective)
    -> target set/replace + goal continuation

held queue (completed + queue>0 + autoDrain=false)
  /goal C
    -> require heldQueueDisposition choice
    -> clearQueueAndSend: clear queue, then sendGoalCommand(C)
    -> keepQueueAndSend: preserve existing queue, then sendGoalCommand(C)
```

The key invariant is:

```text
queue item kind sendGoalCommand
  must never flow into persistUserPrompt/startPromptTurn as raw "/goal ..."
```

Desktop and web remote boundaries:

```text
desktop-continuous client
  -> v4/command
  -> existing desktop host/runtime

web-remote-replayable client
  -> v4/command through shared-host attachment
  -> same owner/runtime boundary
  -> replayable snapshot restores queue/target state
```

No relay/main-process goal state is introduced.

## Implementation Plan

### Phase 1: UI visible slash parser and draft session routing

- Add a pure v4 parser, for example `packages/ui/src/v4/slashCommands.ts`.
- Parser output should include:
  - command type: `sendGoalCommand`, `resumeGoal`, `compact`, or unsupported;
  - `objective` for goal set/replace;
  - `displayText`, preserving the user's visible command when possible;
  - whether the command requires `baseRevision`.
- Parse before the `sessionId` guard in `SessionPane.handleSendText`.
- For draft/no-session goal command:
  - reuse prewarm session if present;
  - otherwise dispatch `createSession` without `firstInput`;
  - promote the session through existing draft promotion hooks;
  - dispatch `sendGoalCommand` or `resumeGoal` to the new session;
  - do not call `sendText` with the raw `/goal` input.
- For existing sessions, dispatch the command directly.
- Carry `heldQueueDisposition` into `sendGoalCommand` when the composer is in choice mode.
- Keep `/compact` behavior as currently implemented, but do not broaden this plan into compact rendering changes.

### Phase 2: Preserve queued goal command kind

Recommended durable path:

- Extend the core/contracts pending-input shape with an explicit command kind:
  - `TurnSteerInput.commandKind?: "sendText" | "sendGoalCommand"`;
  - `PendingTurnInput.commandKind`;
  - `TurnSteerQueuedPayload.commandKind`.
- Default omitted kind to `sendText` for compatibility.
- When `sendGoalCommand` is received during active work, enqueue through `record.app.steerTurn` using:
  - `commandKind: "sendGoalCommand"`;
  - queue text as the visible command (`displayText` if protocol carries it, otherwise canonical `/goal ${objective}`);
  - `inputId` and `queryId` from the command id.
- Update `product-projection.ts` to set `queue.items[].kind` from the event command kind.
- If adding `displayText` to `sendGoalCommand` payload is accepted, make it optional and keep `text` as the parsed objective. This preserves exact `/target` or `/goal replace` user text without changing existing callers.

Compatibility fallback if core contract churn must be minimized:

- Infer `sendGoalCommand` in projection from queued text starting with `/goal` or `/target`.
- This is weaker because edited queued goals can lose the prefix. It should only be a temporary bridge.

### Phase 3: Make auto-drain command-aware

Core pending input auto-drain must distinguish text from commands:

- Existing text pending inputs keep current behavior.
- If queue head is `sendGoalCommand`, `drainPendingInput` must not call `persistUserPrompt` or `messageHistory.addUser`.
- `turn-stop` must not loop forever when queue head is a non-text command:
  - replace `hasPendingInput` checks used for auto-drain with a helper such as `hasAutoDrainablePendingInput`;
  - only text-at-head is auto-drainable inside the model loop;
  - a goal-at-head completes the active turn and leaves the queue item visible for the command drain path.
- Add a v4 command queue drain trigger after active work reaches ready:
  - only run when queue `autoDrain` is true;
  - only consume the head item;
  - preserve FIFO by blocking later text behind a queued goal until the goal command is consumed;
  - apply the same active-lock wait/retry guard as z-code-2's ready-boundary fixes.

### Phase 4: Fix queue actions

- Replace `getQueueItemText` with a host method that returns `{ kind, text }`, or add a parallel `getQueueItem`.
- `sendQueuedNow`:
  - read kind and text before removal;
  - remove the item;
  - stop/pause current active goal when preempting, as current code already does;
  - wait for idle;
  - if kind is `sendText`, call `startPromptTurn`;
  - if kind is `sendGoalCommand`, parse objective from text and call the extracted goal-command execution helper.
- `editQueueItem`:
  - keep the existing item kind;
  - if kind is `sendGoalCommand` and edited text no longer starts with `/goal` or `/target`, store either the objective-only text plus kind, or canonicalize to `/goal ${objective}`;
  - do not trigger a request on edit.
- `reorderQueueItem` and `deleteQueueItem` should remain kind-preserving and side-effect-free.

### Phase 5: Tests and verification

Unit tests:

- Parser:
  - `/goal fix login` -> `sendGoalCommand` objective `fix login`;
  - `/target fix login` -> same command;
  - `/goal replace fix login` -> objective `fix login`;
  - `/goal resume` -> `resumeGoal`;
  - attachment + `/goal` -> not a command;
  - empty `/goal` consumed as unsupported/empty.
- UI routing:
  - draft-first `/goal` creates/promotes a session and dispatches `sendGoalCommand`, not `sendText`;
  - existing session `/goal` dispatches `sendGoalCommand`;
  - held queue passes `heldQueueDisposition`.
- Command handler:
  - completed + no target sets target;
  - completed + existing target replaces target;
  - active turn enqueues `sendGoalCommand` and does not write target immediately.
- Projection:
  - `TurnSteerQueued` with command kind `sendGoalCommand` produces queue item kind `sendGoalCommand`;
  - edit/reorder/delete preserve kind.
- Core drain:
  - text-at-head drains into prompt history as today;
  - goal-at-head is not persisted as a user prompt and does not create an infinite continue loop.
- Queue actions:
  - `sendQueuedNow` on goal item calls goal command path;
  - edited objective-only goal still consumes as goal.

Runtime verification:

- Reproduce with `sess_ec648b58-f3f1-476e-8f2e-c76bffd7735e` style draft-first `/goal`:
  - `session_target` has the new objective;
  - no raw `/goal ...` ordinary `user_prompt` is sent to the model request;
  - the UI goal banner/card updates from snapshot.
- Running session:
  - submit `/goal next target`;
  - snapshot queue shows `kind=sendGoalCommand`;
  - target remains unchanged until the queued command is consumed.
- Queue send-now:
  - queued goal preempts active work through stop/pause;
  - after idle, target is set/replaced through the goal command path.

Required checks before commit:

- `pnpm typecheck`
- `pnpm lint`
- Focused test files added for the parser, projection, command handler, and queue/send-now behavior.

## Open Product Questions

- Should v4 show a visible command row for `/goal <objective>`, or should it only surface the target card/banner? z-code-2 preserved the visible command shape, but current v4 acceptance can first assert the stronger invariant: it must not become an ordinary model prompt.
- Should `/goal show`, `/goal pause`, and `/goal clear` be added to v4 command schema now, or left for full standalone parity?
- Should setup-mode parity from z-code-2 (`direct` / `quick` / `grill`) be planned as a separate v4 protocol extension after this command-routing fix?
