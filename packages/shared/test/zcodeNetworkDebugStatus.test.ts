import { describe, expect, it } from "vitest";
import { zcodeTaskNetworkDebugStatusFromPayload } from "../src/zcode-network-debug-status.js";

describe("zcodeTaskNetworkDebugStatusFromPayload", () => {
  it("projects model network status payloads with headers and without response data", () => {
    const event = zcodeTaskNetworkDebugStatusFromPayload({
      taskId: "task-1",
      traceId: "trace-1",
      inputId: "input-1",
      eventId: "event-1",
      payload: {
        type: "model_request_failed",
        requestId: "request-1",
        timestamp: "2026-06-10T00:00:00.000Z",
        model: {
          providerId: "openai",
          modelId: "model-test",
        },
        transport: "http",
        attempt: 2,
        maxAttempts: 3,
        statusCode: 429,
        message: "rate limited",
        responseData: { body: "should not be projected" },
        requestHeaders: {
          authorization: "[redacted]",
        },
        responseHeaders: {
          "retry-after": "1",
        },
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        type: "task_network_debug_status",
        taskId: "task-1",
        traceId: "trace-1",
        inputId: "input-1",
        eventKey: "event-1",
        statusType: "model_request_failed",
        requestId: "request-1",
        providerId: "openai",
        modelId: "model-test",
        transport: "http",
        attempt: 2,
        maxAttempts: 3,
        statusCode: 429,
        message: "rate limited",
        requestHeaders: {
          authorization: "[redacted]",
        },
        responseHeaders: {
          "retry-after": "1",
        },
        requestHeaderCount: 1,
        responseHeaderCount: 1,
      }),
    );
    expect(event).not.toHaveProperty("responseData");
  });

  it("ignores the admission-wait status types (workflow-adaptive-concurrency v3 决策 44)", () => {
    for (const type of ["model_request_queued", "model_request_admitted"]) {
      expect(
        zcodeTaskNetworkDebugStatusFromPayload({
          taskId: "task-1",
          traceId: "trace-1",
          payload: {
            type,
            requestId: "request-1",
            timestamp: "2026-09-08T00:00:00.000Z",
            model: { providerId: "prov", modelId: "alpha" },
            transport: "http",
            attempt: 1,
            maxAttempts: 0,
            queuedMs: 100,
          },
        }),
      ).toBeNull();
    }
  });
});
