# GLM-5.2 Suffixed Variant Media Fallback

## Status

Accepted for implementation on 2026-07-10. The Highspeed carve-out was accepted on
2026-08-14.

## Problem

The runtime currently treats every unknown, non-official GLM-family model as image-unsupported. The family test is intentionally broad and matches any normalized model ID containing `glm`.

That fallback is still required for canonical GLM models and other unknown GLM-family models, but it is too broad for versioned GLM-5.2 variants whose provider-visible model ID has an additional hyphen suffix.

The implementation must not contain private model IDs, private provider IDs, private base URLs, private suffix tokens, hashes of private identifiers, or obfuscated equivalents.

## Decision

Keep the existing GLM-family detection and official-provider checks. Add one public structural exception for suffixed GLM-5.2 variants:

- Extract the final model ID segment, then apply the existing provider-request normalization so local suffixes such as `[1m]` do not affect the decision.
- Inspect that normalized final segment case-insensitively.
- Treat `glm-5.2-<non-empty suffix>` and `glm-5.3-<non-empty suffix>` as suffixed
  variants. When image support is otherwise unknown, preserve the unknown capability state.
- Exception: if the normalized final segment is exactly `glm-5.2-highspeed` or
  `glm-5.3-highspeed` case-insensitively, resolve `supportsImages: false` before the
  generic suffix exception and official Anthropic media allowance.
- Canonical `glm-5.2`, including a local `[1m]` marker, continues to use the existing fallback.

The structural matcher is equivalent to:

```text
^glm-5\.(?:2|3)-.+$
except ^glm-5\.(?:2|3)-highspeed$
```

Source, tests, and documentation must use neutral semantic naming and must not name any private variant.

## Capability Precedence

The existing precedence remains unchanged:

1. Explicit model capability facts.
2. Catalog capability facts.
3. Deterministic model defaults.
4. Provider-aware GLM fallback.

Therefore:

- Explicit `supportsImages: true` remains image-capable.
- Explicit `supportsImages: false` remains image-unsupported, including for suffixed variants.
- Only unknown suffixed GLM-5.2/5.3 variants skip the capability fallback; their media blocks remain subject to the standard media-budget projection.

## Active Session Refresh Semantics

Provider registry revisions may change a model capability from an explicit fact to unknown, including `supportsImages: false -> undefined` and `supportsPdf: false -> undefined`.

The active-session model-limit refresh patch must carry `modelInputMediaCapabilities` even when the resolved value is `undefined`. `AgentRuntime.updateConfig(...)` uses property presence to distinguish "clear the old value" from "leave the old value unchanged"; omitting the property would retain stale text-only capabilities and continue stripping media after the registry fact was removed.

This is an in-process runtime refresh rule only. It does not change the provider registry schema, capability precedence, persisted configuration, or the media projection behavior for explicit `true` and `false` facts.

## Expected Behavior

| Input model ID | Unknown, non-official provider result |
| --- | --- |
| `glm-5.2` | `supportsImages: false` |
| `vendor/glm-5.2` | `supportsImages: false` |
| `glm-5.2[1m]` | `supportsImages: false` |
| `glm-5.2-[1m]` | `supportsImages: false` |
| `glm-5.2-variant` | capability remains unknown |
| `vendor/glm-5.2-variant` | capability remains unknown |
| `glm-5.2-variant[1m]` | capability remains unknown |
| `glm-5.2-highspeed` | `supportsImages: false` |
| `vendor/GLM-5.2-Highspeed[1m]` | `supportsImages: false` |
| `glm-5.2-highspeed-plus` | capability remains unknown |
| `vendor/GLM-5.3-Highspeed` | `supportsImages: false` |
| `glm-5.2-variant/other-model` | `supportsImages: false` |
| `glm-5.1` | `supportsImages: false` |
| `private-glm-next` | `supportsImages: false` |

Leaving the capability unknown prevents only the capability projection from stripping images. The subsequent media-budget projection may omit historical media or reject oversized current media before any provider request; only retained media reaches the provider.

## Scope

Implementation is limited to:

- The provider-aware media fallback matcher in `apps/zcode-cli/packages/bootstrap/src/app/model-input-capabilities.ts`.
- Focused capability-resolution tests in `apps/zcode-cli/packages/bootstrap/tests/model-selection.test.ts`.
- Active-session provider registry refresh patch construction in `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`.
- A protocol integration regression test in `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`.
- The accepted conversation-session case description and coverage row so they no longer claim that every GLM-family variant is fail-closed.

No protocol schema, provider registry shape, persistent provider configuration, model reasoning policy, context-window policy, adapter request format, desktop/mobile delivery boundary, or remote-control ownership behavior changes.

Desktop continuous and web-remote replayable clients share the same attached host runtime decision, so no client-mode-specific branch is introduced.

## Tests

Focused tests must prove:

1. Canonical `GLM-5.2` remains image-unsupported for an unknown non-official provider.
2. Namespaced canonical `vendor/GLM-5.2` remains image-unsupported.
3. Neutral `GLM-5.2-variant` remains unknown.
4. Neutral namespaced and `[1m]` suffixed variants remain unknown after normalization.
5. Canonical `GLM-5.2[1m]` and `GLM-5.2-[1m]` remain image-unsupported.
6. A matching non-final path segment such as `GLM-5.2-variant/other-model` does not trigger the exception.
7. Existing `GLM-5.1` and `private-glm-next` family behavior remains image-unsupported.
8. Explicit `supportsImages: true` and `supportsImages: false` continue to override fallback behavior.
9. An active session clears stale image and PDF `false` facts when a newer provider registry revision leaves both capabilities unknown.
10. Exact trailing `-highspeed` variants for GLM-5.2 and GLM-5.3 are
    image-unsupported case-insensitively, including after local suffix normalization.
11. Longer suffixes such as `-highspeed-plus` remain unknown.

The existing provider-visible explicit text-only GLM-5.2 image-strip E2E remains valid for downstream media projection. The unknown provider-aware fallback and normalization boundary are covered by bootstrap unit tests, so a new E2E is not required.

## Non-goals

- Identifying or documenting any private model or endpoint.
- Adding a private allowlist, hash, encoded identifier, or source-level secret.
- Making all third-party GLM models fail-open.
- Treating arbitrary suffixes containing `highspeed` as known text-only variants.
- Changing GLM-5.2 reasoning levels, dated-model handling, or 1M context behavior.
- Inferring vision support from arbitrary provider names or base URLs.
