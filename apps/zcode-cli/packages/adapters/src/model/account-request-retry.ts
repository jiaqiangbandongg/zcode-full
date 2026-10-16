import type { RequestVerificationReason } from "@zcode/shared";
import { projectAccessTokenFingerprint, isRequestSecurityFailure } from "@zcode/shared";
import type { Logger, ModelRequestAuth } from "@zcode/contracts";
import { RequestVerificationRetry } from "./request-security-edition/recovery.js";
import { inspectProviderFailure } from "./failure-classifier.js";
import {
  getApiCallResponseBody,
  getHttpResponseStatus,
  unwrapRetryError,
} from "./failure-inspection.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

export class AccountRequestRetry {
  readonly #verification: RequestVerificationRetry;
  #used = false;
  #pending = false;
  #auth?: ModelRequestAuth;

  constructor(
    private readonly request: AiSdkModelTextRequest,
    private readonly model: ResolvedAiSdkModel,
    private readonly logger?: Logger,
  ) {
    this.#verification = new RequestVerificationRetry(request, model);
  }

  get extraAttempts(): number {
    return this.#verification.extraAttempts + Number(this.#used);
  }

  takeReason(): RequestVerificationReason {
    return this.#verification.takeReason();
  }

  prepareRequest(request: AiSdkModelTextRequest): AiSdkModelTextRequest {
    const refresh = request.refreshRuntimeHeadersBeforeAttempt;
    if (!refresh) return request;
    return {
      ...request,
      refreshRuntimeHeadersBeforeAttempt: async (input) => {
        const previous = this.#auth;
        const recover = this.#pending;
        this.#pending = false;
        this.#auth = undefined;
        const token = previous && this.#token(previous);
        const result = await refresh({
          ...input,
          ...(recover && token && previous?.accountScope
            ? {
                expectedAccountScope: previous.accountScope,
                rejectedProjectTokenFingerprint: await projectAccessTokenFingerprint(token),
              }
            : {}),
        });
        if (recover && result.requestAuth?.accountScope !== previous?.accountScope)
          throw new Error("project_token_scope_invalidated");
        this.#auth = result.headersApplied ? result.requestAuth : undefined;
        return result;
      },
    };
  }

  claim(error: unknown, blocked = false): boolean {
    if (this.#verification.claim(error, blocked)) return true;
    if (!this.canRecoverProjectToken(error, blocked)) return false;
    this.#used = true;
    this.#pending = true;
    this.logger?.warn("Model PAT rejected; refreshing once before retry", {
      event: "model.project_token.refresh_retry",
      providerId: String(this.model.providerId),
      modelId: String(this.model.modelId),
      traceId: this.request.traceContext?.traceId,
      statusCode: 401,
    });
    return true;
  }

  canRecoverProjectToken(error: unknown, blocked = false): boolean {
    const mode = this.model.accountAccess?.mode;
    if (
      blocked ||
      this.#used ||
      this.request.abortSignal?.aborted ||
      !this.request.refreshRuntimeHeadersBeforeAttempt ||
      !["individual-coding-plan", "team-coding-plan", "off-peak"].includes(mode ?? "") ||
      !this.#auth?.accountScope ||
      !this.#token(this.#auth) ||
      !isProjectTokenRejection(error)
    )
      return false;
    return true;
  }

  #token(auth: ModelRequestAuth): string | undefined {
    return this.model.accountAccess?.mode === "off-peak"
      ? Object.entries(auth.headers ?? {}).find(
          ([key]) => key.toLowerCase() === "x-coding-plan-api-key",
        )?.[1]
      : auth.apiKey;
  }
}

export function isProjectTokenRejection(error: unknown): boolean {
  return (
    getHttpResponseStatus(unwrapRetryError(error)) === 401 &&
    !isOtherAuthRejection(error, new WeakSet<object>())
  );
}

function isOtherAuthRejection(error: unknown, seen: WeakSet<object>): boolean {
  const current = unwrapRetryError(error);
  if (!current || typeof current !== "object" || seen.has(current)) return false;
  seen.add(current);
  const details = inspectProviderFailure(current);
  return (
    isRequestSecurityFailure(getApiCallResponseBody(current), [
      details.providerErrorCode,
      details.providerErrorMessage,
    ]) ||
    ("cause" in current && isOtherAuthRejection(current.cause, seen))
  );
}
