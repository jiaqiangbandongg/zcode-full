import {
  EMPTY_PLUGIN_UI_INSTANCE_DERIVATION,
  type PluginUiInstanceDerivation,
  type PluginUiRowDisposition,
} from "../domain/pluginUiInstancePolicy.js";

/**
 * 每个会话最近一次由时间线推导出的逻辑 UI 裁决（renderer 内存）。时间线在 effect 里写入，
 * 工具卡片按 (sessionKey, toolCallId) 读自己的裁决（是否被替代、是否强制常驻）；不持有任何沙箱状态。
 */
const derivations = new Map<string, PluginUiInstanceDerivation>();
const listeners = new Set<() => void>();

export function setPluginUiInstanceDerivation(
  sessionKey: string,
  derivation: PluginUiInstanceDerivation,
): void {
  if (derivations.get(sessionKey) === derivation) return;
  derivations.set(sessionKey, derivation);
  for (const listener of listeners) listener();
}

export function getPluginUiRowDisposition(
  sessionKey: string,
  toolCallId: string,
): PluginUiRowDisposition | undefined {
  return (derivations.get(sessionKey) ?? EMPTY_PLUGIN_UI_INSTANCE_DERIVATION).byToolCallId[
    toolCallId
  ];
}

export function subscribePluginUiInstances(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 测试用：清空全部记录。 */
export function resetPluginUiInstancesForTest(): void {
  derivations.clear();
  listeners.clear();
}
