import { BUILTIN_MODEL_PROVIDER_IDS, TID_LOGIN_TRIGGER } from "@zcode/shared";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  readModelProvider,
  seedCredentials,
  seedSettings,
  waitForWorkspaceApp,
} from "./helpers/desktop-app.js";
import {
  openBigModelCodingPlanPersonalUpgradePanel,
  openZaiCodingPlanPersonalUpgradePanel,
} from "./helpers/coding-plan-upgrade.js";
import {
  readCodingPlanWebviewLocalStorage,
  triggerCodingPlanWebviewPurchaseComplete,
  waitForCodingPlanUpgradeMockRequest,
  waitForCodingPlanWebviewClosed,
  waitForCodingPlanWebviewDisplayed,
} from "./helpers/coding-plan-upgrade-webview.js";

describe("BigModel Coding Plan 官网 webview 支付完成 E2E", () => {
  afterEach(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CPUW-01: webview 通知 App 关闭升级弹窗并刷新当前 provider", async function () {
    this.timeout(120000);

    const setInventoryMode = async (mode: "hold" | "fail" | "ready") => {
      const base =
        process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL ??
        process.env.BIGMODEL_TEST_API_BASE_URL;
      if (!base) throw new Error("Missing mock URL");
      const response = await fetch(`${base}/__e2e/coding-plan/inventory-mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      expect(response.ok).toBe(true);
    };
    await setInventoryMode("hold");
    await browser.refresh();
    const telemetryFetch = await browser.electron.mock("net", "fetch");
    await telemetryFetch.mockResolvedValue({ ok: true, status: 204 });
    await openBigModelCodingPlanPersonalUpgradePanel(async () => {
      const entry = () => $('[data-testid="sidebar-coding-plan-upgrade-button"]');
      await browser.waitUntil(async () => (await entry().getAttribute("data-disabled")) !== null, {
        timeout: 10000,
      });
      // 测试窗口沿用当前语言；英文专用断言会把正确的中文 loading/error 误判为业务失败。
      expect(await entry().getText()).toMatch(/Loading plans|正在查询套餐/);
      expect(await $('[data-testid="coding-plan-embedded-webview"]').isExisting()).toBe(false);
      await setInventoryMode("fail");
      await browser.waitUntil(
        async () => {
          if (!(await entry().isExisting()))
            await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
          return /Retry|重试/.test(await entry().getText());
        },
        {
          timeout: 15000,
        },
      );
      await telemetryFetch.update();
      expect(
        telemetryFetch.mock.calls.filter(([, init]) =>
          String((init as { body?: string })?.body).includes("coding_plan_upgrade_ck"),
        ),
      ).toHaveLength(0);
      await setInventoryMode("ready");
      await entry().click();
      expect(await $('[data-testid="coding-plan-embedded-webview"]').isExisting()).toBe(false);
      await browser.waitUntil(
        async () => {
          if (!(await entry().isExisting()))
            await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
          const label = await entry().getText();
          return !/Retry|重试|Loading plans|正在查询套餐/.test(label);
        },
        { timeout: 15000 },
      );
      await telemetryFetch.update();
      expect(
        telemetryFetch.mock.calls.filter(([, init]) =>
          String((init as { body?: string })?.body).includes("coding_plan_upgrade_ck"),
        ),
      ).toHaveLength(0);
    });
    await waitForCodingPlanWebviewDisplayed();

    const readEntryEvents = async () => {
      await telemetryFetch.update();
      return telemetryFetch.mock.calls.flatMap(([url, init]) => {
        if (!String(url).includes("/event/report")) return [];
        const body = (init as { body?: string } | undefined)?.body;
        if (!body) return [];
        const event = JSON.parse(body) as {
          element_name: string;
          event_extra_detail: Record<string, string>;
        };
        return event.element_name === "coding_plan_upgrade_ck" ? [event] : [];
      });
    };
    await browser.waitUntil(async () => (await readEntryEvents()).length === 1, {
      timeout: 10000,
      timeoutMsg: "购买入口没有通过 App net.fetch 上报一次",
    });
    const [entry] = await readEntryEvents();
    if (!entry) throw new Error("App 入口事件不存在");
    expect(entry.event_extra_detail.purchase_funnel_id).toBeTruthy();
    expect(entry.event_extra_detail.entry_plan_list).toBe(
      "coding_plan__personal_pro,start_plan__zcode_v3_start_plan",
    );
    await browser.waitUntil(
      async () => {
        const storage = await readCodingPlanWebviewLocalStorage([
          "zcode:coding-plan:report-context",
        ]);
        const context = JSON.parse(storage["zcode:coding-plan:report-context"] || "{}");
        return (
          context.purchase_funnel_id === entry.event_extra_detail.purchase_funnel_id &&
          context.purchase_entry_reporter === "app" &&
          (context.entry_plan_list ?? "") === entry.event_extra_detail.entry_plan_list
        );
      },
      { timeout: 10000, timeoutMsg: "App 上报字段与 WebView 注入上下文不一致" },
    );
    await browser.electron.execute((electron) => {
      const guest = electron.webContents
        .getAllWebContents()
        .find(
          (contents) =>
            contents.getType() === "webview" && contents.getURL().includes("coding-plan"),
        );
      if (!guest) throw new Error("购买 WebView 不存在");
      return new Promise<void>((resolve) => {
        guest.once("did-finish-load", () => resolve());
        guest.reload();
      });
    });
    await browser.waitUntil(
      async () => {
        const storage = await readCodingPlanWebviewLocalStorage([
          "zcode:coding-plan:report-context",
        ]);
        const context = JSON.parse(storage["zcode:coding-plan:report-context"] || "{}");
        return (
          context.purchase_entry_reporter === "app" &&
          context.purchase_funnel_id === entry.event_extra_detail.purchase_funnel_id
        );
      },
      { timeout: 10000 },
    );
    expect(await readEntryEvents()).toHaveLength(1);
    await triggerCodingPlanWebviewPurchaseComplete("bigmodel");
    await waitForCodingPlanWebviewClosed();

    await waitForCodingPlanUpgradeMockRequest(
      (request) => request.path.endsWith("/api/biz/customer/getCustomerInfo"),
      "购买完成后没有刷新 customerInfo",
    );
    await waitForCodingPlanUpgradeMockRequest(
      (request) =>
        request.path.includes("/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys") &&
        !request.path.includes("/copy/"),
      "购买完成后没有读取或创建 BigModel API key",
    );
    await waitForCodingPlanUpgradeMockRequest(
      (request) =>
        request.path.endsWith(
          "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/copy/bigmodel-webview-refreshed-key",
        ),
      "购买完成后没有复制 BigModel API key secret",
    );
    await waitForCodingPlanUpgradeMockRequest(
      (request) => request.path.endsWith("/api/biz/subscription/list"),
      "购买完成后没有校验 subscription/list",
    );
    // Account 凭据属于 Credential Store，不恢复旧 Provider Store 的 apiKey 持久化断言。
    expect(
      (await readModelProvider(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan))?.apiKey ??
        "",
    ).toBe("");
  });

  it("CPUW-03: Z.ai webview 通知 App 关闭升级弹窗并刷新当前 provider 与 Team Plan products", async function () {
    this.timeout(120000);

    await prepareZaiCodingPlanUpgradeState();
    await openZaiCodingPlanPersonalUpgradePanel();
    await waitForCodingPlanWebviewDisplayed();

    await waitForZaiWebviewCredentialsInjected();

    await triggerCodingPlanWebviewPurchaseComplete("zai");
    await waitForCodingPlanWebviewClosed();

    await waitForCodingPlanUpgradeMockRequest(
      (request) =>
        request.path.endsWith("/api/biz/customer/getCustomerInfo") &&
        request.headers.authorization === "Bearer zai-webview-oauth-token",
      "购买完成后没有按 Z.ai token 刷新 customerInfo",
    );
    await waitForCodingPlanUpgradeMockRequest(
      (request) =>
        request.path.endsWith("/api/biz/subscription/enterprise/v2/pricing") &&
        request.headers.authorization === "zai-webview-oauth-token",
      "购买完成后没有刷新 Z.ai enterprise pricing",
    );
    // Account 凭据属于 Credential Store，不恢复旧 Provider Store 的 apiKey 持久化断言。
    expect(
      (await readModelProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan))?.apiKey ?? "",
    ).toBe("");
  });
});

async function prepareZaiCodingPlanUpgradeState() {
  await clearAppData();
  await seedCredentials("zai-webview-oauth-token");
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
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60000);
}

async function waitForZaiWebviewCredentialsInjected() {
  let latestStorage: Record<string, string | null> = {};
  await browser.waitUntil(
    async () => {
      latestStorage = await readCodingPlanWebviewLocalStorage([
        "oauth:zai:access_token",
        "zcodejwttoken",
        "oauth:bigmodel:access_token",
      ]);
      return (
        latestStorage["oauth:zai:access_token"] === "zai-webview-oauth-token" &&
        latestStorage.zcodejwttoken === "zai-webview-oauth-token" &&
        latestStorage["oauth:bigmodel:access_token"] === null
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `Z.ai credentials 没有注入到 Coding Plan webview localStorage: ${JSON.stringify(latestStorage)}`,
    },
  );
}
