# Settings subagent list

The Subagents settings list is an independent Agent capabilities entry. It uses the same scope and resource-list language as MCPs, Skills, Commands, and Hooks while keeping implementation identifiers out of visible row content.

## Scope contract

- The page-level scope menu contains User and each open workspace. The adjacent summary reports the number of subagents in the selected scope.
- User scope shows direct user agents, user-installed plugin agents grouped by plugin, and built-in agents.
- Workspace scope shows direct agents from `<workspace>/.zcode/agents` and agents from plugins installed into that workspace, grouped by plugin. Built-in agents never appear in workspace scope.
- Search is case-insensitive and hides empty groups. A zero-result search shows one search-empty state instead of empty group headings.
- New is placed beside the Installed heading. New inherits the selected page scope; Edit shows the resource scope but does not allow changing it.
- Workspace identity is carried together with workspace path when listing or mutating workspace resources. The path remains the filesystem target and identity remains the isolation key.

## Resource groups

- `Installed` contains directly-created agents for the selected scope.
- Each plugin has its own group using the converted plugin display name and plugin icon where available.
- `Built-in` is a User-only group.
- Empty and loading containers use the common dashed-border treatment.

- Rows display the agent name, description, model label when applicable, tool label, and available controls.
- Rows do not display the backing Markdown path or internal built-in identifier. Values such as `/Users/name/.zcode/agents/example.md` and `built-in:general-purpose` remain implementation data used for editing and identity only.
- Group headings communicate ownership, so rows do not repeat scope labels.
- Item descriptions use `text-ui-sm text-foreground-subtle` as secondary copy.
- Model and tool metadata labels use `rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border`, matching MCP tool-count labels.
