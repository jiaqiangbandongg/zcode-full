import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const ARMS_CUSTOM_PROPERTY_LIMIT = 20;

vi.mock("@arms/rum-electron", () => ({
  default: {
    sendCustom: vi.fn(),
    setConfig: vi.fn(),
  },
}));

describe("desktopNetworkTelemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const mod = await import("../src/main/desktopNetworkTelemetry.js");
    mod.stopDesktopNetworkTelemetry();
  });

  it("每个接口窗口只上报一条包含 counts 与耗时的事件", async () => {
    const arms = await import("@arms/rum-electron");
    const {
      configureDesktopNetworkTelemetry,
      ingestHostNetworkObservations,
      registerDesktopNetworkTelemetry,
      stopDesktopNetworkTelemetry,
      NETWORK_REPORT_INTERVAL_MS,
    } = await import("../src/main/desktopNetworkTelemetry.js");

    configureDesktopNetworkTelemetry({
      deviceMid: "dev",
      platform: "darwin",
      appVersion: "1.0.0",
      armsEnv: "local",
    });

    vi.useFakeTimers();
    registerDesktopNetworkTelemetry({ info: vi.fn(), warn: vi.fn() });

    ingestHostNetworkObservations([
      { transport: "rpc", interface: "terminal.write", durationMs: 5, ok: true },
      {
        transport: "rpc",
        interface: "terminal.write",
        durationMs: 8,
        ok: false,
        errorKind: "other",
      },
    ]);

    await vi.advanceTimersByTimeAsync(NETWORK_REPORT_INTERVAL_MS);
    stopDesktopNetworkTelemetry();
    vi.useRealTimers();

    const sendCustom = vi.mocked(arms.default.sendCustom);
    expect(sendCustom).toHaveBeenCalledTimes(1);
    expect(sendCustom.mock.calls[0]?.[0]).toMatchObject({
      group: "network",
      name: "perf_network_window",
      value: 6.5,
      properties: {
        duration_ms_p95: "8",
        duration_ms_peak: "8",
        fail_count: "1",
        interface: "terminal.write",
        primary_error_count: "1",
        primary_error_kind: "other",
        request_total: "2",
        retry_count: "0",
        success_count: "1",
        transport: "rpc",
      },
    });
    expect(Object.keys(sendCustom.mock.calls[0]?.[0].properties ?? {})).toHaveLength(15);
    expect(sendCustom.mock.calls[0]?.[0].properties).not.toHaveProperty("event_name");
    expect(sendCustom.mock.calls[0]?.[0].properties).not.toHaveProperty("metric_value");
    expect(sendCustom.mock.calls[0]?.[0].properties).not.toHaveProperty("metric_kind");
    expect(sendCustom.mock.calls[0]?.[0].properties).not.toHaveProperty("duration_ms_mean");
    expect(sendCustom.mock.calls.map(([event]) => event.name)).not.toEqual(
      expect.arrayContaining([
        "perf_network_rpc_success_rate",
        "perf_network_rpc_retry_rate",
        "perf_network_rpc_duration_ms",
        "perf_network_error_rate",
      ]),
    );
  });

  it("HTTP 阶段耗时与主错误归因齐全时仍只发一条且不超过 20 个属性", async () => {
    const arms = await import("@arms/rum-electron");
    const {
      configureDesktopNetworkTelemetry,
      ingestArmsApiEventsFromBatch,
      registerDesktopNetworkTelemetry,
      stopDesktopNetworkTelemetry,
      NETWORK_REPORT_INTERVAL_MS,
    } = await import("../src/main/desktopNetworkTelemetry.js");
    configureDesktopNetworkTelemetry({
      deviceMid: "dev",
      platform: "darwin",
      appVersion: "1.0.0",
      armsEnv: "local",
    });

    vi.useFakeTimers();
    registerDesktopNetworkTelemetry({ info: vi.fn(), warn: vi.fn() });
    try {
      ingestArmsApiEventsFromBatch([
        {
          event_type: "api",
          name: "https://api.example.com/v1/tasks/123456",
          duration: 120,
          success: 0,
          status_code: 500,
          dns_duration: 5,
          connect_duration: 10,
          ssl_duration: 15,
          first_byte_duration: 40,
          download_duration: 50,
          times: 2,
        },
      ]);
      await vi.advanceTimersByTimeAsync(NETWORK_REPORT_INTERVAL_MS);

      const sendCustom = vi.mocked(arms.default.sendCustom);
      expect(sendCustom).toHaveBeenCalledTimes(1);
      const event = sendCustom.mock.calls[0]?.[0];
      expect(Object.keys(event.properties ?? {})).toHaveLength(ARMS_CUSTOM_PROPERTY_LIMIT);
      expect(event).toMatchObject({
        name: "perf_network_window",
        value: 120,
        properties: {
          dns_ms_mean: "5",
          download_ms_mean: "50",
          primary_error_count: "1",
          primary_error_kind: "server_error",
          retry_count: "1",
          tcp_ms_mean: "10",
          tls_ms_mean: "15",
          transport: "http",
          ttfb_ms_mean: "40",
        },
      });
    } finally {
      stopDesktopNetworkTelemetry();
      vi.useRealTimers();
    }
  });
});
