import { readFile, writeFile } from "node:fs/promises";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  clearAppData,
  getE2EAppDataPaths,
  DEFAULT_WORKSPACE,
  readModelProvider,
  seedCredentials,
  seedSettings,
  waitForWorkspaceApp,
} from "../../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../../helpers/occupation-onboarding.js";
import {
  waitForCodingPlanUpgradeMockRequest,
  readCodingPlanUpgradeMockRequests,
} from "../../helpers/coding-plan-upgrade-webview.js";

// 复用已有账号 mock 数据；没有目标名称 Key，由真实 Host resolver 发起创建。
describe("PAT-KEY-E2E: 账号就绪时创建 Coding Plan Key", () => {
  afterEach(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BigModel 创建 Key 显式声明套餐用途，凭据不写入个人配置", async function () {
    this.timeout(90000);
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await assertCreation("e2e-bigmodel-oauth-token");
    expect(
      (await readModelProvider(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan))?.apiKey ??
        "",
    ).toBe("");
  });

  it("Z.AI 旧 Key 损坏但 OAuth 有效，重启直接换 Token 不要求重登", async function () {
    this.timeout(90000);
    await seedCredentials("zai-webview-oauth-token");
    const { credentialsFile } = getE2EAppDataPaths();
    const credentials = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<
      string,
      string
    >;
    const profile = JSON.parse(credentials["oauth:zai:user_info"]!) as { id: string };
    const legacyKey = `account-provider:coding-plan:${BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan}:account:${encodeURIComponent(profile.id)}:api-key`;
    credentials[legacyKey] = "enc:v1:broken-legacy-key";
    await writeFile(credentialsFile, JSON.stringify(credentials), "utf8");
    await seedSettings({
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" },
        bigmodel: { kind: "individual-coding-plan" },
      },
      providerFamilyDomain: "zai",
      providerFamilyDomainMigrated: true,
      lastWorkspaceSession: [
        {
          kind: "local",
          workspacePath: DEFAULT_WORKSPACE,
          workspacePurpose: "project",
        },
      ],
      lastActiveTabIndex: 0,
    });
    await browser.reloadSession();
    await skipOccupationOnboardingIfPresent();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
    await assertCreation("Bearer zai-webview-oauth-token");
    const restored = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<string, string>;
    expect(restored[legacyKey]).toBe("enc:v1:broken-legacy-key");
    expect(restored["oauth:zai:access_token"]).toBe(credentials["oauth:zai:access_token"]);
    expect(
      (await readModelProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan))?.apiKey ?? "",
    ).toBe("");
  });
});

async function assertCreation(authorization: string) {
  await waitForCodingPlanUpgradeMockRequest(
    (request) =>
      request.method === "POST" &&
      request.path.endsWith("/organization/org-e2e/projects/proj-e2e/api_keys") &&
      request.headers.authorization === authorization &&
      request.keyCreation?.name === "zcode-api-key" &&
      request.keyCreation.usageScene === 1,
    "真实 Host 没有创建 usageScene=1 的套餐 Key",
  );
  await assertTokenIssuance(`Bearer ${authorization.replace(/^Bearer\s+/i, "")}`);
}

async function assertTokenIssuance(authorization: string) {
  await waitForCodingPlanUpgradeMockRequest(
    (request) =>
      request.method === "POST" &&
      request.path.endsWith("/access_tokens") &&
      request.headers.authorization === authorization,
    "Host 未使用登录 JWT 换取 Project Token",
  );
  const result = await readCodingPlanUpgradeMockRequests();
  expect(result.requests.some((request) => request.path.includes("/api_keys/copy/"))).toBe(false);
}
