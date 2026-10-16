import { describe, expect, it } from "vitest";
import { ModelErrorCode, ModelFailureReason, ModelRetryBudget } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "../src/model/errors.js";
import type { ClassifiedModelFailure } from "../src/model/failure-classifier.js";
import {
  inspectWorkflowModelFailure,
  resolveWorkflowModelFailurePolicy,
  retryAllowedByFailurePolicy,
  WORKFLOW_QUOTA_PROVIDER_CODES,
} from "../src/model/workflow-model-failure-policy.js";

// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Terminal states」：Stop 集逐行一例，其余一切 retry。
function failure(
  overrides: Partial<ClassifiedModelFailure> & Pick<ClassifiedModelFailure, "reason">,
): ClassifiedModelFailure {
  return {
    code: ModelErrorCode.ModelRequestFailed,
    message: "x",
    retryReason: "network_error",
    retryable: false,
    ...overrides,
  };
}

describe("resolveWorkflowModelFailurePolicy", () => {
  it("Stop 集：认证 / 未配置 / 模型不可用 / 请求无效 / 配额", () => {
    expect(
      resolveWorkflowModelFailurePolicy(failure({ reason: ModelFailureReason.AuthFailed }), "1006"),
    ).toEqual({
      decision: "stop",
      kind: "auth",
    });
    expect(
      resolveWorkflowModelFailurePolicy(failure({ reason: ModelFailureReason.AuthFailed }), "3007"),
    ).toEqual({
      decision: "stop",
      kind: "auth",
    });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ reason: ModelFailureReason.ProviderNotConfigured }),
        undefined,
      ),
    ).toEqual({ decision: "stop", kind: "not_configured" });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ code: ModelErrorCode.ModelConfigMissing, reason: ModelFailureReason.Unknown }),
        undefined,
      ),
    ).toEqual({ decision: "stop", kind: "not_configured" });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ code: ModelErrorCode.ModelNotFound, reason: ModelFailureReason.InvalidRequest }),
        "3006",
      ),
    ).toEqual({ decision: "stop", kind: "model_unavailable" });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({
          code: ModelErrorCode.InvalidModelRequest,
          reason: ModelFailureReason.InvalidRequest,
        }),
        "3001",
      ),
    ).toEqual({ decision: "stop", kind: "invalid_request" });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({
          code: ModelErrorCode.InvalidModelRequest,
          reason: ModelFailureReason.InvalidRequest,
          statusCode: 400,
        }),
        undefined,
      ),
    ).toEqual({ decision: "stop", kind: "invalid_request" });
    for (const code of WORKFLOW_QUOTA_PROVIDER_CODES) {
      expect(
        resolveWorkflowModelFailurePolicy(
          failure({ reason: ModelFailureReason.RateLimited }),
          code,
        ),
      ).toEqual({
        decision: "stop",
        kind: "quota",
      });
    }
    // 1005 在分类器里是 invalid_request：配额按码判、先于 reason。
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ reason: ModelFailureReason.InvalidRequest }),
        "1005",
      ),
    ).toEqual({
      decision: "stop",
      kind: "quota",
    });
  });

  it("并发上限 3008/3009/3010 与其余一切都是 retry（含分类器判不可重试的）", () => {
    for (const code of ["3008", "3009", "3010"]) {
      expect(
        resolveWorkflowModelFailurePolicy(
          failure({
            code: ModelErrorCode.ModelRateLimited,
            reason: ModelFailureReason.RateLimited,
            retryable: false,
          }),
          code,
        ),
      ).toEqual({ decision: "retry" });
    }
    for (const reason of [
      ModelFailureReason.RateLimited,
      ModelFailureReason.ProviderOverloaded,
      ModelFailureReason.ServerError,
      ModelFailureReason.NetworkError,
      ModelFailureReason.Timeout,
      ModelFailureReason.StreamIdleTimeout,
      ModelFailureReason.Unknown,
      ModelFailureReason.TlsError,
      ModelFailureReason.ProxyError,
    ]) {
      expect(resolveWorkflowModelFailurePolicy(failure({ reason }), undefined)).toEqual({
        decision: "retry",
      });
    }
    for (const code of ["1008", "1314", "1315", "2007"]) {
      expect(
        resolveWorkflowModelFailurePolicy(failure({ reason: ModelFailureReason.Unknown }), code),
      ).toEqual({
        decision: "retry",
      });
    }
    // 响应解析失败也被分类器标成 invalid_request，但那不是 provider 拒绝请求：再问一次。
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({
          code: ModelErrorCode.InvalidModelResponse,
          reason: ModelFailureReason.InvalidRequest,
        }),
        undefined,
      ),
    ).toEqual({ decision: "retry" });
  });

  it("context exceeded 与 cancelled 各有自己的裁决", () => {
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ reason: ModelFailureReason.ContextExceeded }),
        "1261",
      ),
    ).toEqual({
      decision: "context_exceeded",
    });
    expect(
      resolveWorkflowModelFailurePolicy(
        failure({ reason: ModelFailureReason.Cancelled }),
        undefined,
      ),
    ).toEqual({
      decision: "cancelled",
    });
  });
});

