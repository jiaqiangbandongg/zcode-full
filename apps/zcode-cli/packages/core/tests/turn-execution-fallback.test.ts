import { describe, expect, it } from "vitest";
import { ModelRetryBudget } from "@zcode/contracts";
import {
  matchExecutionSelectionFallback,
  resolveExecutionFallbackCandidates,
} from "../src/runtime/methods/turn-execution-fallback.js";
import { resolveExecutionModelRetryBudget } from "../src/runtime/methods/turn-model.js";

// docs/highspeed/highspeed-card-spec.md §2.2：加速请求任何失败都退回会话模型；卡过期按 3402 单独给原因。
const HIGHSPEED_PROVIDER_ID = "account:zai-highspeed-card";
const SESSION_PROVIDER_ID = "builtin:zai-coding-plan";
const CARD_EXPIRED_CODE = "3402";
const declaration = {
  providerId: HIGHSPEED_PROVIDER_ID,
  rules: [
    { reason: "highspeed_card_expired" as const, providerErrorCode: CARD_EXPIRED_CODE },
    { reason: "highspeed_request_failed" as const },
  ],
};

/** adapter 归一化后的错误形状：归因字段都在 context 里。 */
function adapterError(
  context: Record<string, unknown>,
  message = "Model request failed.",
  code = "model_request_failed",
): Error {
  return Object.assign(new Error(message), {
    code,
    context: {
      providerId: HIGHSPEED_PROVIDER_ID,
      modelId: "GLM-5.3",
      source: "provider",
      ...context,
    },
    name: "AiSdkModelAdapterError",
  });
}

function match(
  error: unknown,
  overrides: Partial<Parameters<typeof matchExecutionSelectionFallback>[0]> = {},
) {
  return matchExecutionSelectionFallback({
    error,
    executionProviderId: HIGHSPEED_PROVIDER_ID,
    selectionFallback: declaration,
    turnAborted: false,
    ...overrides,
  });
}

describe("matchExecutionSelectionFallback", () => {
  it("卡过期错误码命中首条规则，原因为 highspeed_card_expired 并带回归因", () => {
    expect(match(adapterError({ providerCode: CARD_EXPIRED_CODE, statusCode: 400 }))).toEqual({
      reason: "highspeed_card_expired",
      providerErrorCode: CARD_EXPIRED_CODE,
      statusCode: 400,
    });
  });

  it.each([
    ["401 鉴权失败", { statusCode: 401, reason: "auth_failed", retryable: false }],
    ["429 限流", { statusCode: 429, reason: "rate_limited", retryable: true }],
    ["5xx", { statusCode: 503, reason: "server_error", retryable: true }],
    ["网络错误（无 HTTP 状态、无业务码）", { reason: "network_error", retryable: true }],
    ["流空闲超时", { reason: "stream_idle_timeout", retryable: true }],
    ["其他业务码", { providerCode: "1234", statusCode: 400 }],
  ])("%s 命中兜底规则，原因为 highspeed_request_failed", (_label, context) => {
    expect(match(adapterError(context))?.reason).toBe("highspeed_request_failed");
  });

  it("没有声明、用户取消或本步模型不是声明 provider 时不退回", () => {
    const error = adapterError({ statusCode: 500 });
    expect(match(error, { selectionFallback: undefined })).toBeUndefined();
    expect(match(error, { turnAborted: true })).toBeUndefined();
    expect(match(error, { executionProviderId: SESSION_PROVIDER_ID })).toBeUndefined();
  });

  it("失败归因明确指向其他 provider 时不退回", () => {
    expect(
      match(adapterError({ providerId: SESSION_PROVIDER_ID, statusCode: 500 })),
    ).toBeUndefined();
  });

  it("无上游归因或归因为本地 runtime 的失败不退回", () => {
    expect(match(new Error("event store append failed"))).toBeUndefined();
    expect(
      match(adapterError({ source: "runtime", reason: "persistence_failed" })),
    ).toBeUndefined();
  });

  it("上下文超窗不退回，交给 reactive compact", () => {
    expect(
      match(
        adapterError(
          { reason: "context_exceeded", statusCode: 400 },
          "Model request exceeded the provider context window.",
          "model_context_exceeded",
        ),
      ),
    ).toBeUndefined();
  });

  it("只声明错误码规则时，其他失败不退回；规则按声明顺序首个命中", () => {
    const expiredOnly = { providerId: HIGHSPEED_PROVIDER_ID, rules: [declaration.rules[0]!] };
    expect(
      match(adapterError({ statusCode: 500 }), { selectionFallback: expiredOnly }),
    ).toBeUndefined();
    expect(
      match(adapterError({ providerCode: CARD_EXPIRED_CODE }), { selectionFallback: expiredOnly })
        ?.reason,
    ).toBe("highspeed_card_expired");
    // 兜底规则排在前面会遮蔽后面的错误码规则：声明顺序就是优先级。
    const catchAllFirst = {
      providerId: HIGHSPEED_PROVIDER_ID,
      rules: [declaration.rules[1]!, declaration.rules[0]!],
    };
    expect(
      match(adapterError({ providerCode: CARD_EXPIRED_CODE }), { selectionFallback: catchAllFirst })
        ?.reason,
    ).toBe("highspeed_request_failed");
  });
});

