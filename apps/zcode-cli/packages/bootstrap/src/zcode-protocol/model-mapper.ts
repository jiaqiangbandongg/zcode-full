import type { ModelSelection } from "@zcode/shared";
import { parseProviderQualifiedModelSelection } from "../app/provider-registry-selection.js";

export function formatProtocolModelSelection(ref: ModelSelection): string {
  return `${ref.providerId}/${ref.modelId}`;
}

export function modelSelectionFromString(input: string): ModelSelection {
  const selection = parseProviderQualifiedModelSelection(input);
  if (!selection) throw new Error(`Invalid provider-qualified model selection: ${input}`);
  return selection;
}

/** 未绑定 App 的 getModel() 返回空值；读取协议不能把合法的空状态重新变成恢复异常。 */
export function optionalModelSelectionFromString(input: string): ModelSelection | undefined {
  return input.trim() ? modelSelectionFromString(input) : undefined;
}
