# Off-Peak Task telemetry V1

> Status: approved implementation contract.
>
> Scope: Desktop local Off-Peak creation and automatic turns. This document is
> the canonical telemetry contract for V1 and overrides older Off-Peak proposal
> text in `docs/monitoring/automation-message-telemetry.md`.

## 1. Goals and non-goals

V1 adds only:

1. one business result event, `off_peak_task_create_result`, for every submitted
   Off-Peak creation attempt;
2. Off-Peak attribution on the existing `message_completion` and `agent_step`
   events.

V1 does not add exposure/form funnel events, extra lifecycle events, a new
aggregator, a persistent outbox, restart replay, or accurate step-level token
accounting. Background Off-Peak turns do not emit `send_btn`.

The implementation uses the existing business telemetry route. Desktop reports
to `POST /api/v1/event/report` on the active ZCode endpoint. Web and mobile keep
`reportTelemetryEvent` as a no-op. The new contract is never sent directly to
ARMS.

## 2. Creation result event

### 2.1 Event envelope

| Field | Value |
| --- | --- |
| `element_name` | `off_peak_task_create_result` |
| `event_region` | `app.session` for a homepage template; `app.automations` for an Automations template or direct create |
| `event_type` | `result` |
| `event_text` | empty string |
| `event_value` | omitted |
| `event_extra_detail` | string-valued fields only |

The source, template ID, selected model, and provider identifier are frozen at
submit time before any asynchronous ticket or persistence work starts. Each
submit attempt emits exactly one final result event after the structured
business result is available.

### 2.2 Detail fields

Common fields:

| Field | Contract |
| --- | --- |
| `result` | `success` or `failure` |
| `template_id` | stable Client Scenes item ID; `item-*` is forwarded unchanged, with no compatibility mapping to legacy unprefixed local IDs; empty string for direct create |
| `model_name` | model selected by the submitted creation form |
| `model_provider` | stable Off-Peak model provider ID |
| `provider_name` | non-sensitive stable provider value; URL-derived values are hostname only |

Success-only fields:

| Field | Contract |
| --- | --- |
| `off_peak_task_id` | stable Off-Peak task correlation ID |
| `ticket_initial_state` | key is always present |
| `queue_position` | key is always present; empty string when absent |

Failure-only fields:

| Field | Contract |
| --- | --- |
| `failure_stage` | stable stage below |
| `error_category` | stable category below |
| `error_code` | key is always present; empty string when no stable code exists |

Stable failure mapping:

| `failure_stage` | `error_category` | Meaning |
| --- | --- | --- |
| `client_validation` | `client_validation` | submitted data failed local validation |
| `ticket_request` | `eligibility_3101` | server rejected Off-Peak eligibility |
| `ticket_request` | `quota_3103` | server rejected the daily ticket quota |
| `ticket_request` | `network` | RPC or network request failed |
| `ticket_request` | `invalid_response` | response envelope or ticket body was invalid |
| `local_persist` | `local_persist` | local task/scheduling state could not be persisted |
| current stage | `unknown` | uncategorized failure |

RPC transport, network, and response parsing remain in
`failure_stage=ticket_request`; `error_category` distinguishes them. Stable
server business codes survive the service/RPC boundary. UI toast selection uses
the category/code pair and never parses raw error text.

### 2.3 Best-effort boundary

```text
submit snapshot
  source/template/model/provider
           |
           v
OffPeakTaskService.createTask
  validate -> ticket request -> local persist
           |
           v
  { ok: true, ... } | { ok: false, stage/category/code, ... }
           |
           +------> UI result/toast/navigation/task execution
           |
           `------> fire-and-forget business telemetry
                    POST active ZCode /api/v1/event/report
                    bounded in-memory retry + bounded app-quit drain
                    final failure is swallowed by the UI helper
