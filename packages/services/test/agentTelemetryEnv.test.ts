import { describe, expect, it } from "vitest";
import { buildAgentTelemetrySpawnEnv } from "../src/zcode-agent/agentTelemetryEnv.js";

describe("buildAgentTelemetrySpawnEnv", () => {
  it("未配置 OTLP 时不注入身份", () => {
    expect(
      buildAgentTelemetrySpawnEnv({
        deviceMid: "device",
        runtimeSurface: "desktop_local_host",
        telemetryEnv: {},
        userId: "user",
      }),
    ).toEqual({});
  });

  it("App 注入 OTLP、device mid 和不可读 user subject，不传原始 UID", () => {
    const result = buildAgentTelemetrySpawnEnv({
      deviceMid: "device-1",
      runtimeSurface: "desktop_local_host",
      telemetryEnv: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=secret",
      },
      userId: "account-1",
    });
    expect(result).toMatchObject({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      ZCODE_TELEMETRY_DEVICE_MID: "device-1",
      ZCODE_TELEMETRY_IDENTITY_STATE: "authenticated",
      ZCODE_TELEMETRY_RUNTIME_SURFACE: "desktop_local_host",
    });
    expect(result.ZCODE_TELEMETRY_USER_SUBJECT_ID).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.ZCODE_TELEMETRY_USER_ID).toBeUndefined();
  });
});
