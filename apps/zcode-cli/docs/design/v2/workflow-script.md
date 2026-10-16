# Script Workflow Runtime

## Goal

`/workflow` will let users create and run deterministic workflow scripts that orchestrate child
agent sessions through a small built-in DSL:

- `agent(prompt, opts)`
- `parallel(thunks)`
- `pipeline(items, ...stages)`
- `phase(title)`
- `log(message)`
- `workflow(nameOrRef, args)`
- `args`
- `budget`

The script format follows `workflow.md`. A workflow script exports `meta` and then runs body code in
an async module context:

```ts
export const meta = {
  name: "review-changes",
  description: "Review changed files and verify findings",
  phases: [{ title: "Review" }, { title: "Verify" }],
};

phase("Review");
const findings = await agent("Review the current diff for bugs.", {
  label: "review:diff",
  schema: FINDINGS_SCHEMA,
});
return findings;
```

## First Implementation Scope

The first implementation intentionally avoids a full static parser and avoids promising sandbox
security. It uses:

1. A lightweight text extractor for `export const meta = ...`.
2. A short-lived child process to evaluate only the extracted meta expression.
3. Runtime `zod` validation for meta, `agent()` args, and other injected DSL calls.
4. A separate workflow runner child process for script execution.
5. Parent-process scheduling, persistence, policy checks, statistics, cancellation, and resume.

This keeps the user-facing format aligned with `workflow.md` while still letting the CLI collect
workflow names, descriptions, phases, and model hints before a run starts.

## Script Storage

Named user workflow scripts are stored by scope:

- Project scope: `<workspace>/.zcode/workflows/<name>.workflow.js`
- User scope: `~/.zcode/workflows/<name>.workflow.js`
- Built-in scope: packaged definitions that are loaded only from an allowlist

The default for authored scripts is project scope because scripts usually depend on the current
repository layout, test commands, and conventions. Global user scope is for reusable personal
templates that should be callable by name across projects.

Lookup priority is:

1. Explicit `scriptPath`
2. Project `.zcode/workflows`
3. User `~/.zcode/workflows`
4. Built-in allowlist

Every run records the resolved script path, script hash, source scope, and validated meta in SQLite.
The DB is the durable run/status index; the script file is the editable source of truth.

Inline `Workflow` tool invocations persist the supplied script under a session-scoped storage
directory before launch and return that path in the tool result. The returned path is the edit point
for iteration: edit it with file tools and re-invoke `Workflow` with `scriptPath`.

## Meta Extraction

The runtime does not parse the whole module AST in V1. It scans the script text for:

```ts
export const meta =
```

Then it extracts the following object expression with balanced braces, preserving quoted strings and
comments well enough for normal JS object literals. The extracted expression is evaluated in a
dedicated child process and validated with `WorkflowScriptMetaSchema`.

Limitations are explicit:

- `meta` must be near the top of the file.
- `meta` must be an object expression.
- If extraction or validation fails, the workflow cannot be listed or started.
- Runtime DSL calls are still validated independently; meta is not trusted as an execution policy.

## Process Boundary

Workflow scripts run in a child process. The child process receives only RPC stubs:

```ts
globalThis.agent = (...args) => rpc("agent", args);
globalThis.phase = (title) => rpc("phase", [title]);
globalThis.log = (message) => rpc("log", [message]);
globalThis.parallel = workflowParallel;
globalThis.pipeline = workflowPipeline;
```

The child process does not create sessions, run tools, or write durable state. The parent process
owns scheduling, validation, policy, session creation, event emission, and persistence.

This is process isolation, not a security sandbox. Node `vm` is not used as a trust boundary. User
workflow scripts should be treated as local user code with a narrow RPC surface.

## Agent Call Contract

V1 `agent()` input:

```ts
agent(prompt: string, opts?: {
  label?: string;
  phase?: string;
  schema?: JsonSchema;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
  tools?: string[];
  skills?: string[];
  instructions?: string;
  systemPrompt?: string;
  maxTurns?: number;
  timeoutMs?: number;
})
```

