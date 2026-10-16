import { describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import {
  CHAT_ERROR_BANNER_ARMS_EVENT_NAME,
  CHAT_ERROR_BANNER_ARMS_GROUP,
  buildChatErrorBannerTelemetryPayload,
  reportChatErrorBannerTelemetry,
} from "@/lib/chatErrorBannerTelemetry.js";

describe("chat error banner telemetry", () => {
  it("attributes the shared attachment budget error without matching message text", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "当前附件总量过大",
      error: { code: "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE", message: "opaque fallback" },
      providerBusinessRecoveryAction: null,
    });
    expect(payload.properties).toMatchObject({
      error_source: "runtime",
      failure_reason: "invalid_input",
    });
  });

  it.each([
    "Authorization: Bearer private-secret",
    "https://api.example/v1?api_key=private-secret",
    "Connection failed at https://private-provider.example/v1",
    "<html><body>private provider response</body></html>",
  ])("does not report sensitive underlying text: %s", (text) => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Model request failed",
      error: {
        code: "FAILED",
        message: "Model request failed",
        underlyingErrorMessage: text,
        underlyingErrorDetail: text,
      },
      providerBusinessRecoveryAction: null,
    });
    expect(payload.properties?.error_detail_message).toBe("sensitive error redacted");
    expect(payload.properties).not.toHaveProperty("error_detail_text");
  });

  it("bounds the underlying message but never uploads underlying detail", () => {
    const params = {
      displayMessage: "Failed",
      error: { code: "FAILED", message: "Failed" },
      providerBusinessRecoveryAction: null,
    };
    expect(buildChatErrorBannerTelemetryPayload(params).properties).not.toHaveProperty(
      "error_detail_text",
    );
    const payload = buildChatErrorBannerTelemetryPayload({
      ...params,
      error: {
        ...params.error,
        underlyingErrorMessage: "x".repeat(900),
        underlyingErrorDetail: "private response body",
      },
    });
    expect(payload.properties?.error_detail_message).toHaveLength(500);
    expect(payload.properties).not.toHaveProperty("error_detail_text");
    expect(JSON.stringify(payload)).not.toContain("private response body");
  });

  it("builds a privacy-bounded exposure payload for visible input banner errors", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      errorKey: "task-1:SEND_FAILED:trace-1",
      displayMessage: `${"x".repeat(520)}tail`,
      error: {
        code: "SEND_FAILED",
        message: `${"x".repeat(520)}tail`,
        traceId: "trace-1",
        taskId: "task-1",
        detail: "stack should not be reported",
        underlyingErrorMessage: "Upstream request failed",
        underlyingErrorDetail: "Upstream instance timed out after 10000ms.",
      },
      providerBusinessRecoveryAction: {
        kind: "upgrade",
        providerBusinessCode: "3007",
      },
    });

    expect(payload).toMatchObject({
      name: CHAT_ERROR_BANNER_ARMS_EVENT_NAME,
      group: CHAT_ERROR_BANNER_ARMS_GROUP,
      value: 1,
      properties: {
        surface: "chat_input_error_banner",
        error_code: "SEND_FAILED",
        trace_id: "trace-1",
        task_id: "task-1",
        has_detail: true,
        error_detail_message: "Upstream request failed",
        provider_business_action: "upgrade",
        provider_business_code: "3007",
      },
    });
    expect(payload.properties?.error_key).toMatch(
      /^task-1:SEND_FAILED:trace-1:upgrade:3007:[0-9a-f]{8}$/,
    );
    expect(payload.properties?.error_key).not.toContain("x".repeat(32));
    expect(payload.properties?.error_message).toHaveLength(500);
    expect(payload.properties).not.toHaveProperty("detail");
  });

  it("uses the resolved banner display message for the reported error text", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      errorKey: "task-1:3010:trace-1:service busy",
      displayMessage: "当前系统繁忙，请切换模型、升级账户，或稍后再试。",
      error: {
        code: "3010",
        message: "service busy",
        traceId: "trace-1",
        taskId: "task-1",
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties?.error_message).toBe(
      "当前系统繁忙，请切换模型、升级账户，或稍后再试。",
    );
    expect(payload.properties?.error_message).not.toBe("service busy");
  });

  it("adds safe structured attribution fields for builtin provider failures", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "模型服务暂时不可用",
      error: {
        code: "model_request_failed",
        message: "Provider stream failed",
        attribution: {
          source: "network",
          reason: "network_error",
          errorPhase: "stream",
          exceptionKind: "transport",
          providerId: "account:zai-individual-coding-plan",
          modelId: " GLM-5 ",
          providerKind: "anthropic",
          transport: "sse",
          statusCode: 503,
          providerErrorCode: "UPSTREAM_UNAVAILABLE",
          retryable: true,
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "network",
      failure_reason: "network_error",
      failure_phase: "stream",
      failure_exception_kind: "transport",
      provider_scope: "builtin",
      provider_id: "account:zai-individual-coding-plan",
      model_id: "glm-5",
      provider_kind: "anthropic",
      transport: "sse",
      status_code: 503,
      provider_error_code: "UPSTREAM_UNAVAILABLE",
      failure_retryable: true,
    });
    expect(payload.properties).not.toHaveProperty("attribution");
    expect(payload.properties).not.toHaveProperty("exceptionType");
  });

  it("normalizes provider rate-limit text for ARMS without changing the visible message", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "proxy: ERROR_RATE_LIMITED: Request higher limits to continue using this proxy",
      error: {
        code: "model_request_failed",
        message: "Model request failed.",
        attribution: {
          source: "provider",
          reason: "unknown",
          providerId: "my-proxy-provider",
          modelId: "proxy-model",
          providerKind: "anthropic",
          transport: "sse",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      failure_reason: "rate_limited",
      error_message: "proxy: ERROR_RATE_LIMITED: Request higher limits to continue using this proxy",
      provider_scope: "custom",
      provider_id: "custom",
      model_id: "custom",
    });
  });

  it("normalizes known plan-expired and balance errors for ARMS only", () => {
    const planExpired = buildChatErrorBannerTelemetryPayload({
      displayMessage: "[1309] Coding Plan expired",
      error: {
        code: "1309",
        message: "[1309] Coding Plan expired",
        attribution: {
          source: "provider",
          reason: "unknown",
          providerId: "account:bigmodel-individual-coding-plan",
          providerErrorCode: "1309",
          statusCode: 429,
        },
      },
      providerBusinessRecoveryAction: null,
    });
    const insufficientBalance = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Insufficient Balance",
      error: {
        code: "invalid_request_error",
        message: "Insufficient Balance",
        attribution: {
          source: "provider",
          reason: "unknown",
          providerErrorCode: "invalid_request_error",
          statusCode: 402,
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(planExpired.properties?.failure_reason).toBe("plan_expired");
    expect(insufficientBalance.properties?.failure_reason).toBe("balance_insufficient");
  });

  it("does not apply BigModel business-code meanings to another provider", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Provider request failed",
      error: {
        code: "model_request_failed",
        message: "Provider request failed",
        attribution: {
          source: "provider",
          reason: "unknown",
          providerId: "custom:another-provider",
          providerErrorCode: "1309",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties?.failure_reason).toBe("unknown");
  });

  it("keeps an existing structured reason authoritative", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Provider request failed",
      error: {
        code: "model_request_failed",
        message: "Provider request failed",
        attribution: {
          source: "provider",
          reason: "server_error",
          statusCode: 429,
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties?.failure_reason).toBe("server_error");
  });

  it("normalizes a trusted terminal quota code without changing adapter retry facts", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "[1308] usage limit reached",
      error: {
        code: "model_rate_limited",
        message: "[1308] usage limit reached",
        attribution: {
          source: "provider",
          reason: "rate_limited",
          providerId: "account:zai-individual-coding-plan",
          providerErrorCode: "1308",
          retryable: false,
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "quota_exhausted",
      failure_retryable: false,
      provider_error_code: "1308",
    });
  });

  it("prefers a trusted provider quota code over a conflicting controlled message", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "请求过于频繁，请稍后重试",
      error: {
        code: "model_rate_limited",
        message: "请求过于频繁，请稍后重试",
        attribution: {
          source: "provider",
          reason: "unknown",
          providerId: "account:zai-individual-coding-plan",
          providerErrorCode: "1308",
          retryable: false,
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "quota_exhausted",
    });
  });

  it("uses generic HTTP evidence when the adapter reason is unknown", () => {
    const cases = [
      { statusCode: 429, expected: "rate_limited" },
      { statusCode: 503, expected: "server_error" },
      { statusCode: 404, expected: "model_not_found" },
      { statusCode: 410, expected: "model_not_found" },
      { statusCode: 400, expected: "invalid_request" },
    ] as const;

    for (const testCase of cases) {
      const payload = buildChatErrorBannerTelemetryPayload({
        displayMessage: "Provider request failed",
        error: {
          code: "model_request_failed",
          message: "Model request failed.",
          attribution: {
            source: "provider",
            reason: "unknown",
            statusCode: testCase.statusCode,
          },
        },
        providerBusinessRecoveryAction: null,
      });

      expect(payload.properties?.failure_reason).toBe(testCase.expected);
    }
  });

  it("preserves an empty reason for errors without structured attribution or a known message", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "An unexpected failure occurred",
      error: {
        code: "SEND_FAILED",
        message: "An unexpected failure occurred",
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties?.failure_reason).toBe("");
  });

  it("projects stable runtime wrapper errors into the new attribution schema", () => {
    const modelConfigMissing = buildChatErrorBannerTelemetryPayload({
      displayMessage: "当前没有可用模型。请开通编程套餐或配置自定义模型。",
      error: {
        code: "model_config_missing",
        message: "No usable model provider is configured.",
      },
      providerBusinessRecoveryAction: null,
    });
    const recoveryDiscarded = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Partial assistant output was discarded before a streaming retry.",
      error: {
        code: "StreamRecoveryDiscarded",
        message: "Partial assistant output was discarded before a streaming retry.",
      },
      providerBusinessRecoveryAction: null,
    });

    expect(modelConfigMissing.properties).toMatchObject({
      error_source: "runtime",
      failure_reason: "model_config_missing",
    });
    expect(recoveryDiscarded.properties).toMatchObject({
      error_source: "runtime",
      failure_reason: "stream_recovery_discarded",
    });
  });

  it("restores local attribution for a legacy model capability validation error", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Model does not support image input",
      error: {
        code: "invalid_model_request",
        message: "Model does not support image input",
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "runtime",
      failure_reason: "invalid_request",
    });
  });

  it.each([
    ["1210", "invalid_request"],
    ["1211", "model_not_found"],
    ["1214", "model_not_found"],
    ["1301", "invalid_request"],
    ["1305", "rate_limited"],
    ["1308", "quota_exhausted"],
    ["1310", "quota_exhausted"],
  ])(
    "restores provider attribution from a strict legacy %s envelope",
    (providerCode, expectedReason) => {
      const message = `[${providerCode}][legacy provider failure][request-1234]`;
      const payload = buildChatErrorBannerTelemetryPayload({
        displayMessage: message,
        error: { code: "AiSdkModelAdapterError", message },
        providerBusinessRecoveryAction: null,
      });

      expect(payload.properties).toMatchObject({
        error_source: "provider",
        failure_reason: expectedReason,
      });
    },
  );

  it("restores network attribution from a legacy provider 1234 envelope", () => {
    const message = "[1234][internal network error][request-1234]";
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: message,
      error: { code: "AiSdkModelAdapterError", message },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "network",
      failure_reason: "network_error",
    });
  });

  it("restores a strict provider envelope after the wrapper code was replaced by its own code", () => {
    const message = "[1301][provider safety rejection][request-1234]";
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: message,
      error: {
        code: "1301",
        message,
        attribution: {
          source: "provider",
          reason: "unknown",
          providerId: "custom",
          providerErrorCode: "1301",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "invalid_request",
    });
  });

  it("normalizes remaining controlled production messages without a catch-all fallback", () => {
    const cases = [
      {
        name: "plan access",
        message:
          "Request was rejected due to reason: user is not allowed to access, reason: Action plan limited .",
        expected: { error_source: "provider", failure_reason: "plan_access_denied" },
      },
      {
        name: "stream stalled",
        message: "Model stream stalled: no event received for 600000ms.",
        expected: { error_source: "network", failure_reason: "stream_idle_timeout" },
      },
      {
        name: "authorization missing",
        message: "Authorization Not Found",
        expected: { error_source: "provider", failure_reason: "auth_failed" },
      },
      {
        name: "local auth unavailable",
        message: "auth_unavailable: no auth available (providers=proxy, model=default)",
        expected: { error_source: "runtime", failure_reason: "provider_not_configured" },
      },
      {
        name: "local API key missing",
        message: "Model provider is missing an API key: zai",
        expected: { error_source: "runtime", failure_reason: "provider_not_configured" },
      },
      {
        name: "provider body deserialize",
        message:
          "Failed to deserialize the JSON body into the target type: messages[97]: unknown variant `image_url`, expected `text`",
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "reasoning effort",
        message: "field ReasoningEffort invalid, should be one of: low, medium, high",
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "function call unsupported",
        message: "Function call is not supported for this model.",
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "vision model unsupported",
        message: "The model is not a VLM (Vision Language Model). Please use text-only prompts.",
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "Chinese usage limit",
        message: "已达到 5 小时的使用上限。您的限额将在稍后重置。",
        expected: { error_source: "provider", failure_reason: "quota_exhausted" },
      },
      {
        name: "connect EACCES",
        message: "Cannot connect to API: connect EACCES 127.0.0.1:443",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "self-signed certificate",
        message: "Cannot connect to API: self-signed certificate in certificate chain",
        expected: { error_source: "network", failure_reason: "tls_error" },
      },
      {
        name: "TLS key usage failure",
        message: "Cannot connect to API: SSL routines: KEY_USAGE_BIT_INCORRECT",
        expected: { error_source: "network", failure_reason: "tls_error" },
      },
      {
        name: "upstream unavailable",
        message: "Upstream service temporarily unavailable. Please retry your request.",
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "provider capacity",
        message: "The model is currently at capacity due to high demand.",
        expected: { error_source: "provider", failure_reason: "provider_overloaded" },
      },
      {
        name: "Chinese request frequency",
        message: "请求过于频繁, 请稍后再试",
        expected: { error_source: "provider", failure_reason: "rate_limited" },
      },
      {
        name: "premature stream end",
        message: "Upstream stream ended without a terminal marker",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "session already in flight",
        message: "session 123e4567-e89b-12d3-a456-426614174000 is already in flight",
        expected: { error_source: "provider", failure_reason: "rate_limited" },
      },
      {
        name: "provider-owned server failure",
        message:
          "[PokeAPI] 服务暂时无法完成请求，请稍后重试；若持续发生，请向管理员提供请求 ID。 责任方：服务端。",
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "DNS lookup failure",
        message: "Cannot connect to API: getaddrinfo ENOENT zcode.z.ai",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "free model balance requirement",
        message:
          "To prevent abuse, your account must have a balance greater than $0; no credits will be deducted.",
        expected: { error_source: "provider", failure_reason: "balance_insufficient" },
      },
      {
        name: "embedded provider 400",
        message:
          'Engine protocol predict request returned 400: {"error":{"code":400,"message":"failed to parse grammar","type":"invalid_request_error"}}',
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "invalid provider tool input",
        message: "Model returned invalid tool input. Please retry.",
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "provider model crash",
        message: "The model has crashed without additional information. (Exit code: null)",
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "stream terminated",
        message: "Upstream stream terminated unexpectedly before completion",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "truncated upstream response",
        message: "upstream truncated response without stop reason",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "server disconnected",
        message: "Server disconnected without sending a response.",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "Chinese stream failure",
        message: "Responses 流式调用失败",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "Chinese concurrency limit",
        message: "当前账号并发数已达到上限，请等待其他请求完成后重试。",
        expected: { error_source: "provider", failure_reason: "rate_limited" },
      },
      {
        name: "budget exhausted",
        message: "Budget has been exceeded! Current cost: 818, Max budget: 800",
        expected: { error_source: "provider", failure_reason: "quota_exhausted" },
      },
      {
        name: "account arrears",
        message:
          "The account associated with the API Key is in arrears. Please top up the account and re-enable the service.",
        expected: { error_source: "provider", failure_reason: "balance_insufficient" },
      },
      {
        name: "embedded provider 500",
        message:
          'Engine protocol predict stream returned an error: {"code":500,"message":"ErrorDeviceLost","type":"server_error"}',
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "invalid generated tool call",
        message: "Failed to generate a valid tool call.",
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "provider rejected input",
        message:
          "The model rejected this request. It may not support the input you sent or a parameter is invalid.",
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "upstream access forbidden",
        message: "Upstream access forbidden, please contact administrator",
        expected: { error_source: "provider", failure_reason: "auth_failed" },
      },
      {
        name: "resource access denied",
        message: "You do not have access to this resource.",
        expected: { error_source: "provider", failure_reason: "auth_failed" },
      },
      {
        name: "Chinese service unavailable",
        message: "GLM-5.2 服务暂时不可用，请稍后重试",
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "backend generation fatal exception",
        message: "Encountered fatal exception in the backend generation thread: Traceback",
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "legacy 500 operation failure",
        message: "[500][操作失败][request-1234]",
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "embedded LiteLLM bad request",
        message:
          'litellm.BadRequestError: {"type":"error","error":{"type":"invalid_request_error","message":"Tool name exceeds limit"}}',
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "embedded model not found",
        message:
          '{"type":"error","error":{"type":"NotFoundError","message":"The model does not exist."}}',
        expected: { error_source: "provider", failure_reason: "model_not_found" },
      },
      {
        name: "credit exhausted",
        message: '402 Payment Required: {"status":402,"message":"您的Credit已耗尽"}',
        expected: { error_source: "provider", failure_reason: "balance_insufficient" },
      },
      {
        name: "provider 502 response failure",
        message: "502 服务响应内容异常，结果为空、不完整或不符合接口响应格式。",
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "conversation length limit",
        message: "达到对话长度上限，请开启新对话",
        expected: { error_source: "provider", failure_reason: "context_exceeded" },
      },
      {
        name: "no active subscription",
        message: "当前账号没有可用套餐，请完成订购或续费后重试。",
        expected: { error_source: "provider", failure_reason: "plan_access_denied" },
      },
      {
        name: "subscription not activated",
        message: "当前账户暂无生效套餐，请前往钱包页面激活订阅",
        expected: { error_source: "provider", failure_reason: "plan_access_denied" },
      },
      {
        name: "stream inference internal error",
        message: "流式推理过程中发生内部错误。",
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "weekly budget exhausted",
        message: "您的本周预算已用尽，请下周重试或联系负责人充值。",
        expected: { error_source: "provider", failure_reason: "quota_exhausted" },
      },
      {
        name: "upstream stream idle",
        message: "上游流式响应长时间无数据",
        expected: { error_source: "network", failure_reason: "stream_idle_timeout" },
      },
      {
        name: "CodeBuddy stream idle",
        message: "CodeBuddy CLI produced no stream output for 180000ms",
        expected: { error_source: "network", failure_reason: "stream_idle_timeout" },
      },
      {
        name: "Codex websocket stream failure",
        message: "Codex responses websocket stream error:",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "daily cost limit",
        message: "Daily cost limit reached (used $5.00)",
        expected: { error_source: "provider", failure_reason: "quota_exhausted" },
      },
      {
        name: "free model recharge required",
        message: "福利版模型需先充值后调用",
        expected: { error_source: "provider", failure_reason: "balance_insufficient" },
      },
      {
        name: "engine fetch failure",
        message: "Engine protocol predict request failed: fetch failed",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "plan subscription missing",
        message: "无API调用权限（未订阅相关codeplan或资源包）",
        expected: { error_source: "provider", failure_reason: "plan_access_denied" },
      },
      {
        name: "provider capacity expansion",
        message: "业务申请资源不足，平台申请扩容",
        expected: { error_source: "provider", failure_reason: "provider_overloaded" },
      },
      {
        name: "explicit server error",
        message: "A server error occurred. Please try again.",
        expected: { error_source: "provider", failure_reason: "server_error" },
      },
      {
        name: "credentials cooling down",
        message: "All credentials for model z-ai/glm are cooling down",
        expected: { error_source: "provider", failure_reason: "rate_limited" },
      },
      {
        name: "media count exceeded",
        message: "Antigravity media item count was exceeded.",
        expected: { error_source: "provider", failure_reason: "invalid_request" },
      },
      {
        name: "balance depleted",
        message: "API key denied: balance_depleted",
        expected: { error_source: "provider", failure_reason: "balance_insufficient" },
      },
      {
        name: "empty connect failure",
        message: "Cannot connect to API:",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "stream read text fallback",
        message: "stream_read_error",
        expected: { error_source: "network", failure_reason: "network_error" },
      },
      {
        name: "off-peak continuation marker",
        message: "off-peak-ticket-expired: wrong off-peak ticket",
        expected: { error_source: "runtime", failure_reason: "offpeak_ticket_expired" },
      },
    ] as const;

    for (const testCase of cases) {
      const payload = buildChatErrorBannerTelemetryPayload({
        displayMessage: testCase.message,
        error: {
          code: "AiSdkModelAdapterError",
          message: testCase.message,
          attribution: { source: "provider", reason: "unknown" },
        },
        providerBusinessRecoveryAction: null,
      });

      expect(payload.properties, testCase.name).toMatchObject(testCase.expected);
    }
  });

  it("uses request evidence to split HTTP 413 instead of treating the status as one reason", () => {
    const cases = [
      {
        message: "Chat history exceeds the 800-message limit; compact and retry.",
        expectedReason: "context_exceeded",
      },
      {
        message: "request body exceeds the configured payload limit",
        expectedReason: "invalid_request",
      },
    ] as const;

    for (const testCase of cases) {
      const payload = buildChatErrorBannerTelemetryPayload({
        displayMessage: testCase.message,
        error: {
          code: "AiSdkModelAdapterError",
          message: testCase.message,
          attribution: {
            source: "provider",
            reason: "unknown",
            statusCode: 413,
          },
        },
        providerBusinessRecoveryAction: null,
      });

      expect(payload.properties).toMatchObject({
        error_source: "provider",
        failure_reason: testCase.expectedReason,
      });
    }
  });

  it("does not broaden controlled rules into ambiguous custom or local failures", () => {
    const customNumeric = buildChatErrorBannerTelemetryPayload({
      displayMessage: "custom provider rate policy",
      error: {
        code: "model_rate_limited",
        message: "custom provider rate policy",
        attribution: {
          source: "provider",
          reason: "rate_limited",
          providerId: "custom-provider",
          providerErrorCode: "1308",
          retryable: false,
        },
      },
      providerBusinessRecoveryAction: null,
    });
    const localEacces = buildChatErrorBannerTelemetryPayload({
      displayMessage: "EACCES: permission denied, open '/tmp/input'",
      error: {
        code: "EACCES",
        message: "EACCES: permission denied, open '/tmp/input'",
      },
      providerBusinessRecoveryAction: null,
    });
    const unknownEnvelope = buildChatErrorBannerTelemetryPayload({
      displayMessage: "[9999][legacy failure][request-1234]",
      error: {
        code: "AiSdkModelAdapterError",
        message: "[9999][legacy failure][request-1234]",
      },
      providerBusinessRecoveryAction: null,
    });
    const localUsageLimit = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Local runtime usage limit reached",
      error: {
        code: "LOCAL_LIMIT",
        message: "Local runtime usage limit reached",
        attribution: { source: "runtime", reason: "unknown" },
      },
      providerBusinessRecoveryAction: null,
    });
    const ambiguousResourceExhausted = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Provider request failed",
      error: {
        code: "AiSdkModelAdapterError",
        message: "Provider request failed",
        attribution: {
          source: "provider",
          reason: "unknown",
          providerErrorCode: "resource-exhausted",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(customNumeric.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "rate_limited",
    });
    expect(localEacces.properties).toMatchObject({
      error_source: "",
      failure_reason: "",
    });
    expect(unknownEnvelope.properties).toMatchObject({
      error_source: "",
      failure_reason: "",
    });
    expect(localUsageLimit.properties).toMatchObject({
      error_source: "runtime",
      failure_reason: "quota_exhausted",
    });
    expect(ambiguousResourceExhausted.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "unknown",
    });
  });

  it.each([
    ["思考中...", "get_channel_failed"],
    ["Provider returned a business error.", "PROVIDER_BUSINESS_ERROR"],
    ["gateway request survival ended: committed_output", "gateway_survival_resume_blocked"],
    ["openai_error", "bad_response_status_code"],
    ["Request could not be completed", undefined],
    ["terminated", undefined],
    ["aborted", undefined],
    ["Upstream request failed", undefined],
  ])("keeps ambiguous production evidence unknown: %s", (message, providerErrorCode) => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: message,
      error: {
        code: "AiSdkModelAdapterError",
        message,
        attribution: {
          source: "provider",
          reason: "unknown",
          ...(providerErrorCode ? { providerErrorCode } : {}),
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "unknown",
    });
  });

  it("rejects a legacy envelope whose outer code conflicts with the envelope code", () => {
    const message = "[1301][provider safety rejection][request-1234]";
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: message,
      error: {
        code: "1305",
        message,
        attribution: {
          source: "provider",
          reason: "unknown",
          providerId: "custom",
          providerErrorCode: "1301",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "unknown",
    });
  });

  it("infers provider source for an adapter wrapper when no attribution survived", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Provider rejected the model request.",
      error: {
        code: "AiSdkModelAdapterError",
        message: "Provider rejected the model request.",
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "invalid_request",
    });
  });

  it("keeps known runtime attribution reasons out of the provider bucket", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "上下文压缩过快，暂时无法继续。",
      error: {
        code: "MODEL_CONTEXT_EXCEEDED",
        message: "Context compaction stopped by rapid refill breaker.",
        attribution: { reason: "compact_rapid_refill_breaker" },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "runtime",
      failure_reason: "compact_rapid_refill_breaker",
    });
  });

  it("keeps source-less network reasons in the network bucket", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Proxy connection failed for the provider request.",
      error: {
        code: "model_request_failed",
        message: "Proxy connection failed for the provider request.",
        attribution: { reason: "proxy_error" },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "network",
      failure_reason: "proxy_error",
    });
  });

  it.each([
    "EPIPE",
    "ECONNABORTED",
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EADDRNOTAVAIL",
    "EADDRINUSE",
    "ENOBUFS",
    "ENOTCONN",
    "UND_ERR_SOCKET",
  ])(
    "lets stable transport code %s correct a coarse provider/unknown attribution",
    (providerErrorCode) => {
      const payload = buildChatErrorBannerTelemetryPayload({
        displayMessage: "Provider request failed",
        error: {
          code: "model_request_failed",
          message: "Provider request failed",
          attribution: {
            source: "provider",
            reason: "unknown",
            providerErrorCode,
            transport: "sse",
          },
        },
        providerBusinessRecoveryAction: null,
      });

      expect(payload.properties).toMatchObject({
        error_source: "network",
        failure_reason: "network_error",
      });
    },
  );

  it.each([
    "ETIMEDOUT",
    "ETIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ])(
    "lets stable timeout code %s correct a coarse provider/unknown attribution",
    (providerErrorCode) => {
      const payload = buildChatErrorBannerTelemetryPayload({
        displayMessage: "Provider request failed",
        error: {
          code: "model_request_failed",
          message: "Provider request failed",
          attribution: {
            source: "provider",
            reason: "unknown",
            providerErrorCode,
            transport: "sse",
          },
        },
        providerBusinessRecoveryAction: null,
      });

      expect(payload.properties).toMatchObject({
        error_source: "network",
        failure_reason: "timeout",
      });
    },
  );

  it.each([
    ["service_unavailable", "provider", "server_error"],
    ["server_error", "provider", "server_error"],
    ["upstream_server_error", "provider", "server_error"],
    ["UPSTREAM_UNAVAILABLE", "provider", "server_error"],
    ["no_capacity", "provider", "provider_overloaded"],
    ["stream_read_error", "network", "network_error"],
    ["upstream_http2_stream_error", "network", "network_error"],
    ["request_timeout", "network", "timeout"],
    ["invalid_parameter_error", "provider", "invalid_request"],
    ["invalid_tool_call", "provider", "invalid_request"],
    ["MODEL_CAPABILITY_NOT_SUPPORTED", "provider", "invalid_request"],
    ["cyber_policy", "provider", "invalid_request"],
    ["request_too_large", "provider", "invalid_request"],
    ["chat_history_too_large", "provider", "context_exceeded"],
    ["model_deprecated", "provider", "model_not_found"],
    ["INSUFFICIENT_BALANCE", "provider", "balance_insufficient"],
    ["UPSTREAM_NOT_FOUND", "provider", "model_not_found"],
    ["quota_limit", "provider", "quota_exhausted"],
    ["invalid_input", "provider", "invalid_request"],
    ["validation_error", "provider", "invalid_request"],
    ["internal_server_error", "provider", "server_error"],
    ["gateway_stream_terminated", "network", "network_error"],
    ["ERR_INVALID_URL", "runtime", "invalid_input"],
  ])(
    "normalizes generic provider code %s into an atomic attribution",
    (providerErrorCode, expectedSource, expectedReason) => {
      const payload = buildChatErrorBannerTelemetryPayload({
        displayMessage: "Provider request failed",
        error: {
          code: "AiSdkModelAdapterError",
          message: "Provider request failed",
          attribution: {
            source: "provider",
            reason: "unknown",
            providerErrorCode,
            transport: "sse",
          },
        },
        providerBusinessRecoveryAction: null,
      });

      expect(payload.properties).toMatchObject({
        error_source: expectedSource,
        failure_reason: expectedReason,
      });
    },
  );

  it("keeps source-less provider configuration failures in the runtime bucket", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "The selected provider is not configured.",
      error: {
        code: "model_provider_not_configured",
        message: "The selected provider is not configured.",
        attribution: { reason: "provider_not_configured" },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "runtime",
      failure_reason: "provider_not_configured",
    });
  });

  it.each([
    ["network_error", "network"],
    ["provider_not_configured", "runtime"],
  ])(
    "uses the unambiguous %s reason instead of a coarse provider source",
    (reason, expectedSource) => {
      const payload = buildChatErrorBannerTelemetryPayload({
        displayMessage: "Provider request failed",
        error: {
          code: "AiSdkModelAdapterError",
          message: "Provider request failed",
          attribution: { source: "provider", reason },
        },
        providerBusinessRecoveryAction: null,
      });

      expect(payload.properties).toMatchObject({
        error_source: expectedSource,
        failure_reason: reason,
      });
    },
  );

  it("keeps ambiguous source-less reasons unassigned without upstream evidence", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Invalid parameter in local model configuration.",
      error: {
        code: "invalid_model_configuration",
        message: "Invalid parameter in local model configuration.",
        attribution: { reason: "invalid_request" },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "",
      failure_reason: "invalid_request",
    });
  });

  it("keeps local queue rate limits unassigned without provider evidence", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Request queue is full.",
      error: {
        code: "REQUEST_QUEUE_FULL",
        message: "Request queue is full.",
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "",
      failure_reason: "rate_limited",
    });
  });

  it("uses controlled provider text to source a structured rate limit", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Too many requests. Try again later.",
      error: {
        code: "model_rate_limited",
        message: "Too many requests. Try again later.",
        attribution: { reason: "rate_limited" },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "rate_limited",
    });
  });

  it("uses HTTP evidence to assign provider source for an ambiguous reason", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Provider rejected the model request.",
      error: {
        code: "model_request_failed",
        message: "Provider rejected the model request.",
        attribution: { reason: "unknown", statusCode: 400 },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "invalid_request",
    });
  });

  it("uses timeout status as atomic network evidence over a coarse provider source", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Gateway timeout",
      error: {
        code: "AiSdkModelAdapterError",
        message: "Gateway timeout",
        attribution: {
          source: "provider",
          reason: "unknown",
          statusCode: 504,
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "network",
      failure_reason: "timeout",
    });
  });

  it("prefers an HTTP auth status over a conflicting controlled rate-limit message", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "请求过于频繁，请稍后重试",
      error: {
        code: "model_request_failed",
        message: "请求过于频繁，请稍后重试",
        attribution: {
          source: "provider",
          reason: "unknown",
          statusCode: 401,
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "provider",
      failure_reason: "auth_failed",
    });
  });

  it("normalizes provider evidence that previously remained unknown", () => {
    const cases = [
      {
        name: "BigModel safety rejection",
        message: "[1301][Sensitive content rejected]",
        error: {
          code: "model_request_failed",
          message: "[1301][Sensitive content rejected]",
          attribution: {
            source: "provider" as const,
            reason: "unknown",
            providerId: "account:bigmodel-individual-coding-plan",
            providerErrorCode: "1301",
          },
        },
      },
      {
        name: "generic provider bad request",
        message: "No endpoints found that support image input",
        error: {
          code: "AiSdkModelAdapterError",
          message: "No endpoints found that support image input",
          attribution: {
            source: "provider" as const,
            reason: "unknown",
            providerId: "custom-provider",
            providerErrorCode: "BAD_REQUEST",
          },
        },
      },
      {
        name: "provider method not allowed",
        message: "method not allowed",
        error: {
          code: "AiSdkModelAdapterError",
          message: "method not allowed",
          attribution: {
            source: "provider" as const,
            reason: "unknown",
            providerId: "account:zai-start-plan",
            providerErrorCode: "3012",
            statusCode: 405,
          },
        },
      },
    ] as const;

    for (const testCase of cases) {
      const payload = buildChatErrorBannerTelemetryPayload({
        displayMessage: testCase.message,
        error: testCase.error,
        providerBusinessRecoveryAction: null,
      });

      expect(payload.properties, testCase.name).toMatchObject({
        error_source: "provider",
        failure_reason: "invalid_request",
      });
    }
  });

  it("does not invent a reason for an evidence-free unknown adapter failure", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "Model request failed.",
      error: {
        code: "model_request_failed",
        message: "Model request failed.",
        attribution: {
          source: "runtime",
          reason: "unknown",
          providerId: "account:zai-start-plan",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      error_source: "runtime",
      failure_reason: "unknown",
    });
  });

  it("normalizes non-allowlisted model ids from builtin providers", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "请求失败",
      error: {
        code: "model_request_failed",
        message: "failed",
        attribution: {
          source: "provider",
          providerId: "account:zai-individual-coding-plan",
          modelId: "customer-internal-model-name",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      provider_scope: "builtin",
      provider_id: "account:zai-individual-coding-plan",
      model_id: "custom",
    });
    expect(Object.values(payload.properties ?? {})).not.toContain("customer-internal-model-name");
  });

  it("normalizes custom provider ids instead of uploading user-defined names", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "请求失败",
      error: {
        code: "model_request_failed",
        message: "failed",
        attribution: {
          source: "provider",
          providerId: "my-private-provider-name",
          modelId: "my-private-model-name",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      provider_scope: "custom",
      provider_id: "custom",
      model_id: "custom",
    });
    expect(Object.values(payload.properties ?? {})).not.toContain("my-private-provider-name");
    expect(Object.values(payload.properties ?? {})).not.toContain("my-private-model-name");
  });

  it("does not upload a model id when provider attribution is missing", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "请求失败",
      error: {
        code: "model_request_failed",
        message: "failed",
        attribution: {
          source: "runtime",
          modelId: "orphan-private-model-name",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      provider_scope: "unknown",
      provider_id: "",
      model_id: "",
    });
    expect(Object.values(payload.properties ?? {})).not.toContain("orphan-private-model-name");
  });

  it("keeps model id empty when builtin provider attribution has no model", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      displayMessage: "请求失败",
      error: {
        code: "model_request_failed",
        message: "failed",
        attribution: {
          source: "runtime",
          providerId: "account:zai-individual-coding-plan",
        },
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload.properties).toMatchObject({
      provider_scope: "builtin",
      provider_id: "account:zai-individual-coding-plan",
      model_id: "",
    });
  });

  it("keeps the same event and group while distinguishing session subscription errors", () => {
    const payload = buildChatErrorBannerTelemetryPayload({
      surface: "session_subscription_error",
      errorKey: "session-1:fault.subscribe.sessionNotFound",
      displayMessage:
        "Session is not active and not persisted: session-1 (fault.subscribe.sessionNotFound)",
      error: {
        code: "fault.subscribe.sessionNotFound",
        message:
          "Session is not active and not persisted: session-1 (fault.subscribe.sessionNotFound)",
        taskId: "session-1",
      },
      providerBusinessRecoveryAction: null,
    });

    expect(payload).toMatchObject({
      name: CHAT_ERROR_BANNER_ARMS_EVENT_NAME,
      group: CHAT_ERROR_BANNER_ARMS_GROUP,
      properties: {
        surface: "session_subscription_error",
        error_code: "fault.subscribe.sessionNotFound",
        task_id: "session-1",
      },
    });
  });

  it("reports through the ARMS custom event channel instead of app telemetry", async () => {
    const reportArmsCustomEvent = vi.fn(async () => {});
    const reportTelemetryEvent = vi.fn(async () => {});
    const platform = {
      reportArmsCustomEvent,
      reportTelemetryEvent,
    } as unknown as IPlatformService;

    await reportChatErrorBannerTelemetry(platform, {
      errorKey: "workspace:SEND_FAILED",
      displayMessage: "A prompt is already running for this session",
      error: {
        code: "SEND_FAILED",
        message: "A prompt is already running for this session",
      },
      providerBusinessRecoveryAction: null,
    });

    expect(reportTelemetryEvent).not.toHaveBeenCalled();
    expect(reportArmsCustomEvent).toHaveBeenCalledTimes(1);
    expect(reportArmsCustomEvent.mock.calls[0]?.[0]).toMatchObject({
      name: CHAT_ERROR_BANNER_ARMS_EVENT_NAME,
      group: CHAT_ERROR_BANNER_ARMS_GROUP,
      value: 1,
      properties: {
        surface: "chat_input_error_banner",
        error_key: expect.stringMatching(
          /^no-task:SEND_FAILED:no-trace:no-action:no-provider-code:[0-9a-f]{8}$/,
        ),
        error_code: "SEND_FAILED",
        error_message: "A prompt is already running for this session",
      },
    });
  });
});
