import { readFile } from "node:fs/promises";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "../../helpers/desktop-app.js";

const OAUTH_CREDENTIAL_KEYS = [
  "oauth:active_provider",
  "oauth:zai:access_token",
  "oauth:zai:user_info",
  "zcodejwttoken",
] as const;

describe("ZCode JWT 401 自动退出", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("运行中收到普通 401 后清理凭据并确认重启", async function () {
    this.timeout(120_000);

    await waitForDefaultWorkspaceReady(60_000);

    const networkMock = await browser.electron.mock("net", "fetch");
    await networkMock.mockResolvedValue({ ok: false, status: 401 });
    const relaunchMock = await browser.electron.mock("app", "relaunch");
    await relaunchMock.mockResolvedValue(undefined);
    const quitMock = await browser.electron.mock("app", "quit");
    await quitMock.mockResolvedValue(undefined);

    // 打开模型供应商页会触发一次 getAll；mock 从此处开始，避免启动阶段的匿名请求抢先结束用例。
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15000,
      timeoutMsg: "没有找到设置入口按钮",
    });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, {
      timeout: 15000,
      timeoutMsg: "设置页没有出现",
    });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"), {
      timeout: 15000,
      timeoutMsg: "设置页没有出现模型供应商分区入口",
    });

    await waitForExpiredLoginAlert();
    await waitForOAuthCredentialsCleanup();

    await clickExpiredLoginAlertAction();
    await browser.waitUntil(async () => relaunchMock.mock.calls.length > 0, {
      timeout: 10000,
      timeoutMsg: "确认登录失效提示后没有调用 RelaunchApp",
    });
    expect(quitMock.mock.calls.length).toBeGreaterThan(0);
    expect(networkMock.mock.calls.length).toBeGreaterThan(0);
  });
});

async function waitForExpiredLoginAlert(): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => {
        const content = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
        return /登录已过期|Your session has expired/u.test(
          content?.querySelector<HTMLElement>('[data-slot="alert-dialog-title"]')?.textContent ??
            "",
        );
      })) as boolean,
    {
      timeout: 30000,
      timeoutMsg: "运行中收到 401 后没有出现登录失效提示",
    },
  );
}

async function clickExpiredLoginAlertAction(): Promise<void> {
  await browser.execute(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-slot="alert-dialog-content"] button',
    );
    if (!button) {
      throw new Error("登录失效提示缺少确认按钮");
    }
    button.click();
  });
}

async function waitForOAuthCredentialsCleanup(): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        const credentials = JSON.parse(
          await readFile(getE2EAppDataPaths().credentialsFile, "utf-8"),
        ) as Record<string, string>;
        return OAUTH_CREDENTIAL_KEYS.every((key) => !(key in credentials));
      } catch {
        return false;
      }
    },
    {
      timeout: 10000,
      timeoutMsg: "401 后确认提示出现前 OAuth/JWT 凭据没有清理",
    },
  );
}
