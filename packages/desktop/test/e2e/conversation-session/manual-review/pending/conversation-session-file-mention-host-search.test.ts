import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import {
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  switchToNewestWindow,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";

const marker = "E2E_MFH01_HOST_SEARCH";
const relativePath = `.zcode-e2e/file-mention-host-search/${marker}.ts`;
const root = join(getE2EAppDataPaths().workspace, ".zcode-e2e", "file-mention-host-search");

describe("MFH01：@ 文件候选由 Host 查询", () => {
  before(async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, `${marker}.ts`), "export const marker = true;\n");
    // 冷启动可能先连接到过渡窗口；切到产品窗口后，再退出隔离用户目录的首次引导。
    await browser.waitUntil(
      async () => {
        await switchToNewestWindow();
        return (
          (await $('[data-testid="onboarding-page"]').isDisplayed()) ||
          (await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`).isDisplayed())
        );
      },
      { timeout: 30000, timeoutMsg: "首次引导或 Composer 没有出现" },
    );
    if (await $('[data-testid="onboarding-page"]').isDisplayed()) {
      await browser.keys("Escape");
    }
    await waitForDefaultWorkspaceReady(30000);
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
    await browser.electron.restoreAllMocks();
  });
  it("关键词找到实际文件并插入 mention，输入继续响应", async () => {
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, `@${marker}`, {
      stabilizeLexicalCaretAtEnd: true,
    });
    const option = await $(`[data-option-id="file:${relativePath}"]`);
    await option.waitForDisplayed({ timeout: 30000 });
    await option.click();
    const input = await $(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    await expect(input).toHaveText(expect.stringContaining(`${marker}.ts`));
    await input.click();
    await browser.keys("继续输入");
    await expect(input).toHaveText(expect.stringContaining("继续输入"));
  });
});
