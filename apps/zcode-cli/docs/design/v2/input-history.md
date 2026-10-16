# Input History

## Goal

The server should remember recently submitted user inputs so interactive clients
can recall recent inputs into their editor. The immediate TUI behavior is:
when the normal input box is focused, the first `Up` restores the latest
submitted input for the current project, repeated `Up` presses walk to older
inputs, and `Down` walks back toward newer inputs before restoring the original
draft. This must keep working even when the transcript above the prompt can
scroll, and while a model turn is still streaming output and new input would be
queued.

## Ownership

Input history is server/session state, not TUI state.

- TUI only turns `Up` into a `recallPreviousInput` client intent and renders the
  returned text in the input box.
- After a history entry is restored, the TUI moves the prompt cursor to the end
  of the restored text so the next keystroke naturally appends or edits from the
  right edge.
- TUI must not also bind normal prompt `Up`/`Down` to transcript scrollback.
  Transcript keyboard scrollback uses `PageUp`/`PageDown` so the prompt editor
  and scrollback viewport do not compete for the same direction keys.
- Bootstrap/core own the active project identity and decide what counts as an
  accepted input.
- Storage adapters persist and trim history through a stable port.

The renderer must not read SQLite, derive project ids, or keep a durable history
list in React/Ink component state.

## Scope

First version behavior:

- Store non-empty accepted user inputs.
- Scope recall by `projectID`.
- Return the latest entry for the current project by default.
- Support indexed recall with `skip`, where `0` means the latest entry, `1`
  means the next older entry, and so on.
- Keep at most 100 input history rows total across the whole database.
- Skip consecutive duplicates for the same project.

Stored inputs may include normal prompts, active-turn steering inputs, and
accepted slash commands. Slash commands are not a model message contract, so the
command center records the raw command text through a best-effort input-history
port after a command is successfully handled. This includes local commands such
as `/help` when an input-history source is available, so `Up` can recall the
command the user actually typed instead of an expanded prompt. Commands that may
contain secrets, such as `/login ... <api-key>`, must not be recorded.

## Contract

```ts
type InputHistoryKind = "prompt" | "steered_input" | "slash_command";

interface InputHistoryEntry {
  id: string;
  projectID: ProjectId;
  sessionID?: SessionId;
  text: string;
  kind: InputHistoryKind;
  time: {
    created: number;
  };
}

interface InputHistoryStorePort {
  recordInputHistory(input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    kind: InputHistoryKind;
    time?: { created?: number };
  }): Promise<InputHistoryEntry | null>;

  recallPreviousInput(input: {
    projectID: ProjectId;
    skip?: number;
  }): Promise<InputHistoryEntry | null>;
}
```

`recordInputHistory` returns `null` for blank input or consecutive duplicate
input in the same project. `recallPreviousInput` returns `null` when `skip`
points past the oldest entry for the project.

## Persistence

Input history uses the existing session SQLite database, controlled by
`storage.sessionDbPath`. No new `ZCODE_` environment variable is introduced.

```sql
create table input_history (
  id text primary key,
  project_id text not null,
  session_id text,
  text text not null,
  kind text not null,
  time_created integer not null
);

create index input_history_project_time_idx
  on input_history(project_id, time_created desc, id desc);

create index input_history_time_idx
  on input_history(time_created desc, id desc);
```

The adapter trims after each insert:

```sql
delete from input_history
where id not in (
  select id from input_history
  order by time_created desc, id desc
  limit 100
);
```

The retention limit is global, not per project.

## Failure Behavior

- Blank input is ignored.
- Consecutive duplicate input for the same project is ignored.
- Storage failures while recording history must not block prompt submission.
  Bootstrap logs the failure with trace/session/project context.
- Command-center slash command history writes are best-effort and must not block
  or change the command response.
- Recall failures surface as a recoverable client status message. They must not
  close the TUI or mutate the existing draft input.

## Tests

- Storage reads the latest input by project.
- Storage returns older project inputs when `skip > 0`.
- Storage skips blank and consecutive duplicate input.
- Storage retains only 100 rows total.
- Bootstrap records accepted prompts and accepted steered inputs.
- Command center records accepted slash commands such as `/help` as
  `slash_command` when a history source is available.
- Command center does not record slash command forms that may contain secrets,
  including API-key login commands.
- TUI calls `recallPreviousInput` on `Up` in the normal input state, including
  while a model turn is busy, and places the returned text into the input box.
- TUI walks older history on repeated `Up` and restores newer history or the
  original draft on `Down`.
- TUI still recalls history on `Up` after long output creates transcript
  overflow.
- TUI still recalls history on `Up` while model output is streaming.
- TUI does not scroll the transcript with normal prompt `Up`/`Down`; `PageUp`
  and `PageDown` remain the keyboard scrollback controls.
- Approval and clarification prompts keep their existing `Up`/`Down` behavior.
