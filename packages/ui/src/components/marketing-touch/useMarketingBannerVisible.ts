import { useContext, useSyncExternalStore } from "react";
import { isMarketingBannerRenderable } from "@/components/marketing-touch/marketingTouchController.js";
import { MarketingTouchContext } from "@/components/marketing-touch/MarketingTouchProvider.js";

// controller 缺席时用 noop 订阅、快照恒为 false，与 GlobalNoticeSurface 的 null-safe 写法一致。
const subscribeNoop = () => () => {};

/**
 * 仲裁层（SidebarBottomActivity）用它只读订阅左下角领 token banner 是否可见；
 * 判断源仍是 controller.store，本 hook 不持有任何状态。
 */
export function useMarketingBannerVisible(): boolean {
  const controller = useContext(MarketingTouchContext);
  return useSyncExternalStore(
    controller ? controller.store.subscribe : subscribeNoop,
    () => (controller ? isMarketingBannerRenderable(controller.store.getState().banner) : false),
    () => false,
  );
}
