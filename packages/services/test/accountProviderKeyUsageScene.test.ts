import { describe, expect, it, vi } from "vitest";
import { type ApiClient } from "@zcode/shared";
import { AccountProviderApiClient } from "#src/model-provider/accountProviderApiClient.js";
import { AccountProviderApiKeyResolver } from "#src/model-provider/accountProviderApiKeyResolver.js";
import { resolveAccountTeamPlanRuntimeMaterial } from "#src/model-provider/accountProviderTeamPlanRequestKey.js";

describe.each(["bigmodel", "zai"] as const)("%s Coding Plan Key 用途", (family) => {
  it.each([false, true])(
    "个人已有 Key=%s，创建时明确套餐用途且不改变查询兼容",
    async (existing) => {
      const fixture = createApiFixture(existing, false);
      const remote = new AccountProviderApiClient(fixture.apiClient);
      const resolver = new AccountProviderApiKeyResolver(remote.fetchRemoteData.bind(remote));

      await expect(resolver.resolveProviderMaterial(family, "login-token")).resolves.toMatchObject({
        token: "project-token",
        apiKeyId: "key",
      });
      assertRequests(fixture.requests, existing, false, family);
    },
  );

  it.each([false, true])("团队已有 Key=%s，keyType 与 usageScene 独立", async (existing) => {
    const fixture = createApiFixture(existing, true);
    await expect(
      resolveAccountTeamPlanRuntimeMaterial({
        apiClient: fixture.apiClient,
        credentialService: {
          load: vi.fn(async (key: string) =>
            key === `oauth:${family}:access_token` ? "login-token" : null,
          ),
        },
        access: {
          type: "zhipu-account",
          family,
          planKind: "team-coding-plan",
          organizationId: "org",
          projectId: "project",
          productId: "plan",
        },
      }),
    ).resolves.toMatchObject({ token: "project-token", apiKeyId: "key" });
    assertRequests(fixture.requests, existing, true, family);
  });
});

function createApiFixture(existing: boolean, team: boolean) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const entry = {
    apiKey: "key",
    name: team ? "zcode-team-api-key" : "zcode-api-key",
    keyType: 2,
  };
  const apiClient: ApiClient = {
    async request(input, init) {
      const url = String(input);
      requests.push({ url, init });
      let data: unknown;
      if (url.endsWith("/getCustomerInfo")) {
        data = {
          organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
        };
      } else if (url.endsWith("/api_keys/key/access_tokens")) {
        data = {
          accessToken: "project-token",
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        };
      } else if (url.endsWith("/api_keys")) {
        data = init?.method === "POST" ? entry : existing ? [entry] : [];
      } else throw new Error(`Unexpected URL: ${url}`);
      return new Response(JSON.stringify({ code: 200, data }), {
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { apiClient, requests };
}

function assertRequests(
  requests: Array<{ url: string; init?: RequestInit }>,
  existing: boolean,
  team: boolean,
  family: "bigmodel" | "zai",
) {
  for (const request of requests) {
    const authorization = new Headers(request.init?.headers).get("authorization");
    const expected =
      request.url.endsWith("/access_tokens") ||
      (family === "zai" && (!team || request.url.endsWith("/getCustomerInfo")))
        ? "Bearer login-token"
        : "login-token";
    expect(authorization, request.url).toBe(expected);
  }
  expect(requests.some(({ url }) => url.includes("/copy/"))).toBe(false);
  expect(requests.at(-1)?.url).toMatch(/\/key\/access_tokens$/);
  const creates = requests.filter(
    ({ url, init }) => url.endsWith("/api_keys") && init?.method === "POST",
  );
  expect(creates).toHaveLength(existing ? 0 : 1);
  if (!existing) {
    expect(JSON.parse(String(creates[0]?.init?.body))).toEqual({
      name: team ? "zcode-team-api-key" : "zcode-api-key",
      ...(team ? { keyType: 2 } : {}),
      usageScene: 1,
    });
  }
  const list = requests.find(
    ({ url, init }) => url.endsWith("/api_keys") && init?.method === "GET",
  );
  expect(list).toBeDefined();
  expect(new URL(list!.url).search).toBe("");
}
