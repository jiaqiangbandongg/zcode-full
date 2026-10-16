import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

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
