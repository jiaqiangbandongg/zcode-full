# Dynamic Workflow (spec)

Status: implemented. This document is the entry point to the feature: what it is, the
pieces it is made of, how a workflow moves through them, and the words and principles
every component shares. Seven component documents, listed under "The pieces", own the
details; this one points at them and repeats as little as it can.

## What it is and why it exists

A dynamic workflow lets the main agent direct many subagents by **writing a program**
instead of a conversation. The model writes an ordinary TypeScript script against a small
facade: `agent()` creates a subagent, `.ask<T>()` gives it a task and returns a typed
result, `files.*`, `git.*` and `world.run` read and probe the workspace, `report` streams
findings, `artifact.*` publishes deliverables, `phase()` names a stage, `log` narrates.
Everything else is plain TypeScript: `await`, `Promise.all`, `for`, `while`, `if`,
`try/catch`, helper functions, `.map`.

The harness, not the model, supplies the rigor. From that one script it recovers:

| Recovered | How |
|---|---|
| types | the script is typechecked by the TypeScript compiler against the facade's `.d.ts` |
| schemas | every `ask<T>` gets a JSON schema synthesized from `T`; the subagent's answer is validated against it |
| the dependency graph | a static analysis reads the script once and draws who feeds whom, what runs after what, and where control can go |
| identity | every facade call is a **site** with a stable id; every execution of it is an **instance** |
| durability | every instance is journaled; a run resumes by running the same script again with the journal answering for what already happened |

Two kinds of task gain the most. The first is wide, structured work: "find the bugs in
every TypeScript file" is one `files.glob` and one `.map` over it, where the conversational
alternative is a glob, a long list, and one hand-launched subagent per file. The second is a
fixed procedure the model must not drift from: a Programmer and a Prover alternate until a
proof is accepted or a round limit is hit, and that rule is code, not a sentence in a
prompt.

```ts
const programmer = agent("Programmer", { system: "You are a Lean 4 engineer…" });
const prover = agent("Prover", { system: "You are a Lean 4 verification expert…" });

phase("Implement");
let impl = await programmer.ask<ImplUpdate>(`Implement compress / decompress in ${IMPL_PATH}.`);
phase("Verify");
let verdict = await prover.ask<Verdict>(`Prove or refute ${THEOREM}. Notes: ${impl.notes}`);

let round = 1;
while (!verdict.pass && round < MAX_ROUNDS) {
  round += 1;
  impl = await programmer.ask<ImplUpdate>(`Rejected: ${verdict.reason}. Fix ${IMPL_PATH}.`);
  verdict = await prover.ask<Verdict>(`The implementation changed (${impl.notes}). Re-verify.`);
}
return { proved: verdict.pass, rounds: round, verdict };
```

The two subagents keep their own memory across rounds because the script holds one
reference to each; `agent()` called inside the loop would make a fresh subagent every
round. The `while` is a loop the analyzer sees, the user sees as a back arrow on the
confirmation graph, and the journal replays.

The feature is independent of the older `Workflow` tool and its `.workflow.js` scripts,
which still exist under the same word; the model-facing tool here is `CreateWorkflow`.

## The pieces

**Authoring.** The facade is one `.d.ts` string the compiler is fed and the tool
descriptions embed, so what the model reads and what typechecks cannot drift apart. The
`/workflow <instructions>` command loads the `dynamic-workflows` skill, which carries the
judgment: how to choose a topology, when a result deserves a verification step, what to do
after submitting. Prompts tell each subagent what a workflow is, that its ask has a typed
answer to submit, and that it writes for the user. The same document owns `world.run`, the
artifact channel and `EvalWorkflowSnippet`, a scratch tool that runs a script fragment
through the real compiler and sandbox with no subagents.

**Analysis.** Before anything runs, the analyzer compiles the script, collects its sites,
runs the authoring checks, and interprets the script once to produce a single **analysis
core**. From the core it projects four graphs: the site graph (what feeds what), the
causality graph (what runs after what, and why), the control-flow graph (where execution
can go) and the hand-off graph (who hands work to whom in each phase). Imprecision widens
an edge set; only one rule, that a facade call must be a direct call, rejects a script.

