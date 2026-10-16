import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it } from "vitest";
import { OtelAgentTelemetryMetrics } from "../src/agent-metrics.js";

let providers: MeterProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.map((provider) => provider.shutdown()));
  providers = [];
});

describe("OtelAgentTelemetryMetrics", () => {
  it("只接受每个 Instrument 的低基数标签，机械丢弃身份和内容字段", async () => {
    const { exporter, metrics, provider } = createHarness();
    metrics.recordModelTokenDelta("input", 12, {
      model: "claude-sonnet-4",
      model_operation: "agent_step",
      model_role: "primary",
      provider_kind: "anthropic",
      token_type: "forged",
      transport: "sse",
      "zcode.execution.session_id": "session-private",
      "zcode.model_attempt.request_id": "request-private",
      prompt: "never-export",
    });
    metrics.recordSpanTerminal("model_attempt", "completed", 250, {
      model: "claude-sonnet-4",
      model_operation: "agent_step",
      model_role: "primary",
      provider_kind: "anthropic",
      transport: "sse",
      "zcode.execution.user_subject_id": "user-private",
    });
    await provider.forceFlush();

    const allAttributes = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .flatMap((metric) => metric.dataPoints)
      .flatMap((point) => Object.entries(point.attributes));
    expect(allAttributes).toEqual(
      expect.arrayContaining([
        ["model", "claude-sonnet-4"],
        ["provider_kind", "anthropic"],
        ["token_type", "input"],
      ]),
    );
    expect(allAttributes.map(([key]) => key)).not.toEqual(
      expect.arrayContaining([
        "prompt",
        "zcode.execution.session_id",
        "zcode.execution.user_subject_id",
        "zcode.model_attempt.request_id",
      ]),
    );
  });
});

function createHarness(): {
  exporter: InMemoryMetricExporter;
  metrics: OtelAgentTelemetryMetrics;
  provider: MeterProvider;
} {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      }),
    ],
  });
  providers.push(provider);
  return {
    exporter,
    metrics: new OtelAgentTelemetryMetrics(provider.getMeter("test")),
    provider,
  };
}
