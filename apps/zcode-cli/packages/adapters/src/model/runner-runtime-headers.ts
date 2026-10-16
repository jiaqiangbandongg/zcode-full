import type { RequestVerificationReason } from "@zcode/shared";
import type { ModelRequestAuth } from "@zcode/contracts";
import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

export class RuntimeHeadersRefreshError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RuntimeHeadersRefreshError";
  }
}

export async function resolveModelForAttempt(input: {
  attempt: number;
  reason?: RequestVerificationReason;
  request: AiSdkModelTextRequest;
  resolveModel: (requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel;
}): Promise<ResolvedAiSdkModel> {
  const signal = input.request.abortSignal;
  signal?.throwIfAborted();
  const boundModel = input.resolveModel();
  if (!input.request.refreshRuntimeHeadersBeforeAttempt) return boundModel;
  try {
    const refreshResult = await waitForHeaders(
      () =>
        input.request.refreshRuntimeHeadersBeforeAttempt!({
          attempt: input.attempt,
          reason: input.reason ?? "model-request",
          abortSignal: signal,
          providerId: String(boundModel.providerId),
          modelId: String(boundModel.modelId),
          traceContext: input.request.traceContext,
        }),
      signal,
    );
    signal?.throwIfAborted();
    if (!refreshResult.headersApplied || !refreshResult.requestAuth) {
      throw new Error("Provider request auth was not returned before model request attempt.");
    }
    // 当前绑定负责将完整鉴权材料投影到私有请求，不写共享 Registry，也不重新选择模型。
    return input.resolveModel(refreshResult.requestAuth);
  } catch (error) {
    if (signal?.aborted) throw error;
    // 执行作用域凭据缺失已有稳定错误码；不能被 headers 等待的通用包装吞掉。
    if (
      error instanceof ModelProtocolError &&
      error.code === ModelErrorCode.ModelRequestAuthMissing
    )
      throw error;
    throw new RuntimeHeadersRefreshError(error);
  }
}

async function waitForHeaders<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
