import { createDecipheriv, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PlatformChannels,
  TID_OAUTH_LOGIN_BUTTON,
  TID_OAUTH_ERROR,
  TID_OAUTH_CANCEL,
  TID_LOGIN_TRIGGER,
  TID_LOGIN_MENU_ITEM,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "../../helpers/desktop-app.js";

describe("OAuth 双路径完成竞态", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("AUTH-07: 浏览器唤起兑换失败后使用已到达的 polling 结果，保留归因", async function () {
    this.timeout(120_000);
    const baseUrl = process.env.ZCODE_E2E_OAUTH_RACE_URL;
    if (!baseUrl) throw new Error("缺少 OAuth race HTTP fixture");
    const openExternal = await browser.electron.mock("shell", "openExternal");
    await openExternal.mockResolvedValue(undefined);
    await browser.waitUntil(
      async () =>
        browser.execute(
          (button, trigger) =>
            Boolean(
              document.querySelector(
                `[data-testid="${button}"], [data-testid="${trigger}"], [data-testid="onboarding-page"]`,
              ),
            ),
          TID_OAUTH_LOGIN_BUTTON,
          TID_LOGIN_TRIGGER,
        ),
      { timeout: 60_000 },
    );
    // 新用户引导覆盖登录面板，使用正常 Escape 交互关闭，不修改产品状态。
    await browser.keys("Escape");
    const hasButton = await browser.execute(
      (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
      TID_OAUTH_LOGIN_BUTTON,
    );
    if (!hasButton) {
      // Radix 菜单依赖 pointerdown；原生 WebDriver click 会派发完整指针事件。
      const triggers = await browser.$$(`[data-testid="${TID_LOGIN_TRIGGER}"]`);
      for (const trigger of triggers) {
        if (await trigger.isDisplayed()) {
          await trigger.click();
          break;
        }
      }
      await clickTestIdByDom(TID_LOGIN_MENU_ITEM);
    }
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    const originalProvider = (await readCredentials())["oauth:active_provider"];
    await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await browser.waitUntil(
      async () => {
        await openExternal.update();
        return openExternal.mock.calls.length > 0;
      },
      {
        timeout: 20_000,
      },
    );
    // 先验证兑换等待期间取消：Host 返回 null，Root 不应把正常取消当作失败或登录成功。
    await browser.electron.execute((electron, channel) => {
      electron.BrowserWindow.getAllWindows()[0]!.webContents.send(
        channel,
        "zcode://oauth/callback?state=e2e-race&authCode=cancelled",
      );
    }, PlatformChannels.OAuthCallback);
    await browser.waitUntil(
      async () => {
        const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
          tokenRequests: number;
        };
        return status.tokenRequests === 1;
      },
      { timeout: 20_000 },
    );
    await clickTestIdByDom(TID_OAUTH_CANCEL);
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await fetch(`${baseUrl}/__e2e/complete-token`, { method: "POST" });
    // 等待真实 RPC 回调完成后再发起下一次登录，避免新登录掩盖取消的 UI 结果。
    const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
    if (!logDir) throw new Error("缺少 E2E 日志目录");
    await browser.waitUntil(
      async () => {
        const files = (await readdir(logDir)).filter((file) => file.endsWith(".log"));
        const logs = await Promise.all(files.map((file) => readFile(join(logDir, file), "utf8")));
        return logs.some((log) => log.includes("oauth.handleCallback OK"));
      },
      { timeout: 10_000 },
    );
    await browser.executeAsync((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
    });
    const cancelledCredentials = await readCredentials();
    expect(cancelledCredentials["oauth:active_provider"]).toBe(originalProvider);
    expect(cancelledCredentials["oauth:bigmodel:access_token"]).toBeUndefined();
    expect(await browser.$(`[data-testid="${TID_OAUTH_ERROR}"]`).isExisting()).toBe(false);
    await fetch(`${baseUrl}/__e2e/enable-poll`, { method: "POST" });
    await clickTestIdByDom(TID_OAUTH_LOGIN_BUTTON);
    await browser.waitUntil(
      async () => {
        await openExternal.update();
        return openExternal.mock.calls.length > 1;
      },
      { timeout: 20_000 },
    );
    // 真实 preload → Root → Host；只有浏览器外部打开被拦截，登录服务不 mock。
    await browser.electron.execute((electron, channel) => {
      electron.BrowserWindow.getAllWindows()[0]!.webContents.send(
        channel,
        "zcode://oauth/callback?state=e2e-race&authCode=e2e-code&channel_id=desktop&utm_source=website&utm_campaign=race",
      );
    }, PlatformChannels.OAuthCallback);
    await browser.waitUntil(
      async () => {
        const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
          readyResponses: number;
        };
        return status.readyResponses > 0;
      },
      { timeout: 20_000, timeoutMsg: "兑换挂起期间没有收到 polling ready" },
    );
    await fetch(`${baseUrl}/__e2e/fail-token`, { method: "POST" });
    await browser.waitUntil(
      async () => (await readCredentials())["oauth:active_provider"] === "bigmodel",
      { timeout: 20_000, timeoutMsg: "回调失败导致 polling 登录未完成" },
    );
    await browser.waitUntil(
      async () =>
        browser.execute(
          (id) => !document.querySelector(`[data-testid="${id}"]`),
          TID_OAUTH_LOGIN_BUTTON,
        ),
      { timeout: 20_000, timeoutMsg: "登录成功后未离开登录面板" },
    );
    expect(
      await browser.execute(
        (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
        TID_OAUTH_ERROR,
        TID_OAUTH_CANCEL,
      ),
    ).toBe(false);
    const credentials = await readCredentials();
    expect(credentials["oauth:bigmodel:access_token"]).toBe("e2e-race-business");
    expect(JSON.parse(credentials["oauth:login_attribution"]!)).toEqual({
      channel_id: "desktop",
      utm_source: "website",
      utm_campaign: "race",
    });
    // polling 已成功后，迟到回调只更新归因，不能再次兑换授权码。
    await browser.electron.execute((electron, channel) => {
      electron.BrowserWindow.getAllWindows()[0]!.webContents.send(
        channel,
        "zcode://oauth/callback?state=e2e-race&authCode=late&channel_id=desktop&utm_source=website&utm_campaign=late",
      );
    }, PlatformChannels.OAuthCallback);
    await browser.waitUntil(
      async () =>
        JSON.parse((await readCredentials())["oauth:login_attribution"] ?? "{}").utm_campaign ===
        "late",
      { timeout: 10_000 },
    );
    const status = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
      tokenRequests: number;
    };
    expect(status.tokenRequests).toBe(1);
  });
});

async function readCredentials(): Promise<Record<string, string>> {
  const stored = JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8")) as Record<
    string,
    string
  >;
  // Host 正常加密落盘；这里只用 case 专属合成密钥读取隔离目录，不能把密文当登录值断言。
  const key = createHash("sha256").update("oauth-completion-race-fixture").digest();
  return Object.fromEntries(
    Object.entries(stored).map(([name, value]) => {
      if (!value.startsWith("enc:v1:")) return [name, value];
      const [iv, tag, data] = value.slice("enc:v1:".length).split(".");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv!, "base64url"));
      decipher.setAuthTag(Buffer.from(tag!, "base64url"));
      return [
        name,
        Buffer.concat([
          decipher.update(Buffer.from(data!, "base64url")),
          decipher.final(),
        ]).toString("utf8"),
      ];
    }),
  );
}
