# System Prompt Contract

ZCode stable system prompt is the long-lived behavioral contract for the main
coding agent. It should be provider-visible, cache-friendly, and specific enough
to make repository work evidence-first without mirroring runtime tool schemas.

## Goals

- Fix the agent identity to `zcode-agent`; callers must not compose identity
  text through runtime agent metadata.
- Make "read before deciding" the default behavior for repository tasks.
- Define clear safety, validation, communication, and scope boundaries with
  concrete examples.
- Keep stable prompt copy English-only so prompt behavior is consistent across
  locales.
- Keep tool schemas, project instructions, skills, and current date outside the
  default system blocks; keep the static/global-cache body separate from the
  dynamic/org-cache body.

## Stable Sections

| Section              | Purpose                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Static Default Body  | ZCode role, authorized-security boundary, and compact harness guidance.                                                            |
| Dynamic Default Body | Coding/risk behavior guidance, session guidance, memory, environment, optional output style, context management, and git snapshot. |

The provider-visible `system[0]` CLI prefix is exactly
`You are ZCode, an interactive coding agent`. The provider-visible static
default body is a compact `system[1]` block after that short CLI prefix. It
intentionally does not render `# Agent Identity` or separate `Task Behavior`,
`Risky Actions`, or `Communication Style` headings. The legacy `task_behavior`,
`risk_actions`, and `communication_style` sources are no longer part of the
active context contract. The final provider body must follow this
static/global-cache boundary:

1. Short ZCode software-engineering-agent intro with no heading.
2. Authorized security boundary.
3. `# Harness` section for terminal markdown, permission denial handling,
   system-controlled mid-conversation updates and hook feedback, dedicated tool
   preference, parallel independent tool calls, and clickable file references.

The provider-visible MCS and hook bullet is exactly:

`- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.`

The static block ends at the final `# Harness` bullet. Code-style and
risk/reporting paragraphs must not be emitted in `system[1]`.

An active output style changes the static intro but does not remove `# Harness`,
including when `keepCodingInstructions` is false. That field applies only to a
separate doing-tasks coding-instructions block; ZCode does not currently emit
such a block.

The provider-visible dynamic default body is `system[2]`. It always owns a
leading `\n\n` boundary, independent of provider kind. Its order after that
boundary is:

1. `# Communicating with the user`, followed by user-facing communication
   guidance, the code-style paragraph that tells the agent to match surrounding
   project idiom, and the code-comment constraint.
2. Risk/reporting paragraph for irreversible or outward-facing actions,
   external publishing, inspect-before-delete/overwrite, and truthful validation
   reporting.
3. `# Session-specific guidance` for user-run interactive shell commands,
   slash skill invocation, and guidance for actually exposed built-in tools.
4. Optional `# Memory` when a memory summary is loaded.
5. `# Environment` for current cwd/platform/shell/OS/model/git-repo boolean.
6. Optional active `# Output Style` when a non-empty output style is configured.
7. `# Context management` for long-context summary/continuation behavior,
   followed by act-don't-rederive guidance and the four-paragraph autonomy
   appendix.
8. Optional `gitStatus:` snapshot when the cwd is a git repository.

The output-style section is assembled exactly as
`# Output Style: <name>\n<prompt>`, with no blank line between its heading and
prompt body.

Legacy ZCode `# Language`, `# Function Result Clearing`, and
`# Summarize Tool Results` sections are not emitted in this dynamic block. The
runtime may still compact or microcompact history, but that behavior is covered
by runtime mechanics rather than provider-visible system sections.

Every system section after the CLI prefix owns its left boundary: Main/Workflow
stable blocks and non-empty Subagent agent prompts start with `\n`; Main
dynamic, Subagent Notes, and Subagent environment blocks start with `\n\n`.
An empty Subagent agent prompt does not produce a system block. Built-in blocks
do not add a trailing newline.

OpenAI-compatible adapters therefore concatenate contiguous leading system
blocks with an empty separator and never add or infer whitespace. Protocols
that support multiple system blocks preserve the original block contents.

