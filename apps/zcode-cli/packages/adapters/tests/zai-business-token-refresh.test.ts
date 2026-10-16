import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpClientError, type HttpClientPort } from "@zcode/contracts";
import { createCodingPlanApiKeyResolver } from "../src/auth/coding-plan-api-key.js";

function fixture(options: { jwtTtl?: number; expiresIn?: number; failures?: number[] } = {}) {
  let logins = 0;
  let issues = 0;
  const failures = [...(options.failures ?? [])];
  const request = vi.fn(async (req: { url: string }) => {
    let body: unknown;
    let status = 200;
    if (req.url.endsWith("/api/auth/z/login")) {
      logins++;
      const claims = { exp: Date.now() / 1000 + (options.jwtTtl ?? 600), sub: String(logins) };
      const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
      body = {
        code: 200,
        data: {
          access_token: token,
          ...(options.expiresIn === undefined ? {} : { expires_in: options.expiresIn }),
        },
      };
    } else if (req.url.endsWith("/getCustomerInfo")) {
      body = {
        code: 200,
        data: {
          organizations: [
            {
              organizationId: "org",
              organizationName: "默认机构",
              projects: [{ projectId: "project", projectName: "默认项目" }],
            },
          ],
        },
      };
    } else if (req.url.endsWith("/api_keys")) {
      body = { code: 200, data: [{ apiKey: "key", name: "zcode-api-key" }] };
    } else {
      issues++;
      status = failures.shift() ?? 200;
      body = {
        code: status,
        data: {
          accessToken: `pat-${issues}`,
          tokenType: "Bearer",
          expiresIn: 1,
          expiresAt: Date.now() / 1000 + 1,
        },
      };
    }
    return { status, body: new TextEncoder().encode(JSON.stringify(body)) };
  });
  const resolver = createCodingPlanApiKeyResolver({
    httpClient: { request } as unknown as HttpClientPort,
  });
  const input = { family: "zai", accessToken: "oauth", accountIdentity: "user" } as const;
  return {
    resolve: () => resolver.resolve(input),
    clear: () => resolver.clear(),
    logins: () => logins,
    issues: () => issues,
    request,
  };
}
afterEach(() => vi.useRealTimers());

describe("Z.ai 业务登录 Token 刷新", () => {
  it.each([{ jwtTtl: 600 }, { jwtTtl: 3600, expiresIn: 600 }])(
    "最早 TTL 到刷新窗口后重新交换且并发合并：%j",
    async (options) => {
      vi.useFakeTimers();
      const f = fixture(options);
      await f.resolve();
      vi.setSystemTime(Date.now() + 481_000);
      await Promise.all([f.resolve(), f.resolve(), f.resolve()]);
      expect(f.logins()).toBe(2);
    },
  );
  it("业务 401 只重新交换一次，不重复发送旧业务 JWT", async () => {
    const f = fixture({ failures: [401, 200] });
    await expect(f.resolve()).resolves.toBe("pat-2");
    expect(f.logins()).toBe(2);
  });
  it("连续 401 有限失败，下次调用不永久粘住旧业务 JWT", async () => {
    const f = fixture({ failures: [401, 401, 200] });
    await expect(f.resolve()).rejects.toThrow("project_token_request_failed");
    expect(f.logins()).toBe(2);
    await expect(f.resolve()).resolves.toBe("pat-3");
    expect(f.logins()).toBe(3);
  });
  it.each([403, 500])("%s 不触发重新交换", async (status) => {
    const f = fixture({ failures: [status] });
    await expect(f.resolve()).rejects.toThrow();
    expect(f.logins()).toBe(1);
    expect(f.issues()).toBe(1);
  });
});

it("并发业务 401 合并重新交换，所有调用都能恢复", async () => {
  const f = fixture({ failures: [401, 200] });
  await expect(Promise.all([f.resolve(), f.resolve(), f.resolve()])).resolves.toEqual([
    "pat-2",
    "pat-2",
    "pat-2",
  ]);
  expect(f.logins()).toBe(2);
});

it.each([
  "network_error",
  "timeout",
  "cancelled",
  "egress_blocked",
  "invalid",
  "unknown",
  429,
  503,
  401,
  403,
  404,
] as const)("业务 JWT 提前刷新 %s 的分类、日志、退避和原有效期边界", async (failure) => {
  vi.useFakeTimers();
  const start = Date.now();
  let logins = 0;
  let recovered = false;
  const request = vi.fn(async ({ url }: { url: string }) => {
    let data: unknown;
    if (url.endsWith("/api/auth/z/login")) {
      logins++;
      if (logins > 1 && !recovered) {
        if (failure === "invalid")
          return { status: 200, body: new TextEncoder().encode("invalid secret JSON") };
        if (failure === "unknown") throw new Error("secret failure");
        if (typeof failure === "string")
          throw createHttpClientError({ code: failure, message: "secret failure" });
        return { status: failure, body: new TextEncoder().encode("secret failure") };
      }
      data = { access_token: `business-jwt-${logins}`, expires_in: 600 };
    } else if (url.endsWith("getCustomerInfo")) {
      data = { organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] };
    } else if (url.endsWith("api_keys")) {
      data = [{ apiKey: "key", name: "zcode-api-key" }];
    } else {
      data = {
        accessToken: "valid-pat",
        tokenType: "Bearer",
        expiresIn: 1800,
        expiresAt: start / 1000 + 1800,
      };
    }
    return { status: 200, body: new TextEncoder().encode(JSON.stringify({ code: 200, data })) };
  });
  const observe = vi.fn();
  const resolver = createCodingPlanApiKeyResolver({
    httpClient: { request } as unknown as HttpClientPort,
    observe,
  });
  const input = { family: "zai", accessToken: "oauth", accountIdentity: "user" } as const;
  await expect(resolver.resolve(input)).resolves.toBe("valid-pat");
  vi.setSystemTime(start + 481_000);
  if (["network_error", "timeout", 429, 503].includes(failure)) {
    await expect(Promise.all([resolver.resolve(input), resolver.resolve(input)])).resolves.toEqual([
      "valid-pat",
      "valid-pat",
    ]);
    await resolver.resolve(input);
    expect(logins).toBe(2);
    expect(observe).toHaveBeenCalledExactlyOnceWith({
      family: "zai",
      stage: "resolve",
      code: "project_token_business_login_refresh_deferred",
    });
    // 业务 JWT 到期后即使 PAT 仍有效，也不能把临时故障当作成功。
    vi.setSystemTime(start + 600_000);
  }
  await expect(resolver.resolve(input)).rejects.toThrow("project_token_login_failed");
  recovered = true;
  await expect(resolver.resolve(input)).resolves.toBe("valid-pat");
  expect(JSON.stringify(observe.mock.calls)).not.toMatch(/secret|business-jwt|valid-pat|oauth/);
});
