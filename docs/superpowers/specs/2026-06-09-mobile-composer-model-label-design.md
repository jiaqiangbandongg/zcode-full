# Mobile Composer Model Label Design

## Goal

The mobile web remote chat composer must always show the current model name in the bottom input controls. Long model names should stay on one line and truncate in the middle with `...` instead of hiding the label or expanding the composer.

## Current Behavior

The chat composer renders toolbar controls into the prompt editor submit area through portals. The model selector receives the same `labelVisibilityClassName` used by mode and thought controls. On narrow composer widths this class hides labels, so the mobile composer can show only icons even when a model is selected.

## Required Behavior

- The model selector trigger always renders a visible model label in the composer controls, including mobile web remote viewports.
- The visible label uses `deepseek-v4-flash` as the maximum display length: 17 characters.
- Labels longer than 17 characters are truncated in the middle as `7 left characters + ... + 7 right characters`, so the rendered label still has total length 17.
- The full model name remains available through the trigger title.
- Desktop composer model labels keep the previous default-visible behavior and must not inherit the mode/thought responsive hide class.
- Custom provider prefixes remain hidden until `@2xl/composer`; the model name can stay visible from the existing `sm` boundary, avoiding unnecessary width pressure from `providerName/` at medium widths.
- Mode and thought-level controls keep their existing responsive label visibility.
- The model selector menu behavior, shortcut, disabled state, pending state, focus restoration, and provider selection logic are unchanged.
- Desktop `desktop-continuous` and mobile `web-remote-replayable` realtime semantics are unaffected because this change is presentation-only.

## Scope

Change only the UI model selector trigger presentation and focused regression tests. No service, protocol, snapshot, queue, owner, command, relay, or workspace identity behavior changes are required.

## Verification

Add regression tests that assert the desktop composer model label stays visible by default, while the mobile composer model label class remains visible and includes bounded truncation classes. Then run:

- `pnpm vitest run packages/ui/test/modelConfigSelect.test.ts`
- `pnpm typecheck`
- `pnpm lint`
