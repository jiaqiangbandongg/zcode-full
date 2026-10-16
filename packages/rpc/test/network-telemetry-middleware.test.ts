import { afterEach, describe, expect, it } from "vitest";
import {
  emitNetworkTelemetryObservation,
  setNetworkTelemetrySink,
  type NetworkObservation,
} from "../src/network-telemetry-middleware.js";

describe("network telemetry middleware", () => {
  afterEach(() => {
    setNetworkTelemetrySink(null);
  });

  it("emits explicit network observations through the registered sink", () => {
    const observations: NetworkObservation[] = [];
    setNetworkTelemetrySink((observation) => observations.push(observation));

    emitNetworkTelemetryObservation({
      transport: "http",
      interface: "zcode_agent.model.sse",
      durationMs: 123,
      ok: true,
      attempt: 2,
    });

    expect(observations).toEqual([
      {
        transport: "http",
        interface: "zcode_agent.model.sse",
        durationMs: 123,
        ok: true,
        attempt: 2,
      },
    ]);
  });
});
