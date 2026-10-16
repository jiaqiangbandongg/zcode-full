import {
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER,
  TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM,
  testId,
} from "@zcode/shared";
import { clickTestIdByDom, waitForDefaultWorkspaceReady } from "./helpers/desktop-app.js";
import { clearAppData } from "./helpers/desktop-app.js";
import {
  waitForCodingPlanWebviewBodyTextIncludes,
  waitForCodingPlanWebviewDisplayed,
} from "./helpers/coding-plan-upgrade-webview.js";

describe("BigModel Coding Plan 升级页个人套餐售罄 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("无 Coding 权益账号进入升级页时，个人套餐按钮显示已售罄", async function () {
    this.timeout(120000);

    await waitForDefaultWorkspaceReady(30000);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
    await clickTestIdByDom(testId(TID_MODEL_PROVIDER_NAV_ITEM, "preset:builtin:bigmodel"));
    const selectMode = async (key: string) => {
      // 设置分区切换是异步渲染；等可见 trigger 再用真实指针展开 Radix 菜单。
      await browser.waitUntil(async () => {
        const triggers = await $$(`[data-testid="${TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER}"]`);
        for (const trigger of triggers) {
          if (await trigger.isDisplayed()) {
            await trigger.click();
            return true;
          }
        }
        return false;
      }, { timeout: 15000, timeoutMsg: "没有可见的连接方式选择器" });
      await clickTestIdByDom(testId(TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM, key));
    };
    await selectMode("preset:builtin:bigmodel");
    const base =
      process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL ?? process.env.BIGMODEL_TEST_API_BASE_URL;
    if (!base) throw new Error("Missing mock URL");
    const hold = async (held: boolean) => {
      const response = await fetch(`${base}/__e2e/coding-plan/customer-info-hold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ held }),
      });
      expect(response.ok).toBe(true);
    };
    await hold(true);
    try {
      await selectMode("coding-plan:builtin:bigmodel-coding-plan");
      const subscribe = () => $("button*=Subscribe");
      await subscribe().waitForDisplayed({ timeout: 15000 });
      await browser.waitUntil(async () => await subscribe().$("svg.animate-spin").isExisting(), {
        timeout: 15000,
      });
      expect(await subscribe().isEnabled()).toBe(false);
      expect(await $('[data-testid="coding-plan-embedded-webview"]').isExisting()).toBe(false);
      await hold(false);
      await browser.waitUntil(async () => await subscribe().isEnabled(), { timeout: 30000 });
      expect(await subscribe().$("svg.animate-spin").isExisting()).toBe(false);
      await subscribe().click();
    } finally {
      await hold(false);
    }
    await waitForCodingPlanWebviewDisplayed();
    await waitForCodingPlanWebviewBodyTextIncludes(["已售罄", "Sold out"]);
  });
});
