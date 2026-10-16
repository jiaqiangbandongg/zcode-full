---
description: Select and restore a legacy ZCode session.
argument-hint: "[agent/workspace/session filters]"
skills: restore-legacy-sessions
---

Use the `restore-legacy-sessions` skill for this request:

$ARGUMENTS

Start by listing legacy agents, then narrow to a workspace and a conversation. Run a dry run before applying any restore, and keep the default source as `~/.zcode/v2/sessions` unless the user explicitly provides another source directory.
