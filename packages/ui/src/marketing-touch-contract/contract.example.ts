import type { MarketingTouchControllerContract } from "@/marketing-touch-contract/contract.js";

/** 装配方传入现有工厂和依赖，不通过契约另起生命周期。 */
export function exampleMarketingTouchController(
  contract: MarketingTouchControllerContract,
  ...args: Parameters<MarketingTouchControllerContract["createMarketingTouchController"]>
) {
  return contract.createMarketingTouchController(...args);
}
