import type { IUsageStatsService } from "@zcode/services";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";

/** 消费目标 Host 的原账号视图和权益 owner；不另存余额或登录状态。 */
export function useStartPlanEntitlement(
  providerId: string,
  service: IUsageStatsService | undefined,
  refreshOnAccess = false,
) {
  const settings = useProviderSettingsView();
  return useUsageEntitlementWithService(service, {
    ...buildStartPlanEntitlementOptions(
      settings.state.status === "ready" ? settings.state.view : null,
      providerId,
    ),
    refreshOnMount: refreshOnAccess,
    mountRefreshReason: "access",
  });
}
