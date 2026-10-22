# Office viewer owner and ports

This runtime builds the viewer panels of several plugins. Each built-in plugin package (`apps/zcode-cli/packages/<plugin>-plugin`) declares its panel title and the formats it opens under `office` in its package.json; `scripts/build.mjs` turns that into the plugin's profile (`src/profile.ts`) and keeps only the parsers and viewers of those formats (`src/adapters/parsers.ts`, `ui/viewers/registry.ts`, lines tagged `kind:<format>`). The plugin's name names its MCP server, its panel surface and its resources (`ui://<plugin>/…`). Today `documents`, `spreadsheets`, `presentations` and `pdf` each open one format: docx, xlsx, pptx and pdf. Below, `<plugin>` is the plugin's name.

`DocumentOwner` (`app/documents.ts`) is the only owner of viewer state. Server tools and the panel read and write through it; the plugin never writes workspace files.

- **Documents**: parsed by format (`adapters/parse/*`) into a `ParsedDocument` (outline, paged text, search, locator check). Cached per path and invalidated by size + mtime; the revision is a content hash.
- **Anchors** (`domain/anchor.ts`): `<path>#<locator>` shared by panel, server and model. docx `p:N[-M]`, `t:N[/rRcC]`; xlsx `Sheet[!A1[:B2]]`; pptx `slide:N[-M]`, `slide:N/shape:ID` (the shape's `cNvPr` id); pdf `page:N[-M]`. 1-based. `check()` returns the canonical form (e.g. the real sheet name).
- **Viewer state**: the current document (set by `open_document`, `show_in_viewer`, or the panel's `report_view`) and the user's last reported location and selection. One per server process.
- **Bytes to the panel**: `load_document` hands out a token; the panel reads `ui://<plugin>/file/{token}/{index}` in 4 MiB chunks. Tokens are in-memory and expire after newer loads.

## Tools

| Tool                                                                             | Visibility                                | Panel routing                                               |
| -------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `open_document`                                                                  | model, app                                | surface `<plugin>`, opens the panel                         |
| `show_in_viewer`                                                                 | model                                     | surface `<plugin>`, opens the panel                         |
| `read_document`, `search_document`, `get_view`                                   | model                                     | none                                                        |
| `list_documents`, `load_document`, `check_document`, `get_viewer`, `report_view` | app                                       | none                                                        |
| `capture_view`                                                                   | page tool (`app__<plugin>__capture_view`) | defined statically in `ui/host.ts`, bound once the UI loads |

## Panel

```mermaid
sequenceDiagram
  participant A as Agent
  participant S as Server (DocumentOwner)
  participant H as ZCode host
  participant P as Panel
  A->>S: open_document / show_in_viewer
  S-->>H: ViewerSnapshot {document, reveal{targets, seq}}
  H-->>P: tool result (surface <plugin>)
  P->>S: load_document → read file chunks
  P->>P: render, then reveal targets (seq dedupes replays)
  P->>S: report_view (debounced location + selection)
  P->>H: updateModelContext (Add to chat) / sendMessage (Ask…)
  A->>S: get_view
  A->>P: capture_view (page tool) → PNG
```

The page uses one official `App`; `ui/bootstrap.ts` connects it before loading the UI bundle through resources, keeping every tool result. The sandbox has no network: pdf.js cMaps, fonts and wasm, the pdf.js and react-xlsx workers, the xlsx wasm and the pdf plugin's bundled CJK fallback font (`fonts/*.woff2`, listed in `cjk-fallback.json`) are read as resources (`ui://<plugin>/assets/…`, only those of the plugin's formats); the panel resource declares `zcode/csp.wasmUnsafeEval`. How the PDF panel picks fonts for non-embedded CJK text and normalizes extracted text: `docs/plugins/2026-10-15-office-viewer-builtin-panels-spec.md` §5.
