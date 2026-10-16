import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
} from "@zcode/provider";
import { encodeProviderConfigFile } from "@zcode/provider-node";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";

describe("Todo104 Services 规则读写完整链路", () => {
  it("默认选择与设置更改共用 Personal 文件，服务层透传外层名称", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo104-service-rules-"));
    const personalFilePath = join(directory, "provider_config.json");
    const selection = {
      providerId: "fixture",
      modelId: "unknown-b",
      options: { reasoningLevel: "disabled" },
    };
    await writeFile(
      personalFilePath,
      JSON.stringify(
        encodeProviderConfigFile({
          providers: new ProviderConfigMap([
            {
              providerId: "fixture",
              providerName: "Before",
              config: new ProviderConfig({
                group: "standard-personal",
                personalModelIds: ["unknown-a", "unknown-b"],
                access: new ApiKeyAccessConfig({ apiKey: "fixture-key" }),
                api: new ProviderApiConfig({
                  type: "openai-chat-completions",
                  baseUrl: "https://fixture.test/v1",
                }),
              }),
            },
          ]),
          models: ModelConfigRules.empty(),
          defaultModelSelection: selection,
        }),
      ),
    );
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath: fileURLToPath(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      personalFilePath,
      watch: false,
      personalPollingIntervalMs: false,
    });
    try {
      expect((await runtime.modelSelection.getView()).preferredSelection).toMatchObject(selection);
      const renamed = await runtime.providerSettings.savePersonalProviderOverlay(
        "fixture",
        {},
        { providerName: "After" },
      );
      expect(
        renamed.providers.find((provider) => provider.providerId === "fixture")?.providerName,
      ).toBe("After");
      const stored = JSON.parse(await readFile(personalFilePath, "utf8"));
      expect(stored.config.defaultModelSelection).toEqual(selection);
      expect(stored.config.providerConfigRules.providerRules[0]).toMatchObject({
        providerName: "After",
        config: { personalModelIds: ["unknown-a", "unknown-b"] },
      });
      expect(stored.config.providerConfigRules.providerRules[0].config).not.toHaveProperty("label");
    } finally {
      runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
