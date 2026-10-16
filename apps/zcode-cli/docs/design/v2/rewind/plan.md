# Rewind Implementation Plan v2

Status: initial runtime slice implemented; selector UI and ZCode app-server projection still
planned.
Date: 2026-05-11.

This document turns the existing rewind/compact/checkpoint contract into an
implementation plan. It should be read with `docs/design/v2/rewind-compact.md`
and `docs/design/v2/compact/README.md`.

## Goals

ZCode rewind should let users return to a previous user-authored point without
making compact, checkpoint, or resume state ambiguous.

The product behavior is:

- `/rewind` opens a message selector in interactive clients.
- `/rewind <messageId>` rewinds conversation to before that user message when
  the message is still in the active chain.
- `/rewind code <messageId>` or an equivalent picker option restores only the
  workspace checkpoint for that message.
- `/rewind both <messageId>` restores both conversation and workspace when the
  target is in the active chain and a workspace checkpoint exists.
- If the target is covered by compact, conversation rewind becomes a fork
  proposal or explicit `/fork <checkpointId>` path. File-only rewind may still
  run if the checkpoint artifact exists.

This keeps three concepts separate:

- Conversation rewind changes model-visible message state.
- Workspace rewind changes files from checkpoint artifacts.
- Compact changes which historical messages are visible to the model.

## Target UX

The rewind UX is defined below; state ownership stays in session/runtime
contracts rather than TUI-local state:

- `/rewind` is a local command that opens a message selector instead of mutating
  state directly.
- The selector lists user-authored messages and offers restore modes:
  conversation, code, both, and summarize.
- File history snapshots are keyed by user message UUID. Tools call
  `fileHistoryTrackEdit()` before mutation and the query loop creates a
  snapshot for each accepted user message.
- Conversation rewind truncates messages to before the selected user message,
  resets transient state, restores the selected prompt into input, and restores
  pasted images.
- Compact boundary messages slice provider-visible context. Selectors may still
  show older scrollback, but summarize/rewind must reject or fork when the target
  is not in active context.
- Non-interactive file rewind is standalone: resume a session, pass a user
  message UUID, restore files, and exit.

ZCode implements this UX through session/runtime contracts instead of
TUI-owned arrays. TUI and ZCode app-server should consume the same target
evaluation results.

## Current ZCode Baseline

Already implemented:

- `CheckpointCreatedPayload`, `RewindTriggeredPayload`,
  `WorkspaceCheckpointArtifact`, and `evaluateRewindTarget()`.
- Workspace checkpoint artifacts are written for successful file mutation tool
  results.
- New checkpoint `messageId` values are anchored to the user message that
  opened the turn, while `toolMessageId` preserves the assistant message that
  owns the tool part. Older checkpoint events may still only have the assistant
  message id.
- `/rewind latest` and `/rewind <checkpointId>` restore workspace files.
- `/fork latest` and `/fork <checkpointId>` create a child session from a
  workspace checkpoint.
- Compact writes standard `CompactBoundary` payloads and replaces the active
  provider history.
- TUI has a generic selection list for checkpoint/session rows.

Initial slice implemented on 2026-05-11:

- Checkpoint events now keep a user-message anchor and an optional
  tool/assistant-message anchor.
- `/rewind message <messageId>` and `/rewind conversation <messageId>` rewind
  the active provider-visible conversation to before an active user message.
- `/rewind code <messageId>` resolves the latest workspace checkpoint for that
  message and restores it.
- `/rewind both <messageId>` composes workspace restore and active conversation
  rewind when the target is still in the active chain.
- Resume hydration applies compact boundaries before persisted conversation
  rewind targets, so compact-covered messages cannot be reintroduced by resume.

Still missing for full conversation rewind UX:

- Selectable user-message target summaries.
- Rich persisted tombstone/revert metadata for hidden post-rewind messages.
- TUI/ZCode app-server projection that can show conversation, workspace, both, fork, and
  unavailable modes.
- Interactive input restoration after rewind.

## Target Model

### Target Types

`RewindTargetKind`:

- `message`: user-authored message id.
- `checkpoint`: workspace checkpoint id.
- `latest`: latest workspace checkpoint or latest selectable message depending
  on command mode.

`RewindMode`:

