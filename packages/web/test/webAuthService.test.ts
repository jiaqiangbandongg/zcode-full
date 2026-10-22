import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserOAuthCredentialRepo } from "../src/auth/browserOAuthCredentialRepo.js";
import { buildOAuthState, parseOAuthState } from "../src/auth/oauthStateCodec.js";
import { createWebZaiOAuthConfig } from "../src/auth/webZaiOAuthConfig.js";
import { WebAuthService } from "../src/auth/webAuthService.js";
import { ZaiWebOAuthProvider } from "../src/auth/zaiWebOAuthProvider.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function createProductionWebZaiOAuthConfig() {
  return createWebZaiOAuthConfig({
    VITE_ZCODE_BASE_URL: "https://zcode.z.ai",
    VITE_ZAI_OAUTH_CLIENT_ID: "client_P8X5CMWmlaRO9gyO-KSqtg",
    VITE_ZAI_OAUTH_ORIGIN: "https://chat.z.ai",
  });
}

const PENDING_LOGINS_KEY = "oauth_pending_logins";

function seedPendingLogin(
  localStorage: Storage,
  login: { nonce: string; provider: "zai" | "bigmodel"; redirectUri: string },
): void {
  localStorage.setItem(PENDING_LOGINS_KEY, JSON.stringify([login]));
}

function createService(options?: {
  currentHref?: string;
  currentOrigin?: string;
  allowDevReturnToRedirect?: boolean;
}) {
  const localStorage = new MemoryStorage();
  const assigned: string[] = [];
  const replaced: string[] = [];
  let nonceCount = 0;
  const config = {
    ...createProductionWebZaiOAuthConfig(),
    allowDevReturnToRedirect: options?.allowDevReturnToRedirect ?? false,
  };
  // 每次调用模拟一个新的页面实例：同一标签页刷新，或同一浏览器的另一个标签页。
  // 每个实例都有独立的 sessionStorage，只共享同源 localStorage；登录不能依赖标签页内的存储。
  const openPage = () => {
    const storage = { localStorage, sessionStorage: new MemoryStorage() };
    return new WebAuthService({
      config,
      provider: new ZaiWebOAuthProvider(config, () => 1_000),
      repo: new BrowserOAuthCredentialRepo(storage),
      runtime: {
        assign: (url) => assigned.push(url),
        createNonce: () => `nonce-${++nonceCount}`,
        getCurrentHref: () =>
          options?.currentHref ??
          "http://192.168.1.8:5173/remote/v4?app_version=3.13.0&sid=device-1&mid=mid-1&name=Desktop",
        getCurrentOrigin: () => options?.currentOrigin ?? "http://192.168.1.8:5173",
        replace: (url) => replaced.push(url),
      },
    });
  };

  return {
    assigned,
    localStorage,
    replaced,
    service: openPage(),
    openPage,
  };
}

