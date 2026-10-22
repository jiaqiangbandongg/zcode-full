import { expectTypeOf, it } from "vitest";
import type { MarketingTouchControllerContract } from "@/marketing-touch-contract/contract.js";
import { exampleMarketingTouchController } from "@/marketing-touch-contract/contract.example.js";

// 保证装配示例保留同步工厂或异步初始化的返回语义；运行时回归由现有专项测试覆盖。
it("保持既有入口的返回类型", () => {
  expectTypeOf<ReturnType<typeof exampleMarketingTouchController>>().toEqualTypeOf<
    ReturnType<MarketingTouchControllerContract["createMarketingTouchController"]>
  >();
});
