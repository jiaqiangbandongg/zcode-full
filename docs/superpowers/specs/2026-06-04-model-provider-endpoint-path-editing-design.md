# Model Provider Endpoint Path Editing Design

## Context

Custom model providers store one shared `endpoints.baseURL` plus per-format `endpoints.paths`.
The current add/edit UI lets users choose API formats but does not expose the path values, so users cannot correct providers whose Anthropic or OpenAI-compatible operation paths differ from the defaults.

The supported default paths are:

- Anthropic Messages: `/anthropic/v1/messages`
- OpenAI Chat Completions: `/v1/chat/completions`
- OpenAI Responses: `/responses`

## Scope

This change is provider-level only. The model editor can choose which API formats a model supports, but models do not own endpoint paths.

In scope:

- Add custom provider form: selected API formats show editable path inputs with defaults.
- Edit provider detail: supported API formats show editable path inputs with the provider's saved values.
- API format labels, select options, tags, and model metadata format pickers display the path from current provider configuration or draft state, not a hardcoded path.
- Save flow preserves the canonical shape: `baseURL` plus `paths`.
- Existing duplicate-prefix protection for `/anthropic` and `/v1` remains in place.

Out of scope:

- Catalog provider endpoint editing.
- Per-model endpoint path overrides.
- Runtime protocol changes.

## Recommended Approach

Use the existing provider configuration as the source of truth.

Introduce a small UI helper that resolves API format display metadata from:

1. The API format and kind.
2. The configured `endpoints.paths[kind]`.
3. `getDefaultModelProviderEndpointPathForKind(kind)` when no custom path exists.

This keeps all API format UI consistent without duplicating path strings in each component.

## UI Design

The settings UI remains dense and form-based, following `DESIGN.md`.

Add provider custom mode:

- Keep the existing Base URL input.
- Keep the existing multi-select for API formats.
- Below the format selector, render one path input per selected API format.
- Each input uses the existing `Input` component, `font-mono`, and compact helper-free layout.
- Removing an API format removes its path from the draft. Re-adding it restores the default path.

Edit provider detail:

- Keep the existing Base URL input and API format select.
- Below the API format select, render path inputs for every format supported by the provider.
- Read-only providers show read-only path values when endpoint details are shown.
- Changing a path updates `endpoints.paths` without deleting sibling paths.

API format display:

- Long labels such as `Chat Completions (...)` must show the path resolved from the current provider or draft.
- Tags and model metadata pickers that expose a path in their option rows must use the same resolved path.
- Short tags can stay short (`Chat`, `Anthropic`, `Responses`) because they do not currently display a path, but their tooltip/title should use the resolved long label when present.

## Data Flow

Add provider draft:

- Extend `AddProviderDraft` with `customEndpointPaths`.
- Initialize selected formats with default paths.
- On API format selection changes, keep existing path values for retained formats, add defaults for newly selected formats, and drop unselected formats.
- `customProviderToConfig` accepts optional endpoint paths and passes them to endpoint construction.

Edit provider draft:

- Extend `ProviderDraftValues` with `endpointPathsValue`.
- `InlineEditableProviderCard` initializes it from normalized provider paths.
- Path input changes update `draftRef`.
- Blur commits through `resolvePendingProviderDraftSave`.
- `buildCanonicalEndpointsForDraft` uses draft paths when supplied, otherwise falls back to existing provider paths or defaults.

Normalization:

- Empty path values are normalized to protocol defaults for selected/supported API formats.
- Paths are trimmed.
- A missing leading slash is allowed in UI input but normalized before saving.
- Base URL normalization continues to remove duplicated suffixes when the path starts with `/anthropic/` or `/v1/`.

## Error Handling

No blocking validation is added in this iteration.

If the user enters an unusual non-empty path, save it after trimming and normalizing the leading slash. This supports proxy-specific paths.

Empty selected paths fall back to defaults instead of saving empty strings, preserving the fix for invisible empty `endpoints.paths`.

## Tests

Use TDD before implementation.

Regression tests should cover:

- New custom provider saves default paths for selected formats.
- New custom provider can save custom paths for selected formats.
- Editing provider path preserves sibling paths and updates only the changed path.
- Editing Base URL still preserves paths.
- Full operation URL normalization uses the edited path, not a hardcoded default.
- API format multi-select/options render path text from supplied endpoint paths.
- Existing model metadata dialog keeps using provider-supported formats and displays configured paths when provided.

Verification after implementation:

- Targeted Vitest tests for provider draft save and model provider UI rendering.
- `pnpm typecheck`
- `pnpm lint`