function mockTokenExchange(provider: "zai" | "bigmodel") {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: {
        token: "jwt",
        [provider]: { access_token: "access" },
        user: { user_id: "u_1", name: "Ada" },
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("WebAuthService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("设备页账号行读取当前平台与显示名；显示名缺失时回退用户名", () => {
    const { service, localStorage } = createService();
    expect(service.getActiveAccount()).toBeNull();
    localStorage.setItem("oauth:active_provider", "zai");
    localStorage.setItem(
      "oauth:zai:user_info",
      JSON.stringify({ user_id: "u_1", name: "Ada", avatar: "https://example.com/a.png" }),
    );
    expect(service.getActiveAccount()).toEqual({
      displayName: "Ada",
      avatarUrl: "https://example.com/a.png",
      provider: "zai",
    });
  });

  it("uses VITE_ZAI_OAUTH_ORIGIN and VITE_ZAI_OAUTH_CLIENT_ID to build test environment authorize URL", async () => {
    const testConfig = createWebZaiOAuthConfig({
      VITE_ZCODE_BASE_URL: "https://zcode.z.ai",
      VITE_ZAI_OAUTH_CLIENT_ID: "client_P8X5CMWmlaRO9gyO-KSqtg",
      VITE_ZAI_OAUTH_ORIGIN: "https://chat.z.ai/",
    });
    const localStorage = new MemoryStorage();
    const assigned: string[] = [];
    const service = new WebAuthService({
      config: testConfig,
      provider: new ZaiWebOAuthProvider(testConfig, () => 1_000),
      repo: new BrowserOAuthCredentialRepo({ localStorage }),
      runtime: {
        assign: (url) => assigned.push(url),
        createNonce: () => "nonce-1",
        getCurrentHref: () => "https://zcode.z.ai/remote/v4",
        getCurrentOrigin: () => "https://zcode.z.ai",
        replace: () => undefined,
      },
    });

    service.startLogin();

    const authorizeUrl = new URL(assigned[0]!);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://chat.z.ai/api/oauth/authorize",
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://zcode.z.ai/remote/v4",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
  });

  it("starts ZAI login with nonce, dev return_to, and original app_return_to", () => {
    const { assigned, localStorage, service } = createService();

    service.startLogin({
      devReturnTo: "http://192.168.1.8:5173/remote/v4",
    });

    const authorizeUrl = new URL(assigned[0]!);
    const state = parseOAuthState(authorizeUrl.searchParams.get("state")!);
    expect(JSON.parse(localStorage.getItem(PENDING_LOGINS_KEY)!)).toEqual([
      {
        nonce: "nonce-1",
        provider: "zai",
        redirectUri:
          "https://zcode.z.ai/remote/v4?app_version=3.13.0&sid=device-1&mid=mid-1&name=Desktop",
      },
    ]);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://chat.z.ai/api/oauth/authorize",
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://zcode.z.ai/remote/v4?app_version=3.13.0&sid=device-1&mid=mid-1&name=Desktop",
    );
    expect(state).toEqual({
      nonce: "nonce-1",
      return_to:
        "http://192.168.1.8:5173/remote/v4?app_version=3.13.0&sid=device-1&mid=mid-1&name=Desktop",
      app_return_to:
        "http://192.168.1.8:5173/remote/v4?app_version=3.13.0&sid=device-1&mid=mid-1&name=Desktop",
    });
  });

  it("uses the independent share callback when starting share login", () => {
    const { assigned, service } = createService({
      currentHref: "https://zcode.z.ai/cn/share/share-1",
    });
    service.startLogin({
      appReturnTo: "https://zcode.z.ai/cn/share/share-1",
      redirectUri: "https://zcode.z.ai/cn/share/callback",
    });
    expect(new URL(assigned[0]!).searchParams.get("redirect_uri")).toBe(
      "https://zcode.z.ai/cn/share/callback",
    );
  });

  it.each(
    (["zai", "bigmodel"] as const).flatMap((provider) =>
      ["/remote/v4/", "/remote/__test__", "/remote/__test__/"].map((path) => ({
        provider,
        path,
      })),
    ),
  )(
    // 回归：部分手机浏览器的回调页不是发起登录的标签页（或标签页被回收后重建），
    // 登录记录原先只在发起页的 sessionStorage，回调页读不到就报 “OAuth CSRF 检测失败”。
    "$provider $path completes login when the callback opens in another tab of the same browser, preserving QR parameters",
    async ({ provider, path }) => {
      const origin = "https://zcode.z.ai";
      const query = "app_version=3.14.0&sid=device-1&mid=&name=%E6%88%91%E7%9A%84+Mac%2B%26%3F";
      const h = createService({
        currentOrigin: origin,
        currentHref: `${origin}${path}?${query}&ignored=1&hash=old&t=1&token=secret&code=old&authCode=old&state=old&error=old#fragment`,
      });
      h.service.startLogin({ provider });
      const authorize = new URL(h.assigned[0]!);
      const redirectUri = authorize.searchParams.get(
        provider === "bigmodel" ? "redirect" : "redirect_uri",
      )!;
      expect(redirectUri).toBe(`${origin}/remote/v4?${query}`);
      const callback = new URL(redirectUri);
      callback.searchParams.set(provider === "bigmodel" ? "authCode" : "code", "code-1");
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            token: "jwt",
            [provider]: { access_token: "access" },
            user: { user_id: "u_1", name: "Ada" },
          },
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      // 必须跨实例读取 pending 地址，不能靠发起登录页的内存保留地址。
      const result = await h.openPage().handleCallback(callback.toString());
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        provider,
        code: "code-1",
        state: authorize.searchParams.get("state"),
        redirect_uri: redirectUri,
      });
      expect(result?.appReturnTo).toBe(`${path}?${query}`);
      expect(h.localStorage.getItem("oauth:active_provider")).toBe(provider);
      expect(h.localStorage.getItem(PENDING_LOGINS_KEY)).toBeNull();
    },
  );

  it("keeps the public authorization redirect through a private development callback", async () => {
    const devOrigin = "http://192.168.1.8:5173";
    const query = "app_version=3.14.0&sid=device-1&mid=mid-1&name=Desktop";
    const h = createService({
      currentOrigin: devOrigin,
      currentHref: `${devOrigin}/remote/v4?${query}`,
    });
    h.service.startLogin({ provider: "bigmodel", devReturnTo: `${devOrigin}/remote/v4` });
    const authorize = new URL(h.assigned[0]!);
    const callback = new URL(authorize.searchParams.get("redirect")!);
    callback.searchParams.set("authCode", "code-1");
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    const publicPage = createService({
      currentOrigin: "https://zcode.z.ai",
      allowDevReturnToRedirect: true,
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          token: "jwt",
          bigmodel: { access_token: "access" },
          user: { user_id: "u_1", name: "Ada" },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await publicPage.service.handleCallback(callback.toString())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const forwarded = new URL(publicPage.replaced[0]!);
    expect(forwarded.origin).toBe(devOrigin);
    expect(forwarded.searchParams.get("app_version")).toBe("3.14.0");
    expect(forwarded.searchParams.get("sid")).toBe("device-1");
    expect(forwarded.searchParams.get("mid")).toBe("mid-1");
    expect(forwarded.searchParams.get("name")).toBe("Desktop");
    await h.openPage().handleCallback(forwarded.toString());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).redirect_uri).toBe(
      `https://zcode.z.ai/remote/v4?${query}`,
    );
  });

  it("rejects an unknown nonce without exchanging token or consuming pending logins", async () => {
    const h = createService();
    h.service.startLogin({ provider: "bigmodel" });
    const pendingLogins = h.localStorage.getItem(PENDING_LOGINS_KEY);
    expect(pendingLogins).toContain("app_version=3.13.0");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = buildOAuthState({ nonce: "wrong-nonce" });
    await expect(
      h.openPage().handleCallback(`https://zcode.z.ai/remote/v4?authCode=code&state=${state}`),
    ).rejects.toThrow(/CSRF/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.localStorage.getItem(PENDING_LOGINS_KEY)).toBe(pendingLogins);
  });

  it("keeps parallel logins from two tabs independent", async () => {
    const h = createService();
    const tabA = h.service;
    const tabB = h.openPage();
    tabA.startLogin({ provider: "zai" });
    tabB.startLogin({ provider: "bigmodel" });
    const [authorizeA, authorizeB] = h.assigned.map((url) => new URL(url));

    const fetchMock = mockTokenExchange("zai");
    await h
      .openPage()
      .handleCallback(
        `https://zcode.z.ai/remote/v4?code=code-a&state=${authorizeA!.searchParams.get("state")}`,
      );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      provider: "zai",
      code: "code-a",
    });

    const bigmodelFetch = mockTokenExchange("bigmodel");
    await h
      .openPage()
      .handleCallback(
        `https://zcode.z.ai/remote/v4?authCode=code-b&state=${authorizeB!.searchParams.get("state")}`,
      );
    expect(JSON.parse(String(bigmodelFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      provider: "bigmodel",
      code: "code-b",
    });
    expect(h.localStorage.getItem("oauth:active_provider")).toBe("bigmodel");
    expect(h.localStorage.getItem(PENDING_LOGINS_KEY)).toBeNull();
  });

  it("preserves the canonical share page as the whole-Web OAuth return target", () => {
    const { assigned, service } = createService({
      currentHref: "https://zcode.z.ai/cn/share/share-1",
    });
    service.startLogin({ appReturnTo: "https://zcode.z.ai/cn/share/share-1" });
    const authorizeUrl = new URL(assigned[0]!);
    expect(parseOAuthState(authorizeUrl.searchParams.get("state")!)).toMatchObject({
      app_return_to: "https://zcode.z.ai/cn/share/share-1",
    });
  });

  it("forwards trusted cross-origin dev callbacks before nonce validation or token exchange", async () => {
    const { replaced, service } = createService({
      allowDevReturnToRedirect: true,
      currentOrigin: "https://zcode.z.ai",
      currentHref: "https://zcode.z.ai/remote/v4",
    });
    const state = buildOAuthState({
      nonce: "nonce-1",
      return_to: "http://192.168.1.8:5173/remote/v4",
      app_return_to: "http://192.168.1.8:5173/remote/v4?sid=device-1",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.handleCallback(
      `https://zcode.z.ai/remote/v4?code=code-1&state=${state}`,
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const redirectUrl = new URL(replaced[0]!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe("http://192.168.1.8:5173/remote/v4");
    expect(redirectUrl.searchParams.get("code")).toBe("code-1");
    expect(redirectUrl.searchParams.get("state")).toBe(state);
  });

  it("exchanges token, persists complete session, and returns sanitized app_return_to", async () => {
    const { localStorage, service } = createService();
    seedPendingLogin(localStorage, {
      nonce: "nonce-1",
      provider: "zai",
      redirectUri: "https://zcode.z.ai/remote/v4",
    });
    const state = buildOAuthState({
      nonce: "nonce-1",
      app_return_to: "http://192.168.1.8:5173/remote/v4?sid=device-1&ignored=1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            token: "jwt-token",
            zai: { access_token: "zai-token" },
            expires_in: 60,
            user: { user_id: "u_1", name: "Ada" },
          },
        }),
      })),
    );

    const result = await service.handleCallback(
      `http://192.168.1.8:5173/remote/v4?code=code-1&state=${state}`,
    );

    expect(result).toEqual({
      appReturnTo: "/remote/v4?sid=device-1",
      userInfo: {
        id: "u_1",
        username: "Ada",
        displayName: "Ada",
      },
    });
    expect(localStorage.getItem("zcodejwttoken")).toBe("jwt-token");
    expect(localStorage.getItem("oauth:zai:access_token")).toBe("zai-token");
    expect(localStorage.getItem("oauth:active_provider")).toBe("zai");
    expect(localStorage.getItem(PENDING_LOGINS_KEY)).toBeNull();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).redirect_uri).toBe(
      "https://zcode.z.ai/remote/v4",
    );
  });

  it("does not persist a half-login state when token response is incomplete", async () => {
    const { localStorage, service } = createService();
    seedPendingLogin(localStorage, {
      nonce: "nonce-1",
      provider: "zai",
      redirectUri: "https://zcode.z.ai/remote/v4",
    });
    const state = buildOAuthState({ nonce: "nonce-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            token: "jwt-token",
            zai: {},
            user: { user_id: "u_1", name: "Ada" },
          },
        }),
      })),
    );

    await expect(
      service.handleCallback(`http://192.168.1.8:5173/remote/v4?code=code-1&state=${state}`),
    ).rejects.toThrow(/access_token/);

    expect(localStorage.getItem("zcodejwttoken")).toBeNull();
    expect(localStorage.getItem("oauth:zai:access_token")).toBeNull();
    expect(localStorage.getItem("oauth:active_provider")).toBeNull();
  });
});

