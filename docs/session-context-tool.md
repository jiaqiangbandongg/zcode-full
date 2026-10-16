# On-Demand Session Context

`ReadSessionContext` lets the agent use context from another persisted ZCode session only when a current turn actually needs it.

## Goals

- Avoid pre-generating capsules for every session.
- Avoid injecting another full session into the current model context.
- Keep the feature in the agent layer so desktop, web, and remote clients share the same behavior.
- Make `#sess_*` references lightweight UI syntax, not a protocol requirement.

## Flow

1. The current user prompt may mention a prior session, for example `#sess_abc`.
2. The runtime injects a small current-turn reminder that the referenced session is available through `ReadSessionContext`.
3. The model calls `ReadSessionContext` only if it needs that history.
4. The tool reads the target session from `SessionStorePort`.
5. The tool cleans persisted messages, removes model-only/internal reminder content, and builds bounded transcript chunks.
6. If a lite model is available, the tool asks it to extract relevant or handoff context from bounded material.
7. If lite extraction is unavailable or fails, the tool returns bounded local snippets instead.

## Timeout

`ReadSessionContext` has a fixed five-minute tool execution timeout. The timeout is not call-overridable because the tool is read-only but may need to scan a large persisted session and run lite-model extraction before returning bounded context.

This timeout is owned by the agent tool layer, so desktop, web, and remote clients share the same behavior.

## Strategies

- `relevant`: focused retrieval for a concrete question or current task.
- `handoff`: bounded continuation context with objective, decisions, files, blockers, verification, and next steps.

The returned content is background material. It does not override current user, developer, or system instructions.
