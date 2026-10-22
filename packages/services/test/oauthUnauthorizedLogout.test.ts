import { describe, expect, it, vi } from "vitest";
import type { OAuthProviderId } from "@zcode/shared";
import { OAuthService } from "#src/oauth/oauthService.js";
import {
  isCurrentOAuthCredentialRequest,
  isOAuthBusinessRequest,
  resolveOAuthBusinessCredentialValidationRequest,
} from "#src/oauth/oauthUnauthorizedRequest.js";
import { createNodeApiClient } from "#src/providers/api/nodeApiClient.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(provider: OAuthProviderId = "zai", responseStatus = 401) {
  const tokenKey = `oauth:${provider}:access_token`;
  const store = new Map([
    ["oauth:active_provider", provider],
    [tokenKey, "old-token"],
    [`oauth:${provider}:refresh_token`, "refresh-token"],
    ["zcodejwttoken", "old-jwt"],
    ["bot:test:credential", "independent"],
  ]);
  const credentials = {
    load: vi.fn(async (key: string) => store.get(key) ?? null),
    save: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  const refresh = vi.fn(async () => ({ accessToken: "new-token", refreshToken: "refresh-token" }));
  const onProviderLogout = vi.fn(async () => {});
  const env = { ZCODE_ENV: "production" };
  const service = new OAuthService(credentials, {
    env,
    onProviderLogout,
    adapters: [
      {
        providerId: provider,
        meta: { id: provider, displayName: provider, enabled: true, order: 0 },
        redirectUri: "zcode://oauth/callback",
        apiClient: { request: async () => new Response("{}") },
        buildAuthorizeUrl: ({ state }) => `https://example.test/login?state=${state}`,
        parseCallbackParams: (url) => ({
          code: "code",
          state: new URL(url).searchParams.get("state") ?? "",
        }),
        exchangeToken: async () => ({ accessToken: "new-token" }),
        refreshToken: refresh,
        normalizeError: (error) => (error instanceof Error ? error : new Error(String(error))),
      },
    ],
  });
  const url =
    provider === "zai"
      ? "https://api.z.ai/api/biz/customer/getCustomerInfo"
      : "https://bigmodel.cn/api/biz/customer/getCustomerInfo";
  const headers = new Headers({ Authorization: "Bearer old-token" });
  const notified = vi.fn();
  const logoutTasks: Promise<void>[] = [];
  const fetchImpl = vi.fn(async () =>
    Response.json({ code: 401, msg: "登录状态已过期", success: false }, { status: responseStatus }),
  );
  const client = createNodeApiClient({
    fetchImpl,
    isZcodeJwtRequest: (input, requestHeaders) =>
      isCurrentOAuthCredentialRequest({
        input,
        headers: requestHeaders,
        credentialService: credentials,
        env,
      }),
    isBusinessUnauthorizedRequest: (input, _requestHeaders) =>
      isOAuthBusinessRequest({
        input,
        credentialService: credentials,
        env,
      }),
    resolveBusinessCredentialValidationRequest: (input, headers) =>
      resolveOAuthBusinessCredentialValidationRequest({
        input,
        headers,
        credentialService: credentials,
        env,
      }),
    onZcodeJwtInvalid: (input, requestHeaders) => {
      const logoutTask = service
        .logoutIfCurrentCredentialRequest(input, requestHeaders)
        .then((invalidated) => {
          if (invalidated) notified();
        });
      logoutTasks.push(logoutTask);
    },
  });
  return {
    store,
    tokenKey,
    credentials,
    service,
    refresh,
    url,
    headers,
    onProviderLogout,
    notified,
    client,
    fetchImpl,
    waitLogout: () => (logoutTasks.length ? Promise.all(logoutTasks) : undefined),
  };
}

