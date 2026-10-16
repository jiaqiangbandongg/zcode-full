import { describe, expect, it, vi } from "vitest";
import { createAccountProviderRequestAuthService } from "../src/model-provider/accountProviderRequestAuthService.js";

function fixture() {
  let login = "login-a";
  let projectId = "project-a";
  let token = "pat-a";
  let duringIssue: (() => void) | undefined;
  const service = createAccountProviderRequestAuthService({
    resolveCurrentAccountAccess: async () => ({
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "team-coding-plan",
      organizationId: "org",
      projectId,
      productId: "product",
    }),
    loadOAuthTokenSet: async () => ({ accessToken: login, zcodeJwtToken: "zcode-jwt" }),
    loadIndividualPlanMaterial: async () => null,
    resolveTeamPlanMaterial: async () => {
      duringIssue?.();
      return { token, apiKeyId: "key-id", organizationId: "org", projectId };
    },
  });
  const input = {
    providerId: "account:bigmodel-off-peak",
    accountAccess: { type: "zhipu-account", accountType: "bigmodel", mode: "off-peak" },
    reason: "off-peak",
  } as const;
  return {
    service,
    input,
    login: () => {
      login = "login-b";
    },
    project: () => {
      projectId = "project-b";
    },
    refresh: () => {
      token = "pat-b";
    },
    race: () => {
      duringIssue = () => {
        projectId = "project-b";
      };
    },
  };
}

describe("闲时请求的账号作用域", () => {
  it.each(["individual-coding-plan", "team-coding-plan"] as const)(
    "%s 普通请求返回作用域；恢复指纹只在核对身份后转交 owner",
    async (planKind) => {
      const individual = vi.fn(async () => ({
        token: "pat",
        apiKeyId: "key-id",
        organizationId: "org",
        projectId: "project",
      }));
      const team = vi.fn(async () => ({
        token: "pat",
        apiKeyId: "key-id",
        organizationId: "org",
        projectId: "project",
      }));
      const service = createAccountProviderRequestAuthService({
        resolveCurrentAccountAccess: async () => ({
          type: "zhipu-account",
          family: "bigmodel",
          planKind,
          organizationId: "org",
          projectId: "project",
          productId: "product",
        }),
        loadOAuthTokenSet: async () => ({ accessToken: "login" }),
        loadIndividualPlanMaterial: individual,
        resolveTeamPlanMaterial: team,
      });
      const input = {
        providerId: "account",
        accountAccess: { type: "zhipu-account", accountType: "bigmodel", mode: planKind },
        reason: "model-request",
      } as const;
      const initial = await service.resolveCurrent(input);
      const fingerprint = "b".repeat(64);
      await service.resolveCurrent({
        ...input,
        expectedAccountScope: initial.accountScope,
        rejectedProjectTokenFingerprint: fingerprint,
      });
      const called = planKind === "individual-coding-plan" ? individual : team;
      expect(called.mock.calls.at(-1)?.at(-1)).toBe(fingerprint);
      await expect(
        service.resolveCurrent({
          ...input,
          expectedAccountScope: "c".repeat(64),
          rejectedProjectTokenFingerprint: fingerprint,
        }),
      ).rejects.toThrow("scope_invalidated");
      await expect(
        service.resolveCurrent({ ...input, rejectedProjectTokenFingerprint: fingerprint }),
      ).rejects.toThrow("scope_invalidated");
      expect(called).toHaveBeenCalledTimes(2);
    },
  );

  it("跨 PAT 刷新保留作用域，不将短期 Token 当作身份", async () => {
    const f = fixture();
    const first = await f.service.resolveCurrent(f.input);
    expect(first.accountScope).toMatch(/^[a-f0-9]{64}$/);
    f.refresh();
    expect(
      await f.service.resolveCurrent({ ...f.input, expectedAccountScope: first.accountScope }),
    ).toEqual({ apiKey: "pat-b", apiKeyId: "key-id", accountScope: first.accountScope });
  });
  it.each(["login", "project", "race"] as const)(
    "%s 变化不能把原票据套在新身份上",
    async (change) => {
      const f = fixture();
      const first = await f.service.resolveCurrent(f.input);
      f[change]();
      await expect(
        f.service.resolveCurrent({ ...f.input, expectedAccountScope: first.accountScope }),
      ).rejects.toThrow("scope");
    },
  );
});
