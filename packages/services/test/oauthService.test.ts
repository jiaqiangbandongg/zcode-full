import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  CREDENTIAL_DECRYPT_ERROR_CODE,
  ZCODE_VERSION,
  ZAI_PROVIDER_ID,
  type ApiClient,
  type OAuthProviderId,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { BIGMODEL_OAUTH_PROVIDER_CONFIG } from "../src/oauth/providers/bigmodelProviderConfig.js";
import { ZAI_OAUTH_PROVIDER_CONFIG } from "../src/oauth/providers/zaiProviderConfig.js";
import { ZaiProviderAdapter } from "../src/oauth/providers/zaiProviderAdapter.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { OAuthProviderAdapter } from "../src/oauth/providers/index.js";
import { OAuthService } from "../src/oauth/oauthService.js";
import { OAuthCredentialRepo } from "../src/oauth/repo/oauthCredentialRepo.js";

import { AccountProviderApiKeyResolver } from "../src/model-provider/accountProviderApiKeyResolver.js";
import { createAccountProjectTokenClient } from "../src/model-provider/accountProjectTokenClient.js";
import { resolveAccountTeamPlanRuntimeApiKey } from "../src/model-provider/accountProviderTeamPlanRequestKey.js";

const DESKTOP_OAUTH_CALLBACK_URI = "zcode://oauth/callback";

function buildDesktopOAuthLoginRedirectUri(origin: string): string {
  const url = new URL("/app/oauth/login", origin);
  url.searchParams.set("redirect", DESKTOP_OAUTH_CALLBACK_URI);
  url.searchParams.set("app_version", ZCODE_VERSION);
  return url.toString();
}

const PRODUCTION_DESKTOP_OAUTH_LOGIN_REDIRECT_URI =
  buildDesktopOAuthLoginRedirectUri("https://zcode.z.ai/");
const TEST_DESKTOP_OAUTH_LOGIN_REDIRECT_URI = buildDesktopOAuthLoginRedirectUri(
  "https://zcode.z.ai/",
);

// Windows 机器上设置了 ZAI_TEST_OAUTH_ORIGIN 等环境变量，会覆盖测试预期的 test 端点值
// 过滤掉这些可能污染测试的环境变量
const OAUTH_ENV_KEYS_TO_OMIT = new Set([
  "ZCODE_ENV",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZAI_TEST_OAUTH_ORIGIN",
  "ZAI_PRODUCTION_OAUTH_ORIGIN",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_TEST_OAUTH_CLIENT_ID",
  "ZAI_PRODUCTION_OAUTH_CLIENT_ID",
  "ZAI_OAUTH_CLIENT_ID",
  "BIGMODEL_TEST_API_BASE_URL",
  "BIGMODEL_PRODUCTION_API_BASE_URL",
  "BIGMODEL_API_BASE_URL",
  "ZAI_TEST_BUSINESS_BASE_URL",
  "ZAI_PRODUCTION_BUSINESS_BASE_URL",
  "ZAI_BUSINESS_BASE_URL",
  "ZCODE_TEST_BASE_URL",
  "ZCODE_PRODUCTION_BASE_URL",
  "ZCODE_BASE_URL",
]);
const cleanProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !OAUTH_ENV_KEYS_TO_OMIT.has(key)),
) as Record<string, string | undefined>;

const credentialStore = new Map<string, string>();

const credentialServiceStub: ICredentialService = {
  load: async (key: string) => credentialStore.get(key) ?? null,
  save: async (key: string, value: string) => {
    credentialStore.set(key, value);
  },
  delete: async (key: string) => {
    credentialStore.delete(key);
  },
};

const OAUTH_SESSION_CREDENTIAL_KEYS = [
  "oauth:active_provider",
  "oauth:bigmodel:access_token",
  "oauth:bigmodel:refresh_token",
  "oauth:bigmodel:user_info",
  "oauth:zai:access_token",
  "oauth:zai:refresh_token",
  "oauth:zai:user_info",
  "zcodejwttoken",
] as const;

function expectDeletedOAuthSessionCredentials(
  deletedKeys: string[],
  additionalKeys: readonly string[] = [],
) {
  expect(new Set(deletedKeys)).toEqual(
    new Set([...OAUTH_SESSION_CREDENTIAL_KEYS, ...additionalKeys]),
  );
  expect(deletedKeys).not.toContain("auth_token");
  expect(deletedKeys).not.toContain("refresh_token");
}

function createMockCredentialDecryptError(message = "Serialized credential decrypt failure") {
  return Object.assign(new Error(message), { code: CREDENTIAL_DECRYPT_ERROR_CODE });
}

function expectProviderLogoutNotifications(
  onProviderLogout: ReturnType<typeof vi.fn>,
  expectedProviders: readonly OAuthProviderId[],
) {
  expect(onProviderLogout).toHaveBeenCalledTimes(expectedProviders.length);
  expect(new Set(onProviderLogout.mock.calls.map(([provider]) => provider))).toEqual(
    new Set(expectedProviders),
  );
}

function createMockApiClient(mockFetch: typeof fetch): ApiClient {
  return {
    request: mockFetch,
  };
}

function createBigModelService(
  overrides?: ConstructorParameters<typeof OAuthService>[1],
): OAuthService {
  return new OAuthService(credentialServiceStub, {
    env: {
      ...cleanProcessEnv,
      BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
    },
    apiClient: createMockApiClient(vi.fn<typeof fetch>()),
    ...overrides,
  });
}