```

Telemetry starts only after the business result exists and is not awaited by UI
result handling. A reporting failure must not change the create result, toast,
navigation, scheduler wake-up, or task execution. The common Desktop transport
reuses one logical `event_id` and request body for at most two attempts and joins
the normal app-quit barrier for at most two seconds. The canonical transport
contract is `docs/monitoring/event-report-delivery-reliability.md`.

## 3. Automatic turn attribution

The existing `message_completion` and `agent_step` detail maps gain:

```text
message_source = off_peak_task
off_peak_task_id = <stable offPeakTaskId>
off_peak_run_type = init | resume
```

`automation_id` and `off_peak_task_id` are mutually exclusive in TypeScript
types and runtime schemas. Off-Peak attribution is transported through Desktop
Host `sendPrompt`, service/V4/CLI command boundaries, `turn.started`, and the
renderer telemetry supervisor.

```text
Off-Peak scheduler dispatch
  offPeakTaskId + offPeakRunType + new trace/message identity
           |
           v
Desktop Host sendPrompt (desktop-continuous)
           |
           v
service -> V4 sendText -> CLI runtime
           |
           v
turn.started { offPeakTaskId, offPeakRunType, sourceCommandId }
           |
           v
conversation telemetry supervisor
  no send_btn
  message_completion + agent_step
  actual model facts from model.request.started
```

Attribution belongs to the triggering turn, not the session:

- a later manual message in an associated talk is `chat` and has no
  `off_peak_task_id`;
- the first automatic run, a 3102/app-restart resume, and a retry-created talk
  all carry the same stable `off_peak_task_id`;
- `off_peak_run_type=init` means the dispatch started without a bound
  conversation and created a talk. This includes a replacement talk created
  after a pre-binding dispatch failure;
- `off_peak_run_type=resume` means the dispatch reused an existing conversation
  through `resumeTask`, including 3102 and app-restart continuation;
- first dispatch can fail before binding and create a second talk. This accepted
  behavior makes the relation `off_peak_task_id -> talk_id` one-to-many;
- every automatic turn uses its own `message_id`/`sourceCommandId`. The
  `off_peak_task_id` is never reused as a message ID;
- later manual messages carry neither `off_peak_task_id` nor
  `off_peak_run_type`.

Example:

```text
offPeakTaskId OP-42
  |
  +-- talk A / message run-1       -> attributed, init
  +-- talk A / message manual-1    -> chat, not attributed
  +-- talk A / message resume-1    -> attributed, resume
  `-- talk B / message retry-1     -> attributed, init if no talk was bound
```

The supervisor takes model/provider facts from `model.request.started`, not the
creation form. `message_completion` retains exact message-level token totals.
`agent_step` retains its existing placeholder token semantics.

## 4. Privacy

Allowed values are stable IDs, enums, counts, timestamps, model identifiers, and
an explicitly extracted hostname. Never report:

- server ticket ID;
- title or prompt;
- workspace path or workspace identity;
- full URLs;
- JWTs, API keys, credentials, or request headers;
- raw errors, error messages, or response bodies.

Telemetry helpers construct allowlisted payloads instead of serializing domain
objects or thrown errors.

## 5. Delivery and compatibility boundaries

- Desktop local `desktop-continuous` is the only V1 delivery surface.
- Web/mobile `web-remote-replayable` remains unchanged and does not report this
  event.
- The mobile `/remote` shared-host attachment architecture is unchanged.
- No relay/main-process business state, queue, snapshot, or telemetry
  aggregation is introduced.
- `workspaceIdentity` continues to identify isolated workspace state while
  `workspacePath` remains the filesystem/command path; neither is reported.
- The existing first-dispatch retry binding behavior is not fixed by this work.

## 6. Verification matrix

Focused tests cover:

- homepage template, Automations template, and Automations direct-create source
  snapshots;
- success/failure payloads, exactly-once reporting, required empty keys,
  omitted `event_value`, and privacy allowlisting;
- every stable failure stage/category mapping;
- first run, resume, later manual message, and retry-created second talk;
- the shared attribution branch used by 3102 resume and app restart;
- actual model facts, usage dedupe, duplicate terminal/fact handling, and strict
  automation/Off-Peak mutual exclusion.

No dedicated WDIO telemetry spec is added. Existing Off-Peak E2E planning reuses
OP01, OP02, OP05, and OP06, with deterministic protocol/service/supervisor tests
covering telemetry-specific permutations.
