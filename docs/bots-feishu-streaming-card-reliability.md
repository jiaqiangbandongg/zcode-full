# Feishu Streaming Card Reliability

## Impact Brief

- Surface: Feishu/Lark Bot `streaming_card` reply delivery.
- State owner: one inbound Bot turn owns its card handle, consecutive failure count,
  next allowed attempt time, and circuit-open state. The state is memory-only and is
  discarded with that turn.
- Protocol boundary: Bot task subscriptions remain `bot-channel-continuous`; this
  change does not alter desktop `desktop-continuous` or mobile
  `web-remote-replayable` recovery semantics.
- Independent contract fix: shared session-event validation must accept the complete
  CLI payloads for `turn.steerQueued` and `turn.steerDrained`.
- Evidence: unit/contract tests plus low-volume production logs for the first card
  failure and the transition to an open circuit.

## Failure recovery contract

Feishu card writes are best-effort. A provider failure must not block task lifecycle
events, but repeated stream events must not turn one provider rejection into an HTTP
request storm.

```text
task stream event
      |
      v
card sync requested -- before nextAttemptAt --> suppress request
      |
      +-- circuit open ----------------------> suppress request
      |
      v
Feishu create/update
      | success
      +------------------> reset failure state
      |
      | failure
      v
failure 1 -- wait 1s --> failure 2 -- wait 2s --> failure 3
                                                    |
                                                    v
                                              open circuit
```

The circuit opens after three consecutive failures in the same inbound turn. It has
no timer-based half-open transition: stale events arriving minutes later cannot
restart writes for that turn. A new inbound user message creates a new turn-local
state and may attempt delivery again.

The backoff is event-driven; no retry timer is created. A request is attempted only
when another task event arrives after the current delay. Forced terminal/tool syncs
also obey failure backoff and the open circuit.

## Element budget and card segmentation

Feishu Card JSON 2.0 rejects cards that exceed 200 components or elements with
`230099/11310` and `element exceeds the limit`. The provider therefore owns a
conservative budget of 180 tagged elements per streaming card, including nested
elements and the running/completed status line. The budget is checked before every
create or update request.

Official reference: [Send messages - error code 11310](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create).

When the next timeline block would exceed that budget, the current card is sealed
with the largest fitting prefix and retained in the conversation. Remaining blocks
start a new card, which becomes the only card updated by later stream events.

```text
timeline blocks
      |
      v
rendered element budget <= 180 ---- yes ----> update active card
      |
      no
      v
seal largest fitting prefix -> retain old card -> create next card for suffix
```

The service tracks the first block owned by the active card, so segmentation does
not resend sealed content. If Feishu still returns `230099/11310` despite the
conservative local budget, normal backoff and circuit breaking apply; the service
must not create an unbounded card loop from an unexpected provider rejection.

## Runtime evidence contract

Production logs retain only failed write attempts, not every suppressed stream event:

- each failed attempt: task id, trigger event type, create/update operation, failure count,
  next retry delay, and provider error;
- circuit opened: the same identity fields and the final provider error.

This evidence distinguishes a late task event from a timer or autonomous retry. In
particular, an update observed long after `/停止` must carry the task event that
requested it. High-volume per-chunk and per-suppression traces stay out of production
logs.

## Invariants

- Card delivery failure never changes Agent/task settlement.
- No emitted card exceeds the provider-owned 180 tagged-element budget.
- Every timeline block is delivered by at most one retained card segment.
- No retry timer survives task completion or stop.
- A single failed Bot turn cannot issue further card writes after its circuit opens.
- Feishu/Lark are the only providers affected.
- Queue/guide event validation is additive and does not move queue authority out of
  the CLI runtime.
