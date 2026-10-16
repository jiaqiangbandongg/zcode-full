# GLM Responses Model Selection Design

## Goal

GLM Agent now supports OpenAI Responses upstreams. Model provider selection must treat `Responses (/responses)` providers as selectable for GLM in the chat model menu and Bot `/model` entry, alongside the existing Anthropic-compatible and OpenAI-compatible Chat Completions formats.

## Current Behavior

The settings page can save a provider with `apiFormat: "openai-responses"` and models that support `responses`. The chat model menu and Bot model selector filter providers by the active ZCode provider before rendering. For `glm`, both filters currently accept only `anthropic` and `openai`, where `openai` means OpenAI-compatible Chat Completions. This hides providers that only expose `/responses`.

## Required Behavior

- GLM chat model selection accepts models whose supported formats include `responses`.
- GLM provider inclusion accepts providers that expose a Responses endpoint.
- Bot `/model` provider selection follows the same GLM format boundary as the chat model menu.
- Existing behavior for non-GLM agent types is unchanged.
- Responses remains distinct from OpenAI-compatible Chat Completions in shared type mapping.

## Scope

Update only the UI/Bot model selection eligibility layer and documentation. Runtime request conversion is already supported by GLM Agent and is not changed here. Remote control stream, workspace identity, provider registry sync, and task replay semantics are out of scope.

## Verification

Add regression tests for:

- `getProviderModelsForSelection("glm", provider)` returns a responses-only model.
- `shouldIncludeModelProviderInSelection("glm", provider)` accepts a responses-only provider.
- Bot model selection accepts the same responses-only provider for `glm`.

Run focused tests first, then required project checks:

- `pnpm vitest run packages/ui/test/chatInputToolbarModelGroups.test.ts packages/services/test/botsModelSelectionHelpers.test.ts`
- `pnpm typecheck`
- `pnpm lint`
