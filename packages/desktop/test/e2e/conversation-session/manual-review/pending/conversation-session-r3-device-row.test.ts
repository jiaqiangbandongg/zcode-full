import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { clearAppData, readSettings } from "#e2e/helpers/desktop-app";
import {
  connectRemoteSourceFromSettings,
  disconnectRemoteSource,
} from "#e2e/helpers/remote-project-actions";
import {
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  readHostProcesses,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_R3_DEVICE_ROW";

describe(`${CASE_MARKER}: 设置页设备状态与连接后项目选择`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("R3A-UI-01 设置页断开后项目保留；设备连接进入目录选择，选择 B 不覆盖 A，不创建远程无项目聊天", async function () {
    this.timeout(10 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    const hosts = await readHostProcesses();
    const [pathA, pathB] = config.workspacePaths;
    const a = await connectSSHWorkspace({ config, caseMarker: CASE_MARKER, workspacePath: pathA });
    const sourceId = parseRemoteWorkspaceIdentity(a.workspaceIdentity!)?.sourceServerId;
    if (!sourceId) throw new Error("首连缺少 Source 身份");
    await disconnectRemoteSource(sourceId, CASE_MARKER);
    const row = $(`[data-project-workspace-identity="${a.workspaceIdentity}"]`);
    await browser.waitUntil(
      async () => (await row.getAttribute("data-connection-state")) === "offline",
      { timeout: 30_000 },
    );
    expect(await row.isDisplayed()).toBe(true);
    await connectRemoteSourceFromSettings(sourceId, CASE_MARKER);
    expect(await waitForSSHDirectoryStep(CASE_MARKER)).toBe("directory");
    await selectSSHRemoteDirectory(pathB, CASE_MARKER);
    const b = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: pathB });
    expect(parseRemoteWorkspaceIdentity(b.workspaceIdentity!)?.sourceServerId).toBe(sourceId);
    expect(b.workspaceIdentity).not.toBe(a.workspaceIdentity);
    const restoredA = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: a.workspaceIdentity!,
      expectedPath: pathA,
      requireActive: false,
    });
    expect(restoredA.remoteSessionId).not.toBe(a.remoteSessionId);
    const settings = await readSettings();
    expect(
      settings.lastWorkspaceSession?.filter(
        (entry) => entry.kind === "remote" && entry.workspacePurpose === "conversation",
      ),
    ).toEqual([]);
    expect(
      settings.sourceServers?.filter((source) => source.sourceServerId === sourceId),
    ).toHaveLength(1);
    expect(await readHostProcesses()).toEqual(hosts);
  });
});
