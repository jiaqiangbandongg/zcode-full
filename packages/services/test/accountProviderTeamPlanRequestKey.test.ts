import { describe, expect, it, vi } from "vitest";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID, type ApiClient } from "@zcode/shared";
import { resolveAccountTeamPlanRuntimeApiKey } from "../src/model-provider/accountProviderTeamPlanRequestKey.js";

describe("accountProviderTeamPlanRequestKey", () => {
  it.each([
    {
      family: "bigmodel" as const,
      oauthProviderId: BIGMODEL_PROVIDER_ID,
    },
    {
      family: "zai" as const,
      oauthProviderId: ZAI_PROVIDER_ID,
    },
  ])("resolves $family Team Plan request key from the selected org/project", async (fixture) => {
    const request = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
        return jsonResponse({
          code: 0,
          data: {
            organizations: [
              {
                organizationId: "org-1",
                projects: [{ projectId: "project-1" }],
              },
            ],
          },
        });
      }
      if (url.endsWith("/api_keys/team-api-key/access_tokens")) {
        return jsonResponse({
          code: 200,
          data: {
            accessToken: "project-token",
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: Date.now() / 1000 + 600,
          },
        });
      }
      if (url.endsWith("/api_keys")) {
        return jsonResponse({
          code: 0,
          data: [
            {
              apiKey: "team-api-key",
              keyType: 2,
              name: "zcode-team-api-key",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    });
    const credentialService = {
      load: vi.fn(async (key: string) =>
        key === `oauth:${fixture.oauthProviderId}:access_token`
          ? `${fixture.family}-oauth-token`
          : null,
      ),
    };

    await expect(
      resolveAccountTeamPlanRuntimeApiKey({
        apiClient: { request } satisfies ApiClient,
        credentialService,
        access: {
          type: "zhipu-account",
          family: fixture.family,
          planKind: "team-coding-plan",
          productId: "product-1",
          organizationId: "org-1",
          projectId: "project-1",
        },
      }),
    ).resolves.toBe("project-token");

    expect(request).toHaveBeenCalledTimes(3);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
