import type { RequestVerificationReason } from "@zcode/shared";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "../runner-runtime.js";
import type { ProviderBusinessError, AiSdkProviderKind } from "../model-execution.js";
export class RequestVerificationRetry {
  constructor(_request: AiSdkModelTextRequest, _model: ResolvedAiSdkModel) {}
  get extraAttempts(): number {
    return 0;
  }
  takeReason(): RequestVerificationReason {
    return "model-request";
  }
  claim(_error: unknown, _blocked = false): boolean {
    return false;
  }
}
export function isRequestVerificationRejection(_error: unknown): boolean {
  return false;
}
export function createRequestVerificationEmptyStreamError(_input: {
  accountMode?: string;
  headers: Record<string, string> | undefined;
  providerId: string;
  providerKind: AiSdkProviderKind;
}): ProviderBusinessError | undefined {
  return undefined;
}
