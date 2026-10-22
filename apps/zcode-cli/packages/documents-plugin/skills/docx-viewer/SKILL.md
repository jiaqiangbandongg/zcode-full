---
name: docx-viewer
description: View and discuss Word (.docx) files with the user in the Documents side panel. Use when the user wants to open, read, review or ask about a Word document in the workspace, refers to something they selected or referenced in the Documents viewer, or should check a document you just produced.
---

# Word viewer

The Documents panel renders a workspace Word document for the user. You read the same file through tools and point the user at places in it. The viewer is read-only: never claim to have edited a file through it. To create or change Word documents, use the `docx` skill.

## Anchors

Every location is an anchor `<workspace-relative path>#<location>`:

- `p:N` a paragraph, `p:N-M` a run of paragraphs
- `t:N` a table, `t:N/rRcC` one table cell

For example `report.docx#p:12` or `report.docx#t:1/r3c2`. Omit `#<location>` for the whole document. Indices start at 1. Use only anchors that a tool returned or that follow this grammar; tool output prefixes every block with its location.

## Workflow

1. `open_document(path, at?)` opens the file in the panel and returns its outline. Open the document before discussing it so the user sees what you see.
2. `read_document(anchor, cursor?)` returns the paragraphs and tables (as markdown) of a location. Read the relevant part before answering; follow the `cursor` hint for long content instead of guessing.
3. `search_document(path, query)` finds text and returns paragraph and table anchors.
4. `show_in_viewer(targets, note?)` scrolls the panel to the targets and highlights them. Use it whenever your answer is about specific places, e.g. after finding the clauses you discuss. Add `quote` (exact text inside the paragraph) to highlight a phrase in a long paragraph. Keep `note` to one short sentence.
5. `get_view()` tells you what the user is looking at and what they selected. Call it when the user says "this", "here", "the selected …" or similar without an anchor.
6. `capture_view(anchor?)` (a panel tool, available while the panel is open) returns an image of the rendered location. Use it when layout, images or formatting matter. The document must already be open in the panel.

After you produce or change a document with the `docx` skill, open it with `open_document` so the user can look at the result with you.

## References from the user

When the user clicks or selects something and chooses **Add to chat**, the next message carries context like `- report.docx#p:4: "Revenue grew by 12 percent…"`. Treat those anchors as precise pointers: read them with `read_document` if you need more than the quoted text, and answer about exactly those places. **Ask** sends a question that already includes the anchor and the quoted text.

`show_in_viewer` marks every target and shows your `note` beside the first one; the user can step through the targets in order, so list them in the order you discuss them.

## Notes

- Paths are relative to the workspace; files outside it cannot be opened. Only .docx opens; convert a legacy .doc with the `docx` skill first.
- The panel renders the document close to, but not exactly like, Microsoft Word. Use `capture_view` before you comment on fine layout.
- Do not paste whole documents into the chat; quote briefly and point with `show_in_viewer`.
- The panel only works in ZCode Desktop local workspaces. Elsewhere, the read and search tools still work; tell the user the visual viewer is unavailable.
