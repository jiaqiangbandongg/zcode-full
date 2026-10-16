import { describe, expect, it, vi } from "vitest";
import { createMcpTelemetryTracker } from "../src/mcp/telemetry.js";

function memoryProbe(rssKb: number, treeScope: "process_tree" | "direct_process" = "process_tree") {
  return {
    treeScope,
    reset() {},
    sampleProcessGroup: async () => undefined,
    sampleProcessTrees: async () => new Map([[42_424, [{ pid: 42_424, rssKb }]]]),
  };
}

describe("MCP telemetry tracker", () => {
  it("reports one successful stdio process start with safe stable and instance identities", () => {
    const onEvent = vi.fn();
    const tracker = createMcpTelemetryTracker({
      arch: "arm64",
      idSalt: "device-a",
      now: () => 1_000,
      onEvent,
      platform: "darwin",
      randomId: () => "mcp-instance-1",
    });

    tracker.registerConnection({
      connectionId: "connection-1",
      isolation: "session",
      serverName: "private-company-server",
    });
    tracker.acquireOwner({
      connectionId: "connection-1",
      ownerId: "lease-1",
      sessionId: "session-1",
    });

    expect(tracker.recordProcessStarted({ connectionId: "connection-1", pid: 42_424 })).toEqual({
      mcpId: expect.stringMatching(/^custom:[a-f0-9]{12}$/),
      mcpInstanceId: "mcp-instance-1",
    });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({
      arch: "arm64",
      kind: "process_start",
      mcpId: expect.stringMatching(/^custom:[a-f0-9]{12}$/),
      mcpInstanceId: "mcp-instance-1",
      mcpIsolation: "session",
      mcpSource: "custom",
      occurredAt: 1_000,
      platform: "darwin",
    });
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("private-company-server");
  });

  it("keeps an official MCP identity readable while escaping unsafe characters", () => {
    const onEvent = vi.fn();
    const tracker = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent,
      randomId: () => "mcp-instance-1",
    });
    tracker.registerConnection({
      connectionId: "connection-1",
      isolation: "session",
      serverName: "plugin:document-skills:image search/高清!",
      source: "builtin",
    });

    expect(tracker.recordProcessStarted({ connectionId: "connection-1", pid: 42_424 })).toEqual({
      mcpId: "builtin:document-skills:image%20search%2F%E9%AB%98%E6%B8%85%21",
      mcpInstanceId: "mcp-instance-1",
    });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpId: "builtin:document-skills:image%20search%2F%E9%AB%98%E6%B8%85%21",
        mcpSource: "builtin",
      }),
    );
  });

  it("does not let malformed Unicode in an official MCP name break process startup", () => {
    const tracker = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: vi.fn(),
      randomId: () => "mcp-instance-1",
    });
    tracker.registerConnection({
      connectionId: "connection-1",
      isolation: "session",
      serverName: "plugin:official-plugin:broken-\uD800-name",
      source: "builtin",
    });

    expect(tracker.recordProcessStarted({ connectionId: "connection-1", pid: 42_424 })).toEqual({
      mcpId: "builtin:official-plugin:broken-%EF%BF%BD-name",
      mcpInstanceId: "mcp-instance-1",
    });
  });

  it("reports one unexpected crash with the same instance identity and uptime", () => {
    let now = 1_000;
    const onEvent = vi.fn();
    const tracker = createMcpTelemetryTracker({
      arch: "x64",
      idSalt: "device-a",
      now: () => now,
      onEvent,
      platform: "linux",
      randomId: () => "mcp-instance-1",
    });
    tracker.registerConnection({
      connectionId: "connection-1",
      isolation: "workspace",
      serverName: "node_repl",
    });
    tracker.acquireOwner({
      connectionId: "connection-1",
      ownerId: "lease-a",
      sessionId: "session-a",
    });
    tracker.acquireOwner({
      connectionId: "connection-1",
      ownerId: "lease-b",
      sessionId: "session-b",
    });
    tracker.recordProcessStarted({ connectionId: "connection-1", pid: 42_424 });

    now = 11_000;
    tracker.recordProcessCrashed({
      connectionId: "connection-1",
      exitCode: 1,
      signal: null,
    });
    tracker.recordProcessCrashed({
      connectionId: "connection-1",
      exitCode: 1,
      signal: null,
    });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenLastCalledWith({
      affectedSessionCount: 2,
      arch: "x64",
      exitCode: 1,
      kind: "process_crash",
      mcpId: "builtin:node_repl",
      mcpInstanceId: "mcp-instance-1",
      mcpIsolation: "workspace",
      mcpSource: "builtin",
      occurredAt: 11_000,
      platform: "linux",
      signal: null,
      uptimeMs: 10_000,
    });
  });

  it("marks a still-running process as suspected orphan only after more than 60 seconds unowned", async () => {
    let now = 300_000;
    const onEvent = vi.fn();
    const tracker = createMcpTelemetryTracker({
      idSalt: "device-a",
      now: () => now,
      onEvent,
      randomId: () => "mcp-instance-1",
      processProbe: memoryProbe(512_000),
    });
    tracker.registerConnection({
      connectionId: "connection-1",
      isolation: "session",
      serverName: "private-server",
    });
    tracker.acquireOwner({
      connectionId: "connection-1",
      ownerId: "lease-1",
      sessionId: "session-1",
    });
    tracker.recordProcessStarted({ connectionId: "connection-1", pid: 42_424 });
    onEvent.mockClear();

    tracker.releaseOwner({ connectionId: "connection-1", ownerId: "lease-1" });
    now = 360_000;
    await tracker.sampleNow();
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "memory",
        memoryKb: 512_000,
        memoryScope: "process_tree",
        orphanSuspected: false,
        ownerSessionCount: 0,
        unownedSeconds: 60,
      }),
    );

    now = 360_001;
    await tracker.sampleNow();
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "memory",
        orphanSuspected: true,
        unownedSeconds: 60.001,
      }),
    );
  });

  it("does not mark a process owned by a non-session control-plane lease as orphaned", async () => {
    const onEvent = vi.fn();
    const tracker = createMcpTelemetryTracker({
      idSalt: "device-a",
      now: () => 600_000,
      onEvent,
      randomId: () => "mcp-instance-1",
      processProbe: memoryProbe(64_000, "direct_process"),
    });
    tracker.registerConnection({
      connectionId: "connection-1",
      isolation: "session",
      serverName: "settings-server",
    });
    tracker.acquireOwner({ connectionId: "connection-1", ownerId: "protocol-settings" });
    tracker.recordProcessStarted({ connectionId: "connection-1", pid: 42_424 });
    onEvent.mockClear();

    await tracker.sampleNow();

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "memory",
        orphanSuspected: false,
        ownerSessionCount: 0,
        unownedSeconds: 0,
      }),
    );
  });

  it("owns one unref five-minute resource timer", () => {
    const handle = { unref: vi.fn() };
    const setInterval = vi.fn(() => handle);
    const clearInterval = vi.fn();
    const tracker = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: vi.fn(),
      timer: { clearInterval, setInterval },
    });

    tracker.start();
    tracker.start();
    tracker.stop();

    expect(setInterval).toHaveBeenCalledOnce();
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
    expect(handle.unref).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(handle);
  });

  it("keeps every telemetry sink failure outside MCP lifecycle behavior", async () => {
    const tracker = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: () => {
        throw new Error("transport closed");
      },
      processProbe: memoryProbe(1),
    });
    tracker.registerConnection({
      connectionId: "connection-1",
      isolation: "session",
      serverName: "node_repl",
    });
    tracker.acquireOwner({
      connectionId: "connection-1",
      ownerId: "lease-1",
      sessionId: "session-1",
    });

    expect(() =>
      tracker.recordProcessStarted({ connectionId: "connection-1", pid: 42_424 }),
    ).not.toThrow();
    await expect(tracker.sampleNow()).resolves.toBeUndefined();
    expect(() =>
      tracker.recordProcessCrashed({
        connectionId: "connection-1",
        exitCode: 1,
        signal: null,
      }),
    ).not.toThrow();
    expect(() =>
      tracker.recordSessionStartup({
        configuredCount: 1,
        connectedCount: 1,
        failedCount: 0,
        processCount: 1,
        sessionId: "session-1",
      }),
    ).not.toThrow();
  });

  it("forgets a confirmed closed process so a reused PID is not reported as orphaned", async () => {
    const onEvent = vi.fn();
    const tracker = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent,
      processProbe: memoryProbe(128_000),
    });
    tracker.registerConnection({
      connectionId: "connection-1",
      isolation: "session",
      serverName: "node_repl",
    });
    tracker.acquireOwner({
      connectionId: "connection-1",
      ownerId: "lease-1",
      sessionId: "session-1",
    });
    tracker.recordProcessStarted({ connectionId: "connection-1", pid: 42_424 });
    tracker.releaseOwner({ connectionId: "connection-1", ownerId: "lease-1" });
    tracker.recordProcessClosed({ connectionId: "connection-1" });
    onEvent.mockClear();

    await tracker.sampleNow();

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("listProcesses 只回报仍有存活进程记录的连接，并带明文 serverName 与插件名", () => {
    const tracker = createMcpTelemetryTracker({
      idSalt: "device-a",
      onEvent: vi.fn(),
      randomId: () => "mcp-instance-1",
    });
    tracker.registerConnection({
      connectionId: "plugin-connection",
      isolation: "workspace",
      serverName: "plugin:computer-use:computer-use",
      source: "builtin",
    });
    tracker.registerConnection({
      connectionId: "custom-connection",
      isolation: "session",
      serverName: "my-custom-server",
    });
    tracker.registerConnection({
      connectionId: "idle-connection",
      isolation: "session",
      serverName: "plugin:community-plugin:tools",
      source: "plugin",
    });
    tracker.recordProcessStarted({ connectionId: "plugin-connection", pid: 101 });
    tracker.recordProcessStarted({ connectionId: "custom-connection", pid: 102 });

    expect(tracker.listProcesses()).toEqual([
      {
        pid: 101,
        serverName: "plugin:computer-use:computer-use",
        mcpSource: "builtin",
        pluginName: "computer-use",
      },
      { pid: 102, serverName: "my-custom-server", mcpSource: "custom" },
    ]);

    tracker.recordProcessClosed({ connectionId: "plugin-connection" });
    expect(tracker.listProcesses()).toEqual([
      { pid: 102, serverName: "my-custom-server", mcpSource: "custom" },
    ]);
  });
});
