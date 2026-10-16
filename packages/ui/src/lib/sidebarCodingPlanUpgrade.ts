import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type ProviderFamilyDomain,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { CodingPlanUsageAvailableProvider } from "@/CodingPlanUsageRemainingPanel.js";
import type { SidebarUsageCodingPlanProviderId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

export interface SidebarCodingPlanUpgradeEntitlement {
  providerId: SidebarUsageCodingPlanProviderId;
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
}

export function resolveSidebarCodingPlanUpgradeFallbackProviderId(
  providerFamilyDomain: ProviderFamilyDomain | null,
): SidebarUsageCodingPlanProviderId {
  // API Key 模式不会为 Coding Plan provider 注入套餐 key，头像升级入口因而
  // 无法从权益或用量来源推导 provider；按 provider 家族域名回退到对应品牌的入口。
  return providerFamilyDomain === "bigmodel"
    ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
}

function normalizePlanLevel(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasPlanLevelToken(value: string | null | undefined, token: string): boolean {
  return new RegExp(`(^|[\\s_-])${token}($|[\\s_-])`, "i").test(value?.trim() ?? "");
}

function isTerminalCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  // 判断套餐层级是否为不可升级的终态：enterprise/team 视为终态。
  return normalized.includes("enterprise") || normalized.includes("team");
}

function isMaxCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  return normalized === "max" || hasPlanLevelToken(value, "max");
}

export function isTerminalCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isTerminalCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = normalizePlanLevel(detail.productId);
    const productName = normalizePlanLevel(detail.productName);
    return isTerminalCodingPlanLevel(productId) || isTerminalCodingPlanLevel(productName);
  });
}

export function isMaxCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isMaxCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = detail.productId;
    const productName = detail.productName;
    return isMaxCodingPlanLevel(productId) || isMaxCodingPlanLevel(productName);
  });
}

function hasActiveCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  return (
    snapshot?.provider?.id === providerId &&
    snapshot.unavailableReason !== "no_plan" &&
    Boolean(snapshot.subscription?.details.length)
  );
}

function isUpgradableCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  if (!snapshot || snapshot.provider?.id !== providerId || !snapshot.authenticated) {
    return false;
  }

  if (isTerminalCodingPlanSnapshot(snapshot)) {
    return false;
  }

  if (
    snapshot.unavailableReason === "not_authenticated" ||
    snapshot.unavailableReason === "not_configured" ||
    snapshot.unavailableReason === "unavailable"
  ) {
    return false;
  }

  return snapshot.unavailableReason === "no_plan" || Boolean(snapshot.subscription?.details.length);
}

export function resolveSidebarCodingPlanUpgradeProviderId(params: {
  availableProviders: CodingPlanUsageAvailableProvider[];
  entitlements: SidebarCodingPlanUpgradeEntitlement[];
  modelProvidersLoading: boolean;
  selectedProviderId?: SidebarUsageCodingPlanProviderId;
}): SidebarUsageCodingPlanProviderId | undefined {
  if (params.modelProvidersLoading) {
    return undefined;
  }

  const providerEntitlements = params.entitlements.filter(
    (entitlement) =>
      !entitlement.loading &&
      params.availableProviders.some((provider) => provider.providerId === entitlement.providerId),
  );
  const upgradableEntitlements = providerEntitlements.filter((entitlement) =>
    isUpgradableCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
  );
  if (upgradableEntitlements.length === 0) {
    return undefined;
  }

  const selectedEntitlement = upgradableEntitlements.find(
    (entitlement) => entitlement.providerId === params.selectedProviderId,
  );
  if (selectedEntitlement) {
    return selectedEntitlement.providerId;
  }

  const activeEntitlement = upgradableEntitlements.find((entitlement) =>
    hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
  );
  return (activeEntitlement ?? upgradableEntitlements[0])?.providerId;
}
