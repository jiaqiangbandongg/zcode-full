# @zcode/dynamic-workflow

Self-contained library for the dynamic workflow feature: the TypeScript facade the
main agent writes scripts against, and the compiler that recovers rigor from those
scripts (typecheck, schema synthesis, dependency inference, site identity).

**Spec / decision record:** `docs/dynamic-workflow.md` in the z-code app repo is the
entry point. The facade, compiler options and authoring rules are decided in
`docs/dynamic-workflow/authoring.md`; the analysis and the engine in this package's
`docs/`. This package implements the spec; amend the spec first when behaviour changes.

## Boundaries

- This package is **pure**: no session spawning, no storage, no disk or network
  I/O (the TS stdlib is embedded, not read from disk — see "Embedded libs"). It
  never imports from `@zcode/core` or `@zcode/bootstrap`.
- The runtime layer binds to this package through a narrow driver interface. The
  sandbox harness (child process + vm cell + NDJSON host bridge) lives in the
  sibling package `@zcode/dynamic-workflow-runtime` — impure (node builtins) but
  still app-independent. The production driver (actor sessions, SQLite journal,
  tool wiring) lives in `@zcode/bootstrap`, evolving the existing
  `script-workflow-*` substrate. Phasing: `docs/execution-engine.md`.

## Layout

```
docs/
  analysis.md             spec for the static analysis: site table, diagnostics,
                          the taint fixpoint + temporal walk, and the four graphs
                          (site, causality, control-flow, hand-off) projected from
                          the analysis core (supersedes the parent spec's
                          graph-model/dependency-inference sections)
  execution-engine.md     spec for the execution engine: lowering + sandbox, host
                          API, pure engine core / driver port split, ask lifecycle,
                          journal + resume, terminal states, amend-resume,
                          escalation, and the fault-matrix test bed
src/
  facade/dts.ts       facade .d.ts as an embedded string asset (FACADE_DTS) —
                      the single source of truth for the model-facing API
  compiler/compile.ts virtual-host typecheck of a script against the facade;
                      exposes createWorkflowProgram (typed Program + script source +
                      prelude-stripped location mapper) as the shared substrate
  analysis/types.ts   site-graph types (SiteGraph/SiteNode/SiteEdge/ActorSite)
  analysis/sites.ts   the site table — one checker-driven walk collecting ask /
                      actor / world-read / join sites, iteration (fan-out) candidates
                      and top-level returns, keeping raw ts.Node references
  analysis/analyze.ts analyzeWorkflowScript: the pipeline (typecheck -> collectSites ->
                      diagnostics -> interpret -> four projections)
  analysis/facade-misuse.ts, world-run.ts, phases.ts, actor-names.ts, artifacts.ts
                      the authoring diagnostics (9001, 9003-9006, artifact rules)
  analysis/interpret.ts  the fused interpreter: taint fixpoint, then one temporal walk,
                      then minting the AnalysisCore (core.ts; JSON form in core-json.ts)
  analysis/domain.ts  taint abstract domain (AbstractValue) + pure value algebra
  analysis/state.ts   taint fixpoint storage, update primitives, fact + oracle emission
  analysis/taint.ts   taint evaluator (statements/expressions) + fixpoint driver;
                      calls.ts, promise-ops.ts, array-methods.ts, heap-ops.ts,
                      classes.ts, assign.ts, patterns.ts, literals.ts, relays.ts,
                      control-flow.ts are its transfer rules split by construct
  analysis/callbacks.ts  the callback registry: what a library callee does with the
                      script functions it is handed (each / once, entered, deferred)
  analysis/causality-order*.ts  the temporal walk: issue/settle/mark/jump events and
                      the region tree, inlining bodies per the call oracle
  analysis/artifact-types.ts  producer-side artifact types (checker typeToString)
  analysis/graph.ts   site-graph projection (data/context edges, source completion,
                      relay pruning)
  analysis/causality-graph*.ts, causality-reduce.ts, phase-graph.ts
                      causality projection: facts, typed transitive reduction,
                      may-set lane expansion, phase copies + phase quotient
  analysis/flow-graph.ts, flow-phase.ts  control-flow projection + its phase quotient
  analysis/handoff-graph.ts, fanout-cardinality.ts  hand-off projection
  analysis/actor-graph.ts  derived actor-graph digest (toActorGraph), not drawn
  analysis/mermaid.ts, serialize.ts  mermaid emitters and canonical text forms for
                      every graph and the core (the golden surfaces)
  schema/             ask<T> → JSON Schema emitter (checker-driven, JSDoc constraint
                      harvest, positioned rejection diagnostics) + subset validator
                      (violations as path/expected/got, model-legible for repair)
  engine/             pure execution-engine core: boundary types (host API / driver
                      port / journal port), WorkflowEngine + AskScheduler (ordinals,
                      journal replay + hold rule, repair/nudge, usage accounting),
                      in-memory JournalStorePort
  lowering/           emit step: type-strip + site-id instrumentation of facade
                      calls onto __host — the sandbox input (consumed by the
                      sibling runtime package)
  index.ts            public exports
scripts/
  generate-libs.mjs   embeds the TS stdlib closure into src/compiler/libs.generated.ts
  generate-mermaid.mjs renders every graph fixture to charts/<name>.md (`pnpm charts`)
charts/               generated mermaid pages (one per graph fixture) — gitignored
tests/
  workflows/          fixture workflow scripts for the compiler suite (see below)
  graphs/             fixture scripts for the site-graph suite; expected/*.txt are
                      the serialized-graph snapshots
  helpers/markers.ts  `// error` marker parsing + strict diff
  *.test.ts           fixture runners + API-shape/unit tests