**Launch.** `CreateWorkflow` takes an inline script or a saved workflow by name, compiles
it, and raises the confirmation window in every permission mode. The window shows the
name, the phase timeline and the collapsed script, and offers Allow, Always allow in this
session, Deny and Refine (deny with feedback the model reads). Saved workflows are
`<name>.dwf.ts` files in a project or global directory, listed by `ListSavedWorkflows`,
written by `SaveWorkflow`, and shown on the hub page, where 「运行」 (Run) starts one in a new
session with no model turn. `ListWorkflowRuns` and `GetWorkflowRun` let the model look at
runs; the CLI and TUI have their own card and `/dwf`.

**The engine.** Lowering turns the accepted script into a JavaScript function body whose
facade calls carry their site ids. A child process runs it in a `vm` cell and speaks to the
harness over a wire protocol; the harness calls the pure engine core, which owns state and
decisions and does no I/O except through the journal. The driver behind it opens a session
per subagent, dispatches asks, records every instance as a journal row and every event as
a journal line, and ends the run `completed`, `errored` or `stopped`. Resume replays;
amend (`AmendWorkflow`) starts a new run seeded with a predecessor's results, stopping the
predecessor first if it is still running; `escalate`
lets a subagent ask the main agent a question.

**Concurrency.** A run has a fixed bound on asks in flight, and every model request in the
process passes through a shared governor that learns the provider's real limit from its
refusals and adapts. Transient model errors are retried inside the run without limit;
deterministic ones stop the run as `stopped(provider)`.

**Presentation.** The GUI never sees the analyzer's graphs. A bounding layer folds them
into one display payload, and one pure function builds a horizontal timeline from it:
phases as stations, subagents as pills, skips and loops as arcs. The same timeline is drawn
in the tool row while the model writes, in the confirmation window, live under the turn as
the run card, and vertically in the run pane as a spine.

**Transcript and notifications.** The main agent learns about a run through
`<task-notification>` texts; the GUI draws the structured payload minted with each one.
A completed run's digest ends in a completion card: artifact tiles and four engine-counted
figures. A per-run side tab replays the script's own steps as tool cards, and every
subagent transcript ends in a folded engine epilogue.

| Document | Scope |
|---|---|
| `docs/dynamic-workflow/authoring.md` | the facade, `/workflow` and the skill, subagent prompts, compile-time rules, artifacts, `world.run`, the snippet tool, usage accounting |
| `apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md` | sites, diagnostics, the interpreter, the four graphs, joining runtime instances |
| `docs/dynamic-workflow/launch.md` | `CreateWorkflow`, the confirmation window, saved workflows and scopes, the hub page, direct launch, CLI/TUI, run introspection tools |
| `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md` | lowering, the sandbox, the engine core, ask lifecycle, the journal, resume, amend, terminal states, escalation, the fault-matrix test bed |
| `docs/dynamic-workflow/concurrency.md` | the two bounds, request tickets, the adaptive controller, the model-error policy, tool-side requests |
| `docs/dynamic-workflow/presentation.md` | the display contract, the timeline model, the live overlay, the run card and run pane |
| `docs/dynamic-workflow/transcript-and-notifications.md` | notifications, the completion card, the script transcript, the epilogue fold |

## The life of a workflow

1. **The user opts in.** The model calls `CreateWorkflow` only when the user asked for a
   workflow: through `/workflow <instructions>`, in their own words, or by naming a saved
   one. The command loads the skill; the model settles the topology, then writes the
   script. `EvalWorkflowSnippet` can try a `files.*` or `world.run` fragment first.
2. **Compile and analyze.** The tool compiles the script and runs the analyzer. A script
   with diagnostics never reaches the user: the model gets `L{line}:C{column} {message}`
   lines and resubmits. A clean script yields the display payload.
