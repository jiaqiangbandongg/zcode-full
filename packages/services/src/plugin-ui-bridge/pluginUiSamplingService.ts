import type { IPluginUiSamplingService } from "./samplingContract.js";
import { PluginUiBridgeError } from "./pluginUiBridgeService.js";

export function createPluginUiSamplingService(
  dependencies: Partial<IPluginUiSamplingService> = {},
): IPluginUiSamplingService {
  return {
    async sample(params) {
      if (!dependencies.sample)
        throw new PluginUiBridgeError(
          "unavailable",
          "Plugin UI sampling is unavailable in this runtime",
        );
      return dependencies.sample(params);
    },
    async cancelSampling(params) {
      if (!dependencies.cancelSampling) return { cancelled: false };
      return dependencies.cancelSampling(params);
    },
  };
}