Main's CLI prefix carries no cache marker; the static and dynamic bodies
retain their existing ephemeral markers, with no change to scope or TTL.

Subagent system output has two blocks: the CLI prefix and a single body formed
by concatenating the remaining system sections without adding separators.
Both blocks carry one ephemeral marker; an empty agent prompt still leaves
Notes and environment in the body. Internal sections remain separate for
inspection. This preserves the prompt text and leaves room for the existing
conversation-tail cache marker within the provider's four-breakpoint limit.

## Request-level context and prompt attachments

The request-level `context_prefix` remains a user-side `<system-reminder>`
carrier. Its final warning paragraph starts with exactly six spaces before
`IMPORTANT:`.

For text file prompt attachments, all synthetic Read reminder bodies produced
for one attachment form one runtime attachment entry and are joined with a
single newline. Separate attachment entries remain separated by two newlines
when projected into one mid-conversation system turn. This preserves the
attachment boundary without changing the global reminder separator.

When a text attachment is truncated by the default line limit, the
provider-visible note is exactly:

`Note: The file <filename> was too large and has been truncated to the first 2000 lines. Don't tell the user about this truncation. Use Read to read more of the file if you need.`

## Required Behavior

The stable prompt must include guidance equivalent to:

- The agent is a ZCode interactive coding agent for software-engineering work.
- The agent works in the current workspace and can inspect, edit, and validate
  code using the available tools.
- User-facing text outside tool calls renders as GitHub-flavored Markdown in a
  terminal.
- A denied tool call means the user declined it; the agent adjusts rather than
  retrying the same call unchanged.
- Mid-conversation system turns are system-controlled updates rather than
  function results; hook feedback is treated as user feedback.
- Dedicated file/search tools should be preferred over shell commands when they
  fit; independent tool calls can run in parallel.
- Code references should use clickable `file_path:line_number` formatting.
- Existing code style, naming, idiom, and comment density should guide edits.
- Risky or shared-system actions require explicit user confirmation.
- External publishing may be cached or indexed and needs care.
- The agent inspects a target before deleting or overwriting it, especially when
  it did not create that target or the observed state contradicts the request.
- Authorized security work (defensive security, vulnerability analysis, CTF,
  education) is allowed; malicious-intent requests (destructive techniques, DoS,
  mass targeting, supply-chain compromise, detection evasion) are refused, and
  dual-use tooling needs a clear authorization context.
- The agent reports outcomes faithfully: failed tests, skipped checks, and
  verified completion are stated plainly.
- If the user must run an interactive shell command, the agent should tell them
  to use `! <command>` so the output enters the conversation.
- Slash skill requests use the Skill tool only for listed skills; the agent does
  not guess missing skill names.
- Memory guidance appears only when a memory summary is actually available, and
  tells the agent to treat memory as optional context rather than truth.
- Environment guidance must not include git branch/status/commit details; those
  belong to the optional `gitStatus:` system context snapshot.
- Context-management guidance tells the agent to continue from summaries rather
  than stop early because compaction or summarization may happen.

## Tool Boundary

Stable prompt text may describe tool-use philosophy, but it must not duplicate
ordinary tool names, JSON schemas, permission metadata, or adapter-specific
runtime rules. Those belong in provider tool definitions and dynamic context.

Allowed examples:

- Prefer fast repository search and direct file reads before editing.
- Use shell commands for actions that dedicated tools cannot cover.
- Run focused tests, typechecks, or linters when they demonstrate the change.

Parallel tool-call guidance (call independent tools in one response, sequence
only on dependencies) is a tool-use philosophy generated by the dynamic
`session_guidance` source, then emitted in provider-visible `system[2]`. Because
it is independent of which tools are registered, `session_guidance` always
renders that fixed line.

Disallowed examples:

- Reprinting full tool schema fields in the stable prompt.
- Maintaining a separate list of all available tools in the stable prompt.
- Encoding provider-specific approval flags that the permission layer already
  owns.

## Identity Compatibility

