import { disconnectRemoteSource } from "#e2e/helpers/remote-project-actions";
import { TID_SSH_PASSWORD_INPUT } from "@zcode/shared/test-ids";
import { reloadElectronSessionPreservingBrowserProfile } from "#e2e/helpers/e2e-electron-reload";
import {
  clearAppData,
  removeSeededCredentials,
  readSettings,
  setInputValueByTestIdDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import {
  prepareSSHConnectionPage,
  openRemoteProjectSelection,
  readSSHRuntimeConfig,
  clickLastEnabledSSHDialogButton,
  waitForSSHDirectoryStep,
  selectSSHRemoteDirectory,
  openSSHRemoteDialog,
  fillSSHPasswordSettings,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
  waitForRemoteTab,
} from "../../../helpers/ssh-remote-p0.js";

const CASE_MARKER = "E2E_SSH_P0_WIZARD_CREDENTIALS";

describe(`${CASE_MARKER}: 向导凭据与已在线复用`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-CONN-06/07 缺密码可回填，手动连接在线目标明确提示复用", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
    const tab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedPath: config.workspacePaths[0],
    });
    const settings = await readSettings();
    const profile = settings.connectionProfiles?.find(
      (candidate) =>
        candidate.target.kind === "ssh" &&
        candidate.target.host === config.host &&
        candidate.target.username === config.username,
    );
    if (!profile?.sourceServerId || !tab.workspaceIdentity)
      throw new Error(`${CASE_MARKER}: 首次真实连接未保存设备身份`);
    await disconnectRemoteSource(profile.sourceServerId, CASE_MARKER);
    // 旧 Host 完全退出后再删除凭据值，保留引用，避免活跃 writer 覆盖用例前置。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        const latest = await readSettings();
        const keys = (latest.connectionProfiles ?? []).flatMap((candidate) =>
          candidate.profileId === profile.profileId && candidate.target.kind === "ssh"
            ? [
                candidate.target.passwordCredentialKey,
                candidate.target.privateKeyPassphraseCredentialKey,
              ]
            : [],
        );
        for (const entry of latest.lastWorkspaceSession ?? []) {
          if (
            entry.kind === "remote" &&
            entry.target.kind === "ssh" &&
            entry.target.host === config.host
          )
            keys.push(
              entry.target.passwordCredentialKey,
              entry.target.privateKeyPassphraseCredentialKey,
            );
        }
        await removeSeededCredentials(keys.filter((key): key is string => Boolean(key)));
      },
    });
    await openRemoteProjectSelection();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-testid="ssh-dialog"] [data-remote-source-server-id] button',
          );
          if (!button || button.disabled) return false;
          button.click();
          return true;
        }),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 保存的设备没有连接入口` },
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (testId) => document.activeElement?.getAttribute("data-testid") === testId,
          TID_SSH_PASSWORD_INPUT,
        ),
      { timeout: 15_000, timeoutMsg: `${CASE_MARKER}: 密码框未获得焦点` },
    );
    await setInputValueByTestIdDom(TID_SSH_PASSWORD_INPUT, config.password);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("directory");
    await selectSSHRemoteDirectory(config.workspacePaths[0], CASE_MARKER);
    await waitForWorkspaceApp(config.workspacePaths[0], SSH_WORKSPACE_READY_TIMEOUT_MS);

    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings({ ...config, password: "unused-online-reuse-password" });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          /已直接使用现有连接|existing connection is now in use/u.test(
            document.body.textContent ?? "",
          ),
        ),
      { timeout: 30_000, timeoutMsg: `${CASE_MARKER}: 复用在线连接没有提示` },
    );
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("directory");
    expect(await $('[data-testid="ssh-error"]').isExisting()).toBe(false);
  });
});
