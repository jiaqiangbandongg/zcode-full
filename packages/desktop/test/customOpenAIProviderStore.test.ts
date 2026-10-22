import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
} from "@zcode/provider";
import { decodeProviderConfigFile } from "@zcode/provider-node";

describe("custom OpenAI Provider E2E seed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("只写版本化 Personal Config，不再制造旧 Provider 事实来源", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "zcode-provider-seed-"));
    const cliConfigFile = join(homeDir, ".zcode", "cli", "config.json");
    await writeFileWithParents(
      cliConfigFile,
      JSON.stringify({ mcp: { example: { command: "example" } } }),
    );
    vi.stubEnv("ZCODE_E2E_HOME_DIR", homeDir);
    vi.stubEnv("E2E_PROVIDER_RUNTIME_BASE_URL", "http://127.0.0.1:43123");

    const { seedCustomOpenAIChatCompletionsProvider } =
      await import("./e2e/helpers/custom-openai-provider-store.js");
    await seedCustomOpenAIChatCompletionsProvider({
      providerId: "e2e-openai",
      providerName: "E2E OpenAI",
      modelId: "e2e-model",
      inputModalities: ["text", "image"],
    });

    const personalConfig = JSON.parse(
      await readFile(join(homeDir, ".zcode", "v2", "provider_config.json"), "utf-8"),
    ) as { config: { modelConfigRules: unknown } };
    const personal = decodeProviderConfigFile(personalConfig);
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
        providerId: "e2e-openai",
        modelId: "e2e-model",
        options: { reasoningLevel: "disabled" },
      }),
    ).toEqual({ ok: true });
    expect(personalConfig).toMatchObject({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "e2e-openai",
              providerName: "E2E OpenAI",
              config: {
                access: { type: "api-key", apiKey: "e2e-fixture-key" },
                api: {
                  type: "openai-chat-completions",
                  baseUrl: "http://127.0.0.1:43123",
                },
                personalModelIds: ["e2e-model"],
              },
            },
          ],
        },
      },
    });
    expect(personalConfig.config.modelConfigRules).toEqual(
      expect.objectContaining({
        providerModelRules: expect.arrayContaining([
          expect.objectContaining({
            providerId: "e2e-openai",
            modelId: "e2e-model",
            config: expect.objectContaining({
              properties: expect.objectContaining({
                inputFormat: expect.objectContaining({ supportsImage: true }),
              }),
            }),
          }),
        ]),
      }),
    );

    await expect(stat(join(homeDir, ".zcode", "v2", "model-providers.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    expect(JSON.parse(await readFile(cliConfigFile, "utf-8"))).toEqual({
      mcp: { example: { command: "example" } },
    });

    const { readModelProviders } = await import("./e2e/helpers/desktop-app.js");
    expect(await readModelProviders()).toEqual([
      expect.objectContaining({
        id: "e2e-openai",
        name: "E2E OpenAI",
        apiKey: "e2e-fixture-key",
        endpoints: expect.objectContaining({ baseURL: "http://127.0.0.1:43123" }),
        models: [
          expect.objectContaining({
            id: "e2e-model",
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
            modalities: expect.objectContaining({ input: ["text", "image"] }),
          }),
        ],
      }),
    ]);
  });

  it("E2E 观察保留 Coding Plan API Key，而不把已保存凭据投影为空", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "zcode-provider-key-read-"));
    vi.stubEnv("ZCODE_E2E_HOME_DIR", homeDir);
    await writeFileWithParents(
      join(homeDir, ".zcode", "v2", "provider_config.json"),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "example-plan",
                templateId: "example-template",
                providerName: "Example Plan",
                config: {
                  group: "standard-personal",
                  access: { type: "zhipu-coding-plan-api-key", apiKey: "e2e-plan-key" },
                  personalModelIds: [],
                },
              },
            ],
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
    );
    const { readModelProvider } = await import("./e2e/helpers/desktop-app.js");
    expect(await readModelProvider("example-plan")).toMatchObject({
      id: "example-plan",
      apiKey: "e2e-plan-key",
    });
  });

  it("E2E 诊断不再读取旧 Provider Store", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "zcode-provider-read-"));
    await writeFileWithParents(
      join(homeDir, ".zcode", "v2", "model-providers.json"),
      JSON.stringify([
        {
          id: "legacy-provider",
          name: "Legacy Provider",
          models: [],
        },
      ]),
    );
    vi.stubEnv("ZCODE_E2E_HOME_DIR", homeDir);

    const { readModelProviders } = await import("./e2e/helpers/desktop-app.js");
    expect(await readModelProviders()).toEqual([]);
  });
});

async function writeFileWithParents(file: string, content: string) {
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf-8");
}
