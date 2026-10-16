import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  isCodingPlanModelProviderId,
  isZaiCodingPlanProviderId,
  type OAuthProviderId,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { type CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

export type CodingPlanPurchaseAuthStatus =
  | "unknown"
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "error";

export function isCodingPlanPurchaseAuthPending(status: CodingPlanPurchaseAuthStatus): boolean {
  return status === "unknown" || status === "loading";
}

export async function readCodingPlanPurchaseTokenState(credentialService: {
  load(key: string): Promise<string | null>;
}) {
  const [activeProvider, zaiToken, bigmodelToken] = await Promise.all([
    credentialService.load("oauth:active_provider"),
    credentialService.load(`oauth:${ZAI_PROVIDER_ID}:access_token`),
    credentialService.load(`oauth:${BIGMODEL_PROVIDER_ID}:access_token`),
  ]);
  const active =
    activeProvider === ZAI_PROVIDER_ID || activeProvider === BIGMODEL_PROVIDER_ID
      ? activeProvider
      : null;
  return {
    [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]:
      active === ZAI_PROVIDER_ID && Boolean(zaiToken?.trim()),
    [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]:
      active === ZAI_PROVIDER_ID && Boolean(zaiToken?.trim()),
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]:
      active === BIGMODEL_PROVIDER_ID && Boolean(bigmodelToken?.trim()),
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]:
      active === BIGMODEL_PROVIDER_ID && Boolean(bigmodelToken?.trim()),
  } satisfies Partial<Record<CodingPlanProviderId, boolean>>;
}

export function normalizeCodingPlanProviderId(
  providerId: string | null | undefined,
): CodingPlanProviderId | null {
  const normalized = providerId?.trim();
  return normalized && isCodingPlanModelProviderId(normalized)
    ? (normalized as CodingPlanProviderId)
    : null;
}

export function isCodingPlanProviderId(
  providerId: CodingPlanProviderId | null,
): providerId is CodingPlanProviderId {
  return Boolean(providerId);
}

export function resolveCodingPlanOAuthProviderId(
  providerId: CodingPlanProviderId,
): OAuthProviderId {
  return isZaiCodingPlanProviderId(providerId) ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
}
