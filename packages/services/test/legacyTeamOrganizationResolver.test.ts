import { describe, expect, it, vi } from "vitest";
import {
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  type ApiRequestInit,
} from "@zcode/shared";
import { createLegacyTeamOrganizationResolver } from "../src/model-provider/legacyTeamOrganizationResolver.js";

describe("旧 Team 组织查询", () => {
  it.each(["bigmodel", "zai"] as const)(
    "%s 只用该账号 OAuth GET 用户信息，不申请 API Key",
    async (family) => {
      const request = vi.fn(async (_url: string | URL, _init?: ApiRequestInit) =>
        Response.json({
          code: 200,
          data: {
            organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
          },
        }),
      );
      const load = vi.fn(async () => ({
        accessToken: "oauth-only",
        zcodeJwtToken: "different-jwt",
      }));
      const resolve = createLegacyTeamOrganizationResolver({
        apiClient: { request },
        loadOAuthTokenSet: load,
      });
      expect(await resolve({ family, productId: "product", projectId: "project" })).toBe("org");
      expect(load).toHaveBeenCalledWith(family);
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]).toEqual([
        `${family === "zai" ? resolveZaiBusinessBaseUrl(process.env) : resolveBigModelApiOrigin(process.env)}/api/biz/customer/getCustomerInfo`,
        expect.objectContaining({
          method: "GET",
          headers: { Authorization: "oauth-only", "Content-Type": "application/json" },
        }),
      ]);
    },
  );

  it.each([
    { code: 0, data: { organizations: [] } },
    {
      code: 0,
      data: {
        organizations: [
          { organizationId: "a", projects: [{ projectId: "project" }] },
          { organizationId: "b", projects: [{ projectId: "project" }] },
        ],
      },
    },
    {
      code: 401,
      data: { organizations: [{ organizationId: "a", projects: [{ projectId: "project" }] }] },
    },
  ])("未确认唯一组织不猜测", async (payload) => {
    const resolve = createLegacyTeamOrganizationResolver({
      apiClient: { request: async () => Response.json(payload) },
      loadOAuthTokenSet: async () => ({ accessToken: "oauth" }),
    });
    expect(
      await resolve({ family: "bigmodel", productId: "product", projectId: "project" }),
    ).toBeNull();
  });

  it("网络期间账号凭据变化不采用旧账号结果", async () => {
    let token = "old-account";
    const resolve = createLegacyTeamOrganizationResolver({
      apiClient: {
        request: async () => {
          token = "new-account";
          return Response.json({
            code: 0,
            data: {
              organizations: [{ organizationId: "old-org", projects: [{ projectId: "project" }] }],
            },
          });
        },
      },
      loadOAuthTokenSet: async () => ({ accessToken: token }),
    });
    expect(
      await resolve({ family: "bigmodel", productId: "product", projectId: "project" }),
    ).toBeNull();
  });
});
