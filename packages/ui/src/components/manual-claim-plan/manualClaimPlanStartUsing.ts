import type { ProviderSettingsView } from "@zcode/services";

export interface ManualClaimPlanStartUsingTarget {
  readonly providerExecutable?: boolean;
  readonly modelCount?: number;
  readonly modelExecutable?: boolean;
  readonly modelSelectable?: boolean;
}

export type ManualClaimPlanStartUsingTargetResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "missing-provider" | "provider-not-executable" | "no-executable-model";
    };

/**
 * “开始体验”是一个会改变当前 Family 选择的跳转，必须使用领取后最新的 Provider View 做一次门禁。
 * 不能只依据领取接口的成功响应：Provider 刷新失败或模型尚未进入 Registry 时，直接写入选择会制造坏的当前状态。
 */
export function resolveManualClaimPlanStartUsingTarget(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): ManualClaimPlanStartUsingTargetResult {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (!provider) return { ok: false, reason: "missing-provider" };
  if (!provider.executable) return { ok: false, reason: "provider-not-executable" };
  if (!provider.models.some((model) => model.executable && model.selectable)) {
    return { ok: false, reason: "no-executable-model" };
  }
  return { ok: true };
}
