# Policy schema

`architecture-policy.yaml` contains `version: 1`, a list of modules, global thresholds, and optional exceptions.

Each module has an `id`, one or more `roots`, optional `managed: true`, `requires`, `provides`, `publicEntrypoints`, and an optional `owner`. Existing modules may remain unmanaged while they are in baseline migration.

The policy owns path and layer topology. A module's `module.ts` owns its local dependency declaration. Do not add a second hand-maintained dependency graph.
