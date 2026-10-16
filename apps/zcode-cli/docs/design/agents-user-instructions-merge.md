# AGENTS.md User And Workspace Merge

## Goal

ZCode should treat `~/.zcode/AGENTS.md` as the user's default instruction file and merge it with the workspace `AGENTS.md` resolved for the current session.

## Resolution

- Workspace instruction discovery keeps the current behavior: search from `workingDirectory` upward until the detected project root, or filesystem root when no project root is detected.
- The user default instruction file is `~/.zcode/AGENTS.md`.
- `HOME` resolves the user directory first. On Windows-style environments, `USERPROFILE` is used when `HOME` is absent. If neither is set, Node's `homedir()` is used.
- The user default file is only considered when `priorityFiles` includes `AGENTS.md`. Custom priority sets that omit `AGENTS.md` must not load `~/.zcode/AGENTS.md`.

## Merge Order

When both sources exist, ZCode injects both in this order:

1. User default instructions from `~/.zcode/AGENTS.md`.
2. Workspace instructions from the resolved workspace `AGENTS.md`.

Workspace instructions appear later so they can narrow or override broad user defaults for work inside the repository.

## Prompt Shape

Each loaded source is rendered as its own labeled block under the request-level `# agentsMd` section:

- `Contents of <path> (user default instructions):`
- `Contents of <path> (workspace instructions):`

The combined block is still request-level meta user context and continues to precede `# currentDate`.
`# agentsMd` names the aggregated request-user-context
field rather than a specific source file. It is rendered exactly once whenever that field contains
at least one non-empty source. A non-empty Project Memory index therefore also renders the title,
even when no AGENTS.md source is loaded.

## Compatibility

`ResolvedUserInstructions` keeps its historical single-source fields for compatibility, while also exposing a `sources` array for multi-source rendering. Existing callers that only inspect `filePath` or `content` continue to receive a deterministic primary path and merged content.
