import { describe, expect, it } from "vitest";
import {
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  buildZCodeToolEnvPassthroughEnv,
  getCapturedZCodeCuaBrokerCredentials,
  isCuaDevModeRequested,
  isZCodeCuaInternalFeatureEnabled,
  readZCodeAgentTelemetryEnv,
  readZCodeToolEnvPassthroughEnv,
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnv,
  getCapturedZCodeAgentTelemetryEnv,
  resetCapturedZCodeAgentTelemetryEnvForTest,
} from "../src/runtimeEnv.js";

describe("runtimeEnv", () => {
  it("enables internal CUA by default while honoring explicit false values", () => {
    expect(isZCodeCuaInternalFeatureEnabled({})).toBe(true);
    expect(isZCodeCuaInternalFeatureEnabled({ ZCODE_CUA_PRODUCT_HELPER: "0" })).toBe(false);
    expect(isZCodeCuaInternalFeatureEnabled({ ZCODE_CUA_PRODUCT_HELPER: "false" })).toBe(false);
    expect(isZCodeCuaInternalFeatureEnabled({ ZCODE_CUA_PRODUCT_HELPER: "1" })).toBe(true);
    expect(isZCodeCuaInternalFeatureEnabled({ ZCODE_CUA_PRODUCT_HELPER: " TRUE " })).toBe(true);
    expect(isZCodeCuaInternalFeatureEnabled({ ZCODE_CUA_PRODUCT_HELPER: "on" })).toBe(true);
  });

  it("ZCODE_CUA_DEV_MODE is the one-knob dev bundle and implies the internal feature flag", () => {
    // isCuaDevModeRequested: only explicit truthy values (case-insensitive, trimmed).
    expect(isCuaDevModeRequested({})).toBe(false);
    expect(isCuaDevModeRequested({ ZCODE_CUA_DEV_MODE: "0" })).toBe(false);
    expect(isCuaDevModeRequested({ ZCODE_CUA_DEV_MODE: "false" })).toBe(false);
    expect(isCuaDevModeRequested({ ZCODE_CUA_DEV_MODE: "1" })).toBe(true);
    expect(isCuaDevModeRequested({ ZCODE_CUA_DEV_MODE: " ON " })).toBe(true);
    expect(isCuaDevModeRequested({ ZCODE_CUA_DEV_MODE: "true" })).toBe(true);

    // DEV_MODE implies the internal feature flag without needing ZCODE_CUA_PRODUCT_HELPER,
    // collapsing the historical multi-var dev incantation to one knob.
    expect(isZCodeCuaInternalFeatureEnabled({ ZCODE_CUA_DEV_MODE: "1" })).toBe(true);
    expect(isZCodeCuaInternalFeatureEnabled({ ZCODE_CUA_PRODUCT_HELPER: "1" })).toBe(true);
    expect(isZCodeCuaInternalFeatureEnabled({})).toBe(true);
  });

  it("sanitizes runtime env while sealing user network env for tools", () => {
    const sourceEnv = {
      HTTP_PROXY: "http://proxy.example:8080",
      NODE_ENV: "development",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      PATH: "/usr/bin:/bin",
      npm_config_proxy: "http://npm-proxy.example:8080",
    };

    const sanitized = sanitizeZCodeRuntimeEnv(sourceEnv);
    const passthroughEnv = buildZCodeToolEnvPassthroughEnv(sourceEnv);
    const captured = readZCodeToolEnvPassthroughEnv(passthroughEnv);

    expect(sanitized).toEqual({ PATH: "/usr/bin:/bin" });
    expect(passthroughEnv[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]).toBeDefined();
    expect(captured).toEqual({
      HTTP_PROXY: "http://proxy.example:8080",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      npm_config_proxy: "http://npm-proxy.example:8080",
    });
  });

  it("ignores invalid passthrough JSON and non-network keys", () => {
    const captured = readZCodeToolEnvPassthroughEnv({
      [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
        HTTP_PROXY: "http://proxy.example:8080",
        NODE_ENV: "production",
        PATH: "/tmp/bin",
      }),
    });

    expect(captured).toEqual({
      HTTP_PROXY: "http://proxy.example:8080",
    });
    expect(
      readZCodeToolEnvPassthroughEnv({
        [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: "not-json",
      }),
    ).toEqual({});
  });

  it("strips the CUA broker socket/authority/refresh marker from child env and tool passthrough", () => {
    // Confused-deputy 防护：broker bearer 凭据只该定向注入目标 zcode-cua server，绝不能随全局 env
    // 泄漏给其它 MCP / Bash / tool 子进程，也不能经 tool-env-passthrough 恢复。
    const sourceEnv = {
      PATH: "/usr/bin:/bin",
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/zcode-cua-me/broker-abc.sock",
      ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER:
        "/tmp/zcode-cua-me/broker-abc.sock.permission-refresh.json",
    };
    const sanitized = sanitizeZCodeRuntimeEnv(sourceEnv);
    expect(sanitized).toEqual({ PATH: "/usr/bin:/bin" });

    const captured = readZCodeToolEnvPassthroughEnv(buildZCodeToolEnvPassthroughEnv(sourceEnv));
    expect(captured).not.toHaveProperty("ZCODE_CUA_PERMISSION_BROKER_SOCKET");
    expect(captured).not.toHaveProperty("ZCODE_CUA_PERMISSION_BROKER_SOCKET");
    expect(captured).not.toHaveProperty("ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER");
  });

  it("strips desktop-to-remote network handoff values after stdio bootstrap", () => {
    const sourceEnv = {
      PATH: "/usr/bin:/bin",
      [ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]: "1",
      [ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]: "http://172.21.240.1:7890",
      [ZCODE_REMOTE_NO_PROXY_ENV_KEY]: "localhost,127.0.0.1",
    };

    expect(sanitizeZCodeRuntimeEnv(sourceEnv)).toEqual({ PATH: "/usr/bin:/bin" });
    expect(readZCodeToolEnvPassthroughEnv(buildZCodeToolEnvPassthroughEnv(sourceEnv))).toEqual({});
  });

  it("captures broker credentials as one atomic pair and clears stale state on partial rotation", () => {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    try {
      sanitizeZCodeRuntimeEnv({
        ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker-a.sock",
        ZCODE_CUA_PLUGIN_AUTHORITY: "authority-a",
      });
      expect(getCapturedZCodeCuaBrokerCredentials()).toEqual({
        socket: "/tmp/broker-a.sock",
        pluginAuthority: "authority-a",
      });

      sanitizeZCodeRuntimeEnv({
        ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker-b.sock",
      });
      expect(getCapturedZCodeCuaBrokerCredentials()).toEqual({
        socket: undefined,
        pluginAuthority: undefined,
      });

      sanitizeZCodeRuntimeEnv({
        ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/broker-b.sock",
        ZCODE_CUA_PLUGIN_AUTHORITY: "authority-b",
      });
      expect(getCapturedZCodeCuaBrokerCredentials()).toEqual({
        socket: "/tmp/broker-b.sock",
        pluginAuthority: "authority-b",
      });
    } finally {
      resetCapturedZCodeCuaBrokerCredentialsForTest();
    }
  });

  it("captures Agent OTLP config privately and never passes auth or identity through to tools", () => {
    resetCapturedZCodeAgentTelemetryEnvForTest();
    const sourceEnv = {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=secret",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://arms.example.com/v1/metrics",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=metric-secret",
      PATH: "/usr/bin:/bin",
      ZCODE_TELEMETRY_USER_SUBJECT_ID: "opaque-user",
    };
    expect(sanitizeZCodeRuntimeEnv(sourceEnv)).toEqual({ PATH: "/usr/bin:/bin" });
    expect(getCapturedZCodeAgentTelemetryEnv()).toMatchObject({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=secret",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://arms.example.com/v1/metrics",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=metric-secret",
      ZCODE_TELEMETRY_USER_SUBJECT_ID: "opaque-user",
    });
    const toolEnv = readZCodeToolEnvPassthroughEnv(buildZCodeToolEnvPassthroughEnv(sourceEnv));
    expect(toolEnv).not.toHaveProperty("OTEL_EXPORTER_OTLP_TRACES_HEADERS");
    expect(toolEnv).not.toHaveProperty("OTEL_EXPORTER_OTLP_METRICS_HEADERS");
    expect(toolEnv).not.toHaveProperty("ZCODE_TELEMETRY_USER_SUBJECT_ID");
  });

  it("extracts only the allowlisted Agent telemetry env", () => {
    expect(
      readZCodeAgentTelemetryEnv({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: " https://arms.example.com/v1/traces ",
        OTEL_UNKNOWN_SECRET: "must-not-pass",
        PATH: "/bin",
        ZCODE_MODEL_TELEMETRY_ENABLED: "1",
        ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: " packaged ",
      }),
    ).toEqual({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      ZCODE_MODEL_TELEMETRY_ENABLED: "1",
      ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
    });
  });
});
