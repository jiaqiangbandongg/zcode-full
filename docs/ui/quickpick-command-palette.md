# Quickpick Command Palette

ZCode exposes a workspace-level command center from `Cmd/Ctrl+K` and the compatibility shortcut `Cmd/Ctrl+Shift+P`.
`Cmd/Ctrl+P` and `Cmd/Ctrl+G` no longer open standalone file or conversation search dialogs; their command entries route back into the command center so search has one modal surface.
Workspace-level shortcuts are handled globally even when focus is inside the composer or another text input, so command access remains keyboard-first while typing.

The UI lives in `packages/ui/src/command-center/CommandCenterDialog.tsx` and reuses the existing `cmdk` primitives from `packages/ui/src/components/ui/command.tsx`. It follows the overlay rules in `DESIGN.md`: compact rows, `bg-popover`, semantic borders, keyboard navigation, and localized labels.
On Linux desktop the shared `DialogContent` applies a platform titlebar compensation for centered dialogs. Command Center is a top-positioned search surface, so it must explicitly keep its `top-16` / `sm:top-20` placement under the `platform-linux-desktop` variant instead of inheriting the centered-dialog compensation.

Search results are grouped in a fixed order: commands, conversations, then files. The input supports explicit prefixes:

- `>` searches commands.
- `#` searches conversations.
- `@` searches files.
- No prefix searches all groups.

With an empty query, the command center shows search-history badges under the input and a short default command list. Search history is isolated by `workspaceIdentity?.trim() || workspaceAbsPath`, deduped by scope/query, capped at 20 entries, and collapsed to one visual row with an expand control when it overflows.

With a non-empty query, each result group shows at most three rows first. If a group has more matches, it renders an in-group “show more results” action that expands only that group. The overall result list is scrollable so commands, conversations, and files remain reachable on desktop and mobile web viewports.

Commands are created by `createQuickPickCommands()` in `packages/ui/src/quickpick/quickPickCommands.ts`. Add new entries there with:

- `id`: stable command id.
- `sectionId`: one of the displayed groups.
- `titleId`: i18n message id.
- `icon`: one of the supported quickpick icon kinds.
- `keywords`: extra searchable terms across English and Chinese.
- `shortcut`: optional display-only shortcut label.
- `run`: injected handler from `App`, so the registry does not import services or workspace state directly.

`App` wires the registry to existing workspace actions: new chat, open folder, search files, settings, navigation, terminal, side pane, and browser. The visible Recommended group uses the `recommended` section id and includes new chat, open folder, search files, and settings. The Navigation group sits before Panels and exposes previous/next conversation, conversation search, back, and forward actions. File search opens files through the code viewer side pane, and conversation search keeps the existing chat-result highlight request path so selecting a conversation result can jump to the matched snippet.
