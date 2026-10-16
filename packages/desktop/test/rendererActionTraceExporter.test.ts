import { describe, expect, it } from "vitest";
import {
  parseRendererActionTraceHeaders,
  resolveRendererActionTraceEndpoint,
} from "../src/main/rendererActionTraceExporter.js";

describe("renderer action trace exporter config", () => {
  it("uses the traces endpoint directly and appends v1/traces to the common endpoint", () => {
    expect(
      resolveRendererActionTraceEndpoint({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example/custom",
      }),
    ).toBe("https://arms.example/custom");
    expect(
      resolveRendererActionTraceEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example/otlp/",
      }),
    ).toBe("https://arms.example/otlp/v1/traces");
  });

  it("rejects non-http endpoints and parses percent-encoded headers", () => {
    expect(
      resolveRendererActionTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "file:///tmp/x" }),
    ).toBeUndefined();
    expect(parseRendererActionTraceHeaders("x-key=hello%20world,ignored,x-two=2")).toEqual({
      "x-key": "hello world",
      "x-two": "2",
    });
  });
});
