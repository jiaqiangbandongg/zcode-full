import type { BuiltinModelProviderId, IPlatformService } from "@zcode/shared";
import type { IOAuthService } from "@zcode/services";
import { resolveOAuthProviderIdByPreset } from "./utils.js";
import {
  reportAppTelemetryEvent,
  resolvePresetModelProviderTelemetryLabel,
} from "@/lib/appTelemetry.js";
import { logger } from "@/logger.js";

export async function startPresetSubscriptionLogin(params: {
  presetId: BuiltinModelProviderId;
  oauthService: IOAuthService;
  platform: IPlatformService;
  clearPending: () => void;
}) {
  const oauthProviderId = resolveOAuthProviderIdByPreset(params.presetId);
  if (!oauthProviderId) {
    return;
  }

  try {
    const { authorizeUrl, state, provider } = await params.oauthService.startOAuth(oauthProviderId);
    params.platform.registerOAuthState({ state, provider });
    params.platform.openExternal(authorizeUrl);
    logger.info("[ModelProviderSection] 已发起模型供应商 App OAuth 登录", {
      presetId: params.presetId,
      provider,
    });
  } catch (error) {
    logger.error("[ModelProviderSection] 发起模型供应商 App OAuth 登录失败", {
      presetId: params.presetId,
      error,
    });
    params.clearPending();
  }
}

export async function reportPresetSubscriptionSuccess(params: {
  platform: IPlatformService;
  presetId: BuiltinModelProviderId;
}) {
  await reportAppTelemetryEvent(
    params.platform,
    {
      elementName: "add_model_success",
      eventRegion: "app_setting",
      eventType: "ck",
      eventExtraDetail: {
        login_default: "1",
        model_provider: resolvePresetModelProviderTelemetryLabel(params.presetId),
      },
    },
    "ModelProviderSection",
  );
}
