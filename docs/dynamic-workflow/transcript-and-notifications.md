# Dynamic Workflow: Transcript and Notifications (spec)

Status: implemented. This document describes what a workflow run leaves behind in the chat
transcript and in the main agent's notifications; its siblings `presentation.md` (the graph
and run pane), `authoring.md` (the artifact system), and
`apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md` (terminal states, the
journal) own the things these surfaces display.

## What a run leaves behind

A workflow run lives in the background. Its owner, the main agent, learns about it through
notifications, and the user reads those notifications in the transcript. Four surfaces
come out of this:

| Surface | Where | When |
|---|---|---|
| the **notification row** | the transcript turn that a run event wakes | every terminal state, every escalated question, every stall |
| the **completion card** | the tail of that turn | completed runs only |
| the **script transcript** | a side-pane tab, one per run | any run that has touched the project |
| the **epilogue fold** | a subagent's transcript tab | every ask the engine dispatched |

The rule behind all four: the transcript shows what the engine recorded, never what the
model said about it. Every number on the completion card is an engine count, every card in
the script transcript is a journal row, every notification row is built from a payload the
emitter minted at the moment of the event.

## Notifications

A run notification has two halves, minted together at the emit point. The **text** is
what the model reads: a `<task-notification>` block plus guidance on what to do next. The
**payload** is what the GUI draws: a structured `workflowNotification` object riding on the
notification's `originMeta`. Neither is derived from the other. In particular the GUI never
parses the model-facing text; if the payload is absent, the GUI falls back to a bare title
row.

### The payload

`workflowNotification` is a discriminated union on `BackgroundResultOriginMeta`. The zod
source is `packages/shared/src/zcode-protocol-v4/rows.ts`; the contracts package carries a
hand-synchronized TypeScript mirror.

```ts
workflowNotification?:
  | {
      kind: "terminal";
      status: "completed" | "errored" | "stopped";
      stopReason?: "user" | "model" | "provider" | "interrupted"; // only when stopped
      summary: string;                 // ≤500, the same sentence the model reads
      result?: string;                 // ≤4000, the script's return value, serialized
      resultForm?: "prose" | "json";   // a string return is prose, anything else json
      resultTruncated?: true;
      error?: string;                  // ≤2000
      reports?: { count: number; shown: number; preview: string[] }; // ≤8 × ≤500
      artifacts?: { id; kind; title?; version; contentType?; primary?: true; description? }[]; // ≤8
      artifactsTruncated?: true;
      durationMs?: number;             // the lineage's active time, see "How long it took"
    }
  | { kind: "escalation"; qid: string; actor: string; question: string; context?: string; askedAt?: number }
  | { kind: "hole"; siteId: string; ordinal: number; name: string; type: string; prompt?: string;  // ≤4000
      draftPath?: string; line?: number; before?: string; after?: string; reachedAt?: number }
  | { kind: "stall"; sinceMs: number; reason?: string; cap?: number };
```

The payload rides the turn-header row through the protocol and the snapshot, so it is
bounded. Truncation is honest rather than silent: `resultTruncated` means the preview is
partial and the full value is reachable through `GetWorkflowRun`; `reports.count` greater
than `reports.shown` means the same for reports; `artifactsTruncated` means chips were cut
by the cap or by an unknown kind. The emitter truncates before construction, because the
shared schema enforces the same bounds and an over-long field would make the whole row
fail to persist.

The `artifacts` entries are the script's user-facing deliverables (published through
`artifact.*`, see `docs/dynamic-workflow/authoring.md`). They are a different thing from
`result`, which is the script's top-level return value. Only chip-sized fields travel:
bytes and item counts are one click away in the side pane. The one exception is the
primary's `description` (≤500), carried on that entry alone so a cold transcript can draw
the deliverable row with its words. The list is ordered primary first, then publish order,
before the cap of eight is applied.

Two things the terminal payload does not carry. Tokens: at emit time the tracker knows only
the snapshot, and usage lives in the run projection, so the GUI joins by run id when it
needs a token figure. Artifact bytes: the payload names artifacts; the card and the pane read
their bytes through the artifact queries.

### Where the payload is minted

| Kind | Emitter | Trigger |
|---|---|---|
| `terminal` | the background task tracker's settlement path in `packages/core` (`background-tasks.ts`), for both `CreateWorkflow` and `ResumeWorkflowRun` launches | the run's terminal snapshot arrives |
| `escalation` | `dynamic-workflow-run-progress.ts` in `packages/core`, next to the run progress event | an `escalation-raised` run event |
| `stall` | the same file | a `run-stalled` run event |

The terminal payload exists only when the tracker status is terminal **and** a snapshot is
present. A run whose in-process state was lost has no snapshot and gets no payload; the
row falls back to the bare title. The tracker's generic words map onto the run's own:
`failed` becomes `errored`, `cancelled` becomes `stopped`. When the snapshot declares
`runStatus` and `stopReason` (the run service projects them from the journal), those win.

The escalation and stall emitters never throw: they are observation, and the run's truth
is the journal. A malformed event is skipped with a log line. Each `escalation-raised`
yields exactly one notification, never re-sent; an answered question yields none, because
the answer was the main agent's own tool call. Each stall segment yields one notification;
a later success re-arms the clock without an "unstalled" message. The run label on both is
the registry description of the run, else the run id, and an anonymous subagent is named by
its structural reference `site@ordinal`, the same fallback the text uses.

### The pipeline and cold restore

A single notification's `originMeta` is forwarded as one object from the runtime command
through the ledger, the synthetic user message, the `TurnStarted` payload, the normalizer
fact, and the turn-header row. The payload rides along for free. Three places construct
the object field by field and therefore name the payload explicitly: the zod row schema
(zod strips unknown keys), the transcript hydration reader (cold restore would otherwise
drop it), and the contracts mirror. Hydration validates the payload against the shared
schema and, on a malformed value, keeps the three base fields and drops only the payload.

A **batch turn**, where several notifications arrive in one turn and the title becomes
`a · b · +N`, deliberately carries no payload. One turn maps to one row; claiming the first
notification's payload for the whole batch would misreport. The batch turn renders as a
bare title row.