describe("401 条件退出与会话写入串行化", () => {
  it.each([
    ["bigmodel", 200],
    ["bigmodel", 403],
    ["zai", 200],
    ["zai", 403],
  ] as const)("%s 有效身份遇到业务 HTTP %i 时不能因核验头格式被清理", async (provider, status) => {
    const f = fixture(provider, status);
    let identityAuthorization: string | null = null;
    // 身份端点遵循裸 token 契约；错误前缀会返回401，必须验证真实退出链不会被误触发。
    f.fetchImpl.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/getCustomerInfo")) {
        identityAuthorization = new Headers(args[1]?.headers).get("authorization");
        return identityAuthorization === "old-token"
          ? Response.json({ code: 200, data: { customerNumber: "synthetic-account" } })
          : Response.json({ code: 401 }, { status: 401 });
      }
      return new Response("", { status });
    });
    const origin = provider === "bigmodel" ? "https://bigmodel.cn" : "https://api.z.ai";
    await f.client.request(origin + "/api/biz/subscription/enterprise/v2/pricing", {
      headers: f.headers,
    });
    await f.waitLogout();
    expect(identityAuthorization).toBe("old-token");
    expect(f.store.get("oauth:active_provider")).toBe(provider);
    expect(f.store.get(f.tokenKey)).toBe("old-token");
    expect(f.onProviderLogout).not.toHaveBeenCalled();
    expect(f.notified).not.toHaveBeenCalled();
  });
  it("BigModel 并发空定价响应只核验一次、清理一次并广播", async () => {
    const f = fixture("bigmodel", 200);
    const started = deferred(),
      release = deferred();
    f.fetchImpl.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/getCustomerInfo")) {
        started.resolve();
        await release.promise;
      }
      return new Response("");
    });
    const url = "https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing";
    const requests = [
      f.client.request(url, { headers: f.headers }),
      f.client.request(url, { headers: f.headers }),
    ];
    await started.promise;
    release.resolve();
    await Promise.all(requests);
    await f.waitLogout();
    expect(
      f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/getCustomerInfo")),
    ).toHaveLength(1);
    expect(f.store.has(f.tokenKey)).toBe(false);
    expect(f.store.get("bot:test:credential")).toBe("independent");
    expect(f.onProviderLogout).toHaveBeenCalledOnce();
    expect(f.notified).toHaveBeenCalledOnce();
  });

  it("身份核验等待期间新 token 已提交，旧空响应不清理新会话", async () => {
    const f = fixture("bigmodel", 200);
    const started = deferred(),
      release = deferred();
    f.fetchImpl.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/getCustomerInfo")) {
        started.resolve();
        await release.promise;
      }
      return new Response("");
    });
    const request = f.client.request(
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing",
      { headers: f.headers },
    );
    await started.promise;
    await f.service.refreshToken();
    release.resolve();
    await request;
    await f.waitLogout();
    expect(f.store.get(f.tokenKey)).toBe("new-token");
    expect(f.store.get("oauth:active_provider")).toBe("bigmodel");
    expect(f.onProviderLogout).not.toHaveBeenCalled();
    expect(f.notified).not.toHaveBeenCalled();
  });
  it.each(["bigmodel", "zai"] as const)(
    "%s 条件退出保留重构后的 accountIdentity 清理边界",
    async (provider) => {
      const f = fixture(provider);
      f.store.set(
        `oauth:${provider}:user_info`,
        JSON.stringify(
          provider === "zai"
            ? { user_id: "old-account", name: "Ada" }
            : { id: "old-account", username: "Ada", displayName: "Ada" },
        ),
      );
      expect(await f.service.logoutIfCurrentCredentialRequest(f.url, f.headers)).toBe(true);
      expect(f.onProviderLogout).toHaveBeenCalledWith(provider, "old-account");
      expect(f.store.has(`oauth:${provider}:user_info`)).toBe(false);
    },
  );

  it.each(["bigmodel", "zai"] as const)(
    "%s 三个接口并发业务 401 只清理一次并通知原过期提示",
    async (provider) => {
      const f = fixture(provider, 200);
      f.store.set(
        `oauth:${provider}:user_info`,
        JSON.stringify(
          provider === "zai"
            ? { user_id: "old-account", name: "Fixture User" }
            : { id: "old-account", username: "Fixture User", displayName: "Fixture User" },
        ),
      );
      const origin = new URL(f.url).origin;
      const responses = await Promise.all(
        [
          "/api/biz/customer/getCustomerInfo",
          "/api/biz/subscription/enterprise/v2/pricing",
          "/api/biz/team/subscribe/product/querySubscribeDetail",
        ].map((path) => f.client.request(`${origin}${path}`, { headers: f.headers })),
      );
      await f.waitLogout();
      expect(responses.every((response) => response.status === 200)).toBe(true);
      for (const response of responses) expect(await response.json()).toMatchObject({ code: 401 });
      expect(f.store.has(f.tokenKey)).toBe(false);
      expect(f.store.has("oauth:active_provider")).toBe(false);
      expect(f.store.has("zcodejwttoken")).toBe(false);
      expect(f.store.get("bot:test:credential")).toBe("independent");
      expect(f.onProviderLogout).toHaveBeenCalledExactlyOnceWith(provider, "old-account");
      expect(f.notified).toHaveBeenCalledOnce();
    },
  );

  it("手动退出仍报告派生清理错误，不把条件退出的降级扩散到手动命令", async () => {
    const f = fixture();
    f.onProviderLogout.mockRejectedValueOnce(new Error("provider cleanup failed"));
    await expect(f.service.logout()).rejects.toThrow("provider cleanup failed");
    expect(f.store.has(f.tokenKey)).toBe(false);
  });

  it.each(
    ["bigmodel", "zai"].flatMap((provider) =>
      [200, 401].map((status) => [provider as OAuthProviderId, status] as const),
    ),
  )(
    "%s 分类读取旧 token 后同平台刷新完成，旧 401 不清理新登录（HTTP %i）",
    async (provider, status) => {
      const f = fixture(provider, status);
      let rotated = false;
      f.credentials.load.mockImplementation(async (key) => {
        const value = f.store.get(key) ?? null;
        if (key === f.tokenKey && !rotated) {
          rotated = true;
          await f.service.refreshToken();
        }
        return value;
      });
      expect((await f.client.request(f.url, { headers: f.headers })).status).toBe(status);
      expect(f.waitLogout()).toBeDefined();
      await f.waitLogout();
      expect(f.store.get(f.tokenKey)).toBe("new-token");
      expect(f.onProviderLogout).not.toHaveBeenCalled();
      expect(f.notified).not.toHaveBeenCalled();
    },
  );

  it.each(
    ["bigmodel", "zai"].flatMap((provider) =>
      [200, 401].map((status) => [provider as OAuthProviderId, status] as const),
    ),
  )("%s 同平台重新登录在旧 401 分类期间完成，不清理新登录（HTTP %i）", async (provider, status) => {
    const f = fixture(provider, status);
    let loggedIn = false;
    f.credentials.load.mockImplementation(async (key) => {
      const value = f.store.get(key) ?? null;
      if (key === f.tokenKey && !loggedIn) {
        loggedIn = true;
        const { state } = await f.service.startOAuth(provider);
        await f.service.handleCallback(`zcode://oauth/callback?code=code&state=${state}`);
      }
      return value;
    });
    await f.client.request(f.url, { headers: f.headers });
    expect(f.waitLogout()).toBeDefined();
    await f.waitLogout();
    expect(f.store.get(f.tokenKey)).toBe("new-token");
    expect(f.store.get("oauth:active_provider")).toBe(provider);
    expect(f.onProviderLogout).not.toHaveBeenCalled();
    expect(f.notified).not.toHaveBeenCalled();
  });

  it("刷新写入已经进入队列时，条件退出等待提交后再核对 token", async () => {
    const f = fixture();
    const saving = deferred();
    const release = deferred();
    f.credentials.save.mockImplementation(async (key, value) => {
      if (key === f.tokenKey) {
        saving.resolve();
        await release.promise;
      }
      f.store.set(key, value);
    });
    const refreshed = f.service.refreshToken();
    await saving.promise;
    const invalidated = f.service.logoutIfCurrentCredentialRequest(f.url, f.headers);
    release.resolve();
    await refreshed;
    expect(await invalidated).toBe(false);
    expect(f.store.get(f.tokenKey)).toBe("new-token");
    expect(f.onProviderLogout).not.toHaveBeenCalled();
  });

  it("401 正在核对凭据时刷新不能插入清理窗口，迟到刷新也不能复活已退出会话", async () => {
    const f = fixture();
    const reading = deferred();
    const release = deferred();
    let blocked = false;
    f.credentials.load.mockImplementation(async (key) => {
      const value = f.store.get(key) ?? null;
      if (key === f.tokenKey && !blocked) {
        blocked = true;
        reading.resolve();
        await release.promise;
      }
      return value;
    });
    const invalidated = f.service.logoutIfCurrentCredentialRequest(f.url, f.headers);
    await reading.promise;
    const refreshed = f.service.refreshToken();
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
    release.resolve();
    expect(await invalidated).toBe(true);
    await refreshed;
    expect(f.store.has(f.tokenKey)).toBe(false);
    expect(f.store.has("oauth:active_provider")).toBe(false);
    expect(f.onProviderLogout).toHaveBeenCalledOnce();
  });

  it("当前 token 401 保留原清理行为，重复候选不重复通知，Bot 凭据独立", async () => {
    const f = fixture();
    expect(await f.service.logoutIfCurrentCredentialRequest(f.url, f.headers)).toBe(true);
    expect(await f.service.logoutIfCurrentCredentialRequest(f.url, f.headers)).toBe(false);
    expect(f.store.has(f.tokenKey)).toBe(false);
    expect(f.store.has("zcodejwttoken")).toBe(false);
    expect(f.store.get("bot:test:credential")).toBe("independent");
    expect(f.onProviderLogout).toHaveBeenCalledOnce();
  });
  it("凭据已清理但派生 provider 清理失败，仍返回失效事实以保留原过期提示", async () => {
    const f = fixture();
    f.onProviderLogout.mockRejectedValueOnce(new Error("provider cleanup failed"));
    expect(await f.service.logoutIfCurrentCredentialRequest(f.url, f.headers)).toBe(true);
    expect(f.store.has(f.tokenKey)).toBe(false);
  });

  it("并发 401 候选由同一队列核对，仅一个实际清理并通知", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.logoutIfCurrentCredentialRequest(f.url, f.headers),
      f.service.logoutIfCurrentCredentialRequest(f.url, f.headers),
    ]);
    expect(results).toEqual([true, false]);
    expect(f.onProviderLogout).toHaveBeenCalledOnce();
  });
});
