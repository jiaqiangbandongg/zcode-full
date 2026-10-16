import type { McpPort, McpServerConfig } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMcpConnectionPool } from "./pool.js";

describe("MCP App pooled connection lifetime", () => {
  it("forwards the trusted snapshot and invalidates one lease without closing another owner", async () => {
    const listeners = new Set<() => void>();
    const snapshot = { identity: "trusted", generation: 7 };
    const adapter = {
      connectServer: async () => ({ status: "connected" }),
      listTools: async () => [],
      status: async () => ({ fixture: { status: "connected" } }),
      close: vi.fn(async () => {}),
      appConnectionSnapshot: () => snapshot,
      onAppConnectionInvalidated: (_name: string, listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      callTool: vi.fn(async () => {
        throw new Error("Not connected");
      }),
    };
    const createAdapter = vi.fn(() => adapter as unknown as McpPort);
    const pool = createMcpConnectionPool({ createAdapter, idleGraceMs: 0 });
    const a = pool.acquireLease({ sessionId: "a" }),
      b = pool.acquireLease({ sessionId: "b" });
    const config: McpServerConfig = { type: "stdio", command: "fixture", isolation: "workspace" };
    await a.connectServer("fixture", config, { workingDirectory: "/fixture" });
    await b.connectServer("fixture", config, { workingDirectory: "/fixture" });
    expect(createAdapter).toHaveBeenCalledOnce();
    expect(a.appConnectionSnapshot?.("fixture")).toEqual(snapshot);
    const revokeA = vi.fn(),
      revokeB = vi.fn();
    a.onAppConnectionInvalidated?.("fixture", revokeA);
    b.onAppConnectionInvalidated?.("fixture", revokeB);
    await expect(
      b.callTool({ serverName: "fixture", toolName: "increment" }, { appConnection: snapshot }),
    ).rejects.toThrow("Not connected");
    expect(adapter.callTool).toHaveBeenCalledTimes(1);
    await a.close();
    expect(revokeA).toHaveBeenCalledOnce();
    expect(revokeB).not.toHaveBeenCalled();
    expect(a.appConnectionSnapshot?.("fixture")).toBeNull();
    expect(b.appConnectionSnapshot?.("fixture")).toEqual(snapshot);
    expect(listeners.size).toBe(1);
    expect(adapter.close).not.toHaveBeenCalled();
    await b.close();
    expect(revokeB).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    await pool.close();
  });
});
