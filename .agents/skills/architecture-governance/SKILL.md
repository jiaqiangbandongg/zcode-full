---
name: architecture-governance
description: Check ZCode module and layer boundaries for code changes. Generate bounded context for cross-module or ownership changes; skip documentation-only work.
---

# Architecture governance

Use this skill before editing code in the ZCode repository. It is a design guide as well as a gate: the goal is to make the intended architecture obvious before code is generated, so the checker confirms a decision instead of discovering it for the first time.

## Before writing code

1. Identify intended files and modules from the task, contracts, and existing tests. Run `pnpm architecture:check --changed` for the current baseline; a clean diff does not identify files you have not edited yet.
2. For cross-module changes, state ownership changes, or an unclear contract, run `pnpm architecture:context <module-id>` (or `node .agents/skills/architecture-governance/scripts/context-package.mjs <module-id>`). For a local change with a known contract, read only the relevant contract, spec, and affected tests; expand when a concrete dependency or evidence gap requires it.
3. Apply the spec and regression-evidence rules in [AGENTS.md](../../../AGENTS.md). New behavior needs a spec before implementation; restoring already specified behavior needs regression evidence, not a duplicate feature document. Pure refactors update docs only when contracts change.
4. For changes to mutable state, asynchronous behavior, or module boundaries, make the relevant design decisions before coding:
   - **One owner:** name the single component that owns each piece of mutable state. Other layers read through its contract and send commands; they do not keep a second accepted queue, cache, or derived truth.
   - **One path:** reuse an existing command, service, hook, adapter, or contract when it already expresses the behavior. Do not create a parallel helper for the same responsibility.
   - **Explicit boundaries:** choose the layer for every new file and the public contract for every cross-module edge. Keep `ui → hooks/services → app → domain → adapters` and keep IO out of domain.
   - **Explicit time:** for asynchronous or remote behavior, write the event order, owner/lease, idempotency key, stale-result rule, replay/resume boundary, and desktop versus mobile delivery kind before implementation.
   - **Bounded context:** use the relevant contracts, specs, and tests. A generated reading package helps when dependencies are unclear; do not require a whole-module reading pass for every local edit.
5. If the change alters a public contract, ownership, or allowed dependency, record that decision in the relevant spec/contract before implementation. Editing files in two modules alone does not require a new document. Use the root task boundary for when to consult the user; ordinary authorized implementation choices proceed autonomously.

Use this compact design sketch while planning stateful changes:

```text
input → single owner → command admission → state transition → contract/event
                  └── persistence / replay / projection are derived from the owner
```

For remote or streaming changes, make the delivery boundary explicit:

```text
desktop: continuous ── direct live stream ──┐
                                           ├─ same owner and sequence
mobile: replayable ─ snapshot + gap repair ┘
```

## During and after editing

6. Keep changes inside the declared module and its allowed layer direction. Add a module dependency or public contract before introducing a cross-module edge.
7. Run `pnpm architecture:check --changed` after editing. Report new violations separately from baseline violations; include owners and event-order assumptions when affected. Follow the root validation matrix, finish after required checks pass, and expand checks only for new edits, failures, or unresolved risks.

The executable policy is `architecture-policy.yaml`; keep its detailed rule definitions there. Check the actual managed-module coverage before claiming the gate verifies a boundary: a passing result does not prove unconfigured modules or runtime semantics are correct. Use `pnpm architecture:baseline:update` only when a reviewed change intentionally changes the accepted legacy baseline. CI never refreshes baseline automatically.

For a new managed module, provide `module.ts`, `contract.ts`, `contract.example.ts`, `contract.test.ts`, and a short `CONTRACT.md`. Keep runtime and persistence details behind the contract. Prefer typed service calls for one-to-one interactions, commands for state changes, and typed events for broadcast facts.

See [policy-schema.md](references/policy-schema.md), [module-contract.md](references/module-contract.md), and [rule-catalog.md](references/rule-catalog.md) when the change needs their detailed guidance. The [golden-module](references/golden-module) fixture is the smallest compliant example.
See [ai-guidance.md](references/ai-guidance.md) for the anti-patterns this workflow is designed to prevent and the questions an agent must answer before proposing code.
