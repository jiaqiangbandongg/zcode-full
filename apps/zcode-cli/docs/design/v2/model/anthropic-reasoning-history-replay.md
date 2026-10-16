# Anthropic Reasoning History Replay

Status: L1 Implemented

## Goal

Anthropic thinking signatures are valid only for the model response that produced them. Request
history must therefore remove incompatible reasoning at the request projection boundary without
modifying the canonical session history or treating every block without a signature as invalid.

## Request projection

The current request uses the assistant message's original `providerId + modelId` as provenance and
applies these rules to a request-local copy, in order:

1. When the source and target model IDs differ, or their providers are not replay-compatible,
   remove reasoning with a non-empty Anthropic `signature` and reasoning carrying Anthropic
   `redactedData`. Provider compatibility follows the bounded identity rules below.
2. Remove an assistant message that contains only reasoning and has no tool calls.
3. If the final message is an assistant message, remove its consecutive trailing reasoning blocks.
4. Remove whitespace-only assistant messages and merge ordinary user messages that become adjacent;
   tool-result carriers retain their message boundary.
5. Replace an empty non-final assistant message with `(no content)`.

Reasoning block filtering preserves the assistant message envelope. Message removal and empty
content repair are separate structural passes, rather than letting a
low-level block filter decide whether a conversation turn still exists.

A logical model request applies this structural normalization exactly once, before its first
physical attempt. Ordinary retries reuse that projected request-local history. A signature-repair
retry derives only by removing rejected signed or redacted reasoning from the same projection; it
must not run the structural passes again.

Missing or empty signatures are unsigned reasoning. They are preserved unless the block is removed
by the orphan or trailing rules, or the final serializer-input projection identifies an exact-empty
stream stub with `text === ""` and no `providerOptions` keys. Whitespace-only reasoning is not an
empty stub, and provider options are opaque: the presence of any known or unknown key preserves the
block without inspecting `signature` or another provider-specific field. A missing source model
identity is treated as unknown rather than cross-model, so legacy and synthetic history is not
deleted by inference. Model `variant` and `role` do not participate in identity comparison.

The exact-empty stub filter is request-local and does not rewrite MessageHistory or persisted
session parts. It runs before Anthropic metadata completion. DeepSeek V4 tool-call replay therefore
reconstructs its required empty thinking block afterwards, while Anthropic signatures/redacted data
and OpenAI Responses item references or encrypted content remain untouched.

Live and resumed history must use the same provenance:

```text
completed model result -- result.model -------> MessageHistory
in-flight recovery ------ executionModelRef ---> MessageHistory
persisted assistant ----- provider/model ------> hydrate modelRef
                                                   |
                                                   v
target model + request-local history -> normalize -> AI SDK -> provider
```

The persisted assistant schema already contains provider, model, and variant fields. This behavior
does not add a storage migration or a protocol field.

### Coding Plan provider identity compatibility

Bug cause: the provider refactor migrates the selected `builtin:*` Coding Plan ID to an
`account:*` ID, while historical assistant messages correctly retain their original provider ID.
Strict provider-ID equality then strips signed/redacted reasoning even for the same logical
service and model. Individual/Team switches expose the same mismatch.

The Adapter owns one pure provider-compatibility predicate, shared by generate and stream through
the existing request projection. It uses only the source and target provider IDs:

- Identical provider IDs remain compatible.
- The exact IDs `builtin:zai-coding-plan`, `account:zai-individual-coding-plan`, and
  `account:zai-team-coding-plan` form one compatible group.
- The corresponding three BigModel IDs form a separate compatible group.
- No other distinct IDs are equivalent. Start Plan, Off-Peak, API templates, custom providers,
  unknown IDs, and strings merely containing a known name do not inherit these groups.
- Model IDs still require exact equality. Missing source identity keeps the existing unknown
  provenance behavior; it is not inferred from the current account or Registry.

```text
live / persisted assistant providerId + modelId
                         |
                         v
target identity -> Adapter compatibility predicate -> request-local projection -> SDK
```

This is a replay-only equivalence relation, not a Provider alias resolver. It does not rewrite
selection, routing, credentials, usage attribution, canonical history, or stored bytes, and adds
no field or configuration. Signature contents, block order, tool results, and cache metadata
remain unchanged for compatible histories. Existing signature-rejection repair remains bounded
to its current one-shot request-local retry.

Regression coverage must include both directions between Individual/Team, legacy selection
migration followed by real Runtime cold resume, both generate/stream HTTP serialization, and
cross-service/model/custom-provider controls. Local HTTP fixtures prove client serialization;
they do not establish real service cross-account signature acceptance or cache hit rates.

After Todo109, cold-resume fixtures must run the versioned database migration on store open,
not call the removed per-session migration API. Migration may append new identity fields while
preserving every original member and reasoning part; subsequent request projection must leave
the migrated historical rows byte-for-byte unchanged.

## Signature rejection

