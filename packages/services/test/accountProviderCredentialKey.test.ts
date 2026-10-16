import { describe, expect, it } from "vitest";
import { accountProviderCredentialKey } from "../src/model-provider/accountProviderCredentialKey.js";

describe("accountProviderCredentialKey", () => {
  it("只在 Services Credential Store 边界生成账号隔离键", () => {
    expect(
      accountProviderCredentialKey({
        providerId: "account:zai-individual-coding-plan",
        planKind: "individual-coding-plan",
        accountIdentity: "account:a/b",
      }),
    ).toBe(
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:account%3Aa%2Fb:api-key",
    );
  });

  it("Team 连接把完整 scope 编入私有键", () => {
    expect(
      accountProviderCredentialKey({
        providerId: "account:bigmodel-team-coding-plan",
        planKind: "team-coding-plan",
        productId: "product",
        organizationId: "org",
        projectId: "project",
        accountIdentity: "account-a",
      }),
    ).toBe(
      "account-provider:team:account%3Abigmodel-team-coding-plan:product:org:project:account:account-a:api-key",
    );
  });
});
