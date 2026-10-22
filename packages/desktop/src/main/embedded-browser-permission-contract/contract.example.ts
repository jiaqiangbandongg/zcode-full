import type { EmbeddedBrowserPermissionContract } from "@desktop/main/embedded-browser-permission-contract/contract.js";

/** 装配方传入现有工厂和依赖，不通过契约另起生命周期。 */
export function exampleEmbeddedBrowserPermission(
  contract: EmbeddedBrowserPermissionContract,
  ...args: Parameters<EmbeddedBrowserPermissionContract["applyEmbeddedBrowserPermissionPolicy"]>
) {
  return contract.applyEmbeddedBrowserPermissionPolicy(...args);
}
