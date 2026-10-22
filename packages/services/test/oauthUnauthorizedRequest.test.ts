import { describe, expect, it, vi } from "vitest";
import {
  isCurrentOAuthCredentialRequest,
  isOAuthBusinessRequest,
  resolveOAuthBusinessCredentialValidationRequest,
} from "#src/oauth/oauthUnauthorizedRequest.js";
import { createNodeApiClient } from "#src/providers/api/nodeApiClient.js";
import {
  createBigModelLoginAuthHeaders,
  createZaiLoginAuthHeaders,
} from "#src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";

function createFixture(provider = "zai", env: NodeJS.ProcessEnv = { ZCODE_ENV: "production" }) {
  const credentials = new Map([
    ["oauth:active_provider", provider],
    ["oauth:zai:access_token", "zai-business-token"],
    ["oauth:bigmodel:access_token", "bigmodel-business-token"],
    ["zcodejwttoken", "current-zcode-jwt"],
  ]);
  const credentialService = { load: vi.fn(async (key: string) => credentials.get(key) ?? null) };
  const observe = (url: string | URL, headers: Headers) =>
    isCurrentOAuthCredentialRequest({ input: url, headers, credentialService, env });
  const observeBusiness = (url: string | URL, _headers: Headers) =>
    isOAuthBusinessRequest({ input: url, credentialService, env });
  const notified = vi.fn();
  const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
  const client = createNodeApiClient({
    fetchImpl,
    isZcodeJwtRequest: observe,
    isBusinessUnauthorizedRequest: observeBusiness,
    resolveBusinessCredentialValidationRequest: (input, headers) =>
      resolveOAuthBusinessCredentialValidationRequest({ input, headers, credentialService, env }),
    onZcodeJwtInvalid: notified,
  });
  return { credentials, credentialService, observe, notified, fetchImpl, client };
}

