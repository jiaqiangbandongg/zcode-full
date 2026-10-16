# Extension Discovery Priority

## Goal

ZCode agent extensions must merge user-level and current-workspace definitions instead of choosing only one source. When the same extension identity appears in both places, the user-level definition wins.

This applies to local discovery for:

- skills
- custom slash commands
- MCP server configs

The rule is intentionally scoped to extension discovery. General runtime preferences such as model, permission mode, UI locale, and logging keep the existing config precedence where project config can override user config.

## Skills

Default skill roots are resolved in this order:

1. explicitly configured `skills.roots`, in configured order
2. user native root: `~/.zcode/skills`
3. user agent-compatible root: `~/.agents/skills`
4. project native roots from `workingDirectory` up to the git worktree root: `<dir>/.zcode/skills`
5. project agent-compatible roots from `workingDirectory` up to the git worktree root: `<dir>/.agents/skills`
6. enabled plugin-provided roots

Within the same directory level, `.zcode` has higher priority than `.agents`. `.zcode` and `.agents` are both scanned; `.agents` is no longer only a fallback when `.zcode` is empty.

Same-name skills from different paths remain discoverable because path is the install identity. When loading by skill name, the first discovered skill wins, so user-level skills shadow project-level skills with the same name.

## Custom Commands

Default custom command roots use the same source order as skills:

1. configured roots
2. user `.zcode/commands`
3. user `.agents/commands`
4. project `.zcode/commands`
5. project `.agents/commands`
6. enabled plugin-provided command roots

Commands are keyed by normalized command name. The first discovered command wins. A later same-name command is ignored and reported as a duplicate diagnostic. This means a user-level command shadows a project command with the same slash command name.

## MCP

MCP server maps are merged by server name with extension-specific precedence:

1. plugin-provided MCP servers
2. project config MCP servers
3. user config MCP servers
4. runtime/CLI MCP overrides

User MCP servers therefore override project MCP servers with the same name. This is implemented only for `mcp.servers`; it does not change global config precedence for unrelated sections.

Project-origin MCP servers remain untrusted by default and are visible in `/mcp list` without startup auto-connect. If a project server is shadowed by a user server with the same name, the effective server is treated as user-origin and may auto-connect like any other user-configured MCP server.

## Tests

Coverage must include small fixture trees with the same skill, command, and MCP server name declared at both user and project levels:

- skill discovery lists both paths, but `loadSkill(name)` loads the user copy
- command discovery keeps the user command and reports the project duplicate
- MCP config resolves the user server, does not mark it untrusted, and still keeps project-only servers untrusted