- `conversation`: restore provider-visible message chain only.
- `workspace`: restore files only.
- `both`: restore conversation and workspace in one audited turn.
- `fork`: create a child session when conversation rewind crosses compact.
- `summarize`: optional later mode that performs partial compact around the
  selected message instead of restoring.

`RewindTargetSummary`:

- `messageId`
- `checkpointId?`
- `createdAt`
- `preview`
- `modeAvailability`
- `strategy`
- `compactBoundaryId?`
- `coveredByCompact`
- `fileCount?`
- `diffStats?`
- `disabledReason?`

### Strategy Matrix

| Target | Requested mode | Checkpoint | Compact status | Strategy |
| --- | --- | --- | --- | --- |
| active message | conversation | any | active chain | `active_chain` |
| active message | workspace | yes | active chain | `active_chain` |
| active message | both | yes | active chain | `active_chain` |
| active message | workspace/both | no | active chain | `unavailable` |
| compact-covered message | conversation/both | any | covered | `fork_required` |
| compact-covered message | workspace | yes | covered | `file_only` |
| missing message | any | any | missing | `unavailable` |
| checkpoint id only | workspace | yes | any | `active_chain` or `file_only` |

Important: `both` is not two unrelated operations. It is one runtime turn that
emits one `rewind_triggered` event with `scope=both`, records the selected
message/checkpoint, restores files, then replaces active conversation state. If
the file restore fails, conversation state must not be truncated.

## Contracts

### RewindTargetEvaluated

Add a reusable pure result type in `packages/contracts/src/rewind`:

```ts
export interface RewindTargetSummary {
  checkpointId?: string;
  compactBoundaryId?: string;
  coveredByCompact: boolean;
  createdAt: number;
  disabledReason?: string;
  fileCount?: number;
  messageId: MessageId;
  modeAvailability: Record<RewindMode, boolean>;
  preview?: string;
  strategy: RewindStrategy;
}
```

The runtime should return these summaries to TUI/ZCode app-server instead of making clients
parse raw messages, compact parts, or checkpoint events.

### Conversation Rewind Event

Extend `RewindTriggeredPayload` only if needed. Prefer using the existing
fields:

- `scope=conversation | both`
- `strategy=active_chain | fork_required | unavailable`
- `targetMessageId`
- `targetCheckpointId?`
- `compactBoundaryId?`
- `restoredSnapshotRef?`
- `createdMessageId?`
- `reason`

If post-rewind hidden history needs durable metadata, add
`conversationCutMessageId` or `removedMessageCount` rather than storing removed
message bodies in the event.

### Session Store

Do not hard-delete messages for conversation rewind in P0. Add a contract that
lets runtime persist a logical active-chain override:

```ts
interface SessionConversationRewind {
  rewindId: string;
  targetMessageId: MessageId;
  keepBeforeMessageId: MessageId;
  removedMessageCount: number;
  compactBoundaryId?: string;
  createdAt: number;
}
```

Implementation options:

- Preferred P0: store this as session-level `revert`/rewind metadata plus a
  `rewind_triggered` event; message hydrator applies the latest rewind cut when
  reconstructing active messages.
- Later: add tombstone fields or an explicit message-chain table if multiple
  branches need first-class storage.

This preserves audit history and avoids deleting attachments, tool artifacts, or
compact summaries.

## Runtime Plan

### Phase 1: Message Target Listing

Add `listRewindTargets({ limit, includeCoveredByCompact })` to runtime and
bootstrap app facade.

Rules:

- Only user-authored, non-synthetic, non-meta messages are selectable.
- Tool result messages, synthetic rewind notices, compact summaries, queued
  command outputs, and transcript-only messages are excluded.
- Each row is evaluated against the latest compact boundary.
- Rows should include matching workspace checkpoint metadata when available.
- Default interactive list may hide compact-covered conversation targets but
  should expose them in advanced mode or mark them as fork-required.

Tests:

- Synthetic messages are excluded.
- A user message with a workspace checkpoint advertises `workspace` and `both`.
- A compact-covered message advertises `workspace` only if the checkpoint exists
  and `conversation` as fork-required.

### Phase 2: Workspace Checkpoint Mapping by Message

Current workspace checkpoint selection is checkpoint-id first, and checkpoint
events point at assistant/tool messages. Conversation rewind needs a
user-message view. Add explicit turn ownership to checkpoint metadata:

