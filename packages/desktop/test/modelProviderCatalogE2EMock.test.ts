import { describe, expect, it } from "vitest";
import {
  resolveSubagentLoginCatalogConfigVersion,
  resolveSubagentLoginCatalogPayload,
  SUBAGENT_LOGIN_CATALOG_POST_LOGIN_CONFIG_VERSION,
  SUBAGENT_LOGIN_CATALOG_PRE_LOGIN_CONFIG_VERSION,
} from "./e2e/helpers/model-provider-catalog-mock-server.js";

describe("model provider catalog E2E mock", () => {
  it("keeps the login catalog immutable for each config version", () => {
    expect(resolveSubagentLoginCatalogConfigVersion(false)).toBe(
      SUBAGENT_LOGIN_CATALOG_PRE_LOGIN_CONFIG_VERSION,
    );
    expect(resolveSubagentLoginCatalogConfigVersion(true)).toBe(
      SUBAGENT_LOGIN_CATALOG_POST_LOGIN_CONFIG_VERSION,
    );
    expect(SUBAGENT_LOGIN_CATALOG_PRE_LOGIN_CONFIG_VERSION).not.toBe(
      SUBAGENT_LOGIN_CATALOG_POST_LOGIN_CONFIG_VERSION,
    );

    const preLoginCatalog = resolveSubagentLoginCatalogPayload({
      configVersion: SUBAGENT_LOGIN_CATALOG_PRE_LOGIN_CONFIG_VERSION,
      oauthTokenIssued: false,
    });
    const samePreLoginVersionAfterOAuth = resolveSubagentLoginCatalogPayload({
      configVersion: SUBAGENT_LOGIN_CATALOG_PRE_LOGIN_CONFIG_VERSION,
      oauthTokenIssued: true,
    });
    const postLoginCatalog = resolveSubagentLoginCatalogPayload({
      configVersion: SUBAGENT_LOGIN_CATALOG_POST_LOGIN_CONFIG_VERSION,
      oauthTokenIssued: true,
    });

    expect(samePreLoginVersionAfterOAuth).toEqual(preLoginCatalog);
    expect(
      preLoginCatalog.data.builtinProviders.some(
        (provider) => provider.id === "account:bigmodel-individual-coding-plan",
      ),
    ).toBe(false);
    expect(
      postLoginCatalog.data.builtinProviders.some(
        (provider) => provider.id === "account:bigmodel-individual-coding-plan",
      ),
    ).toBe(true);
  });
});
