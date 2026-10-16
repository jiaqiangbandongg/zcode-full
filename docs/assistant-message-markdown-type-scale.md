# Assistant Message Markdown Type Scale

## Goal

Assistant message Markdown uses a reading-oriented type scale while the surrounding operational UI remains compact. The scale is shared by chat output and other surfaces rendered through `MessageResponse`.

## Type Scale

| Surface | Standard |
|---|---|
| User and assistant message containers | `text-ui-lg` |
| Markdown body | `text-ui-base` |
| h1 | `text-ui-xl` (`--ui-font-size + 4px`) |
| h2 | `text-ui-lg` (`--ui-font-size + 2px`) |
| h3 | `text-ui-base` |
| h4-h6 | `text-ui-base` |
| Normal and file links | `text-ui-base` |
| Inline code | `font-mono text-ui-sm` |
| Code block body | default `14px` |
| Code block header | `text-ui-base` |
| Tables | `text-ui-base` |

## Implementation Contract

- V4 `UserInputRowView` and `AssistantTextRowView` provide the shared `text-ui-lg` message container baseline.
- `MessageResponse` provides the Markdown body baseline and owns custom renderers for headings, links, inline code, and code blocks.
- Markdown tables keep their own explicit `text-ui-base` class so table preview and inline table rendering stay aligned.
- Markdown h1 uses the scalable `text-ui-xl` token instead of Tailwind's fixed `text-xl`, so heading hierarchy follows the UI font-size setting without scaling layout geometry.
- Code block body size continues to come from code preview settings, with the default set to `14px`.

## Link Interaction Contract

- Public URLs and workspace file links share the browser-style link treatment in `MessageResponse`.
- Link text uses the semantic `icon-blue` token, whose value follows `--color-terminal-bright-blue`. File-type icons keep their existing descriptor colors.
- Links have no underline at rest. Pointer hover restores the original fine dotted underline with the existing link offset; do not replace the round dots with dashed segments.
- Styling does not change link routing: public URLs keep the external/local-browser split, while PDF, Office, and other workspace files keep the workspace-scoped preview and context-menu actions.
- Desktop and mobile Web reuse the same base rendering. Mobile has no hover-only dependency: color continues to identify the link and tapping keeps the existing action.