### The notification row

A background-result turn whose `originMeta.backgroundSource` is `workflow` and which carries
a payload renders a **tool row** in place of the bare title: the same `ToolLayout` grammar
as an ordinary tool call, with an icon, a kind label, a primary text, and an expandable
body. Bash and subagent notifications, batch turns, and old transcripts keep the bare title
row. The turn container drops its top padding when it starts with this row, so the card
sits at the ordinary flow gap below the previous turn.

| Kind | Icon | Kind label | Primary text | Expanded body |
|---|---|---|---|---|
| terminal, completed | `Workflow` | Workflow completed / 工作流已完成 | `· <run name>` | the result: prose as a paragraph, JSON pretty-printed in a code block with the language and copy toolbar; both capped at 320 px with the body scrolling |
| terminal, errored | `Workflow` | Workflow errored / 工作流出错 | `· <run name>` | the error in a destructive-bordered panel |
| terminal, stopped | `Workflow` | Workflow stopped / 工作流已停止 `· <reason>` | `· <run name>` | the error panel when an error is present (provider, interrupted), else the result |
| escalation | `MessageCircleQuestion` | one of three live states, below | the question, one line, 160 characters | the question in full, then the context in subtle text, then how long the subagent has waited, then the run link |
| hole | `Pen` | one of three live states, below | `· <run name> · <hole name>` (the type is on the wire for the model, never on the row) | the prompt in full (the values the author interpolated as it carries them), where the hole stands (the phases before and after), the draft path, then how long it has waited, then the run link |
| stall | `Hourglass` | Workflow waiting on the model / 工作流等待模型 | `· <run name>` | one sentence naming the minutes, then `Retry reason` and `Max concurrency` / 「最大并发数」 fact lines when present (the second is the shared cap at the moment of the stall: a bound, so it carries the bound's word, never a word that reads as a count of what is running) |

The stop reason words are by you / by the agent / model error / process exited (你停止的 /
代理停止的 / 模型侧错误 / 进程已退出).

A terminal row is expandable only when it has a result or an error; with neither, it has
no chevron. Reports and usage are carried in the payload and not rendered. An errored run
does not use the tool row's failure styling: that styling means "this call broke", and here
the kind label already says the workflow errored.

The folded header of a terminal row ends with the **artifact chips**: at most three small
artifact pills and a `+N` overflow (an ellipsis when the emitter truncated). Chips render
whenever the payload lists artifacts; they are clickable when the host provides an
open-artifact callback, which needs only the parent session and run id, and disabled
otherwise. A chip passes the payload's `contentType` to that callback, so an HTML artifact
goes straight to the browser tab rather than to the artifact tab (`authoring.md`, "How the
user sees them"); the payload carries no source path, so the handler looks that one up.
When the row is expanded the chips hide, because the body speaks for itself.

The expanded body ends with an **Open run details** link (查看实例详情) when the host can open
the run pane and the run projection knows the run's tool call id. Cold restore sometimes
cannot join the tool call id; then the link is absent and the chips still work.

### The escalation row's live state

The escalation row's kind label flips as the run progresses, using the run projection's
pending questions rather than any text:

| The run projection says | Kind label |
|---|---|
| the run is present and its pending questions include this `qid` | Subagent is waiting for an answer / 子代理正在等待回答, with the waited-for time refreshed every 30 seconds |
| the run is present and the `qid` is gone | Subagent question answered / 子代理的问题已回答 |
| the run is not in the projection | Subagent asked a question / 子代理提出了问题 |

The third state is neutral on purpose: a run evicted from the projection's cap of eight
recent runs tells the GUI nothing about whether the question was answered. The row never
shimmers; a parked question waits on the main agent, not on work. The answer text is never
quoted in the row: it sits in the adjacent `ResolveWorkflowQuestion` tool card.

### The hole row's live state

The hole row's kind label flips on the run projection's `holes`, never on text:

| Condition | Kind label |
|---|---|
| the run is present and its holes list this `siteId` as `waiting` | Workflow waiting for code / 工作流留白 · 等待补全, with the waited-for time refreshed every 30 seconds |
| the run is present and the hole is `filled` | Hole filled / 留白已补全 |
| the run is not in the projection | Workflow left a hole / 工作流留白 |

The row never shimmers: a hole waits on the main agent, not on work. The body is never
quoted in the row; it sits in the adjacent `FillWorkflowHole` tool card
(`docs/dynamic-workflow/presentation.md`, "Holes on the timeline"). A hole and a question
are two rows with two icons and two chips, and never share one: 「1 个问题」 and 「1 处留白待补全」
stand side by side when both are pending.

### What the model reads

The terminal text is a `<task-notification>` of type `local_workflow`:

```
<task-notification>
<task-id>…</task-id>
<tool-use-id>…</tool-use-id>
<status>completed | errored | stopped</status>
<stop-reason>user | model | provider | interrupted</stop-reason>   (stopped only)
<description>run name</description>
<summary>one sentence</summary>
<result>…</result>                                                 (when the script returned)
<error>…</error>                                                   (when present)
<reports count="N" shown="M">…</reports>                           (when any)
<artifacts count="N" shown="M">…</artifacts>                       (when any)
</task-notification>

<delivery guidance>
```

The summary sentence says how the run ended before the model reads any field:

| Ending | Summary |
|---|---|
| completed | `Workflow "<name>" completed.` |
| errored | `Workflow "<name>" errored: the script failed.` |
| stopped, user | `Workflow "<name>" was stopped by the user.` |
| stopped, model | `Workflow "<name>" was stopped by you (TaskStop).` |
| stopped, provider | `Workflow "<name>" was stopped on a provider error.` |
| stopped, interrupted | `Workflow "<name>" was stopped: the process that owned it exited.` |
| stopped, superseded | no notification: the `AmendWorkflow` result that stopped it is the model's account of the stop (below) |
| state lost | `Workflow "<name>" failed because its in-process state was lost.` |

`<result>` is the script's return value serialized; it never falls back to the launch
output, whose text only says the run started. `<reports>` and `<artifacts>` are carried
for every terminal state, since a run that died on its twelfth ask still finished eleven.
The report items come from the terminal snapshot, which carries the first 256 in report
order, and no more than 8 MiB of them, as `reports` and the run's true total as `reportCount`; `count` is always
`reportCount`, so a run with more reports than the section shows says so in `count` versus
`shown`, the same signal the section already gives when its character budget runs out.
Order matters for the overall 120,000-character cap: result and error first, then reports,
then artifacts, then guidance, so truncation cuts the supplements before the outcome. For
a provider stop the `<error>` block is a fixed-form text: what went wrong, what to do,
a fact line (`provider= model= subagent= phase= code=`), and the provider's raw message.

The **delivery guidance** after the block tells the main agent how to present the outcome
and what its next move is. It is chosen by status and stop reason:

| Ending | Guidance |
|---|---|
| completed | present the outcome as a deliverable: conclusion, each finding with its evidence, what was checked versus judged, what was not covered; treat reported items individually; do not restate the graph or the script |
| stopped, user | the user stopped it on purpose; do not resume with `ResumeWorkflowRun` and do not rebuild with `CreateWorkflow` unless asked; present what was finished, then wait |
| stopped, model | you stopped it with `TaskStop`; if you stopped it to fix the script, amend it now with `AmendWorkflow`; otherwise present what was finished and resume only if the user wants |
| stopped, provider | the error block names cause and fix; present what was finished; resolve the cause with the user, then `ResumeWorkflowRun` with the run id; do not rebuild |
| stopped, interrupted | the owning process exited; present what was finished, then `ResumeWorkflowRun`; finished steps replay from the journal |
| stopped, reason unknown | it can be continued; ask the user before resuming a run you did not stop |
| errored | present what was salvaged, explain the failure, then fix the script and submit it with `AmendWorkflow`; `ResumeWorkflowRun` will refuse an errored run. When the run recorded a script file (`docs/dynamic-workflow/launch.md`, "Script files") the guidance names it and says to edit it in place and pass `path`, not to paste the script; a run without one gets the older sentence |

When the `<artifacts>` section is present, one more sentence says the artifacts are already
in front of the user as cards and should be referred to by title, not pasted.

**Who stopped the run.** The GUI cancel path and the model's `TaskStop` tool converge on
one stop routine, which passes the initiator (`user` or `model`) to the run port; the
engine settles the run as `stopped` with that reason and the journal keeps it. The
notification reads the reason from the snapshot; for an old port that does not report it,
the registry's in-process `stopInitiator`, written before the abort, is the fallback. A
user cancel is also what makes the next `AmendWorkflow` of that run ask for confirmation
again.

**A superseded run has no terminal notification.** When `AmendWorkflow` stops a running
predecessor, the run settles `stopped(superseded)` and the background-task coordinator's
notification policy drops its terminal notification: the tool result the model is already
reading says which run was stopped and which one replaced it, and a second message telling
the model "you stopped run A, amend it now" would send it in a circle. The registry entry
is still claimed, so a later `TaskOutput` on the predecessor does not resurrect the message.
The successor notifies as any run does. In the transcript the predecessor's row and card
stay where they were, with the status word "Superseded" and a link to the successor
(`docs/dynamic-workflow/presentation.md`).

The same distinction reaches the model through two more channels. `GetWorkflowRun`'s
`<resumable>` block appends the reason sentence: stopped on purpose by the user, resume
unchanged only when asked; stopped by your own `TaskStop`, amend now if you stopped it to
fix the script; a provider error to resolve first. Its `<amendable>` tail names
`AmendWorkflow`, and a superseded run gets a `<superseded>` block pointing at the successor
in place of `<resumable>`. The `ResumeWorkflowRun` tool description spells out the five
reasons, states that a run the user just cancelled is never resumed on the agent's own
initiative, that an interrupted run usually should be, and that a superseded run is refused.

The escalation text is a `<workflow-escalation>` block (run id, run, question id, subagent,
question, context) followed by the next step, verbatim: call `ResolveWorkflowQuestion` with
the `question_id`. It states that only the asking subagent is parked, the rest of the run
keeps going, nothing times out, and `GetWorkflowRun` lists owed questions if the
notification is ever lost. The stall text is a `<workflow-stall>` block (run id, run,
`since-ms`, dominant reason, cap) followed by a sentence saying the run is still running,
needs nothing from the agent, and must not be cancelled or rebuilt on its own; the user can
stop it from the run card. All three texts open with the standard system-notification
banner so the model does not read them as user input.

The hole text is a `<workflow-hole>` block (run id, run, hole id, name, type, the prompt,
the draft path and line, the phases before and after) followed by the next step, verbatim:
read the draft at that path for the context, write the body, and call `FillWorkflowHole`
with the `hole_id`. It states that only this branch of the script is parked and the rest of
the run keeps going, that nothing times out, that the body is compiled where the hole
stands and sees every binding declared before it, that it must return the named type, and
that `GetWorkflowRun` lists open holes if the notification is ever lost. It opens with the
same banner as the other three.

## The completion card

When the main agent digests a **completed** run's notification, the reply that consumes it
ends with a card: what the run delivered, and what it cost. Errored and stopped runs get no
card; their notification row already states the error and carries their partial artifacts.

### When the card appears

`workflowTurnCompletion.ts` resolves a turn to a card input when all of these hold: the
turn header's origin is `backgroundResult`, the origin's source is `workflow`, the payload
is `terminal` with status `completed`, and the title is non-empty. Escalation and stall
notifications, batch turns (no payload), and bash or subagent notifications never resolve.

The card renders once the turn has finished, never while the main agent is still writing.
It is the first block in the turn tail: after the last paragraph of the reply, before the
running-run digests and every other tail block. One card per turn.

### The card

Top to bottom:

1. **Header**, the shared workflow card header: icon, the kind word Workflow completed /
   工作流已完成, the run name in monospace, the status lamp and word, and an open-details
   control (⤢) when the host can open the run pane and the run's tool call id is known.
   No chevron: nothing on the card expands. The header's two slots carry this run's next
   verb — Save, or Run again once it has a saved workflow, with a 「已保存」 chip beside the
   status ("Saving the run, and running it again" below).
2. **Artifacts.** With a primary (the flagged artifact, or the only artifact when there is
   exactly one): the **deliverable row**, a hairline rule, then the other artifacts as the
   **index**, one line each, in two columns when the card has room for two 220 px columns
   and one column otherwise; at most six lines, and from seven on, five lines and a
   "N more" line that opens the run pane. Without a primary: the index alone, from the
   first artifact in publish order, with the same cap and the same door. No artifact earned
   a preview, so none is drawn. The door shows the real count once the list is known in
   full: the payload is cut at eight, but the live projection (bounded at the engine's 32)
   or the journal answers with every artifact, and the card counts what it merged. The
   ellipsis appears only while the payload is the sole source: a cold render with no
   session, an old CLI without the artifact queries, or the frames before the journal
   answers. A single artifact never stretches into a banner: the row's frame is a tile's
   size. With no artifacts the artifact area is omitted and the card is still drawn,
   because the run finished and cost something.
3. A hairline rule, then **four figures** in a fixed order: time, tokens, subagents,
   phases (时间 · tokens · 子代理 · 阶段). The value is a large monospace number with its
   unit letter in small type; the label sits below in subtle text.

A figure the card cannot obtain shows `—` with the accessible name Not available / 暂无数据,
never `0`.

### Artifact tiles

A tile is a preview frame (16:10) above a caption line, and the whole tile is a button that
opens the artifact: the artifact tab, or the browser tab when the artifact is HTML and the
workspace is local (`authoring.md`, "How the user sees them"). Without an open-artifact
callback the button is disabled: what was delivered is a fact, whether it can be opened is
a capability. The caption is the artifact pill's grammar: kind icon, title, monospace
detail (`12 KB`, `CSV · 6 KB`, `4 items`), and a tail slot that shows the version number
once an artifact has more than one version and swaps to ↗ on hover. The same tile is used
in the run pane's gallery, so an artifact looks the same everywhere it has room. The preview
frame is inert and sits beside the button in the DOM rather than inside it, because a
thumbnail can contain controls of its own (a table's copy button, a file link) and a button
may not nest a button; the button's hit area is stretched over the whole tile.

**The deliverable row** is a tile laid on its side: the same 16:10 frame at 160 × 100 px
(136 × 85 in a pane narrower than 380 px), then, beside it, the kind icon and the title one
type step larger than a caption, the author's description clamped to three lines, and a
monospace `kind · size` line (`Document · 24 KB`, `Board · 9 items`). The tail slot is the
tile's. The whole row is one button with the tile's hover grammar. Emphasis comes from
position, form and words, never from a larger preview and never from a label.

**The index** is what the other artifacts become when a run has a deliverable, and what
every artifact becomes on a card without one: the tile's caption line standing alone, 26 px
high, kind icon, the full title (truncating at the column edge only), the mono detail, and
the tail slot. No frame. A thumbnail at a sixth of the card is texture, not a preview, so the
rule is that a preview is legible or absent; hierarchy comes from form, the pictorial
deliverable against the textual rest, not from a large frame against small ones. Lines flow
in `repeat(auto-fit, minmax(220px, 1fr))` columns on the card and in one column in the pane,
separated from the row by the figures' hairline so the card reads as three bands of a
receipt: what was delivered, what else was made, what it cost. Hover fills the line like a
sidebar row, the icon goes to foreground and ↗ replaces the version. The "N more" line is a
door, not an artifact: an ellipsis icon, subtle text, ↗ at rest; it reads no bytes.

The preview shows the artifact itself, by kind and content type:

| Artifact | Preview |
|---|---|
| markdown, or `text/markdown` | the document's opening, laid out at twice the width and scaled by 0.5 (a thumbnail of the content, not a smaller font), fading to the panel colour over the bottom 28 % |
| `text/plain`, `application/json` | the same, as preformatted text |
| `text/csv` | a mini table of the first 6 rows × 5 columns, cells cut at 28 characters |
| `image/*` | the image, covering the frame |
| chart, table, metrics, board | the preset body in compact form, fed by the artifact data query |
| anything else (PDF, binary, oversized) | a quiet sheet glyph with the extension as a badge |

Bytes are read only within limits: text up to 256 KiB, images up to 4 MiB; beyond that the
glyph is drawn without reading. Of a text artifact only the first 8 KiB are decoded and the
first 1,600 characters shown. While bytes are in flight the frame stays blank; a read error
falls back to the glyph. A preset preview stays blank until its spec arrives from the
journal. Only the frames that are drawn read bytes: on the card the deliverable row alone, in the
pane the row or the gallery's tiles; index lines and the "N more" line never do.

### Where the numbers come from

| Figure | Source |
|---|---|
| time | `durationMs` on the notification payload, the lineage's active time (see "How long it took"), written in the same words as the turn's "worked for" label: seconds rounded, at least one second, at most two units (`1h 3m`, `1 分 42 秒`) |
| tokens | `run.usage.spentTokens` from the run projection, joined by run id; shown compactly (`812`, `386.4k`, `1.30M`) with the full count in the tooltip. For an amended run this is the lineage total, predecessor included (`docs/dynamic-workflow/launch.md`, "The `AmendWorkflow` tool") |
| subagents | `run.actors.length` from the projection |
| phases | `run.phases.length`, the phases entered; a script with no `phase()` markers has none, and the figure shows `—` |

Artifacts start from the payload's list, which is persisted with the notification and
survives cold restore. In a live session the artifact metadata query then fills in content
type, bytes, source path, item count, preset spec and description per id, and appends any
artifact the journal knows that the payload cut, at the end. Identity stays the payload's;
order is primary first, then the payload's. A host without a conversation context (static
rendering, replay) draws the cold card: payload artifacts with glyphs, the primary's
description from the payload, and whatever figures the join returned.

The run projection keeps only the eight most recent runs. When the run has been evicted,
the three projection figures show `—` and the header has no ⤢; time and artifacts still
show. A restart does not empty the projection, because the CLI replays the journal into it
on cold start.

The card arrives with the standard entrance animation; tiles enter staggered, then the
figures. Each figure counts up from 0 to its value over 640 ms, but only when the browser
explicitly reports `prefers-reduced-motion: no-preference`; the first frame is always the
final value, so static rendering, tests, and reduced-motion viewers see the number at rest.

### How long it took

The time figure is the **lineage's active time**: the run's own lives plus every life of the
runs it was amended from, and nothing in between. Two things restart a clock that the figure
must not restart with. A resume is a new life of the same run id, and an amendment is a new
run id that inherits the predecessor's finished work from the cache; in both cases the
process that finally settles the run has only been holding it for the tail of the job, and
the replay of already-finished nodes takes seconds. Left to the settling process's own clock,
a workflow that worked for four hours and was then amended once reports the amendment's
twelve seconds — beside a token figure that is the whole lineage's. The two figures answer
the same question and must be counted over the same span.

A life is bounded by its `run-started` event and the last event it recorded, so the figure
is a sum over lives read from the journal: `Σ (last event − run-started)` for the run, plus
the same sum for each ancestor reached through `resumedFrom`. Idle time between lives is
excluded, because nothing was running in it — a run interrupted by a restart on Friday and
resumed on Monday did not work all weekend. Idle time *within* a life is included: a run
parked on an escalation is live and waiting, which is the same thing a turn's "worked for"
label counts while a tool is slow.

The floor is what the settling process itself observed (`completedAt − startedAt` on its own
entry). The journal's answer is normally larger, since it spans the lives the process never
saw; when it is not — a run whose events predate this accounting, a journal that cannot be
read — the figure falls back to the observed life rather than reporting less than a number we
know to be true. A snapshot with no life evidence at all carries no `durationMs`, and the
figure shows `—`.

### Saving the run, and running it again

A run that finished is the moment a user knows whether the workflow was worth keeping, so
the card's header carries the verb that follows from that judgement. The header's control
slot — the place the run digest keeps Configure, Resume and Stop, empty on a completed run —
holds **Save** / 「保存」 before the workflow is saved and **Run again** / 「再次运行」 after,
both outline buttons at the header's own size, with the save and play icons. The leading
slot, where the digest keeps its pending-questions chip, holds a neutral **Saved** /
「已保存」 chip once the run has a saved workflow: the questions chip's shape in `bg-surface`,
never green, because the lamp beside it is already green and the chip is a fact about a file,
not a run status. The chip is a button that opens that workflow's page in the hub, with ↗ on
hover; where the hub cannot be reached (the web remote-control shell does not offer it) it is
drawn as plain text. Below the header nothing changes: deliverable, index and figures are the
receipt they were. A card narrower than 480 px (container query on the card) drops the
button's word and keeps its icon, with the word as the accessible name and in the tooltip.

The same pair sits in the run pane's status header (`presentation.md`, "The run pane"), at
that header's button size, before Stop, always with its word (every button in that header
carries one). The pane's lead message goes to the run's parent session. A card with no service
context at all (a shared read-only timeline, a static render) mounts neither the chip nor the
verb.

#### The popover

Save opens a popover (`WorkflowSavePopover`, the settings popover's shell: `align="end"`,
320 px, `rounded-xl`, title 「保存工作流」). It offers two ways to save, in the order of their
value, not of their cost:

1. **The lead**, one full-width primary button: 「让 ZCode 帮我提炼保存」 / "Let ZCode refine
   and save it", with one line under it — 「ZCode 会帮你提炼出可复用的工作流，再交你确认。」 A
   script that just ran is a one-off; what makes it reusable is lifting the values that change
   between runs into `args` and writing the description and when-to-use, and only a reader of
   the script can do that. The button sends one user message into this session (below), shows
   「已交给 ZCode…」 for that moment, and closes. The model loads the skill, calls `SaveWorkflow`,
   and the existing confirmation window asks for approval, arguments table and all. When the
   session does not take the message (a paused queue waiting for its own confirmation), the
   popover stays open and the button returns: nothing was handed over.
2. **The verbatim path**, under a hairline divider labelled 「或按原样直接保存」: three fields
   and an outline 「直接保存」. It writes the exact script the run executed, through
   `workflows/save` (`launch.md`, "Data path"), with no model turn.

The three fields serve both paths: whatever is typed rides the message the lead sends, and is
what the verbatim path writes.

| Field | Content |
|---|---|
| 名称 | the file name, mono, with a `.dwf.ts` suffix in subtle text. Prefilled with the run's name only when that name already satisfies the saved-workflow rule (`[A-Za-z0-9_.-]`, at most 64 characters, `launch.md`, "Names and scopes"); a run named in the user's own language therefore starts empty, with a placeholder, because a name is a file name. Helper line: 「字母、数字、`- _ .`，最多 64 个字符」; an invalid name turns it into an error and disables 「直接保存」. |
| 作用域 | 「项目」 or 「全局 · 对所有项目可见」, defaulting to project. A remote project offers project only, with 「远程项目只能保存到项目里。」: `~` on the agent's machine is not a place this hub reads. |
| 说明 | prefilled with the run's name, which is what the model called this run in the user's language and reads as a one-line description in the hub. Helper: 「「何时使用」和参数可以之后在工作流中枢里补。」 |

Under the fields, one consequence line in subtle text: 「将写入 {path}；之后可在「自动化 ›
工作流」按名字再次运行。」 It is replaced by the overwrite warning — 「本项目已有同名工作流，保存
会覆盖它；已有的运行记录保留。」 in `border-warning/40 bg-warning/10`, with the button reading
「覆盖并直接保存」 — as soon as a debounced `workflows/get` says the name is taken. The same
probe asks the other scope, and whichever line is showing gains the shadowing sentence the
`SaveWorkflow` card already uses (「同名的全局工作流将被这一份遮蔽」 / 「本项目里已有同名工作流，
在这里会遮蔽它」) when the other scope holds that name: overwriting and shadowing are separate
facts, and naming only one would imply the other cannot happen. A remote project does not ask
the global scope. The path in the consequence line is set in mono. A refusal from the agent
replaces the line with its own and leaves the popover open: nothing was written.

An agent too old to know `workflows/save` — detected the way the hub detects a missing
`scope`, by the JSON-RPC error of the capability probe below — shows the lead alone: no
divider, no fields, and the hint gains 「当前 agent 不支持直接保存」. The model path is the whole
popover there, which is also what it was before this feature existed.

Keyboard: opening focuses the name field; Tab runs lead → name → scope → description →
「直接保存」; `⌘↩` / `Ctrl↩` triggers the lead from any field; Esc closes and drops the draft.
After a save the focus returns to the slot, now Run again, and the chip announces itself once
through `aria-live="polite"` (「已保存到项目」 / 「已保存为全局工作流」).

#### The message the lead sends

One user message, sent into this session the way the hub's 「提升为全局」 sends its own
(`launch.md`, "Promote to global"): the GUI writes it, the user does not confirm it, and the
session's own routing decides whether it starts now or queues. It names the run and its id,
asks for a distilled workflow rather than a copy, passes whatever the fields hold, and asks
the model to pass `run_id` back to `SaveWorkflow` so the save can be attributed to this run.
It does not carry the script: the model has the call that produced it, and the tool reads the
file it needs.

#### Which workflow a run is saved as

"Saved" is derived, never remembered on the card: after a reload, a save made from another
window, or a save made in chat, the same rule answers. `workflows/forRun` (`launch.md`, "Data
path") answers it on the agent, where both the run's journal record and the saved files are,
and returns the entry itself, so a workflow the user has since deleted stops being a fact
about this run. Three rules, in order:

1. **What the transcript says.** A `SaveWorkflow` tool row in this session that succeeded and
   carried `run_id` for this run names a candidate; the query resolves it and returns it when
   the file is there. This is how the lead's path lands, since the model names the workflow,
   not the user.
2. **What the run executed.** A saved workflow whose body is byte-identical to the run's
   stored script, project scope before global. This is how the verbatim path lands, and it
   keeps landing after the conversation is gone.
3. **What the run is called.** A saved workflow whose name equals the run's name, the hub's
   own rule for attributing run history to a workflow (`launch.md`, "Cards"). This is how a
   run started from the hub, or from `CreateWorkflow` with a `saved` source, shows as saved
   without anything having been saved just now.

The query is also the capability probe: a method-not-found answer marks the agent as unable
to save directly, and the popover shows the lead alone. Its result is cached per run (and per
set of transcript candidates, so a save made in chat is a new question) and dropped whenever
the hub reloads a list, so a delete made in the hub reaches the card. An answer still in flight
when the cache is dropped is discarded rather than written back. A verbatim save turns its own
card over at once, keeping the run's arguments it already had, and drops every other answer,
since overwriting a name can change what another run is saved as.

#### Run again

Run again is the hub's launcher, from the card: the same `startSavedWorkflow` command, the
same new session, the same navigation (`launch.md`, "The launcher"), with this run's
arguments — the journal's, returned by the same query — prefilled in the launch dialog. A
project workflow with no arguments starts immediately, as it does in the hub; a global one
always opens the dialog, because it needs its 「运行于」 project, which starts on the project
this run ran in (the hub's list of local projects, as in the hub). A prefilled value is used
only for an argument the workflow still declares. While the session is being
created the button reads 「启动中…」 and is disabled. A failure is a toast, or an inline error
in the dialog, worded by the launcher's own reason table.

#### Gates

Save and Run again are withheld exactly where Resume is: a read-only conversation, and a
workspace where the dynamic-workflow mode is off (`launch.md`, "Gray release") — both would
write a file or start an engine, and both reach the card through the same supply point in
`SessionPane`. The chip is a fact and stays. A card with no session context (static
rendering, replay) has no controls at all and is the card it always was.

## The script transcript

A phase's timeline shows a pill for every participant. The lane class `workspace` is the
script itself: the `files.*`, `git.*`, and `world.run` steps the script runs with no model
involved. Its pill is labelled Script / 脚本 (the identifier `workspace` stays in code, the
lane id, and the tab type). Clicking it opens a per-run tab that replays those steps as
tool cards in execution order, landing on the clicked phase.

### The journal column

The engine records each `files.*` / `git.*` / `world.run` call as a `dwf_node` row of kind
`world-read` or `world-run`, keyed by site and ordinal, with the result in `result_json`.
The transcript must also say *what* ran, so the row carries `input_json`: a bounded
`{ op, args, truncated? }` written at admission together with the input hash and carried
unchanged through the settlement upsert. Bounding is 4,096 bytes serialized; a larger input
is replaced by per-argument string previews, at most 8 arguments of at most 400 characters,
with `truncated: true`. The input hash is not affected: it remains the cache key, the
column is an audit surface. A row with no recorded input (an older journal) has `NULL`; the
GUI then falls back to the static graph's step label and a generic "Step" kind.

### Two read queries

Both are read-only v4 conversation queries, stateless and safe to resend, with no
sequence or epoch parameter, because they read the journal and there is no staleness to
guard against.

| Method | Params | Result |
|---|---|---|
| `v4/conversation/workflowRunWorkspace` | `{ sessionId, runId }` | `{ nodes: WorkflowRunWorkspaceNode[], truncated?: true }` |
| `v4/conversation/workflowRunNodeResult` | `{ sessionId, runId, siteId, ordinal, maxBytes? }` | `{ status, result?, error?, truncated, totalBytes }` |

```ts
interface WorkflowRunWorkspaceNode {
  siteId; ordinal; kind: "world-read" | "world-run";
  op?; args?; inputTruncated?: true;           // absent on pre-column rows
  status: "running" | "completed" | "failed";
  error?: { code; message };
  summary?: { resultBytes; resultCount?; exitCode?; stdoutBytes?; stderrBytes? };
  createdAt; updatedAt;                        // journal timestamps; their difference is the step's duration
}
```

The list never carries a result body. The row schema is strict, and the storage query does
not select `result_json`; the summary numbers are computed in SQL from the JSON: byte
length of the body, array length for list results, and for a `world.run` result the exit
code and the byte lengths of `stdout` and `stderr`. Rows come back in journal insertion
order, which is admission order.

| Limit | Value |
|---|---|
| list rows | 2,000; the gateway cuts the tail and sets `truncated` |
| `op` length | 32 |
| `args` count | 16 |
| error message | 2,000 characters, cut by the host |
| result bytes | 32 KiB, the default and the maximum of `maxBytes`; the gateway clamps |

**Authorization** is the same chain as the artifact reads, and both queries walk it: the
run row must exist, and its `parent_session_id` must equal the calling session (a `NULL`
parent is refused). The list is authorized too, not only the body: the arguments are
already paths and command lines. All three refusals collapse to one answer, so a caller
cannot learn which half it guessed. The gateway turns an absent list into `{ nodes: [] }`
and an absent body into a `notFound` fault.

**Bounding a body** preserves shape rather than refusing: a string is cut at its tail on a
UTF-8 boundary; an array is cut by whole elements; a `world.run` result keeps `exitCode`
always and splits the byte budget between `stdout` and `stderr`, each half yielding unused
budget to the other; any other object is serialized and, when too large, cut as text. The
response carries `totalBytes` from before the cut, so the footer can say "showing the first
200 lines of 38 KB". This is the opposite policy from the script's own reads, which refuse
an oversized result outright because half a grep would mislead the script.

**Capability.** The list method is not on the engine's journal port (the engine never
enumerates nodes by kind); it comes from the storage adapter's introspection queries and
is probed at wiring time. A host wired to a stub journal registers neither method; the
gateway answers `capabilityUnsupported`, and the panel shows "This session cannot show the
script's steps. Update the CLI to read them." rather than an empty run.

### Opening the tab

The pill is a control only in a live run whose host provides the open callback; a static
card, a draft, and a run with no projection give it no handle. The same rule gates the
script row on the run pane's phase list. The subagent pills and the script pill are gated
separately: a host that can open subagent transcripts but not the script leaves the script
pill inert. The accessible label is "Open the script's steps at {phase}" / 「打开 {phase}
处的脚本步骤」.

The tab's identity is (workspace, parent session, run), type `workflow-workspace`: one tab
per run, from whichever phase it was opened. `focusPhaseId` is a landing point, not part of
the identity. Opening again merges the request into the existing tab; a request naming a
phase replaces the landing point, a request without one removes it. The tab's title is the
run name (falling back to Script steps / 脚本步骤), its icon is a terminal, and its type
label appears in the tooltip and the tab overview. It is scoped to its conversation and is
never collected by subagent-session cleanup: the journal outlives the run, and so does the
tab.

### The panel

The panel subscribes to the parent session's projection for the run's live state and the
static graph, and reads the two queries itself; there is no session behind it, so it does
not embed a session pane. The list is fetched on mount and re-fetched when the live run's
`lastEventSequence` rises, debounced by 250 ms because one step settles through three
events. Bodies are fetched per card and cached by (session, run, site, ordinal) for settled
rows only, up to 256 entries; a collapsed and re-expanded card, and a second tab on the
same run, read from the cache.

The panel is not a second timeline. The run pane keeps the only timeline; here phases are
chapters and there are no lamps or rails.

- **Header**: a terminal tile, the eyebrow Script / 脚本, the run name, and the run's lamp
  and status word. A second line summarizes the book: `3 phases · 9 steps · 4m 12s`,
  counting phases touched, cards, and the span from the first admission to the last
  settlement, advancing every second while a step runs.
- **Chapters**: cards are cut into chapters by execution order. Consecutive cards in the
  same phase form one chapter; re-entering a phase starts a new chapter with a ⟳n badge
  counting entries. A chapter header shows the phase name, the badge, a rule, and
  `n steps · duration`. Cards whose site the graph cannot place have no chapter header.
- **Landing**: on open, the panel scrolls to the first card of the landing phase, or to the
  end when that phase has not started; the landed card's background flashes once. Every
  open re-lands, because the request carries a fresh open time.
- **Placeholders**: a run that has not touched the project shows "The script has not run
  anything yet" / 「脚本还没执行任何步骤」; a capability-less session shows the unavailable
  notice; a cut list ends with "Only the first N steps are shown".

### Cards

A card's kind follows the recorded `op`, which is how the three facade containers divide:

| `op` | Kind | First line | Result line (settled) |
|---|---|---|---|
| `read` | Read | Read + a file chip | the path, bytes |
| `glob`, `grep` | Search | Searched + pattern, `in` + scope | `n files` or `n matches`, duration |
| `git-*` | Git | git + subcommand and arguments | count or bytes, duration |
| `run` | Terminal | Ran (or Running) + the command line, quoted like a shell | `exit n`, duration, stdout bytes |
| absent | Step | the static graph's step label | count, bytes, duration |

Every card has a kind tile on the left (tinted red when failed, amber while running), the
two lines in the middle, and a time-ruler mark on the right: `+m:ss` from the first card's
admission, or `now` with a pulsing lamp while running. A running card's verb shimmers and
its result line says "started {ago} ago". A card whose arguments were shortened before
journaling ends its result line with an ellipsis whose tooltip says so.

The status word: a failed row shows `timed out` when the error code or message says so,
else the error code, in red, with the message as tooltip; a settled command shows `exit n`,
green for zero and red otherwise, with the command line as tooltip on failure. Status comes
from the journal; the live projection only overlays a `replayed` chip when the projection
marks the node as a resume cache hit, meaning the command did not run again.

Read cards do not expand; the file chip opens the code viewer on the file as it is **now**,
not a snapshot. Every other card is a button that toggles its body; the expanded state is
remembered per (session, run, card) for the life of the window. Clicks inside the body or
the peek (selecting text, Copy, a chip) do not toggle.

A collapsed, settled Terminal card shows a **peek**: the last three non-empty lines of
`stdout`, or of `stderr` when `stdout` is empty, with lines that look like errors in red.
The body is fetched when the card scrolls within 200 px of the viewport and goes into the
same cache, so expanding later costs no read.

The **expanded body** depends on the result shape:

| Result | Body | Footer |
|---|---|---|
| `{ exitCode, stdout, stderr }` | `$ command`, then `stdout` (up to 200 lines), then `stderr` on a faintly red section, or "no output" when both are empty | `exit n · duration · bytes` and Copy (copies `stdout`) |
| an array (`glob`, `grep`, changed files) | a numbered list, up to 200 items; `grep` matches show the match's own line number, the path, and the text | `n files` or `n matches`, duration; Copy joins the items |
| a string (`read`, `git-diff`, status) | preformatted text, up to 200 lines; a diff colours `+`, `-`, and hunk headers | duration, bytes |
| anything else | pretty-printed JSON | duration, bytes |

Whenever the body was cut by the line cap or by the gateway, a note under the footer says
"Showing the first {shown} of {total}; the full result stays in the journal."

Motion is confined to opacity, transform, and background colour, and disappears under
reduced motion: the first batch of cards arrives staggered by 24 ms up to 360 ms (later
cards arrive at once), chapter rules grow from the left, peeks and bodies unfold from the
top, and a changed status word swaps.

## The epilogue fold

Every ask the driver dispatches to a subagent is one user message: the script's
instructions, then a quality epilogue (`---`, "Standard for this result:", a list of rules
about evidence and honesty), and for a typed ask a schema epilogue (`---`, "call the
`submit_result` tool…", the JSON schema indented, or one sentence when the schema is already
in the tool declaration). A nudge turn is one message that is entirely engine text: "You
ended your turn without submitting a result…". The reader of a subagent transcript wants
to see what the script asked; the epilogues repeat verbatim on every ask, and a typed
schema is often longer than the instructions.

The driver therefore marks the boundary: it calls `executeTurn` with `epilogueStart` equal
to the instruction length, or `0` for a nudge. The boundary is an offset, not a second
text, because the persisted message must stay whole: an amended run copies the subagent's
transcript into a new session, message by message, and feeds it back to the model, and a
stored display text would drop the epilogue from that history. The model receives the full
text, the persisted text part is the full text, and the ask's input hash, computed over the
instructions before the epilogue is appended, does not change.

The offset travels two ways to the same row. Live, `TurnStarted.payload.epilogueStart`
reaches the normalizer fact and the `userInput` row. Cold, `persistUserPrompt` writes the
same value into the message metadata, and hydration reads it back into the same row field,
accepting only a non-negative integer. The row schema declares
`epilogueStart: number, int, non-negative, optional`. A row without the field, on the main
session, an ordinary subagent, or an old transcript, renders as before.

In the transcript the bubble draws `text.slice(0, epilogueStart)` as the message body and
folds the rest into a disclosure labelled Workflow engine instructions / 工作流引擎附加说明,
collapsed by default, placed inside the bubble below the body and separate from the body's
own "expand more" fold. The disclosure trims the epilogue's leading blank lines and first
`---`, since the fold itself marks that boundary, and keeps the later `---` between the two
epilogues. Opened, it shows the text preformatted in monospace, subtle, capped in height.
An offset beyond the text length is treated as absent: better to show too much than to eat
the body. A message whose body is empty (a nudge) still draws its bubble, containing only
the disclosure; the no-visible-body rule that suppresses a bubble is for attachment-only
messages. Prompt-context parsing (file references and the like) sees only the body. The
open state is local to the row and not persisted. The TUI shows the full text.

## Alternatives not taken

- **A ledger-style notification entry** (double rules with the legend set into the top rule,
  an alignment grid, gutter marks): in a real transcript it introduced new visual elements
  for no information; the tool-row grammar makes a notification a sibling of every other
  tool call.
- **Rendering reports and usage in the notification row**: the row says how the run ended;
  reports belong to the run pane, and the payload still carries them.
- **A completion card for errored and stopped runs**: the notification row already states
  the error and carries the partial artifacts.
- **Deriving the GUI payload by parsing the model-facing text**: wording changes would
  silently break rendering; the payload is minted from the same snapshot facts instead.
- **Per-notification rows for a batch turn**: needs a batch schema; a batch turn
  degrades to a title row rather than misreporting one member.
- **A second timeline inside the script pane**: the run pane owns the only timeline;
  chapters keep phase context without rails.
- **Snapshotting the file a Read card opened**: the chip opens the current file; a
  snapshot would belong to the artifact copy-on-publish path, not the journal.
- **Storing a display text instead of the epilogue offset**: it would corrupt the
  transcript copy an amended run feeds back to the model.
- **Guessing the epilogue boundary from `---` in the GUI**: a wording change would break it
  silently, and a script whose instructions end in `---` would be mis-folded.
- **Wide single-artifact tiles on the completion card**: previews are thumbnails and
  should not take the room of content. The deliverable row keeps this: its frame is a
  tile's size, and the room it gains goes to words.
- **A label or badge on the primary** ("Primary" / 「主产物」): the row's form already says
  it, and a word next to the title reads as noise to the user.
- **Secondaries as mini tiles under the row** (a six-column grid of small frames): at a
  sixth of the card a thumbnail is texture, the captions truncated to ten characters, and
  six framed boxes weighed as much as the deliverable's frame, so the hierarchy the row
  built was spent. The index keeps the caption, which was the only legible part.
- **Secondaries as a pill strip under the row**: pills carry no detail, cut titles at 24
  characters, and past a handful wrap into a texture of capsules.
- **Guessing the primary** (the last content artifact, the largest document): wrong exactly
  when it matters; the only inference kept is the singleton, which is not a guess.

## Open questions

- Tokens are not in the terminal payload, because the tracker cannot know usage at emit
  time; the figure depends on the run projection. A journal-backed usage query would make
  the card whole without the projection.
- Bash and subagent notifications still render as bare title rows; the tool-row grammar
  has room for them.
- Reports ride the payload unrendered. If the row ever shows them, the `count` versus
  `shown` tail ("N more in the run") is the contract to honour.
