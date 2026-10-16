import { describe, it, expect } from "vitest";
import { createLocalTtftExporter } from "../src/main/localTtftExporter.js";

describe("专用 TTFT 出口异常隔离", () => {
  it.each(["not a url", "file:///tmp/trace", "http://user:secret@localhost:4318"])(
    "无效 endpoint %s 不阻止应用初始化",
    async (endpoint) => {
      const exporter = createLocalTtftExporter({
        env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint },
        version: "test",
        logger: { warn() {} },
      });
      expect(() => exporter.enqueue({ prompt: "not-telemetry" })).not.toThrow();
      await exporter.shutdown();
    },
  );
});