3. **Confirm.** The confirmation window appears in every permission mode with the phase
   timeline and the script. Allow runs once; Always allow stops asking for this tool in
   this session; Deny refuses; Refine refuses with feedback. An amendment of a run this
   session started skips the window. 「运行」 on the hub page is its own consent.
4. **Run.** The tool returns the run id at once; the main agent goes on with its turn. The
   sandbox executes the script; each `ask` becomes a subagent session turn, queued FIFO on
   its subagent and admitted under the run's bound and the governor's shared cap; each
   world read runs in the harness. Every instance and event is journaled before anyone
   sees it. The run card's lamps and pills follow the events; the run pane shows the same
   run as a spine with subagent transcripts one click away.
5. **Questions.** A blocked subagent calls `escalate`; the main agent receives a question
   notification and answers with `ResolveWorkflowQuestion`. The subagent waits, without
   timeout, until then.
6. **End.** The script returns (`completed`), throws (`errored`), or something outside
   it ends the run (`stopped`: the user, the main agent, the provider, or an interrupted
   process). In-flight asks are aborted, the subagent sessions are closed, and a
   notification carries the result, the reported items and the published artifacts,
   including for runs that did not complete.
7. **After.** The main agent digests the notification; a completed run ends that reply
   with the completion card. A stopped run resumes with `ResumeWorkflowRun` or the run
   pane's Resume, under the byte-identical script; a revised script goes through
   `AmendWorkflow`, a new run that imports the finished work as a cache and, when the
   predecessor is still running, stops it first. A change of settings alone (concurrency,
   subagent model, name) goes through the same tool with the script left out. A workflow worth keeping is
   saved with `SaveWorkflow` and appears on the hub page, where the user runs it again
   without the model.

## Vocabulary

Prose uses these words in every component document and in the GUI. Code identifiers,
protocol fields, event names and site ids keep their older spellings where the table says
so.

| Word | Meaning | In code / Chinese UI |
|---|---|---|
| **workflow** | the thing the model writes and the user approves: one script and its name | 工作流 |
| **script** | the TypeScript source; also the timeline lane for the steps the script runs itself (`files.*`, `git.*`, `world.run`) | lane id `workspace`; pill 「脚本」, tab 「脚本步骤」 (Script steps) |
| **site** | one facade call in the script, the unit of identity: `ask#3`, `actor#1`, `world-read#2`, `report#1`, `artifact#1` | `siteId` |
| **instance** | one execution of a site, `siteId@ordinal` | `{siteId, ordinal}`; a journal **node** |
| **step** | an `ask` or world-read site as the graphs draw it | `Step` |
| **subagent** | the session behind an `agent()` value; it keeps its transcript across asks and answers them one at a time | identifiers `actor*`, `actor#N`, `actor-created`; 子代理. The generic Agent tool's 子智能体 is a different thing |
| **ask** | one `.ask()` instance: a message to a subagent and the typed result it settles with. Script and engine vocabulary only; every user surface calls it a **task** (任务), so that **question** (问题) stays reserved for an escalation | `ask#N`; display "{n} tasks" / 「{n} 个任务」 |
| **run** | one execution of one script under one run id | `dwfrun-<uuid>`; noun 实例 (工作流实例, N 个实例), verbs stay 运行 (停止运行, 恢复运行) |
| **phase** | a named stage the script declares with `phase("…")`; a station on the timeline | 阶段 |
| **artifact** | on the facade and every user surface: what the script publishes for the user to keep (`artifact.file`, `.markdown`, or a `chart`/`table`/`metrics`/`board` fed by tagged `report` items). At most one is the **primary**, the deliverable the surfaces lead with (`primary: true`; a lone artifact counts). In engine identifiers only: a site's typed output or the script's return value | 产物; the primary is never labelled in the UI |
| **saved workflow** | a `<name>.dwf.ts` file: a `/* zcode-workflow */` metadata block, then the script | 已保存的工作流 |
| **scope** | where a saved workflow lives: `project` (`<cwd>/.zcode/workflows/`) or `global` (`~/.zcode/workflows/`); a project workflow hides a global one of the same name | 「项目」 / 「全局」 |
| **world read** | a journaled call into the workspace: `files.*`, `git.*`, `world.run` | `world-read#N` |
| **journal** | the durable record of a run: run, subagents, nodes, events | `dwf_run`, `dwf_actor`, `dwf_node`, `dwf_event` |
| **question** | a subagent's `escalate` call waiting for the main agent | `dwfq-…`; 询问主代理 |

