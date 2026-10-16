---
name: feature-boundary-planner
description: Use when the agent needs to discover the blast radius of a ZCode feature or behavior change, answer "if I change X what other features or UI surfaces should I inspect?", map shared UI components, option builders, state owners, protocol commands, persistence and tests with codegraph, clarify product boundaries, prune state combinations, and prepare specs, case catalogs, coverage matrices, or E2E handoffs before implementation.
---

# Feature Boundary Planner

Use this skill from the ZCode repository root before implementation when a request needs feature-impact discovery, product-boundary clarification, coverage planning, or an E2E handoff.

Treat impact discovery and boundary planning as two connected jobs:

1. Determine where the capability appears and what a change can affect.
2. Decide what the affected states should do and which combinations need coverage.

Do not begin with a large Cartesian product. Build a compact semantic impact map, verify it against live code, then ask only the questions that change the result.

## Choose The Operating Mode

- `impact-only`: Produce an Impact Brief. Do not change product code or existing product specs.
- `planning`: Produce the Impact Brief, clarify product semantics, and update specs or planning documents before code.
- `implementation-handoff`: Complete planning and prepare accepted cases for implementation or `e2e-case-lifecycle`.

Infer the least expansive mode from the user's request. A request to scan, explain, diagnose, or report impact is `impact-only`. A request to change or build uses `planning` unless the user explicitly limits the work.

## Required Reading

For every impact scan, read:

- `docs/feature-impact-discovery.md`
- `references/zcode-feature-graph.yaml`
- `references/impact-brief-template.md`
- the relevant rows in `references/zcode-domain-cross-products.md`

For `planning` or `implementation-handoff`, also read:

- `packages/formal-proof/README.md`
- `references/case-planning-template.md`
- the current feature spec, nearby case catalog, coverage matrix, decision worksheet, and testing workflow.

When conversation/session behavior is affected, read:

- `docs/conversation-protocol-declaration.md`
- `docs/conversation-product-state-space.md`
- `docs/conversation-session-case-catalog.md`
- `docs/testing/conversation-session-e2e-coverage-matrix.md`
- `docs/testing/conversation-session-e2e-development-workflow.md`
- `docs/testing/conversation-session-requirement-matrix-workflow.md`

Read only the domain-specific references routed by the feature graph and domain map. Prefer current fact/architecture docs over historical plans.

## Classify The Change Layer

Classify the proposed change before expanding the graph. Use one or more of:

- `presentation`: labels, layout, visibility, interaction controls, responsive behavior, theme, or locale.
- `option-source`: candidates, grouping, sorting, filtering, registry, or discovery.
- `draft-default`: initial value, inheritance, fallback, or local edit state.
- `validation`: availability, permissions, guards, blocking, or error presentation.
- `commit-effect`: command/service invoked and the runtime state changed by the action.
- `persistence`: saved representation, load, migration, isolation key, or cache.
- `recovery`: queue, snapshot, reconnect, replay, owner command, or stream recovery.

Do a low-cost scan before asking the user to classify an ambiguous change. Ask only when two interpretations would materially change the impact conclusion.

## Discover Feature And UI Impact

1. Match the user's terms to capability aliases in `references/zcode-feature-graph.yaml`.
2. Load the matched capability, its declared UI surfaces, shared implementation, state owners, invariants, docs, and one-hop semantic neighbors.
3. Use codegraph before text search for indexed code:
   - Explore every declared symbol/file seed.
   - Find direct callers of shared components, option builders, hooks, stores, services, and protocol commands.
   - Trace each UI surface through `local display/draft -> default/inheritance -> validation/gating -> commit command/service -> authoritative runtime or persistence owner`.
   - Run impact analysis at depth 2 by default. Expand to depth 3 only when a critical owner or sink is still unresolved.
   - Treat affected tests as evidence, not proof of a product dependency.
4. Use `rg` only for docs, config, generated files, unindexed content, or precise string checks after the graph has identified the area.
5. Compare live callers with declared surfaces. Record missing or stale declarations as `graph-drift-candidate`; do not silently rewrite product semantics from static reachability.
6. Rank each relationship:
   - `must-inspect`: shared edit point, owner, or commit path.
   - `should-inspect`: shared option source, default, validation, or high-value invariant.
   - `conditional`: relevant only for a change layer, client mode, workspace type, or runtime condition.
   - `invariant-only`: no expected edit, but isolation must be verified.
   - `evidence-only`: test or reachable implementation used only as supporting evidence.

Never report every reachable node as an affected feature. Explain the semantic edge and why it matters for this change layer.

## Build The UI Surface Matrix

For every UI entry point, record:

- user scenario and entry component;
- shared component, option builder, hook, store, or service;
- displayed value and local draft owner;
- default, inheritance, and fallback source;
- validation and gating;
- commit command/service;
- authoritative runtime owner or persistence sink;
- desktop/web/mobile and local/remote differences;
- behavior that must remain isolated from other surfaces.

