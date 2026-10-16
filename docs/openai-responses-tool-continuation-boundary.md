# OpenAI Responses Tool Continuation Boundary

## Goal

OpenAI Responses sessions must continue tool-call turns without leaking Responses-only stored item replay into non-stateful or partially compatible `/responses` providers.

## Problem

ZCode keeps provider-visible history in a protocol-neutral message list. After a Responses model emits reasoning and tool calls, the next model request replays the assistant message plus tool results. Some OpenAI Responses-compatible providers accept `function_call` and `function_call_output` replay, but fail when a stored reasoning `item_reference` is included without `previous_response_id` or a conversation boundary.

The observed failure mode is:

- First Responses request succeeds and returns tool calls.
- Tools complete successfully.
- The follow-up request contains tool results, but the provider returns HTTP 502.

## Required Boundary

- The compatibility behavior is limited to OpenAI Responses transport:
  - `providerKind === "openai"`
  - `apiFormat === "openai-responses"`
- It applies only when ZCode is doing stateless history replay:
  - no `openai.previousResponseId`
  - no `openai.conversation`
  - `openai.store` is not explicitly `false`
- Only stored OpenAI reasoning references are suppressed from assistant history replay.
- Tool calls and tool results remain in the normal protocol-neutral history.
- Anthropic reasoning, OpenAI Chat-style tool results, OpenAI-compatible Chat Completions, and DeepSeek/MiMo `reasoning_content` replay must remain unchanged.

## Verification

- Adapter transform coverage must prove Responses stateless replay drops only stored OpenAI reasoning references.
- Neighbor coverage must prove the same reasoning is preserved when a stateful Responses boundary exists.
- Existing Anthropic and OpenAI-compatible reasoning replay tests must continue passing.
- Required project checks remain:
  - `pnpm typecheck`
  - `pnpm lint`
