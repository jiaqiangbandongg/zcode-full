# Legacy Text-sm Type Scale Migration

## Goal

This historical migration has been superseded by the dedicated `text-ui-*` scale documented in `docs/ui/ui-font-tokens.md`.

## Scope

- Compact UI text now uses `text-ui-base` as its 14px default baseline.
- Legacy explicit 13px utilities map to `text-ui-base`. Explicit 10px through
  12px utilities require semantic review; only badge-scale and very weak
  metadata roles map to `text-ui-xs`.
- Responsive prefixes and nested selectors continue to work with the new utilities.

## Non-goals

- Do not change layout spacing, color, weight, or component behavior.
- Do not alter code preview font size settings.

## Runtime Font Scaling

- The application does not override the browser root font size in CSS or through `document.documentElement.style.fontSize`.
- The Appearance UI font-size preference updates `--ui-font-size`, which drives only the `text-ui-*` utilities.
- Code and diff typography continues to use the independent `codePreviewSettings.fontSizePx` setting.

## Verification

- Searching for the old custom 13px text utility in `packages/ui/src`, `packages/ui/test`, `docs`, and `DESIGN.md` should return no matches.
- Run `pnpm typecheck`.
- Run `pnpm lint`.
- Run focused UI tests that assert rendered class names.
