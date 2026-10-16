# zcode-guide

The official built-in ZCode plugin for configuration and self-diagnosis. It is content-only (skills) and enabled by default.

## What it provides

A set of skills that teach both users and agents how to configure ZCode's five extension resource types in the ZCode client, and how to locate and fix configuration problems for each:

| Skill | Purpose |
|---|---|
| `zcode-configuration-guide` | Overview: the locations, scopes, precedence, and merge rules for MCP servers, commands, skills, hooks, and plugins, plus guidance on where to configure each |
| `diagnosing-mcp` | Localize and fix MCP servers that will not connect, have missing tools, are untrusted, or time out |
| `diagnosing-skills` | Localize and fix skills that are not discovered, do not trigger, are shadowed, or are disabled |
| `diagnosing-commands` | Localize and fix slash commands that are missing, overridden, have frontmatter errors, or do not substitute arguments |
| `diagnosing-hooks` | Localize and fix hooks that do not trigger, whose matcher does not match, whose script is not executable, that time out, or that block unexpectedly |
| `diagnosing-plugins` | Localize and fix plugins that are not listed, fail to install, have missing components, or are not enabled |

## Design principle

Every diagnosis resolves to a concrete action: for a person, what to inspect and change in the client (Settings → Plugin Management / Skills / MCP, and the `/` menu); for an agent, the specific configuration file and field to edit. The goal is for an agent to diagnose and repair configuration on its own using these skills alone.

A built-in plugin can be disabled but not uninstalled.