An Anthropic request may return HTTP 400 when a signed or redacted thinking block is rejected. The
adapter may retry once only when all of these conditions hold:

- the error text identifies a thinking signature that is invalid or cannot be modified;
- no provider-visible stream output has been committed;
- removing signed or redacted reasoning actually changes the request;
- the one-shot signature-repair credit has not already been used.

The retry uses a request-local copy, has no backoff, and never updates MessageHistory or persisted
messages. The rejection repair removes blank text blocks from an assistant it changed. If that
assistant would otherwise be empty or contain only unsigned reasoning and has no tool calls, it
appends `[Thinking removed]`. Unsigned reasoning itself is not removed.

The one signature-repair retry does not consume the ordinary provider retry budget. Unrelated HTTP
400 responses, a second signature failure, or a request containing only unsigned reasoning are
returned without this repair retry.

The rejected attempt publishes `model_request_failed`, followed by one zero-delay
`model_retry_scheduled` event whose reason is `reasoning_signature_repair`. The repair credit adds
one physical attempt to the status lifecycle without changing the ordinary retry budget. Existing
usage aggregation and `control.apiRetry` projection consume that normal retry event; no separate
retry state or UI path is introduced.

Model-I/O request fields are attempt-scoped. Every emitted record uses the messages that built that
physical attempt: a rejected attempt, when the existing recorder emits one, shows the original
request-local messages, while the successful retry shows the repaired messages it actually sent.
Recording must not fall back to the canonical input request after request-local history changes.

## Invariants

- Same-model signed and redacted reasoning remains unchanged by cross-model compatibility
  filtering. The explicit orphan and final trailing-reasoning structural rules may still remove it.
- Structural normalization runs once per logical model request. Physical attempts, including a
  signature-repair retry, reuse or derive from that request-local projection without normalizing it
  again.
- Text, tool calls, tool results, and cache metadata remain unchanged except for the explicit blank
  assistant cleanup above. Message order remains unchanged except for explicit orphan or
  whitespace-only assistant removal. When whitespace cleanup makes ordinary user messages
  adjacent, they are merged to preserve a valid request shape.
- Anthropic unsigned reasoning that survives normalization remains in the serializer input using
  the required empty-signature representation, except for an exact-empty block with no provider
  options. Whitespace-only reasoning and any block carrying opaque provider options remain intact.
- OpenAI Responses, OpenAI-compatible reasoning fields, DeepSeek V4 synthetic thinking, and
  desktop/mobile delivery semantics are unchanged. Signature repair is visible only through the
  existing provider-retry UI state; no UI component or interaction behavior is added.
- Signature repair reuses the existing model retry status, usage, and live-tail projection paths;
  it does not add protocol fields, persisted retry state, or another retry authority.

## Tests

- `packages/adapters/tests/reasoning-provider-compatibility.test.ts` covers the bounded Coding
  Plan identity groups, exact model matching, custom/unknown provider isolation, and cache metadata.
- `packages/adapters/tests/runtime-reasoning-provider-replay.test.ts` covers actual SQLite decoding
  and selection migration, Runtime cold resume and live continuation, generate/stream HTTP request
  bodies, and original stored message/part immutability with a local fake transport.
- Pure projection tests cover same-model, cross-model, unknown-model, unsigned, redacted, orphan,
  trailing, empty/whitespace assistant repair, rejection placeholders, tool-call, and immutability
  cases. Adjacent-user repair also covers cache-control precedence, mixed string/block content, and
  tool-result carriers on either side of a removed assistant.
- Core tests cover live cloning, persisted execution-model provenance, resume hydration, and
  execution-model provenance on terminal-error, partial-stream recovery, streamed-tool recovery,
  and Start Plan admission-retry paths when the selected model changes in flight.
- Adapter runner tests cover the exact HTTP 400 classifier, a single repaired retry outside the
  ordinary retry budget, no retry after committed output, no retry when the request does not
  change, canonical-history immutability, the failed/scheduled/started status sequence, and
  attempt-scoped production model-I/O. Generate and stream each cover both orderings between an
  ordinary retry and the one-shot signature-repair credit; generate also covers a second signature
  rejection terminating without another repair. A structural regression case keeps an
  empty-assistant placeholder and its surrounding user-turn boundaries unchanged across the
  repaired retry.
- Product projection tests cover the signature-repair retry reason through the existing
  `control.apiRetry` live-tail state.
- Serializer-input projection tests prove that exact-empty metadata-free stubs are omitted while
  whitespace-only reasoning, surviving unsigned reasoning, opaque Anthropic metadata, OpenAI
  Responses metadata, and DeepSeek V4 tool-call placeholders are not silently omitted.
- Desktop replay E2E covers standard native `signature_delta`, start-only signature fallback, and
  native-delta precedence across repeated live and cold-resume follow-ups. It also proves that a
  resumed unsigned-only history is sent unchanged and a signature
  400 that cannot remove any signed or redacted block terminates without retrying.
