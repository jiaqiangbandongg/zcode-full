/* eslint-disable max-lines -- SSH lifecycle case 共用 setup/teardown、身份与故障辅助逻辑，集中维护以保持同一安全边界。 */
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_TASK_ITEM,
  TID_WORKSPACE_CLOSE,
  TID_WORKSPACE_ITEM,
  buildRemoteWorkspaceIdentity,
  testId,
  type RemoteTarget,
} from "@zcode/shared";
import {
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "./desktop-app.js";
import { createCustomOpenAIChatCompletionsProvider } from "./custom-openai-provider.js";
import { selectUpstreamProviderModelById } from "./upstream-provider.js";
import {
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "./conversation-session-network.js";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "./v4-conversation.js";
import {
  clickLastEnabledSSHDialogButton,
  createSSHReplayTunnel,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readHostProcesses,
  readRemoteTabSnapshot,
  readSSHRuntimeConfig,
  runSSHCommand,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type ReplayTunnel,
  type SSHConnectionConfig,
  type SSHRuntimeConfig,
  SSH_WORKSPACE_READY_TIMEOUT_MS,
} from "./ssh-remote-p0.js";

export const SSH_LIFECYCLE_MODEL_ID = "e2e-ssh-remote-lifecycle-model";
export const SSH_LIFECYCLE_TURN_TIMEOUT_MS = 2 * 60_000;

export interface SSHLifecycleTask {
  firstPrompt: string;
  firstReply: string;
  followPrompt: string;
  followReply: string;
  identity: string;
  label: "A" | "B";
  remoteSessionId: string;
  taskId: string;
  workspacePath: string;
}

export interface SSHLifecycleProvider {
  id: string;
  name: string;
  tunnel: ReplayTunnel;
}

export async function createSSHLifecycleProvider(
  config: SSHConnectionConfig,
  caseMarker: string,
): Promise<SSHLifecycleProvider> {
  const tunnel = await createSSHReplayTunnel(config, caseMarker);
  try {
    const provider = await createCustomOpenAIChatCompletionsProvider({
      baseURL: tunnel.baseURL,
      modelId: SSH_LIFECYCLE_MODEL_ID,
      providerName: `SSH remote lifecycle ${Date.now()}`,
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
      timeout: 30_000,
      timeoutMsg: `${caseMarker}: provider 创建后设置页没有返回入口`,
    });
    return { ...provider, tunnel };
  } catch (error) {
    await tunnel.close();
    throw error;
  }
}

export async function connectSSHWorkspaceAndSendFirstTurn(options: {
  caseMarker: string;
  config: SSHConnectionConfig;
  provider: SSHLifecycleProvider;
  label: "A" | "B";
  workspacePath: string;
}): Promise<SSHLifecycleTask> {
  const target: RemoteTarget = {
    kind: "ssh",
    host: options.config.host,
    port: options.config.port,
    username: options.config.username,
  };
  const identity = buildRemoteWorkspaceIdentity(options.workspacePath, target);

  await startNewV4Draft();
  await openSSHRemoteDialog(options.caseMarker);
  await fillSSHPasswordSettings(options.config);
  await clickLastEnabledSSHDialogButton(options.caseMarker);
  await waitForSSHDirectoryStep(options.caseMarker);
  await selectSSHRemoteDirectory(options.workspacePath, options.caseMarker);
  await waitForWorkspaceApp(
    options.workspacePath,
    SSH_WORKSPACE_READY_TIMEOUT_MS,
  );

  const tab = await waitForRemoteTab({
    caseMarker: options.caseMarker,
    expectedIdentity: identity,
    expectedPath: options.workspacePath,
  });
  expect(tab.remoteKind).toBe("ssh");
  expect(tab.remoteHost).toBe(options.config.host);
  expect(tab.secretPersistedInTab).toBe(false);
  if (!tab.remoteSessionId) {
    throw new Error(
      `${options.caseMarker}: workspace ${options.label} 缺少 remoteSessionId`,
    );
  }

  await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
    includePlainModelFallback: false,
    providerId: options.provider.id,
    providerName: options.provider.name,
  });
  await startNewV4Draft();

  // fixture contract 使用稳定的 case/label 标记；run 身份已由 E2E profile 隔离。
  const marker = options.caseMarker.startsWith("E2E_")
    ? `${options.caseMarker}_${options.label}`
    : `E2E_${options.caseMarker}_${options.label}`;
  const replyMarker = options.caseMarker.startsWith("E2E_")
    ? options.caseMarker.slice("E2E_".length)
    : options.caseMarker;
  const task = {
    firstPrompt: `${marker}_FIRST_PROMPT`,
    firstReply: `${replyMarker}_REPLY`,
    followPrompt: `${marker}_FOLLOW_PROMPT`,
    followReply: `${replyMarker}_REPLY`,
  };
  const requestStart = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${task.firstPrompt}: 只回复 ${task.firstReply}`,
    task.firstPrompt,
    `${options.caseMarker}: workspace ${options.label} 首发没有被接受`,
  );
  const running = await waitForV4ConversationState(
    (snapshot) =>
      Boolean(snapshot.taskId && snapshot.taskId !== "draft") &&
      snapshot.state === "streaming",
    `${options.caseMarker}: workspace ${options.label} 首发没有进入 streaming`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
  if (!running.taskId) {
    throw new Error(
      `${options.caseMarker}: workspace ${options.label} 首发没有 taskId`,
    );
  }

  await waitForUpstreamRequest(
    { lastUserMessageIncludes: [task.firstPrompt] },
    `${options.caseMarker}: workspace ${options.label} 首发没有到达 provider`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    { afterIndex: requestStart - 1 },
  );
  await waitForV4AssistantMessageContaining(
    task.firstReply,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.taskId === running.taskId &&
      snapshot.state === "idle" &&
      snapshot.queueCount === 0,
    `${options.caseMarker}: workspace ${options.label} 首发没有回到 idle`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );

  return {
    ...task,
    identity,
    label: options.label,
    remoteSessionId: tab.remoteSessionId,
    taskId: running.taskId,
    workspacePath: options.workspacePath,
  };
}

export async function sendSSHFollowTurn(
  task: SSHLifecycleTask,
  caseMarker: string,
  foreignPrompt?: string,
): Promise<void> {
  await selectV4TaskById(task.taskId, 30_000);
  await waitForRemoteTab({
    caseMarker,
    expectedIdentity: task.identity,
    expectedPath: task.workspacePath,
    expectedRemoteSessionId: task.remoteSessionId,
  });
  const requestStart = await getUpstreamRequestRecordCount();
  await sendV4PromptAndWaitAccepted(
    `${task.followPrompt}: 只回复 ${task.followReply}`,
    task.followPrompt,
    `${caseMarker}: workspace ${task.label} 续发没有被接受`,
  );
  await waitForUpstreamRequest(
    {
      ...(foreignPrompt ? { excludes: [foreignPrompt] } : {}),
      includes: [task.firstPrompt],
      lastUserMessageIncludes: [task.followPrompt],
    },
    `${caseMarker}: workspace ${task.label} 续发历史或目标 workspace 错误`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
    { afterIndex: requestStart - 1 },
  );
  await waitForV4AssistantMessageContaining(
    task.followReply,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
  await waitForV4ConversationState(
    (snapshot) =>
      snapshot.taskId === task.taskId &&
      snapshot.state === "idle" &&
      snapshot.queueCount === 0,
    `${caseMarker}: workspace ${task.label} 续发没有回到 idle`,
    SSH_LIFECYCLE_TURN_TIMEOUT_MS,
  );
}

export async function reconnectSSHWorkspaceThroughUI(options: {
  caseMarker: string;
  config: SSHConnectionConfig;
  workspacePath: string;
}): Promise<{
  remoteSessionId: string;
  identity: string;
}> {
  const identity = buildSSHIdentity(options.config, options.workspacePath);
  await startNewV4Draft();
  await openSSHRemoteDialog(options.caseMarker);
  await fillSSHPasswordSettings(options.config);
  await clickLastEnabledSSHDialogButton(options.caseMarker);
  await waitForSSHDirectoryStep(options.caseMarker);
  await selectSSHRemoteDirectory(options.workspacePath, options.caseMarker);
  await waitForWorkspaceApp(
    options.workspacePath,
    SSH_WORKSPACE_READY_TIMEOUT_MS,
  );
  const tab = await waitForRemoteTab({
    caseMarker: options.caseMarker,
    expectedIdentity: identity,
    expectedPath: options.workspacePath,
  });
  if (!tab.remoteSessionId) {
    throw new Error(`${options.caseMarker}: 重连后缺少 remoteSessionId`);
  }
  expect(tab.remoteKind).toBe("ssh");
  expect(tab.remoteHost).toBe(options.config.host);
  expect(tab.secretPersistedInTab).toBe(false);
  return { identity, remoteSessionId: tab.remoteSessionId };
}

export async function removeSSHWorkspace(
  workspacePath: string,
  caseMarker: string,
): Promise<void> {
  const workspaceItemId = testId(TID_WORKSPACE_ITEM, workspacePath);
  await browser.waitUntil(
    async () =>
      browser.execute((itemId) => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>("[data-testid]"),
        ).find((candidate) => candidate.dataset.testid === itemId);
        if (!item) return false;
        const moreButton = Array.from(
          item.closest("li")?.querySelectorAll<HTMLButtonElement>("button") ??
            [],
        ).find((button) => {
          const label = (button.getAttribute("aria-label") ?? "").toLowerCase();
          return label.includes("more") || label.includes("更多");
        });
        if (!moreButton) return false;
        moreButton.click();
        return true;
      }, workspaceItemId),
    {
      timeout: 30_000,
      timeoutMsg: `${caseMarker}: workspace ${workspacePath} 没有显示更多菜单入口`,
    },
  );
  await clickTestIdByDom(testId(TID_WORKSPACE_CLOSE, workspacePath), {
    timeout: 15_000,
    timeoutMsg: `${caseMarker}: workspace ${workspacePath} 没有显示移除入口`,
  });
  await browser.waitUntil(
    () =>
      browser.execute((itemId) => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>("[data-testid]"),
        ).find((candidate) => candidate.dataset.testid === itemId);
        return !item;
      }, workspaceItemId),
    {
      timeout: 30_000,
      timeoutMsg: `${caseMarker}: workspace ${workspacePath} 移除后仍在侧栏`,
    },
  );
}

export async function waitForRemoteWorkspaceDisconnected(
  identity: string,
  caseMarker: string,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        const snapshot = await readRemoteTabSnapshot(identity);
        return (
          snapshot.workspaceIdentity === identity &&
          snapshot.remoteSessionId === null
        );
      } catch {
        return false;
      }
    },
    {
      timeout: SSH_WORKSPACE_READY_TIMEOUT_MS,
      timeoutMsg: `${caseMarker}: remote workspace 没有进入 disconnected 保留态`,
    },
  );
}

export async function reconnectSSHWorkspace(
  workspacePath: string,
  caseMarker: string,
): Promise<void> {
  const workspaceItemId = testId(TID_WORKSPACE_ITEM, workspacePath);
  await browser.waitUntil(
    async () =>
      browser.execute((itemId) => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>("[data-testid]"),
        ).find((candidate) => candidate.dataset.testid === itemId);
        const button = Array.from(
          item?.closest("li")?.querySelectorAll<HTMLButtonElement>("button") ??
            [],
        ).find((candidate) => {
          const label = (candidate.getAttribute("aria-label") ?? "").toLowerCase();
          return label.includes("reconnect") || label.includes("重新连接");
        });
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, workspaceItemId),
    {
      timeout: 30_000,
      timeoutMsg: `${caseMarker}: workspace ${workspacePath} 没有显示可用的重连按钮`,
    },
  );
}

export async function listRemoteZCodeServerPids(
  config: SSHConnectionConfig,
): Promise<number[]> {
  const result = await runSSHCommand(config, "ps -eo pid=,args=");
  if (result.code !== 0) {
    throw new Error(`读取远端 zcode-server PID 失败: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+.*(?:^|\s)zcode-server\.cjs(?:\s|$)/u);
      return match ? [Number.parseInt(match[1]!, 10)] : [];
    })
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

