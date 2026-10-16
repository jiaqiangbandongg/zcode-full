import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRemoteActiveSessionCountArmsPayload,
  buildRemoteConnectResultArmsPayload,
  buildRemoteDisconnectArmsPayload,
  configureRemoteUsageArmsTelemetry,
  REMOTE_USAGE_GAUGE_INTERVAL_MS,
  reportRemoteConnectResultToArms,
  reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnectToArms,
  resetRemoteUsageArmsTelemetryForTest,
  stopRemoteUsageArmsPeriodicSampling,
} from "../src/main/desktopRemoteUsageArmsTelemetry.js";
import { createFinalArmsCustomEventE2EController } from "../src/main/desktopArmsCustomEvent.js";

describe("desktop remote usage ARMS telemetry", () => {
  afterEach(() => {
    resetRemoteUsageArmsTelemetryForTest();
    vi.useRealTimers();
  });

  it("为连接结果、并发 gauge 和断开时长构造独立数值事件", () => {
    expect(
      buildRemoteConnectResultArmsPayload({
        result: "success",
        remoteKind: "ssh",
        connectTrigger: "new",
      }),
    ).toEqual({
      name: "remote_connect_result",
      group: "remote_usage",
      value: 1,
      properties: {
        result: "success",
        remote_kind: "ssh",
        connect_trigger: "new",
        error_category: "",
      },
    });

    expect(
      buildRemoteActiveSessionCountArmsPayload(
        {
          sampleReason: "state-change",
          transition: "connected",
          remoteKind: "ssh",
        },
        { activeSessionCount: 2, activeTargetCount: 1 },
      ),
    ).toEqual({
      name: "remote_active_session_count",
      group: "remote_usage",
      value: 2,
      properties: {
        sample_reason: "state-change",
        transition: "connected",
        remote_kind: "ssh",
        active_target_count: 1,
      },
    });

    expect(
      buildRemoteDisconnectArmsPayload({
        remoteKind: "ssh",
        disconnectReason: "disposed",
        durationMs: 12_345,
      }),
    ).toEqual({
      name: "remote_disconnect",
      group: "remote_usage",
      value: 12_345,
      properties: {
        remote_kind: "ssh",
        disconnect_reason: "disposed",
        duration_ms: 12_345,
      },
    });
  });

  it("经最终 ARMS bridge 补齐公共维度，并遵守 E2E suppression", () => {
    const controller = createFinalArmsCustomEventE2EController({
      now: () => 7,
    });
    const sendCustom = vi.fn();
    controller.configure({ suppressedEventNames: ["remote_connect_result"] });
    configureRemoteUsageArmsTelemetry({
      armsCustomContext: {
        deviceMid: "device-1",
        platform: "darwin",
        appVersion: "1.2.3",
        armsEnv: "test",
      },
      getRemoteConnectionStats: () => ({
        activeSessionCount: 0,
        activeTargetCount: 0,
      }),
      sendCustom,
      e2eController: controller,
      logger: { warn: vi.fn() },
    });

    reportRemoteConnectResultToArms({
      rendererId: 73,
      result: "failure",
      remoteKind: "wsl",
      connectTrigger: "reconnect",
    });

    expect(sendCustom).not.toHaveBeenCalled();
    expect(controller.read()).toEqual([
      {
        sequence: 1,
        recordedAt: 7,
        payload: {
          name: "remote_connect_result",
          type: "custom",
          group: "remote_usage",
          value: 1,
          properties: {
            event_name: "remote_connect_result",
            app_version: "1.2.3",
            arms_env: "test",
            device_mid: "device-1",
            platform: "macos",
            renderer_id: "73",
            metric_value: "1",
            result: "failure",
            remote_kind: "wsl",
            connect_trigger: "reconnect",
            error_category: "unknown",
          },
        },
      },
    ]);
  });

  it("状态变化即时上报，并在仍有连接时每五分钟补一个 gauge", async () => {
    vi.useFakeTimers();
    let stats = { activeSessionCount: 1, activeTargetCount: 1 };
    const sendCustom = vi.fn();
    configureRemoteUsageArmsTelemetry({
      armsCustomContext: {
        deviceMid: "device-1",
        platform: "linux",
        appVersion: "1.2.3",
        armsEnv: "test",
      },
      getRemoteConnectionStats: () => stats,
      sendCustom,
      logger: { warn: vi.fn() },
    });

    reportRemoteConnectionStateChangedToArms({
      rendererId: 81,
      transition: "connected",
      remoteKind: "docker",
    });
    expect(sendCustom).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "remote_active_session_count",
        value: 1,
        properties: expect.objectContaining({
          renderer_id: "81",
          sample_reason: "state-change",
          transition: "connected",
          remote_kind: "docker",
          active_target_count: "1",
        }),
      }),
    );

    sendCustom.mockClear();
    await vi.advanceTimersByTimeAsync(REMOTE_USAGE_GAUGE_INTERVAL_MS);
    expect(sendCustom).toHaveBeenCalledOnce();
    expect(sendCustom).toHaveBeenLastCalledWith(
      expect.objectContaining({
        value: 1,
        properties: expect.objectContaining({
          renderer_id: "81",
          sample_reason: "periodic",
          transition: "none",
          remote_kind: "",
        }),
      }),
    );

    stats = { activeSessionCount: 0, activeTargetCount: 0 };
    await vi.advanceTimersByTimeAsync(REMOTE_USAGE_GAUGE_INTERVAL_MS);
    expect(sendCustom).toHaveBeenCalledOnce();

    stopRemoteUsageArmsPeriodicSampling();
    stats = { activeSessionCount: 1, activeTargetCount: 1 };
    await vi.advanceTimersByTimeAsync(REMOTE_USAGE_GAUGE_INTERVAL_MS);
    expect(sendCustom).toHaveBeenCalledOnce();
  });

  it("未配置或读取/发送失败时保持旁路且不抛错", () => {
    expect(() =>
      reportRemoteDisconnectToArms({
        rendererId: 1,
        remoteKind: "server",
        disconnectReason: "host-exit",
        durationMs: 500,
      }),
    ).not.toThrow();

    const logger = { warn: vi.fn() };
    const sendCustom = vi.fn(() => {
      throw new Error("ARMS unavailable");
    });
    configureRemoteUsageArmsTelemetry({
      armsCustomContext: {
        deviceMid: "device-1",
        platform: "win32",
        appVersion: "1.2.3",
        armsEnv: "test",
      },
      getRemoteConnectionStats: () => {
        throw new Error("stats unavailable");
      },
      sendCustom,
      logger,
    });

    expect(() =>
      reportRemoteConnectionStateChangedToArms({
        rendererId: 2,
        transition: "connected",
        remoteKind: "wsl",
      }),
    ).not.toThrow();
    expect(() =>
      reportRemoteDisconnectToArms({
        rendererId: 2,
        remoteKind: "wsl",
        disconnectReason: "app-shutdown",
        durationMs: 500,
      }),
    ).not.toThrow();

    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
