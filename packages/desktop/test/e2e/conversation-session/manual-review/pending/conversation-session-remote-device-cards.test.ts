import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { buildRemoteHostWorkspaceIdentity, ServiceChannels } from "@zcode/shared";
import type { RemoteProjectDirectory } from "@zcode/services";
import { callHandoffHost, installHandoffRpcProbe } from "#e2e/helpers/remote-project-handoff-probe";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_REMOTE_KIND_SSH,
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
  waitForSSHError,
  waitForRemoteTab,
} from "../../../helpers/ssh-remote-p0.js";

const CASE_MARKER = "E2E_REMOTE_DEVICE_CARDS";
async function button(text: string, selector = "[data-settings-content-frame]") {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (label, root) => {
          const found = [
            ...(document.querySelector(root)?.querySelectorAll<HTMLButtonElement>("button") ?? []),
          ].find(
            (item) =>
              (item.textContent?.trim() === label || item.getAttribute("aria-label") === label) &&
              !item.disabled,
          );
          found?.click();
          return Boolean(found);
        },
        text,
        selector,
      ),
    { timeout: 10_000, timeoutMsg: `Missing ${text}` },
  );
}
async function settings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"));
}

describe(`${CASE_MARKER}: 设置设备卡与未完成连接`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });
  it("RDUX-13 真实设备卡与失败连接隔离，项目可打开，主题与窄屏", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
    await waitForWorkspaceApp(config.workspacePaths[0], 120_000);
    await installHandoffRpcProbe();
    const originalDirectory = await callHandoffHost<RemoteProjectDirectory>(
      ServiceChannels.RemoteProjects,
      "readDirectory",
    );
    const original = originalDirectory.entries.find((entry) =>
      entry.roots.some((root) => root.rootPath === config.workspacePaths[0]),
    );
    if (!original?.projectId) throw new Error(`${CASE_MARKER}: 缺少原项目身份`);
    const identity = buildRemoteHostWorkspaceIdentity(original.hostId, config.workspacePaths[0]);
    const openRecentProject = async (cachedProjectId: string | null) => {
      // 模拟旧版本缺少草稿范围或同目录残留其他项目；最近项目必须由 Host 入口决定归属。
      await browser.execute(
        (identity, hostId, projectId) => {
          const key = `zcode-composer-workspace-scope:v1:${JSON.stringify(["desktop", identity])}`;
          if (projectId === null) localStorage.removeItem(key);
          else
            localStorage.setItem(
              key,
              JSON.stringify({ clientNamespace: "desktop", hostId, projectId }),
            );
        },
        identity,
        original.hostId,
        cachedProjectId,
      );
      await $("[data-device-project]").click();
      await browser.waitUntil(
        async () => {
          // 旧断言反而等待创建器，掩盖了已保存项目被当作新目录的回归。
          expect(await $('[data-testid="virtual-project-name"]').isDisplayed()).toBe(false);
          return (
            !(await $('[role="dialog"]').isDisplayed()) &&
            !(await $('[data-testid="settings-page"]').isDisplayed())
          );
        },
        { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 最近项目未完成原项目导航` },
      );
      await waitForRemoteTab({
        caseMarker: CASE_MARKER,
        expectedIdentity: identity,
        expectedPath: config.workspacePaths[0],
      });
      await waitForWorkspaceApp(config.workspacePaths[0], 30_000);
      expect(await $('[data-testid="virtual-project-name"]').isDisplayed()).toBe(false);
      const projectId = await browser.execute(
        (path, identity) => {
          const bridge = window as Window & {
            __zcodeSessionStoreE2E?: {
              getState(): {
                getWorkspaceState(
                  path: string,
                  identity: string,
                ): { draftProjectId?: string | null };
              };
            };
          };
          return bridge.__zcodeSessionStoreE2E?.getState().getWorkspaceState(path, identity)
            .draftProjectId;
        },
        config.workspacePaths[0],
        identity,
      );
      expect(projectId).toBe(original.projectId);
      const rememberedProjectId = await browser.execute((identity) => {
        const key = `zcode-composer-workspace-scope:v1:${JSON.stringify(["desktop", identity])}`;
        return JSON.parse(localStorage.getItem(key) ?? "null")?.projectId;
      }, identity);
      expect(rememberedProjectId).toBe(original.projectId);
      const current = await callHandoffHost<RemoteProjectDirectory>(
        ServiceChannels.RemoteProjects,
        "readDirectory",
      );
      expect(current.entries.map((entry) => [entry.id, entry.projectId]).sort()).toEqual(
        originalDirectory.entries.map((entry) => [entry.id, entry.projectId]).sort(),
      );
    };
    await browser.execute(() => {
      (
        window as Window & { __testActions?: { setLocale(locale: string): void } }
      ).__testActions?.setLocale("zh-CN");
    });
    await settings();
    await $("[data-source-server-card]").waitForDisplayed();
    expect(await $$("[data-source-server-card]").length).toBe(1);
    // 单条连接不再标记“当前 / 默认”；连接行展示目标与远端版本。
    const connectionText = await $("[data-device-connection]").getText();
    expect(connectionText).toContain(`${config.username}@`);
    expect(connectionText).not.toContain("当前");
    expect(connectionText).toMatch(/v\d+\.\d+/u);
    // 最近项目每行带完整远端路径，任务继续提示只在断开按钮说明里。
    await $("[data-device-project]").waitForDisplayed();
    expect(await $("[data-device-projects]").getText()).toContain("最近项目");
    expect(await $("[data-device-project]").getText()).toContain(config.workspacePaths[0]);
    expect(await $("[data-settings-content-frame]").getText()).not.toContain("远端任务会继续运行");
    await openRecentProject(null);
    await settings();
    await $('[data-source-server-card] button[aria-label="更多"]').click();
    await browser.waitUntil(
      async () => (await $("[data-device-info]").getText()).includes("设备 ID"),
      { timeout: 5000 },
    );
    await browser.keys("Escape");
    // 最近日志收在卡片页脚；短密码不能把固定文案按子串遮蔽（曾出现 "[redacted]ice"）。
    await $("[data-source-server-card] [data-source-server-log-toggle]").click();
    await $("[data-source-server-log-timestamp]").waitForDisplayed();
    const logText = await $("[data-source-server-log]").getText();
    expect(logText).toContain("Checking the remote device");
    expect(logText).not.toContain("[redacted]ice");
    expect(
      await browser.execute(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>("[data-source-server-card] button")]
            .find((item) => item.textContent?.trim() === "断开")
            ?.getAttribute("title") ?? null,
      ),
    ).toContain("远端任务会继续运行");
    await button("断开");
    await $(
      '[data-source-server-card] [data-remote-connection-status="offline"]',
    ).waitForDisplayed();
    await openRecentProject("stale-project");
    await settings();
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing unused port");
    await new Promise<void>((done, reject) =>
      listener.close((error) => (error ? reject(error) : done())),
    );
    await button("新建连接");
    await clickTestIdByDom(TID_REMOTE_KIND_SSH);
    await fillSSHPasswordSettings({ ...config, host: "localhost", port: address.port });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    expect(await waitForSSHError(CASE_MARKER)).toMatch(/无法连接到主机|Unable to connect to host/u);
    // 默认折叠针对历史记录；收起会保留后台 owner 并主动展开，须先关闭失败的当前流程。
    await button("关闭", '[data-testid="ssh-dialog"]');
    await $('[data-testid="ssh-dialog"]').waitForDisplayed({ reverse: true });
    const unfinished = $("[data-unfinished-connections]");
    await unfinished.waitForExist();
    expect(await unfinished.getAttribute("open")).toBeNull();
    expect(await $$("[data-source-server-card]").length).toBe(1);
    await $("[data-unfinished-connections] summary").click();
    expect(await unfinished.getText()).toContain(String(address.port));
    const artifact = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-device-cards",
    );
    await mkdir(artifact, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await browser.execute(
        (value) =>
          (
            window as Window & { __testActions?: { setTheme(theme: string): void } }
          ).__testActions?.setTheme(value),
        theme,
      );
      for (const width of [1440, 900, 480]) {
        await browser.electron.execute(
          (electron, size) =>
            electron.BrowserWindow.getAllWindows()
              .find((window) => !window.isDestroyed())
              ?.setSize(size, 1000),
          width,
        );
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        await browser.saveScreenshot(resolve(artifact, `device-cards-${theme}-${width}.png`));
      }
    }
    await button("清理全部", "[data-unfinished-connections]");
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM);
    await unfinished.waitForExist({ reverse: true });
    expect(await $$("[data-source-server-card]").length).toBe(1);
  });
});
