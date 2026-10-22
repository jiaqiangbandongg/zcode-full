# Subagent runtime scope boundary

The zcode-cua MCP server is shared by the parent and child runtime in some launch
paths. The request metadata namespace `com.zcode/request-context` therefore carries
the trusted `runtime_scope` value from the ZCode MCP adapter.

When the nested value is exactly `subagent`, the registration middleware returns an
`isError` result with the text `Computer Use is not available in subagent` and the
stable `structuredContent.code` value `SUBAGENT_COMPUTER_USE_UNAVAILABLE` before
kill-switch checks, session work, Broker I/O, or tool handlers. This applies to all
30 tools, including lifecycle and clipboard tools. Missing, malformed, or `main`
metadata remains compatible with standalone MCP clients. A top-level unnamespaced
`runtime_scope` is ignored.

This is an execution backstop only. ZCode Core remains responsible for removing the
authority-verified official CUA server and Skill from child provider-visible surfaces.
No tool name, schema, annotation, permission group, or MCP protocol field changes.
