// 会话派生（stable fork / 编辑前分叉 / 辅助对话）的常驻 Selection 推导。
// 从 v4-bridge 抽出：这些函数是纯选型推导，与网关接线无关，需要独立回归测试。
import type { ModelSelection } from "@zcode/contracts";
import { isHighspeedProviderId } from "@zcode/shared";

export function cloneModelSelection(
  selection: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

export function modelSelectionWithOptionFallback(
  selection: ModelSelection | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return fallback && cloneModelSelection(fallback);
  // 兼容旧 fork 消息可能缺少 reasoning；输出预算属于单次请求，不属于 Selection。
  const reasoningLevel = selection.options?.reasoningLevel ?? fallback?.options?.reasoningLevel;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}),
  };
}

/**
 * 派生会话的初始常驻 Selection：优先继承分叉点消息上的选型，加速卡选型必须跳过。
 *
 * Bug 根因：加速轮的 user/assistant 消息按 highspeed-card-spec §5 记录本轮真实执行模型
 * `account:*-highspeed-card`，那是 `selectionScope=execution` 的单轮事实，只有与同一轮
 * requestAuth 成对才有效（加速轮从不改写会话常驻 Selection）。派生会话直接继承这条消息选型，
 * 子会话就常驻在一个无凭据、模型列表里也不存在的加速 Provider 上：用户看到「加速中的会话
 * 分叉后原模型没带过来」，子会话首次发送还会以 ModelRequestAuthMissing 失败。跳过加速选型后
 * 退回父会话常驻 Selection——加速期间它正是用户的原模型（与 §3 规则 13 同一口径）。
 */
export function derivedSessionModelSelection(
  messageSelection: ModelSelection | undefined,
  sessionSelection: ModelSelection | undefined,
): ModelSelection | undefined {
  const inheritable =
    messageSelection && isHighspeedProviderId(messageSelection.providerId)
      ? undefined
      : messageSelection;
  return modelSelectionWithOptionFallback(inheritable, sessionSelection);
}