describe("resolveExecutionFallbackCandidates", () => {
  // spec §2.2：退回目标先取发起方声明的 target（抽卡时的提交选择），再取 runtime 会话常驻 Selection。
  const target = {
    providerId: SESSION_PROVIDER_ID,
    modelId: "GLM-5.3",
    options: { reasoningLevel: "low" },
  };
  const resident = { providerId: "user-provider", modelId: "user-model" };

  it("先取声明的 target，再取会话常驻 Selection", () => {
    expect(
      resolveExecutionFallbackCandidates({
        declaredTarget: target,
        executionProviderId: HIGHSPEED_PROVIDER_ID,
        sessionSelection: resident,
      }),
    ).toEqual([
      { source: "declared_target", selection: target },
      { source: "session_selection", selection: resident },
    ]);
  });

  it("没有 target 时只剩会话常驻 Selection；都没有时无候选", () => {
    expect(
      resolveExecutionFallbackCandidates({
        declaredTarget: undefined,
        executionProviderId: HIGHSPEED_PROVIDER_ID,
        sessionSelection: resident,
      }),
    ).toEqual([{ source: "session_selection", selection: resident }]);
    expect(
      resolveExecutionFallbackCandidates({
        declaredTarget: undefined,
        executionProviderId: HIGHSPEED_PROVIDER_ID,
        sessionSelection: undefined,
      }),
    ).toEqual([]);
  });

  it("候选不能是本轮 execution provider 本身；相同候选只保留一个", () => {
    // 退回同一个失败端点只会再失败一次；误声明成加速 provider 的 target 直接忽略。
    expect(
      resolveExecutionFallbackCandidates({
        declaredTarget: { providerId: HIGHSPEED_PROVIDER_ID, modelId: "GLM-5.3" },
        executionProviderId: HIGHSPEED_PROVIDER_ID,
        sessionSelection: target,
      }),
    ).toEqual([{ source: "session_selection", selection: target }]);
    expect(
      resolveExecutionFallbackCandidates({
        declaredTarget: target,
        executionProviderId: HIGHSPEED_PROVIDER_ID,
        sessionSelection: { ...target, options: { ...target.options } },
      }),
    ).toEqual([{ source: "declared_target", selection: target }]);
  });
});

describe("resolveExecutionModelRetryBudget", () => {
  it("带退回声明且 Selection 指向声明 provider 的执行句柄 0 次重试", () => {
    expect(
      resolveExecutionModelRetryBudget({
        selection: { providerId: HIGHSPEED_PROVIDER_ID, modelId: "GLM-5.3" },
        selectionFallback: declaration,
      }),
    ).toBe(ModelRetryBudget.SingleAttempt);
  });

  it("无声明、无 Selection 或 Selection 不是声明 provider 时沿用默认预算", () => {
    expect(
      resolveExecutionModelRetryBudget({
        selection: { providerId: HIGHSPEED_PROVIDER_ID, modelId: "GLM-5.3" },
        selectionFallback: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveExecutionModelRetryBudget({
        selection: { providerId: SESSION_PROVIDER_ID, modelId: "GLM-5.3" },
        selectionFallback: declaration,
      }),
    ).toBeUndefined();
    expect(
      resolveExecutionModelRetryBudget({ selection: undefined, selectionFallback: declaration }),
    ).toBeUndefined();
  });
});
