import { describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS, ZAI_PROVIDER_ID } from "@zcode/shared";
import { createOAuthProviderLogoutHandler } from "../src/oauth/oauthProviderLogout.js";

function createAccountProviderCredentialStoreStub() {
  return {
    deleteApiKey: vi.fn(async (_credentialKey: string) => undefined),
  };
}

describe("oauthProviderLogout", () => {
  it("新 Provider Runtime 登出后只清理账号凭据并刷新 Account Source", async () => {
    const accountProviderCredentialStore = createAccountProviderCredentialStoreStub();
    const refreshAccountProviders = vi.fn(async () => {});
    const handleLogout = createOAuthProviderLogoutHandler({
      accountProviderCredentialStore,
      refreshAccountProviders,
    });

    await handleLogout(ZAI_PROVIDER_ID, "account-a");

    expect(accountProviderCredentialStore.deleteApiKey).toHaveBeenNthCalledWith(
      1,
      `account-provider:coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan}:account:account-a:api-key`,
    );
    expect(accountProviderCredentialStore.deleteApiKey).toHaveBeenCalledTimes(1);
    expect(refreshAccountProviders).toHaveBeenCalledWith("oauth-logout:zai");
  });
});
