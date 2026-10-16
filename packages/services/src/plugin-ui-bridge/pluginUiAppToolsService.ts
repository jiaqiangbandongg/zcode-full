import type {
  IPluginUiAppToolsService,
  PluginUiAppToolAcceptedResult,
  PluginUiAppToolCallParams,
  PluginUiAppToolInstanceParams,
  PluginUiRegisterAppToolsParams,
  PluginUiRegisterAppToolsResult,
  PluginUiResolveAppToolCallParams,
} from "./appToolsContract.js";
import { PluginUiBridgeError } from "./pluginUiBridgeService.js";

/** 四条 agent 调用都是透传；缺省（web / 远程）时登记与认领抛 unavailable，注销静默。 */
export interface PluginUiAppToolsServiceDependencies {
  registerAppToolsForUi?: (
    params: PluginUiRegisterAppToolsParams,
  ) => Promise<PluginUiRegisterAppToolsResult>;
  unregisterAppToolsForUi?: (params: PluginUiAppToolInstanceParams) => Promise<{ removed: number }>;
  claimAppToolCallForUi?: (
    params: PluginUiAppToolCallParams,
  ) => Promise<PluginUiAppToolAcceptedResult>;
  resolveAppToolCallForUi?: (
    params: PluginUiResolveAppToolCallParams,
  ) => Promise<PluginUiAppToolAcceptedResult>;
}

const unavailable = () =>
  new PluginUiBridgeError("unavailable", "Plugin UI app tools are unavailable in this runtime");

export function createPluginUiAppToolsService(
  dependencies: PluginUiAppToolsServiceDependencies = {},
): IPluginUiAppToolsService {
  return {
    async registerAppTools(params) {
      if (!dependencies.registerAppToolsForUi) throw unavailable();
      return dependencies.registerAppToolsForUi(params);
    },
    async unregisterAppTools(params) {
      if (!dependencies.unregisterAppToolsForUi) return { removed: 0 };
      return dependencies.unregisterAppToolsForUi(params);
    },
    async claimAppToolCall(params) {
      if (!dependencies.claimAppToolCallForUi) throw unavailable();
      return dependencies.claimAppToolCallForUi(params);
    },
    async resolveAppToolCall(params) {
      if (!dependencies.resolveAppToolCallForUi) throw unavailable();
      return dependencies.resolveAppToolCallForUi(params);
    },
  };
}
