import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
} from "@zcode/provider";
import { decodeProviderConfigFile } from "@zcode/provider-node";
import {
  seedPersonalProviderConfig,
  type PersonalProviderConfigSeed,
} from "./e2e/helpers/model-provider-restart-config.js";

describe("model provider restart config", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  it.each(["anthropic-messages", "openai-chat-completions", "openai-responses"] as const)(
    "%s replay 默认模型在没有本机 Built-in 的远端仍可选择",
    async (apiFormat) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-remote-seed-"));
      roots.push(root);
      const file = join(root, "provider_config.json");
      await seedPersonalProviderConfig(file, {
        id: "remote-replay",
        label: "Remote Replay",
        apiFormat,
        apiKey: "fixture-key",
        baseURL: "http://127.0.0.1:43124",
        models: [{ id: "remote-model" }],
      });
      const personal = decodeProviderConfigFile(JSON.parse(await readFile(file, "utf8")));
      const resolved = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: new ProviderConfigMap(),
        accountProviders: new ProviderConfigMap(),
        zcodeBuiltinModelRules: new ModelConfigRules(),
        personalProviders: personal.providers,
        personalModels: personal.models,
      });
      expect(resolved.issues).toEqual([]);
      expect(
        new ProviderRegistry(resolved.registryProviders).validateSelection({
          providerId: "remote-replay",
          modelId: "remote-model",
          options: { reasoningLevel: "disabled" },
        }),
      ).toEqual({ ok: true });
    },
  );

  it.each([true, false])(
    "显式思考选项和模型启用状态 %s 在独立 Registry 中保持",
    async (enabled) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-remote-seed-"));
      roots.push(root);
      const file = join(root, "provider_config.json");
      await seedPersonalProviderConfig(file, {
        id: "reasoning-replay",
        label: "Reasoning Replay",
        apiFormat: "anthropic-messages",
        apiKey: "fixture-key",
        baseURL: "http://127.0.0.1:43124",
        enabled,
        models: [
          {
            id: "reasoning-model",
            reasoningLevel: {
              values: ["high", "max"],
              map: '{"output_config":{"effort":reasoningLevel}}',
            },
          },
        ],
      });
      const personal = decodeProviderConfigFile(JSON.parse(await readFile(file, "utf8")));
      const resolved = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: new ProviderConfigMap(),
        accountProviders: new ProviderConfigMap(),
        zcodeBuiltinModelRules: new ModelConfigRules(),
        personalProviders: personal.providers,
        personalModels: personal.models,
      });
      expect(resolved.issues).toEqual([]);
      expect(
        new ProviderRegistry(resolved.registryProviders).validateSelection({
          providerId: "reasoning-replay",
          modelId: "reasoning-model",
          options: { reasoningLevel: "high" },
        }).ok,
      ).toBe(enabled);
    },
  );

  it("把 replay provider 写入唯一的版本化 Personal Config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-restart-provider-"));
    roots.push(root);
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