- `targetMessageId` or `userMessageId`: the user-authored message the restore
  target should appear under.
- `toolMessageId` or `assistantMessageId`: the assistant message that owns the
  tool part and artifact.

Then add message-id lookup:

- `selectCheckpointForMessage(events, messageId)`
- Latest checkpoint at or before the selected user message is not enough. Use
  the checkpoints whose user-message anchor equals the selected user message,
  unless a later spec defines a richer turn graph.
- If a turn produces multiple file mutation checkpoints, group them under a
  single message-level restore target and restore all artifacts in stable order.

This is the biggest difference from the current P0, where each successful file
mutation creates a one-file checkpoint anchored to the assistant/tool message.
Conversation rewind needs a message-level checkpoint view keyed by the user's
turn.

Tests:

- Multiple file mutations in one turn produce one message-level target with all
  files.
- Missing artifact makes workspace/both unavailable but still allows
  conversation-only active-chain rewind.

### Phase 3: Conversation-Only Active-Chain Rewind

Add `rewindConversationToMessage({ targetMessageId })`.

Algorithm:

1. Reject if another regular/compact/rewind turn is active.
2. Load persisted messages through `SessionStorePort.messages()`.
3. Apply latest compact boundary and latest prior rewind cut to get the current
   active chain.
4. Find the target user message in that active chain.
5. Build the kept chain as messages before the target message.
6. Rebuild provider `messageHistory` from kept chain.
7. Persist a synthetic user/status notice that says conversation was rewound and
   the selected prompt is ready to edit/resubmit.
8. Append `rewind_triggered` with `scope=conversation`.
9. Persist session rewind metadata so resume applies the same cut.

The selected user prompt should be returned in the command result as
`restoreInput` for TUI/ZCode protocol clients. Runtime should not directly mutate TUI input
state.

Tests:

- Rewind to a user message removes later messages from provider context.
- Old messages remain in storage for audit.
- Resume after rewind reconstructs the same active chain.
- Permission/model/context snapshot from the selected message can be surfaced to
  clients, but P0 does not silently rewrite session permission.

### Phase 4: Both Mode

Add `rewindToMessage({ targetMessageId, mode: "both" })`.

Order:

1. Evaluate target.
2. Read all workspace checkpoint artifacts for the target message.
3. Dry-parse all artifacts before touching files.
4. Restore files through `FileSystemPort`.
5. Rebuild active conversation chain.
6. Persist synthetic notice and event.

Failure rule:

- If checkpoint read or file restore fails, do not truncate conversation.
- If conversation rewrite fails after file restore, emit a failed event with the
  restored snapshot refs and return an actionable error. Do not attempt silent
  reverse restore in P0.

Tests:

- Both mode restores files and truncates active chain.
- File restore failure leaves conversation unchanged.
- Event payload contains both target ids and restored refs.

### Phase 5: Compact-Covered Targets

For targets before the latest compact boundary:

- `conversation` and `both` return `fork_required`.
- Interactive clients present "Fork from here" instead of "Restore
  conversation".
- Runtime may expose `forkConversationFromMessage()` later, but P0 should reuse
  checkpoint fork where possible.
- `workspace` remains available if checkpoint artifacts exist and emits
  `strategy=file_only`.

Tests:

- Compact-covered conversation rewind never mutates current active chain.
- File-only compact-covered rewind adds a synthetic notice and preserves compact
  boundary.
- Fork creates a child session and restores files without editing parent active
  context.

### Phase 6: Client UX

TUI:

- Bare `/rewind` should open a message selector, not the checkpoint selector.
- The selector defaults to recent user messages.
- Rows show prompt preview, age, compact/fork-required marker, and file-change
  count when available.
- Selecting a row opens a mode picker:
  conversation, workspace, both, fork, nevermind.
- Keep `/rewind latest`, `/rewind <checkpointId>`, and `/fork <checkpointId>` as
  scriptable compatibility paths until message-id syntax is finalized.

ZCode app-server:
- Add list/evaluate/apply methods or emit structured selection data through the
  existing app facade.
- Do not require remote clients to infer active-chain legality from transcript
  scrollback.

CLI non-interactive:

- Add an explicit standalone file rewind command only after the message-id
  checkpoint mapping is stable.
