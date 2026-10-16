import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import {
  createModelProviderModelConfig,
  type ModelProviderConfig,
} from "../src/model-provider/legacyModelProviderSerialized.js";
import { readLegacyZCodeConfigProviders } from "../src/model-provider/legacyZCodeConfigProviderReader.js";

function createProvider(): ModelProviderConfig {
  return {
    id: "custom:test",
    name: "Test Provider",
    endpoints: {
      baseURL: "https://example.test/api",
      paths: {
        anthropic: "/messages",
      },
    },
    apiFormat: "anthropic-messages",
    defaultKind: "anthropic",
    apiKey: "test-key",
    models: [
      createModelProviderModelConfig({
        id: "test-model",
        kinds: ["anthropic"],
        defaultKind: "anthropic",
      }),
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("legacyZCodeConfigProviderReader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-provider-store-"));
    setDataBaseDir(tempDir);
  });

  afterEach(() => {
    setDataBaseDir(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("彻底忽略 model-providers.json", async () => {
    const legacyConfigDir = join(tempDir, ".zcode", "v2");
    mkdirSync(legacyConfigDir, { recursive: true });
    writeFileSync(
      join(legacyConfigDir, "model-providers.json"),
      JSON.stringify({
        schemaVersion: "zcode.model-providers.v2",
        providers: [createProvider()],
      }),
      "utf8",
    );
    const providers = await readLegacyZCodeConfigProviders();

    const configDir = join(tempDir, ".zcode", "v2");
    expect(providers).toEqual([]);
    expect(() => readFileSync(join(configDir, "config.json"), "utf-8")).toThrow();
  });

  it("只从已发布旧 config.json 读取 Provider", async () => {
    const legacyConfigDir = join(tempDir, ".zcode", "v2");
    mkdirSync(legacyConfigDir, { recursive: true });
    writeFileSync(
      join(legacyConfigDir, "config.json"),
      JSON.stringify({
        provider: {
          "custom:test": {
            name: "Test Provider",
            options: { baseURL: "https://example.test/api", apiKey: "test-key" },
            models: { "test-model": {} },
          },
        },
      }),
      "utf8",
    );

    const providers = await readLegacyZCodeConfigProviders();

    expect(providers.map((provider) => provider.id)).toEqual(["custom:test"]);
  });

  it("不把开发阶段曾写入 config.json 的未发布 Provider 格式当作迁移输入", async () => {
    const configDir = join(tempDir, ".zcode", "v2");
    const configPath = join(configDir, "config.json");
    const document = {
      schemaVersion: 1,
      providers: { unreleased: { enabled: true } },
      modelConfigRules: [],
    };
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(document, null, 2), "utf8");

    await expect(readLegacyZCodeConfigProviders()).resolves.toEqual([]);

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(document);
  });
});