Shared UI does not imply shared behavior. The same `model` label can mean current conversation runtime, an automation record, a Subagent Markdown field, or a built-in override. Preserve those state and commit boundaries unless the user explicitly changes the product contract.

## Clarify Product Boundaries

After impact discovery, convert only undefined or conflicting relations into questions.

- Ask 3-7 concrete questions per round.
- Include small candidate answer sets and state what each answer includes, prunes, or leaves undefined.
- Cover trigger, allowed state, target, forbidden side effects, isolation boundary, and proof evidence.
- Summarize fixed boundaries and remaining unknowns after each answer batch.
- Do not ask the user to reconfirm facts already established by code or current source-of-truth docs.

If the user has not named any capability or behavior, ask one concise scope question before scanning.

## Curate The Feature Graph

Turn confirmed scan results into reusable retrieval data.

- In `impact-only` mode, include a proposed graph delta in the Impact Brief but do not edit the graph.
- In `planning` and `implementation-handoff` modes, update `references/zcode-feature-graph.yaml` after the relevant product semantics are confirmed.
- Add or update capability aliases, source docs, exact code seeds, UI surfaces, state owners, services, persistence nodes, delivery boundaries, typed edges, ranks, and conditions.
- Use one UI surface node per distinct user scenario and state/commit contract. Put nested component call sites for that same surface into multiple `codeSeeds` instead of inventing duplicate product surfaces.
- Keep node IDs stable. Add aliases when terminology changes; do not rename IDs merely to match new UI copy.
- Persist only named product semantics. Leave raw reachability, tests, and unexplained callers as drift or evidence.
- Re-run graph integrity and codegraph seed checks after every graph edit.

## Enumerate And Prune

Run this section only in `planning` or `implementation-handoff` mode.

1. Select 1-4 primary domains and the high-risk cross-products that can change semantics.
2. Extract only behavior-changing dimensions: product state, event, target, UI surface, client mode, delivery kind, workspace identity, model/provider config, runtime/network/filesystem/auth state, persistence source, and evidence layer.
3. Enumerate with `state -> candidate -> guard -> effect -> case`. Prefer pairwise and high-risk combinations over global expansion.
4. Present 3-7 candidate decisions at a time and prune with the user.
5. Classify every candidate as `accepted`, `undefined`, `pruned`, `ignored`, or `bug-candidate`.
6. Give every pruned case a guard/invariant reason. Give every undefined case a concrete question and candidate answers.
7. Record accepted cases with setup, action, assertions, and evidence.

## Write Docs Before Code

In planning modes, update or create the feature spec, catalog, matrix, decision worksheet, or backlog before implementation. For conversation-related E2E work, update the conversation case catalog and coverage matrix and obtain pruning decisions before writing tests.

Hand accepted E2E cases to `e2e-case-lifecycle` when they require manual-review specs, provider replay fixtures, Docker isolation, timing control, or CI promotion.

## Output Contract

Always use `references/impact-brief-template.md` and include:

- feature summary and change-layer classification;
- UI Surface Matrix;
- shared implementation versus divergent behavior;
- ranked upstream/downstream relationships;
- state owners, validation points, commit sinks, and persistence;
- must-preserve invariants;
- codegraph seeds, direct callers, impact depth, and test evidence;
- graph drift candidates;
- confirmed or proposed graph delta;
- unresolved questions that would change scope.

For planning modes, append the sections in `references/case-planning-template.md`: clarification log, dimensions, candidate combinations, pruning decisions, accepted cases, coverage rows, and E2E handoff notes. Keep case IDs stable.

## Guardrails

- Static reachability is not a product dependency. Require a named semantic edge.
- Shared components, hooks, labels, or fields do not prove shared state or commit effects.
- Trace every UI surface to its own validation and commit sink.
- Keep semantic expansion to one meaningful hop and codegraph impact to depth 2 by default; never start at depth 5.
- Report graph drift for human confirmation instead of automatically declaring new product semantics.
- Do not turn an `impact-only` request into code or product-spec edits.
- Do not enumerate a large matrix before the first impact and clarification pass.
- Do not guess undefined product behavior. Record the decision and ask the user.
- Do not write E2E code until accepted semantics exist in docs.
- Do not claim coverage from a path that lacks setup, action, and assertion.
- Mark implementation/spec conflicts as `bug-candidate`; do not rewrite the contract to match current code without confirmation.
- Keep desktop `desktop-continuous` and mobile `web-remote-replayable` semantics separate.
- Preserve workspace isolation with `workspaceIdentity?.trim() || workspacePath`; use `workspacePath` for execution and display.
- Treat task sqlite index, session snapshots, runtime snapshots, localStorage, settings files, provider registry, and backend APIs as distinct sources until synchronization is proven.
- Split environment faults, remote/replayable semantics, performance, telemetry, persistence migrations, and tool cross-products into specialized docs when they would obscure the main feature path.