function createZaiBusinessLoginResponse(accessToken = "zai_business_access_token"): Response {
  return new Response(
    JSON.stringify({
      code: 200,
      success: true,
      data: {
        access_token: accessToken,
        expires_in: 3600,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

function createBigModelZcodeTokenResponse(
  token = "bigmodel-zcode-jwt",
  accessToken = "bigmodel-business-access-token",
): Response {
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        token,
        bigmodel: {
          access_token: accessToken,
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function createBigModelUserInfoResponse(
  nickName: unknown = "BigModel User",
  customerNumber: unknown = "bigmodel-u-001",
  customerName: unknown = nickName,
): Response {
  return new Response(
    JSON.stringify({
      data: {
        customerNumber,
        customerName,
        nickName,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  credentialStore.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("oauthService", () => {
  it.each([false, true])("Z.AI polling 先换业务 JWT 再签发 PAT，team=%s", async (team) => {
    let now = 2_000_000_000_000;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/v1/oauth/cli/init")) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "",
            data: {
              authorize_url:
                "https://chat.z.ai/api/oauth/authorize?client_id=zcode&redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback&state=flow-state&response_type=code",
              expires_at: 2_000_000_300,
              flow_id: "flow-1",
              poll_interval_sec: 2,
              poll_token: "server-must-not-replace-client-token",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/oauth/cli/poll/flow-1")) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "",
            data: {
              status: "ready",
              token: "zcode-jwt",
              user: {
                user_id: "user-1",
                name: "Edward",
                email: "edward@example.com",
              },
              zai: { access_token: "zai-oauth-token" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/auth/z/login")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          token: "zai-oauth-token",
        });
        return createZaiBusinessLoginResponse("zai-business-token");
      }
      if (url.includes("/api/biz/")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          team && url.includes("/api_keys") && !url.endsWith("/access_tokens")
            ? "zai-business-token"
            : "Bearer zai-business-token",
        );
        const data = url.endsWith("/getCustomerInfo")
          ? {
              organizations: [
                {
                  organizationId: "org",
                  projects: [{ projectId: "project" }],
                },
              ],
            }
          : url.endsWith("/access_tokens")
            ? {
                accessToken: "project-pat",
                tokenType: "Bearer",
                expiresIn: 600,
                expiresAt: Date.now() / 1000 + 600,
              }
            : [
                {
                  name: team ? "zcode-team-api-key" : "zcode-api-key",
                  apiKey: "key",
                  keyType: 2,
                },
              ];
        return new Response(JSON.stringify({ code: 200, data }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => now,
    });

    const started = await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    const authorizeUrl = new URL(started.authorizeUrl);
    const redirectUrl = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
    const result = await service.pollPendingOAuth();

    expect(authorizeUrl.searchParams.get("state")).toBe(started.state);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe("https://zcode.z.ai/app/oauth/login");
    expect(redirectUrl.searchParams.get("redirect")).toBe("zcode://oauth/callback");
    expect(redirectUrl.searchParams.get("app_version")).toBe(ZCODE_VERSION);
    expect(result).toEqual({
      kind: "session",
      provider: ZAI_PROVIDER_ID,
      userInfo: {
        id: "user-1",
        username: "Edward",
        displayName: "Edward",
      },
    });
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/u),
    });
    const initAuthorization = (requests[0]!.init!.headers as Record<string, string>).Authorization;
    expect(requests[1]?.init?.headers).toMatchObject({
      Authorization: initAuthorization,
    });
    expect(credentialStore.get("oauth:zai:access_token")).toBe("zai-business-token");
    expect(credentialStore.get("zcodejwttoken")).toBe("zcode-jwt");
    const apiClient = createMockApiClient(mockFetch);
    const tokenClient = createAccountProjectTokenClient(apiClient, credentialServiceStub);
    const persistedToken = (await credentialServiceStub.load("oauth:zai:access_token"))!;
    const pat = team
      ? await resolveAccountTeamPlanRuntimeApiKey({
          apiClient,
          tokenClient,
          credentialService: credentialServiceStub,
          accountIdentity: "user-1",
          access: {
            type: "zhipu-account",
            family: "zai",
            planKind: "team-coding-plan",
            organizationId: "org",
            projectId: "project",
          },
        })
      : await new AccountProviderApiKeyResolver(
          async () => null,
          tokenClient,
        ).resolveProviderApiKey(ZAI_PROVIDER_ID, persistedToken, "user-1");
    expect(pat).toBe("project-pat");
    expect(requests.filter(({ url }) => url.endsWith("/api/auth/z/login"))).toHaveLength(1);
    expect(requests.slice(2).map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/auth/z/login",
      "/api/biz/customer/getCustomerInfo",
      "/api/biz/v1/organization/org/projects/project/api_keys",
      "/api/biz/v1/organization/org/projects/project/api_keys/key/access_tokens",
    ]);
    await expect(
      service.handleCallback(`zcode://oauth/callback?state=${started.state}&code=late-code`),
    ).resolves.toEqual({ kind: "duplicate", provider: ZAI_PROVIDER_ID });
    await expect(
      service.handleCallback("zcode://oauth/callback?state=different-state&code=late-code"),
    ).rejects.toThrow("OAuth state 不匹配或已过期");
    now += 30_000;
    await expect(
      service.handleCallback(`zcode://oauth/callback?state=${started.state}&code=too-late-code`),
    ).rejects.toThrow("OAuth state 不匹配或已过期");
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(6);
  });

  it.each([
    ["snake_case", { access_token: "bigmodel-business-token", refresh_token: "bigmodel-refresh" }],
    ["camelCase", { accessToken: "bigmodel-business-token", refreshToken: "bigmodel-refresh" }],
  ])(
    "uses the same backend polling flow for BigModel with %s token fields",
    async (_label, bigmodelTokenData) => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/api/v1/oauth/cli/init")) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                authorize_url:
                  "https://bigmodel.cn/login?appId=zcode&redirect=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fbigmodel&state=bigmodel-flow",
                expires_at: 2_000_000_300,
                flow_id: "bigmodel-flow-1",
                poll_interval_sec: 2,
                poll_token: "ignored",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              status: "ready",
              token: "bigmodel-zcode-jwt",
              user: { user_id: "bigmodel-user", name: "BigModel User" },
              bigmodel: bigmodelTokenData,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      const service = createBigModelService({
        apiClient: createMockApiClient(mockFetch),
        now: () => 2_000_000_000_000,
      });

      const started = await service.startOAuthWithPolling(BIGMODEL_PROVIDER_ID);
      const authorizeUrl = new URL(started.authorizeUrl);
      const redirectUrl = new URL(authorizeUrl.searchParams.get("redirect")!);
      const result = await service.pollPendingOAuth();

      expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
        provider: BIGMODEL_PROVIDER_ID,
      });
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://bigmodel.cn/login");
      expect(redirectUrl.origin + redirectUrl.pathname).toBe("https://zcode.z.ai/app/oauth/login");
      expect(redirectUrl.searchParams.get("redirect")).toBe("zcode://oauth/callback");
      expect(redirectUrl.searchParams.get("app_version")).toBe(ZCODE_VERSION);
      expect(result).toEqual({
        kind: "session",
        provider: BIGMODEL_PROVIDER_ID,
        userInfo: {
          id: "bigmodel-user",
          username: "BigModel User",
          displayName: "BigModel User",
        },
      });
      expect(credentialStore.get("oauth:bigmodel:access_token")).toBe("bigmodel-business-token");
      expect(credentialStore.get("oauth:bigmodel:refresh_token")).toBe("bigmodel-refresh");
      expect(credentialStore.get("zcodejwttoken")).toBe("bigmodel-zcode-jwt");
      expect(started.provider).toBe(BIGMODEL_PROVIDER_ID);
    },
  );

  it("rejects a late polling callback after timeout without persisting credentials", async () => {
    vi.useFakeTimers();
    let now = 2_000_000_000_000;
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/oauth/cli/init")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              authorize_url: "https://chat.z.ai/api/oauth/authorize?state=expired-polling-state",
              expires_at: (now + 5_000) / 1_000,
              flow_id: "expired-polling-flow",
              poll_interval_sec: 1,
              poll_token: "poll-token",
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const baseAdapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(mockFetch),
    );
    const exchangeToken = vi.spyOn(baseAdapter, "exchangeToken").mockImplementation(async () => {
      throw new Error("exchange should not run");
    });
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => now,
      adapters: [baseAdapter],
    });

    const started = await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    credentialStore.set("oauth:zai:access_token", "existing-token");
    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(
      service.handleCallback(`zcode://oauth/callback?state=${started.state}&code=late-code`),
    ).rejects.toThrow("OAuth state 不匹配或已过期");
    expect(exchangeToken).not.toHaveBeenCalled();
    expect(credentialStore.get("oauth:zai:access_token")).toBe("existing-token");
  });

  it("keeps a pending Z.AI flow until the server polling interval elapses", async () => {
    let now = 2_000_000_000_000;
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/init")
            ? {
                code: 0,
                data: {
                  authorize_url: "https://chat.z.ai/api/oauth/authorize?state=flow-state",
                  expires_at: 2_000_000_300,
                  flow_id: "flow-1",
                  poll_interval_sec: 2,
                  poll_token: "ignored",
                },
              }
            : { code: 0, data: { status: "pending" } },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => now,
    });

    await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    now += 2_000;
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      "an expired flow",
      {
        authorize_url: "https://chat.z.ai/api/oauth/authorize?state=flow-state",
        expires_at: 2_000_000_000,
        flow_id: "flow-1",
        poll_interval_sec: 2,
      },
    ],
    [
      "a non-HTTPS authorize URL",
      {
        authorize_url: "http://example.com/oauth?state=flow-state",
        expires_at: 2_000_000_300,
        flow_id: "flow-1",
        poll_interval_sec: 2,
      },
    ],
    [
      "a polling interval below one second",
      {
        authorize_url: "https://chat.z.ai/api/oauth/authorize?state=flow-state",
        expires_at: 2_000_000_300,
        flow_id: "flow-1",
        poll_interval_sec: 0.5,
      },
    ],
    [
      "a polling interval longer than the remaining flow lifetime",
      {
        authorize_url: "https://chat.z.ai/api/oauth/authorize?state=flow-state",
        expires_at: 2_000_000_300,
        flow_id: "flow-1",
        poll_interval_sec: 301,
      },
    ],
  ])("rejects polling init with %s", async (_label, data) => {
    const mockFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ code: 0, data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => 2_000_000_000_000,
    });

    await expect(service.startOAuthWithPolling(ZAI_PROVIDER_ID)).rejects.toThrow(
      "OAuth flow 初始化响应无效",
    );
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
  });

  it.each([
    ["an unknown status", { status: "completed" }],
    [
      "malformed ready credential fields",
      {
        status: "ready",
        token: { value: "not-a-string" },
        user: { user_id: 42, name: ["not-a-string"] },
        zai: { access_token: true },
      },
    ],
  ])("fails polling cleanly for %s", async (_label, pollData) => {
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const data = String(input).endsWith("/init")
        ? {
            authorize_url: "https://chat.z.ai/api/oauth/authorize?state=flow-state",
            expires_at: 2_000_000_300,
            flow_id: "flow-1",
            poll_interval_sec: 2,
          }
        : pollData;
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => 2_000_000_000_000,
    });

    await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    await expect(service.pollPendingOAuth()).rejects.toThrow("OAuth flow 查询响应无效");
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
  });

  it("keeps the newest polling flow when an older init response arrives late", async () => {
    let resolveFirstInit: ((response: Response) => void) | undefined;
    const firstInit = new Promise<Response>((resolve) => {
      resolveFirstInit = resolve;
    });
    let initCount = 0;
    const polledUrls: string[] = [];
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/init")) {
        initCount += 1;
        if (initCount === 1) {
          return firstInit;
        }
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              authorize_url: "https://bigmodel.cn/login?state=new-flow-state",
              expires_at: 2_000_000_300,
              flow_id: "new-flow",
              poll_interval_sec: 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      polledUrls.push(url);
      return new Response(JSON.stringify({ code: 0, data: { status: "pending" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => 2_000_000_000_000,
    });

    const oldStart = service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    await vi.waitFor(() => expect(initCount).toBe(1));
    const newStart = service.startOAuthWithPolling(BIGMODEL_PROVIDER_ID);
    await expect(newStart).resolves.toMatchObject({
      provider: BIGMODEL_PROVIDER_ID,
      state: "new-flow-state",
    });
    resolveFirstInit?.(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            authorize_url: "https://chat.z.ai/api/oauth/authorize?state=old-flow-state",
            expires_at: 2_000_000_300,
            flow_id: "old-flow",
            poll_interval_sec: 2,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(oldStart).rejects.toThrow("OAuth flow 已被新的登录请求替换");
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
    expect(polledUrls).toEqual([expect.stringContaining("/poll/new-flow")]);
  });

  it("discards an in-flight init response after the user cancels", async () => {
    let resolveInit: ((response: Response) => void) | undefined;
    const initResponse = new Promise<Response>((resolve) => {
      resolveInit = resolve;
    });
    const mockFetch = vi.fn<typeof fetch>(() => initResponse);
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => 2_000_000_000_000,
    });

    const start = service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await service.cancelPending();
    resolveInit?.(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            authorize_url: "https://chat.z.ai/api/oauth/authorize?state=cancelled-flow",
            expires_at: 2_000_000_300,
            flow_id: "cancelled-flow",
            poll_interval_sec: 2,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(start).rejects.toThrow("OAuth flow 已被新的登录请求替换");
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
  });

  it("does not cancel another provider's in-flight init response", async () => {
    let resolveInit: ((response: Response) => void) | undefined;
    const initResponse = new Promise<Response>((resolve) => {
      resolveInit = resolve;
    });
    const mockFetch = vi.fn<typeof fetch>(() => initResponse);
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => 2_000_000_000_000,
    });

    const start = service.startOAuthWithPolling(BIGMODEL_PROVIDER_ID);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await service.cancelPending(ZAI_PROVIDER_ID);
    resolveInit?.(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            authorize_url: "https://bigmodel.cn/login?state=bigmodel-flow",
            expires_at: 2_000_000_300,
            flow_id: "bigmodel-flow",
            poll_interval_sec: 2,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(start).resolves.toMatchObject({
      provider: BIGMODEL_PROVIDER_ID,
      state: "bigmodel-flow",
    });
  });

  it("stops polling when the pending Z.AI login is cancelled", async () => {
    const mockFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              authorize_url: "https://chat.z.ai/api/oauth/authorize?state=flow-state",
              expires_at: 2_000_000_300,
              flow_id: "flow-1",
              poll_interval_sec: 2,
              poll_token: "ignored",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => 2_000_000_000_000,
    });

    await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    await service.cancelPending(ZAI_PROVIDER_ID);

    await expect(service.pollPendingOAuth()).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([503, 429])(
    "retries a transient Z.AI polling HTTP %i without clearing the flow",
    async (transientStatus) => {
      let now = 2_000_000_000_000;
      let pollAttempts = 0;
      const mockFetch = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith("/init")) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                authorize_url: "https://chat.z.ai/api/oauth/authorize?state=flow-state",
                expires_at: 2_000_000_300,
                flow_id: "flow-1",
                poll_interval_sec: 2,
                poll_token: "ignored",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/poll/")) {
          pollAttempts += 1;
          if (pollAttempts === 1) {
            return new Response("", { status: transientStatus });
          }
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                status: "ready",
                token: "zcode-jwt",
                user: { user_id: "user-1", name: "Edward" },
                zai: { access_token: "zai-oauth-token" },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return createZaiBusinessLoginResponse("zai-business-token");
      });
      const service = createBigModelService({
        apiClient: createMockApiClient(mockFetch),
        now: () => now,
      });

      await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
      await expect(service.pollPendingOAuth()).resolves.toBeNull();
      now += 2_000;
      await expect(service.pollPendingOAuth()).resolves.toMatchObject({
        kind: "session",
        provider: ZAI_PROVIDER_ID,
      });
      expect(pollAttempts).toBe(2);
    },
  );

  it("clears the flow when ready token normalization fails", async () => {
    let now = 2_000_000_000_000;
    let pollAttempts = 0;
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/init")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              authorize_url: "https://chat.z.ai/api/oauth/authorize?state=flow-state",
              expires_at: 2_000_000_300,
              flow_id: "flow-1",
              poll_interval_sec: 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/poll/")) {
        pollAttempts += 1;
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              status: "ready",
              token: "zcode-jwt",
              user: { user_id: "user-1", name: "Edward" },
              zai: { access_token: "zai-oauth-token" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ code: 500, msg: "business token failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => now,
    });

    await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    await expect(service.pollPendingOAuth()).rejects.toThrow();
    now += 2_000;
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
    expect(pollAttempts).toBe(1);
  });

  it("clears a failed Z.AI polling flow without persisting credentials", async () => {
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/init")
            ? {
                code: 0,
                data: {
                  authorize_url: "https://chat.z.ai/api/oauth/authorize?state=flow-state",
                  expires_at: 2_000_000_300,
                  flow_id: "flow-1",
                  poll_interval_sec: 2,
                  poll_token: "ignored",
                },
              }
            : { code: 0, data: { status: "failed" } },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const service = createBigModelService({
      apiClient: createMockApiClient(mockFetch),
      now: () => 2_000_000_000_000,
    });

    await service.startOAuthWithPolling(ZAI_PROVIDER_ID);
    await expect(service.pollPendingOAuth()).rejects.toThrow("OAuth flow 授权失败");
    await expect(service.pollPendingOAuth()).resolves.toBeNull();
    expect(credentialStore.get("oauth:zai:access_token")).toBeUndefined();
  });

  it("persists website attribution without an expiry time", async () => {
    const service = createBigModelService({
      apiClient: createMockApiClient(vi.fn<typeof fetch>()),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    await service.handleCallback(
      `zcode://oauth/callback?state=${state}&channel_id=douyin&utm_source=wechat`,
    );

    const repo = new OAuthCredentialRepo(credentialServiceStub);
    await expect(repo.loadLoginAttribution()).resolves.toEqual({
      channel_id: "douyin",
      utm_source: "wechat",
    });
  });

  it("reads the temporary expiring attribution record written by an earlier branch revision", async () => {
    await credentialServiceStub.save(
      "oauth:login_attribution",
      JSON.stringify({
        params: { channel_id: "migrated-channel", utm_campaign: "launch" },
        expiresAt: 1,
      }),
    );
    const repo = new OAuthCredentialRepo(credentialServiceStub);

    await expect(repo.loadLoginAttribution()).resolves.toEqual({
      channel_id: "migrated-channel",
      utm_campaign: "launch",
    });
  });

  it("缺少 apiClient 注入时会立即报错", () => {
    expect(
      () =>
        new OAuthService(credentialServiceStub, {
          env: {
            ...process.env,
            BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
          },
        }),
    ).toThrow(/ApiClient/);
  });

  it("returns enabled provider metadata", async () => {
    const service = createBigModelService();

    await expect(service.getProviders()).resolves.toEqual<OAuthProviderMeta[]>([
      {
        id: BIGMODEL_PROVIDER_ID,
        displayName: "BigModel",
        enabled: true,
        order: 0,
      },
      {
        id: ZAI_PROVIDER_ID,
        displayName: "Z.ai",
        enabled: true,
        order: 1,
      },
    ]);
  });

  it("builds authorize URL with provider-specific params", async () => {
    const service = createBigModelService();

    const { provider, authorizeUrl, state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    const parsed = new URL(authorizeUrl);

    expect(provider).toBe(BIGMODEL_PROVIDER_ID);
    expect(parsed.origin + parsed.pathname).toBe(BIGMODEL_OAUTH_PROVIDER_CONFIG.authorizeUrl);
    expect(parsed.searchParams.get("redirect")).toBe(PRODUCTION_DESKTOP_OAUTH_LOGIN_REDIRECT_URI);
    expect(parsed.searchParams.get("appId")).toBe(BIGMODEL_OAUTH_PROVIDER_CONFIG.appId);
    expect(parsed.searchParams.get("state")).toBe(state);
  });

  it("builds zai authorize URL with backend-token flow params", async () => {
    const service = createBigModelService();

    const { provider, authorizeUrl, state } = await service.startOAuth(ZAI_PROVIDER_ID);
    const parsed = new URL(authorizeUrl);

    expect(provider).toBe(ZAI_PROVIDER_ID);
    expect(parsed.origin + parsed.pathname).toBe("https://chat.z.ai/api/oauth/authorize");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      PRODUCTION_DESKTOP_OAUTH_LOGIN_REDIRECT_URI,
    );
    expect(parsed.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
    expect(parsed.searchParams.get("state")).toBe(state);
  });

  it("uses ZAI_OAUTH_ORIGIN and ZAI_OAUTH_CLIENT_ID to build test environment authorize URL", async () => {
    const service = createBigModelService({
      env: {
        ...cleanProcessEnv,
        BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
        ZCODE_ENV: "test",
        ZAI_OAUTH_CLIENT_ID: "client_P8X5CMWmlaRO9gyO-KSqtg",
        ZAI_OAUTH_ORIGIN: "https://chat.z.ai/",
      },
    });

    const { authorizeUrl } = await service.startOAuth(ZAI_PROVIDER_ID);
    const parsed = new URL(authorizeUrl);

    expect(parsed.origin + parsed.pathname).toBe(
      "https://chat.z.ai/api/oauth/authorize",
    );
    expect(parsed.searchParams.get("redirect_uri")).toBe(TEST_DESKTOP_OAUTH_LOGIN_REDIRECT_URI);
    expect(parsed.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
  });

  it("uses test zcode website OAuth login redirect for BigModel in test environment", async () => {
    const service = createBigModelService({
      env: {
        ...cleanProcessEnv,
        BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
        ZCODE_ENV: "test",
      },
    });

    const { authorizeUrl } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    const parsed = new URL(authorizeUrl);

    expect(parsed.searchParams.get("redirect")).toBe(TEST_DESKTOP_OAUTH_LOGIN_REDIRECT_URI);
  });

  it("uses bigmodel.cn to build BigModel authorize URL when ZCODE_ENV=test", async () => {
    const service = createBigModelService({
      env: {
        ...cleanProcessEnv,
        BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
        ZCODE_ENV: "test",
      },
    });

    const { authorizeUrl } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    const parsed = new URL(authorizeUrl);

    expect(parsed.origin + parsed.pathname).toBe("https://bigmodel.cn/login");
  });

  it("uses production bigmodel.cn to build BigModel authorize URL when ZCODE_ENV=production", async () => {
    const service = createBigModelService({
      env: {
        ...process.env,
        BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
        ZCODE_ENV: "production",
      },
    });

    const { authorizeUrl } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    const parsed = new URL(authorizeUrl);

    expect(parsed.origin + parsed.pathname).toBe("https://bigmodel.cn/login");
  });

  it("accepts attribution once and preserves the same state for the final authorization callback", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    await expect(
      service.handleCallback(
        `zcode://oauth/callback?state=${state}&channel_id=google_ads&utm_source=google`,
      ),
    ).resolves.toEqual({
      kind: "attribution",
      provider: BIGMODEL_PROVIDER_ID,
      attribution: {
        channel_id: "google_ads",
        utm_source: "google",
      },
    });
    expect(await credentialServiceStub.load("oauth:login_attribution")).toBe(
      JSON.stringify({ channel_id: "google_ads", utm_source: "google" }),
    );

    await expect(
      service.handleCallback(
        `zcode://oauth/callback?state=${state}&channel_id=duplicate&utm_source=duplicate`,
      ),
    ).rejects.toThrow("OAuth 归因回调已处理");
    expect(await credentialServiceStub.load("oauth:login_attribution")).toBe(
      JSON.stringify({ channel_id: "google_ads", utm_source: "google" }),
    );

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse());
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());

    await expect(
      service.handleCallback(`zcode://oauth/callback?authCode=auth-code-001&state=${state}`),
    ).resolves.toMatchObject({
      kind: "session",
      provider: BIGMODEL_PROVIDER_ID,
    });
  });

  it("invalidates an attributed state when a new OAuth flow starts", async () => {
    const service = createBigModelService({
      apiClient: createMockApiClient(vi.fn<typeof fetch>()),
    });
    const first = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    await service.handleCallback(
      `zcode://oauth/callback?state=${first.state}&channel_id=google_ads`,
    );

    const second = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    await expect(
      service.handleCallback(`zcode://oauth/callback?authCode=old-code&state=${first.state}`),
    ).rejects.toThrow("OAuth state 不匹配或已过期");
    expect(second.state).not.toBe(first.state);
    await service.cancelPending();
  });

  it("expires an attributed state after the OAuth timeout", async () => {
    vi.useFakeTimers();
    const service = createBigModelService({
      apiClient: createMockApiClient(vi.fn<typeof fetch>()),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    await service.handleCallback(`zcode://oauth/callback?state=${state}&channel_id=google_ads`);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await expect(
      service.handleCallback(`zcode://oauth/callback?authCode=late-code&state=${state}`),
    ).rejects.toThrow("OAuth state 不匹配或已过期");
  });

  // Windows 机器上设置了 ZAI_TEST_OAUTH_ORIGIN 等环境变量，会覆盖测试预期的 test 端点值
  it("uses testZAI endpoints from runtime ZCODE_ENV without explicit origin overrides", async () => {
    const service = createBigModelService({
      env: {
        ...cleanProcessEnv,
        BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
        ZCODE_ENV: "test",
      },
    });

    const { authorizeUrl } = await service.startOAuth(ZAI_PROVIDER_ID);
    const parsed = new URL(authorizeUrl);

    expect(parsed.origin + parsed.pathname).toBe(
      "https://chat.z.ai/api/oauth/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
  });

  it("stores zai credential keys and active provider after callback", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
            expires_in: 86400,
            user: {
              user_id: "zai-u-001",
              email: "user@example.com",
              avatar: "https://example.com/zai-avatar.png",
              created_at: "2026-04-27T10:00:00Z",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());
    const result = await service.handleCallback(
      `zcode://oauth/callback?code=zai-code-001&state=${state}&channel_id=google_ads&utm_source=google&utm_campaign=brand_search`,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const tokenCall = fetchMock.mock.calls[0];
    if (!tokenCall) {
      throw new Error("missing token call");
    }
    const tokenInit = tokenCall[1] as RequestInit;
    expect(JSON.parse(String(tokenInit.body))).toEqual({
      provider: ZAI_PROVIDER_ID,
      code: "zai-code-001",
      redirect_uri: PRODUCTION_DESKTOP_OAUTH_LOGIN_REDIRECT_URI,
      state,
    });

    expect(result).toEqual({
      kind: "session",
      provider: ZAI_PROVIDER_ID,
      userInfo: {
        id: "zai-u-001",
        username: "user@example.com",
        displayName: "user@example.com",
        avatarUrl: "https://example.com/zai-avatar.png",
      },
    });

    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBe(
      "zai_business_access_token",
    );
    expect(await credentialServiceStub.load("oauth:zai:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBe("zcode_backend_jwt");
    expect(await credentialServiceStub.load("oauth:login_attribution")).toBe(
      JSON.stringify({
        channel_id: "google_ads",
        utm_source: "google",
        utm_campaign: "brand_search",
      }),
    );
    expect(await credentialServiceStub.load("oauth:zai:user_info")).toBe(
      JSON.stringify({
        user_id: "zai-u-001",
        email: "user@example.com",
        avatar: "https://example.com/zai-avatar.png",
        created_at: "2026-04-27T10:00:00Z",
      }),
    );
    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(ZAI_PROVIDER_ID);
  });

  it("uses ZCODE_BASE_URL for zai backend token exchange", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
      env: {
        ...process.env,
        BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
        ZCODE_BASE_URL: "https://zcode.z.ai",
      },
    });
    const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: { access_token: "zai_oauth_access_token" },
            user: { user_id: "zai-u-001", email: "user@example.com" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await service.handleCallback(`zcode://oauth/callback?code=zai-code-001&state=${state}`);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://zcode.z.ai/api/v1/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses ZAI_BUSINESS_BASE_URL for zai business token exchange", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
      env: {
        ...process.env,
        BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
        ZAI_BUSINESS_BASE_URL: "https://api.z.ai",
      },
    });
    const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: { access_token: "zai_oauth_access_token" },
            user: { user_id: "zai-u-001", email: "user@example.com" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await service.handleCallback(`zcode://oauth/callback?code=zai-code-001&state=${state}`);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.z.ai/api/auth/z/login",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses zai backend user name without prefixing avatar path after callback", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
            user: {
              user_id: "zai-u-001",
              email: "13800000000@phone.local",
              avatar: "/user.png",
              name: "旅行者0000",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await expect(
      service.handleCallback(`zcode://oauth/callback?code=zai-code-001&state=${state}`),
    ).resolves.toEqual({
      kind: "session",
      provider: ZAI_PROVIDER_ID,
      userInfo: {
        id: "zai-u-001",
        username: "旅行者0000",
        displayName: "旅行者0000",
        avatarUrl: "/user.png",
      },
    });
  });

  it("keeps zai backend base64 avatar renderable after callback", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(ZAI_PROVIDER_ID);
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
            user: {
              user_id: "zai-u-002",
              email: "user@example.com",
              avatar: pngBase64,
              name: "Base64 User",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await expect(
      service.handleCallback(`zcode://oauth/callback?code=zai-code-002&state=${state}`),
    ).resolves.toEqual({
      kind: "session",
      provider: ZAI_PROVIDER_ID,
      userInfo: {
        id: "zai-u-002",
        username: "Base64 User",
        displayName: "Base64 User",
        avatarUrl: `data:image/png;base64,${pngBase64}`,
      },
    });
  });

  it("fails zai backend token exchange when business code is not zero", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 10001,
          msg: "invalid oauth code",
          data: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      service.handleCallback(`zcode://oauth/callback?code=bad-code&state=${state}`),
    ).rejects.toThrow(/invalid oauth code/);

    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
  });

  it("fails zai backend token exchange when response misses data.zai.access_token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {},
            expires_in: 86400,
            user: {
              user_id: "zai-u-001",
              email: "user@example.com",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      service.handleCallback(`zcode://oauth/callback?code=zai-code-001&state=${state}`),
    ).rejects.toThrow(/data.zai.access_token/);

    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
  });

  it("fails zai backend token exchange when response misses data token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            zai: {
              access_token: "zai_oauth_access_token",
            },
            user: {
              user_id: "zai-u-001",
              email: "user@example.com",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      service.handleCallback(`zcode://oauth/callback?code=zai-code-001&state=${state}`),
    ).rejects.toThrow(/data.token/);

    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
  });

  it("falls back to zai userinfo when backend token response misses user", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(ZAI_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sub: "zai-u-003",
          name: "Fallback User",
          picture: "https://example.com/fallback-avatar.png",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      service.handleCallback(`zcode://oauth/callback?code=zai-code-003&state=${state}`),
    ).resolves.toEqual({
      kind: "session",
      provider: ZAI_PROVIDER_ID,
      userInfo: {
        id: "zai-u-003",
        username: "Fallback User",
        displayName: "Fallback User",
        avatarUrl: "https://example.com/fallback-avatar.png",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      ZAI_OAUTH_PROVIDER_CONFIG.userinfoUrl,
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer zai_business_access_token",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("maps zai backend expires_in into OAuthTokenSet expiresAt", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );
    const now = 1_800_000_000_000;

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
            expires_in: 86400,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await expect(
      adapter.exchangeToken(
        { code: "zai-code-001", state: "state-001" },
        {
          providerId: ZAI_PROVIDER_ID,
          state: "state-001",
          redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
          now: () => now,
        },
      ),
    ).resolves.toEqual({
      accessToken: "zai_business_access_token",
      zcodeJwtToken: "zcode_backend_jwt",
      expiresAt: now + 86400 * 1000,
    });
  });

  it("logs zai backend token request without exposing full oauth code", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );
    const fullCode = "abcdefghijklmnopqrstuvwxyz";

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await adapter.exchangeToken(
      { code: fullCode, state: "state-001" },
      {
        providerId: ZAI_PROVIDER_ID,
        state: "state-001",
        redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
        now: () => 1_800_000_000_000,
      },
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[zaiOAuth]"),
      "token request",
      {
        method: "POST",
        url: ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
        headers: { "Content-Type": "application/json" },
        body: {
          provider: ZAI_PROVIDER_ID,
          code: "abcd...wxyz",
          codeLength: 26,
          redirect_uri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
          state: "state-001",
        },
      },
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(fullCode);
  });

  it("logs zai final token response body without exposing full token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );
    const fullToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock-signature";
    const fullZaiAccessToken = "zai_oauth_access_token_should_not_leak";

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: fullToken,
            zai: {
              access_token: fullZaiAccessToken,
            },
            expires_in: 86400,
            user: {
              user_id: "u_xxxxx",
              email: "user@example.com",
              avatar: "https://example.com/avatar.png",
              created_at: "2026-04-27T10:00:00Z",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await adapter.exchangeToken(
      { code: "zai-code-001", state: "state-001" },
      {
        providerId: ZAI_PROVIDER_ID,
        state: "state-001",
        redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
        now: () => 1_800_000_000_000,
      },
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[zaiOAuth]"),
      "token final response body",
      {
        code: 0,
        msg: "",
        data: {
          token: "eyJh...ture",
          tokenLength: fullToken.length,
          zai: {
            access_token: "zai_...leak",
            accessTokenLength: fullZaiAccessToken.length,
          },
          expires_in: 86400,
          user: {
            user_id: "u_xxxxx",
            email: "user@example.com",
            avatar: "https://example.com/avatar.png",
            created_at: "2026-04-27T10:00:00Z",
          },
        },
      },
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(fullToken);
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(fullZaiAccessToken);
  });

  it("logs zai token response request id on backend error", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );

    fetchMock.mockResolvedValueOnce(
      new Response("404 page not found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain",
          "set-cookie": "visitor_id=secret",
          "x-request-id": "req-404",
          "x-span-id": "span-404",
          "x-trace-id": "trace-404",
        },
      }),
    );

    await expect(
      adapter.exchangeToken(
        { code: "authorization-code", state: "state-404" },
        {
          providerId: ZAI_PROVIDER_ID,
          state: "state-404",
          redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
          now: () => 1_800_000_000_000,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: "ApiError",
        method: "POST",
        status: 404,
        url: ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
      }),
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[zaiOAuth]"),
      "token response error",
      {
        method: "POST",
        url: ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
        status: 404,
        responseHeaders: {
          "x-request-id": "req-404",
          "x-span-id": "span-404",
          "x-trace-id": "trace-404",
        },
      },
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain("visitor_id=secret");
  });

  it("stores namespaced credential keys and active provider after callback", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse());
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());
    const result = await service.handleCallback(
      `zcode://oauth/callback?authCode=auth-code-001&state=${state}&utm_source=google`,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://zcode.z.ai/api/v1/oauth/token",
      expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json" } }),
    );
    const zcodeTokenCall = fetchMock.mock.calls[0];
    if (!zcodeTokenCall) {
      throw new Error("missing zcode token call");
    }
    const zcodeTokenInit = zcodeTokenCall[1] as RequestInit;
    expect(JSON.parse(String(zcodeTokenInit.body))).toEqual({
      provider: BIGMODEL_PROVIDER_ID,
      code: "auth-code-001",
      redirect_uri: PRODUCTION_DESKTOP_OAUTH_LOGIN_REDIRECT_URI,
      state,
    });

    expect(result).toEqual({
      kind: "session",
      provider: BIGMODEL_PROVIDER_ID,
      userInfo: {
        id: "bigmodel-u-001",
        username: "BigModel User",
        displayName: "BigModel User",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      BIGMODEL_OAUTH_PROVIDER_CONFIG.userinfoUrl,
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "bigmodel-business-access-token",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe(
      "bigmodel-business-access-token",
    );
    expect(await credentialServiceStub.load("oauth:bigmodel:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBe("bigmodel-zcode-jwt");
    expect(await credentialServiceStub.load("oauth:login_attribution")).toBe(
      JSON.stringify({ utm_source: "google" }),
    );
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBe(
      JSON.stringify({
        ...result.userInfo,
        rawProfile: { zcodeProfileSchemaVersion: 2 },
      }),
    );
    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(BIGMODEL_PROVIDER_ID);
    expect(await credentialServiceStub.load("auth_token")).toBeNull();
    expect(await credentialServiceStub.load("refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("user_info")).toBeNull();
  });

  it("uses BigModel customerName before nickName for user display", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse());
    fetchMock.mockResolvedValueOnce(
      createBigModelUserInfoResponse("Nickname User", "bigmodel-u-001", "Customer User"),
    );

    const result = await service.handleCallback(
      `zcode://oauth/callback?authCode=auth-code-001&state=${state}`,
    );

    expect(result.userInfo).toEqual({
      id: "bigmodel-u-001",
      username: "Customer User",
      displayName: "Customer User",
    });
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBe(
      JSON.stringify({
        ...result.userInfo,
        rawProfile: { zcodeProfileSchemaVersion: 2 },
      }),
    );
  });

  it.each([
    ["empty customerName", ""],
    ["blank customerName", "   "],
  ])("falls back to BigModel nickName when %s is returned", async (_label, customerName) => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse());
    fetchMock.mockResolvedValueOnce(
      createBigModelUserInfoResponse("Nickname User", "bigmodel-u-001", customerName),
    );

    const result = await service.handleCallback(
      `zcode://oauth/callback?authCode=auth-code-001&state=${state}`,
    );

    expect(result.userInfo).toEqual({
      id: "bigmodel-u-001",
      username: "Nickname User",
      displayName: "Nickname User",
    });
  });

  it("falls back to BigModel nickName when customerName has malformed type", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse());
    fetchMock.mockResolvedValueOnce(
      createBigModelUserInfoResponse("Nickname User", "bigmodel-u-001", 123),
    );

    const result = await service.handleCallback(
      `zcode://oauth/callback?authCode=auth-code-001&state=${state}`,
    );

    expect(result.userInfo).toEqual({
      id: "bigmodel-u-001",
      username: "Nickname User",
      displayName: "Nickname User",
    });
  });

  it("falls back to default BigModel username when display fields have malformed types", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse());
    fetchMock.mockResolvedValueOnce(
      createBigModelUserInfoResponse({ value: "Nickname User" }, "bigmodel-u-001", 123),
    );

    const result = await service.handleCallback(
      `zcode://oauth/callback?authCode=auth-code-001&state=${state}`,
    );

    expect(result.userInfo).toEqual({
      id: "bigmodel-u-001",
      username: "user",
      displayName: "user",
    });
  });

  it("uses ZCODE_BASE_URL for bigmodel backend token exchange", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
      env: {
        ...process.env,
        BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
        ZCODE_BASE_URL: "https://zcode.z.ai",
      },
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse());
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());

    await service.handleCallback(`zcode://oauth/callback?authCode=auth-code-001&state=${state}`);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://zcode.z.ai/api/v1/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // Windows 机器上设置了 ZCODE_TEST_BASE_URL 等环境变量，会覆盖测试预期的 test 端点值
  it("uses test product endpoints for bigmodel token exchange and userinfo", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
      env: {
        ...cleanProcessEnv,
        BIGMODEL_OAUTH_APP_SECRET: "unit-test-secret",
        ZCODE_ENV: "test",
      },
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse());
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());

    await service.handleCallback(`zcode://oauth/callback?authCode=auth-code-001&state=${state}`);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://zcode.z.ai/api/v1/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://bigmodel.cn/api/biz/customer/getCustomerInfo",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("bigmodel zcode token 非 2xx 时中止登录并记录后端 msg", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 2007, msg: "http error" }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "req-zcode-500",
        },
      }),
    );

    await expect(
      service.handleCallback(`zcode://oauth/callback?authCode=auth-code-500&state=${state}`),
    ).rejects.toMatchObject<ApiError>({
      name: "ApiError",
      method: "POST",
      status: 500,
      url: "https://zcode.z.ai/api/v1/oauth/token",
      message: "http error",
    });

    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).toContain("http error");
    expect(JSON.stringify(consoleWarnSpy.mock.calls)).toContain("req-zcode-500");
  });

  it("keeps polling available when deep-link token exchange fails", async () => {
    let rejectExchange!: (error: Error) => void;
    const exchangeStarted = new Promise<never>((_, reject) => {
      rejectExchange = reject;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/oauth/cli/init")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              authorize_url: "https://example.com/authorize?state=flow-state",
              expires_at: 2_000_000_300,
              flow_id: "flow-1",
              poll_interval_sec: 1,
              poll_token: "poll-token",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/oauth/cli/poll/flow-1")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              status: "ready",
              token: "poll-jwt",
              user: { user_id: "poll-user", name: "Poll User" },
              bigmodel: { access_token: "poll-provider-token" },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const service = new OAuthService(credentialServiceStub, {
      apiClient: createMockApiClient(fetchMock),
      adapters: [
        {
          providerId: BIGMODEL_PROVIDER_ID,
          meta: { id: BIGMODEL_PROVIDER_ID, displayName: "BigModel", enabled: true, order: 1 },
          redirectUri: DESKTOP_OAUTH_CALLBACK_URI,
          buildAuthorizeUrl: ({ state }) => `https://example.com/authorize?state=${state}`,
          parseCallbackParams: (url) => ({
            code: new URL(url).searchParams.get("code") ?? "",
            state: new URL(url).searchParams.get("state") ?? "",
          }),
          exchangeToken: async () => exchangeStarted,
          normalizePolledTokenSet: async ({ accessToken, zcodeJwtToken }) => ({
            accessToken,
            zcodeJwtToken,
          }),
          normalizeError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        },
      ],
      now: () => 2_000_000_000_000,
    });

    const started = await service.startOAuthWithPolling(BIGMODEL_PROVIDER_ID);
    const deepLink = service.handleCallback(
      `zcode://oauth/callback?state=${started.state}&code=deep-link-code`,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rejectExchange(new Error("deep-link exchange failed"));
    await expect(deepLink).rejects.toThrow("deep-link exchange failed");

    await expect(service.pollPendingOAuth()).resolves.toEqual({
      kind: "session",
      provider: BIGMODEL_PROVIDER_ID,
      userInfo: { id: "poll-user", username: "Poll User", displayName: "Poll User" },
    });
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe(
      "poll-provider-token",
    );
  });

  it("does not persist a deep-link result after cancellation", async () => {
    let resolveExchange!: (tokenSet: OAuthTokenSet) => void;
    const exchange = new Promise<OAuthTokenSet>((resolve) => {
      resolveExchange = resolve;
    });
    const service = new OAuthService(credentialServiceStub, {
      adapters: [
        {
          providerId: BIGMODEL_PROVIDER_ID,
          meta: { id: BIGMODEL_PROVIDER_ID, displayName: "BigModel", enabled: true, order: 1 },
          redirectUri: DESKTOP_OAUTH_CALLBACK_URI,
          buildAuthorizeUrl: ({ state }) => `https://example.com/authorize?state=${state}`,
          parseCallbackParams: (url) => ({
            code: new URL(url).searchParams.get("code") ?? "",
            state: new URL(url).searchParams.get("state") ?? "",
          }),
          exchangeToken: async () => exchange,
          normalizeError: (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        },
      ],
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    const callback = service.handleCallback(`zcode://oauth/callback?state=${state}&code=late`);
    await Promise.resolve();
    await service.cancelPending();
    resolveExchange({ accessToken: "cancelled-token" });
    await expect(callback).resolves.toBeNull();
    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
  });

  it("clears the opposite OAuth provider when switching App login provider", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:zai:access_token", "old-zai-token");
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({
        id: "zai-old",
        username: "zai-old",
        displayName: "ZAI Old",
      }),
    );
    await credentialServiceStub.save("zcodejwttoken", "old-zcode-jwt");

    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    fetchMock.mockResolvedValueOnce(
      createBigModelZcodeTokenResponse("new-bigmodel-zcode-jwt", "new-bigmodel-business-token"),
    );
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());

    await service.handleCallback(`zcode://oauth/callback?authCode=switch-code&state=${state}`);

    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(BIGMODEL_PROVIDER_ID);
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe(
      "new-bigmodel-business-token",
    );
    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:zai:user_info")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBe("new-bigmodel-zcode-jwt");
  });

  it("BigModel zcode token 响应缺少 token 时中止登录", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          data: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      service.handleCallback(`zcode://oauth/callback?authCode=auth-code-missing&state=${state}`),
    ).rejects.toThrow(/缺少 data.token/);
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
  });

  it("BigModel zcode token 业务失败时透出 msg", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 10002,
          msg: "authCode 已过期",
          data: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      service.handleCallback(`zcode://oauth/callback?authCode=auth-code-expired&state=${state}`),
    ).rejects.toThrow(/authCode 已过期/);
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBeNull();
  });

  it("兼容 BigModel callback code 字段并只消费一次授权码", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse("code-field-zcode-jwt"));
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());

    await service.handleCallback(`zcode://oauth/callback?code=oauth-code-002&state=${state}`);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://zcode.z.ai/api/v1/oauth/token",
      expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json" } }),
    );
    const tokenCall = fetchMock.mock.calls[0];
    if (!tokenCall) {
      throw new Error("missing token call");
    }
    const tokenInit = tokenCall[1] as RequestInit;
    expect(JSON.parse(String(tokenInit.body))).toEqual({
      provider: BIGMODEL_PROVIDER_ID,
      code: "oauth-code-002",
      redirect_uri: PRODUCTION_DESKTOP_OAUTH_LOGIN_REDIRECT_URI,
      state,
    });
    expect(await credentialServiceStub.load("zcodejwttoken")).toBe("code-field-zcode-jwt");
  });

  it("App OAuth 入口切换 active provider", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({
        id: "zai-u-keep",
        username: "existing-zai-user",
        displayName: "Existing ZAI User",
      }),
    );

    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      createBigModelZcodeTokenResponse(
        "subscription-zcode-jwt",
        "subscription-business-access-token",
      ),
    );
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());

    const result = await service.handleCallback(
      `zcode://oauth/callback?authCode=subscription-code-001&state=${state}`,
    );

    expect(result).toEqual({
      kind: "session",
      provider: BIGMODEL_PROVIDER_ID,
      userInfo: {
        id: "bigmodel-u-001",
        username: "BigModel User",
        displayName: "BigModel User",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe(
      "subscription-business-access-token",
    );
    expect(await credentialServiceStub.load("oauth:bigmodel:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBe("subscription-zcode-jwt");
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBe(
      JSON.stringify({
        id: "bigmodel-u-001",
        username: "BigModel User",
        displayName: "BigModel User",
        rawProfile: { zcodeProfileSchemaVersion: 2 },
      }),
    );
    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(BIGMODEL_PROVIDER_ID);
    expect(await credentialServiceStub.load("oauth:zai:user_info")).toBeNull();
  });

  it("BigModel zcode token body 不携带 appSecret", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
      env: {} as NodeJS.ProcessEnv,
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse());
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());
    await service.handleCallback(`zcode://oauth/callback?authCode=auth-code-004&state=${state}`);

    const tokenCall = fetchMock.mock.calls[0];
    if (!tokenCall) {
      throw new Error("missing token call");
    }
    const tokenInit = tokenCall[1] as RequestInit;
    const tokenPayload = JSON.parse(String(tokenInit.body)) as { appSecret?: unknown };
    expect(tokenPayload.appSecret).toBeUndefined();
  });

  it("keeps single pending state and invalidates older flow", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    const first = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    const second = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    await expect(
      service.handleCallback(`zcode://oauth/callback?authCode=first&state=${first.state}`),
    ).rejects.toThrow(/state/);

    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse("token-2"));
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());
    await expect(
      service.handleCallback(`zcode://oauth/callback?authCode=second&state=${second.state}`),
    ).resolves.toEqual({
      kind: "session",
      provider: BIGMODEL_PROVIDER_ID,
      userInfo: {
        id: "bigmodel-u-001",
        username: "BigModel User",
        displayName: "BigModel User",
      },
    });
  });

  it("does not infer active provider from legacy token keys", async () => {
    const service = createBigModelService();

    await credentialServiceStub.save("auth_token", "legacy-token");

    await expect(service.getActiveProvider()).resolves.toBeNull();
    await expect(credentialServiceStub.load("oauth:active_provider")).resolves.toBeNull();
  });

  it("clears OAuth login credentials when active provider cannot be decrypted", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const deletedKeys: string[] = [];
    const brokenCredentialService: ICredentialService = {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          throw createMockCredentialDecryptError();
        }
        return `${key}-value`;
      },
      save: async () => {},
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    };
    const service = new OAuthService(brokenCredentialService, {
      adapters: [],
      onProviderLogout,
    });

    await expect(service.getActiveProvider()).resolves.toBeNull();

    expectDeletedOAuthSessionCredentials(deletedKeys);
    expectProviderLogoutNotifications(onProviderLogout, [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID]);
  });

  it("keeps corrupt OAuth recovery successful when derived provider cleanup fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onProviderLogout = vi.fn(async () => {
      throw new Error("model provider config write failed");
    });
    const deletedKeys: string[] = [];
    const brokenCredentialService: ICredentialService = {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          throw createMockCredentialDecryptError();
        }
        return `${key}-value`;
      },
      save: async () => {},
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    };
    const service = new OAuthService(brokenCredentialService, {
      adapters: [],
      onProviderLogout,
    });

    await expect(service.getActiveProvider()).resolves.toBeNull();

    expectDeletedOAuthSessionCredentials(deletedKeys);
    expectProviderLogoutNotifications(onProviderLogout, [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("clears OAuth login credentials when cached user info cannot be decrypted", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const deletedKeys: string[] = [];
    const brokenCredentialService: ICredentialService = {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          return ZAI_PROVIDER_ID;
        }
        if (key === "oauth:zai:user_info") {
          throw createMockCredentialDecryptError();
        }
        return `${key}-value`;
      },
      save: async () => {},
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    };
    const service = new OAuthService(brokenCredentialService, {
      adapters: [
        {
          providerId: ZAI_PROVIDER_ID,
          meta: {
            id: ZAI_PROVIDER_ID,
            displayName: "Z.ai",
            enabled: true,
            order: 1,
          },
          redirectUri: DESKTOP_OAUTH_CALLBACK_URI,
          parseCallbackParams: () => ({ code: "", state: "" }),
          buildAuthorizeUrl: () => "https://example.com/auth",
          exchangeToken: async () => ({ accessToken: "unused" }),
          normalizeError: (error: unknown) =>
            error instanceof Error ? error : new Error(String(error)),
        },
      ],
      onProviderLogout,
    });

    await expect(service.restoreCachedSession()).resolves.toBeNull();

    expectDeletedOAuthSessionCredentials(deletedKeys);
    expectProviderLogoutNotifications(onProviderLogout, [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID]);
  });

  it("clears registered OAuth provider credentials when cached user info cannot be decrypted", async () => {
    const customProviderId = "custom-oauth" as OAuthProviderId;
    const onProviderLogout = vi.fn(async () => {});
    const deletedKeys: string[] = [];
    const brokenCredentialService: ICredentialService = {
      load: async (key: string) => {
        if (key === "oauth:active_provider") {
          return customProviderId;
        }
        if (key === `oauth:${customProviderId}:user_info`) {
          throw createMockCredentialDecryptError();
        }
        return `${key}-value`;
      },
      save: async () => {},
      delete: async (key: string) => {
        deletedKeys.push(key);
      },
    };
    const service = new OAuthService(brokenCredentialService, {
      adapters: [
        {
          providerId: customProviderId,
          meta: {
            id: customProviderId,
            displayName: "Custom OAuth",
            enabled: true,
            order: 9,
          },
          redirectUri: "zcode://custom-auth/callback",
          parseCallbackParams: () => ({ code: "", state: "" }),
          buildAuthorizeUrl: () => "https://example.com/auth",
          exchangeToken: async () => ({ accessToken: "unused" }),
          normalizeError: (error: unknown) =>
            error instanceof Error ? error : new Error(String(error)),
        },
      ],
      onProviderLogout,
    });

    await expect(service.restoreCachedSession()).resolves.toBeNull();

    expectDeletedOAuthSessionCredentials(deletedKeys, [
      `oauth:${customProviderId}:access_token`,
      `oauth:${customProviderId}:refresh_token`,
      `oauth:${customProviderId}:user_info`,
    ]);
    expectProviderLogoutNotifications(onProviderLogout, [
      BIGMODEL_PROVIDER_ID,
      ZAI_PROVIDER_ID,
      customProviderId,
    ]);
  });

  it("refresh only reads namespaced keys and ignores legacy keys", async () => {
    const refreshAdapter: OAuthProviderAdapter = {
      providerId: BIGMODEL_PROVIDER_ID,
      meta: {
        id: BIGMODEL_PROVIDER_ID,
        displayName: "BigModel",
        enabled: true,
        order: 0,
      },
      redirectUri: DESKTOP_OAUTH_CALLBACK_URI,
      parseCallbackParams: () => ({ code: "", state: "" }),
      buildAuthorizeUrl: () => "https://example.com/auth",
      exchangeToken: async () => ({ accessToken: "unused" }),
      refreshToken: async (tokenSet: OAuthTokenSet) => ({
        accessToken: `${tokenSet.accessToken}-refreshed`,
        refreshToken: tokenSet.refreshToken,
      }),
      fetchUserInfo: async (): Promise<OAuthUserProfile> => ({
        id: "u-1",
        username: "tester",
        displayName: "Tester",
      }),
      normalizeError: (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    };

    const service = createBigModelService({ adapters: [refreshAdapter] });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("auth_token", "legacy-access");
    await credentialServiceStub.save("refresh_token", "legacy-refresh");

    await expect(service.refreshToken()).rejects.toThrow(/refresh_token/);

    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("auth_token")).toBe("legacy-access");
    expect(await credentialServiceStub.load("refresh_token")).toBe("legacy-refresh");
  });

  it("restores cached session from stored user info without remote validation", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    const cachedUser = {
      id: "u-cached-001",
      username: "CachedNick",
      displayName: "CachedNick",
      rawProfile: { zcodeProfileSchemaVersion: 2 },
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "expired-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    await expect(service.restoreCachedSession()).resolves.toEqual({
      id: "u-cached-001",
      username: "CachedNick",
      displayName: "CachedNick",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not migrate cached bigmodel profile with newer schema version", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    const cachedUser = {
      id: "u-cached-001",
      username: "FutureName",
      displayName: "FutureName",
      rawProfile: { zcodeProfileSchemaVersion: 3, futureField: "keep" },
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    await expect(service.restoreCachedSession()).resolves.toEqual({
      id: "u-cached-001",
      username: "FutureName",
      displayName: "FutureName",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBe(
      JSON.stringify(cachedUser),
    );
  });

  it("refreshes legacy cached bigmodel profile once and keeps login state when refresh succeeds", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    const cachedUser = {
      id: "bigmodel-u-001",
      username: "CachedNick",
      displayName: "CachedNick",
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    fetchMock.mockResolvedValueOnce(
      createBigModelUserInfoResponse("CachedNick", "bigmodel-u-001", "Account Center Name"),
    );

    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        BIGMODEL_OAUTH_PROVIDER_CONFIG.userinfoUrl,
        expect.objectContaining({
          method: "GET",
          headers: {
            Authorization: "session-access-token",
            "Content-Type": "application/json",
          },
        }),
      );
    });
    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(BIGMODEL_PROVIDER_ID);
    await vi.waitFor(async () => {
      expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBe(
        JSON.stringify({
          id: "bigmodel-u-001",
          username: "Account Center Name",
          displayName: "Account Center Name",
          rawProfile: { zcodeProfileSchemaVersion: 2 },
        }),
      );
    });
  });

  it("keeps legacy cached bigmodel profile when refresh fails", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    const cachedUser = {
      id: "bigmodel-u-001",
      username: "CachedNick",
      displayName: "CachedNick",
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "expired-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);

    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(BIGMODEL_PROVIDER_ID);
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe("expired-token");
    await vi.waitFor(async () => {
      expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBe(
        JSON.stringify({
          ...cachedUser,
          rawProfile: { zcodeProfileSchemaVersion: 2 },
        }),
      );
    });

    fetchMock.mockClear();
    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps legacy cached bigmodel profile when access token is polluted by zcode jwt", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    const cachedUser = {
      id: "bigmodel-u-001",
      username: "CachedNick",
      displayName: "CachedNick",
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "polluted-zcode-jwt");
    await credentialServiceStub.save("zcodejwttoken", "polluted-zcode-jwt");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(BIGMODEL_PROVIDER_ID);
    await vi.waitFor(async () => {
      expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBe(
        JSON.stringify({
          ...cachedUser,
          rawProfile: { zcodeProfileSchemaVersion: 2 },
        }),
      );
    });
  });

  it("retries legacy cached bigmodel profile after transient userinfo failure", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    let now = 1_000;
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
      now: () => now,
    });

    const cachedUser = {
      id: "bigmodel-u-001",
      username: "CachedNick",
      displayName: "CachedNick",
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);

    let retryAfter = 0;
    await vi.waitFor(async () => {
      const stored = JSON.parse(
        (await credentialServiceStub.load("oauth:bigmodel:user_info")) ?? "{}",
      ) as OAuthUserProfile;
      retryAfter =
        typeof stored.rawProfile?.zcodeProfileMigrationRetryAfter === "number"
          ? stored.rawProfile.zcodeProfileMigrationRetryAfter
          : 0;
      expect(retryAfter).toBeGreaterThan(now);
      expect(stored.rawProfile?.zcodeProfileSchemaVersion).toBeUndefined();
    });

    fetchMock.mockClear();
    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);
    expect(fetchMock).not.toHaveBeenCalled();

    now = retryAfter + 1;
    fetchMock.mockResolvedValueOnce(
      createBigModelUserInfoResponse("CachedNick", "bigmodel-u-001", "Account Center Name"),
    );

    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);
    await vi.waitFor(async () => {
      expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBe(
        JSON.stringify({
          id: "bigmodel-u-001",
          username: "Account Center Name",
          displayName: "Account Center Name",
          rawProfile: { zcodeProfileSchemaVersion: 2 },
        }),
      );
    });
  });

  it("returns legacy cached bigmodel profile without waiting for slow refresh", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    const cachedUser = {
      id: "bigmodel-u-001",
      username: "CachedNick",
      displayName: "CachedNick",
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));

    const result = await Promise.race([
      service.restoreCachedSession().then((userInfo) => ({ kind: "restored", userInfo })),
      new Promise<{ kind: "timeout"; userInfo: null }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout", userInfo: null }), 0),
      ),
    ]);

    expect(result).toEqual({ kind: "restored", userInfo: cachedUser });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("does not overwrite zai profile when BigModel cached migration finishes after provider switch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    let resolveUserInfo!: (response: Response) => void;
    const cachedUser = {
      id: "bigmodel-u-001",
      username: "CachedNick",
      displayName: "CachedNick",
    };
    const zaiUserInfo = {
      user_id: "zai-u-001",
      email: "zai@example.com",
      name: "ZAI Current",
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveUserInfo = resolve;
      }),
    );

    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await credentialServiceStub.delete("oauth:bigmodel:access_token");
    await credentialServiceStub.delete("oauth:bigmodel:user_info");
    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "zai-session-token");
    await credentialServiceStub.save("zcodejwttoken", "zai-zcode-jwt");
    await credentialServiceStub.save("oauth:zai:user_info", JSON.stringify(zaiUserInfo));

    const loadSpy = vi.spyOn(credentialServiceStub, "load");
    const loadCallCountBeforeResolve = loadSpy.mock.calls.length;

    resolveUserInfo(
      createBigModelUserInfoResponse("CachedNick", "bigmodel-u-001", "Account Center Name"),
    );

    await vi.waitFor(() => {
      expect(loadSpy.mock.calls.length).toBeGreaterThan(loadCallCountBeforeResolve);
    });
    expect(await credentialServiceStub.load("oauth:zai:user_info")).toBe(
      JSON.stringify(zaiUserInfo),
    );
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBeNull();
  });

  it("does not restore BigModel profile when cached migration finishes after logout", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    let resolveUserInfo!: (response: Response) => void;
    const cachedUser = {
      id: "bigmodel-u-001",
      username: "CachedNick",
      displayName: "CachedNick",
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveUserInfo = resolve;
      }),
    );

    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await service.logout();

    resolveUserInfo(
      createBigModelUserInfoResponse("CachedNick", "bigmodel-u-001", "Account Center Name"),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBeNull();
  });

  it("does not send zai token to BigModel when migration token load races with provider switch", async () => {
    const bigModelFetchMock = vi.fn<typeof fetch>();
    const migrationService = createBigModelService({
      apiClient: createMockApiClient(bigModelFetchMock),
    });
    let markTokenLoadStarted!: () => void;
    let releaseTokenLoad!: () => void;
    const tokenLoadStarted = new Promise<void>((resolve) => {
      markTokenLoadStarted = resolve;
    });
    const tokenLoadCanFinish = new Promise<void>((resolve) => {
      releaseTokenLoad = resolve;
    });
    const cachedUser = {
      id: "bigmodel-u-001",
      username: "CachedNick",
      displayName: "CachedNick",
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "bigmodel-session-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    let blockedBigModelTokenLoad = false;
    vi.spyOn(credentialServiceStub, "load").mockImplementation(async (key) => {
      if (key === "oauth:bigmodel:access_token" && !blockedBigModelTokenLoad) {
        blockedBigModelTokenLoad = true;
        markTokenLoadStarted();
        await tokenLoadCanFinish;
      }
      return credentialStore.get(key) ?? null;
    });

    await expect(migrationService.restoreCachedSession()).resolves.toEqual(cachedUser);
    await tokenLoadStarted;

    const zaiFetchMock = vi.fn<typeof fetch>();
    const zaiService = createBigModelService({
      apiClient: createMockApiClient(zaiFetchMock),
    });
    const { state } = await zaiService.startOAuth(ZAI_PROVIDER_ID);
    zaiFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zai-zcode-jwt",
            zai: { access_token: "zai-oauth-token" },
            user: { user_id: "zai-u-001", email: "zai@example.com" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    zaiFetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse("zai-business-token"));

    await zaiService.handleCallback(`zcode://zai-auth/callback?code=zai-code&state=${state}`);
    releaseTokenLoad();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bigModelFetchMock).not.toHaveBeenCalled();
    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(ZAI_PROVIDER_ID);
    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBe("zai-business-token");
  });

  it("does not leave BigModel profile when logout waits for cached migration save", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    let resolveUserInfo!: (response: Response) => void;
    let markSaveStarted!: () => void;
    let unblockSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveCanFinish = new Promise<void>((resolve) => {
      unblockSave = resolve;
    });
    const cachedUser = {
      id: "bigmodel-u-001",
      username: "CachedNick",
      displayName: "CachedNick",
    };

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");
    await credentialServiceStub.save("oauth:bigmodel:user_info", JSON.stringify(cachedUser));

    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveUserInfo = resolve;
      }),
    );

    await expect(service.restoreCachedSession()).resolves.toEqual(cachedUser);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    vi.spyOn(credentialServiceStub, "save").mockImplementation(async (key, value) => {
      if (key === "oauth:bigmodel:user_info" && value.includes("Account Center Name")) {
        markSaveStarted();
        await saveCanFinish;
      }
      credentialStore.set(key, value);
    });

    resolveUserInfo(
      createBigModelUserInfoResponse("CachedNick", "bigmodel-u-001", "Account Center Name"),
    );
    await saveStarted;

    const logoutPromise = service.logout();
    unblockSave();
    await logoutPromise;

    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBeNull();
  });

  it("restores cached zai session from raw backend user info", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "zai-session-token");
    await credentialServiceStub.save("zcodejwttoken", "zcode_backend_jwt");
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({
        user_id: "zai-u-cached",
        email: "13800000000@phone.local",
        avatar: pngBase64,
        name: "旅行者0000",
      }),
    );

    await expect(service.restoreCachedSession()).resolves.toEqual({
      id: "zai-u-cached",
      username: "旅行者0000",
      displayName: "旅行者0000",
      avatarUrl: `data:image/png;base64,${pngBase64}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalidates an expired zcode JWT and requests reauthentication", async () => {
    const onProviderLogout = vi.fn(async () => {
      throw new Error("derived provider cleanup failed");
    });
    const service = createBigModelService({
      now: () => 2_000_000,
      onProviderLogout,
    });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "zai-session-token");
    await credentialServiceStub.save("zcodejwttoken", createUnsignedJwt({ exp: 1_000 }));
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({ user_id: "zai-u-cached", name: "Ada" }),
    );

    await expect(service.restoreCachedSessionState()).resolves.toEqual({
      status: "reauthentication-required",
      reason: "jwt-expired",
    });
    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:zai:user_info")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
    expect(onProviderLogout).toHaveBeenCalledWith(ZAI_PROVIDER_ID, "zai-u-cached");
  });

  it("does not clear a new login completed while an expired cached session is being restored", async () => {
    const expiredJwt = createUnsignedJwt({ exp: 1_000 });
    let releaseExpiredJwtRead = () => undefined;
    let didBlockExpiredJwtRead = false;
    const expiredJwtReadStarted = new Promise<void>((resolve) => {
      const originalLoad = credentialServiceStub.load;
      vi.spyOn(credentialServiceStub, "load").mockImplementation(async (key) => {
        if (key !== "zcodejwttoken" || didBlockExpiredJwtRead) {
          return originalLoad(key);
        }
        didBlockExpiredJwtRead = true;
        const snapshot = await originalLoad(key);
        resolve();
        await new Promise<void>((release) => {
          releaseExpiredJwtRead = release;
        });
        return snapshot;
      });
    });
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      now: () => 2_000_000,
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "old-token");
    await credentialServiceStub.save("zcodejwttoken", expiredJwt);
    await credentialServiceStub.save(
      "oauth:bigmodel:user_info",
      JSON.stringify({ id: "old-user", username: "Old", displayName: "Old" }),
    );

    const restorePromise = service.restoreCachedSessionState();
    await expiredJwtReadStarted;
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    fetchMock.mockResolvedValueOnce(createBigModelZcodeTokenResponse("new-zcode-jwt", "new-token"));
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());
    await service.handleCallback(`zcode://oauth/callback?authCode=new-login&state=${state}`);
    releaseExpiredJwtRead();

    await expect(restorePromise).resolves.toMatchObject({ status: "authenticated" });
    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(BIGMODEL_PROVIDER_ID);
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe("new-token");
    expect(await credentialServiceStub.load("zcodejwttoken")).toBe("new-zcode-jwt");
  });

  it("does not clear a newly selected provider while another provider restore is expiring", async () => {
    const expiredJwt = createUnsignedJwt({ exp: 1_000 });
    let releaseExpiredJwtRead = () => undefined;
    let didBlockExpiredJwtRead = false;
    const expiredJwtReadStarted = new Promise<void>((resolve) => {
      const originalLoad = credentialServiceStub.load;
      vi.spyOn(credentialServiceStub, "load").mockImplementation(async (key) => {
        if (key !== "zcodejwttoken" || didBlockExpiredJwtRead) {
          return originalLoad(key);
        }
        didBlockExpiredJwtRead = true;
        const snapshot = await originalLoad(key);
        resolve();
        await new Promise<void>((release) => {
          releaseExpiredJwtRead = release;
        });
        return snapshot;
      });
    });
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      now: () => 2_000_000,
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "old-zai-token");
    await credentialServiceStub.save("zcodejwttoken", expiredJwt);
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({ user_id: "old-zai-user", name: "Old ZAI" }),
    );

    const restorePromise = service.restoreCachedSessionState();
    await expiredJwtReadStarted;
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);
    fetchMock.mockResolvedValueOnce(
      createBigModelZcodeTokenResponse("new-bigmodel-jwt", "new-bigmodel-token"),
    );
    fetchMock.mockResolvedValueOnce(createBigModelUserInfoResponse());
    await service.handleCallback(`zcode://oauth/callback?authCode=switch-login&state=${state}`);
    releaseExpiredJwtRead();

    await expect(restorePromise).resolves.toMatchObject({ status: "authenticated" });
    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(BIGMODEL_PROVIDER_ID);
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe(
      "new-bigmodel-token",
    );
    expect(await credentialServiceStub.load("zcodejwttoken")).toBe("new-bigmodel-jwt");
  });

  it("restores an authenticated cached session when zcode JWT is not expired", async () => {
    const service = createBigModelService({ now: () => 1_000_000 });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "zai-session-token");
    await credentialServiceStub.save("zcodejwttoken", createUnsignedJwt({ exp: 2_000 }));
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({ user_id: "zai-u-cached", name: "Ada" }),
    );

    await expect(service.restoreCachedSessionState()).resolves.toEqual({
      status: "authenticated",
      userInfo: {
        id: "zai-u-cached",
        username: "Ada",
        displayName: "Ada",
      },
    });
  });

  it("invalidates an expired BigModel zcode JWT before cached profile migration", async () => {
    const service = createBigModelService({ now: () => 2_000_000 });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "bigmodel-session-token");
    await credentialServiceStub.save("zcodejwttoken", createUnsignedJwt({ exp: 1_000 }));
    await credentialServiceStub.save(
      "oauth:bigmodel:user_info",
      JSON.stringify({ id: "bigmodel-u-cached", username: "Ada", displayName: "Ada" }),
    );

    await expect(service.restoreCachedSessionState()).resolves.toEqual({
      status: "reauthentication-required",
      reason: "jwt-expired",
    });
    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
  });

  it("returns null when restoring zai session without zcodejwttoken", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "zai-session-token");
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({
        user_id: "zai-u-cached",
        email: "13800000000@phone.local",
        name: "旅行者0000",
      }),
    );

    await expect(service.restoreCachedSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restoreCachedSession returns null when cached user info is missing", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");

    await expect(service.restoreCachedSession()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restores session by validating active provider access token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "session-access-token");

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            customerNumber: "u-restore-001",
            customerName: "Restore User",
            nickName: "RestoreNick",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(service.restoreSession()).resolves.toEqual({
      id: "u-restore-001",
      username: "Restore User",
      displayName: "Restore User",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      BIGMODEL_OAUTH_PROVIDER_CONFIG.userinfoUrl,
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "session-access-token",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("restores bigmodel session from legacy auth_token and migrates to namespaced key", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("auth_token", "legacy-access-token");

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            customerNumber: "u-legacy-001",
            customerName: "Legacy User",
            nickName: "LegacyNick",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(service.restoreSession()).resolves.toEqual({
      id: "u-legacy-001",
      username: "Legacy User",
      displayName: "Legacy User",
    });

    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe(
      "legacy-access-token",
    );
  });

  it("logouts active provider when startup validation reports unauthorized", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "expired-token");
    await credentialServiceStub.save("oauth:bigmodel:refresh_token", "refresh-token");
    await credentialServiceStub.save(
      "oauth:bigmodel:user_info",
      JSON.stringify({ id: "u", username: "u", displayName: "u" }),
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(service.restoreSession()).resolves.toBeNull();

    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBeNull();
  });

  it("app logout clears active provider credentials", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const service = createBigModelService({ onProviderLogout });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "token");
    await credentialServiceStub.save("oauth:zai:refresh_token", "refresh");
    await credentialServiceStub.save(
      "oauth:zai:user_info",
      JSON.stringify({ user_id: "account-a", name: "Ada" }),
    );
    await credentialServiceStub.save("zcodejwttoken", "zai-jwt");
    await credentialServiceStub.save(
      "oauth:login_attribution",
      JSON.stringify({ channel_id: "google_ads" }),
    );

    await service.logout();

    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:zai:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:zai:user_info")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
    expect(await credentialServiceStub.load("oauth:login_attribution")).toBe(
      JSON.stringify({ channel_id: "google_ads" }),
    );
    expect(onProviderLogout).toHaveBeenCalledWith(ZAI_PROVIDER_ID, "account-a");
  });

  it("provider unlink logs out the matching active provider", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const service = createBigModelService({ onProviderLogout });

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);
    await credentialServiceStub.save("oauth:bigmodel:access_token", "token");
    await credentialServiceStub.save("oauth:bigmodel:refresh_token", "refresh");
    await credentialServiceStub.save(
      "oauth:bigmodel:user_info",
      JSON.stringify({ id: "account-b", username: "Ada", displayName: "Ada" }),
    );
    await credentialServiceStub.save("zcodejwttoken", "bigmodel-jwt");

    await service.logout(BIGMODEL_PROVIDER_ID);

    expect(await credentialServiceStub.load("oauth:active_provider")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:refresh_token")).toBeNull();
    expect(await credentialServiceStub.load("oauth:bigmodel:user_info")).toBeNull();
    expect(await credentialServiceStub.load("zcodejwttoken")).toBeNull();
    expect(onProviderLogout).toHaveBeenCalledWith(BIGMODEL_PROVIDER_ID, "account-b");
  });

  it("provider unlink does not clear non-active provider credentials", async () => {
    const onProviderLogout = vi.fn(async () => {});
    const service = createBigModelService({ onProviderLogout });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "zai-token");
    await credentialServiceStub.save("oauth:bigmodel:access_token", "bigmodel-token");

    await service.logout(BIGMODEL_PROVIDER_ID);

    expect(await credentialServiceStub.load("oauth:active_provider")).toBe(ZAI_PROVIDER_ID);
    expect(await credentialServiceStub.load("oauth:zai:access_token")).toBe("zai-token");
    expect(await credentialServiceStub.load("oauth:bigmodel:access_token")).toBe("bigmodel-token");
    expect(onProviderLogout).not.toHaveBeenCalled();
  });

  it("throws clear error when provider does not support refresh", async () => {
    const service = createBigModelService();

    await credentialServiceStub.save("oauth:active_provider", BIGMODEL_PROVIDER_ID);

    await expect(service.refreshToken()).rejects.toThrow(/请重新登录/);
  });

  it("bigmodel zcode token 非 2xx 时会抛出统一的 ApiError", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });
    const { state } = await service.startOAuth(BIGMODEL_PROVIDER_ID);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      service.handleCallback(`zcode://oauth/callback?authCode=auth-code-401&state=${state}`),
    ).rejects.toMatchObject<ApiError>({
      name: "ApiError",
      method: "POST",
      status: 401,
      url: "https://zcode.z.ai/api/v1/oauth/token",
      message: "Unauthorized",
    });
  });

  it("zai userinfo 非法 JSON 时会向上抛出统一的 ApiError", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createBigModelService({
      apiClient: createMockApiClient(fetchMock),
    });

    await credentialServiceStub.save("oauth:active_provider", ZAI_PROVIDER_ID);
    await credentialServiceStub.save("oauth:zai:access_token", "zai-session-token");

    fetchMock.mockResolvedValueOnce(
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(service.restoreSession()).rejects.toMatchObject<ApiError>({
      name: "ApiError",
      method: "GET",
      status: 200,
      url: ZAI_OAUTH_PROVIDER_CONFIG.userinfoUrl,
    });
  });
});
