import { describe, expect, it } from "vitest";
import { normalizeZCodeUiError, normalizeRestoredTaskFailureError } from "@/lib/zcodeUiError.js";

describe("normalizeZCodeUiError", () => {
  it.each([
    (error: object) => error,
    (error: object) => ({ data: error }),
    (error: object) => ({ data: { error } }),
    (error: object) => ({ data: { zcode: { error } } }),
  ])("preserves structured underlying fields through RPC wrappers", (wrap) => {
    expect(
      normalizeZCodeUiError(
        wrap({
          message: "Model request failed",
          underlyingErrorMessage: "Upstream request failed",
          underlyingErrorDetail: "Upstream instance timed out after 10000ms.",
        }),
      ),
    ).toMatchObject({
      underlyingErrorMessage: "Upstream request failed",
      underlyingErrorDetail: "Upstream instance timed out after 10000ms.",
    });
  });

  it("外层 message 是泛化错误时优先展示 data.message", () => {
    const normalized = normalizeZCodeUiError({
      message: "Internal error",
      data: {
        message: "Provider quota exceeded",
      },
    });

    expect(normalized).toMatchObject({
      code: "UNKNOWN",
      message: "Provider quota exceeded",
      detail: undefined,
    });
  });

  it("message 缺失时会回退到 data.reason", () => {
    const normalized = normalizeZCodeUiError({
      data: {
        reason: "Credential expired",
      },
    });

    expect(normalized).toMatchObject({
      code: "UNKNOWN",
      message: "Credential expired",
    });
  });

  it("支持解析 JSON 字符串中的嵌套错误字段", () => {
    const normalized = normalizeZCodeUiError(
      '{"message":"Internal error","data":{"error":{"message":"token invalid"},"code":"AUTH_FAILED"}}',
    );

    expect(normalized).toMatchObject({
      code: "AUTH_FAILED",
      message: "token invalid",
      detail: undefined,
    });
  });

  it("支持上下文字段透传 traceId/taskId 与 fallbackCode", () => {
    const normalized = normalizeZCodeUiError(
      { data: { message: "Network timeout" } },
      {
        fallbackCode: "SEND_FAILED",
        traceId: "trace-123",
        taskId: "task-123",
      },
    );

    expect(normalized).toMatchObject({
      code: "SEND_FAILED",
      message: "Network timeout",
      traceId: "trace-123",
      taskId: "task-123",
    });
  });

  it("支持把顶层 detail 解析成可展开详情", () => {
    const normalized = normalizeZCodeUiError({
      message: "WebSocket protocol error: Handshake not finished",
      detail:
        "2026-04-10T02:39:27.704964Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket",
      code: "STDERR_WS_HANDSHAKE_NOT_FINISHED",
    });

    expect(normalized).toMatchObject({
      code: "STDERR_WS_HANDSHAKE_NOT_FINISHED",
      message: "WebSocket protocol error: Handshake not finished",
      detail:
        "2026-04-10T02:39:27.704964Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket",
    });
  });

  it("支持读取 zcode 结构化错误摘要", () => {
    const normalized = normalizeZCodeUiError({
      message: "Internal error",
      data: {
        zcode: {
          error: {
            code: "UNKNOWN_ERROR",
            message: "Network connection failed for the provider request.",
            detail: "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9091",
            traceId: "trace-network",
          },
        },
      },
    });

    expect(normalized).toMatchObject({
      code: "UNKNOWN_ERROR",
      message: "Network connection failed for the provider request.",
      detail: "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9091",
      traceId: "trace-network",
    });
  });

  it("保留错误 payload 中的结构化归因，避免新 schema 在 UI 归一化时丢失", () => {
    const normalized = normalizeZCodeUiError({
      code: "model_request_failed",
      message: "Provider request failed.",
      attribution: {
        source: "provider",
        reason: "server_error",
        providerId: "zai-api",
        modelId: "glm-5.2",
        statusCode: 503,
        retryable: true,
      },
    });

    expect(normalized.attribution).toEqual({
      source: "provider",
      reason: "server_error",
      providerId: "zai-api",
      modelId: "glm-5.2",
      statusCode: 503,
      retryable: true,
    });
  });
});

describe("normalizeRestoredTaskFailureError", () => {
  it("恢复 error snapshot 时优先使用 task meta 持久化的 lastError", () => {
    const normalized = normalizeRestoredTaskFailureError({
      taskId: "task-1",
      traceId: "trace-1",
      title: "",
      workspacePath: "/tmp/workspace",
      createdAt: 1,
      updatedAt: 2,
      mode: "default",
      status: "error",
      lastError: {
        code: "EMPTY_REPLY",
        message: "Agent 未产生任何回复，请重试。",
        traceId: "trace-empty",
        taskId: "task-1",
      },
    });

    expect(normalized).toMatchObject({
      code: "EMPTY_REPLY",
      message: "Agent 未产生任何回复，请重试。",
      traceId: "trace-empty",
      taskId: "task-1",
    });
  });

  it("旧 error snapshot 缺少 lastError 时不展示错误文案", () => {
    const normalized = normalizeRestoredTaskFailureError({
      taskId: "task-2",
      traceId: "trace-2",
      title: "",
      workspacePath: "/tmp/workspace",
      createdAt: 1,
      updatedAt: 2,
      mode: "default",
      status: "error",
    });

    expect(normalized).toBeNull();
  });
});