The schema accepts these fields, but policy decides which fields are allowed for a given workflow:

- User workflows default to no custom `systemPrompt`, no nested subagents, and tool/skill/model
  values must pass a whitelist.
- Trusted built-in workflows may opt into custom system prompts, wider tool sets, nested subagents,
  and deeper task trees.
- All agent calls are validated in the parent process before dispatch.

## Session And Task Tree

Workflow is a task state machine. A session is one execution attempt inside that task tree.

The session table gets a coarse `task_type` so normal session lists can hide workflow-generated
sessions by default:

- `interactive`
- `fork`
- `workflow_parent`
- `workflow_child`
- `subagent_child`
- `nested_workflow_child`

Detailed workflow relationships live in workflow tables, not in `session.parent_id`. `parent_id`
remains compatible with existing fork/session lineage behavior.

The persistence model must support arbitrary future nesting even if V1 policy blocks user workflow
children from spawning subagents:

```text
workflow_run
  workflow_activity
    session_task_link
      child session
        session_task_link
          grandchild session
```

Each link records `root_workflow_run_id`, parent link id, parent session id, child session id, depth,
role, phase, label, model, and activity id.

## Resume

Workflow resume does not revive the old runner process. It starts a fresh runner and replays the
script from the beginning.

Each dispatchable call gets a deterministic `callIndex`, `callPath`, and `inputHash`. Before
starting a new child session, the parent scheduler checks `workflow_activity`:

- Completed activity with matching input hash: return cached result immediately.
- Running activity from a dead process: mark lost/cancelled and create a new attempt.
- Failed activity: follow retry policy or pause.
- New or changed activity: dispatch live.

This supports loops as long as the loop condition and agent inputs are deterministic across resume.
Runaway loops are bounded by max agent calls, token budget, wall-clock timeout, and child process
watchdog.

## Failure Rules

- A direct `await agent()` failure throws into the script.
- `parallel()` catches individual thunk failures and returns `null` for that branch.
- `pipeline()` turns a failed item into `null` and skips remaining stages for that item.
- Uncaught script failure pauses the workflow with structured failure metadata.
- Cancellation is terminal and aborts the runner plus any active child activities.
- Retrying creates a new activity attempt and preserves failed session links for audit.

## Statistics

Workflow status should expose:

- agent calls: total, queued, running, completed, failed, cancelled, cached
- tool calls: total and by tool name
- model requests
- tokens: input, output, reasoning, cache read/write, total
- phase durations and run duration
- permission requests and denials
- budget total/spent/remaining

Stats may be stored as JSON in `workflow_run.stats_json` and recalculated from events when needed.

## Command Surface

**Removed (2026-08-22, `docs/dynamic-workflow/launch.md`).** The `/workflow` and `/workflows`
slash commands and the TUI workflows panel they opened are gone. The commands below are recorded for
history only — none of them parse today.

- ~~`/workflow create|validate|run|resume|stop`~~ and ~~`/workflows [runId]`~~.

The script-workflow runtime itself is unchanged and still reachable: the model-facing `Workflow`
tool is the launch surface (see «Built-in Workflow Tool» below), and `WorkflowPort` plus the
`workflow_*` tables are untouched. Desktop keeps its own workflow surface via the app capabilities.
The `/dwf` command that replaced the namespace serves the **dynamic** workflow system, which is a
different runtime — see `docs/dynamic-workflow/launch.md`.

## Natural Language Creation

**The `/workflow create` command was removed with the rest of the namespace** (see «Command
Surface»). The authoring *rules* below still hold — they are what the `Workflow` tool's description
in `workflow.md` carries, and what any agent writing a script must respect. Read the command framing
in this section as history.