export async function stopOwnedSSHServer(
  config: SSHConnectionConfig,
  beforePids: readonly number[],
  caseMarker: string,
): Promise<number> {
  const currentPids = await listRemoteZCodeServerPids(config);
  const owned = currentPids.filter((pid) => !beforePids.includes(pid));
  if (owned.length !== 1) {
    throw new Error(
      `${caseMarker}: 只允许终止本 case 新建的一个 zcode-server，before=${beforePids.join(",")}, current=${currentPids.join(",")}`,
    );
  }
  const pid = owned[0]!;
  const result = await runSSHCommand(config, `kill -TERM -- ${pid}`);
  if (result.code !== 0) {
    throw new Error(`${caseMarker}: 终止远端 zcode-server ${pid} 失败: ${result.stderr}`);
  }
  await browser.waitUntil(
    async () => !(await listRemoteZCodeServerPids(config)).includes(pid),
    {
      timeout: SSH_WORKSPACE_READY_TIMEOUT_MS,
      timeoutMsg: `${caseMarker}: 远端 zcode-server ${pid} 没有退出`,
    },
  );
  return pid;
}

export async function waitForRendererAfterColdRestart(
  caseMarker: string,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const target = puppeteer
          .targets()
          .find((candidate) => candidate.url().includes("/renderer/index.html"));
        const targetId = target
          ? ((target as unknown as { _targetId?: string })._targetId ?? null)
          : null;
        if (!targetId) return false;
        await browser.switchToWindow(targetId);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: `${caseMarker}: cold restart 后没有找到 renderer target`,
    },
  );
}

