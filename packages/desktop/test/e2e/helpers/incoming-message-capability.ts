import { ModelConfig, ModelPropertiesConfig } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { getE2EAppDataPaths, seedSettings } from "./desktop-app.js";
import {
  ensureUpstreamModelForE2E,
  ensureUpstreamProviderForE2E,
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
} from "./upstream-provider.js";
import { prepareV4ConversationE2E, switchV4Model } from "./v4-conversation.js";

export const INCOMING_MESSAGE_MODES = [
  { label: "MCS", mcs: true },
  { label: "non-MCS", mcs: false },
] as const;

/** Loopback 没有线上站点能力，必须明确设置 capability，不能按模型名称猜测。 */
export async function prepareIncomingMessageCapability(
  mcs: boolean,
  interactionBehavior: "guide" | "queue" = "guide",
): Promise<void> {
  await prepareV4ConversationE2E({ resetDraftBeforeProvider: true, skipProvider: true });
  await ensureUpstreamProviderForE2E({ skipToolbarSelection: true });
  await ensureUpstreamModelForE2E("claude-opus-4-8");
  await ensureUpstreamModelForE2E(UPSTREAM_MODEL);
  const repository = new NodePersonalProviderConfigRepository({
    filePath: getE2EAppDataPaths().configFile,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => {
      let models = current.models;
      for (const [modelId, supported] of [
        ["claude-opus-4-8", true],
        [UPSTREAM_MODEL, false],
      ] as const) {
        models = models.setExact(
          UPSTREAM_PROVIDER_ID,
          modelId,
          (models.getExact(UPSTREAM_PROVIDER_ID, modelId) ?? new ModelConfig()).overlay(
            new ModelConfig({
              properties: new ModelPropertiesConfig({ supportsMidConversationSystem: supported }),
            }),
          ),
        );
      }
      return { ...current, models };
    });
  } finally {
    repository.dispose();
  }
  await seedSettings({ zcodeInteractionBehavior: interactionBehavior });
  // 冷启动 Host/Worker 形成配置生效屏障，不依赖 watcher 的偶然时序。
  await browser.reloadSession();
  await prepareV4ConversationE2E({ resetDraftBeforeProvider: true, skipProvider: true });
  await switchIncomingMessageCapability(mcs);
}

export async function switchIncomingMessageCapability(mcs: boolean): Promise<void> {
  await switchV4Model(UPSTREAM_PROVIDER_ID, mcs ? "claude-opus-4-8" : UPSTREAM_MODEL, "");
}