describe("retryAllowedByFailurePolicy", () => {
  const busy = failure({
    code: ModelErrorCode.ModelRateLimited,
    reason: ModelFailureReason.RateLimited,
    retryable: false,
  });
  it("有界预算照旧读分类器的 retryable（主对话一字不动）", () => {
    expect(retryAllowedByFailurePolicy(busy, undefined, "3008")).toBe(false);
    expect(retryAllowedByFailurePolicy(busy, ModelRetryBudget.Default, "3008")).toBe(false);
    expect(retryAllowedByFailurePolicy({ ...busy, retryable: true }, undefined, undefined)).toBe(
      true,
    );
  });
  it("无上限预算读策略表", () => {
    expect(retryAllowedByFailurePolicy(busy, ModelRetryBudget.Unbounded, "3008")).toBe(true);
    expect(
      retryAllowedByFailurePolicy(
        failure({ reason: ModelFailureReason.AuthFailed }),
        ModelRetryBudget.Unbounded,
        "1006",
      ),
    ).toBe(false);
    expect(retryAllowedByFailurePolicy(busy, ModelRetryBudget.Unbounded, "1308")).toBe(false);
  });
});

describe("inspectWorkflowModelFailure", () => {
  it("按形状读 adapter 错误（直接或一层 cause），带出拼 ProviderStop 要的事实", () => {
    const adapterError = new AiSdkModelAdapterError(
      ModelErrorCode.ModelRateLimited,
      "[1308] 已达到 5 小时的使用上限",
      {
        context: {
          reason: "rate_limited",
          retryable: false,
          providerCode: 1308,
          providerId: "account:bigmodel-coding-plan",
          modelId: "glm-5.3",
          retryAfterMs: 60_000,
        },
      },
    );
    const direct = inspectWorkflowModelFailure(adapterError);
    expect(direct).toMatchObject({
      policy: { decision: "stop", kind: "quota" },
      reason: "rate_limited",
      providerCode: "1308",
      providerId: "account:bigmodel-coding-plan",
      modelId: "glm-5.3",
      rawMessage: "[1308] 已达到 5 小时的使用上限",
    });
    expect(direct?.resetAt).toBeGreaterThan(Date.now());
    const wrapped = new Error("Subagent turn failed", { cause: adapterError });
    expect(inspectWorkflowModelFailure(wrapped)?.policy).toEqual({
      decision: "stop",
      kind: "quota",
    });
  });

  it("并发上限是 retry；非模型层错误返回 undefined", () => {
    const busy = new AiSdkModelAdapterError(
      ModelErrorCode.ModelRateLimited,
      "user concurrency limit exceeded",
      {
        context: { reason: "rate_limited", retryable: false, providerCode: "3008" },
      },
    );
    expect(inspectWorkflowModelFailure(busy)).toMatchObject({
      policy: { decision: "retry" },
      providerCode: "3008",
    });
    expect(inspectWorkflowModelFailure(new Error("tool crashed"))).toBeUndefined();
    expect(inspectWorkflowModelFailure(undefined)).toBeUndefined();
    // 没有 reason 的 adapter 错误（构造期）也不归模型层。
    expect(
      inspectWorkflowModelFailure(
        new AiSdkModelAdapterError(ModelErrorCode.ModelRequestFailed, "x", { context: {} }),
      ),
    ).toBeUndefined();
  });
});