export async function readTaskRowInWorkspace(
  task: SSHLifecycleTask,
  caseMarker: string,
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((taskId, workspaceId) => {
        const taskRow = Array.from(
          document.querySelectorAll<HTMLElement>("[data-testid]"),
        ).find((candidate) => candidate.dataset.testid === taskId);
        const workspaceRow = Array.from(
          document.querySelectorAll<HTMLElement>("[data-testid]"),
        ).find((candidate) => candidate.dataset.testid === workspaceId);
        return Boolean(
          taskRow &&
            workspaceRow?.closest("li")?.contains(taskRow) &&
            !taskRow.querySelector('[data-error-indicator="true"]'),
        );
      }, testId(TID_TASK_ITEM, task.taskId), testId(TID_WORKSPACE_ITEM, task.workspacePath)),
    {
      timeout: 30_000,
      timeoutMsg: `${caseMarker}: task ${task.label} 没有恢复到正确 workspace`,
    },
  );
}

export function buildSSHIdentity(
  config: SSHConnectionConfig,
  workspacePath: string,
): string {
  const target: RemoteTarget = {
    kind: "ssh",
    host: config.host,
    port: config.port,
    username: config.username,
  };
  return buildRemoteWorkspaceIdentity(workspacePath, target);
}

export async function prepareSSHLifecycle(
  caseMarker: string,
): Promise<{
  config: SSHRuntimeConfig;
  initialHosts: Array<{ name: string; pid: number }>;
  provider: SSHLifecycleProvider;
}> {
  const config = readSSHRuntimeConfig(caseMarker);
  await prepareV4ConversationE2E({ skipProvider: true });
  const initialHosts = await readHostProcesses();
  expect(initialHosts).toHaveLength(1);
  const provider = await createSSHLifecycleProvider(config, caseMarker);
  return { config, initialHosts, provider };
}
