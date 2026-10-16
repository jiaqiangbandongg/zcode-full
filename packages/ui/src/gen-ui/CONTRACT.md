# Gen UI

Completed assistant references create bounded desktop sandbox pages. One page remains mounted while its inline/expanded anchor changes. UI hooks select the execution Host for file reads and base desktop Host for state and registration. Follow-ups use the existing session input binding; read-only, stale and hidden bindings cannot send. State changes alone never start an Agent turn. No tools are exposed.

External HTTP(S) anchors and `window.zcode.openExternal({ href })` use `ui/open-link`. The page owner validates the active visible instance and consumes a native user gesture before calling the viewing client's injected platform opener. Fragment links remain local; guest navigation, popups and downloads stay blocked. See `docs/specs/gen-ui-external-links.md` for the contract and validation scope.

The window page owner shares admission and eviction capacity with MCP pages. Message components lease anchors and confirmation callbacks, not the guest lifetime. Natural-flow inline surfaces have no chrome, use content height (240px initial, 10,000px ceiling), and keep their node when elevated into a preview popover. Copy-image uses the owner-validated platform sandbox API. Tweak uses the object-binding runtime and serialized register/update/dispose acknowledgements. The page owner accepts registrations and projects preview commands; the old positional constructor is removed. Transient adjustments belong to the page owner, not a remounting panel.

The conversation parent owns inline width. Normal and wide cards fill its content width without a separate maximum; the compensated paint gutter does not change that layout boundary.

Reference projection accepts the Unicode JSON marker, `::visualize{path="..." title="..." mode="wide"}`, and `::visualize{"path":"...","title":"..."}`. The existing assistant directive parser locates boundaries; JSON decoding belongs only to Gen UI projection. All forms use the same strict reference schema, Markdown code exclusions, completion gate and original message offsets. Messages need no migration.

`collectGenUiSourcePaths` and `matchesGenUiSourcePath` expose the same validated references for conversation presentation. Complete references suppress duplicate HTML preview cards and file-summary entries by full path, including Windows separator normalization. They do not authorize file reads or change page admission, stored file changes, or whole-turn rewind. See `docs/specs/gen-ui-file-summary.md`.
