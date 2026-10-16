import { ProviderConfig } from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  NodeModelSelectionConfigRepository,
} from "@zcode/provider-node";

const [filePath, role] = process.argv.slice(2);
if (!filePath || (role !== "provider" && role !== "default"))
  throw new Error("invalid fixture arguments");
const personal = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
const defaults = new NodeModelSelectionConfigRepository({ personalRepository: personal });
const start = new Promise<void>((resolve) => process.once("message", () => resolve()));
process.send?.("ready");
await start;
try {
  for (let index = 0; index < 20; index += 1) {
    if (role === "default") {
      await defaults.saveConfiguredDefault({ providerId: "fixture", modelId: `model-${index}` });
    } else {
      await personal.update((current) => ({
        ...current,
        providers: current.providers.setRule({
          providerId: `provider-${index}`,
          providerName: `Provider ${index}`,
          config: new ProviderConfig({ personalModelIds: ["model"] }),
        }),
      }));
    }
  }
} finally {
  defaults.dispose();
  personal.dispose();
  process.disconnect?.();
}
