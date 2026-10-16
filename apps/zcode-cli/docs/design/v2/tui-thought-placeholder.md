# TUI Thought Placeholder

## Context

Core runtime already emits `model_streaming` events for provider reasoning:
`reasoning_start`, `reasoning_delta`, and `reasoning_end`. ZCode app-server maps live
`reasoning_delta` events to `agent_thought_chunk`, but the local TUI previously
used reasoning events only as a status hint and did not show any transcript
presence for thinking.

The TUI should acknowledge that the model is thinking without forcing raw
reasoning content into the default transcript view. The reasoning content should
be available when the user explicitly expands the thought block.

## Requirements

- TUI consumes only session events; it does not call provider, runtime, or
  session store internals to discover reasoning state.
- A thought placeholder is created only after a non-empty `reasoning_delta`.
  `reasoning_start` alone must not create visible transcript noise.
- While reasoning is active, the placeholder label is `Thinking...`.
- When `reasoning_end` or the final stream `finish` arrives, the placeholder
  label changes to `Thought`.
- The placeholder uses `+` when collapsed and `-` when expanded.
- The placeholder is locally expandable/collapsible. Expanded state is
  presentation-only TUI state and is not written back to session state.
- The expanded view renders the captured reasoning text.
- The thought block aligns with assistant text content; it must not add the
  extra tool-call left padding.
- The thought block leaves one row of bottom spacing so following assistant
  text or tool rows do not visually attach to the thought content.
- Text, thought, and tool parts must preserve the original provider stream
  order inside the assistant message.
- If a provider emits reasoning without a matching start event, TUI should still
  create the placeholder on the first non-empty delta.

## Projection Shape

TUI transcript parts gain a local-only `thought` part:

```ts
type ThoughtTranscriptPart = {
  contentCharCount: number;
  status: "thinking" | "thought";
  streamProjected?: boolean;
  text: string;
  type: "thought";
};
```

`text` is the user-expandable reasoning content. `contentCharCount` is retained
as cheap projection metadata for tests and future copy/status affordances.

## Presentation Choice

Reasoning stays an assistant `reasoning` part and renders as a separate thought
block with a toggle interaction: the local TUI keeps the block collapsed by
default, and expands to show the reasoning text.

## Tests

- TUI event projection creates a `thought` part on `reasoning_delta`.
- The part changes from `thinking` to `thought` on `reasoning_end` and on stream
  `finish` fallback.
- Interleaved thought/text/tool stream order is preserved.
- Render tests verify `+`/`-` markers, expanded reasoning text, and bottom
  spacing.
