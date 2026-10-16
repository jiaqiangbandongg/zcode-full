# Models.dev Catalog Source

## Status

Retired, 2026-08-24, by Provider Refactor Todo 02/03.

## Retirement contract

`models.dev`, its bundled snapshot, cache/source resolution and default policy no longer
participate in Config, Registry, Model creation or Runtime. Provider and model facts now come
from ZCode Built-in Config plus Account/Personal Overlay, and Effective Model Config Rules.

The generated snapshot module and build generator are deleted. Reintroducing models.dev as a
runtime or build-time fallback would create a second model-fact source and is not compatible with
the current Provider architecture.

Adapter-specific wire compatibility may still inspect an API/model identity when the upstream
protocol itself requires it, but it must not infer model properties, selectable reasoning levels
or reasoning strength defaults.

See the current contracts in:

- `docs/working-memory/provider-refactor/design/registry/configuration.md`
- `docs/working-memory/provider-refactor/design/registry/model-creation.md`
- `docs/working-memory/provider-refactor/steps/todo-02-ai-sdk-execution-registry-retirement.md`