```

## Fixture tests (`tests/workflows/`)

Every `tests/workflows/*.ts` file is compiled by the fixture suite. Expectations
live in the fixture itself, Dotty-neg-test style:

- A trailing `// error` marker expects one diagnostic on that line; repeat the
  marker for multiple (`// error // error` = two).
- Matching is strict and bidirectional: every marker must be hit, and every
  emitted diagnostic must be covered by a marker (line-level).
- A file with no markers must compile clean.

To add a compiler test, drop a new fixture file in the directory — no test code
changes needed. Fixtures are excluded from oxlint (many are intentionally
invalid) and from tsc (tsconfig covers `src/` only); the fixture suite is their
only checker.

## Site-graph tests (`tests/graphs/`)

Every `tests/graphs/*.ts` file must typecheck clean; the suite serializes its site
graph and snapshots it under `tests/graphs/expected/<name>.txt` (via vitest's async
`toMatchFileSnapshot`), plus the derived actor-graph projection as
`<name>.actor.txt`. A representative subset also snapshots the mermaid renderings as
`<name>.site.mmd` / `<name>.actor.mmd`. Regenerate with `pnpm test -- -u`, then
review the diffs by hand — the snapshots are the human-readable contract for the
analyzer. These fixtures are excluded from oxlint like `tests/workflows/`.

## Develop

All commands from this directory (or with `--filter @zcode/dynamic-workflow` from
either workspace root):

```sh
pnpm test         # vitest run tests
pnpm test -- -w   # watch mode while developing
pnpm typecheck    # tsc --noEmit
pnpm build        # tsc -> dist/ (declaration + maps)
pnpm charts       # build + render graph fixtures to charts/*.md (mermaid)
pnpm lint         # oxlint src tests
```

There is no dev server and no process to run: the package is a pure function
library, so the dev loop is test-driven — add a script fixture, assert on
diagnostics/schemas/graph output, implement until green.

## Compile pipeline notes

- Scripts are wrapped in an async function body before typechecking (mirrors the
  runtime `AsyncFunction` execution shape): top-level `await` and a final
  `return <artifact>` are legal; `import` is not.
- `types: []` and `lib: ES2022` only — `process`, `fetch`, `require` fail
  typechecking, so the purity contract starts at compile time.
- **Embedded libs:** the compiler host is fully virtual — no disk access. The TS
  stdlib `.d.ts` closure (`lib.es2022.d.ts` and its `/// <reference lib>` chain)
  is embedded into `src/compiler/libs.generated.ts` by `scripts/generate-libs.mjs`.
  That file is gitignored and regenerated automatically whenever the installed
  `typescript` version changes (the generator is chained into `build`,
  `typecheck`, `test`, and `coverage`; it exits fast when already current). This
  keeps dev and the bundled/SEA CLI identical: with no fallback to disk, a missing
  lib fails package tests too.

## Roadmap (step by step)

1. ~~Scaffold: facade + virtual-host typecheck~~ (done)
2. ~~Schema synthesis: JSON Schema from `ask<T>` type arguments + JSDoc harvest,
   non-serializable rejection diagnostics~~ (done; `src/schema/`)
3. Site identity: structural AST-path hashes for ask/world-read/join/fan-out
   sites — deferred; layers onto the existing site table later without changing
   the graph shape (v1 ships per-kind source-order ordinal ids, `ask#1` etc.).
   **Its motivation is gone (2026-08-31).** The one thing this step was for was
   resume-after-edit, and amend-resume shipped that without it: cache identity for
   an ask is (actor name, per-actor ask sequence) checked against the recorded
   `inputHash`, and for a world node it is `{op, args}` content plus occurrence
   index — neither is positional. Site ids stay display/graph coordinates. Step 3
   survives only if world nodes ever need a *positional* identity of their own;
   nothing asks for that today. See `docs/execution-engine.md` in the
   app repo.
4. ~~Analysis: taint-based may-flow site graph, then the causality, control-flow and
   hand-off projections~~ (done; `docs/analysis.md` is the whole story).
5. ~~Journal contracts + replay semantics (pure state machine, in-memory journal,
   fake driver tests)~~ (done; `src/engine/`; see `docs/execution-engine.md`)
6. ~~Lowering: type-strip + site-id instrumentation emit step~~ (done; `src/lowering/`)
7. ~~Sandbox harness in sibling `@zcode/dynamic-workflow-runtime`: child process +
   vm cell + NDJSON host bridge, end-to-end fixture runs against a fake driver~~
   (done; outside this package but still app-free)
8. ~~Real-runtime binding (outside this package): `submit_result` in `@zcode/core` +
   the `AgentRuntime` driver in `@zcode/bootstrap`~~ (done; `docs/execution-engine.md`,
   "The driver (Boundary B)")
9. ~~Storage + app surfaces (outside this package): `dwf_*` SQLite journal passing
   the contract suite, `CreateWorkflow` submit path, notification/status wiring~~
   (done; `docs/execution-engine.md` "The journal", `docs/dynamic-workflow/launch.md`,
   `docs/dynamic-workflow/transcript-and-notifications.md`)
