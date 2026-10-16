import { Emitter } from "@zcode/rpc";
import type { AgentLaneResourceSample } from "@zcode/shared";
import { HostResponseTypes } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { registerHostAgentResourceTelemetry } from "../src/host/hostAgentResourceTelemetry.js";

const sample: AgentLaneResourceSample = {
  arch: "arm64",
  cpuCores: 1.25,
  cpuPercent: 12.5,
  heapUsedKb: 41_000,
  instanceToken: "9f2c4a1b7d0e5638",
  intervalMs: 60_000,
  lane: "chat",
  logicalCpuCount: 10,
  platform: "darwin",
  rssKb: 96_000,
  totalMemoryGb: 32,
  uptimeMinutes: 9,
};

describe("registerHostAgentResourceTelemetry", () => {
  it("透传 services 打标后的样本（含 lane 与 heap 等新字段）与 local/remote surface 给 main", () => {
    const emitter = new Emitter<AgentLaneResourceSample>();
    const postMessage = vi.fn();
    const disposable = registerHostAgentResourceTelemetry({
      agentService: {
        onDynamicProcessResourceSample: () => emitter.event,
      },
      postMessage,
      runtimeSurface: "remote",
      environmentKey: "a".repeat(64),
    });

    emitter.fire(sample);
    disposable.dispose();
    emitter.fire({ ...sample, rssKb: 1 });

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      type: HostResponseTypes.AgentResourceSample,
      runtimeSurface: "remote",
      environmentKey: "a".repeat(64),
      sample,
    });
  });

  it("drops parentPort failures without throwing into the Agent event source", () => {
    const emitter = new Emitter<AgentLaneResourceSample>();
    const disposable = registerHostAgentResourceTelemetry({
      agentService: {
        onDynamicProcessResourceSample: () => emitter.event,
      },
      postMessage: () => {
        throw new Error("main disconnected");
      },
      runtimeSurface: "local",
    });

    expect(() => emitter.fire(sample)).not.toThrow();
    disposable.dispose();
  });
});
