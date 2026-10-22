import type { ComposerToolbarLayoutContract } from "@/composer-toolbar-layout/contract.js";

/** 由现有入口提供布局函数，不引入第二套观察器或状态。 */
export function exampleComposerToolbarLayout(
  contract: ComposerToolbarLayoutContract,
  root: HTMLElement,
): void {
  contract.fit(root);
}
