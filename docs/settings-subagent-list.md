# Settings subagent list

The Subagents settings list is an independent Agent capabilities entry. It uses the same scope and resource-list language as MCPs, Skills, Commands, and Hooks while keeping implementation identifiers out of visible row content.

## Scope contract

- The page-level scope menu contains User and each open workspace. The adjacent summary reports the number of subagents in the selected scope.
- User scope shows direct user agents, user-installed plugin agents grouped by plugin, and built-in agents.
- Workspace scope shows direct agents from `<workspace>/.zcode/agents` and agents from plugins installed into that workspace, grouped by plugin. Built-in agents never appear in workspace scope.
- Search is case-insensitive and hides empty groups. A zero-result search shows one search-empty state instead of empty group headings.
- New is placed beside the Installed heading. New inherits the selected page scope; Edit shows the resource scope but does not allow changing it.
- Workspace identity is carried together with workspace path when listing or mutating workspace resources. The path remains the filesystem target and identity remains the isolation key.

### User authority when a remote conversation is active

User means the base Host's user configuration. Opening Settings from an SSH/WSL/Docker
conversation or project must not redirect User reads or writes to that remote workspace.
The selected scope owns the service target; the last active tab is only a possible execution
context, never the authority of User configuration.

```text
User                 -> base services             -> base Host user agents
selected Workspace   -> identity/session services -> selected project agents
explicit Source User -> SourceSettingsAttachment  -> selected Source user agents
```

- Lists, model choices, edits, creation, deletion and plugin inventory use the same scope
  authority. Ordinary User plugin initialization may use an available local workspace,
  but must never send a remote path to the base Host. Without a local workspace, direct
  User agents and model choices remain available; no remote workspace is borrowed or created.
- A User mutation refreshes already loaded subagent contexts belonging to that service
  authority, including local contexts while a remote tab is active. Workspace mutations
  refresh only the matching workspace identity. A stale response from a previous target
  must not overwrite the current projection.
- An explicit Source User remains separate from its conversation backing workspace. A
  remote `default` workspace is a workspace scope, not a substitute Source User option.
- This correction uses existing service injection and attachments. It creates no Host or
  stream state and preserves desktop `continuous` and mobile `replayable` delivery.

Regression coverage: `subagentsSection.test.ts` checks User creation with remote active,
same-path remote identities, offline targets and plugin initialization; `subagentsStore.test.ts`
checks authority-scoped refresh. `conversation-session-r3-settings-scopes.test.ts` checks
real GUI creation and both local/remote filesystem destinations. Source User availability
and labels remain a separate acceptance item.

The SSH regression must distinguish connection completion from directory selection:
`waitForSSHDirectoryStep` reports `closed` when the conversation flow unmounts the
wizard, and `directory` only when the directory step is visible. The case asserts
`closed` before checking the conversation identity/session; closing the wizard alone
does not prove a successful connection. Installation/boundary confirmations remain
handled, and connection errors fail immediately. Project flows still verify the
directory step and selected workspace. This is a test-helper contract only; Host and
desktop/mobile delivery behavior do not change.

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
