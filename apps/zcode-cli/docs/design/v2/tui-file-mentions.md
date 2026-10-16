# TUI File Mentions

## Goal

The TUI composer should let users reference files from the current workspace by
typing `@`. This is a local typeahead surface: it helps the user insert a stable
workspace path and, for files, bind a prompt attachment through the existing
attachment pipeline.

## User Contract

- Typing `@` after the start of the draft or whitespace opens a workspace path
  menu above the prompt input.
- Typing more path characters filters candidates in the active directory.
- `@pu` can complete to a matching directory such as `@public/`.
- Completing a directory keeps the menu open and shows that directory's children.
- Completing a file inserts `@path/to/file ` and binds that file as a prompt
  attachment.
- `Up` and `Down` move the highlighted candidate.
- `Tab` completes the highlighted candidate.
- `Enter` also completes the highlighted candidate.
- `Esc` dismisses the menu and leaves the draft unchanged.
- The menu is hidden while a turn is busy because active-turn steering does not
  accept attachments.

Whitespace terminates a mention token. P0 does not support filenames containing
spaces or quoted mention syntax.

## State Boundary

- TUI owns transient mention state: trigger position, query token, visible
  candidates, selected index, loading state, and local dismissal.
- The TUI must not read the host filesystem directly. It asks a read-only
  workspace path suggestion provider exposed through `TuiOptions`.
- The CLI owns the workspace path suggestion provider and resolves candidates
  through the `FileSystemPort` adapter boundary.
- Core attachment resolution remains the source of truth for reading selected
  files and projecting them into model input.

## Data Contract

The TUI provider receives the raw mention token without the leading `@`, for
example `""`, `"src"`, or `"public/assets/"`. It returns display-ready workspace
relative paths using `/` as the separator:

- directory candidates end with `/`;
- file candidates do not end with `/`;
- paths must stay inside the current workspace;
- candidates include a `kind` of `file` or `directory`;
- results are bounded and report whether they were truncated.

The CLI provider lists only the active directory, not the whole tree. It filters
by the segment after the last `/`, sorts directories before files, and prefers
prefix matches over substring matches. VCS and dependency/cache directories such
as `.git` and `node_modules` are excluded from suggestions.

## Rendering

- File mention suggestions render above the prompt input, sharing the same action
  area pattern as slash command suggestions.
- At most eight rows are visible.
- Rows use width-aware wrapping so narrow terminals do not overlap rows.
- Candidate paths use the same primary emphasis as the TUI model popup model
  name: normal text while idle and accent text while selected.
- Directory rows use the trailing slash as the only type signal; no separate text
  label or icon dependency is introduced for P0.

## Attachment Behavior

When a file is selected, the draft contains the visible placeholder
`@relative/path.ext`. The TUI keeps a draft attachment with:

- `type: "file"`;
- `path: "relative/path.ext"`;
- `placeholder: "@relative/path.ext"`.

Before submission, `toPromptInput()` includes only file attachments whose
placeholder is still present in the draft. If the user deletes the mention, the
attachment is removed from the submitted prompt.

Directories are not submitted as attachments in P0. Selecting a directory only
updates the active mention token so the user can continue selecting a child file
or leave the path as normal text.

## Errors

- If the provider is unavailable, no file mention menu is shown.
- If a directory cannot be read, the menu shows no candidates and a short status
  message may be shown.
- If a candidate becomes stale before submission, the existing core attachment
  resolver returns the stable file-read fallback.
- A token that would resolve outside the workspace returns no candidates.

## Tests

- Parser coverage for root mentions, nested mentions, whitespace termination,
  and non-trigger `a@b` text.
- Completion coverage for directory expansion and file insertion with attachment
  binding.
- TUI keyboard coverage for `Tab`, `Enter`, arrows, and `Esc`.
- Rendering coverage for wrapped file mention rows and empty/loading states.
- CLI provider coverage for directory-first sorting, prefix filtering, hidden
  path behavior, and workspace escape rejection.
- FileSystemPort adapter coverage for directory listing and non-directory errors.
