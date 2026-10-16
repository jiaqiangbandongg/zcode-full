import { readFile, writeFile } from "node:fs/promises";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { buildRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import {
  clearAppData,
  getE2EAppDataPaths,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
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
} from "../../../helpers/ssh-remote-p0.js";

const CASE_MARKER = "SSH_PROVISIONING_FAILURE";

describe(CASE_MARKER, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-CONN-05 首次失败保留安全诊断，恢复凭据后失效默认不阻断连接", async function () {
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
    const hosts = await readHostProcesses();
    const paths = getE2EAppDataPaths();
    const credentials = await readFile(paths.credentialsFile, "utf8");
    const invalidCredential = "enc:v1:E2E_INVALID_PROVISIONING_CREDENTIAL";
    try {
      await writeFile(
        paths.credentialsFile,
        JSON.stringify({
          ...JSON.parse(credentials),
          "oauth:bigmodel:refresh_token": invalidCredential,
        }),
      );
      await openSSHRemoteDialog(CASE_MARKER);
      await fillSSHPasswordSettings(config);
      await clickLastEnabledSSHDialogButton(CASE_MARKER);
      expect(await waitForSSHError(CASE_MARKER)).toContain("source-read-failed");
      const text = await browser.execute(
        () => document.querySelector('[data-testid="ssh-dialog"]')?.textContent ?? "",
      );
      expect(text.split("source-read-failed").length - 1).toBeGreaterThanOrEqual(2);
      expect(text).not.toContain(invalidCredential);
      expect((await readRemoteTabSnapshot(identity)).remoteSessionId).toBeNull();
    } finally {
      await writeFile(paths.credentialsFile, credentials);
    }

    const defaultModelSelection = {
      providerId: "e2e-removed-provider",
      modelId: "e2e-removed-model",
    };
    const personal = new NodePersonalProviderConfigRepository({
      filePath: paths.configFile,
      pollingIntervalMs: false,
    });
    try {
      await personal.update((current) => ({ ...current, defaultModelSelection }));
      await clickLastEnabledSSHDialogButton(CASE_MARKER);
      await waitForSSHDirectoryStep(CASE_MARKER);
      await selectSSHRemoteDirectory(workspacePath, CASE_MARKER);
      await waitForWorkspaceApp(workspacePath, SSH_WORKSPACE_READY_TIMEOUT_MS);
      await waitForRemoteTab({
        caseMarker: CASE_MARKER,
        expectedIdentity: identity,
        expectedPath: workspacePath,
      });
      expect((await personal.read()).defaultModelSelection).toEqual(defaultModelSelection);
      expect(await readHostProcesses()).toEqual(hosts);
    } finally {
      personal.dispose();
    }
  });
});
