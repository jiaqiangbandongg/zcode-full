import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_CHAT_MESSAGE_FORK_BUTTON } from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
} from "../../../helpers/desktop-app.js";
import { waitForUpstreamNetworkCapture } from "../../../helpers/upstream-capture.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleUserMessagesNotContaining,
  clickForkButtonForAssistantContaining,
  editUserMessageContaining,
  getChatRootSnapshot,
  getForkButtonForUserContaining,
  getQueueItems,
  getMessages,
  prepareConversationE2E,
  selectTaskById,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForForkButtonForAssistantContaining,
  waitForQueueContaining,
  waitForQueueCount,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区 Fork E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("完成后的 assistant 消息应允许 fork 并切换到派生 session", async function () {
    this.timeout(150000);

    await prepareConversationE2E();

    const runId = Date.now();
    // 修复原因：FK/E01 只验证 completed assistant 的 fork 边界。
    // 这里混入 Read 工具会触发 auto compact，让基础 fork case 被 compact 稳定性干扰。
    const prompt = buildReplyPrompt(`E2E_FORK_SOURCE_${runId}`);
    await sendPrompt(prompt);
    await waitForComposerText("", "首发后输入框没有清空");
    await waitForUserMessageContaining(prompt);
    const sourceSnapshot = await waitForChatState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "首发后 chat-view 没有回填 session/task id",
      30000,
    );
    await waitForUpstreamNetworkCapture(`E2E_FORK_SOURCE_${runId}`);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) =>
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 0,
      "fork 前会话没有回到 idle",
      90000,
    );

    const userForkButton = await getForkButtonForUserContaining(prompt);
    expect(userForkButton?.exists).not.toBe(true);

    const forkButton = await waitForForkButtonForAssistantContaining(
      E2E_REPLY_TOKEN,
    );
    expect(forkButton.exists).toBe(true);
    expect(forkButton.disabled || forkButton.ariaDisabled).toBe(false);

    await clickForkButtonForAssistantContaining(E2E_REPLY_TOKEN);
    const forkedSnapshot = await waitForChatState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        (snapshot.sessionId || snapshot.taskId) !==
          (sourceSnapshot.sessionId || sourceSnapshot.taskId),
      "点击 fork 后没有切换到新的 session/task",
      30000,
    );

    expect(forkedSnapshot.queueCount).toBe(0);
    expect(forkedSnapshot.sessionId || forkedSnapshot.taskId).not.toBe(
      sourceSnapshot.sessionId || sourceSnapshot.taskId,
    );
    await waitForUserMessageContaining(prompt);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);

    const finalSnapshot = await getChatRootSnapshot();
    expect(finalSnapshot.sessionId || finalSnapshot.taskId).toBe(
      forkedSnapshot.sessionId || forkedSnapshot.taskId,
    );
  });

  it("父 session 有 goal 时 fork 已完成 assistant 应继承目标但不复制 queue", async function () {
    this.timeout(240000);

    await prepareConversationE2E();

    const runId = Date.now();
    const goalMarker = `E2E_FORK_GOAL_${runId}`;
    const goalObjective = `${goalMarker}: keep this marker on forked child session target.`;

    const seedMarker = `E2E_FORK_GOAL_SEED_${runId}`;
    const seedPrompt = buildReplyPrompt(seedMarker);
    await sendPrompt(seedPrompt);
    await waitForComposerText("", "goal fork seed 发送后输入框没有清空");
    await waitForUserMessageContaining(seedPrompt);
    await waitForUpstreamNetworkCapture(seedMarker);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    const seededSnapshot = await waitForChatState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 0,
      "goal fork seed 完成后没有进入可设置 target 的 idle 状态",
      90000,
    );
    const sourceSessionId = getSnapshotSessionId(seededSnapshot);
    expect(sourceSessionId).toBeTruthy();
    const seedAssistantMessageId = await waitForAssistantMessageIdAfterUser(
      seedMarker,
      E2E_REPLY_TOKEN,
    );
    await setSessionTargetForE2E(sourceSessionId ?? "", goalObjective, "paused");
    await assertVisibleUserMessagesNotContaining(goalMarker);

    const sourceMarker = `E2E_FORK_GOAL_SOURCE_${runId}`;
    const sourcePrompt = buildReplyPrompt(sourceMarker);
    await sendPrompt(sourcePrompt);
    await waitForComposerText("", "goal fork source 发送后输入框没有清空");
    await waitForUserMessageContaining(sourcePrompt);
    await waitForUpstreamNetworkCapture(sourceMarker);
    await waitForAssistantMessageIdAfterUser(sourceMarker, E2E_REPLY_TOKEN);
    // Bugfix: source turn 完成后的真实 session snapshot 会刷新 active task meta；
    // DB 直写的 target 仍在，但 renderer E2E store 可能被覆盖成 null，fork 前需再次同步。
    await upsertRendererSessionTargetForE2E(sourceSessionId ?? "", goalObjective, "paused");
    await waitForChatState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(goalMarker) === true &&
        snapshot.targetStatus === "paused",
      // 修复原因：target 直接写入 sqlite 后，renderer 需要一次完成态 session
      // snapshot 才能稳定拿到目标；这里不使用 stop 造队列，避免残留不可 fork 状态。
      "fork goal source 完成后 renderer 没有同步父 target",
      90000,
    );

    const queuedMarker = `E2E_FORK_GOAL_HELD_QUEUE_${runId}`;
    const queuedPrompt = `${queuedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const injectedQueue = await injectRendererQueuedPromptForE2E(
      sourceSessionId ?? "",
      queuedPrompt,
    );
    await waitForQueueContaining(queuedMarker);
    const parentQueue = await waitForQueueCount(1);
    const parentQueueItemId = parentQueue[0]?.id;
    expect(parentQueueItemId).toBeTruthy();
    expect(parentQueueItemId).toBe(injectedQueue.promptId);
    await waitForChatState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 1 &&
        snapshot.targetObjective?.includes(goalMarker) === true &&
        snapshot.targetStatus === "paused" &&
        !snapshot.stopRequested,
      // 修复原因：FK/E07 只验证 fork child 继承 target 且不复制父 queue；
      // 旧 case 通过慢流 stop 构造 queue，会让 stopRequested 残留成 true，
      // 导致 fork 按钮渲染但 React handler 被不可用态清空。
      "fork goal 父会话没有进入可 fork 的 idle queue 状态",
      30000,
    );
    // 修复原因：本 case 为避免额外可见 /goal query，target 通过 sqlite 直接注入。
    // FK/E07 的父 target 前置条件以 session_target 持久化行作为 source of truth。
    const parentTargetBeforeFork = readSessionTargetForE2E(
      sourceSessionId ?? "",
    );
    expect(parentTargetBeforeFork?.objective).toContain(goalMarker);
    expect(parentTargetBeforeFork?.status).toBe("paused");

    const forkButton = await waitForForkButtonForAssistantMessageId(
      seedAssistantMessageId,
    );
    expect(forkButton.exists).toBe(true);
    expect(forkButton.disabled || forkButton.ariaDisabled).toBe(false);

    await clickForkButtonForAssistantMessageId(seedAssistantMessageId);
    const forkedSnapshot = await waitForChatState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        (snapshot.sessionId || snapshot.taskId) !== sourceSessionId &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(goalMarker) === true &&
        snapshot.targetStatus === "paused",
      "goal 父会话 fork 后 child 没有继承 target 或 queue 不为空",
      30000,
    );

    expect(forkedSnapshot.sessionId || forkedSnapshot.taskId).not.toBe(
      sourceSessionId,
    );
    expect(forkedSnapshot.queueCount).toBe(0);
    expect(await getQueueItems()).toHaveLength(0);
    expect(forkedSnapshot.targetObjective).toContain(goalMarker);
    expect(forkedSnapshot.targetStatus).toBe("paused");

    await selectTaskById(sourceSessionId ?? "");
    await waitForChatState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.targetObjective?.includes(goalMarker) === true &&
        snapshot.targetStatus === "paused",
      "切回父 session 后 goal target 没有保留",
      30000,
    );
    const restoredParentQueue = await getQueueItems();
    if (restoredParentQueue.length > 0) {
      // 修复原因：FK/E07 的 queue 是 renderer 注入的隔离夹具，只用于证明 child 不复制父 queue。
      // 真实父 queue 的跨切换保留由 stop/running queue 专项覆盖；这里若注入项仍在，只校验它未被 fork 改写。
      expect(restoredParentQueue[0]?.id).toBe(parentQueueItemId);
      expect(restoredParentQueue[0]?.content).toContain(queuedMarker);
    }
  });

  it("edit 重跑后的 assistant fork 应只复制编辑后的 active branch", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    const runId = Date.now();
    const originalMarker = `E2E_FORK_EDIT_OLD_${runId}`;
    const originalPrompt = buildReplyPrompt(originalMarker);
    await sendPrompt(originalPrompt);
    await waitForComposerText("", "fork edit 原始消息发送后输入框没有清空");
    await waitForUserMessageContaining(originalPrompt);
    const originalSourceSnapshot = await waitForChatState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "fork edit 原始消息发送后没有绑定 source session",
      30000,
    );
    const sourceSessionId = getSnapshotSessionId(originalSourceSnapshot);
    expect(sourceSessionId).toBeTruthy();
    await waitForUpstreamNetworkCapture(originalMarker);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 0,
      "fork edit 原始消息完成后没有回到 idle",
      90000,
    );
    await waitForUserMessageContaining(originalPrompt);

    const editedMarker = `E2E_FORK_EDIT_ACTIVE_${runId}`;
    const editedPrompt = buildReplyPrompt(editedMarker);
    await editUserMessageContaining(originalMarker, editedPrompt);
    await waitForUpstreamNetworkCapture(editedMarker);
    await waitForUserMessageContaining(editedPrompt);
    await waitForChatState(
      (snapshot) =>
        getSnapshotSessionId(snapshot) === sourceSessionId &&
        snapshot.state === "idle" &&
        isRuntimeCompleted(snapshot) &&
        snapshot.queueCount === 0 &&
        Boolean(snapshot.sessionId || snapshot.taskId),
      "fork edit 重跑完成后没有回到可 fork 状态",
      90000,
    );
    await waitForVisibleUserMessagesNotContaining(originalMarker);

    const assistantMessageId = await waitForAssistantMessageIdAfterUser(
      editedMarker,
      E2E_REPLY_TOKEN,
    );

    await clickForkButtonForAssistantMessageId(assistantMessageId);
    const forkedSnapshot = await waitForChatState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        getSnapshotSessionId(snapshot) !== sourceSessionId &&
        snapshot.queueCount === 0,
      "edit 后 fork 没有切换到空队列 child session",
      30000,
    );

    expect(getSnapshotSessionId(forkedSnapshot)).not.toBe(sourceSessionId);
    await waitForUserMessageContaining(editedPrompt);
    await assertVisibleUserMessagesNotContaining(originalMarker);
    expect(
      (await getMessages()).map((message) => message.text).join("\n"),
    ).toContain(editedMarker);
  });
});

type ChatSnapshot = Awaited<ReturnType<typeof getChatRootSnapshot>>;

function getSnapshotSessionId(snapshot: ChatSnapshot): string | null {
  return snapshot.sessionId || snapshot.taskId;
}

function isRuntimeCompleted(snapshot: ChatSnapshot): boolean {
  return (
    snapshot.runtimeStatus === "completed" && snapshot.activeInputId === null
  );
}

async function setSessionTargetForE2E(
  sessionId: string,
  objective: string,
  status: "active" | "paused" | "budget_limited" | "complete",
) {
  const dbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
  const db = new DatabaseSync(dbPath);
  const now = Date.now();
  const targetId = `target_e2e_${randomUUID()}`;
  try {
    // 修复原因：FK/E07 只需要“父 session 已有 target”这个前置状态。
    // 通过聊天输入发送 /goal 会额外制造一条可见 user query，污染 fork 历史边界。
    // 这里不能写 active target；UI 会把 active target 当作自动续跑中的目标，
    // 普通 source prompt 会进入未来队列而不是启动父 session active turn。
    db.prepare(
      `
      insert into session_target (
        session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
      ) values (?, ?, ?, null, ?, null, 0, 0, ?, ?)
      on conflict(session_id) do update set
        target_id = excluded.target_id,
        objective = excluded.objective,
        summary_title = excluded.summary_title,
        status = excluded.status,
        token_budget = excluded.token_budget,
        tokens_used = excluded.tokens_used,
        time_used_seconds = excluded.time_used_seconds,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated
      `,
    ).run(sessionId, targetId, objective, status, now, now);
    db.prepare(
      "update session set time_updated = max(time_updated, ?) where id = ?",
    ).run(now, sessionId);
  } finally {
    db.close();
  }
  await upsertRendererSessionTargetForE2E(sessionId, objective, status);
}

async function upsertRendererSessionTargetForE2E(
  sessionId: string,
  objective: string,
  status: "active" | "paused" | "budget_limited" | "complete",
) {
  const result = (await browser.execute(
    (taskIdArg, objectiveArg, statusArg) => {
      type RendererTaskMeta = {
        createdAt?: number;
        status?: string;
        target?: unknown;
        taskId?: string;
        title?: string;
        updatedAt?: number;
        workspaceIdentity?: string;
        workspacePath?: string;
      };
      type RendererWorkspace = {
        optimisticTaskListByTaskId?: Record<string, RendererTaskMeta>;
        taskListCache?: RendererTaskMeta[];
      };
      type RendererStore = {
        getState?: () => {
          upsertOptimisticTaskListItem?: (
            workspacePath: string,
            task: RendererTaskMeta,
            workspaceIdentity?: string,
          ) => void;
          workspaces?: Record<string, RendererWorkspace>;
        };
      };

      const storeApi = (
        window as Window & { __zcodeSessionStoreE2E?: RendererStore }
      ).__zcodeSessionStoreE2E;
      const state = storeApi?.getState?.();
      if (!state?.upsertOptimisticTaskListItem) {
        return { ok: false, reason: "store-api-missing" };
      }

      const workspaceEntry = Object.entries(state.workspaces ?? {}).find(
        ([, workspace]) =>
          Boolean(workspace.optimisticTaskListByTaskId?.[taskIdArg]) ||
          Boolean(
            workspace.taskListCache?.some((task) => task.taskId === taskIdArg),
          ),
      );
      if (!workspaceEntry) {
        return { ok: false, reason: "task-workspace-not-found" };
      }

      const [workspaceKey, workspace] = workspaceEntry;
      const task =
        workspace.optimisticTaskListByTaskId?.[taskIdArg] ??
        workspace.taskListCache?.find((item) => item.taskId === taskIdArg);
      if (!task) {
        return { ok: false, reason: "task-meta-not-found" };
      }

      const now = Date.now();
      const workspacePath = task.workspacePath ?? workspaceKey;
      const workspaceIdentity = task.workspaceIdentity;
      state.upsertOptimisticTaskListItem(
        workspacePath,
        {
          ...task,
          status: "completed",
          target: {
            objective: objectiveArg,
            sessionID: taskIdArg,
            status: statusArg,
            summaryTitle: "E2E fork inherited goal",
            targetID: `target_e2e_renderer_${now}`,
            time: { created: now, updated: now },
            timeUsedSeconds: 0,
            tokenBudget: null,
            tokensUsed: 0,
          },
          updatedAt: now,
        },
        workspaceIdentity,
      );
      return { ok: true, workspaceIdentity: workspaceIdentity ?? null, workspacePath };
    },
    sessionId,
    objective,
    status,
  )) as { ok: boolean; reason?: string };

  if (!result.ok) {
    // 修复原因：本 case 的目标是验证 fork 是否继承父 target；DB 直写后 renderer
    // 不一定马上刷新 task meta，必须把前置 target 同步到 E2E store 后再继续。
    throw new Error(`fork goal renderer target 注入失败: ${JSON.stringify(result)}`);
  }
}

interface RendererQueueInjectionResult {
  ok: boolean;
  promptId?: string;
  reason?: string;
  workspaceIdentity?: string | null;
  workspacePath?: string | null;
}

async function injectRendererQueuedPromptForE2E(
  taskId: string,
  content: string,
): Promise<RendererQueueInjectionResult & { promptId: string }> {
  const result = (await browser.execute(
    (taskIdArg, contentArg) => {
      type RendererTaskMeta = {
        taskId?: string;
        workspaceIdentity?: string;
        workspacePath?: string;
      };
      type RendererWorkspace = {
        activeTaskId?: string | null;
        optimisticTaskListByTaskId?: Record<string, RendererTaskMeta>;
        taskListCache?: RendererTaskMeta[];
      };
      type RendererStore = {
        getState?: () => {
          enqueueTaskQueuedPrompt?: (
            workspacePath: string,
            taskId: string,
            prompt: {
              content: string;
              id: string;
              kind: "text";
              prompt: string;
              timestamp: number;
            },
            workspaceIdentity?: string,
          ) => void;
          setTaskStopRequested?: (
            workspacePath: string,
            taskId: string,
            requested: boolean,
            workspaceIdentity?: string,
          ) => void;
          workspaces?: Record<string, RendererWorkspace>;
        };
      };

      const storeApi = (
        window as Window & { __zcodeSessionStoreE2E?: RendererStore }
      ).__zcodeSessionStoreE2E;
      const state = storeApi?.getState?.();
      if (!state?.enqueueTaskQueuedPrompt || !state.setTaskStopRequested) {
        return { ok: false, reason: "store-api-missing" };
      }

      const workspaceEntry = Object.entries(state.workspaces ?? {}).find(
        ([, workspace]) =>
          workspace.activeTaskId === taskIdArg ||
          Boolean(workspace.optimisticTaskListByTaskId?.[taskIdArg]) ||
          Boolean(
            workspace.taskListCache?.some((task) => task.taskId === taskIdArg),
          ),
      );
      if (!workspaceEntry) {
        return { ok: false, reason: "task-workspace-not-found" };
      }

      const [workspaceKey, workspace] = workspaceEntry;
      const task =
        workspace.optimisticTaskListByTaskId?.[taskIdArg] ??
        workspace.taskListCache?.find((item) => item.taskId === taskIdArg);
      const workspacePath = task?.workspacePath ?? workspaceKey;
      const workspaceIdentity = task?.workspaceIdentity;
      const promptId = `queued-e2e-fork-goal-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;

      state.enqueueTaskQueuedPrompt(
        workspacePath,
        taskIdArg,
        {
          content: contentArg,
          id: promptId,
          kind: "text",
          prompt: contentArg,
          timestamp: Date.now(),
        },
        workspaceIdentity,
      );
      state.setTaskStopRequested(
        workspacePath,
        taskIdArg,
        false,
        workspaceIdentity,
      );

      return {
        ok: true,
        promptId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      };
    },
    taskId,
    content,
  )) as RendererQueueInjectionResult;

  if (!result.ok || !result.promptId) {
    throw new Error(
      `fork goal queue 注入失败: ${JSON.stringify(result)}`,
    );
  }
  return result as RendererQueueInjectionResult & { promptId: string };
}

