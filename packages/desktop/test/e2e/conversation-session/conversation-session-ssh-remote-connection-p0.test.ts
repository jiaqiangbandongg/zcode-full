import { buildRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import {
  clearAppData,
  waitForWorkspaceApp,
} from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  waitForSSHError,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
} from "../helpers/ssh-remote-p0.js";

const CASE_MARKER = "SSH_P0_CONNECTION";

describe(`${CASE_MARKER}: SSH password 连接 P0`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-CONN-02/01 错误密码失败后，以正确密码重试并选择远端目录", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    const target: RemoteTarget = {
      kind: "ssh",
      host: config.host,
      port: config.port,
      username: config.username,
    };
    const identity = buildRemoteWorkspaceIdentity(workspacePath, target);

    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);

    await openSSHRemoteDialog(CASE_MARKER);
    const invalidPassword = `${config.password}-e2e-invalid`;
    await fillSSHPasswordSettings({
      ...config,
      password: invalidPassword,
    });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    const errorText = await waitForSSHError(CASE_MARKER);
    expect(errorText).not.toContain(config.password);
    expect(errorText).not.toContain(invalidPassword);
    expect((await readRemoteTabSnapshot(identity)).remoteSessionId).toBeNull();
    expect(await readHostProcesses()).toEqual(initialHosts);

    await closeSSHDialogAfterFailure();
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
    await waitForWorkspaceApp(workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);

    const tab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: identity,
      expectedPath: workspacePath,
    });
    expect(tab.remoteKind).toBe("ssh");
    expect(tab.remoteHost).toBe(config.host);
    expect(tab.secretPersistedInTab).toBe(false);
    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});

async function closeSSHDialogAfterFailure(): Promise<void> {
  await browser.keys("Escape");
  await browser.waitUntil(
    () =>
      browser.execute(
        () => !document.querySelector('[data-testid="ssh-dialog"]'),
      ),
    {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 失败后的 SSH 向导没有关闭`,
    },
  );
}
