import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
export function smartDraftModel(): ProviderSettingsFormModel {
  const config = {
    enabled: false,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 100000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: false,
        supportsAudio: true,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["low", "high"], map: "{}" },
      maxOutputTokens: {
        max: 32000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    },
  };
  return {
    kind: "candidate",
    modelId: "a",
    builtin: false,
    config,
    inheritedConfig: config,
    personalConfig: { enabled: false },
    hasPersonalConfig: true,
    executable: true,
    selectable: true,
  };
}
