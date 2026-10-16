import { describe, expect, it, vi } from "vitest";
import type {
  McpConnectionSnapshot,
  McpPort,
  McpServerStatus,
  McpToolDescriptor,
} from "@zcode/contracts";
import { createBorrowedSubagentMcpAccess } from "../src/subagent/borrowed-mcp-port.js";

describe("borrowed subagent MCP port", () => {
  it("replays an exact server-scoped startup snapshot with connected tools only", async () => {
    const alphaTool = createDescriptor("alpha", "search");
    const similarlyNamedTool = createDescriptor("alpha-extra", "search");
    const disconnectedTool = createDescriptor("offline", "search");
    const startupSnapshot: McpConnectionSnapshot = {
      statuses: {
        alpha: createStatus("connected"),
        "alpha-extra": createStatus("connected"),
        offline: createStatus("disconnected"),
      },
      tools: [alphaTool, similarlyNamedTool, disconnectedTool],
    };
    const parentPort = createMockMcpPort();

    const borrowed = createBorrowedSubagentMcpAccess(parentPort, startupSnapshot, [
      "alpha",
      "offline",
    ]);

    expect(borrowed.snapshot.statuses).toEqual({
      alpha: startupSnapshot.statuses.alpha,
      offline: startupSnapshot.statuses.offline,
    });
    expect(borrowed.snapshot.tools).toEqual([alphaTool]);

    startupSnapshot.statuses.late = createStatus("connected");
    startupSnapshot.tools.push(createDescriptor("alpha", "late-tool"));
    const firstStatuses = await borrowed.port.status();
    const firstTools = await borrowed.port.listTools();
    delete firstStatuses.alpha;
    firstTools.push(createDescriptor("alpha", "caller-mutation"));

    expect(await borrowed.port.status()).toEqual({
      alpha: startupSnapshot.statuses.alpha,
      offline: startupSnapshot.statuses.offline,
    });
    expect(await borrowed.port.listTools()).toEqual([alphaTool]);
    expect(parentPort.status).not.toHaveBeenCalled();
    expect(parentPort.listTools).not.toHaveBeenCalled();
  });

  it("delegates visible calls without propagating child lifecycle operations", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "parent result" }],
    }));
    const parentPort = createMockMcpPort({ callTool });
    const borrowed = createBorrowedSubagentMcpAccess(
      parentPort,
      {
        statuses: {
          alpha: createStatus("connected"),
          beta: createStatus("connected"),
        },
        tools: [createDescriptor("alpha", "search"), createDescriptor("beta", "search")],
      },
      ["alpha"],
    );
    const request = {
      serverName: "alpha",
      toolName: "search",
      arguments: { query: "zcode" },
    };
    const options = { timeoutMs: 1_000 };

    await expect(borrowed.port.callTool(request, options)).resolves.toEqual({
      content: [{ type: "text", text: "parent result" }],
    });
    expect(callTool).toHaveBeenCalledWith(request, options);
    await expect(
      borrowed.port.callTool({ serverName: "beta", toolName: "search" }),
    ).rejects.toThrow("outside visible scope");

    await expect(borrowed.port.connectConfiguredServers({})).rejects.toThrow(
      "cannot mutate parent connection lifecycle",
    );
    await expect(
      borrowed.port.connectServer("alpha", { type: "stdio", command: "mcp" }),
    ).rejects.toThrow("cannot mutate parent connection lifecycle");
    await expect(borrowed.port.disconnectServer("alpha")).rejects.toThrow(
      "cannot mutate parent connection lifecycle",
    );
    await expect(borrowed.port.close()).resolves.toBeUndefined();

    expect(parentPort.connectConfiguredServers).not.toHaveBeenCalled();
    expect(parentPort.connectServer).not.toHaveBeenCalled();
    expect(parentPort.disconnectServer).not.toHaveBeenCalled();
    expect(parentPort.close).not.toHaveBeenCalled();
  });

  it("hides and blocks denied official servers without forwarding to the parent", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "parent result" }] }));
    const parentPort = createMockMcpPort({ callTool });
    const official = createDescriptor("plugin:computer-use:computer-use", "left_click");
    const unrelated = createDescriptor("plugin:demo:search", "lookup");
    const borrowed = createBorrowedSubagentMcpAccess(
      parentPort,
      {
        statuses: {
          "plugin:computer-use:computer-use": createStatus("connected"),
          "plugin:demo:search": createStatus("connected"),
        },
        tools: [official, unrelated],
      },
      undefined,
      new Set(["plugin:computer-use:computer-use"]),
    );

    expect(borrowed.snapshot.statuses).toEqual({
      "plugin:demo:search": expect.anything(),
    });
    expect(borrowed.snapshot.tools).toEqual([unrelated]);
    await expect(
      borrowed.port.callTool({
        serverName: official.serverName,
        toolName: official.toolName,
      }),
    ).rejects.toThrow("Computer Use is not available in subagent");
    expect(callTool).not.toHaveBeenCalled();
    await expect(
      borrowed.port.callTool({ serverName: unrelated.serverName, toolName: unrelated.toolName }),
    ).resolves.toEqual({ content: [{ type: "text", text: "parent result" }] });
  });
});

function createDescriptor(serverName: string, toolName: string): McpToolDescriptor {
  return {
    serverName,
    toolName,
    inputSchema: { type: "object" },
  };
}

function createStatus(status: McpServerStatus["status"]): McpServerStatus {
  return {
    status,
    transport: "stdio",
    toolCount: status === "connected" ? 1 : 0,
    updatedAt: "now",
  };
}

function createMockMcpPort(overrides: Partial<McpPort> = {}): McpPort {
  return {
    connectConfiguredServers: vi.fn(async () => ({ statuses: {}, tools: [] })),
    connectServer: vi.fn(async () => createStatus("connected")),
    disconnectServer: vi.fn(async () => undefined),
    status: vi.fn(async () => ({})),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}
