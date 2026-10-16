import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererActionTraceResourceV1,
} from "@zcode/shared";
import {
  RendererUserActionTelemetry,
  type UserActionTelemetryClock,
} from "../src/lib/userActionTelemetry.js";

const resource: RendererActionTraceResourceV1 = {
  serviceName: "zcode-desktop-renderer",
  serviceVersion: "test",
  deploymentEnvironment: "test",
  rendererInstanceId: "renderer-test",
};

const enabledConfig: RendererActionTraceConfigV1 = {
  enabled: true,
  sampleRatio: 0.2,
  enabledGroups: ["core", "settings"],
  configVersion: "test",
};

function createClock(): UserActionTelemetryClock {
  let now = 1_000;
  return {
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("RendererUserActionTelemetry", () => {
  afterEach(() => vi.useRealTimers());

  it("creates one completed ui_action and preserves fixed attributes", async () => {
    const batches: RendererActionTraceBatchV1[] = [];
    const clock = createClock();
    const telemetry = new RendererUserActionTelemetry({
      config: enabledConfig,
      resource,
      clock,
      random: () => 0,
      randomHex: (bytes) => (bytes === 16 ? "1".repeat(32) : "2".repeat(16)),
      sendBatch: async (batch) => batches.push(batch),
    });

    const action = telemetry.start({
      featureId: "settings.memory",
      action: "toggle_memory",
      trigger: "switch",
    });
    clock.setNow(1_125);
    action.complete({ resultSource: "shared_settings", stateAfter: "enabled" });
    action.fail({ failureStage: "late" });
    await telemetry.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.spans).toHaveLength(1);
    expect(batches[0]?.spans[0]).toMatchObject({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      name: "ui_action",
      startTimeUnixMs: 1_000,
      endTimeUnixMs: 1_125,
      status: "ok",
      attributes: {
        feature_id: "settings.memory",
        action: "toggle_memory",
        catalog_group: "settings",
        outcome: "completed",
        result_source: "shared_settings",
        state_after: "enabled",
      },
    });
  });

  it("is a no-op for disabled groups and unsampled actions", async () => {
    const sendBatch = vi.fn(async () => undefined);
    const telemetry = new RendererUserActionTelemetry({
      config: { ...enabledConfig, enabledGroups: ["core"] },
      resource,
      random: () => 0.99,
      sendBatch,
    });

    telemetry
      .start({ featureId: "settings.memory", action: "toggle_memory", trigger: "switch" })
      .complete();
    telemetry.start({ featureId: "task.lifecycle", action: "open", trigger: "button" }).complete();
    await telemetry.flush();

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("marks timed-out actions abandoned", async () => {
    vi.useFakeTimers();
    const batches: RendererActionTraceBatchV1[] = [];
    const telemetry = new RendererUserActionTelemetry({
      config: enabledConfig,
      resource,
      random: () => 0,
      sendBatch: async (batch) => batches.push(batch),
    });

    telemetry.start({
      featureId: "settings.navigation",
      action: "open_section",
      trigger: "button",
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(11);
    await telemetry.flush();

    expect(batches[0]?.spans[0]?.attributes.outcome).toBe("abandoned");
  });

  it("automatically flushes a full batch", async () => {
    const sendBatch = vi.fn(async (_batch: RendererActionTraceBatchV1) => undefined);
    const telemetry = new RendererUserActionTelemetry({
      config: { ...enabledConfig, sampleRatio: 1 },
      resource,
      random: () => 0,
      sendBatch,
    });

    for (let index = 0; index < 32; index += 1) {
      telemetry
        .start({
          featureId: "settings.memory",
          action: "toggle_memory",
          trigger: "switch",
        })
        .complete();
    }
    await telemetry.flush();

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]?.[0].spans).toHaveLength(32);
  });

  it("serializes timer flush with shutdown and drains spans queued during export", async () => {
    vi.useFakeTimers();
    let resolveFirstSend: (() => void) | undefined;
    let sendCount = 0;
    const sendBatch = vi.fn((_batch: RendererActionTraceBatchV1) => {
      sendCount += 1;
      if (sendCount > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveFirstSend = resolve;
      });
    });
    const telemetry = new RendererUserActionTelemetry({
      config: { ...enabledConfig, sampleRatio: 1 },
      resource,
      random: () => 0,
      sendBatch,
    });

    telemetry
      .start({ featureId: "settings.memory", action: "toggle_memory", trigger: "switch" })
      .complete();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendBatch).toHaveBeenCalledTimes(1);

    telemetry
      .start({ featureId: "settings.memory", action: "toggle_memory", trigger: "switch" })
      .complete();
    const shutdown = telemetry.shutdown();
    const repeatedShutdown = telemetry.shutdown();
    expect(sendBatch).toHaveBeenCalledTimes(1);

    resolveFirstSend?.();
    await Promise.all([shutdown, repeatedShutdown]);

    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[1]?.[0].spans).toHaveLength(1);
  });
});
