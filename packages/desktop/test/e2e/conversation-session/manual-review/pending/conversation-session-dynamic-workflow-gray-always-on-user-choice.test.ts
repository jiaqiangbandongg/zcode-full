import { readFile } from "node:fs/promises";
import { TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, testId } from "@zcode/shared";
import { clearAppData, readSettings, waitForTestIdByDom } from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E, startNewV4Draft } from "../../../helpers/v4-conversation.js";
import {
  AUTOMATIONS_CONTENT_SELECTOR,
  PLUS_GOAL_OPTION_ID,
  PLUS_WORKFLOW_OPTION_ID,
  automationsPageTabTestId,
  closePlusMenu,
  expectTestIdAbsentThroughout,
  openAutomationsPage,
  openDynamicWorkflowModeSelect,
  openGeneralSettings,
  openPlusMenu,
  readDynamicWorkflowGrayMockStatus,
  readDynamicWorkflowModeTriggerText,
  readPlusMenuAddOptionIds,
  selectDynamicWorkflowMode,
  setComposerDraft,
} from "../../../helpers/dynamic-workflow-gray.js";
import { sel } from "../../../helpers/selectors.js";

// DWG-23（docs/dynamic-workflow/launch.md「The user's choice」）：服务端下发 alwaysOn（文件名命中
// always-on 档），用户在设置 › 常规里选「关闭」后，自动化页退回「自动化」、新草稿的 + 菜单没有工作流；
// 再选回带「默认」标签的「始终开启」，设置文件里的选择被删除（跟随服务端），工作流入口回来。
// E2E_DWF_GRAY：只读入口，不发送 prompt；空 provider fixture 是有意的合同。
describe("动态工作流用户选择（服务端 alwaysOn）", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });
  afterEach(async () => {
    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
    if (!capturePath) throw new Error("Missing provider capture evidence");
    expect(JSON.parse(await readFile(capturePath, "utf8")).records).toEqual([]);
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWG-23 设置行显示默认值；选关闭后入口消失，选回默认删除选择", async function () {
    this.timeout(240000);

    const status = await readDynamicWorkflowGrayMockStatus();
    expect(status.scenario).toBe("alwaysOn");
    await browser.waitUntil(
      async () => (await readDynamicWorkflowGrayMockStatus()).configRequests > 0,
      { timeout: 60000, timeoutMsg: "Host 没有向 case-local 配置网关请求 /client/configs" },
    );

    // 1) 设置 › 常规：未选择时显示服务端下发的「始终开启」，「默认」标签只在它上面。
    await openGeneralSettings();
    await browser.waitUntil(
      async () => (await readDynamicWorkflowModeTriggerText()).includes("始终开启"),
      { timeout: 30000, timeoutMsg: "动态工作流模式行没有显示服务端默认的「始终开启」" },
    );
    await openDynamicWorkflowModeSelect();
    const itemText = (mode: string) =>
      $(sel(testId(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM, mode))).getText();
    expect(await itemText("alwaysOn")).toContain("默认");
    expect(await itemText("onDemand")).not.toContain("默认");
    expect(await itemText("disabled")).not.toContain("默认");
    await browser.keys("Escape");

    // 2) 选「关闭」：写进设置文件，触发器立即显示「关闭」。
    await selectDynamicWorkflowMode("disabled");
    await browser.waitUntil(async () => (await readSettings()).dynamicWorkflowMode === "disabled", {
      timeout: 15000,
      timeoutMsg: "选择「关闭」没有写进设置文件",
    });
    expect(await readDynamicWorkflowModeTriggerText()).toContain("关闭");

    // 3) 自动化页退回平铺的「自动化」标题，「工作流」标签在观察窗内不出现。
    await openAutomationsPage();
    expect(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed()).toBe(true);
    await expectTestIdAbsentThroughout(automationsPageTabTestId("workflow"));

    // 4) 新草稿的 + 菜单：目标仍在（正向对照），工作流不在——CLI 策略已按用户选择重发。
    await startNewV4Draft();
    await setComposerDraft("");
    await browser.waitUntil(
      async () => {
        await openPlusMenu();
        const ids = await readPlusMenuAddOptionIds();
        await closePlusMenu();
        return ids.includes(PLUS_GOAL_OPTION_ID) && !ids.includes(PLUS_WORKFLOW_OPTION_ID);
      },
      { timeout: 30000, timeoutMsg: "选择「关闭」后新草稿的 + 菜单仍有工作流" },
    );

    // 5) 选回带「默认」的「始终开启」：设置文件里的选择被删除（跟随服务端），工作流标签回来。
    await openGeneralSettings();
    await selectDynamicWorkflowMode("alwaysOn");
    await browser.waitUntil(async () => !("dynamicWorkflowMode" in (await readSettings())), {
      timeout: 15000,
      timeoutMsg: "选回默认模式后设置文件里仍留着 dynamicWorkflowMode",
    });
    await openAutomationsPage();
    await waitForTestIdByDom(automationsPageTabTestId("workflow"), {
      timeout: 30000,
      timeoutMsg: "选回默认模式后自动化页没有恢复「工作流」切换",
    });
  });
});
