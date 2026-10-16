# Meta User Context

ZCode context is split by injection target so stable behavior instructions can
stay cache-friendly while volatile workspace context stays below them.

## Goals

- Keep the system prompt front-loaded with stable agent behavior.
- Move project-specific, date-specific, and instruction-file context into a
  separate meta user message.
- Preserve structured context accounting for debug views and tests.
- Avoid reading host time, files, git, or process state from core. Adapters
  resolve those values and core only renders a snapshot.

## Injection Targets

Each `ContextSection` declares:

- `injectionTarget: "system" | "meta_user"`
- `cacheHint: "stable" | "dynamic"`

`system` sections are rendered into provider-visible system blocks. Stable
system sections are rendered before dynamic system sections. Each rendered
system block may carry provider-neutral cache intent:

```typescript
cacheControl: { type: "ephemeral" }
```

Adapters translate this intent to provider-specific request fields. For
Anthropic-compatible providers, the AI SDK receives:

```typescript
providerOptions: {
  anthropic: { cacheControl: { type: "ephemeral" } }
}
```

`meta_user` sections are rendered into synthetic user messages after the
system blocks and before real conversation messages. Consecutive synthetic
user messages are provider-visible content blocks on Anthropic-compatible
requests:

```text
<system-reminder>
As you answer the user's questions, you can use the following context:
# currentDate
Today's date is 2026-05-04.

# agentsMd
...

      IMPORTANT: this context may or may not be relevant to your tasks. You should
not respond to this context unless it is highly relevant to your task.
</system-reminder>
```

The meta user message is part of the initial context prefix. It must be restored
on resume and preserved across history resets the same way the system message is
preserved.

## Default Section Placement

| Section | Target | Cache hint | Reason |
| --- | --- | --- | --- |
| CLI Prefix | system | stable | Fixed product identity prefix. |
| Agent Identity | system | stable | Fixed `zcode-agent` identity and role. |
| Dynamic Behavior | system | dynamic | Communication and action-caution content; independent of output-style coding-instruction replacement. |
| Session-specific Guidance | system | dynamic | Optional guidance derived from the active tool and skill surface. |
| Memory | system | dynamic | Optional project-memory guidance. |
| Environment Info | system | dynamic | cwd and platform vary by session, current model refreshes with session model changes, and git fields stay pinned to the session-start snapshot. |
| Output Style | system | dynamic | Optional active output-style prompt. |
| Context Management | system | dynamic | Long-context continuity and autonomous execution guidance. |
| Git System Context | system | dynamic | Optional session-start git snapshot. |
| Skills | meta_user | dynamic | Discovered skills vary by workspace and are user-invocable context. |
| Request User Context | meta_user | dynamic | Resolved instruction files and project-memory index are assembled into one request context block. |
| Current Date | meta_user | dynamic | Date changes independently of behavior rules. |

Environment Info is a bounded snapshot, not a full repository index. In
particular, `git status --short --untracked-files=all` must be capped to 20
entries before it enters `EnvInfo.gitStatusLines`; large decompiled or generated
workspaces can otherwise make the initial provider request exceed the context
window before the first user message is considered. When the cap is reached, the
adapter keeps a deterministic prefix and appends one truncation line that tells
the model to run `git status --short --untracked-files=all` if exact paths are
needed.

## Ordering

Provider-visible message order:

1. Cached CLI prefix system block.
2. Cached stable system body.
3. Cached dynamic system block.
4. Skills system-reminder user block, when skills are available.
5. Meta user context block: dynamic contextual sections wrapped in
   `<system-reminder>`.
6. Real user/assistant/tool conversation messages.
7. Request-time mode reminder, when required by the current mode.

This ordering keeps the cache-sensitive system prefix stable while keeping
volatile context close to the user turn.

The latest real user message may also be sent with `cacheControl` for the
current request. This request-time marker is not persisted into conversation
history; it acts as a "last message breakpoint" without accumulating old
message-level cache markers.

## Request-Time Mode Reminder

Collaboration mode is mutable session state, so it must not be baked into the
stable tool contracts or the initial context prefix. The runtime appends a
transient `<system-reminder>` user message immediately before each regular model
request when the current mode needs model-visible steering.

For `plan` mode, the reminder states:

- Current permission mode is `plan`.
- The request must stay read-only.
- The model should use tools marked read-only for inspection.
- Non-read-only tools, including `Bash`, must not be called even if they appear
  in the stable tool list.
- The model should produce a plan or ask a clarifying question, then wait for a
  mode switch before making changes.

This reminder is not stored in `MessageHistory`; it is a request projection. A
later `/mode` change is therefore reflected on the next model request without
rebuilding the tool pool or invalidating tool-schema cache assumptions.

## Errors And Fallbacks

- If there are no `meta_user` sections, no synthetic user message is emitted.
- If a context source cannot be read, adapters report diagnostics and omit that
  section.
- If `systemPrompt` override is set, the cached CLI prefix remains first and the
  override becomes the cached stable system body. The default stable and dynamic
  bodies are omitted; applicable meta user attachments remain.

## Test Coverage

- ContextBuilder emits cached CLI prefix, cached stable system, cached dynamic
  system, then meta user messages in order.
- Resolved user instructions and the project-memory index are absent from the
  system message and present in the Request User Context meta user message.
- Skills are absent from the system message and present in a skills
  system-reminder user message.
- No empty meta user message is emitted.
- Runtime preserves the initial meta user message across turns.
- Runtime adds a request-time cache marker to the latest real user message.
- Runtime appends the plan-mode reminder at request time without removing Bash
  from the tool contracts.
- Debug context usage reports system prompt and meta user context separately.
- New-turn task notifications are not ContextBuilder sections: their complete provider-visible user messages count once in Messages, identified by the existing `task_notification` presentation in the request's `sourceEntries`. The reminder wrapper must not make these messages disappear from usage categories. Static context remains counted through sections without duplication; this changes neither provider token usage nor compact budgets.
- Node context adapter caps large git status snapshots and appends a truncation
  marker instead of injecting every changed or untracked path.
