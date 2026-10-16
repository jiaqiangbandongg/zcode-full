import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import { isApiKeyAccess } from "@zcode/provider";

type ProviderSettingsApiKeyService = Pick<
  IProviderSettingsService,
  "getView" | "savePersonalProviderOverlay"
>;

function findSettingsProvider(view: ProviderSettingsView, providerId: string) {
  return view.providers.find((entry) => entry.providerId === providerId);
}

export function resolveSettingsProviderApiKey(
  view: ProviderSettingsView,
  providerId: string,
): string | null {
  const provider = findSettingsProvider(view, providerId);
  if (!provider || !isApiKeyAccess(provider.effectiveConfig.access)) return null;
  return provider.effectiveConfig.access.apiKey?.trim() ?? "";
}

export function resolveSettingsProviderApiKeyManagementUrl(
  view: ProviderSettingsView | null,
  providerId: string,
): string | undefined {
  const provider = view ? findSettingsProvider(view, providerId) : undefined;
  if (!provider || !isApiKeyAccess(provider.effectiveConfig.access)) return undefined;
  return provider.effectiveConfig.access.apiKeyManagementUrl?.trim() || undefined;
}

export async function loadProviderApiKey(params: {
  providerId: string;
  providerSettingsService: Pick<IProviderSettingsService, "getView">;
}): Promise<string> {
  return (
    resolveSettingsProviderApiKey(
      await params.providerSettingsService.getView(),
      params.providerId,
    ) ?? ""
  );
}

export async function persistProviderApiKey(params: {
  providerId: string;
  apiKey: string;
  providerSettingsService: ProviderSettingsApiKeyService;
}): Promise<void> {
  const settingsView = await params.providerSettingsService.getView();
  const provider = findSettingsProvider(settingsView, params.providerId);
  if (!provider || !isApiKeyAccess(provider.effectiveConfig.access)) {
    throw new Error(`Provider Settings View 中不存在 API Provider ${params.providerId}`);
  }

  const personal = provider.personalConfig ?? {};
  await params.providerSettingsService.savePersonalProviderOverlay(params.providerId, {
    ...personal,
    access: {
      ...(isApiKeyAccess(personal.access) ? personal.access : {}),
      type: provider.effectiveConfig.access.type,
      apiKey: params.apiKey,
    },
  });
}
