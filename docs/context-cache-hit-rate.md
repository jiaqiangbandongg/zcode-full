# Context Cache Hit Rate

ZCode context usage now carries provider cache hit information on the same path as the input toolbar context meter.

The toolbar cache hit rate is a main-session aggregate, not the last provider request.

## Data Flow

- Agent model usage is the source of truth. Only main-session requests are counted. A request is eligible when `querySource === "main_turn"`; sidecar requests such as compact, title generation, prompt enhancement, goal verification, subagent, and workflow child requests are excluded.
- Main-turn provider usage exposes total input `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, per-request `latestHitRate`, and aggregate `hitRate`.
- Aggregate `hitRate` is token-weighted:

```text
sum(cacheReadTokens) / sum(inputTokens)
```

`inputTokens` already includes cache read/write tokens in the AI SDK v6
Anthropic path, so the denominator must not add cache fields again.

- `hitRateRequestCount`, `totalInputTokens`, `totalCacheReadTokens`, and `totalCacheWriteTokens` describe the aggregate window used to compute `hitRate`.
- ZCode Protocol snapshot returns the value at `runtime.contextUsage.cache`.
- Task stream emits the same value on `usage_update.cache`, so desktop `continuous` and mobile `/remote` `replayable` clients consume one shared payload.
- UI displays `cache.hitRate` in the chat input context panel when the field is present. Production builds keep the aggregate `0.78` (78%) threshold so lower rates do not distract from context capacity; development builds always display every valid rate to make provider cache diagnostics observable. It does not invent a fallback when the provider omits cache usage, and it does not infer cache hit rate from task cumulative token usage.

## Context Source Breakdown

Main-session `model_complete` payloads may also carry `contextUsageBreakdown`, which estimates context source proportions by character count. The input toolbar uses that breakdown only for the context popover display; the progress meter's total `used` / `size` still comes from the token usage fields.

Runtime snapshots can arrive while a follow-up turn is already running. During that window the snapshot may have fresher token/cache usage but no new source breakdown yet, because the next `model_complete` has not happened. The renderer keeps the last known breakdown for the same context window instead of clearing the popover, then replaces it when a newer `usage_update.breakdown` arrives.

## Recovery

Runtime snapshots restore aggregate cache hit information from persisted non-summary assistant messages. This keeps visible main-session history recoverable without mixing in title generation or other sidecar requests that do not create normal assistant messages.

Active-branch selection determines which persisted assistant requests belong to the recovered
aggregate, while the original persisted token metadata supplies their input and cache usage.
Provider/context projections may invalidate Compact-preserved assistant usage to prevent a stale
context anchor, but that projection-only invalidation must not erase the same request from the
recovered cache aggregate.

## Developer Tools Panel

When localStorage contains `zcode:developer-tools:enabled` or the legacy alias
`zcode:token-debug:enabled`, the right-side panel add menu shows a Developer Tools
entry. Values `0`, `false`, `off`, and `no` disable the entry; any other stored value enables it.

The Developer Tools panel is scoped to the active task and includes the token debug view for
main-session model requests with:

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `reasoningTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- per-request `hitRate`

It also records recent model network status events that help troubleshoot transport failures:

- request lifecycle status such as started, completed, failed, retry scheduled, and stream stalled
- request id, provider, model, base URL, transport, attempt, retryability, duration, delay, status code, and reason/message
- trace/session/request attribution when available
- sanitized request headers and response headers

The panel never displays response body/data. Header values that can carry credentials or cookies are
redacted before they reach the renderer. Each request/response keeps at most 32 headers, with each
name/value limited to 512 characters; error messages are limited to 2048 characters.

The panel reads `session/debug`, a read-only, session-scoped observation query. The CLI session
record owns a bounded in-memory observation of live `model_network_status` events, independent
of chat subscriptions and telemetry reporting. It retains the latest 200 completed main-turn
requests and 100 network events; aggregate counters cover all observed main-turn completions.
Closing the panel does not stop collection. Closing/reclaiming the CLI session or restarting its
process clears these diagnostics; persisted history does not invent missing network timing.

```text
model request status -> CLI session debug observation -> session/debug -> UI hook -> panel
desktop continuous / mobile replayable: unchanged; both read the same observation query
```

Only completed requests with `querySource === "main_turn"` enter the token table and summary.
Retries have distinct physical request IDs; duplicate events/completions must not double count.
Title, compact, subagent and other sidecar requests remain visible in network diagnostics but
do not enter main-turn token statistics. The query never starts/resumes a task or changes its
activity timestamp. It returns metadata and sanitized headers, never prompt or response bodies.
The visible panel refreshes once per second after the previous read settles; hidden panels stop
querying. Task/workspace switches discard stale responses and clear the previous task's view.
Query failures are shown explicitly instead of being rendered as successful empty results.

### Output TPS

Each completed main-turn request shows `TPS (tokens/s)`:

```text
outputTokens / ((durationMs - timeToFirstContentMs) / 1000)
```

Both durations come from the same provider request clock. First content is the first non-empty
text, reasoning or tool-argument output observed by the adapter. The end is that model request's
completion, not the end of the user turn or tool execution. The numerator is the provider's
`outputTokens`, without adding reasoning tokens again. Missing output/timing, non-finite values
or a non-positive generation duration display `—`; an observed zero output with valid timing
displays zero. The column tooltip explains the denominator.

Acceptance: live requests populate a panel opened before or after completion; 120 output tokens,
5 seconds total and 2 seconds to first content yield 40 TPS; duplicates, failed retries and
sidecars cannot inflate the summary; missing timing never uses request duration as a fallback;
workspace/task switching, desktop/mobile widths and light/dark themes preserve isolation and
readability. Read-only protocol tests and browser integration evidence remain separate from
formal desktop E2E admission.
