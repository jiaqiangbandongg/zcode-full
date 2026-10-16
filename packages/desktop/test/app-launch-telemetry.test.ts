import { describe, expect, it, vi } from "vitest";

describe("app telemetry bridge", () => {
  it("syncs renderer telemetry context to main at bootstrap", async () => {
    const { syncAppTelemetryContext } = await import(
      "../src/renderer/appTelemetryBridge.js"
    );
    const createRendererContext = vi.fn(() => ({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    }));
    const syncTelemetryContext = vi.fn();

    syncAppTelemetryContext({
      bridge: { syncTelemetryContext },
      createRendererContext,
    });
    expect(createRendererContext).toHaveBeenCalledTimes(1);
    expect(syncTelemetryContext).toHaveBeenCalledWith({
      clientTimezone: "Asia/Shanghai",
      clientLanguage: "zh-CN",
      screenResolution: "3024x1964",
    });
  });
});