`agentName` may remain runtime metadata for hooks, persistence, subsessions, and
debug records. It must not affect the stable main-agent system prompt.
`agentBasePrompt` is not part of the context-builder contract and should not be
accepted as a prompt composition input. Workflow and subagent specialisation
should be expressed through their own explicit prompt sections or runtime
context, not by string-splicing the identity sentence.

## Explore Subagent

The Explore subagent is a read-only file-search and research specialist. Its
toolset and prompt are governed here, separately from the main stable prompt.

Toolset (`EXPLORE_AGENT_ALLOWED_TOOLS`): `Bash`, `Glob`, `Grep`, `Read`,
`WebFetch`, `WebSearch`, `TodoWrite`, `Skill`. `Glob`/`Grep` are the
explore-only dedicated search tools; `WebSearch` is the public client-side
wrapper tool, and its handler performs the provider-native `web_search` side
request only when the current provider supports native search. `Skill` only
registers when the child runtime is given a `skillPort`.

Read-only enforcement model: unlike the main agent's `plan`-mode hard gate, the
Explore child runs in `yolo` mode so that `Bash` (a non-read-only capability)
can execute at all. Read-only behavior is therefore enforced by the system
prompt's CRITICAL section rather than by the permission layer. The allowlist
still excludes every file-mutating tool (`Write`/`Edit`/`ApplyPatch`), so `Bash`
is the only mutation vector and the prompt must forbid mutating shell commands
explicitly. This is a deliberate tradeoff: it adopts a prompt-only read-only
model and weakens the previous physical isolation.

Required Explore prompt behavior:

- Identifies as a read-only file-search / codebase-research specialist.
- Carries a CRITICAL READ-ONLY section that forbids file creation,
  modification, deletion, moves, redirects/heredocs, and any state-changing
  command; `Bash` is restricted to read-only operations.
- Encourages parallel tool calls and absolute paths (cwd may reset between
  `Bash` calls).
- ZCode-specific, kept on purpose: says exactly what is missing when evidence is
  incomplete, and explicitly forbids spawning another agent.

## Test Coverage

- ContextBuilder renders a fixed `zcode-agent` identity even when runtime config
  contains custom agent metadata.
- Stable system prompt contains evidence-first and no-guessing guidance.
- Stable system prompt contains safety boundaries with destructive-action
  examples.
- Stable system prompt contains validation and truthful-reporting guidance.
- Stable system prompt contains the authorized-security / refuse-malicious
  policy and the no-URL-fabrication rule.
- Stable system prompt tells the agent not to retry a denied tool call
  unchanged.
- Provider-visible static `system[1]` starts with the ZCode intro, uses compact
  `# Harness`, and does not render `# Agent Identity` or the old `# Task Behavior`,
  `# Risky Actions`, or `# Communication Style` headings; it ends at the final
  `# Harness` bullet.
- Provider-visible dynamic `system[2]` starts with `# Communicating with the
user`, including the code-style and code-comment constraints, followed by the
  risk/reporting paragraph after an unconditional leading `\n\n`. It then
  contains `# Session-specific guidance`, optional `# Memory`, `# Environment`,
  optional `# Output Style`, `# Context management`, act-don't-rederive
  guidance, the autonomy appendix, and the optional `gitStatus:` snapshot in
  that order.
- Subagent provider-visible system blocks are ordered as CLI prefix, optional
  `\n` + non-empty agent-specific prompt, `\n\n` + Notes, and `\n\n` +
  environment.
- OpenAI-compatible serialization concatenates leading system blocks with an
  empty separator and does not inspect or repair their contents.
- Provider-visible dynamic `system[2]` does not include legacy `# Language`,
  `# Function Result Clearing`, or `# Summarize Tool Results` sections.
- Dynamic `session_guidance` always renders the parallel tool-call guidance and
  is emitted in provider-visible `system[2]`.
- Memory guidance is emitted in `system[2]` when a memory summary is loaded.
- Stable system prompt does not mirror ordinary tool schemas.
