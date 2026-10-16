import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  readTaskRowInWorkspace,
  reconnectSSHWorkspaceThroughUI,
  removeSSHWorkspace,
  sendSSHFollowTurn,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "../../../helpers/ssh-remote-lifecycle.js";
import {
  readHostProcesses,
  waitForRemoteTab,
} from "../../../helpers/ssh-remote-p0.js";

const CASE_MARKER = "E2E_SSH_P0_TASK_LIFECYCLE";

describe(`${CASE_MARKER}: close one SSH workspace and continue another`, () => {
  let provider: SSHLifecycleProvider | null = null;

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSH-P0-TASK-02 关闭 A 后 B 继续发送，重新打开 A 复用共享 Host", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const [workspaceA, workspaceB] = prepared.config.workspacePaths;

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
    const hostBeforeClose = await readHostProcesses();
    expect(hostBeforeClose).toEqual(prepared.initialHosts);

    await removeSSHWorkspace(workspaceA, CASE_MARKER);
    await sendSSHFollowTurn(taskB, CASE_MARKER, taskA.firstPrompt);
    await readTaskRowInWorkspace(taskB, CASE_MARKER);
    expect(await readHostProcesses()).toEqual(hostBeforeClose);

    const reopened = await reconnectSSHWorkspaceThroughUI({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      workspacePath: workspaceA,
    });
    const reopenedTaskA: SSHLifecycleTask = {
      ...taskA,
      remoteSessionId: reopened.remoteSessionId,
    };
    expect(reopened.identity).toBe(taskA.identity);
    expect(reopened.remoteSessionId).not.toBe(taskA.remoteSessionId);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: taskB.identity,
      expectedPath: workspaceB,
      expectedRemoteSessionId: taskB.remoteSessionId,
      requireActive: false,
    });
    await readTaskRowInWorkspace(reopenedTaskA, CASE_MARKER);
    await sendSSHFollowTurn(reopenedTaskA, CASE_MARKER, taskB.firstPrompt);
    expect(await readHostProcesses()).toEqual(hostBeforeClose);
  });
});
