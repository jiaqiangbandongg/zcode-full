---
name: restore-legacy-sessions
description: Use when ZCode needs to inspect, plan, or execute restoration of old ACP-era ZCode sessions from ~/.zcode/v2/sessions into the new ZCode task/session stores. Trigger when the user wants to choose a previous agent, select a workspace to restore, pick a specific historical conversation, dry-run legacy session migration, or reason about tasks-index.sqlite and ~/.zcode/cli/db/db.sqlite consistency.
---

# Restore Legacy Sessions

## Overview

Use this skill to guide old ACP-era ZCode session restoration. The first job is selection, not mutation: identify the source agent, the workspace, and the exact conversation before proposing any write to the new stores.

## Stores

- Legacy snapshots: `~/.zcode/v2/sessions/{workspaceHash}/{legacyTaskId}.json`
- Task index: `~/.zcode/v2/tasks-index.sqlite`
- New ZCode session DB: `~/.zcode/cli/db/db.sqlite`

Use `restoredTaskId = meta.acpSessionId || meta.taskId`. The legacy snapshot filename and `meta.taskId` are historical IDs; the app task list often uses `meta.acpSessionId` as the real task/session ID.

The scan script defaults to the live legacy source `~/.zcode/v2/sessions`; pass `--legacy-dir <path>` only when the user explicitly asks to inspect another source directory.

Restored ACP-era conversations are normal ZCode Agent history, so persisted provider fields must be `glm`. Treat the snapshot provider as legacy source context only; do not write task-index `migration_source` or `meta_json.migrationSource` for these restores. The `migrationSource` enum is reserved for the existing Claude Code native import path (`claudeCode`).

## Selection Workflow

Resolve script paths relative to this `SKILL.md` directory. When running from another working directory, use the absolute path to the script inside the plugin cache.

List source agents:

```bash
node scripts/scan-legacy-sessions.mjs agents
```

After the user chooses an agent, list workspaces for that agent:

```bash
node scripts/scan-legacy-sessions.mjs workspaces --agent glm
```

After the user chooses a workspace, list conversations:

```bash
node scripts/scan-legacy-sessions.mjs conversations --agent glm --workspace /Users/dev/test/z-m
```

Use `--query <text>` to narrow conversations by title, message content, task id, or session id. Use `--json` when feeding the result into `jq` or another script.

## Presenting Choices

Ask for one choice at a time unless the user already supplied enough filters:

1. previous agent/provider
2. workspace to restore
3. conversation to restore

Show compact numbered options with title, updated time, message count, `restoredTaskId`, and restore state. If there are many options, show the top 20 by `updatedAt` and tell the user how to filter with `--query`.

After the user chooses an exact conversation, run a dry run first:

```bash
node scripts/restore-conversation.mjs --snapshot ~/.zcode/v2/sessions/<workspaceHash>/<legacyTaskId>.json --dry-run
```

Then apply the restore:

```bash
node scripts/restore-conversation.mjs --snapshot ~/.zcode/v2/sessions/<workspaceHash>/<legacyTaskId>.json
```

## Restore States

- `ready`: CLI DB and task-index both already contain the restored task id.
- `needs-cli-db`: task-index exists, but `~/.zcode/cli/db/db.sqlite` has no session row; rebuild the real session from the legacy snapshot.
- `needs-task-index`: CLI DB exists, but task-index is missing; backfill task-index only.
- `needs-full-import`: both stores are missing; import session history and then index it.

## Mutation Rules

Do not write data during selection. Before any apply step:

- Create timestamped backups of `tasks-index.sqlite` and `db.sqlite`.
- Keep writes idempotent; never overwrite a new real session that already contains user continuation messages.
- Preserve task-index `pinned`, `archived`, `deleted`, and `title_overridden`.
- Use `workspaceKey = workspaceIdentity?.trim() || workspacePath` for identity/isolation semantics.
- Write task-index `provider = "glm"` and CLI message `providerID = "glm"` regardless of the snapshot provider.
- Keep `task-index.meta_json.taskId = restoredTaskId`; never leave it as the old snapshot `meta.taskId`.
- Leave task-index `migration_source` empty for ACP-era restores. If a previous restore wrote `legacy-session`, clear it before validating visibility.
- Write CLI DB `part` rows for visible text and tool calls. The app detail page renders from `part`; `message.data.content` alone is not enough.
- Preserve assistant threading by setting `parentID` to the preceding user message id when possible.
- Do not start old ACP runtimes. Restore from snapshots and new ZCode stores only.

For app code changes, update a spec under `docs/` before implementation and run `pnpm typecheck` and `pnpm lint`.
