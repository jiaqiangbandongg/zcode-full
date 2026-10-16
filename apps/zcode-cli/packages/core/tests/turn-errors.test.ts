import { describe, expect, it, vi } from "vitest";
import { SessionEventType } from "@zcode/contracts";
import {
  appendTurnOutcomeEvent,
  createExternalTurnFaultError,
  createTurnFailureError,
  projectExecutionErrorPayload,
} from "../src/runtime/helpers/turn-errors.js";

describe("turn abort outcome", () => {
  it("external protocol fault 持久化 TurnError，而普通 stop 仍是 TurnComplete(cancelled)", async () => {
    const protocolAbort = new AbortController();
    protocolAbort.abort(createExternalTurnFaultError("proto.payloadTooLarge"));
    const protocolError = createTurnFailureError(
      protocolAbort.signal.reason,
      protocolAbort.signal,
      "Turn execution failed",
    );
    const protocolEvents: Array<{ type: string; payload: unknown }> = [];
    const runtime = {
      createEvent: (type: string, payload: unknown) => ({ type, payload }),
      appendEvent: vi.fn(async (event: { type: string; payload: unknown }) => {
        protocolEvents.push(event);
      }),
      logger: undefined,
    };
    await appendTurnOutcomeEvent(runtime as never, {
      coreError: protocolError,
      events: [],
      durationMs: 1,
      turnPhase: "model",
      traceContext: { traceId: "trace-protocol-fault" } as never,
      fallbackMessage: "Turn execution failed",
      logEvent: "turn.failed",
      logLabel: "Turn",
    });
    expect(protocolEvents[0]).toMatchObject({
      type: SessionEventType.TurnError,
      payload: { error: { type: "proto.payloadTooLarge" } },
    });

    const stopAbort = new AbortController();
    stopAbort.abort(new Error("user stop"));
    const stopError = createTurnFailureError(
      stopAbort.signal.reason,
      stopAbort.signal,
      "Turn execution failed",
    );
    const stopEvents: Array<{ type: string; payload: unknown }> = [];
    await appendTurnOutcomeEvent(
      {
        ...runtime,
        appendEvent: vi.fn(async (event: { type: string; payload: unknown }) => {
          stopEvents.push(event);
        }),
      } as never,
      {
        coreError: stopError,
        events: [],
        durationMs: 1,
        turnPhase: "model",
        traceContext: { traceId: "trace-stop" } as never,
        fallbackMessage: "Turn execution failed",
        logEvent: "turn.failed",
        logLabel: "Turn",
      },
    );
    expect(stopEvents[0]).toMatchObject({
      type: SessionEventType.TurnComplete,
      payload: { resultType: "cancelled" },
    });
  });
});

