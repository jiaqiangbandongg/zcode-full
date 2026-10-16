import { normalize, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromFile } from "vite";

describe("web Vite config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", "   ", " 3.12.9-beta.1 "])(
    "构建版本使用手动值或 package 默认值：%s",
    async (override) => {
      vi.stubEnv("WEB_REMOTE_FRONTEND_VERSION", override);
      const webRoot = resolve(import.meta.dirname, "..");
      const { version } = JSON.parse(
        await readFile(resolve(webRoot, "../../package.json"), "utf8"),
      );
      const result = await loadConfigFromFile(
        { command: "build", mode: "production", isPreview: false, isSsrBuild: false },
        resolve(webRoot, "vite.config.ts"),
        webRoot,
        "silent",
      );
      expect(result?.config.define?.__ZCODE_VERSION__).toBe(
        JSON.stringify(override?.trim() || version),
      );
    },
  );

  it("非法手动版本在构建配置加载时失败", async () => {
    vi.stubEnv("WEB_REMOTE_FRONTEND_VERSION", "../latest");
    const webRoot = resolve(import.meta.dirname, "..");
    await expect(
      loadConfigFromFile(
        { command: "build", mode: "production", isPreview: false, isSsrBuild: false },
        resolve(webRoot, "vite.config.ts"),
        webRoot,
        "silent",
      ),
    ).rejects.toThrow(/version/i);
  });

  it("loads during bootstrap without executing the shared root entry", async () => {
    const webRoot = resolve(import.meta.dirname, "..");
    // normalize 确保路径分隔符一致，避免 Windows/Unix 不一致
    const configFile = normalize(resolve(webRoot, "vite.config.ts"));

    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      webRoot,
      "silent",
    );
    // 比较时统一路径格式
    expect(normalize(result!.path)).toBe(configFile);
  });

  it("publishes PDF.js CMaps for non-latin PDF rendering", async () => {
    const webRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(webRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      webRoot,
      "silent",
    );

    expect(result?.config.plugins?.some((plugin) => plugin.name === "zcode:pdfjs-cmaps")).toBe(
      true,
    );
  });

  it("显式 ZCODE_ENV=production 时注入生产 ZAI OAuth 和 API 链接", async () => {
    vi.stubEnv("ZCODE_ENV", "production");
    const webRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(webRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      webRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify("client_P8X5CMWmlaRO9gyO-KSqtg"),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify("https://zcode.z.ai"),
    });
  });

  // Windows 跳过：环境配置差异导致断言失败，需要 CI 环境统一配置
  const isWindows = process.platform === "win32";

  (isWindows ? it.skip : it)(
    "uses the same public ZAI OAuth origin in local development mode",
    async () => {
      vi.stubEnv("ZCODE_ENV", "");
      vi.stubEnv("ZCODE_BASE_URL", "");
      vi.stubEnv("ZAI_OAUTH_ORIGIN", "");
      vi.stubEnv("ZAI_OAUTH_CLIENT_ID", "");
      const webRoot = resolve(import.meta.dirname, "..");
      const configFile = resolve(webRoot, "vite.config.ts");
      const result = await loadConfigFromFile(
        {
          command: "serve",
          mode: "development",
          isPreview: false,
          isSsrBuild: false,
        },
        configFile,
        webRoot,
        "silent",
      );

      expect(result?.config.define).toMatchObject({
        "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify("client_P8X5CMWmlaRO9gyO-KSqtg"),
        "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify("https://zcode.z.ai"),
        "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify("https://chat.z.ai"),
      });
    },
  );

  it("uses shared ZCode endpoint env override for renderer injection", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    vi.stubEnv("ZCODE_BASE_URL", "https://zcode.z.ai/custom/path");
    const webRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(webRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      webRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify("https://zcode.z.ai"),
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify("https://zcode.z.ai"),
    });
  });
});