`/workflow create <task description>` was a script authoring command, not a separate generator
runtime. The command wrapped the request into a normal agent turn so the agent could inspect the
project with read-only tools, write the final script with file tools, and use the built-in
`Workflow` tool when the user explicitly asked to launch or resume a run.

Default output path:

```text
<workspace>/.zcode/workflows/<generated-name>.workflow.js
```

Command rules:

- The generated script must keep the `workflow.md` format and begin with `export const meta = {...}`.
- The command prompt directs the agent to use project inspection tools before authoring when useful.
- The default destination is project scope. `--user` changes the requested destination to
  `~/.zcode/workflows`.
- `--name <name>` requests a concrete file/meta name; otherwise the agent chooses a concise
  kebab-case name from the task.
- Existing files should not be overwritten unless `--overwrite` is present.
- The agent should write the script to disk with normal file tools, then report the path. (It used
  to point at `/workflow validate` / `/workflow run`; those commands no longer exist — launching now
  goes through the `Workflow` tool with `scriptPath`.)
- `create` itself does not force yolo mode and does not start workflow child sessions.

Authoring prompt constraints:

- Use only the injected DSL: `agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow`, `args`, and
  `budget`.
- Do not use imports, direct filesystem/process/network APIs, random values, timestamps, or ambient
  Node globals.
- Prefer simple `pipeline` and `parallel` structures over custom scheduler code.
- Keep loops deterministic and bounded; no unbounded `while` loops.
- Do not set custom `systemPrompt`, `tools`, `skills`, or `model` unless the user explicitly asks for
  them. The runtime still validates and policy-gates these options before dispatch.
- Child workflow agent sessions run with `subagents.enabled = false` in V1, so generated scripts
  should not assume child agents can create further subagents.
- If the user asks to launch the workflow, call the built-in `Workflow` tool with `scriptPath`,
  `script`, `name`, `args`, or `resumeFromRunId` according to its schema. Otherwise, do not call
  `Workflow` for authoring-only requests.

TODO: add the model-facing workflow creation tool schema after the CLI creation flow stabilizes. The
launch tool schema is intentionally separate from the authoring command.

## Built-in Workflow Tool

The built-in `Workflow` tool is the model-facing launch surface for the same runtime. Its
description is derived from `workflow.md` and must preserve the explicit opt-in rule: the model may
only call it when the user requests workflow or multi-agent orchestration.

Input schema:

```json
{
  "type": "object",
  "properties": {
    "script": {
      "type": "string",
      "maxLength": 524288,
      "description": "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` followed by the script body using agent()/parallel()/pipeline()/phase()."
    },
    "name": {
      "type": "string",
      "description": "Name of a predefined workflow resolved from built-ins, project .zcode/workflows, or user ~/.zcode/workflows."
    },
    "args": {
      "description": "Optional input value exposed to the script as the global `args`."
    },
    "scriptPath": {
      "type": "string",
      "description": "Path to a workflow script file on disk. Takes precedence over `script` and `name`."
    },
    "resumeFromRunId": {
      "type": "string",
      "pattern": "^wf_[a-z0-9-]{6,}$",
      "description": "Run ID of a prior Workflow invocation to resume from."
    }
  },
  "additionalProperties": false
}
```

At least one source field is required. The core tool handler only validates and delegates through
`WorkflowPort`; bootstrap resolves paths, writes inline scripts, validates meta, starts the
background run, and returns `{ status: "backgrounded", runId, scriptPath, response, traceId }`.

## Tests

Required coverage:

- Meta extraction succeeds for normal `export const meta = {...}` scripts.
- Invalid meta fails before dispatch.
- `agent()` options are runtime-validated with zod.
- User workflow policy rejects forbidden `systemPrompt`, tools, skills, models, and nested
  subagents.
- Workflow tables migrate idempotently.
- `session.task_type` persists and can be filtered.
- Resume returns cached completed agent results and creates new attempts for stale active calls.
- Cancelling a workflow updates run, activities, events, and session links.
