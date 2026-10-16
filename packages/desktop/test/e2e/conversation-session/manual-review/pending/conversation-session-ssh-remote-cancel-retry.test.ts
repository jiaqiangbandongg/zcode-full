import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SSH_DIALOG,
  buildRemoteWorkspaceIdentity,
  type RemoteTarget,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import {
  clickLastEnabledSSHDialogButton,
  createFirstConnectionStallingSSHProxy,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readHostProcesses,
  readSSHRuntimeConfig,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  waitForSSHError,
  type FirstConnectionStallingSSHProxy,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
} from "../../../helpers/ssh-remote-p0.js";

const CASE_MARKER = "E2E_SSH_P0_CANCEL_RETRY";
const CONNECTION_CLOSE_TIMEOUT_MS = 30_000;

describe(`${CASE_MARKER}: SSH pending cancel 后立即重试`, () => {
  let proxy: FirstConnectionStallingSSHProxy | null = null;

  after(async () => {
    try {
      await browser.electron.restoreAllMocks();
      await clearAppData();
    } finally {
      await proxy?.close();
      proxy = null;
    }
  });

  it("SSH-P0-CONN-03 停止 pending 连接后，同 target 使用新凭据重试", async function () {
    this.timeout(20 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const workspacePath = config.workspacePaths[0];
    proxy = await createFirstConnectionStallingSSHProxy(config, CASE_MARKER);
    const proxiedConfig = {
      ...config,
      host: "127.0.0.1",
      port: proxy.port,
    };
    const target: RemoteTarget = {
      kind: "ssh",
      host: proxiedConfig.host,
      port: proxiedConfig.port,
      username: proxiedConfig.username,
    };
    const identity = buildRemoteWorkspaceIdentity(workspacePath, target);

    await prepareV4ConversationE2E({ skipProvider: true });
    const initialHosts = await readHostProcesses();
    expect(initialHosts).toHaveLength(1);

    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings({
      ...proxiedConfig,
      password: "cancelled-attempt",
    });
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await proxy.firstConnectionAccepted;

    await browser.keys("Escape");
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: pending SSH 连接没有显示停止确认`,
    });
    await waitForPromise(
      proxy.waitForFirstConnectionClosed(),
      CONNECTION_CLOSE_TIMEOUT_MS,
      `${CASE_MARKER}: 取消后首个 SSH socket 没有关闭`,
    );
    await waitForSSHError(CASE_MARKER, CONNECTION_CLOSE_TIMEOUT_MS);
    await clickSSHDialogBackButton();

    await fillSSHPasswordSettings(proxiedConfig);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
    await waitForWorkspaceApp(workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);

    const tab = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: identity,
      expectedPath: workspacePath,
    });
    expect(tab.remoteSessionId).toBeTruthy();
    expect(tab.secretPersistedInTab).toBe(false);
    expect(await readHostProcesses()).toEqual(initialHosts);
  });
});

async function clickSSHDialogBackButton(): Promise<void> {
  let visibleLabels: string[] = [];
  await browser.waitUntil(
    async () => {
      const result = await browser.execute((dialogTestId) => {
        const dialog = document.querySelector<HTMLElement>(
          `[data-testid="${dialogTestId}"]`,
        );
        if (!dialog?.getClientRects().length) {
          return { clicked: false, labels: [] as string[] };
        }
        const buttons = Array.from(
          dialog.querySelectorAll<HTMLButtonElement>("button"),
        ).filter((button) => button.getClientRects().length > 0 && !button.disabled);
        const labels = buttons.map((button) => button.innerText.trim());
        const back = buttons.find((button) =>
          ["Back", "返回"].includes(button.innerText.trim()),
        );
        back?.click();
        return { clicked: Boolean(back), labels };
      }, TID_SSH_DIALOG);
      visibleLabels = result.labels;
      return result.clicked;
    },
    {
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: 取消后 SSH 向导没有可用的返回按钮 (${visibleLabels.join(",")})`,
    },
  );
}

async function waitForPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
