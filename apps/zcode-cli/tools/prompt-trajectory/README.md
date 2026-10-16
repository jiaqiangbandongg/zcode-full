# @zcode/prompt-trajectory

Test-only OpenAI protocol trajectory recorder for zcode-cli prompt assembly checks.

This tool lives under `tools/` so it is available in the pnpm workspace but stays out of
the production CLI and SEA packaging path.

## Commands

```bash
pnpm --filter @zcode/bootstrap^... build
pnpm --filter @zcode/bootstrap build

pnpm --filter @zcode/prompt-trajectory record -- \
  --fixture fixtures/prompt/basic-live.json \
  --out /tmp/zcode-prompt-trajectory/basic-live

pnpm --filter @zcode/prompt-trajectory record:prompt -- \
  --prompt "Say hello in one short sentence."

pnpm --filter @zcode/prompt-trajectory run:testcases -- \
  --cases testcases

pnpm --filter @zcode/prompt-trajectory derive -- \
  --out /tmp/zcode-prompt-trajectory/basic-live

pnpm --filter @zcode/prompt-trajectory model-io -- \
  --input ~/.zcode/cli/debug/model-io-<session>.jsonl \
  --out /tmp/zcode-prompt-trajectory/model-io-session
```

`record` writes `/out/trajectory.jsonl` while proxying provider requests, then
derives complete request-body snapshots under `/out/trajectories`.

`trajectory.jsonl` is the single source of truth. Streaming deltas are assembled
into a single assistant message before they are appended to the JSONL file.

When `--model`, `--upstream-base-url`, and API-key flags are omitted, the recorder
uses the same zcode model config resolution as the CLI. The upstream request is
still proxied through the recorder; only the model provider `baseURL` is replaced
with the local proxy URL at runtime.

## Testcase Runner

`run:testcases` scans the testcase directory one child folder at a time. A case is
valid when it contains both files:

```text
testcases/<case-name>/prompt.txt
testcases/<case-name>/expect.json
```

Each run writes a timestamped output directory:

```text
out/testYYYYMMDD-HHMMSS/<case-name>/trajectory.jsonl
out/testYYYYMMDD-HHMMSS/<case-name>/manifest.json
out/testYYYYMMDD-HHMMSS/<case-name>/trajectories/*.openai_request_body.json
out/testYYYYMMDD-HHMMSS/<case-name>/trajectories/*.anthropic_request_body.json
out/testYYYYMMDD-HHMMSS/<case-name>/expect.json
```

The runner does not compare `expect.json` yet; it records and derives the
trajectory so the generated OpenAI request-body JSON can be inspected manually.

Single prompt recording without `--out` writes to:

```text
out/promptYYYYMMDD-HHMMSS/trajectory.jsonl
out/promptYYYYMMDD-HHMMSS/trajectories/*.openai_request_body.json
out/promptYYYYMMDD-HHMMSS/trajectories/*.anthropic_request_body.json
```

The OpenAI-compatible snapshot keeps the legacy comparison format. The Anthropic
snapshot projects the same trajectory into Anthropic request-body shape: system
content is emitted through top-level `system`, and adjacent `user` messages are
merged into a single Anthropic `content[]` run. If the recorder captured a real
Anthropic request, the derived Anthropic snapshot preserves that provider-level
shape.

## Model-IO Converter

`model-io` reads a real ZCode `model-io-*.jsonl` file and turns the main
conversation into a reusable Anthropic trajectory:

```text
out/<run>/anthropic_trajectory.json
out/<run>/manifest.json
out/<run>/trajectories/*.openai_request_body.json
out/<run>/trajectories/*.anthropic_request_body.json
```

The converter expands model-io delta records before filtering. By default it
keeps only `querySource: "main_turn"` and excludes sidecar calls such as
`session_title`. It also applies the request compatibility projection that runs
after model-io capture, so the generated Anthropic trajectory reflects the final
provider-visible wire shape. Use `--query-source <value>` to inspect a different
source.

Continuity compares recorded request history, ignoring only `cache_control` drift.
When the next request contains the previous response with additional thinking blocks,
the converter preserves that complete assistant message after verifying its text and
tool calls against the response summary. Appending blocks to the final user message
also remains in the same trajectory. Rewriting existing content still starts a new
segment. `non-incremental-change` is not a provider cache-miss indicator.
