import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountProjectTokenClient } from "../src/model-provider/accountProjectTokenClient.js";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";
import { CREDENTIAL_DECRYPT_ERROR_CODE } from "@zcode/shared";

afterEach(() => vi.useRealTimers());

describe("项目位置缓存恢复", () => {
  function fixture(saved: string | null = null) {
    const unreadable = Object.assign(new Error("unreadable"), {
      code: CREDENTIAL_DECRYPT_ERROR_CODE,
    });
    const recoverUnreadable = vi.fn(async (_key: string, assertCurrent: () => void) => {
      assertCurrent();
      return saved;
    });
    const request = vi.fn(async (url: string) => {
      const data = url.endsWith("getCustomerInfo")
        ? { organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] }
        : url.endsWith("api_keys")
          ? [{ apiKey: "key", name: "zcode-api-key" }]
          : {
              accessToken: "pat",
              tokenType: "Bearer",
              expiresIn: 600,
              expiresAt: Date.now() / 1000 + 600,
            };
      return Response.json({ code: 200, data });
    });
    const store = {
      load: vi.fn(async (): Promise<string | null> => {
        throw unreadable;
      }),
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      recoverUnreadable,
    };
    const client = createAccountProjectTokenClient({ request }, store);
    const input = {
      family: "bigmodel" as const,
      origin: "https://example.com",
      accountId: "user",
      loginToken: "login",
    };
    return { client, input, store, request, unreadable };
  }

  it("损坏位置只重建一次，并发解析共享定位与签发", async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 3 }, () => f.client.resolve(f.input)));
    expect(results.map((r) => r.token)).toEqual(["pat", "pat", "pat"]);
    expect(f.store.recoverUnreadable).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.store.save).toHaveBeenCalledTimes(1);
    expect(f.store.save).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Function),
    );
    expect(f.store.delete).not.toHaveBeenCalled();
  });

  it("其他写入已经修复时复用位置，不重复查找或写入", async () => {
    const f = fixture(
      JSON.stringify({ organizationId: "org", projectId: "project", apiKeyId: "key" }),
    );
    await expect(f.client.resolve(f.input)).resolves.toMatchObject({ token: "pat" });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.store.save).not.toHaveBeenCalled();
  });

  it("重建遇到 503 不在本次解析重试，不写位置或清理其他凭据", async () => {
    const f = fixture();
    f.request.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(f.client.resolve(f.input)).rejects.toThrow("project_token_request_failed");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.store.save).not.toHaveBeenCalled();
    expect(f.store.delete).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "unknown"])("普通读取错误 %s 不进入缓存恢复", async (code) => {
    const f = fixture();
    f.store.load.mockRejectedValue(Object.assign(new Error("read failed"), { code }));
    await expect(f.client.resolve(f.input)).rejects.toThrow("project_token_request_failed");
    expect(f.store.recoverUnreadable).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("恢复端口错误直接失败，不继续请求", async () => {
    const f = fixture();
    f.store.recoverUnreadable.mockRejectedValue(new Error("write failed"));
    await expect(f.client.resolve(f.input)).rejects.toThrow("project_token_request_failed");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("404 清理也携带提交前代次检查", async () => {
    const f = fixture(
      JSON.stringify({ organizationId: "org", projectId: "project", apiKeyId: "key" }),
    );
    f.request.mockResolvedValue(new Response("{}", { status: 404 }));
    await expect(f.client.resolve(f.input)).rejects.toThrow("project_token_invalid_response");
    expect(f.store.delete).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
  });

  it("clear 后迟到的解密失败不调用恢复", async () => {
    const f = fixture();
    let reject!: (error: unknown) => void;
    f.store.load.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = f.client.resolve(f.input);
    await Promise.resolve();
    f.client.clear();
    reject(f.unreadable);
    await expect(pending).rejects.toThrow("project_token_scope_invalidated");
    expect(f.store.recoverUnreadable).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("恢复等待期间 clear，存储提交前检查必须拒绝旧任务", async () => {
    const f = fixture();
    let commit!: () => void;
    f.store.recoverUnreadable.mockImplementation(
      (_key, assertCurrent) =>
        new Promise((resolve, reject) => {
          commit = () => {
            try {
              assertCurrent();
              resolve(null);
            } catch (error) {
              reject(error);
            }
          };
        }),
    );
    const pending = f.client.resolve(f.input);
    await vi.waitFor(() => expect(commit).toBeDefined());
    f.client.clear();
    commit();
    await expect(pending).rejects.toThrow("project_token_scope_invalidated");
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe("Desktop PAT 临时故障分类", () => {
  it.each(["network", "timeout", 429, 503, 401, 403, 404, "invalid", "unknown"])(
    "%s 只在允许范围内复用未过期 PAT",
    async (failure) => {
      vi.useFakeTimers();
      const start = Date.now();
      let issues = 0;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        let data: unknown;
        if (url.endsWith("getCustomerInfo"))
          data = {
            organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
          };
        else if (url.endsWith("api_keys")) data = [{ apiKey: "key", name: "zcode-api-key" }];
        else {
          issues++;
          if (issues > 1) {
            if (failure === "network") throw new TypeError("fetch failed: secret must not escape");
            if (failure === "timeout") throw new DOMException("timeout", "AbortError");
            if (failure === "unknown") throw new Error("unknown secret");
            if (failure === "invalid") return new Response("invalid secret JSON");
            return new Response("upstream secret", { status: failure });
          }
          data = {
            accessToken: "old-pat",
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: start / 1000 + 600,
          };
        }
        return Response.json({ code: "0", data });
      });
      const values = new Map<string, string>();
      const client = createAccountProjectTokenClient(createNodeApiClient({ fetchImpl }), {
        load: async (key) => values.get(key) ?? null,
        save: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      });
      const input = {
        family: "bigmodel" as const,
        origin: "https://example.invalid",
        accountId: "user",
        loginToken: "login",
      };
      await expect(client.resolve(input)).resolves.toMatchObject({ token: "old-pat" });
      vi.setSystemTime(start + 481_000);
      if (["network", "timeout", 429, 503].includes(failure)) {
        const results = await Promise.all([client.resolve(input), client.resolve(input)]);
        expect(results.map((value) => value.token)).toEqual(["old-pat", "old-pat"]);
        await client.resolve(input);
        expect(issues).toBe(2);
        vi.setSystemTime(start + 600_000);
      }
      await expect(client.resolve(input)).rejects.toThrow(
        /^project_token_(request_failed|invalid_response)$/,
      );
      expect(JSON.stringify([...values])).not.toMatch(/old-pat|login/);
    },
  );
});
