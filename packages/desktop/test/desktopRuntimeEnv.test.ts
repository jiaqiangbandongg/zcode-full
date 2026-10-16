import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const appMock = {
  isPackaged: false,
  getPath: vi.fn((name: string) => `/mock/${name}`),
};

// 编译期常量 ZCODE_PRODUCT_FLAVOR 决定 isPreviewPackagedRuntime；Dynamic Workflow 灰度的
// 「打包 production」档位必须能与 preview 区分，因此这里改成可切换的持有者，默认仍是 preview。
const productFlavorMock = { value: "preview" as string };

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("@zcode/shared", () => ({
  ZCODE_APP_VERSION_ENV: "ZCODE_APP_VERSION",
  ZCODE_BUILD_COMMIT_ID_ENV: "ZCODE_BUILD_COMMIT_ID",
  ZCODE_RUNTIME_ENV_KEY: "ZCODE_RUNTIME_ENV",
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY: "ZCODE_TOOL_ENV_PASSTHROUGH_JSON",
  ZCODE_AGENT_RUNTIME: {
    binaryKind: "native-binary",
    binaryEnvVar: "GLM_BINARY_PATH",
    bundledResourceDir: "glm",
    version: "0.0.0-test",
    spawnArgs: ["app-server", "--stdio"],
    nativeConfigDir: ".zcode/cli",
    nativeConfigFileName: "config.json",
    missingBinaryMessage: "[ZCode Agent] missing test binary",
    resolveEntrySegments: (platform: string) => [
      platform === "win32" ? "zcode-agent.exe" : "zcode-agent",
    ],
  },
  ZCODE_ENV: "test",
  get ZCODE_PRODUCT_FLAVOR() {
    return productFlavorMock.value;
  },
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV: "ZCODE_DYNAMIC_WORKFLOW_MODE",
  normalizeDynamicWorkflowMode: (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return ["disabled", "onDemand", "alwaysOn"].includes(trimmed) ? trimmed : undefined;
  },
  ZCODE_COMMIT: "commit-test",
  ZCODE_VERSION: "0.0.0-test",
  DEFAULT_ZCODE_ENDPOINT_ORIGIN: "https://zcode.z.ai",
  TEST_ZCODE_ENDPOINT_ORIGIN: "https://zcode.z.ai",
  resolveRuntimeZCodeEndpointOrigin: (env: Record<string, string | undefined>) =>
    env.ZCODE_BASE_URL ?? env.ZCODE_TEST_BASE_URL ?? "https://zcode.z.ai",
  resolveZaiOAuthOrigin: (env: Record<string, string | undefined>) =>
    env.ZAI_OAUTH_ORIGIN ?? env.ZAI_TEST_OAUTH_ORIGIN ?? "https://chat.z.ai",
  resolveZaiBusinessBaseUrl: (env: Record<string, string | undefined>) =>
    env.ZAI_BUSINESS_BASE_URL ?? env.ZAI_TEST_BUSINESS_BASE_URL ?? "https://api.z.ai",
  resolveZaiOAuthClientId: (env: Record<string, string | undefined>) =>
    env.ZAI_OAUTH_CLIENT_ID ?? env.ZAI_TEST_OAUTH_CLIENT_ID ?? "client_P8X5CMWmlaRO9gyO-KSqtg",
  sanitizeZCodeRuntimeEnv: (env: Record<string, string | undefined>) => {
    const sanitizedKeys = new Set([
      "NODE_ENV",
      "ELECTRON_RUN_AS_NODE",
      "NODE_NO_WARNINGS",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "REQUESTS_CA_BUNDLE",
      "CURL_CA_BUNDLE",
      "GIT_SSL_CAINFO",
    ]);
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (
        value == null ||
        sanitizedKeys.has(key.toUpperCase()) ||
        key.toUpperCase().startsWith("OTEL_") ||
        key.toUpperCase().startsWith("ZCODE_TELEMETRY_") ||
        key.toUpperCase() === "ZCODE_MODEL_TELEMETRY_ENABLED" ||
        /^(npm_config|yarn|pnpm)_(http_proxy|https_proxy|proxy|all_proxy|no_proxy|cafile|ca)$/i.test(
          key,
        )
      ) {
        continue;
      }
      sanitized[key] = value;
    }
    return sanitized;
  },
  readZCodeAgentTelemetryEnv: (env: Record<string, string | undefined>) =>
    Object.fromEntries(
      Object.entries(env).filter(([key, value]) => {
        const upperKey = key.toUpperCase();
        return (
          value != null &&
          (upperKey.startsWith("OTEL_") ||
            upperKey.startsWith("ZCODE_TELEMETRY_") ||
            upperKey === "ZCODE_MODEL_TELEMETRY_ENABLED")
        );
      }),
    ),
  buildZCodeToolEnvPassthroughEnv: (env: Record<string, string | undefined>) => {
    const captured: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      const upperKey = key.toUpperCase();
      if (
        value != null &&
        !["NODE_ENV", "ELECTRON_RUN_AS_NODE", "NODE_NO_WARNINGS"].includes(upperKey) &&
        ([
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "NODE_EXTRA_CA_CERTS",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "REQUESTS_CA_BUNDLE",
          "CURL_CA_BUNDLE",
          "GIT_SSL_CAINFO",
        ].includes(upperKey) ||
          /^(npm_config|yarn|pnpm)_(http_proxy|https_proxy|proxy|all_proxy|no_proxy|cafile|ca)$/i.test(
            key,
          ))
      ) {
        captured[key] = value;
      }
    }
    return Object.keys(captured).length > 0
      ? { ZCODE_TOOL_ENV_PASSTHROUGH_JSON: JSON.stringify(captured) }
      : {};
  },
}));

