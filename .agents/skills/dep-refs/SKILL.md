---
name: dep-refs
description: Use when the agent needs to inspect TypeScript export references in the z-code workspace, list exports from a file, verify whether an export is unused before deletion, investigate who imports a symbol during refactors, or combine pnpm knip unused-export results with pnpm dep:refs symbol-level reference tracing.
disable-model-invocation: true
---

# Dep Refs

Use the repository's `pnpm dep:refs` CLI to answer symbol-level questions before changing or deleting TypeScript exports. Run commands from the z-code repository root.

## Workflow

Start broad when deleting code:

```bash
pnpm knip
```

Use `knip` to find likely unused exports, then inspect any risky or unclear export with `dep:refs`:

```bash
pnpm dep:refs packages/services/src/bots/botsService.ts:createBotsService
```

List all exports in a file when the exact symbol name is unknown:

```bash
pnpm dep:refs --list-exports packages/services/src/bots/botsService.ts
```

Use scoped scans for fast exploration only when the scope is intentionally limited:

```bash
pnpm dep:refs --scope packages/services packages/services/src/bots/botsService.ts:createBotsService
```

Before claiming an export is safe to delete, prefer an unscoped `dep:refs` run so cross-package callers are not missed.

## JSON Mode

Use silent pnpm mode for machine-readable output, because normal `pnpm` output includes extra banner lines:

```bash
pnpm -s dep:refs packages/services/src/bots/botsService.ts:createBotsService --json | jq .
```

Use JSON when summarizing many symbols, feeding results to `jq`, or comparing `references` and `reExports` counts programmatically.

## Interpreting Results

Treat `References (0)` and `Re-exports (0)` as "no static references found", not as proof that no dynamic usage exists. The script does not detect `dynamic import()` paths or string-based references.

If a symbol only appears under `Re-exports`, trace the outward barrel path before deleting. A re-export can still be part of the public surface even when there are no direct internal imports.

For refactors, report concrete callers with file and line from the CLI output, then decide whether to update callers, preserve the export, or delete it.
