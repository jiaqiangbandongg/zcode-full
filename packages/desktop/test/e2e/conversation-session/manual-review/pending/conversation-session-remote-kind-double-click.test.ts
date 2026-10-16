import {
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_DOCKER_CONTAINER_INPUT,
  TID_REMOTE_KIND_DOCKER,
  TID_REMOTE_KIND_SERVER,
  TID_REMOTE_KIND_SSH,
  TID_REMOTE_KIND_WSL,
  TID_SERVER_URL_INPUT,
  TID_SSH_DIALOG,
  TID_SSH_HOST_INPUT,
  TID_WSL_USER_INPUT,
} from "@zcode/shared";
import { clearAppData, clickTestIdByWebDriver } from "../../../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../../../helpers/occupation-onboarding.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_REMOTE_KIND_DOUBLE_CLICK";
const dialogSelector = `[data-testid="${TID_SSH_DIALOG}"]`;
const kindCases = [
  { card: TID_REMOTE_KIND_SSH, field: TID_SSH_HOST_INPUT },
  { card: TID_REMOTE_KIND_SERVER, field: TID_SERVER_URL_INPUT },
  { card: TID_REMOTE_KIND_WSL, field: TID_WSL_USER_INPUT },
  { card: TID_REMOTE_KIND_DOCKER, field: TID_DOCKER_CONTAINER_INPUT },
];

describe(`${CASE_MARKER}: 远程连接类型卡片`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("CWP13: 单击加下一步与双击均进入匹配配置，返回后可以再次双击", async function () {
    this.timeout(90_000);
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E({ skipProvider: true });
    await clickTestIdByWebDriver(TID_COMPOSER_WORKSPACE_TRIGGER);
    await clickTestIdByWebDriver(TID_COMPOSER_REMOTE_CONNECTION);
    await $(dialogSelector).waitForDisplayed();

    expect(await $(`[data-testid="${TID_REMOTE_KIND_SSH}"]`).isDisplayed()).toBe(true);
    expect(await $(`[data-testid="${TID_REMOTE_KIND_DOCKER}"]`).isDisplayed()).toBe(true);

    for (const { card, field } of kindCases) {
      if (!(await $(`[data-testid="${card}"]`).isExisting())) continue;

      await clickTestIdByWebDriver(card);
      expect(await $(`[data-testid="${card}"]`).isDisplayed()).toBe(true);
      expect(await $(`[data-testid="${field}"]`).isExisting()).toBe(false);
      await dialogAction("下一步", "Next").click();
      await expectSettings(field);
      await backToKinds(card);

      // 先切到另一类型，确保双击进入的是目标配置而不是旧选中项。
      const otherCard = card === TID_REMOTE_KIND_SSH ? TID_REMOTE_KIND_DOCKER : TID_REMOTE_KIND_SSH;
      await clickTestIdByWebDriver(otherCard);
      await $(`[data-testid="${card}"]`).doubleClick();
      await expectSettings(field);
      await backToKinds(card);

      await $(`[data-testid="${card}"]`).doubleClick();
      await expectSettings(field);
      await backToKinds(card);
    }
  });
});

function dialogAction(zh: string, en: string) {
  return $(dialogSelector).$(`.//button[normalize-space(.)="${zh}" or normalize-space(.)="${en}"]`);
}

async function expectSettings(field: string) {
  await $(`[data-testid="${field}"]`).waitForDisplayed({
    timeout: 10_000,
    timeoutMsg: `${CASE_MARKER}: 未进入 ${field} 对应的配置页`,
  });
  expect(await $(`[data-testid="${TID_REMOTE_KIND_SSH}"]`).isExisting()).toBe(false);
  expect(await dialogAction("开始连接", "Start connection").isEnabled()).toBe(true);
}

async function backToKinds(card: string) {
  await dialogAction("上一步", "Back").click();
  await $(`[data-testid="${card}"]`).waitForDisplayed();
  expect(await $(`[data-testid="${card}"]`).getAttribute("class")).toMatch(/\bbg-selected\b/);
}
