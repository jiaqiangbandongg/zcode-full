import { describe, expect, it, vi } from "vitest";
import { ProjectAccessTokenClient } from "../src/project-access-token-client.js";
import { projectAccessTokenFingerprint } from "../src/project-access-token.js";

const input = {
  origin: "https://example.invalid",
  family: "bigmodel" as const,
  loginToken: "login",
  accountId: "user",
};
function fixture(existing = true) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const request = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith("/getCustomerInfo"))
      return {
        code: 200,
        data: {
          organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
        },
      };
    if (url.endsWith("/api_keys"))
      return {
        code: 200,
        data:
          init.method === "POST"
            ? { apiKey: "key" }
            : existing
              ? [{ apiKey: "key", name: "zcode-api-key" }]
              : [],
      };
    if (url.endsWith("/key/access_tokens"))
      return {
        code: 200,
        data: {
          accessToken: "short-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        },
      };
    throw new Error("unexpected request");
  });
  return { request, requests };
}

describe("ProjectAccessTokenClient", () => {
  it("收到失败指纹后复用 Key ID 换证，并发/迟到拒绝只产生一次新签发", async () => {
    const f = fixture();
    let issues = 0;
    const client = new ProjectAccessTokenClient({
      request: async (url, init) => {
        const value = await f.request(url, init);
        if (url.endsWith("/access_tokens"))
          return { ...value, data: { ...value.data, accessToken: `pat-${++issues}` } };
        return value;
      },
    });
    await client.resolve(input);
    const recovery = {
      ...input,
      rejectedProjectTokenFingerprint: await projectAccessTokenFingerprint("pat-1"),
    };
    const results = await Promise.all([client.resolve(recovery), client.resolve(recovery)]);
    expect(results.map((value) => value.token)).toEqual(["pat-2", "pat-2"]);
    expect((await client.resolve(recovery)).token).toBe("pat-2");
    expect(issues).toBe(2);
    expect(f.requests.filter((r) => r.url.endsWith("/api_keys"))).toHaveLength(1);
    expect(JSON.stringify(f.requests)).not.toContain(recovery.rejectedProjectTokenFingerprint);
  });

  it.each([true, false])("已有专用 Key=%s：只取 ID 签发，不 Copy", async (existing) => {
    const f = fixture(existing);
    const client = new ProjectAccessTokenClient({ request: f.request });
    const result = await client.resolve(input);
    expect(result).toMatchObject({ token: "short-token", apiKeyId: "key" });
    expect(await client.resolve(input)).toEqual(result);
    expect(f.requests.filter((r) => r.url.endsWith("/access_tokens"))).toHaveLength(1);
    expect(f.requests.some((r) => r.url.includes("/copy/"))).toBe(false);
    const issue = f.requests.find((r) => r.url.endsWith("/access_tokens"))!;
    expect(issue.init.headers).toMatchObject({
      Authorization: "Bearer login",
    });
    expect(JSON.parse(String(issue.init.body))).toMatchObject({
      clientType: "zcode",
    });
    const created = f.requests.find((r) => r.url.endsWith("/api_keys") && r.init.method === "POST");
    expect(Boolean(created)).toBe(!existing);
    if (created)
      expect(JSON.parse(String(created.init.body))).toEqual({
        name: "zcode-api-key",
        usageScene: 1,
      });
  });

  it("退出使在途元数据失效，不继续签发或返回凭据", async () => {
    let release!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const client = new ProjectAccessTokenClient({ request });
    const result = client.resolve(input);
    const rejected = expect(result).rejects.toThrow("project_token_scope_invalidated");
    await Promise.resolve();
    client.clear();
    release({ code: 200, data: { organizations: [] } });
    await rejected;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("明确关闭时失败，不 Copy、不输出服务端敏感错误", async () => {
    const f = fixture();
    const client = new ProjectAccessTokenClient({
      request: async (url, init) =>
        url.endsWith("/access_tokens")
          ? { code: 200, data: { enable: false } }
          : f.request(url, init),
    });
    await expect(client.resolve(input)).rejects.toThrow("project_token_disabled");
    expect(f.requests.some((r) => r.url.includes("copy"))).toBe(false);
  });
});

describe("Key ID 持久化", () => {
  it("重启后仅保存并复用作用域内的 ID，不保存登录态或 Token", async () => {
    const values = new Map<string, string>();
    const locationStore = {
      load: async (key: string) => values.get(key) ?? null,
      save: async (key: string, value: string) => {
        values.set(key, value);
      },
      delete: async (key: string) => {
        values.delete(key);
      },
    };
    const request = vi.fn(async (url: string) => {
      if (url.endsWith("getCustomerInfo"))
        return {
          code: 200,
          data: {
            organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
          },
        };
      if (url.endsWith("api_keys"))
        return { code: 200, data: [{ apiKey: "key", name: "zcode-api-key" }] };
      return {
        code: 200,
        data: {
          accessToken: "private-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        },
      };
    });
    const scope = {
      origin: "https://bigmodel.cn",
      family: "bigmodel" as const,
      loginToken: "private-login",
      accountId: "account-a",
    };
    await new ProjectAccessTokenClient({ request, locationStore }).resolve(scope);
    request.mockClear();
    await new ProjectAccessTokenClient({ request, locationStore }).resolve(scope);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toContain("/api_keys/key/access_tokens");
    expect(JSON.stringify([...values])).not.toMatch(/private-token|private-login/);
    await new ProjectAccessTokenClient({ request, locationStore }).resolve({
      ...scope,
      accountId: "account-b",
    });
    expect(values.size).toBe(2);
  });
});

it("持久化 ID 收到明确 404 后重新查找，403 不清除也不自动创建", async () => {
  for (const code of [403, 404]) {
    const values = new Map<string, string>();
    const locationStore = {
      load: async (key: string) => values.get(key) ?? null,
      save: async (key: string, value: string) => {
        values.set(key, value);
      },
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    };
    const f = fixture();
    await new ProjectAccessTokenClient({ request: f.request, locationStore }).resolve(input);
    const request = vi.fn(async () => ({ code }));
    await expect(
      new ProjectAccessTokenClient({ request, locationStore }).resolve(input),
    ).rejects.toThrow("project_token_invalid_response");
    expect(request).toHaveBeenCalledTimes(1);
    expect(locationStore.delete).toHaveBeenCalledTimes(code === 404 ? 1 : 0);
    f.requests.length = 0;
    await new ProjectAccessTokenClient({ request: f.request, locationStore }).resolve(input);
    expect(f.requests.some((r) => r.url.endsWith("/api_keys"))).toBe(code === 404);
    expect(f.requests.some((r) => r.url.includes("/copy/"))).toBe(false);
  }
});
