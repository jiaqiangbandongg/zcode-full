---
name: pdf-viewer
description: View and discuss PDF files with the user in the PDF side panel. Use when the user wants to open, read, review or ask about a PDF in the workspace, refers to something they selected or referenced in the PDF viewer, or should check a PDF you just produced.
---

# PDF viewer

The PDF panel renders a workspace PDF for the user. You read the same file through tools and point the user at places in it. The viewer is read-only: never claim to have edited a file through it. To produce or change PDFs, use the `pdf` skill.

## Anchors

Every location is an anchor `<workspace-relative path>#<location>`: `page:N` or `page:N-M`, for example `paper.pdf#page:5`. Omit `#<location>` for the whole document. Pages start at 1. Use only anchors that a tool returned or that follow this grammar; tool output prefixes every page with its location.

## Workflow

1. `open_document(path, at?)` opens the file in the panel and returns its outline. Open the document before discussing it so the user sees what you see.
2. `read_document(anchor, cursor?)` returns the text of a page or range. Read the relevant part before answering; follow the `cursor` hint for long content instead of guessing.
3. `search_document(path, query)` finds text and returns page anchors.
4. `show_in_viewer(targets, note?)` scrolls the panel to the targets and highlights them. Use it whenever your answer is about specific places. Add `quote` (exact text on the page) to highlight a phrase rather than the whole page. Keep `note` to one short sentence.
5. `get_view()` tells you what the user is looking at and what they selected. Call it when the user says "this", "here", "the selected …" or similar without an anchor.
6. `capture_view(anchor?)` (a panel tool, available while the panel is open) returns an image of the rendered page. Use it when layout, figures or formatting matter, or when text extraction comes back empty (for example scanned PDFs). The document must already be open in the panel.

After you produce a PDF with the `pdf` skill, open it with `open_document` so the user can look at the result with you.

## References from the user

When the user selects text or clicks a page and chooses **Add to chat**, the next message carries context like `- paper.pdf#page:4: "Latency fell by 40 percent…"`. Treat those anchors as precise pointers: read them with `read_document` if you need more than the quoted text, and answer about exactly those places. **Ask** sends a question that already includes the anchor and the quoted text.

`show_in_viewer` marks every target and shows your `note` beside the first one; the user can step through the targets in order, so list them in the order you discuss them.

## Notes

- Paths are relative to the workspace; files outside it cannot be opened. Encrypted PDFs cannot be opened.
- Do not paste whole documents into the chat; quote briefly and point with `show_in_viewer`.
- The panel only works in ZCode Desktop local workspaces. Elsewhere, the read and search tools still work; tell the user the visual viewer is unavailable.
