# Runtime Communication Performance Reproduction

## Background

The renderer CPU issue under investigation is suspected to happen while a task is actively communicating, not only when opening a long persisted history. Static database fixtures are useful for cold render and scroll baselines, but they do not exercise provider SSE, app-agent protocol fanout, subagent continuation, tool updates, or React updates during an active turn.

This reproduction suite keeps the first phase focused on building repeatable environments. Root-cause profiling and fixes are a separate phase.

## Communication Chain

```text
Provider replay SSE
  -> zcode-cli runtime events
  -> @zcode/protocol stdio NDJSON
  -> host process session services
  -> renderer desktop-continuous subscription
  -> v4 pane projection store
  -> React render / layout / paint
```

For four-pane reproduction, the chain fans out per visible pane:

```text
pane A prompt -> parent Agent tool -> child subagent stream -> parent final stream -> pane A render
pane B prompt -> parent Agent tool -> child subagent stream -> parent final stream -> pane B render
pane C prompt -> parent Agent tool -> child subagent stream -> parent final stream -> pane C render
pane D prompt -> parent Agent tool -> child subagent stream -> parent final stream -> pane D render
```

All cases in this document use desktop `desktop-continuous`. They must not be used to infer mobile `/remote` `web-remote-replayable` snapshot or gap-recovery behavior.

## Case Set

| ID | Purpose | Setup | Action | Evidence |
| --- | --- | --- | --- | --- |
| PERF01 | Isolate one visible pane under high-frequency stream traffic. | One v4 pane, one session, synthetic recorded-stream fixture with many text/reasoning/tool-input chunks. | Send one prompt and keep the stream open long enough for CPU sampling. | Network artifact with chunk timeline, optional CDP profile, UI remains responsive. |
| PERF02 | Reproduce visible four-pane runtime fanout with tools and subagents. | Four v4 panes in one workbench, each bound to a different session. | Send four prompts that each trigger an `Agent` tool, a child subagent streamed response, then a streamed parent final response. | Electron window recording, replay artifact with multiple overlapping `/messages` streams, all panes reach final markers. |

## Recording And Profiling

Phase 1 records user-visible reproduction evidence:

- WDIO drives the four-pane path.
- The in-app Electron window recorder captures a video artifact.
- The DeepSeek replay server writes request and response chunk timelines.
- The recording path requires `ffmpeg` on `PATH`, or `ZCODE_E2E_FFMPEG_PATH`
  pointing at a compatible binary.

Run PERF02 with:

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-runtime-communication-performance.json \
ZCODE_E2E_MANUAL_REVIEW=1 \
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/manual-review/pending/conversation-session-runtime-communication-performance.test.ts'
```

Run the same case without video recording but with a renderer CPU profile:

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-runtime-communication-performance.json \
ZCODE_E2E_PROFILE_ONLY=1 \
ZCODE_E2E_PROFILE_STREAMING=1 \
ZCODE_E2E_MANUAL_REVIEW=1 \
pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/manual-review/pending/conversation-session-runtime-communication-performance.test.ts'
```

Phase 2 adds profiler evidence after PERF02 reliably reproduces high CPU:

- Start an Electron/Chromium performance profile during the overlapping child/final streams.
- Compare active pane render cost, hidden shell fanout, protocol event batching, and tool/subagent update frequency.
- Keep logging high-volume protocol or streaming diagnostics at `debug`; do not add production `info` logs for per-chunk traces.

## 2026-07-08 Local Baseline

PERF02 was run with `ZCODE_E2E_PROFILE_ONLY=1` and `ZCODE_E2E_PROFILE_STREAMING=1`.

- Artifact dir: `packages/desktop/.e2e-artifacts/runtime-perf-20260708105637`
- Case duration: `99552ms`
- Visible renderer tab CPU mean / peak: `2.59%` / `3.87%`
- Total Electron CPU mean / p95 / peak: `4.19%` / `5.96%` / `6.85%`
- Visible renderer working set: `254MB` at start, `424MB` peak, `391MB` near end
- Renderer V8 profile duration: `97455ms`, with about `82318ms` idle, `10320ms` unattributed program time, and `399ms` GC self time

Mapped renderer self-time hotspots:

- `packages/ui/src/components/ai-elements/reasoning.tsx`: reasoning content auto-follow scroll and mask updates, especially `scrollToReasoningBottom`
- `packages/ui/src/v4/ConversationTimeline.tsx`: bottom anchoring layout effect and scroll handling during streaming height changes
- React DOM commit/render work triggered by streaming updates
- `packages/rpc/src/serialization.ts`: small but visible deserialize cost for protocol frames

This baseline does not show a renderer process pegging CPU under deterministic replay; the current bottleneck shape is repeated streaming-driven React commit/layout work plus renderer memory growth. A follow-up high-CPU reproduction should either increase chunk concurrency/frequency or run against the live provider scenario where the original CPU spike was observed.

## Boundaries

- Desktop local `desktop-continuous` only.
- No direct SQLite fixture injection for PERF02.
- No separate mobile replayable or remote-host runtime is created.
- Four-pane layout uses existing v4 pane split behavior and the `MAX_WORKBENCH_PANES = 4` boundary.
- Provider traffic is synthetic replay; the goal is deterministic communication pressure, not live model quality.