/**
 * BigModel 登录。
 *
 * 起因：private 分享的 owner 判定用的是 provider 自己的 user id（BigModel 是
 * CustomerNumber 数字串，Z.ai 是 sub UUID），所以桌面端用 BigModel 发布的私享分享，
 * 在只能 z.ai 登录的分享页上永远匹配不到 owner，服务端按存在性隐匿返回 404/3211。
 */
describe("WebAuthService BigModel provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("授权 URL 用 BigModel 的参数名（redirect/appId），不是 ZAI 的那套", () => {
    const { assigned, localStorage, service } = createService();

    service.startLogin({
      provider: "bigmodel",
      redirectUri: "https://zcode.z.ai/cn/share/callback",
    });

    const url = new URL(assigned[0]!);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect")).toBe("https://zcode.z.ai/cn/share/callback");
    expect(url.searchParams.get("appId")).toBe("zcode");
    // ZAI 专用参数不能出现，否则 BigModel 侧会忽略 redirect 直接回默认地址
    expect(url.searchParams.get("redirect_uri")).toBeNull();
    expect(url.searchParams.get("client_id")).toBeNull();
    expect(url.searchParams.get("response_type")).toBeNull();
    // 回调页要靠它知道用哪个 provider 换 token
    expect(JSON.parse(localStorage.getItem(PENDING_LOGINS_KEY)!)).toMatchObject([
      { provider: "bigmodel" },
    ]);
  });

  it("换 token 时带 provider，并从 data.bigmodel.access_token 取值", async () => {
    const { localStorage, service } = createService();
    seedPendingLogin(localStorage, {
      nonce: "nonce-1",
      provider: "bigmodel",
      redirectUri: "https://zcode.z.ai/cn/share/callback",
    });
    const state = buildOAuthState({ nonce: "nonce-1" });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          token: "jwt-token",
          bigmodel: { access_token: "bigmodel-token" },
          user: { user_id: "53291785835589288", name: "Ada" },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.handleCallback(
      `https://zcode.z.ai/cn/share/callback?code=code-1&state=${state}`,
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).provider).toBe("bigmodel");
    expect(result?.userInfo.id).toBe("53291785835589288");
    expect(localStorage.getItem("oauth:active_provider")).toBe("bigmodel");
    expect(localStorage.getItem("oauth:bigmodel:access_token")).toBe("bigmodel-token");
    expect(localStorage.getItem("zcodejwttoken")).toBe("jwt-token");
    // 登录记录用完即清，避免污染下一次登录
    expect(localStorage.getItem(PENDING_LOGINS_KEY)).toBeNull();
  });

  it("BigModel 响应缺 access_token 时不落半个登录态", async () => {
    const { localStorage, service } = createService();
    seedPendingLogin(localStorage, {
      nonce: "nonce-1",
      provider: "bigmodel",
      redirectUri: "https://zcode.z.ai/cn/share/callback",
    });
    const state = buildOAuthState({ nonce: "nonce-1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: { token: "jwt-token", bigmodel: {}, user: { user_id: "5329", name: "Ada" } },
        }),
      })),
    );

    await expect(
      service.handleCallback(`https://zcode.z.ai/cn/share/callback?code=code-1&state=${state}`),
    ).rejects.toThrow(/data\.bigmodel\.access_token/);

    expect(localStorage.getItem("zcodejwttoken")).toBeNull();
    expect(localStorage.getItem("oauth:active_provider")).toBeNull();
  });
});
