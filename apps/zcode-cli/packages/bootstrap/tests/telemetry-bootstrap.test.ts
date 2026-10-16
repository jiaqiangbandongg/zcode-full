import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetCapturedZCodeAgentTelemetryEnvForTest,
  sanitizeZCodeRuntimeEnvInPlace,
} from "@zcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import { prepareZCodeTelemetryEnv } from "../src/telemetry-bootstrap.js";

describe("prepareZCodeTelemetryEnv", () => {
  afterEach(() => {
    resetCapturedZCodeAgentTelemetryEnvForTest();
  });

  it("从进程捕获区异步准备 identity，但不把 OTLP 凭据写回业务 env", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-telemetry-"));
    try {
      const env: NodeJS.ProcessEnv = {
        OTEL_EXPORTER_OTLP_HEADERS: "x-arms-license-key=secret",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example/v1/traces",
        ZCODE_HOME: root,
      };
      sanitizeZCodeRuntimeEnvInPlace(env);

      const prepared = await prepareZCodeTelemetryEnv(env);

      expect(prepared.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
      expect(prepared.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined();
      expect(prepared.ZCODE_TELEMETRY_DEVICE_MID).toMatch(/^[0-9a-f-]{36}$/u);
      const state = JSON.parse(
        await readFile(join(root, "v2", "telemetry-state.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(state.deviceMid).toBe(prepared.ZCODE_TELEMETRY_DEVICE_MID);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
