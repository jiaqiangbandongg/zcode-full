import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createConfig, parseEnvConfig } from "../src/config/index.js";

describe("env model config", () => {
  it("ignores legacy model environment variables", () => {
    const config = parseEnvConfig({
      ZCODE_API_KEY: "secret",
      ZCODE_BASE_URL: "https://api.example.test/anthropic",
      ZCODE_MODEL: "glm-5.1",
    });

    expect(config).not.toHaveProperty("model");
  });

  it("does not validate legacy model environment variables", () => {
    const config = parseEnvConfig({
      ZCODE_BASE_URL: "https://api.z.ai/api/anthropic",
      ZCODE_MODEL: "zai/",
    });

    expect(config).not.toHaveProperty("model");
  });

  it("does not let legacy env or file model config enter RuntimeConfig", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-env-model-"));
    const path = join(dir, "config.json");

    try {
      await writeFile(
        path,
        JSON.stringify({
          model: {
            main: "deepseek/deepseek-v4-pro",
            lite: "deepseek/deepseek-chat",
          },
          provider: {
            deepseek: {
              kind: "openai-compatible",
              options: {
                apiKey: "file-secret",
                baseURL: "https://api.deepseek.com",
              },
              models: {
                "deepseek-chat": {},
                "deepseek-v4-pro": {},
              },
            },
          },
        }),
      );

      const result = createConfig({
        env: {
          ZCODE_BASE_URL: "https://api.env.example/anthropic",
          ZCODE_MODEL: "env-model",
        },
        userConfigPath: path,
      });

      expect(result.sources.env).toBe(false);
      expect(result.config).not.toHaveProperty("model");
      expect(result.config).not.toHaveProperty("modelCatalog");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