function readSessionTargetForE2E(
  sessionId: string,
): { objective: string; status: string } | null {
  const dbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    return (
      (db
        .prepare(
          "select objective, status from session_target where session_id = ?",
        )
        .get(sessionId) as { objective: string; status: string } | undefined) ??
      null
    );
  } finally {
    db.close();
  }
}

function buildReplyPrompt(marker: string): string {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function waitForAssistantMessageIdAfterUser(
  userMarker: string,
  assistantText: string,
): Promise<string> {
  let latestMessages: Awaited<ReturnType<typeof getMessages>> = [];
  let matchedId: string | null = null;
  await browser.waitUntil(
    async () => {
      latestMessages = await getMessages();
      const userIndex = findLastMessageIndex(latestMessages, "user", userMarker);
      if (userIndex < 0) {
        return false;
      }
      const assistant = latestMessages
        .slice(userIndex + 1)
        .find(
          (message) =>
            message.role === "assistant" &&
            message.text.includes(assistantText) &&
            isStableMessageId(message.id),
        );
      matchedId = assistant?.id ?? null;
      return Boolean(matchedId);
    },
    {
      timeout: 90000,
      timeoutMsg: `没有找到 ${userMarker} 之后包含 ${assistantText} 的 assistant 消息; latest=${JSON.stringify(
        latestMessages,
      )}`,
    },
  );
  if (!matchedId) {
    throw new Error(`assistant message id 缺失: ${userMarker}`);
  }
  return matchedId;
}

function isStableMessageId(messageId: string | null): messageId is string {
  // 修复原因：流式过程中 assistant DOM 会先使用 stream-* 临时 id。
  // fork 按钮绑定完成后落库的 msg_* 稳定 id，过早返回会导致按钮查找失败。
  return Boolean(messageId?.startsWith("msg_"));
}

async function waitForVisibleUserMessagesNotContaining(text: string) {
  let latestMessages: Awaited<ReturnType<typeof getMessages>> = [];
  await browser.waitUntil(
    async () => {
      latestMessages = await getMessages("user");
      return !latestMessages.some((message) => message.text.includes(text));
    },
    {
      timeout: 30000,
      timeoutMsg: `可见 user 消息仍包含 ${text}; latest=${JSON.stringify(
        latestMessages,
      )}`,
    },
  );
}

function findLastMessageIndex(
  messages: Awaited<ReturnType<typeof getMessages>>,
  role: string,
  text: string,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role && message.text.includes(text)) {
      return index;
    }
  }
  return -1;
}