describe("projectExecutionErrorPayload", () => {
  it("does not synthesize underlying fields without an error frame", () => {
    expect(projectExecutionErrorPayload(undefined)).toEqual({ message: "Turn execution failed" });
  });

  it("uses the final wrapper only when no primary frame exists, and bounds cyclic chains", () => {
    const wrapper = Object.assign(new Error("wrapper only"), { errorPayloadRole: "wrapper", cause: undefined as unknown });
    wrapper.cause = wrapper;
    expect(projectExecutionErrorPayload(wrapper).underlyingErrorMessage).toBe("wrapper only");
  });

  it("keeps message and detail from one deepest non-wrapper frame", () => {
    const inner = Object.assign(new Error("inner wrapper"), { errorPayloadRole: "wrapper", detail: "not the chosen frame" });
    const outer = Object.assign(new Error("primary failure"), { cause: inner, detail: "primary detail" });
    expect(projectExecutionErrorPayload(outer)).toMatchObject({ underlyingErrorMessage: "primary failure", underlyingErrorDetail: "primary detail" });
  });

  it("uses model/network cause as the visible message and keeps low-level detail", () => {
    const socketError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9091"), {
      code: "ECONNREFUSED",
    });
    const apiError = Object.assign(
      new Error("Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9091"),
      {
        cause: socketError,
      },
    );
    const modelError = Object.assign(
      new Error("Network connection failed for the provider request."),
      {
        cause: apiError,
        code: "model_request_failed",
        context: {
          baseURL: "https://secret.example.com/v1/messages?token=secret",
          errorPhase: "stream",
          exceptionKind: "transport",
          exceptionType: "SecretProviderNetworkError",
          headers: { authorization: "Bearer secret" },
          modelId: "deepseek-v4-flash",
          providerKind: "anthropic-messages",
          providerId: "default-deepseek",
          reason: "network_error",
          requestId: "request-1",
          responseBody: "private provider response",
          retryable: true,
          source: "network",
          statusCode: 503,
          transport: "sse",
        },
        name: "AiSdkModelAdapterError",
      },
    );
    const turnError = createTurnFailureError(modelError, undefined, "Turn execution failed");

    const projection = projectExecutionErrorPayload(turnError);

    expect(projection.message).toBe("Network connection failed for the provider request.");
    expect(projection.underlyingErrorMessage).toBe(
      "connect ECONNREFUSED 127.0.0.1:9091",
    );
    expect(projection.detail).toContain("Turn execution failed");
    expect(projection.detail).toContain(
      "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9091",
    );
    expect(projection.detail).toContain("provider=default-deepseek");
    expect(projection.detail).toContain("model=deepseek-v4-flash");
    expect(projection.detail).toContain("request=request-1");
    expect(projection.attribution).toEqual({
      source: "network",
      reason: "network_error",
      errorPhase: "stream",
      exceptionKind: "transport",
      providerId: "default-deepseek",
      modelId: "deepseek-v4-flash",
      providerKind: "anthropic-messages",
      transport: "sse",
      statusCode: 503,
      retryable: true,
    });
    expect(projection.attribution).not.toHaveProperty("baseURL");
    expect(projection.attribution).not.toHaveProperty("headers");
    expect(projection.attribution).not.toHaveProperty("requestId");
    expect(projection.attribution).not.toHaveProperty("responseBody");
    expect(projection.attribution).not.toHaveProperty("exceptionType");
  });

  it("surfaces provider business code and structured context in detail", () => {
    const modelError = Object.assign(new Error("当前模型不在可用范围内"), {
      code: "invalid_model_request",
      context: {
        providerCode: "3006",
        providerId: "account:zai-individual-coding-plan",
        modelId: "glm-5",
        requestId: "request-allowed-models",
        source: "provider",
      },
      name: "AiSdkModelAdapterError",
    });
    const turnError = createTurnFailureError(modelError, undefined, "Turn execution failed");

    const projection = projectExecutionErrorPayload(turnError);

    expect(projection.code).toBe("3006");
    expect(projection.detail).toContain("provider_code=3006");
    expect(projection.detail).toContain("provider=account:zai-individual-coding-plan");
    expect(projection.detail).toContain("model=glm-5");
    expect(projection.attribution).toEqual({
      source: "provider",
      providerId: "account:zai-individual-coding-plan",
      modelId: "glm-5",
      providerErrorCode: "3006",
    });
  });

  it("keeps the deepest provider detail separate from the composed detail", () => {
    const rootError = Object.assign(new Error("Runtime headers request failed"), {
      detail: "Runtime headers helper timed out after 10000ms.",
      code: "RUNTIME_HEADERS_TIMEOUT",
    });
    const modelError = Object.assign(new Error("Model request failed"), {
      cause: rootError,
      code: "MODEL_REQUEST_FAILED",
    });

    const projection = projectExecutionErrorPayload(
      createTurnFailureError(modelError, undefined, "Turn execution failed"),
    );

    expect(projection.underlyingErrorMessage).toBe("Runtime headers request failed");
    expect(projection.underlyingErrorDetail).toBe(
      "Runtime headers helper timed out after 10000ms.",
    );
    expect(projection.detail).toContain("Runtime headers helper timed out after 10000ms.");
  });

  it("uses a non-wrapper top-level retryable fact when context does not provide one", () => {
    const modelError = Object.assign(new Error("Model returned no content"), {
      code: "MODEL_ERROR",
      context: {
        reason: "empty_model_response",
        source: "provider",
      },
      retryable: false,
    });

    expect(projectExecutionErrorPayload(modelError).attribution).toMatchObject({
      retryable: false,
    });
  });

  it("does not parse provider response bodies in the core payload projector", () => {
    const modelError = Object.assign(new Error("Provider request failed"), {
      code: "model_request_failed",
      data: {
        error: {
          message: "Provider body message should be normalized by the adapter layer",
        },
      },
      responseBody: JSON.stringify({
        error: {
          message: "Raw response body should not be parsed by core payload projector",
        },
      }),
    });

    const projection = projectExecutionErrorPayload(modelError);

    expect(projection.message).toBe("Provider request failed");
    expect(projection.message).not.toContain("adapter layer");
    expect(projection.message).not.toContain("Raw response body");
  });

  it("surfaces provider business code from ProviderBusinessError fields", () => {
    const providerError = Object.assign(
      new Error("Security verification failed or the verify token was rejected."),
      {
        name: "ProviderBusinessError",
        isProviderBusinessError: true,
        providerCode: "3007",
      },
    );
    const turnError = createTurnFailureError(providerError, undefined, "Turn execution failed");

    const projection = projectExecutionErrorPayload(turnError);

    expect(projection.code).toBe("3007");
    expect(projection.message).toContain("verify token was rejected");
  });
});
