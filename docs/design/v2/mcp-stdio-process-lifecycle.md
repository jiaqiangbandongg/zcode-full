# MCP stdio process lifecycle

## Background

MCP stdio servers are external processes owned by the CLI adapter. Many configured servers are launched through wrappers such as `npx` or `npm exec`, and some servers start their own child processes, for example watchdog processes. Relying only on the MCP SDK transport close can leave those wrapper or descendant processes alive, especially on Windows where killing one PID does not imply killing its process tree.

## Requirements

- `apps/zcode-cli/packages/adapters/src/mcp` owns stdio MCP process cleanup.
- Every stdio MCP close path must explicitly terminate the process tree for the SDK transport pid before or alongside `client.close()` / `transport.close()`.
- The cleanup path must be idempotent. Reconnect, disconnect, adapter close, connect timeout, and connect failure can all race with an already closed transport.
- Windows cleanup must use `taskkill /PID <pid> /T /F` so wrappers and descendants are removed together.
- macOS/Linux cleanup must signal the process group when possible. It must also collect and signal known descendants because some MCP servers may detach child processes into another process group.
- HTTP and SSE MCP transports are network transports and must not run process cleanup.
- Failure to terminate a stale stdio process tree must be logged as a warning, but must not block adapter close from continuing with the SDK close path.

## Close Ordering

For stdio transports, the adapter captures the transport pid before invoking SDK close, then runs the managed process cleanup. This preserves the pid even if SDK close clears its internal process handle. After that, the adapter still calls `client.close()` and `transport.close()` for protocol and stream cleanup.

## Non Goals

- This change does not alter task archive semantics in the UI. Archiving a task hides it from the active list and does not imply `session/close`.
- This change does not change when MCP startup is scheduled by runtime/session creation.
