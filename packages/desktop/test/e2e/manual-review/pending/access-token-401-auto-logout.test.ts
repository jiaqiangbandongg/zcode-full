import { readFile } from "node:fs/promises";
import { DesktopCommandIds, PlatformChannels } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths } from "../../helpers/desktop-app.js";

const responseStatus = process.env.ZCODE_E2E_AUTH_EXPIRY_HTTP_STATUS === "200" ? 200 : 401;

describe("用户资料 access token 登录过期", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it(`AUTH-06: 真实 Host 请求 HTTP ${responseStatus} + 业务 401 后清理当前登录并复用过期弹窗`, async () => {
    const baseUrl = process.env.ZCODE_E2E_ACCESS_TOKEN_401_URL;
    if (!baseUrl) throw new Error("缺少隔离 userinfo HTTP fixture");

    await browser.waitUntil(
      async () => {
        const response = await fetch(`${baseUrl}/__e2e/status`);
        const status = (await response.json()) as { businessRequestCount: number };
        return status.businessRequestCount > 0;
      },
      { timeout: 30_000, timeoutMsg: "Host 没有使用业务 access token 请求 userinfo" },
    );
    const before = await readCredentials();
    expect(before["oauth:active_provider"]).toBe("bigmodel");
    expect(await expiredAlertCount()).toBe(0);

    await fetch(`${baseUrl}/__e2e/reject?status=${responseStatus}`, { method: "POST" });
    const fixtureStatus = (await (await fetch(`${baseUrl}/__e2e/status`)).json()) as {
      rejectionStatus: number;
      rejected: boolean;
    };
    expect(fixtureStatus.rejectionStatus).toBe(responseStatus);
    expect(fixtureStatus.rejected).toBe(true);
    await browser.waitUntil(async () => (await expiredAlertCount()) === 1, {
      timeout: 30_000,
      timeoutMsg: `业务 access token HTTP ${responseStatus} + 业务 401 后没有出现原登录过期弹窗`,
    });
    await browser.waitUntil(
      async () => {
        const credentials = await readCredentials();
        return [
          "oauth:active_provider",
          "oauth:bigmodel:access_token",
          "oauth:bigmodel:refresh_token",
          "oauth:bigmodel:user_info",
          "zcodejwttoken",
        ].every((key) => !(key in credentials));
      },
      { timeout: 10_000, timeoutMsg: "弹窗确认前没有完成原 OAuth 清理" },
    );
    expect((await readCredentials())["bot:e2e:credential"]).toBe("e2e-independent-bot-token");

    // 测试原因：仅 mock app.relaunch/quit 仍会先执行真实 Host 关闭屏障，导致
    // ChromeDriver 收尾超时。业务断言完成后在 IPC 边界记录重启命令，不实际重启。
    await browser.electron.execute((electron, channel) => {
      const state = globalThis as typeof globalThis & { __oauth401Commands?: string[] };
      state.__oauth401Commands = [];
      electron.ipcMain.removeHandler(channel);
      electron.ipcMain.handle(channel, (_event, command: string) => {
        state.__oauth401Commands?.push(command);
      });
    }, PlatformChannels.ExecuteDesktopCommand);
    await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-slot="alert-dialog-content"] button',
      );
      if (!button) throw new Error("缺少登录过期确认按钮");
      button.click();
    });
    await browser.waitUntil(
      async () => {
        const commands = await browser.electron.execute(
          () =>
            (globalThis as typeof globalThis & { __oauth401Commands?: string[] })
              .__oauth401Commands ?? [],
        );
        return commands.length === 1 && commands[0] === DesktopCommandIds.RelaunchApp;
      },
      { timeout: 10_000, timeoutMsg: "确认后没有复用原 RelaunchApp" },
    );
  });
});

async function readCredentials(): Promise<Record<string, string>> {
  return JSON.parse(await readFile(getE2EAppDataPaths().credentialsFile, "utf8"));
}

async function expiredAlertCount(): Promise<number> {
  return browser.execute(
    () =>
      Array.from(document.querySelectorAll('[data-slot="alert-dialog-title"]')).filter((element) =>
        /登录已过期|Your session has expired/u.test(element.textContent ?? ""),
      ).length,
  );
}
