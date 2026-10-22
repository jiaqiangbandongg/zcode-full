import { afterEach, expect, it, vi } from "vitest";
import { ProxyChannel } from "@zcode/rpc";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID, type OAuthTokenSet } from "@zcode/shared";
import type { IOAuthService } from "#src/oauth/oauth.js";
import { OAuthService } from "#src/oauth/oauthService.js";

const services: OAuthService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.cancelPending()));
});

function fixture(onProviderLogout = vi.fn(async () => {})) {
  const credentials = new Map<string, string>();
  const credentialService = {
    load: async (key: string) => credentials.get(key) ?? null,
    save: async (key: string, value: string) => {
      credentials.set(key, value);
    },
    delete: async (key: string) => {
      credentials.delete(key);
    },
  };
  const exchangeToken = vi.fn(
    async (): Promise<OAuthTokenSet> => ({
      accessToken: "access",
      zcodeJwtToken: "jwt",
    }),
  );
  const service = new OAuthService(credentialService, {
    onProviderLogout,
    adapters: [
      {
        providerId: ZAI_PROVIDER_ID,
        apiClient: { request: vi.fn<typeof fetch>() },
        meta: { id: ZAI_PROVIDER_ID, displayName: "Z.ai", enabled: true, order: 1 },
        redirectUri: "zcode://oauth/callback",
        buildAuthorizeUrl: ({ state }) => `https://example.com/authorize?state=${state}`,
        parseCallbackParams: (url) => ({
          state: new URL(url).searchParams.get("state") ?? "",
          code: new URL(url).searchParams.get("code") ?? "",
        }),
        exchangeToken,
        fetchUserInfo: async () => ({ id: "user", username: "User", displayName: "User" }),
        normalizeError: (error) => (error instanceof Error ? error : new Error(String(error))),
      },
    ],
  });
  services.push(service);
  const server = ProxyChannel.fromService(service);
  const client = ProxyChannel.toService<IOAuthService>({
    call: (command, args) => server.call(undefined, command, args),
    listen: (event, args) => server.listen(undefined, event, args),
  });
  async function login() {
    const { state } = await client.startOAuth(ZAI_PROVIDER_ID);
    return client.handleCallback(`zcode://oauth/callback?state=${state}&code=code`);
  }
  return { service, client, credentials, credentialService, exchangeToken, login };
}

it("同账号每次凭据落盘均经 RPC 发布完成事件，先于调用结果及 UI 后处理", async () => {
  const f = fixture();
  const changes: string[] = [];
  const subscription = f.client.onDidChangeSession((state) => {
    expect(f.credentials.get("zcodejwttoken")).toBe("jwt");
    expect(f.credentials.get("oauth:active_provider")).toBe(ZAI_PROVIDER_ID);
    changes.push(state);
  });
  await f.login();
  await f.login();
  expect(changes).toEqual(["signed-in", "signed-in"]);
  subscription.dispose();
});

it.each(["active", "provider", "all"] as const)(
  "%s 登出清凭据后立即通知，即使派生 provider 清理失败",
  async (mode) => {
    const onProviderLogout = vi.fn(async () => {
      throw new Error("derived settings failed");
    });
    const f = fixture(onProviderLogout);
    await f.login();
    const changes: string[] = [];
    const subscription = f.client.onDidChangeSession((state) => {
      expect(f.credentials.has("zcodejwttoken")).toBe(false);
      expect(onProviderLogout).not.toHaveBeenCalled();
      changes.push(state);
    });
    const logout =
      mode === "all"
        ? f.client.logoutAll()
        : f.client.logout(mode === "provider" ? ZAI_PROVIDER_ID : undefined);
    await expect(logout).rejects.toThrow("derived settings failed");
    expect(changes).toEqual(["signed-out"]);
    subscription.dispose();
  },
);

it("取消中的登录和非当前 provider 的 unlink 不发布会话变更", async () => {
  const f = fixture();
  const changed = vi.fn();
  const subscription = f.client.onDidChangeSession(changed);
  const exchange = Promise.withResolvers<OAuthTokenSet>();
  f.exchangeToken.mockReturnValue(exchange.promise);
  const login = f.login();
  await vi.waitFor(() => expect(f.exchangeToken).toHaveBeenCalled());
  await f.client.cancelPending();
  exchange.resolve({ accessToken: "cancelled", zcodeJwtToken: "cancelled" });
  await login;
  await f.client.logout(BIGMODEL_PROVIDER_ID);
  expect(changed).not.toHaveBeenCalled();
  subscription.dispose();
});

it("active provider 落盘期间取消并回滚的登录不发布 signed-in", async () => {
  const f = fixture();
  const saving = Promise.withResolvers<void>();
  const continueSave = Promise.withResolvers<void>();
  const save = f.credentialService.save;
  vi.spyOn(f.credentialService, "save").mockImplementation(async (key, value) => {
    await save(key, value);
    if (key === "oauth:active_provider") {
      saving.resolve();
      await continueSave.promise;
    }
  });
  const changed = vi.fn();
  const subscription = f.client.onDidChangeSession(changed);
  const login = f.login();
  const rejected = expect(login).rejects.toThrow("OAuth flow 已取消");
  await saving.promise;
  await f.client.cancelPending();
  continueSave.resolve();
  await rejected;
  expect(f.credentials.has("zcodejwttoken")).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  subscription.dispose();
});
