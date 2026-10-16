import { describe, expect, it, vi } from "vitest";
import { createPluginUiSamplingService } from "./pluginUiSamplingService.js";
import { exampleSample } from "./contract.example.js";
import { IPluginUiSamplingService } from "./samplingContract.js";
const scope = {
  workspacePath: "/repo",
  sessionId: "task",
  pluginId: "math",
  serverName: "math",
  instance: { runtimeId: "agent", generation: 1, token: "credential", appIdentity: "a".repeat(64) },
};
describe("sampling service boundary", () => {
  it("forwards the complete bound identity without transforming the result", async () => {
    const result = {
      role: "assistant" as const,
      model: "test",
      content: { type: "text" as const, text: "answer" },
      stopReason: "endTurn",
    };
    const sample = vi.fn(async () => result),
      cancelSampling = vi.fn(async () => ({ cancelled: true }));
    const service = createPluginUiSamplingService({ sample, cancelSampling });
    expect(await exampleSample(service, scope)).toBe(result);
    expect(sample).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, operationId: "sample-1" }),
    );
    await service.cancelSampling({ ...scope, operationId: "sample-1" });
    expect(cancelSampling).toHaveBeenCalledWith({ ...scope, operationId: "sample-1" });
    expect(IPluginUiSamplingService.channelName).toBe("plugin-ui-sampling");
  });
  it("fails closed when this runtime has no sampling implementation", async () => {
    const service = createPluginUiSamplingService();
    await expect(exampleSample(service, scope)).rejects.toMatchObject({ code: "unavailable" });
    expect(await service.cancelSampling({ ...scope, operationId: "sample-1" })).toEqual({
      cancelled: false,
    });
  });
});