- Conversation rewind should remain interactive until active-chain replacement
  and resume behavior are covered by tests.

## Command Syntax

Keep current compatibility:

- `/rewind` opens the selector in TUI or shows status in non-interactive clients.
- `/rewind latest` restores latest workspace checkpoint for now.
- `/rewind <checkpointId>` restores that workspace checkpoint.
- `/fork <checkpointId>` forks from a checkpoint.

Introduce message-id syntax behind tests:

- `/rewind message <messageId>`
- `/rewind code <messageId>`
- `/rewind both <messageId>`
- `/rewind fork <messageId>`

Do not overload bare `/rewind <id>` until checkpoint ids and message ids have
unambiguous prefixes in all persisted data.

## Compact Coupling Rules

- Compact boundary is the source of truth for provider-visible active chain.
- Conversation rewind may only cut inside the current active chain.
- Compact-covered conversation targets must fork or return unavailable.
- Partial compact must record preserved segment fields before it can be eligible
  for conversation rewind.
- Rewind-created synthetic notices are normal active-chain messages, but message
  selector must exclude them.
- After rewind, auto compact should use the post-rewind active chain and should
  not count hidden audit history.

## Checkpoint Coupling Rules

- Workspace checkpoints are artifacts, not conversation messages.
- Message-level restore targets should aggregate all file mutation artifacts for
  one user turn.
- Rewinding files does not change attachment artifacts.
- Conversation rewind does not delete checkpoint artifacts.
- Rewind events must include enough refs to audit which checkpoint artifacts were
  used.
- Large diffs stay in artifact storage; selector rows return summaries only.

## Observability

Emit structured logs/events for:

- `rewind.targets.listed`
- `rewind.target.evaluated`
- `rewind.started`
- `rewind.workspace.restore.started`
- `rewind.workspace.restore.completed`
- `rewind.conversation.apply.started`
- `rewind.conversation.apply.completed`
- `rewind.failed`

Every operation must carry the existing `traceId`, `turnId`, and child span
context. Errors should use stable reasons, not message text:

- `target_message_not_found`
- `target_not_user_authored`
- `target_covered_by_compact_requires_fork`
- `checkpoint_required_for_workspace_rewind`
- `checkpoint_snapshot_unavailable`
- `conversation_rebuild_failed`
- `session_store_not_configured`
- `file_system_port_not_configured`

## Test Plan

Contracts:

- Extend `packages/contracts/tests/rewind.test.ts` for message target
  evaluation, mode availability, and compact-covered fork-required cases.

Core runtime:

- List rewind targets from persisted messages.
- Rewind conversation active chain.
- Rewind both with all message-level file artifacts.
- Resume after conversation rewind.
- Compact then attempt conversation rewind before boundary.
- Compact then file-only rewind before boundary.
- Missing checkpoint artifact.
- Multiple file edits in one user turn.
- Synthetic messages excluded from selector rows.

CLI/TUI:

- Bare `/rewind` opens message selector when available.
- Compatibility checkpoint picker remains reachable through explicit checkpoint
  command path.
- Mode picker submits explicit command-shaped requests.
- Disabled rows explain fork-required or unavailable status.

ZCode app-server/bootstrap:

- App facade exposes target listing and structured apply results.
- Remote clients get `restoreInput` instead of relying on terminal-only state.

## Implementation Order

1. Contracts: add target summary/mode types and pure evaluation helpers.
2. Core target listing: derive user-message rows and attach checkpoint metadata.
3. Runtime workspace mapping: group checkpoint artifacts by message id.
4. Conversation-only active-chain rewind with resume reconstruction.
5. Both mode with transactional ordering.
6. Compact-covered fork proposal path.
7. TUI message selector and mode picker.
8. ZCode app-server projection and non-interactive file rewind.

Each step should be a separate feature-level commit with focused tests.

## Open Questions

- Should message-level workspace checkpoints aggregate during tool execution or
  only in the rewind projection?
- Should conversation rewind update session permission/model state from the
  selected message, or only return it to the client as metadata?
- Should `/rewind latest` eventually mean latest user message, or remain latest
  workspace checkpoint for backwards compatibility?
- Do we need unrevert/redo, or is fork the recovery path for accidental rewind?
- How much pre-compact scrollback should the selector expose by default?
