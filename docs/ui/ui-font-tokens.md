# UI Font Tokens

## Goal

Application interface typography uses a dedicated `text-ui-*` scale so the
Appearance UI font-size preference can resize text without changing the root
`html` font size, icons, spacing, or other `rem`-based geometry.

## Scale

`--ui-font-size` is the persisted UI baseline. Its default is 14px.

| Utility | Formula | Default |
| --- | --- | ---: |
| `text-ui-lg` | `--ui-font-size + 2px` | 16px |
| `text-ui-base` | `--ui-font-size` | 14px |
| `text-ui-sm` | `--ui-font-size - 2px` | 12px |
| `text-ui-xs` | `--ui-font-size - 4px` | 10px |

`text-mobile-input-safe` is fixed at 16px and is reserved for editable mobile
Web controls that must stay above iOS Safari's focus-zoom threshold. It is a
platform compatibility token, not part of the scalable interface hierarchy.

For example, a 16px UI preference produces 18px, 16px, 14px, and 12px.

## Migration

- Replace `text-base` with `text-ui-lg`.
- Replace `text-sm` with `text-ui-base`.
- Replace `text-xs` with `text-ui-sm`.
- Replace legacy explicit 13px UI text with `text-ui-base`. The earlier bulk
  migration incorrectly collapsed 13px text into `text-ui-xs`, reducing the
  default rendered size to 10px and losing the original content hierarchy.
- Map legacy explicit 10px through 12px text by semantic role instead of
  normalizing the whole range to one token. Reserve `text-ui-xs` for badges,
  compact labels, counters, and very weak metadata.
- Code, Diff, and terminal content retain their independent numeric font-size
  settings. Their surrounding interface controls use the UI token scale.
- Never mutate `document.documentElement.style.fontSize`; apply the preference
  only through the `--ui-font-size` custom property.
- Do not pair scalable `text-ui-*` tokens with fixed pixel line heights such as
  `leading-[18px]`. Use a relative line-height token such as `leading-normal`;
  compact controls that must grow with text use `h-auto` plus a minimum height.
- Do not use a relative `text-ui-*` token for the iOS input focus-zoom guard.
  Even when the UI preference is 12px, guarded inputs must use the fixed
  `text-mobile-input-safe` 16px token.

## Compatibility

The tokens are defined in the shared UI stylesheet, so desktop, Web, and mobile
Web use the same scale. The existing preference remains persisted in
`localStorage` and synchronized across application windows.

Independent desktop renderers that do not create the shared Zustand store must
apply `loadUiFontSizePx()` before their first React render. While open, they must
also subscribe to `zcode-ui-font-size-px` storage changes and apply them through
`applyUiFontSizePx()`. This keeps lightweight windows such as Resource Manager in
sync without attaching them to a Local/Remote Host workspace scope or the application RPC state
channel. The storage-event path assumes the windows share Electron's existing
storage partition; the startup read remains the source of truth when reopening
the window.

The shared `cn()` merger registers `text-ui-*` in the font-size class group so
semantic `text-*` color utilities do not remove the font-size token.
