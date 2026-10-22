---
name: pptx-viewer
description: View and discuss PowerPoint (.pptx) decks with the user in the Presentations side panel. Use when the user wants to open, review or ask about a deck in the workspace together, refers to a slide or shape they selected or referenced in the Presentations viewer, or should check a deck you just produced.
---

# PowerPoint viewer

The Presentations panel renders a workspace deck for the user. You read the same file through tools and point the user at slides and shapes in it. The viewer is read-only: never claim to have edited a file through it. To create or change decks, use the `pptx` skill.

## Anchors

Every location is an anchor `<workspace-relative path>#<location>`:

- `slide:N` a slide, `slide:N-M` a run of slides
- `slide:N/shape:ID` one shape on a slide (ID is the shape's id in the file, as tools return it)

For example `deck.pptx#slide:3` or `deck.pptx#slide:3/shape:7`. Omit `#<location>` for the whole deck. Slides start at 1. Use only anchors that a tool returned or that follow this grammar; tool output prefixes every block with its location.

## Workflow

1. `open_document(path, at?)` opens the deck in the panel and returns its outline. Open it before discussing it so the user sees what you see.
2. `read_document(anchor, cursor?)` returns the slides of a location with their shapes' text and speaker notes. Read the relevant slides before answering; follow the `cursor` hint for long decks instead of guessing.
3. `search_document(path, query)` finds text and returns shape anchors.
4. `show_in_viewer(targets, note?)` scrolls the panel to the targets and highlights them. Use it whenever your answer is about specific slides or shapes, e.g. when you point out inconsistent numbers. Keep `note` to one short sentence.
5. `get_view()` tells you which slide the user is looking at and what they selected. Call it when the user says "this", "here", "this slide" or similar without an anchor.
6. `capture_view(anchor?)` (a panel tool, available while the panel is open) returns an image of the rendered slide. Use it when layout, images, charts or visual design matter, which on slides is often. The deck must already be open in the panel.

After you produce or change a deck with the `pptx` skill, open it with `open_document` so the user can look at the result with you.

## References from the user

When the user clicks a shape or selects text and chooses **Add to chat**, the next message carries context like `- launch.pptx#slide:2/shape:4: "Owner: Dana"`. Treat those anchors as precise pointers: read them with `read_document` if you need more than the quoted text, and answer about exactly those places. **Ask** sends a question that already includes the anchor and the quoted text.

`show_in_viewer` marks every target and shows your `note` beside the first one; the user can step through the targets in order, so list them in the order you discuss them.

## Notes

- Paths are relative to the workspace; files outside it cannot be opened. Only .pptx opens, not legacy .ppt.
- The panel renders slides close to, but not exactly like, PowerPoint; fonts missing on the machine fall back to similar ones. Use `capture_view` before you comment on fine layout, and say when a difference may come from the renderer.
- Do not paste whole decks into the chat; quote briefly and point with `show_in_viewer`.
- The panel only works in ZCode Desktop local workspaces. Elsewhere, the read and search tools still work; tell the user the visual viewer is unavailable.