vi.mock("@zcode/services/node", () => ({
  getAppConfigDir: vi.fn(() => "/mock/config"),
  getDataBaseDir: vi.fn(() => "/mock/db"),
  ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV: "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV: "ZCODE_WINDOWS_APP_INSTALL_DIR",
}));

const originalUseCdnSwitch = process.env["ZCODE_DEV_REMOTE_ASSET_USE_CDN"];
const originalCdnBaseUrl = process.env["ZCODE_REMOTE_ASSET_CDN_BASE_URL"];
const originalRemoteAssetCacheDir = process.env["ZCODE_REMOTE_ASSET_CACHE_DIR"];
const originalNodeNoWarnings = process.env["NODE_NO_WARNINGS"];
const originalNodeEnv = process.env["NODE_ENV"];
const originalZCodeRuntimeEnv = process.env["ZCODE_RUNTIME_ENV"];
const originalGlmBinaryPath = process.env["GLM_BINARY_PATH"];
const originalZCodeBaseUrl = process.env["ZCODE_BASE_URL"];
const originalZCodeEndpointOrigin = process.env["ZCODE_ENDPOINT_ORIGIN"];
const originalDynamicWorkflowMode = process.env["ZCODE_DYNAMIC_WORKFLOW_MODE"];
const originalZaiOAuthOrigin = process.env["ZAI_OAUTH_ORIGIN"];
const originalZaiBusinessBaseUrl = process.env["ZAI_BUSINESS_BASE_URL"];
const originalZaiOAuthClientId = process.env["ZAI_OAUTH_CLIENT_ID"];
const originalDesktopApplicationName = process.env["ZCODE_DESKTOP_APPLICATION_NAME"];
const originalDesktopHomeDir = process.env["ZCODE_DESKTOP_HOME_DIR"];
const originalDesktopUserDataDir = process.env["ZCODE_DESKTOP_USER_DATA_DIR"];
const originalDesktopSessionDataDir = process.env["ZCODE_DESKTOP_SESSION_DATA_DIR"];
const originalDesktopUseElectronDefaultUserData =
  process.env["ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA"];
const originalCwd = process.cwd();
const originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const createdDirs: string[] = [];

function restoreEnvValue(key: string, value: string | undefined) {
  if (value == null) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

// Bugfix: 开发机 shell（如 ~/.codegeex/mamba profile）常注入 NO_PROXY/SSL_CERT_FILE 等代理证书
// 变量，buildHostProcessEnv 会把它们并入 ZCODE_TOOL_ENV_PASSTHROUGH_JSON / telemetry env，
// 断言随宿主机环境漂移。逐个枚举清单必然漏网，这里按 passthrough/telemetry 捕获口径全量清理并恢复。
const AMBIENT_TOOL_PASSTHROUGH_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "ZCODE_MODEL_TELEMETRY_ENABLED",
]);
const AMBIENT_PACKAGE_MANAGER_PROXY_ENV_PATTERN =
  /^(npm_config|yarn|pnpm)_(http_proxy|https_proxy|proxy|all_proxy|no_proxy|cafile|ca)$/i;

function isAmbientHostEnvKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return (
    AMBIENT_TOOL_PASSTHROUGH_ENV_KEYS.has(upperKey) ||
    upperKey.startsWith("OTEL_") ||
    upperKey.startsWith("ZCODE_TELEMETRY_") ||
    AMBIENT_PACKAGE_MANAGER_PROXY_ENV_PATTERN.test(key)
  );
}

const originalAmbientHostEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && isAmbientHostEnvKey(key)) {
    originalAmbientHostEnv[key] = value;
  }
}

function deleteAmbientHostEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (isAmbientHostEnvKey(key)) {
      delete process.env[key];
    }
  }
}

function resolveTestMockCdnReleaseDir(): string {
  return join(process.cwd(), "packages", "desktop", "mock-cdn", "releases", "0.0.0-test");
}

