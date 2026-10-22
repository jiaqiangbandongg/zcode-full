/** 只登记现有入口；实现位置与调用链保持不变。 */
export const marketingTouchControllerModule = {
  id: "marketing-touch-controller",
  requires: ["services", "shared", "ui"],
  provides: ["marketing-touch-controller"],
  publicEntrypoints: [
    "packages/ui/src/components/marketing-touch/marketingTouchController.ts",
    "packages/ui/src/marketing-touch-contract/contract.ts",
  ],
} as const;
