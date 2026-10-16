import { describe, expect, it } from "vitest";
import {
  DEFAULT_BIGMODEL_API_ORIGIN,
  DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL,
  DEFAULT_ZAI_BUSINESS_BASE_URL,
  DEFAULT_ZAI_OAUTH_CLIENT_ID,
  DEFAULT_ZAI_OAUTH_ORIGIN,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  TEST_BIGMODEL_API_ORIGIN,
  TEST_ZAI_BUSINESS_BASE_URL,
  TEST_ZAI_OAUTH_CLIENT_ID,
  TEST_ZAI_OAUTH_ORIGIN,
  TEST_ZCODE_ENDPOINT_ORIGIN,
  buildBigModelCodingPlanPersonalManageUrl,
  buildBigModelCodingPlanTeamManageUrl,
  buildBigModelApiUrl,
  buildRuntimeZCodeApiUrl,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZaiOAuthUrl,
  buildRuntimeZCodeEndpointUrls,
  buildZCodeEndpointUrls,
  normalizeZCodeEndpointOrigin,
  resolveBigModelApiOrigin,
  resolveRuntimeProductEndpointConfig,
  resolveWebRemoteControlRelayWsUrl,
  resolveZaiBusinessBaseUrl,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
  resolveZCodeEndpointOrigin,
} from "../src/zcodeEndpoint.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

