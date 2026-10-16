import type { McpConnectionSnapshot, McpPort } from "@zcode/contracts";
import { SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE } from "./computer-use-policy.js";

export interface BorrowedSubagentMcpAccess {
  port: McpPort;
  snapshot: McpConnectionSnapshot;
}

export function createBorrowedSubagentMcpAccess(
  parentPort: McpPort,
  parentStartupSnapshot: McpConnectionSnapshot,
  scopedServerNames?: readonly string[],
  deniedServerNames?: ReadonlySet<string>,
): BorrowedSubagentMcpAccess {
  const scope = scopedServerNames === undefined ? undefined : new Set(scopedServerNames);
  const isDenied = (serverName: string): boolean => deniedServerNames?.has(serverName) === true;
  const isInScope = (serverName: string): boolean =>
    (scope === undefined || scope.has(serverName)) && !isDenied(serverName);
  const statuses = Object.fromEntries(
    Object.entries(parentStartupSnapshot.statuses).filter(([serverName]) => isInScope(serverName)),
  );
  const connectedServerNames = new Set(
    Object.entries(statuses)
      .filter(([, status]) => status.status === "connected")
      .map(([serverName]) => serverName),
  );
  const snapshot: McpConnectionSnapshot = {
    statuses,
    tools: parentStartupSnapshot.tools.filter(
      (descriptor) =>
        isInScope(descriptor.serverName) && connectedServerNames.has(descriptor.serverName),
    ),
  };
  const rejectLifecycleMutation = (): never => {
    // child 借用 parent adapter，不拥有 MCP 连接生命周期。
    throw new Error("Subagent MCP port cannot mutate parent connection lifecycle");
  };

  return {
    snapshot,
    port: {
      async callTool(request, options) {
        if (isDenied(request.serverName)) {
          throw new Error(SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE);
        }
        if (!connectedServerNames.has(request.serverName)) {
          throw new Error(`Subagent MCP server is outside visible scope: ${request.serverName}`);
        }
        return parentPort.callTool(request, options);
      },
      async close() {
        // child 结束时不向 parent adapter 传播 close。
      },
      async connectConfiguredServers() {
        return rejectLifecycleMutation();
      },
      async connectServer() {
        return rejectLifecycleMutation();
      },
      async disconnectServer() {
        return rejectLifecycleMutation();
      },
      async listTools() {
        return [...snapshot.tools];
      },
      async status() {
        return { ...snapshot.statuses };
      },
    },
  };
}
