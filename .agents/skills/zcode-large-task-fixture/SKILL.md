---
name: zcode-large-task-fixture
description: Generate, verify, or remove large synthetic ZCode task fixtures in local ~/.zcode persistence for UI/session performance testing. Use when testing big conversation/task rendering, task list performance, snapshot recovery, tool-call rendering, reasoning, patches, todos, and model usage without spending time chatting manually.
disable-model-invocation: true
---

# ZCode Large Task Fixture

Use this skill to create a large local task that behaves like a long-running ZCode Agent task.
It writes both persistence layers:

- App task index: `~/.zcode/v2/tasks-index.sqlite`
- Agent session DB: `~/.zcode/cli/db/db.sqlite`

The generated task is synthetic test data. Always back up before writing and record the manifest path.

## Quick Commands

From the z-code repository root:

```bash
node .agents/skills/zcode-large-task-fixture/scripts/generate-large-task-fixture.mjs \
  --workspace "$PWD" \
  --turns 3000
```

Verify an existing generated task:

```bash
node .agents/skills/zcode-large-task-fixture/scripts/generate-large-task-fixture.mjs \
  --verify sess_perf_large_YYYYMMDDHHMMSS_xxxxxxxx
```

Remove a generated task:

```bash
node .agents/skills/zcode-large-task-fixture/scripts/generate-large-task-fixture.mjs \
  --delete sess_perf_large_YYYYMMDDHHMMSS_xxxxxxxx
```

## Workflow

1. Confirm the target workspace path. Use the repository root unless the user names another workspace.
2. Generate with `--turns 3000` for a large fixture. This creates roughly 6,000 messages and 20,000 parts.
3. Read the script output and report the `sessionId`, manifest path, counts, and backup directory.
4. Verify with `--verify <sessionId>`.
5. Tell the user to restart or refresh the app if it was already running, then open the pinned task titled `Performance Fixture Large Mixed Task`.

## Safety

- The script uses SQLite `.backup` before generation unless `--no-backup` is passed.
- Backups are stored under `~/.zcode/perf-task-backups/<timestamp>/`.
- Manifests are stored under `~/.zcode/perf-task-manifests/<sessionId>.json`.
- Use `--delete <sessionId>` for generated fixtures. It deletes from `tasks-index.sqlite` and cascades the agent `session` rows.
- Do not delete manually unless you have checked the manifest and confirmed the task id starts with `sess_perf_large_`.

## Coverage

Generated sessions include:

- User text and file parts
- Assistant text and reasoning parts
- Tool parts with completed, running, pending, and error states
- Bash, Read, Grep, Glob, Edit, Write, TodoWrite, AskUserQuestion, Agent, WebSearch, and WebFetch tool shapes
- Patch, compaction, subtask, agent, retry, step-start, and step-finish parts
- Todo rows, session target rows, model usage rows, turn usage rows, and task index searchable text

