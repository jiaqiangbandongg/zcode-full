import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_TASK_ITEM,
  TID_TASK_SETTINGS_BUTTON,
  TID_WORKSPACE_ITEM,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "../../../helpers/conversation-session-network.js";
import { sel } from "../../../helpers/selectors.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  prepareSSHLifecycle,
  SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  type SSHLifecycleProvider,
  type SSHLifecycleTask,
} from "../../../helpers/ssh-remote-lifecycle.js";
import { waitForRemoteTab } from "../../../helpers/ssh-remote-p0.js";
import {
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_SSH_P0_SETTINGS_OVERLAY_SIDEBAR";

interface SidebarRowIndicator {
  exists: boolean;
  inWorkspace: boolean;
  running: boolean;
  error: boolean;
}

/** 读取侧栏"项目"视图里该 task 行的前导指示器：running=转圈（sessions-index phase running/prewarming）。 */
function readSidebarRowIndicator(task: SSHLifecycleTask): Promise<SidebarRowIndicator> {
  return browser.execute(
    (taskTestId, workspaceTestId) => {
      const taskRow = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (element) => element.dataset.testid === taskTestId,
      );
      const workspaceRow = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (element) => element.dataset.testid === workspaceTestId,
      );
      return {
        exists: Boolean(taskRow),
        inWorkspace: Boolean(taskRow && workspaceRow?.closest("li")?.contains(taskRow)),
        running: Boolean(taskRow?.querySelector(".animate-spin")),
        error: Boolean(taskRow?.querySelector('[data-error-indicator="true"]')),
      };
    },
    testId(TID_TASK_ITEM, task.taskId),
    testId(TID_WORKSPACE_ITEM, task.workspacePath),
  );
}

async function waitForSidebarRowRunning(task: SSHLifecycleTask, running: boolean): Promise<void> {
  let latest: SidebarRowIndicator | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readSidebarRowIndicator(task);
      return latest.exists && latest.inWorkspace && !latest.error && latest.running === running;
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${CASE_MARKER}: 侧栏 task 行 running 期望 ${String(running)}，实际 ${JSON.stringify(latest)}`,
    },
  );
}

async function openAndCloseSettingsPage(workspacePath: string): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: 没有找到设置页入口`,
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: 设置页没有返回入口`,
  });
  await waitForWorkspaceApp(workspacePath, 30_000);
}

describe(`${CASE_MARKER}: opening Settings must not detach the remote sidebar sessions-index`, () => {
  let provider: SSHLifecycleProvider | null = null;

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  // Bug 根因（2026-09-04 用户反馈）：Settings tab 覆盖远程 workspace 时 Root 丢掉 remoteSessionId，
  // 完成通知 hook 用 __base__ 键再建一条 sessions-index 订阅，CLI 同 connection/topic 只保留最新订阅，
  // 侧栏订阅被静默顶掉 → 运行中的任务永久转圈、时间停在打开设置页那一刻，聊天区却已完成。
  it("SSH-P0-TASK-03 运行中开关设置页后，侧栏任务行仍随任务完成收敛", async function () {
    this.timeout(30 * 60_000);
    const prepared = await prepareSSHLifecycle(CASE_MARKER);
    provider = prepared.provider;
    const [workspaceA] = prepared.config.workspacePaths;

    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: prepared.config,
      label: "A",
      provider,
      workspacePath: workspaceA,
    });
    await waitForSidebarRowRunning(task, false);

    // 续发一轮（fixture 延迟 15s 返回），在运行中打开并关闭设置页。
    await selectV4TaskById(task.taskId, 30_000);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: task.identity,
      expectedPath: task.workspacePath,
      expectedRemoteSessionId: task.remoteSessionId,
    });
    const requestStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${task.followPrompt}: 只回复 ${task.followReply}`,
      task.followPrompt,
      `${CASE_MARKER}: 续发没有被接受`,
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === task.taskId && snapshot.state === "streaming",
      `${CASE_MARKER}: 续发没有进入 streaming`,
      SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    );
    // 侧栏必须先证明自己在跟踪实时 phase（running 转圈），否则后面的收敛断言无意义。
    await waitForSidebarRowRunning(task, true);

    await openAndCloseSettingsPage(workspaceA);
    await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: task.identity,
      expectedPath: task.workspacePath,
      expectedRemoteSessionId: task.remoteSessionId,
    });

    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [task.followPrompt] },
      `${CASE_MARKER}: 续发没有到达 provider`,
      SSH_LIFECYCLE_TURN_TIMEOUT_MS,
      { afterIndex: requestStart - 1 },
    );
    await waitForV4AssistantMessageContaining(task.followReply, SSH_LIFECYCLE_TURN_TIMEOUT_MS);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId === task.taskId && snapshot.state === "idle" && snapshot.queueCount === 0,
      `${CASE_MARKER}: 续发没有回到 idle`,
      SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    );

    // 修复前：侧栏订阅已被设置页顶掉，这里会一直看到转圈直到超时；修复后与聊天区同步收敛。
    await waitForSidebarRowRunning(task, false);
  });
});