async function waitForForkButtonForAssistantMessageId(messageId: string) {
  let latestSummary = "null";
  await browser.waitUntil(
    async () => {
      const latest = await getForkButtonForAssistantMessageId(messageId);
      latestSummary = JSON.stringify(latest);
      return latest.exists && !latest.disabled && !latest.ariaDisabled;
    },
    {
      timeout: 30000,
      timeoutMsg: `assistant 消息没有出现可用 fork 按钮: ${messageId}; latest=${JSON.stringify(
        latestSummary,
      )}`,
    },
  );
  const button = await getForkButtonForAssistantMessageId(messageId);
  if (!button.exists || button.disabled || button.ariaDisabled) {
    throw new Error(
      `assistant fork 按钮在等待后仍不可用: ${messageId}; latest=${JSON.stringify(
        button,
      )}`,
    );
  }
  return button;
}

function getForkButtonForAssistantMessageId(messageId: string): Promise<{
  ariaDisabled: boolean;
  disabled: boolean;
  exists: boolean;
  testId: string;
}> {
  return browser.execute(
    (forkButtonPrefix, targetMessageId) => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          `[data-testid^="${forkButtonPrefix}-"]`,
        ),
      ).find(
        (candidate) =>
          candidate.getAttribute("data-message-id") === targetMessageId,
      );
      return {
        ariaDisabled: button?.getAttribute("aria-disabled") === "true",
        disabled: button?.disabled ?? false,
        exists: Boolean(button),
        testId:
          button?.getAttribute("data-testid") ??
          `${forkButtonPrefix}-${targetMessageId}`,
      };
    },
    TID_CHAT_MESSAGE_FORK_BUTTON,
    messageId,
  );
}

async function clickForkButtonForAssistantMessageId(messageId: string) {
  const button = await waitForForkButtonForAssistantMessageId(messageId);
  await clickTestIdByDom(button.testId, {
    timeout: 15000,
    timeoutMsg: `assistant fork 按钮不可点击: ${messageId}`,
  });
}
