import type { RequestVerificationReason } from "@zcode/shared";
import { traceContextToLogContext } from "../deps.js";
import type { ModelRequestAuth } from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { Model, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

export function createRefreshRuntimeHeadersBeforeModelAttempt(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    model: Model;
    traceContext: TraceContext;
  },
):
  | ((attemptInput: {
      accountAccess?: ZCodeProviderAccountAccess;
      expectedAccountScope?: string;
      rejectedProjectTokenFingerprint?: string;
      attempt: number;
      reason?: RequestVerificationReason;
      abortSignal?: AbortSignal;
    }) => Promise<{
      headersApplied: boolean;
      requestAuth?: ModelRequestAuth;
    }>)
  | undefined {
  const runtimeHeadersPort = runtime.providerRuntimeHeadersPort;
  if (
    !runtimeHeadersPort ||
    !(
      runtimeHeadersPort.shouldRefreshBeforeModelRequest?.({
        providerId: String(input.model.providerId),
        modelId: String(input.model.modelId),
      }) ?? true
    )
  ) {
    return undefined;
  }

  return async (attemptInput) => {
    // Start Plan 的账号鉴权材料按请求刷新，adapter 内部 retry、WebSearch/native tool
    // 请求和标题/compact 等单独模型请求都必须在每个真实请求 attempt 发送前刷新，
    // 不能复用进入 adapter 前的旧材料。
    // 路由身份：主 runtime 报自己的会话；child runtime 拿到的端口由父 runtime 派生
    // （helpers/child-client-ports.ts），把 sessionId 改写成客户端认识的根会话。
    const refreshResult = await runtimeHeadersPort.refreshBeforeModelRequest({
      accountAccess: attemptInput.accountAccess,
      expectedAccountScope: attemptInput.expectedAccountScope,
      rejectedProjectTokenFingerprint: attemptInput.rejectedProjectTokenFingerprint,
      abortSignal: attemptInput.abortSignal ?? input.abortSignal,
      modelId: String(input.model.modelId),
      providerId: String(input.model.providerId),
      reason: attemptInput.reason ?? "model-request",
      sessionId: runtime.sessionId,
      traceContext: input.traceContext,
      turnId: input.traceContext.turnId,
    });
    if (!refreshResult.headersApplied) {
      throw new Error("Provider runtime headers were not applied before model request attempt.");
    }
    runtime.logger?.debug("Provider runtime headers refreshed before model request attempt", {
      ...traceContextToLogContext(input.traceContext),
      attempt: attemptInput.attempt,
      event: "model.request.runtime_headers_refreshed",
      headersApplied: refreshResult.headersApplied,
      module: "core.runtime",
      providerId: String(input.model.providerId),
    });
    return refreshResult;
  };
}
