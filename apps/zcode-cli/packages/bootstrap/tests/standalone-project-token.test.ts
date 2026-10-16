import { ProviderConfig, ProviderConfigMap, ZhipuAccountAccessConfig } from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import {
  createStandaloneProviderRuntimeHeadersPort,
  readStandaloneAccountProviderConfigSnapshot,
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "../src/app/standalone-account-provider-runtime.js";

function fixture() {
  const providerId = "account:bigmodel-individual-coding-plan";
  const identityKey = standaloneAccountIdentityCredentialKey(providerId);
  const sourceKey = standaloneAccountAuthSourceCredentialKey(providerId);
  const legacyKey = standaloneAccountProviderCredentialKey({
    providerId,
    accountIdentity: "account-a",
  });
  const loginKey = "oauth:bigmodel:access_token";
  const values = new Map([
    [identityKey, "account-a"],
    [sourceKey, "oauth"],
    [legacyKey, "legacy-secret"],
    [loginKey, "login-a"],
  ]);
  const store = {
    load: async (key: string) => values.get(key) ?? null,
    loadMany: async (keys: readonly string[]) =>
      Object.fromEntries(keys.map((key) => [key, values.get(key) ?? null])),
    save: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: async (key: string) => {
      values.delete(key);
    },
  };
  const resolver = {
    resolve: vi.fn(async () => "short-token"),
    resolveMaterial: vi.fn(async () => ({
      token: "short-token",
      apiKeyId: "real-key-id",
      organizationId: "org",
      projectId: "proj",
    })),
    clear: vi.fn(),
  };
  const port = createStandaloneProviderRuntimeHeadersPort(store, {}, resolver);
  const request = (
    recovery: { expectedAccountScope?: string; rejectedProjectTokenFingerprint?: string } = {},
  ) =>
    port.refreshBeforeModelRequest({
      ...recovery,
      providerId,
      modelId: "glm",
      accountAccess: {
        type: "zhipu-account",
        accountType: "bigmodel",
        entitled: true,
        mode: "individual-coding-plan",
      },
      reason: "model-request",
      sessionId: "session" as never,
      traceContext: { traceId: "trace" } as never,
    });
  return {
    values,
    store,
    resolver,
    port,
    request,
    providerId,
    loginKey,
    identityKey,
    sourceKey,
    legacyKey,
  };
}

describe("Standalone Project Token", () => {
  it("401 恢复携带失败指纹；重新登录和手工模式切换后拒绝旧作用域", async () => {
    const f = fixture();
    const initial = await f.request();
    const expectedAccountScope = initial.requestAuth?.accountScope;
    expect(expectedAccountScope).toMatch(/^[a-f0-9]{64}$/);
    const recovery = { expectedAccountScope, rejectedProjectTokenFingerprint: "b".repeat(64) };
    await f.request(recovery);
    expect(f.resolver.resolveMaterial).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rejectedProjectTokenFingerprint: recovery.rejectedProjectTokenFingerprint,
      }),
      { signal: undefined },
    );
    f.values.set(f.loginKey, "login-b");
    await expect(f.request(recovery)).rejects.toThrow("scope_invalidated");
    f.values.set(f.sourceKey, "manual");
    await expect(f.request(recovery)).rejects.toThrow("scope_invalidated");
    expect(f.resolver.resolveMaterial).toHaveBeenCalledTimes(2);
  });

  it("请求时取得 Token，旧 Key 不参与，Token 不落盘", async () => {
    const f = fixture();
    await expect(f.request()).resolves.toMatchObject({
      requestAuth: { apiKey: "short-token", apiKeyId: "real-key-id" },
    });
    expect(f.resolver.resolveMaterial).toHaveBeenCalledWith(
      {
        family: "bigmodel",
        accessToken: "login-a",
        accountIdentity: "account-a",
        rejectedProjectTokenFingerprint: undefined,
        trace: { traceId: "trace" },
      },
      { signal: undefined },
    );
    expect(JSON.stringify([...f.values])).not.toContain("short-token");
    expect(f.values.get(f.legacyKey)).toBe("legacy-secret");
  });
  it.each(["missing", "corrupt"])("旧 OAuth 用户无来源标记且旧 Key=%s 时可恢复", async (legacy) => {
    const f = fixture();
    f.values.delete(f.sourceKey);
    f.values.delete(f.legacyKey);
    const loadMany = vi.fn(async (keys: readonly string[]) => {
      if (legacy === "corrupt" && keys.includes(f.legacyKey))
        throw new Error("legacy ciphertext corrupt");
      return f.store.loadMany(keys);
    });
    const snapshot = await readStandaloneAccountProviderConfigSnapshot(
      { loadMany },
      {},
      {
        revision: "builtin",
        providers: new ProviderConfigMap([
          [
            f.providerId,
            new ProviderConfig({
              access: new ZhipuAccountAccessConfig({
                accountType: "bigmodel",
                mode: "individual-coding-plan",
              }),
              builtinModelIds: ["glm"],
            }),
          ],
        ]),
      },
    );
    expect(snapshot.providers.get(f.providerId)?.access).toMatchObject({ entitled: true });
    expect(loadMany.mock.calls.flatMap(([keys]) => keys)).not.toContain(f.legacyKey);
    await expect(f.request()).resolves.toMatchObject({
      requestAuth: { apiKey: "short-token", apiKeyId: "real-key-id" },
    });
    expect(f.values.get(f.sourceKey)).toBe("oauth");
  });

  it("明确手工模式不读取损坏的 OAuth", async () => {
    const f = fixture();
    f.values.set(f.sourceKey, "manual");
    const originalLoad = f.store.load;
    f.store.load = async (key) => {
      if (key === f.loginKey) throw new Error("unused OAuth ciphertext corrupt");
      return originalLoad(key);
    };
    await expect(f.request()).resolves.toMatchObject({ requestAuth: { apiKey: "legacy-secret" } });
    const snapshot = await readStandaloneAccountProviderConfigSnapshot(
      {
        loadMany: async (keys) => {
          if (keys.includes(f.loginKey)) throw new Error("unused OAuth ciphertext corrupt");
          return f.store.loadMany(keys);
        },
      },
      {},
      {
        revision: "builtin",
        providers: new ProviderConfigMap([
          [
            f.providerId,
            new ProviderConfig({
              access: new ZhipuAccountAccessConfig({
                accountType: "bigmodel",
                mode: "individual-coding-plan",
              }),
              builtinModelIds: ["glm"],
            }),
          ],
        ]),
      },
    );
    expect(snapshot.providers.get(f.providerId)?.access).toMatchObject({ entitled: true });
  });

  it("缺失 OAuth 不回退到旧 Key", async () => {
    const f = fixture();
    f.values.delete(f.loginKey);
    await expect(f.request()).rejects.toThrow("project_token_login_required");
    expect(f.resolver.resolveMaterial).not.toHaveBeenCalled();
  });
  it("退出后丢弃迟到 Token 并清除内存缓存", async () => {
    const f = fixture();
    let release!: (value: {
      token: string;
      apiKeyId: string;
      organizationId: string;
      projectId: string;
    }) => void;
    f.resolver.resolveMaterial.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.request();
    const rejected = expect(pending).rejects.toThrow("project_token_scope_invalidated");
    await vi.waitFor(() => expect(f.resolver.resolveMaterial).toHaveBeenCalled());
    f.values.delete(f.loginKey);
    await f.port.invalidateChangedCredentials();
    release({ token: "late-token", apiKeyId: "key-id", organizationId: "org", projectId: "proj" });
    await rejected;
    expect(f.resolver.clear).toHaveBeenCalled();
  });
  it("旧记录无来源标记且无登录态时，不猜测为手工 Key", async () => {
    const f = fixture();
    f.values.delete(f.sourceKey);
    f.values.delete(f.loginKey);
    await expect(f.request()).rejects.toThrow("project_token_login_required");
    expect(f.resolver.resolveMaterial).not.toHaveBeenCalled();
  });
  it("用户手工 Key 保留独立请求方式", async () => {
    const f = fixture();
    f.values.set(f.sourceKey, "manual");
    await expect(f.request()).resolves.toMatchObject({
      requestAuth: { apiKey: "legacy-secret" },
    });
    expect(f.resolver.resolveMaterial).not.toHaveBeenCalled();
  });
});
