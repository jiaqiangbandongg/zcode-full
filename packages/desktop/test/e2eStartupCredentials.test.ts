import { describe, expect, it } from "vitest";
import { createE2EStartupCredentialSeed } from "./e2e/helpers/e2e-startup-credentials.js";

const restoredOAuthCredentials = {
  "oauth:active_provider": "zai",
  "oauth:zai:access_token": "fake-access-token",
  "oauth:zai:user_info": "{}",
  zcodejwttoken: "fake-zcode-jwt",
};

describe("desktop e2e startup credentials", () => {
  it.each([
    "coding-plan-upgrade-webview-refresh-provider.test.ts",
    "marketing-touch-rewards.test.ts",
  ])("%s 保留本地 Start 余额/请求鉴权所需 JWT", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [spec],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }).zcodejwttoken,
    ).toBe("fake-zcode-jwt");
  });
  it("供应商响应式 spec 保留本地 balance mock 所需的 JWT", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: ["/repo/packages/desktop/test/e2e/provider-family-responsive.test.ts"],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }).zcodejwttoken,
    ).toBe("fake-zcode-jwt");
  });
  it("纯 Provider 冷恢复 spec 不播种会访问账号控制面的假登录态", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-unbound-resume.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it.each([
    "conversation-session-v4-composer-toolbar.test.ts",
    "conversation-session-draft-model-switch-first-send.test.ts",
    "conversation-session-composer-draft-switching.test.ts",
    "conversation-session-ssh-provisioning-failure.test.ts",
  ])("Composer Draft spec %s 不播种无关账号身份", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [`/repo/packages/desktop/test/e2e/conversation-session/${spec}`],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it.each([
    "conversation-session-automation-cron-create.test.ts",
    "conversation-session-fork-merged-assistant.test.ts",
    "conversation-session-goal-run-cases.test.ts",
    "conversation-session-running-guide-steer.test.ts",
    "conversation-session-tool-cross-product.test.ts",
    "conversation-session-v4-fork-edit-branch.test.ts",
  ])("fork/goal/tool spec %s 不播种无关账号身份", (spec) => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [`/repo/packages/desktop/test/e2e/conversation-session/${spec}`],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({});
  });

  it("普通 spec 保留 OAuth 展示态但不注入会触发失效广播的 zcode JWT", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/conversation-session/conversation-session-v4-sendnow.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({
      auth_token: "fake-auth-token",
      "oauth:active_provider": "zai",
      "oauth:zai:access_token": "fake-access-token",
      "oauth:zai:user_info": "{}",
    });
  });

  it("JWT 401 自动退出专项 spec 保留完整 restored OAuth fixture", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: [
          "/repo/packages/desktop/test/e2e/manual-review/pending/jwt-401-auto-logout.test.ts",
        ],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({
      auth_token: "fake-auth-token",
      ...restoredOAuthCredentials,
    });
  });

  it("Start Plan 手动领取 spec 保留调用 claim API 所需的 zcode JWT", () => {
    expect(
      createE2EStartupCredentialSeed({
        specs: ["/repo/packages/desktop/test/e2e/ui-shell/marketing-touch-entitlement.test.ts"],
        legacyAuthToken: "fake-auth-token",
        restoredOAuthCredentials,
      }),
    ).toEqual({
      auth_token: "fake-auth-token",
      ...restoredOAuthCredentials,
    });
  });
});