describe("zcodeEndpoint", () => {
  it("defaults to the scoped origin in every env without env base url", () => {
    expect(resolveZCodeEndpointOrigin({ env: "test" })).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
    expect(resolveZCodeEndpointOrigin({ env: "production" })).toBe(DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  });

  it("uses ZCODE_BASE_URL style env base as the default endpoint", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "test",
        envBaseOrigin: "https://zcode.z.ai/api/v1",
      }),
    ).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
    expect(
      resolveZCodeEndpointOrigin({
        env: "production",
        envBaseOrigin: "https://zcode.z.ai/api/v1",
      }),
    ).toBe(DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  });

  it("keeps the non-production settings override above env base url", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "test",
        envBaseOrigin: "https://zcode.z.ai",
        overrideOrigin: "http://localhost:3030/api/v1",
      }),
    ).toBe("http://localhost:3030");
  });

  it("uses a non-production override after normalizing to origin", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "test",
        overrideOrigin: "https://zcode.z.ai/api/v1/ignored?x=1",
      }),
    ).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
  });

  it("ignores overrides in production", () => {
    expect(
      resolveZCodeEndpointOrigin({
        env: "production",
        envBaseOrigin: "https://zcode.z.ai",
        overrideOrigin: "https://zcode.z.ai",
      }),
    ).toBe(DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  });

  it("derives http and websocket urls from the same origin", () => {
    expect(buildZCodeEndpointUrls("http://localhost:3030")).toEqual({
      origin: "http://localhost:3030",
      apiBaseUrl: "http://localhost:3030/api/v1",
      remoteUrl: "http://localhost:3030/remote/v3",
      webRemoteCallbackUrl: "http://localhost:3030/web-remote/callback",
      webShareCallbackUrl: "http://localhost:3030/cn/share/callback",
      relayWsUrl: "ws://localhost:3030/ws",
      zcodePlanOpenAiBaseUrl: "http://localhost:3030/api/v1/zcode-plan",
      zcodePlanAnthropicBaseUrl: "http://localhost:3030/api/v1/zcode-plan/anthropic",
      zcodePlanBillingCurrentUrl: "http://localhost:3030/api/v1/zcode-plan/billing/current",
      zcodePlanBillingBalanceUrl: "http://localhost:3030/api/v1/zcode-plan/billing/balance",
    });
  });

  it("uses remote v3 for app versions below 3.4.0", () => {
    expect(buildZCodeEndpointUrls("https://zcode.z.ai", { appVersion: "3.3.9" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v3",
    );
  });

  it("uses remote v4 for app versions at or above 3.4.0", () => {
    expect(buildZCodeEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.0" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v4",
    );
    expect(buildZCodeEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.1" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v4",
    );
    expect(
      buildZCodeEndpointUrls("https://zcode.z.ai", { appVersion: "3.5.0-beta.1" }).remoteUrl,
    ).toBe("https://zcode.z.ai/remote/v4");
  });

  it("keeps prerelease and invalid app versions on remote v3", () => {
    expect(
      buildZCodeEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.0-beta.1" }).remoteUrl,
    ).toBe("https://zcode.z.ai/remote/v3");
    expect(buildZCodeEndpointUrls("https://zcode.z.ai", { appVersion: "dev" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v3",
    );
    expect(buildZCodeEndpointUrls("https://zcode.z.ai", { appVersion: "03.4.0" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v3",
    );
    expect(
      buildZCodeEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.1-alpha..1" }).remoteUrl,
    ).toBe("https://zcode.z.ai/remote/v3");
    expect(buildZCodeEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.1-01" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v3",
    );
  });

  it("derives runtime zcode-plan urls from ZCODE_ENV", () => {
    expect(buildRuntimeZCodeEndpointUrls({ ZCODE_ENV: "test" }).zcodePlanOpenAiBaseUrl).toBe(
      "https://zcode.z.ai/api/v1/zcode-plan",
    );
    expect(buildRuntimeZCodeEndpointUrls({ ZCODE_ENV: "production" }).zcodePlanOpenAiBaseUrl).toBe(
      "https://zcode.z.ai/api/v1/zcode-plan",
    );
    expect(buildRuntimeZCodeEndpointUrls({}).zcodePlanOpenAiBaseUrl).toBe(
      "https://zcode.z.ai/api/v1/zcode-plan",
    );
    expect(
      buildRuntimeZCodeEndpointUrls({
        ZCODE_ENV: "test",
        ZCODE_BASE_URL: "https://zcode.z.ai/ignored/path",
      }).zcodePlanAnthropicBaseUrl,
    ).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  });

  it("uses the test relay only for the standard test endpoint", () => {
    expect(
      resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: TEST_ZCODE_ENDPOINT_ORIGIN,
      }),
    ).toBe("wss://zcode.z.ai/ws");
    expect(
      resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
      }),
    ).toBe(DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL);
    expect(
      resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: "http://localhost:3030",
      }),
    ).toBe(DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL);
  });

  it("allows an explicit web remote control relay url override", () => {
    expect(
      resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: TEST_ZCODE_ENDPOINT_ORIGIN,
        overrideUrl: " ws://localhost:8787/ws ",
      }),
    ).toBe("ws://localhost:8787/ws");
  });

  it("derives BigModel API origin from ZCODE_ENV", () => {
    expect(resolveBigModelApiOrigin({ ZCODE_ENV: "production" })).toBe("https://bigmodel.cn");
    expect(resolveBigModelApiOrigin({ ZCODE_ENV: "test" })).toBe("https://bigmodel.cn");
    expect(buildBigModelApiUrl({ ZCODE_ENV: "test" }, "/api/biz/subscription/list")).toBe(
      "https://bigmodel.cn/api/biz/subscription/list",
    );
  });

  it("derives BigModel Coding Plan manage urls from ZCODE_ENV", () => {
    expect(buildBigModelCodingPlanPersonalManageUrl({ ZCODE_ENV: "test" })).toBe(
      "https://bigmodel.cn/coding-plan/personal/overview",
    );
    expect(buildBigModelCodingPlanPersonalManageUrl({ ZCODE_ENV: "production" })).toBe(
      "https://bigmodel.cn/coding-plan/personal/overview",
    );
    expect(buildBigModelCodingPlanTeamManageUrl({ ZCODE_ENV: "test" })).toBe(
      "https://bigmodel.cn/coding-plan/team/plans",
    );
    expect(buildBigModelCodingPlanTeamManageUrl({ ZCODE_ENV: "production" })).toBe(
      "https://bigmodel.cn/coding-plan/team/plans",
    );
  });

  it("resolves all product endpoints for the test product environment", () => {
    expect(resolveRuntimeProductEndpointConfig({ ZCODE_ENV: "test" })).toMatchObject({
      zcodeEnv: "test",
      zcodeEndpointOrigin: TEST_ZCODE_ENDPOINT_ORIGIN,
      zaiOAuthOrigin: TEST_ZAI_OAUTH_ORIGIN,
      zaiBusinessBaseUrl: TEST_ZAI_BUSINESS_BASE_URL,
      zaiOAuthClientId: TEST_ZAI_OAUTH_CLIENT_ID,
      bigModelApiOrigin: TEST_BIGMODEL_API_ORIGIN,
    });
  });

  it("resolves all product endpoints for the production product environment", () => {
    expect(resolveRuntimeProductEndpointConfig({ ZCODE_ENV: "production" })).toMatchObject({
      zcodeEnv: "production",
      zcodeEndpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
      zaiOAuthOrigin: DEFAULT_ZAI_OAUTH_ORIGIN,
      zaiBusinessBaseUrl: DEFAULT_ZAI_BUSINESS_BASE_URL,
      zaiOAuthClientId: DEFAULT_ZAI_OAUTH_CLIENT_ID,
      bigModelApiOrigin: DEFAULT_BIGMODEL_API_ORIGIN,
    });
  });

  it("builds product endpoint URLs from the selected environment", () => {
    expect(buildRuntimeZCodeApiUrl({ ZCODE_ENV: "test" }, "/api/v1/oauth/token")).toBe(
      "https://zcode.z.ai/api/v1/oauth/token",
    );
    expect(buildRuntimeZaiOAuthUrl({ ZCODE_ENV: "test" }, "/api/oauth/authorize")).toBe(
      "https://chat.z.ai/api/oauth/authorize",
    );
    expect(buildRuntimeZaiBusinessUrl({ ZCODE_ENV: "test" }, "/api/auth/z/login")).toBe(
      "https://api.z.ai/api/auth/z/login",
    );
    expect(buildBigModelApiUrl({ ZCODE_ENV: "test" }, "/login")).toBe(
      "https://bigmodel.cn/login",
    );
  });

  it("keeps environment-scoped endpoint overrides centralized", () => {
    const env = {
      ZCODE_ENV: "test",
      ZCODE_TEST_BASE_URL: "https://test-zcode.example.com/path",
      ZAI_TEST_OAUTH_ORIGIN: "https://test-oauth.example.com/oauth",
      ZAI_TEST_BUSINESS_BASE_URL: "https://test-business.example.com/api",
      ZAI_TEST_OAUTH_CLIENT_ID: "client_test_override",
      BIGMODEL_TEST_API_BASE_URL: "https://test-bigmodel.example.com/base",
    };

    expect(resolveRuntimeProductEndpointConfig(env)).toMatchObject({
      zcodeEndpointOrigin: "https://test-zcode.example.com",
      zaiOAuthOrigin: "https://test-oauth.example.com",
      zaiBusinessBaseUrl: "https://test-business.example.com",
      zaiOAuthClientId: "client_test_override",
      bigModelApiOrigin: "https://test-bigmodel.example.com",
    });
  });

  it("keeps unscoped endpoint overrides above scoped endpoint overrides", () => {
    const env = {
      ZCODE_ENV: "test",
      ZAI_OAUTH_ORIGIN: "https://oauth-global.example.com",
      ZAI_TEST_OAUTH_ORIGIN: "https://oauth-test.example.com",
      ZAI_BUSINESS_BASE_URL: "https://business-global.example.com",
      ZAI_TEST_BUSINESS_BASE_URL: "https://business-test.example.com",
      ZAI_OAUTH_CLIENT_ID: "client_global",
      ZAI_TEST_OAUTH_CLIENT_ID: "client_test",
      BIGMODEL_API_BASE_URL: "https://bigmodel-global.example.com",
      BIGMODEL_TEST_API_BASE_URL: "https://bigmodel-test.example.com",
    };

    expect(resolveZaiOAuthOrigin(env)).toBe("https://oauth-global.example.com");
    expect(resolveZaiBusinessBaseUrl(env)).toBe("https://business-global.example.com");
    expect(resolveZaiOAuthClientId(env)).toBe("client_global");
    expect(resolveBigModelApiOrigin(env)).toBe("https://bigmodel-global.example.com");
  });

  it("ignores blank runtime endpoint overrides", () => {
    const env = {
      ZCODE_ENV: "test",
      ZCODE_BASE_URL: " ",
      ZCODE_TEST_BASE_URL: "\t",
      ZAI_OAUTH_ORIGIN: "",
      ZAI_TEST_OAUTH_ORIGIN: " ",
      ZAI_BUSINESS_BASE_URL: " ",
      ZAI_TEST_BUSINESS_BASE_URL: "",
      ZAI_OAUTH_CLIENT_ID: "",
      ZAI_TEST_OAUTH_CLIENT_ID: " ",
      BIGMODEL_API_BASE_URL: " ",
      BIGMODEL_TEST_API_BASE_URL: "",
    };

    expect(resolveRuntimeProductEndpointConfig(env)).toMatchObject({
      zcodeEndpointOrigin: TEST_ZCODE_ENDPOINT_ORIGIN,
      zaiOAuthOrigin: TEST_ZAI_OAUTH_ORIGIN,
      zaiBusinessBaseUrl: TEST_ZAI_BUSINESS_BASE_URL,
      zaiOAuthClientId: TEST_ZAI_OAUTH_CLIENT_ID,
      bigModelApiOrigin: TEST_BIGMODEL_API_ORIGIN,
    });
  });

  it("rejects non-http endpoint origins", () => {
    expect(() => normalizeZCodeEndpointOrigin("file:///tmp/zcode")).toThrow(/http or https/);
  });

  it("persists optional endpoint override in app settings", () => {
    expect(
      appSettingsSchema.parse({ zcodeEndpointOrigin: "https://zcode.z.ai/path" })
        .zcodeEndpointOrigin,
    ).toBe(TEST_ZCODE_ENDPOINT_ORIGIN);
    expect(
      appSettingsPatchSchema.parse({ zcodeEndpointOrigin: "http://localhost:3030/foo" })
        .zcodeEndpointOrigin,
    ).toBe("http://localhost:3030");
  });
});
