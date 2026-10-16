import type { ModelSelection } from "@zcode/contracts";

export function createTestModelSelection(
  input: string | ModelSelection,
  options?: ModelSelection["options"],
): ModelSelection {
  if (typeof input !== "string") {
    return {
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.options ? { options: { ...input.options } } : {}),
    };
  }
  const separator = input.indexOf("/");
  if (separator <= 0 || separator === input.length - 1) {
    throw new Error(`Test model selection must be provider-qualified: ${input}`);
  }
  return {
    providerId: input.slice(0, separator),
    modelId: input.slice(separator + 1),
    ...(options ? { options: { ...options } } : {}),
  };
}
