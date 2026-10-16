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

function createService(options?: {
  currentHref?: string;
  currentOrigin?: string;
  allowDevReturnToRedirect?: boolean;
}) {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const assigned: string[] = [];
  const replaced: string[] = [];
  const config = {
    ...createProductionWebZaiOAuthConfig(),
    allowDevReturnToRedirect: options?.allowDevReturnToRedirect ?? false,
  };
  const service = new WebAuthService({
    config,
    provider: new ZaiWebOAuthProvider(config, () => 1_000),
    repo: new BrowserOAuthCredentialRepo({ localStorage, sessionStorage }),
    runtime: {
      assign: (url) => assigned.push(url),
      createNonce: () => "nonce-1",
      getCurrentHref: () =>
        options?.currentHref ??
        "http://192.168.1.8:5173/web-remote?remoteControlToken=token&relayOrigin=https%3A%2F%2Frelay.example",
      getCurrentOrigin: () => options?.currentOrigin ?? "http://192.168.1.8:5173",
      replace: (url) => replaced.push(url),
    },
  });

  return { assigned, localStorage, replaced, service, sessionStorage };
}

describe("WebAuthService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses VITE_ZAI_OAUTH_ORIGIN and VITE_ZAI_OAUTH_CLIENT_ID to build test environment authorize URL", async () => {
    const testConfig = createWebZaiOAuthConfig({
      VITE_ZCODE_BASE_URL: "https://zcode.z.ai",
      VITE_ZAI_OAUTH_CLIENT_ID: "client_P8X5CMWmlaRO9gyO-KSqtg",
      VITE_ZAI_OAUTH_ORIGIN: "https://chat.z.ai/",
    });
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const assigned: string[] = [];
    const service = new WebAuthService({
      config: testConfig,
      provider: new ZaiWebOAuthProvider(testConfig, () => 1_000),
      repo: new BrowserOAuthCredentialRepo({ localStorage, sessionStorage }),
      runtime: {
        assign: (url) => assigned.push(url),
        createNonce: () => "nonce-1",
        getCurrentHref: () => "https://zcode.z.ai/web-remote",
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
      "https://zcode.z.ai/web-remote/callback",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
  });

  it("starts ZAI login with nonce, dev return_to, and original app_return_to", () => {
    const { assigned, service, sessionStorage } = createService();

    service.startLogin({
      devReturnTo: "http://192.168.1.8:5173/web-remote/callback",
    });

    const authorizeUrl = new URL(assigned[0]!);
    const state = parseOAuthState(authorizeUrl.searchParams.get("state")!);
    expect(sessionStorage.getItem("oauth_pending_nonce")).toBe("nonce-1");
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://chat.z.ai/api/oauth/authorize",
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://zcode.z.ai/web-remote/callback",
    );
    expect(state).toEqual({
      nonce: "nonce-1",
      return_to: "http://192.168.1.8:5173/web-remote/callback",
      app_return_to:
        "http://192.168.1.8:5173/web-remote?remoteControlToken=token&relayOrigin=https%3A%2F%2Frelay.example",
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
      currentHref: "https://zcode.z.ai/web-remote/callback",
    });
    const state = buildOAuthState({
      nonce: "nonce-1",
      return_to: "http://192.168.1.8:5173/web-remote/callback",
      app_return_to: "http://192.168.1.8:5173/web-remote?remoteControlToken=token",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.handleCallback(
      `https://zcode.z.ai/web-remote/callback?code=code-1&state=${state}`,
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const redirectUrl = new URL(replaced[0]!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      "http://192.168.1.8:5173/web-remote/callback",
    );
    expect(redirectUrl.searchParams.get("code")).toBe("code-1");
    expect(redirectUrl.searchParams.get("state")).toBe(state);
  });

  it("exchanges token, persists complete session, and returns sanitized app_return_to", async () => {
    const { localStorage, service, sessionStorage } = createService();
    sessionStorage.setItem("oauth_pending_nonce", "nonce-1");
    const state = buildOAuthState({
      nonce: "nonce-1",
      app_return_to: "http://192.168.1.8:5173/web-remote?remoteControlToken=token&ignored=1",
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
      `http://192.168.1.8:5173/web-remote/callback?code=code-1&state=${state}`,
    );

    expect(result).toEqual({
      appReturnTo: "/web-remote?remoteControlToken=token",
      userInfo: {
        id: "u_1",
        username: "Ada",
        displayName: "Ada",
      },
    });
    expect(localStorage.getItem("zcodejwttoken")).toBe("jwt-token");
    expect(localStorage.getItem("oauth:zai:access_token")).toBe("zai-token");
    expect(localStorage.getItem("oauth:active_provider")).toBe("zai");
    expect(sessionStorage.getItem("oauth_pending_nonce")).toBeNull();
  });

  it("does not persist a half-login state when token response is incomplete", async () => {
    const { localStorage, service, sessionStorage } = createService();
    sessionStorage.setItem("oauth_pending_nonce", "nonce-1");
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
      service.handleCallback(
        `http://192.168.1.8:5173/web-remote/callback?code=code-1&state=${state}`,
      ),
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
    const { assigned, service, sessionStorage } = createService();

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
    expect(sessionStorage.getItem("oauth_pending_provider")).toBe("bigmodel");
  });

  it("换 token 时带 provider，并从 data.bigmodel.access_token 取值", async () => {
    const { localStorage, service, sessionStorage } = createService();
    sessionStorage.setItem("oauth_pending_nonce", "nonce-1");
    sessionStorage.setItem("oauth_pending_provider", "bigmodel");
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
    // pending provider 用完即清，避免污染下一次登录
    expect(sessionStorage.getItem("oauth_pending_provider")).toBeNull();
  });

  it("缺少 pending provider 时按 zai 兜底，保持旧回调链接可用", async () => {
    const { localStorage, service, sessionStorage } = createService();
    sessionStorage.setItem("oauth_pending_nonce", "nonce-1");
    const state = buildOAuthState({ nonce: "nonce-1" });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          token: "jwt-token",
          zai: { access_token: "zai-token" },
          user: { user_id: "u_1", name: "Ada" },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await service.handleCallback(`https://zcode.z.ai/cn/share/callback?code=code-1&state=${state}`);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).provider).toBe("zai");
    expect(localStorage.getItem("oauth:active_provider")).toBe("zai");
  });

  it("BigModel 响应缺 access_token 时不落半个登录态", async () => {
    const { localStorage, service, sessionStorage } = createService();
    sessionStorage.setItem("oauth_pending_nonce", "nonce-1");
    sessionStorage.setItem("oauth_pending_provider", "bigmodel");
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
