import {
  clearAppData,
  DEFAULT_WORKSPACE,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  listRemoteZCodeServerPids,
  prepareSSHLifecycle,
  readTaskRowInWorkspace,
  reconnectSSHWorkspace,
  sendSSHFollowTurn,
  stopOwnedSSHServer,
  waitForRemoteWorkspaceDisconnected,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "../../../helpers/ssh-remote-lifecycle.js";
import { readHostProcesses, waitForRemoteTab } from "../../../helpers/ssh-remote-p0.js";

const CASE_MARKER = "E2E_SSH_P0_SERVER_FAULT";

describe(`${CASE_MARKER}: SSH zcode-server fault and grouped reconnect`, () => {
  let provider: SSHLifecycleProvider | null = null;

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-LIFE-02 只终止本 case 新建的 zcode-server 后，重连 A 恢复 A/B", async function () {
    this.timeout(35 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const [workspaceA, workspaceB] = prepared.config.workspacePaths;
    const serverPidsBefore = await listRemoteZCodeServerPids(prepared.config);
    const taskA = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    const taskB = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "B",
      provider,
      workspacePath: workspaceB,
    });
    const hostBeforeFault = await readHostProcesses();
    expect(await listRemoteZCodeServerPids(prepared.config)).toEqual(
      expect.arrayContaining(serverPidsBefore),
    );

    await stopOwnedSSHServer(prepared.config, serverPidsBefore, CASE_MARKER);
    await waitForRemoteWorkspaceDisconnected(taskA.identity, CASE_MARKER);
    await waitForRemoteWorkspaceDisconnected(taskB.identity, CASE_MARKER);

    await reconnectSSHWorkspace(workspaceA, CASE_MARKER);
    const reconnectedA = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskA.identity,
      expectedPath: workspaceA,
    });
    const reconnectedB = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspaceB,
      requireActive: false,
    });
    expect(reconnectedA.remoteSessionId).not.toBe(taskA.remoteSessionId);
    expect(reconnectedB.remoteSessionId).not.toBe(taskB.remoteSessionId);
    expect(await readHostProcesses()).toEqual(hostBeforeFault);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);

    const resumedA: SSHLifecycleTask = {
      ...taskA,
      remoteSessionId: reconnectedA.remoteSessionId!,
    };
    const resumedB: SSHLifecycleTask = {
      ...taskB,
      remoteSessionId: reconnectedB.remoteSessionId!,
    };
    await readTaskRowInWorkspace(resumedA, CASE_MARKER);
    await readTaskRowInWorkspace(resumedB, CASE_MARKER);
    await sendSSHFollowTurn(resumedB, CASE_MARKER, taskA.firstPrompt);
    await sendSSHFollowTurn(resumedA, CASE_MARKER, taskB.firstPrompt);
    await readTaskRowInWorkspace(resumedA, CASE_MARKER);
    await readTaskRowInWorkspace(resumedB, CASE_MARKER);
  });
});
