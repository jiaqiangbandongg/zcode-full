import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  seedPersonalProviderConfig,
  type PersonalProviderConfigSeed,
} from "./e2e/helpers/model-provider-restart-config.js";

describe("model provider restart config", () => {
  it("把 replay provider 写入唯一的版本化 Personal Config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-restart-provider-"));
    const file = join(root, "config.json");
    const provider: PersonalProviderConfigSeed = {
      id: "restart-provider",
      label: "Restart Provider",
      apiFormat: "openai-chat-completions",
      apiKey: "restart-key",
      baseURL: "http://127.0.0.1:43124",
      visibility: "hidden",
      models: [
        {
          id: "restart-model",
          contextWindow: 128_000,
          maxOutputTokens: 16_000,
        },
      ],
    };

    await seedPersonalProviderConfig(file, provider);

    expect(JSON.parse(await readFile(file, "utf-8"))).toMatchObject({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "restart-provider",
              providerName: "Restart Provider",
              config: {
                access: { type: "api-key", apiKey: "restart-key" },
                api: {
                  type: "openai-chat-completions",
                  baseUrl: "http://127.0.0.1:43124",
                },
                personalModelIds: ["restart-model"],
                visibility: "hidden",
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: "restart-provider",
              modelId: "restart-model",
              config: {
                properties: expect.objectContaining({ contextWindow: 128_000 }),
                optionSpecs: {
                  maxOutputTokens: expect.objectContaining({
                    max: 16_000,
                  }),
                },
              },
            },
          ],
        },
      },
    });
  });
});
