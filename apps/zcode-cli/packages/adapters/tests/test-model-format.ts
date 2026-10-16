import type { ModelInputFormat, ModelProperties } from "@zcode/contracts";

export function createTestInputFormat(override: Partial<ModelInputFormat> = {}): ModelInputFormat {
  return {
    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: false,
    supportsPdf: true,
    ...override,
  };
}

export function createTestModelProperties(
  override: Partial<ModelInputFormat> = {},
  propertyOverride: Partial<ModelProperties> = {},
): ModelProperties {
  return {
    requiresMfjsToolSchema: false,
    contextWindow: 200_000,
    inputFormat: createTestInputFormat(override),
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: true,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: true,
    ...propertyOverride,
  };
}
