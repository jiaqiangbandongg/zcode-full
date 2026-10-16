import { useEffect, useState } from "react";

/** Highspeed 输入框入场方式：activation 播放激活动效，restore 直接呈现稳定态。 */
export type HighspeedComposerEntrance = "activation" | "restore";

function resolveEntrance(
  cardId: string | null,
  activationCardId: string | null,
): HighspeedComposerEntrance {
  return cardId !== null && cardId === activationCardId ? "activation" : "restore";
}

/**
 * 按 cardId 锁定入场方式：仅宿主登记的一次性激活请求命中当前卡时播放激活动效，
 * 切回 Task、快照恢复与组件重挂载一律 restore（spec §9.2）。
 * 锁定后立即回调消费请求，之后的重挂载读不到请求，因而不会重播。
 */
export function useHighspeedComposerEntrance({
  cardId,
  activationCardId,
  onActivationApplied,
}: {
  cardId: string | null;
  activationCardId: string | null;
  onActivationApplied?: (cardId: string) => void;
}): HighspeedComposerEntrance {
  const [latch, setLatch] = useState(() => ({
    cardId,
    entrance: resolveEntrance(cardId, activationCardId),
  }));
  let current = latch;
  if (latch.cardId !== cardId) {
    // 卡片身份变化时在渲染期重新锁定，避免新卡先以旧入场方式渲染一帧。
    current = { cardId, entrance: resolveEntrance(cardId, activationCardId) };
    setLatch(current);
  }
  const appliedActivationCardId = current.entrance === "activation" ? current.cardId : null;
  useEffect(() => {
    if (appliedActivationCardId !== null) onActivationApplied?.(appliedActivationCardId);
  }, [appliedActivationCardId, onActivationApplied]);
  return current.entrance;
}
