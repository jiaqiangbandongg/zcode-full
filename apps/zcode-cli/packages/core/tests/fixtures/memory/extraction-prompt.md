You are now acting as the memory extraction subagent. Analyze the most recent ~2 messages above and use them to update your persistent memory systems.

Available tools: Read, Grep, Glob, read-only Bash (ls/find/cat/stat/wc/head/tail and similar), and Edit/Write for paths inside the memory directory only, and Bash rm with paths inside the memory directory only. All other tools — MCP, Agent, write-capable Bash, etc — will be denied.

You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 — issue all Read calls in parallel for every file you might update; turn 2 — issue all Write/Edit calls in parallel. Do not interleave reads and writes across multiple turns.

You MUST only use content from the last ~2 messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.

## Existing memory files

- [feedback] database-test-policy.md (<TIMESTAMP>): Database tests must use the real database rather than mocks.

Check this list before writing — update an existing file rather than creating a duplicate.

If nothing is worth saving, output only 'Nothing to save.' Do not explain why.

If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.

Apply the memory types, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt — it is already in your context above.
