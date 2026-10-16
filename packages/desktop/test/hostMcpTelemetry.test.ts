import { Emitter } from "@zcode/rpc";
import type { ZCodeMcpTelemetryEvent } from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { registerHostMcpTelemetry } from "../src/host/hostMcpTelemetry.js";

const event: ZCodeMcpTelemetryEvent = {
  arch: "arm64",
  kind: "memory",
  mcpId: "builtin:node_repl",
  mcpInstanceId: "mcp-instance-1",
  mcpIsolation: "workspace",
  mcpSource: "builtin",
  memoryKb: 96_000,
  memoryScope: "process_tree",
  occurredAt: 1_000,
  orphanSuspected: false,
  ownerSessionCount: 2,
  platform: "darwin",
  unownedSeconds: 0,
};

describe("registerHostMcpTelemetry", () => {
  it("forwards only the event and local/remote surface to main", () => {
    const emitter = new Emitter<ZCodeMcpTelemetryEvent>();
    const postMessage = vi.fn();
    const disposable = registerHostMcpTelemetry({
      agentService: { onDynamicMcpTelemetry: () => emitter.event },
      postMessage,
      runtimeSurface: "remote",
    });

    emitter.fire(event);
    disposable.dispose();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      type: HostResponseTypes.McpTelemetry,
      runtimeSurface: "remote",
      event,
    });
  });

  it("drops parentPort failures without throwing into the Agent event source", () => {
    const emitter = new Emitter<ZCodeMcpTelemetryEvent>();
    const disposable = registerHostMcpTelemetry({
      agentService: { onDynamicMcpTelemetry: () => emitter.event },
      postMessage: () => {
        throw new Error("main disconnected");
      },
      runtimeSurface: "local",
    });

    expect(() => emitter.fire(event)).not.toThrow();
    disposable.dispose();
  });
});