async function withTestMockCdnReleaseDir<T>(
  mode: "present" | "missing",
  task: () => Promise<T>,
): Promise<T> {
  const releaseDir = resolveTestMockCdnReleaseDir();
  const backupDir = `${releaseDir}.backup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const hadReleaseDir = existsSync(releaseDir);
  if (hadReleaseDir) {
    renameSync(releaseDir, backupDir);
  }

  try {
    if (mode === "present") {
      mkdirSync(releaseDir, { recursive: true });
    } else {
      rmSync(releaseDir, { recursive: true, force: true });
    }
    vi.resetModules();
    return await task();
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
    if (hadReleaseDir) {
      renameSync(backupDir, releaseDir);
    }
  }
}
function expectRuntimePath(actualPath: string | undefined, expectedPath: string) {
  // Bugfix: macOS 的 /var 是 /private/var 的符号链接，chdir 后 process.cwd() 会返回真实路径。
  // buildHostProcessEnv 按 cwd 解析 bundled runtime，因此断言也要比较真实路径，避免路径拼写差异掩盖优先级语义。
  expect(actualPath).toBe(realpathSync(expectedPath));
}

describe("desktopRuntimeEnv resolveRemoteAssetDirs", () => {
  beforeEach(() => {
    vi.resetModules();
    appMock.isPackaged = false;
    appMock.getPath.mockImplementation((name: string) => `/mock/${name}`);
    delete process.env["ZCODE_DEV_REMOTE_ASSET_USE_CDN"];
    delete process.env["ZCODE_REMOTE_ASSET_CDN_BASE_URL"];
    delete process.env["ZCODE_REMOTE_ASSET_CACHE_DIR"];
  });

  afterAll(() => {
    if (originalUseCdnSwitch == null) {
      delete process.env["ZCODE_DEV_REMOTE_ASSET_USE_CDN"];
    } else {
      process.env["ZCODE_DEV_REMOTE_ASSET_USE_CDN"] = originalUseCdnSwitch;
    }

    if (originalCdnBaseUrl == null) {
      delete process.env["ZCODE_REMOTE_ASSET_CDN_BASE_URL"];
    } else {
      process.env["ZCODE_REMOTE_ASSET_CDN_BASE_URL"] = originalCdnBaseUrl;
    }

    if (originalRemoteAssetCacheDir == null) {
      delete process.env["ZCODE_REMOTE_ASSET_CACHE_DIR"];
    } else {
      process.env["ZCODE_REMOTE_ASSET_CACHE_DIR"] = originalRemoteAssetCacheDir;
    }

    if (originalNodeNoWarnings == null) {
      delete process.env["NODE_NO_WARNINGS"];
    } else {
      process.env["NODE_NO_WARNINGS"] = originalNodeNoWarnings;
    }
  });

  it("开发态当前版本 mock-cdn 存在时默认走 mock-cdn", async () => {
    await withTestMockCdnReleaseDir("present", async () => {
      const { resolveRemoteAssetDirs } = await import("../src/main/desktopRuntimeEnv.js");
      const dirs = resolveRemoteAssetDirs({
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
      });

      expect(dirs.mockCdnDir).toMatch(/[\\/]mock-cdn$/);
      expect(dirs.remoteCdnBaseUrl).toBe(
        "http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test",
      );
      expect(dirs.remoteCdnBaseUrls).toEqual([
        "http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test",
      ]);
      expect(dirs.remoteCacheDir).toMatch(/[\\/]userData[\\/]remote-assets-cache$/);
    });
  });

  it("开发态当前版本 mock-cdn 缺失时回退到 CDN cache", async () => {
    await withTestMockCdnReleaseDir("missing", async () => {
      const { resolveRemoteAssetDirs } = await import("../src/main/desktopRuntimeEnv.js");
      const dirs = resolveRemoteAssetDirs({
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
      });

      expect(dirs.mockCdnDir).toBeUndefined();
      expect(dirs.remoteCdnBaseUrl).toBe(
        "http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test",
      );
      expect(dirs.remoteCdnBaseUrls).toEqual([
        "http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test",
      ]);
      expect(dirs.remoteCacheDir).toMatch(/[\\/]userData[\\/]remote-assets-cache$/);
    });
  });
  it("开发态打开开关后应直接走 CDN", async () => {
    process.env["ZCODE_DEV_REMOTE_ASSET_USE_CDN"] = "TRUE";
    const { resolveRemoteAssetDirs } = await import("../src/main/desktopRuntimeEnv.js");
    const dirs = resolveRemoteAssetDirs({
      locale: "en-US",
      timeZone: "Asia/Shanghai",
    });

    expect(dirs.mockCdnDir).toBeUndefined();
    expect(dirs.remoteCdnBaseUrl).toBe(
      "http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test",
    );
    expect(dirs.remoteCdnBaseUrls).toEqual([
      "http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test",
    ]);
    expect(dirs.remoteCacheDir).toMatch(/[\\/]userData[\\/]remote-assets-cache$/);
  });

  it("生产态应始终走 CDN 分支", async () => {
    appMock.isPackaged = true;
    process.env["ZCODE_DEV_REMOTE_ASSET_USE_CDN"] = "0";
    process.env["ZCODE_REMOTE_ASSET_CDN_BASE_URL"] = "https://cdn.example.com/releases///";
    const { resolveRemoteAssetDirs } = await import("../src/main/desktopRuntimeEnv.js");
    const dirs = resolveRemoteAssetDirs({
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
    });

    expect(dirs.mockCdnDir).toBeUndefined();
    expect(dirs.remoteCdnBaseUrl).toBe("https://cdn.example.com/releases");
    expect(dirs.remoteCdnBaseUrls).toEqual(["https://cdn.example.com/releases"]);
    expect(dirs.remoteCacheDir).toMatch(/[\\/]userData[\\/]remote-assets-cache$/);
  });

  it("remote asset cache 目录支持环境变量覆盖", async () => {
    const overrideCacheDir = join(tmpdir(), "zcode-prod-remote-assets-cache");
    process.env["ZCODE_REMOTE_ASSET_CACHE_DIR"] = overrideCacheDir;
    const { resolveRemoteAssetDirs } = await import("../src/main/desktopRuntimeEnv.js");
    const dirs = resolveRemoteAssetDirs({
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
    });

    expect(dirs.remoteCacheDir).toBe(overrideCacheDir);
  });

  it("remote asset cache 目录支持本地 env 文件覆盖", async () => {
    const overrideCacheDir = join(tmpdir(), "zcode-local-env-remote-assets-cache");
    const { resolveRemoteAssetDirs } = await import("../src/main/desktopRuntimeEnv.js");
    const dirs = resolveRemoteAssetDirs(
      {
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
      },
      {
        ZCODE_REMOTE_ASSET_CACHE_DIR: overrideCacheDir,
      },
    );

    expect(dirs.remoteCacheDir).toBe(overrideCacheDir);
  });

  it("开发态本地 env 文件可切到 CDN 并覆盖 CDN 与 cache", async () => {
    const overrideCacheDir = join(tmpdir(), "zcode-local-env-cdn-remote-assets-cache");
    const { resolveRemoteAssetDirs } = await import("../src/main/desktopRuntimeEnv.js");
    const dirs = resolveRemoteAssetDirs(
      {
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
      },
      {
        ZCODE_DEV_REMOTE_ASSET_USE_CDN: "1",
        ZCODE_REMOTE_ASSET_CDN_BASE_URL: "https://cdn.example.com/releases///",
        ZCODE_REMOTE_ASSET_CACHE_DIR: overrideCacheDir,
      },
    );

    expect(dirs.mockCdnDir).toBeUndefined();
    expect(dirs.remoteCdnBaseUrl).toBe("https://cdn.example.com/releases");
    expect(dirs.remoteCdnBaseUrls).toEqual(["https://cdn.example.com/releases"]);
    expect(dirs.remoteCacheDir).toBe(overrideCacheDir);
  });
});

describe("desktopRuntimeEnv buildHostProcessEnv", () => {
  beforeEach(() => {
    vi.resetModules();
    appMock.isPackaged = false;
    appMock.getPath.mockImplementation((name: string) => `/mock/${name}`);
    delete process.env["NODE_NO_WARNINGS"];
    delete process.env["NODE_ENV"];
    delete process.env["ZCODE_RUNTIME_ENV"];
    deleteAmbientHostEnv();
    delete process.env["GLM_BINARY_PATH"];
    delete process.env["ZCODE_BASE_URL"];
    delete process.env["ZCODE_ENDPOINT_ORIGIN"];
    delete process.env["ZCODE_DYNAMIC_WORKFLOW_MODE"];
    productFlavorMock.value = "preview";
    process.chdir(originalCwd);
  });

  afterAll(() => {
    restoreEnvValue("NODE_NO_WARNINGS", originalNodeNoWarnings);
    restoreEnvValue("ZCODE_DYNAMIC_WORKFLOW_MODE", originalDynamicWorkflowMode);
    productFlavorMock.value = "preview";
    restoreEnvValue("NODE_ENV", originalNodeEnv);
    restoreEnvValue("ZCODE_RUNTIME_ENV", originalZCodeRuntimeEnv);
    deleteAmbientHostEnv();
    for (const [key, value] of Object.entries(originalAmbientHostEnv)) {
      process.env[key] = value;
    }

    if (originalGlmBinaryPath == null) {
      delete process.env["GLM_BINARY_PATH"];
    } else {
      process.env["GLM_BINARY_PATH"] = originalGlmBinaryPath;
    }
    restoreEnvValue("ZCODE_BASE_URL", originalZCodeBaseUrl);
    restoreEnvValue("ZCODE_ENDPOINT_ORIGIN", originalZCodeEndpointOrigin);
    restoreEnvValue("ZAI_OAUTH_ORIGIN", originalZaiOAuthOrigin);
    restoreEnvValue("ZAI_BUSINESS_BASE_URL", originalZaiBusinessBaseUrl);
    restoreEnvValue("ZAI_OAUTH_CLIENT_ID", originalZaiOAuthClientId);
    if (originalResourcesPathDescriptor) {
      Object.defineProperty(process, "resourcesPath", originalResourcesPathDescriptor);
    } else {
      Reflect.deleteProperty(process, "resourcesPath");
    }

    process.chdir(originalCwd);
    for (const dir of createdDirs.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("host 进程 env 不再注入 NODE_NO_WARNINGS", async () => {
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv({});

    // Bugfix: warning 抑制改由 utilityProcess.fork 的 execArgv 负责，避免 Node 专用变量继续泄漏到 shell。
    expect(env.NODE_NO_WARNINGS).toBeUndefined();
  });

  it("host 进程显式注入 app version 和 build commit 供 agent 使用", async () => {
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv({});

    expect(env.ZCODE_APP_VERSION).toBe("0.0.0-test");
    expect(env.ZCODE_BUILD_COMMIT_ID).toBe("commit-test");
  });

  it("只把 Agent OTLP 配置定向注入 host，并剔除外部身份字段", async () => {
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=secret",
      ZCODE_TELEMETRY_USER_ID: "raw-oauth-user",
      ZCODE_TELEMETRY_USER_SUBJECT_ID: "spoofed-user-subject",
      ZCODE_TELEMETRY_IDENTITY_STATE: "authenticated",
      ZCODE_TELEMETRY_DEVICE_MID: "spoofed-device",
      ZCODE_TELEMETRY_RUNTIME_SURFACE: "standalone-cli",
    });

    expect(env).toMatchObject({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://arms.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=secret",
    });
    expect(env.ZCODE_TELEMETRY_USER_ID).toBeUndefined();
    expect(env.ZCODE_TELEMETRY_USER_SUBJECT_ID).toBeUndefined();
    expect(env.ZCODE_TELEMETRY_IDENTITY_STATE).toBeUndefined();
    expect(env.ZCODE_TELEMETRY_DEVICE_MID).toBeUndefined();
    expect(env.ZCODE_TELEMETRY_RUNTIME_SURFACE).toBeUndefined();
    expect(env.ZCODE_TOOL_ENV_PASSTHROUGH_JSON).toBeUndefined();
  });

  it("正式安装包默认配置只接收 OTLP 连接字段，不接受构建期身份字段", async () => {
    const { resolvePackagedAgentTelemetryEnv } = await import("../src/main/desktopRuntimeEnv.js");

    expect(
      resolvePackagedAgentTelemetryEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example.com/otlp",
        OTEL_EXPORTER_OTLP_HEADERS: "x-arms-license-key=write-only",
        OTEL_SERVICE_NAME: "zcode-cli-agent",
        ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
        ZCODE_TELEMETRY_USER_SUBJECT_ID: "spoofed-user",
        ZCODE_TELEMETRY_DEVICE_MID: "spoofed-device",
      }),
    ).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://arms.example.com/otlp",
      OTEL_EXPORTER_OTLP_HEADERS: "x-arms-license-key=write-only",
      OTEL_SERVICE_NAME: "zcode-cli-agent",
      ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
    });
  });

  it("Windows 打包态会从 resourcesPath 推导安装目录供数据目录保护使用", async () => {
    const { resolveWindowsAppInstallDirForDataBaseDirGuard } =
      await import("../src/main/desktopRuntimeEnv.js");

    expect(
      resolveWindowsAppInstallDirForDataBaseDirGuard({
        platform: "win32",
        isPackaged: true,
        resourcesPath: "C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode\\resources",
      }),
    ).toBe("C:\\Users\\tester\\AppData\\Local\\Programs\\ZCode");
  });

  it("非 Windows 或开发态不会注入安装目录保护路径", async () => {
    const { resolveWindowsAppInstallDirForDataBaseDirGuard } =
      await import("../src/main/desktopRuntimeEnv.js");

    expect(
      resolveWindowsAppInstallDirForDataBaseDirGuard({
        platform: "darwin",
        isPackaged: true,
        resourcesPath: "/Applications/ZCode.app/Contents/Resources",
      }),
    ).toBeUndefined();
    expect(
      resolveWindowsAppInstallDirForDataBaseDirGuard({
        platform: "win32",
        isPackaged: false,
        resourcesPath: "C:\\repo\\packages\\desktop",
      }),
    ).toBeUndefined();
  });

  it("本地开发态 host 进程显式注入 ZCODE_RUNTIME_ENV=development 且不传 NODE_ENV", async () => {
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv({});

    expect(env.ZCODE_RUNTIME_ENV).toBe("development");
    expect(env.NODE_ENV).toBeUndefined();
  });

  // 根因：bundledCuaHelperAppPath 只在 darwin 上计算（desktopRuntimeEnv.ts:474 直接
  // `process.platform !== "darwin" ? undefined : ...`），其他平台不写这个键，继承值原样穿透。
  // Windows CUA 走独立的 Node Helper，不使用 .app bundle，所以下面几条 dev bundle 断言
  // 只在 darwin 上有意义。
  it.skipIf(process.platform !== "darwin")(
    "本地免签 CUA 使用 dev Helper bundle，且不回退网络下载",
    async () => {
      const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

      const env = buildHostProcessEnv({
        ZCODE_HOME: "/tmp/zcode-cua-dev-home",
        ZCODE_CUA_PRODUCT_HELPER: "1",
        ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
      });

      expect(env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH).toBe(
        join("/tmp/zcode-cua-dev-home", "computer-use", "dev", "ZCode Computer Use Dev.app"),
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "本地免签 CUA 尊重显式 bundled Helper 路径以支持无打包源码验证",
    async () => {
      const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

      const env = buildHostProcessEnv({
        ZCODE_HOME: "/tmp/zcode-cua-dev-home",
        ZCODE_CUA_PRODUCT_HELPER: "1",
        ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
        ZCODE_CUA_BUNDLED_HELPER_APP_PATH: "/tmp/new-helper/ZCode Computer Use Dev.app",
      });

      expect(env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH).toBe(
        "/tmp/new-helper/ZCode Computer Use Dev.app",
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "本地免签 CUA 在显式 bundled Helper 路径为空白时回退到默认 dev bundle",
    async () => {
      const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

      const env = buildHostProcessEnv({
        ZCODE_HOME: "/tmp/zcode-cua-dev-home",
        ZCODE_CUA_PRODUCT_HELPER: "1",
        ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
        ZCODE_CUA_BUNDLED_HELPER_APP_PATH: "   ",
      });

      expect(env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH).toBe(
        join("/tmp/zcode-cua-dev-home", "computer-use", "dev", "ZCode Computer Use Dev.app"),
      );
    },
  );

  it("打包态 host 进程显式注入 ZCODE_RUNTIME_ENV=production 且不传 NODE_ENV", async () => {
    appMock.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: "/mock/resources",
      configurable: true,
    });
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv({
      ZCODE_CUA_BUNDLED_HELPER_APP_PATH: "/tmp/untrusted-helper.app",
      ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
    });

    expect(env.ZCODE_RUNTIME_ENV).toBe("production");
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL).toBeUndefined();
  });

  it("打包 Preview 不向 Host 注入 storage profile 或精确 CLI 根", async () => {
    appMock.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: "/mock/resources",
      configurable: true,
    });
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv({});

    expect(env.ZCODE_STORAGE_PROFILE).toBeUndefined();
    expect(env.ZCODE_STORAGE_DIR).toBeUndefined();
    expect(env.ZCODE_HOME).toBeUndefined();
  });

  it("源码开发态不向 Host 注入独立 storage profile 或精确 CLI 根", async () => {
    appMock.isPackaged = false;
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv({});

    expect(env.ZCODE_STORAGE_PROFILE).toBeUndefined();
    expect(env.ZCODE_STORAGE_DIR).toBeUndefined();
    expect(env.ZCODE_HOME).toBeUndefined();
  });

  // 拆出来的原因：「打包态用 Resources 里的签名 Helper 覆盖外部传入路径」这条断言只在 darwin
  // 成立（desktopRuntimeEnv.ts:474 非 darwin 直接给 undefined，继承值原样穿透），
  // 而同一条用例里的 ZCODE_RUNTIME_ENV / NODE_ENV / ALLOW_UNSIGNED 是跨平台契约，
  // 整条 skip 会连带丢掉这三条覆盖，所以只把 macOS 专属的那条单独 gate。
  it.skipIf(process.platform !== "darwin")(
    "打包态 host 进程用 Resources 里的 Helper 覆盖外部传入的 bundled 路径",
    async () => {
      appMock.isPackaged = true;
      Object.defineProperty(process, "resourcesPath", {
        value: "/mock/resources",
        configurable: true,
      });
      const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

      const env = buildHostProcessEnv({
        ZCODE_CUA_BUNDLED_HELPER_APP_PATH: "/tmp/untrusted-helper.app",
        ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
      });

      expect(env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH).toBe(
        join("/mock/resources", "cua-helper", "ZCode Computer Use.app"),
      );
    },
  );

  it("host 进程过滤 shell 注入的运行时、代理和证书变量", async () => {
    process.env["NODE_ENV"] = "development";
    process.env["HTTP_PROXY"] = "http://ambient-proxy:8080";
    process.env["NODE_EXTRA_CA_CERTS"] = "/tmp/ambient-ca.pem";
    process.env["npm_config_proxy"] = "http://npm-proxy:8080";
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv({
      http_proxy: "http://local-proxy:8080",
      NODE_NO_WARNINGS: "1",
    });

    expect(env.ZCODE_RUNTIME_ENV).toBe("development");
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.NODE_NO_WARNINGS).toBeUndefined();
    expect(env.npm_config_proxy).toBeUndefined();
    expect(JSON.parse(env.ZCODE_TOOL_ENV_PASSTHROUGH_JSON ?? "{}")).toMatchObject({
      http_proxy: "http://local-proxy:8080",
      HTTP_PROXY: "http://ambient-proxy:8080",
      NODE_EXTRA_CA_CERTS: "/tmp/ambient-ca.pem",
      npm_config_proxy: "http://npm-proxy:8080",
    });
  });

  it("bundled GLM runtime 优先于本地显式 GLM_BINARY_PATH", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-desktop-runtime-env-"));
    createdDirs.push(sandboxRoot);
    const platformKey = `${process.platform}-${process.arch}`;
    const bundledBinaryName = process.platform === "win32" ? "zcode-agent.exe" : "zcode-agent";
    const bundledPath = join(sandboxRoot, "bundled-agents", platformKey, "glm", bundledBinaryName);
    const localGlmPath = join(sandboxRoot, "local", "zcode-agent");
    mkdirSync(join(sandboxRoot, "bundled-agents", platformKey, "glm"), {
      recursive: true,
    });
    mkdirSync(join(sandboxRoot, "local"), { recursive: true });
    writeFileSync(bundledPath, "bundled\n", "utf-8");
    writeFileSync(localGlmPath, "local\n", "utf-8");
    process.chdir(sandboxRoot);

    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv({ GLM_BINARY_PATH: localGlmPath });

    expectRuntimePath(env.GLM_BINARY_PATH, bundledPath);
  });

  it("本地 host 进程加载工作区 .env.development 的测试环境 API 与 ZAI 登录入口", async () => {
    const { loadHostProcessEnvFromLocalFiles } = await import("../src/main/desktopRuntimeEnv.js");

    const env = loadHostProcessEnvFromLocalFiles();

    expect(env.ZCODE_BASE_URL).toBe("https://zcode.z.ai");
    expect(env.ZAI_OAUTH_ORIGIN).toBe("https://chat.z.ai");
    expect(env.ZAI_BUSINESS_BASE_URL).toBe("https://api.z.ai");
    expect(env.ZAI_OAUTH_CLIENT_ID).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
  });

  it("main 进程 endpoint 临时覆盖优先读取命令行环境变量", async () => {
    process.env["ZCODE_ENDPOINT_ORIGIN"] = "http://127.0.0.1:18765";
    const { resolveZCodeEndpointEnvBaseOrigin } = await import("../src/main/desktopRuntimeEnv.js");

    expect(
      resolveZCodeEndpointEnvBaseOrigin({
        ZCODE_BASE_URL: "https://zcode.z.ai",
      }),
    ).toBe("http://127.0.0.1:18765");
  });

  it("打包后的测试环境 host 进程应内置测试环境登录入口", async () => {
    appMock.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: "/mock/resources",
      configurable: true,
    });
    delete process.env["ZCODE_BASE_URL"];
    delete process.env["ZCODE_ENDPOINT_ORIGIN"];
    delete process.env["ZAI_OAUTH_ORIGIN"];
    delete process.env["ZAI_BUSINESS_BASE_URL"];
    delete process.env["ZAI_OAUTH_CLIENT_ID"];

    const { buildHostProcessEnv, loadHostProcessEnvFromLocalFiles } =
      await import("../src/main/desktopRuntimeEnv.js");

    const env = buildHostProcessEnv(loadHostProcessEnvFromLocalFiles());

    expect(env.ZCODE_ENV).toBe("test");
    expect(env.ZCODE_BASE_URL).toBe("https://zcode.z.ai");
    expect(env.ZAI_OAUTH_ORIGIN).toBe("https://chat.z.ai");
    expect(env.ZAI_BUSINESS_BASE_URL).toBe("https://api.z.ai");
    expect(env.ZAI_OAUTH_CLIENT_ID).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
    expect(env.ZCODE_CUA_HELPER_INSTALL_VARIANT).toBe("preview");
  });

  // DWG-05（docs/dynamic-workflow/launch.md「Gray release」）：Main 对
  // ZCODE_DYNAMIC_WORKFLOW_MODE 只有「写」和「删」两种动作，先在纯函数上钉住三档语义。
  describe("resolveDynamicWorkflowModeHostEnv", () => {
    it("未打包 dev 透传 shell 里的合法取值", async () => {
      const { resolveDynamicWorkflowModeHostEnv } =
        await import("../src/main/desktopRuntimeEnv.js");

      expect(
        resolveDynamicWorkflowModeHostEnv({
          inheritedValue: "disabled",
          isPackaged: false,
          isPreview: false,
        }),
      ).toEqual({ ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled" });
    });

    it("未打包 dev 丢弃非法取值和缺省值，而不是转发给 Host", async () => {
      const { resolveDynamicWorkflowModeHostEnv } =
        await import("../src/main/desktopRuntimeEnv.js");

      expect(
        resolveDynamicWorkflowModeHostEnv({
          inheritedValue: "garbage",
          isPackaged: false,
          isPreview: false,
        }),
      ).toEqual({});
      expect(
        resolveDynamicWorkflowModeHostEnv({
          inheritedValue: undefined,
          isPackaged: false,
          isPreview: false,
        }),
      ).toEqual({});
    });

    it("打包 preview 固定写入 alwaysOn，忽略 shell 的相反取值", async () => {
      const { resolveDynamicWorkflowModeHostEnv } =
        await import("../src/main/desktopRuntimeEnv.js");

      expect(
        resolveDynamicWorkflowModeHostEnv({
          inheritedValue: "disabled",
          isPackaged: true,
          isPreview: true,
        }),
      ).toEqual({ ZCODE_DYNAMIC_WORKFLOW_MODE: "alwaysOn" });
    });

    it("打包 production 永不写入，shell 的合法取值同样无效", async () => {
      const { resolveDynamicWorkflowModeHostEnv } =
        await import("../src/main/desktopRuntimeEnv.js");

      expect(
        resolveDynamicWorkflowModeHostEnv({
          inheritedValue: "alwaysOn",
          isPackaged: true,
          isPreview: false,
        }),
      ).toEqual({});
    });
  });

  it("未打包 dev 的 host env 带上 shell 里的 Dynamic Workflow 覆盖，非法取值则整键消失", async () => {
    process.env["ZCODE_DYNAMIC_WORKFLOW_MODE"] = "onDemand";
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    expect(buildHostProcessEnv({}).ZCODE_DYNAMIC_WORKFLOW_MODE).toBe("onDemand");

    vi.resetModules();
    process.env["ZCODE_DYNAMIC_WORKFLOW_MODE"] = "not-a-mode";
    const { buildHostProcessEnv: rebuilt } = await import("../src/main/desktopRuntimeEnv.js");

    // 非法值必须被删掉而不是随 inheritedEnv 穿透；否则 Host 还要自己分辨来源。
    expect(rebuilt({}).ZCODE_DYNAMIC_WORKFLOW_MODE).toBeUndefined();
  });

  it("打包 preview 的 host env 把 Dynamic Workflow 覆盖改写成 alwaysOn", async () => {
    appMock.isPackaged = true;
    productFlavorMock.value = "preview";
    Object.defineProperty(process, "resourcesPath", {
      value: "/mock/resources",
      configurable: true,
    });
    process.env["ZCODE_DYNAMIC_WORKFLOW_MODE"] = "disabled";

    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    expect(buildHostProcessEnv({}).ZCODE_DYNAMIC_WORKFLOW_MODE).toBe("alwaysOn");
  });

  it("打包 production 的 host env 删除继承的 Dynamic Workflow 覆盖", async () => {
    appMock.isPackaged = true;
    productFlavorMock.value = "production";
    Object.defineProperty(process, "resourcesPath", {
      value: "/mock/resources",
      configurable: true,
    });
    process.env["ZCODE_DYNAMIC_WORKFLOW_MODE"] = "alwaysOn";

    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");

    // shell 和 .env 两条继承路径都要被删干净，本机环境变量不能自行打开灰度。
    expect(buildHostProcessEnv({}).ZCODE_DYNAMIC_WORKFLOW_MODE).toBeUndefined();
    expect(
      buildHostProcessEnv({ ZCODE_DYNAMIC_WORKFLOW_MODE: "alwaysOn" }).ZCODE_DYNAMIC_WORKFLOW_MODE,
    ).toBeUndefined();
  });
});

describe("desktopRuntimeEnv runtime identity", () => {
  beforeEach(() => {
    vi.resetModules();
    appMock.isPackaged = false;
    appMock.getPath.mockClear();
    appMock.getPath.mockImplementation((name: string) => `/mock/${name}`);
    delete process.env["ZCODE_DESKTOP_APPLICATION_NAME"];
    delete process.env["ZCODE_DESKTOP_HOME_DIR"];
    delete process.env["ZCODE_DESKTOP_USER_DATA_DIR"];
    delete process.env["ZCODE_DESKTOP_SESSION_DATA_DIR"];
    delete process.env["ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA"];
  });

  afterAll(() => {
    if (originalDesktopApplicationName == null) {
      delete process.env["ZCODE_DESKTOP_APPLICATION_NAME"];
    } else {
      process.env["ZCODE_DESKTOP_APPLICATION_NAME"] = originalDesktopApplicationName;
    }

    if (originalDesktopHomeDir == null) {
      delete process.env["ZCODE_DESKTOP_HOME_DIR"];
    } else {
      process.env["ZCODE_DESKTOP_HOME_DIR"] = originalDesktopHomeDir;
    }

    if (originalDesktopUserDataDir == null) {
      delete process.env["ZCODE_DESKTOP_USER_DATA_DIR"];
    } else {
      process.env["ZCODE_DESKTOP_USER_DATA_DIR"] = originalDesktopUserDataDir;
    }

    if (originalDesktopSessionDataDir == null) {
      delete process.env["ZCODE_DESKTOP_SESSION_DATA_DIR"];
    } else {
      process.env["ZCODE_DESKTOP_SESSION_DATA_DIR"] = originalDesktopSessionDataDir;
    }

    if (originalDesktopUseElectronDefaultUserData == null) {
      delete process.env["ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA"];
    } else {
      process.env["ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA"] =
        originalDesktopUseElectronDefaultUserData;
    }
  });

  it("e2e 可通过环境变量隔离应用名和 Electron 数据目录", async () => {
    process.env["ZCODE_DESKTOP_APPLICATION_NAME"] = "ZCode E2E";
    process.env["ZCODE_DESKTOP_HOME_DIR"] = "/tmp/zcode-e2e/home";
    process.env["ZCODE_DESKTOP_USER_DATA_DIR"] = "/tmp/zcode-e2e/user-data";
    process.env["ZCODE_DESKTOP_SESSION_DATA_DIR"] = "/tmp/zcode-e2e/session-data";

    const { runtimeApplicationName, runtimeHomePath, runtimeSessionDataPath, runtimeUserDataPath } =
      await import("../src/main/desktopRuntimeEnv.js");

    expect(runtimeApplicationName).toBe("ZCode E2E");
    expect(runtimeHomePath).toBe("/tmp/zcode-e2e/home");
    expect(runtimeUserDataPath).toBe("/tmp/zcode-e2e/user-data");
    expect(runtimeSessionDataPath).toBe("/tmp/zcode-e2e/session-data");
  });

  it("打包测试环境使用 Preview 应用名和独立 Electron 数据目录", async () => {
    appMock.isPackaged = true;

    const {
      isPreviewPackagedRuntime,
      runtimeApplicationName,
      runtimeSessionDataPath,
      runtimeUserDataPath,
    } = await import("../src/main/desktopRuntimeEnv.js");

    expect(isPreviewPackagedRuntime).toBe(true);
    expect(runtimeApplicationName).toBe("ZCode Preview");
    // Bugfix：这两条路径由实现用宿主 path.join 从 app.getPath("appData") 拼出，
    // Windows 上是 `\mock\appData\ZCode Preview`，写死 POSIX 字面量必然失败。
    // 用例要断言的是「Preview 单独占一个 Electron 数据目录」的目录结构，与分隔符无关，
    // 所以用同样的 join 表达；在 POSIX 上是恒等变换。
    expect(runtimeUserDataPath).toBe(join("/mock/appData", "ZCode Preview"));
    expect(runtimeSessionDataPath).toBe(join("/mock/appData", "ZCode Preview", "session"));
  });

  it("e2e 可保留 Chromedriver 注入的 Electron userData 目录", async () => {
    process.env["ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA"] = "1";
    appMock.getPath.mockImplementation((name: string) => {
      if (name === "appData") {
        throw new Error("Failed to get 'appData' path");
      }
      return `/mock/${name}`;
    });

    const { runtimeSessionDataPath, runtimeUserDataPath, shouldUseElectronDefaultUserDataPath } =
      await import("../src/main/desktopRuntimeEnv.js");

    expect(shouldUseElectronDefaultUserDataPath).toBe(true);
    expect(runtimeUserDataPath).toBeUndefined();
    expect(runtimeSessionDataPath).toBeUndefined();
    expect(appMock.getPath).not.toHaveBeenCalledWith("appData");
  });
});