describe("当前 App 登录凭据的 HTTP 401 识别", () => {
  it.each(["bigmodel", "zai"])("%s 身份核验与既有裸 token helper 保持一致", async (provider) => {
    const f = createFixture(provider);
    const token = `${provider}-business-token`;
    const origin = provider === "bigmodel" ? "https://bigmodel.cn" : "https://api.z.ai";
    const expected =
      provider === "bigmodel"
        ? createBigModelLoginAuthHeaders(token)
        : createZaiLoginAuthHeaders(token);
    for (const prefix of ["", "Bearer "]) {
      const check = await resolveOAuthBusinessCredentialValidationRequest({
        input: origin + "/api/biz/subscription/enterprise/v2/pricing",
        headers: new Headers({ Authorization: prefix + token }),
        credentialService: f.credentialService,
      });
      expect(check?.authorization).toBe(expected.Authorization);
    }
  });
  it.each(["bigmodel", "zai"])(
    "%s PAT/支付使用当前业务 token 的明确401均识别",
    async (provider) => {
      const f = createFixture(provider),
        origin = provider === "bigmodel" ? "https://bigmodel.cn" : "https://api.z.ai";
      for (const path of [
        "/api/biz/v1/organization/org/projects/project/api_keys/key/access_tokens",
        "/api/biz/pay/preview",
        "/api/pay/stripe/pay",
      ]) {
        await f.client.request(origin + path, {
          headers: { Authorization: `Bearer ${provider}-business-token` },
        });
      }
      expect(f.notified).toHaveBeenCalledTimes(3);
    },
  );

  it("BigModel 身份空200确认失效，ZAI 空200不作同样推断", async () => {
    for (const provider of ["bigmodel", "zai"]) {
      const f = createFixture(provider),
        origin = provider === "bigmodel" ? "https://bigmodel.cn" : "https://api.z.ai";
      f.fetchImpl.mockResolvedValueOnce(new Response(""));
      await f.client.request(origin + "/api/biz/customer/getCustomerInfo", {
        headers: { Authorization: provider + "-business-token" },
      });
      expect(f.notified.mock.calls.length).toBe(provider === "bigmodel" ? 1 : 0);
      expect(f.fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it("核验材料构造期间切换平台，不把旧 token 发往新平台", async () => {
    const f = createFixture("bigmodel");
    let reads = 0;
    f.credentialService.load.mockImplementation(async (key) => {
      const value = f.credentials.get(key) ?? null;
      if (key === "oauth:active_provider" && ++reads === 3) f.credentials.set(key, "zai");
      return value;
    });
    const request = await resolveOAuthBusinessCredentialValidationRequest({
      input: "https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing",
      headers: new Headers({ Authorization: "bigmodel-business-token" }),
      credentialService: f.credentialService,
    });
    expect(request).toBeNull();
  });
  it.each([
    ["bigmodel", "https://bigmodel.cn/api/biz/customer/getCustomerInfo"],
    ["zai", "https://api.z.ai/api/biz/customer/getCustomerInfo"],
    ["zai", "https://chat.z.ai/api/oauth/userinfo"],
    ["bigmodel", "https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing"],
    ["zai", "https://api.z.ai/api/biz/subscription/enterprise/v2/pricing"],
    ["bigmodel", "https://bigmodel.cn/api/biz/team/subscribe/product/querySubscribeDetail"],
    ["zai", "https://api.z.ai/api/biz/team/subscribe/product/querySubscribeDetail"],
  ])("%s 用户/团队查询兼容裸 token 与 Bearer", async (provider, url) => {
    const fixture = createFixture(provider);
    for (const prefix of ["", "Bearer "]) {
      const response = await fixture.client.request(new URL(`${url}?source=e2e`), {
        headers: { Authorization: `${prefix}${provider}-business-token` },
      });
      expect(response.status).toBe(401);
    }
    expect(fixture.notified).toHaveBeenCalledTimes(2);
  });

  it.each([
    "https://api.z.ai/api/anthropic/v1/messages",
    "https://untrusted.example/api/biz/customer/getCustomerInfo",
    "https://api.z.ai.evil.example/api/biz/customer/getCustomerInfo",
  ])("不扩散至模型接口、错误域名/环境或非业务路径：%s", async (url) => {
    const fixture = createFixture();
    await fixture.client.request(url, { headers: { Authorization: "Bearer zai-business-token" } });
    expect(fixture.notified).not.toHaveBeenCalled();
  });

  it.each(["", "old-zai-token", "model-api-key", "Bearer model-api-key"])(
    "目标接口的匿名/旧凭据/API key 不退出：%s",
    async (authorization) => {
      const fixture = createFixture();
      await fixture.client.request("https://api.z.ai/api/biz/customer/getCustomerInfo", {
        headers: { Authorization: authorization },
      });
      expect(fixture.notified).not.toHaveBeenCalled();
    },
  );

  it("非 active 平台的残留 access token 不退出当前登录", async () => {
    const fixture = createFixture("bigmodel");
    await fixture.client.request("https://api.z.ai/api/biz/customer/getCustomerInfo", {
      headers: { Authorization: "zai-business-token" },
    });
    expect(fixture.notified).not.toHaveBeenCalled();
  });

  it.each(["token", "provider"])("401 返回前已更新 %s 时忽略旧请求", async (change) => {
    const fixture = createFixture();
    let complete!: (response: Response) => void;
    fixture.fetchImpl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const request = fixture.client.request("https://api.z.ai/api/biz/customer/getCustomerInfo", {
      headers: { Authorization: "zai-business-token" },
    });
    if (change === "token") fixture.credentials.set("oauth:zai:access_token", "new-token");
    else fixture.credentials.set("oauth:active_provider", "bigmodel");
    complete(new Response("", { status: 401 }));
    await request;
    expect(fixture.notified).not.toHaveBeenCalled();
  });

  it("读取 access token 期间切换平台，不使用跨平台读取快照", async () => {
    const fixture = createFixture();
    fixture.credentialService.load.mockImplementation(async (key) => {
      const value = fixture.credentials.get(key) ?? null;
      if (key === "oauth:zai:access_token")
        fixture.credentials.set("oauth:active_provider", "bigmodel");
      return value;
    });
    await fixture.client.request("https://api.z.ai/api/biz/customer/getCustomerInfo", {
      headers: { Authorization: "zai-business-token" },
    });
    expect(fixture.notified).not.toHaveBeenCalled();
  });

  it("HTTP 500 不因业务正文提示过期而登出", async () => {
    const fixture = createFixture();
    fixture.fetchImpl.mockResolvedValueOnce(
      new Response('{"code":401,"msg":"token expired"}', { status: 500 }),
    );
    await fixture.client.request("https://api.z.ai/api/biz/customer/getCustomerInfo", {
      headers: { Authorization: "zai-business-token" },
    });
    expect(fixture.notified).not.toHaveBeenCalled();
  });

  it.each([
    ["bigmodel", 200],
    ["bigmodel", 403],
    ["zai", 200],
    ["zai", 403],
  ] as const)("%s HTTP %i 的三个接口业务 401 均通知失效", async (provider, status) => {
    const fixture = createFixture(provider);
    const origin = provider === "bigmodel" ? "https://bigmodel.cn" : "https://api.z.ai";
    for (const path of [
      "/api/biz/customer/getCustomerInfo",
      "/api/biz/subscription/enterprise/v2/pricing",
      "/api/biz/team/subscribe/product/querySubscribeDetail",
    ]) {
      fixture.fetchImpl.mockResolvedValueOnce(
        Response.json({ code: 401, msg: "登录状态已过期", success: false }, { status }),
      );
      const response = await fixture.client.request(`${origin}${path}`, {
        headers: { Authorization: `${provider}-business-token` },
      });
      expect(await response.json()).toMatchObject({ code: 401 });
    }
    expect(fixture.notified).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["https://api.z.ai/api/biz/customer/getCustomerInfo", "old-token"],
    ["https://api.z.ai/api/biz/subscription/enterprise/v2/pricing", "model-api-key"],
    [
      "https://untrusted.example/api/biz/team/subscribe/product/querySubscribeDetail",
      "zai-business-token",
    ],
    ["https://bigmodel.cn/api/biz/customer/getCustomerInfo", "bigmodel-business-token"],
  ])("业务 401 不扩散到旧凭据、非 active 平台或白名单外：%s", async (url, authorization) => {
    const fixture = createFixture();
    fixture.fetchImpl.mockResolvedValueOnce(Response.json({ code: 401, success: false }));
    await fixture.client.request(url, { headers: { Authorization: authorization } });
    expect(fixture.notified).not.toHaveBeenCalled();
  });

  it("保留原 ZCode JWT 401 判断", async () => {
    const fixture = createFixture();
    await fixture.client.request("https://zcode.z.ai/api/v1/zcode-plan/billing/balance", {
      headers: { Authorization: "Bearer current-zcode-jwt" },
    });
    expect(fixture.notified).toHaveBeenCalledOnce();
  });

  it("按当前环境和显式 userinfo 配置匹配，不硬编码生产域名", async () => {
    const fixture = createFixture("bigmodel", {
      ZCODE_ENV: "test",
      BIGMODEL_OAUTH_USERINFO_URL: "http://127.0.0.1:18080/custom/userinfo",
    });
    for (const url of [
      "https://bigmodel.cn/api/biz/customer/getCustomerInfo",
      "http://127.0.0.1:18080/custom/userinfo",
    ]) {
      await fixture.client.request(url, { headers: { Authorization: "bigmodel-business-token" } });
    }
    expect(fixture.notified).toHaveBeenCalledTimes(2);
  });

  describe.each([
    [
      "bigmodel",
      "BIGMODEL_API_BASE_URL",
      "BIGMODEL_OAUTH_USERINFO_URL",
      "https://bigmodel.cn/api/biz/customer/getCustomerInfo",
    ],
    [
      "zai",
      "ZAI_BUSINESS_BASE_URL",
      "ZAI_OAUTH_USERINFO_URL",
      "https://api.z.ai/api/biz/customer/getCustomerInfo",
    ],
  ])("%s URL 配置边界", (provider, baseKey, userinfoKey, customerInfoUrl) => {
    it.each(["production", "test"])("%s 环境仅识别当前配置的身份接口", async (environment) => {
      // 原用例依赖真实测试域名与生产域名不同，导出地址改写后会把否定用例变成肯定用例。
      // 用独立示例域名注入两套环境，开闭源保留相同的 origin 隔离断言。
      const currentOrigin = `https://${environment}.example`;
      const otherOrigin = `https://${environment === "test" ? "production" : "test"}.example`;
      const fixture = createFixture(provider, {
        ZCODE_ENV: environment,
        [baseKey]: currentOrigin,
        [userinfoKey]: `${currentOrigin}/userinfo`,
      });
      const headers = { Authorization: `Bearer ${provider}-business-token` };
      for (const path of ["/api/biz/customer/getCustomerInfo", "/userinfo"]) {
        const response = await fixture.client.request(`${otherOrigin}${path}`, { headers });
        expect(response.status).toBe(401);
      }
      expect(fixture.notified).not.toHaveBeenCalled();
      for (const path of ["/api/biz/customer/getCustomerInfo", "/userinfo"]) {
        const response = await fixture.client.request(`${currentOrigin}${path}`, { headers });
        expect(response.status).toBe(401);
      }
      expect(fixture.notified).toHaveBeenCalledTimes(2);
    });

    it.each(["not a URL", "/relative/userinfo", "file:///userinfo"])(
      "无效 userinfo %s 不影响有效 customerInfo 的 401",
      async (userinfo) => {
        const fixture = createFixture(provider, {
          ZCODE_ENV: "production",
          [userinfoKey]: userinfo,
        });
        await expect(
          fixture.observe(
            customerInfoUrl,
            new Headers({ Authorization: `${provider}-business-token` }),
          ),
        ).resolves.toBe(true);
        const response = await fixture.client.request(customerInfoUrl, {
          headers: { Authorization: `${provider}-business-token` },
        });
        expect(response.status).toBe(401);
        expect(fixture.notified).toHaveBeenCalledOnce();
      },
    );

    it.each(["not a URL", "/relative/base", "file:///base"])(
      "无效业务 base %s 不影响显式 userinfo 的 401",
      async (base) => {
        const userinfo = "https://userinfo.example/current";
        const fixture = createFixture(provider, {
          ZCODE_ENV: "production",
          [baseKey]: base,
          [userinfoKey]: userinfo,
        });
        await expect(
          fixture.observe(
            userinfo,
            new Headers({ Authorization: `Bearer ${provider}-business-token` }),
          ),
        ).resolves.toBe(true);
        const response = await fixture.client.request(userinfo, {
          headers: { Authorization: `Bearer ${provider}-business-token` },
        });
        expect(response.status).toBe(401);
        expect(fixture.notified).toHaveBeenCalledOnce();
      },
    );

    it.each(["", "   "])("空白 override %j 保留默认地址", async (blank) => {
      const fixture = createFixture(provider, {
        ZCODE_ENV: "production",
        [baseKey]: blank,
        [userinfoKey]: blank,
      });
      const url = provider === "zai" ? "https://chat.z.ai/api/oauth/userinfo" : customerInfoUrl;
      await expect(
        fixture.observe(url, new Headers({ Authorization: `${provider}-business-token` })),
      ).resolves.toBe(true);
    });

    it("全部候选非法时返回 false，不吞掉 HTTP 响应", async () => {
      const fixture = createFixture(provider, {
        ZCODE_ENV: "production",
        [baseKey]: "invalid",
        [userinfoKey]: "/userinfo",
      });
      await expect(
        fixture.observe(
          customerInfoUrl,
          new Headers({ Authorization: `${provider}-business-token` }),
        ),
      ).resolves.toBe(false);
      const response = await fixture.client.request(customerInfoUrl, {
        headers: { Authorization: `${provider}-business-token` },
      });
      expect(response.status).toBe(401);
      expect(fixture.notified).not.toHaveBeenCalled();
    });
  });

  it("ZAI 业务 base 异常时仍匹配默认 OAuth userinfo", async () => {
    const fixture = createFixture("zai", {
      ZCODE_ENV: "production",
      ZAI_BUSINESS_BASE_URL: "invalid",
    });
    await expect(
      fixture.observe(
        "https://chat.z.ai/api/oauth/userinfo",
        new Headers({ Authorization: "zai-business-token" }),
      ),
    ).resolves.toBe(true);
  });

  it.each(["", "/relative/userinfo", "not a URL", "file:///userinfo"])(
    "非法 access token 请求地址 %j 不抛错",
    async (url) => {
      const fixture = createFixture();
      await expect(
        fixture.observe(url, new Headers({ Authorization: "zai-business-token" })),
      ).resolves.toBe(false);
    },
  );

  it("userinfo 分类不受无关的 ZCode base 配置异常影响", async () => {
    const fixture = createFixture("zai", { ZCODE_ENV: "production", ZCODE_BASE_URL: "invalid" });
    await expect(
      fixture.observe(
        "https://chat.z.ai/api/oauth/userinfo",
        new Headers({ Authorization: "zai-business-token" }),
      ),
    ).resolves.toBe(true);
  });

  it("URL 配置异常不影响原 JWT 分支", async () => {
    const fixture = createFixture("zai", {
      ZCODE_ENV: "production",
      ZAI_BUSINESS_BASE_URL: "invalid",
      ZAI_OAUTH_USERINFO_URL: "invalid",
    });
    await expect(
      fixture.observe(
        "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
        new Headers({ Authorization: "Bearer current-zcode-jwt" }),
      ),
    ).resolves.toBe(true);
  });
});