## Principles that hold across components

**Recover rigor rather than demand it.** The model writes the most natural program it
can; types, schemas, edges, identity and durability are derived from it. Where something
cannot be recovered, a compile-time diagnostic names what to change; the facade is never
narrowed to make analysis easier.

**Imprecision widens and never rejects.** An edge the analysis cannot prove exact is still
drawn. The one hard rule is that a facade call must be a direct call, because a call
reached through an escaped function value has no site and therefore no identity.

**The static graph is complete before any node runs.** Nothing is learned from
execution; a run only decorates the picture, joined to it by site id. The confirmation
window therefore shows the whole shape of what will happen.

**The journal is the truth.** Every node and event is written before it is shown. Resume
is the same script run again against the journal; the transcript, the completion card and
every notification are built from engine records, never from what the model said about
them.

**Plain semantics, no hidden retries for logic.** `Node<T>` is a thenable, so waiting is
`await`, a join is `Promise.all`, and not awaiting is concurrency. A failed ask rejects its
promise and the script decides; a retry loop is code and appears in the graph. Only
provider transients are retried invisibly, and only inside the run.

**Caps fail loudly.** A world read over its cap rejects that node
(`WorldReadCapExceeded`); a run over the report caps fails (`ReportCapExceeded`). Nothing is
truncated, because a silently partial view of the workspace fanned out over is worse than a
failure the script can catch.

**Cancellation and confirmation are the controls.** The harness enforces no token budget
and no node cap and the script can read neither; token usage is accounted as an
observation. The user approves the script once, in the window; there is no prompt inside a
run.

**One arrow style.** Every ordering on screen is one kind of arrow; the analyzer's typed
reduction decides which arrows survive, and rendering carries no kinds.

**Write for the user.** Subagent names, phase names, `log` lines, reports and artifacts
are read by the person, in the session's language; the model is taught to name and write
accordingly.

## Alternatives not taken

- **A step or loop DSL** (`step()`, `task()`, `.then` chains, a fan-out helper): plain
  `await`, `Promise.all`, `for` and `.map` are recognized statically, so the DSL would only
  add ceremony.
- **Get-or-create subagents by name**: two parallel branches would silently converge on
  one serialized context with no shared variable to show it. Every `agent()` is a fresh
  subagent; sharing a subagent is sharing a reference.
- **A persistent REPL as the venue**: a one-shot script submitted through a tool call is
  what can be typechecked, drawn, confirmed and replayed as a whole.
- **A token budget and a node cap**: no caller ever set a budget, the cap fenced in normal
  large fan-outs, and a script optimising against a limit is worse than a person cancelling.
- **Model tier and tool profile on the persona**: every subagent runs on the parent
  session's model with the regular working tools; what it may do is said in the ask.
- **Runtime tracing as a dependency source**: the static graph is complete before the run;
  a graph that grew while running could not be confirmed.
- **Reusing the legacy `Workflow` / expert-workflow machinery**: fresh contracts and a
  fresh UI surface, so neither feature constrains the other.

## Open questions

Each component document ends with its own. Two cross-cutting ones remain:

- Whether a run interrupted by a process exit should resume on its own when the owning
  session returns, rather than waiting for the user or the model.
- Guidance for large values in prompts: when a script should interpolate
  `JSON.stringify(bigThing)` and when it should hand subagents a path instead.
