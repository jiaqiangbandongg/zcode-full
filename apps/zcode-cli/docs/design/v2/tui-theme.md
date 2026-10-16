# TUI Theme

## Goal

The TUI should have a small, explicit theme contract instead of spreading raw
hex colors through components. The first version ships two built-in themes,
`dark` and `light`, and defaults to `auto` so the visible UI follows the
terminal color scheme when OpenTUI can detect it.

This is a presentation feature. Theme state changes must not alter session
history, model-visible context, tool execution, permissions, storage, ZCode app-server, or
provider behavior.

## Token Shape

The theme layer is built on semantic tokens:

- components consume semantic colors instead of raw palette names;
- markdown, syntax, diff, borders, panels, and muted text have explicit tokens;
- theme values can be selected by dark/light mode;
- OpenTUI's renderer exposes terminal theme mode and emits theme-mode changes.

ZCode adopts the semantic token contract and OpenTUI integration pattern, not a
full custom theme loader. Custom theme files, plugin themes, generated
terminal-palette themes, and a theme picker are later extensions.

## Scope

- Add built-in `dark` and `light` TUI themes.
- Add `ui.theme` runtime config with values `auto`, `dark`, and `light`.
- Default `ui.theme` to `auto`.
- In `auto`, choose the initial theme from OpenTUI terminal theme detection.
- In `auto`, listen for OpenTUI terminal theme changes and switch between the
  built-in themes at runtime.
- Update terminal background color through OpenTUI when the resolved theme
  changes.
- Keep a legacy palette adapter so existing TUI components can migrate
  incrementally without visual churn.

## Non-Goals

- No custom theme JSON files in P0.
- No `/theme` command or theme picker in P0.
- No plugin-provided themes in P0.
- No `ZCODE_` environment variable for theme selection.
- No model, runtime, tool, MCP, ZCode app-server, or session-store schema changes.
- No direct terminal escape handling outside the OpenTUI renderer.

## Config Contract

`RuntimeConfig.ui` includes:

```ts
type TuiThemePreference = "auto" | "dark" | "light";

ui: {
  locale: UiLocale;
  theme: TuiThemePreference;
}
```

Priority follows the existing config chain:

1. system defaults;
2. user config;
3. project config;
4. environment config;
5. CLI overrides.

P0 intentionally adds no environment or CLI override, so file config is the
only persistent user-facing surface:

```json
{
  "ui": {
    "theme": "auto"
  }
}
```

Invalid `ui.theme` values reject the config file through the existing config
schema path, matching current `ui.locale` behavior.

## Theme Mode Resolution

The TUI has two related concepts:

- `preference`: `auto`, `dark`, or `light`;
- `resolvedMode`: `dark` or `light`.

Resolution:

- `dark` always resolves to `dark`;
- `light` always resolves to `light`;
- `auto` resolves to the OpenTUI-detected terminal mode;
- when terminal mode cannot be detected, `auto` falls back to `dark`.

At startup, `runTui` may wait briefly for OpenTUI's theme-mode detection. It
must not block TUI startup for a long-running palette query. Runtime theme
changes are delivered through `CliRenderEvents.THEME_MODE`.

## Token Contract

The built-in themes expose a complete semantic token object:

```ts
type TuiThemeTokens = {
  mode: "dark" | "light";

  primary: string;
  secondary: string;
  accent: string;

  error: string;
  warning: string;
  success: string;
  info: string;

  text: string;
  textMuted: string;
  selectedListItemText: string;

  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  backgroundMenu: string;
  backgroundMessageUser: string;

  border: string;
  borderActive: string;
  borderSubtle: string;

  diffAdded: string;
  diffRemoved: string;
  diffContext: string;
  diffHunkHeader: string;
  diffHighlightAdded: string;
  diffHighlightRemoved: string;
  diffAddedBg: string;
  diffRemovedBg: string;
  diffContextBg: string;
  diffLineNumber: string;
  diffAddedLineNumberBg: string;
  diffRemovedLineNumberBg: string;

  markdownText: string;
  markdownHeading: string;
  markdownLink: string;
  markdownLinkText: string;
  markdownCode: string;
  markdownBlockQuote: string;
  markdownEmph: string;
  markdownStrong: string;
  markdownHorizontalRule: string;
  markdownListItem: string;
  markdownListEnumeration: string;
  markdownImage: string;
  markdownImageText: string;
  markdownCodeBlock: string;

  syntaxComment: string;
  syntaxKeyword: string;
  syntaxFunction: string;
  syntaxVariable: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxType: string;
  syntaxOperator: string;
  syntaxPunctuation: string;

  thinkingOpacity: number;
};
```

All color strings are normalized built-in hex values in P0. The runtime theme
object is complete; components should not handle missing tokens.

## Legacy Palette Adapter

The current TUI uses a smaller palette:

```ts
accent
background
border
danger
muted
panel
panelAlt
success
text
userMessageBackground
warning
```

P0 keeps this adapter as a compatibility layer:

- `accent` -> `theme.accent`;
- `danger` -> `theme.error`;
- `muted` -> `theme.textMuted`;
- `panel` -> `theme.backgroundPanel`;
- `panelAlt` -> `theme.backgroundElement`;
- `userMessageBackground` -> `theme.backgroundMessageUser`.

New code should consume semantic theme tokens directly. Existing components can
move from the legacy palette file by file.

## Failure Behavior

- If terminal theme detection returns `null`, `auto` uses `dark`.
- If OpenTUI later emits an unknown value, ignore it.
- If terminal background update throws, keep rendering with the selected theme.
- If config parsing rejects `ui.theme`, the file is treated as invalid by the
  existing config adapter.

## Cross-Platform Notes

Theme detection relies on OpenTUI's renderer abstraction and must work the same
on Windows, macOS, and Linux where the terminal supports color-scheme reporting.
ZCode should not manually write OSC sequences, parse terminal input, or assume a
specific terminal emulator.

Terminals without theme reporting still get a stable dark default.

## Tests

- Theme resolution maps `auto` plus terminal mode to the expected built-in theme.
- `auto` falls back to dark when no terminal mode is available.
- The legacy palette maps dark and light themes correctly.
- Markdown syntax rules use semantic theme tokens.
- Config parsing accepts `ui.theme` values and rejects unsupported values.
- TUI startup passes the configured theme preference into `runTui`.
