import { readFile } from "node:fs/promises";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import {
  AUTOMATIONS_CONTENT_SELECTOR,
  PLUS_GOAL_OPTION_ID,
  PLUS_WORKFLOW_OPTION_ID,
  SLASH_GOAL_OPTION_ID,
  SLASH_WORKFLOW_OPTION_ID,
  automationsPageTabTestId,
  closePlusMenu,
  closeSlashPanel,
  expectTestIdAbsentThroughout,
  hasTestIdInDom,
  openAutomationsPage,
  openGeneralSettings,
  openPlusMenu,
  openSlashPanelWithCatalogReady,
  readDynamicWorkflowGrayMockStatus,
  readPlusMenuAddOptionIds,
  setComposerDraft,
} from "../../../helpers/dynamic-workflow-gray.js";
import { TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER } from "@zcode/shared";

// DWG-08（disabled 档）：服务端 /client/configs 不下发 dynamicWorkflow key，
// 三个入口必须同时消失——`+` 菜单的「工作流」、`/` 面板的 workflow、自动化页的「工作流」标签。
// 服务端形状由 dynamic-workflow-config-mock-server.ts 按本文件名选档；
// 契约见 docs/dynamic-workflow/launch.md「Gray release: the `dynamicWorkflow` feature key」。
// E2E_DWF_GRAY：只读入口，不发送 prompt；空 provider fixture 是有意的合同。
describe("动态工作流灰度未命中（disabled）", () => {
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

  it("DWG-08 关闭时 + 菜单、/ 面板与自动化页都没有工作流入口", async function () {
    this.timeout(180000);

    // 0) 先证明 Host 确实从 case-local 网关取过灰度快照，且这一档没有下发 key。
    //    否则后面的三个「缺席」断言可能只是证明 app 根本没连上这台 mock。
    const status = await readDynamicWorkflowGrayMockStatus();
    expect(status.scenario).toBe("disabled");
    expect(status.mode).toBe(null);
    await browser.waitUntil(
      async () => (await readDynamicWorkflowGrayMockStatus()).configRequests > 0,
      { timeout: 60000, timeoutMsg: "Host 没有向 case-local 配置网关请求 /client/configs" },
    );

    // 1) `/` 面板：catalog 已送达（goal 在场）但 workflow 被整条剔除。
    const slashIds = await openSlashPanelWithCatalogReady();
    expect(slashIds).toContain(SLASH_GOAL_OPTION_ID);
    expect(slashIds).not.toContain(SLASH_WORKFLOW_OPTION_ID);
    await closeSlashPanel();

    // 2) `+` 菜单：目标仍在（正向对照），工作流不在。菜单打开瞬间快照 catalog，
    //    上一步的屏障保证这里读到的是已送达的目录。
    await setComposerDraft("");
    await openPlusMenu();
    const addIds = await readPlusMenuAddOptionIds();
    expect(addIds).toContain(PLUS_GOAL_OPTION_ID);
    expect(addIds).not.toContain(PLUS_WORKFLOW_OPTION_ID);
    await closePlusMenu();

    // 3) 自动化页：页面渲染了，但标题退回平铺 h1——两个标签按钮都不在场，
    //    并且在观察窗内不会迟到出现。
    await openAutomationsPage();
    expect(await $(AUTOMATIONS_CONTENT_SELECTOR).isDisplayed()).toBe(true);
    expect(await hasTestIdInDom(automationsPageTabTestId("workflow"))).toBe(false);
    expect(await hasTestIdInDom(automationsPageTabTestId("automation"))).toBe(false);
    await expectTestIdAbsentThroughout(automationsPageTabTestId("workflow"));

    // 4) DWG-23：服务端未提供时，设置 › 常规里没有动态工作流模式行，灰度对用户不可见。
    await openGeneralSettings();
    await expectTestIdAbsentThroughout(TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER);
  });
});
