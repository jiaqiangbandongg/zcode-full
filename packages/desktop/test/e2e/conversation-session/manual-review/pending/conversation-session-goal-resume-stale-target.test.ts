import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  clickChatStop,
  clickFirstQueueSendNow,
  getChatRootSnapshot,
  prepareConversationE2E,
  selectTaskById,
  sendPrompt,
  startNewTask,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForUpstreamRequestContaining,
  waitForQueueContaining,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const CASE_TIMEOUT_MS = 180000;

type GoalStatusForE2E = "active" | "paused" | "complete";

interface TaskIndexRowForE2E {
  meta_json?: string | null;
}

interface TaskIndexMetaForE2E {
  createdAt?: number;
  status?: string;
  target?: unknown;
  taskId?: string;
  updatedAt?: number;
  workspaceIdentity?: string;
  workspacePath?: string;
}

interface RendererInjectionResult {
  ok: boolean;
  previousTargetStatus?: string | null;
  reason?: string;
  workspaceIdentity?: string | null;
  workspacePath?: string | null;
}

describe("会话区 Goal 恢复 stale target 复现", () => {
  before(async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await prepareConversationE2E();
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("paused target 恢复后队列 item 点立即发送不能被 stale active task meta 卡住", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    const runId = Date.now();
    const seedMarker = `E2E_GOAL_RESUME_STALE_SEED_${runId}`;
    await sendPrompt(buildReplyPrompt(seedMarker));
    await waitForUserMessageContaining(seedMarker);
    await waitForUpstreamRequestContaining(seedMarker);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);

    const completedSnapshot = await waitForChatState(
      (snapshot) =>
        Boolean(snapshot.taskId) &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.activeInputId === null,
      "seed task 没有回到 completed idle 状态",
      90000,
    );
    const taskId = completedSnapshot.taskId;
    if (!taskId) {
      throw new Error(`seed task 缺少 taskId: ${JSON.stringify(completedSnapshot)}`);
    }

    await waitForTaskIndexRow(taskId);

    const objective = `E2E_GOAL_RESUME_STALE_OBJECTIVE_${runId}`;
    // 复现原因：用户日志里 agent 侧 session_target 已经 paused，
    // 但 app task index / renderer meta 仍残留 active target，且 queue item 点立即发送也无法出队。
    await setSessionTargetForE2E(taskId, objective, "paused");
    await setTaskIndexTargetForE2E(taskId, objective, "active");

    await startNewTask();
    await selectTaskById(taskId);
    await waitForChatState(
      (snapshot) =>
        snapshot.taskId === taskId &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.activeInputId === null,
      "stale target task 恢复后没有停在 completed idle 状态",
      60000,
    );
    await injectRendererTaskMetaTargetForE2E(taskId, objective, "active");
    await waitForRendererTaskMetaTargetStatusForE2E(taskId, "active");

    const queuedMarker = `E2E_GOAL_RESUME_STALE_SEND_NOW_${runId}`;
    await injectRendererQueuedPromptForE2E(taskId, buildReplyPrompt(queuedMarker));
    await waitForQueueContaining(queuedMarker);

    const sentNowItem = await clickFirstQueueSendNow();
    expect(sentNowItem.kind).toBe("text");
    expect(sentNowItem.content).toContain(queuedMarker);

    await waitForChatState(
      (snapshot) =>
        snapshot.taskId === taskId &&
        snapshot.queueCount === 0 &&
        snapshot.activeInputId !== null &&
        (snapshot.runtimeStatus === "running" ||
          snapshot.runtimeStatus === "streaming"),
      "队列 item 点立即发送后仍被 stale active goal meta 卡住，没有作为新一轮发送",
      15000,
    );
    await waitForUpstreamRequestContaining(queuedMarker);
  });
});

async function stopIfBusy() {
  const snapshot = await getChatRootSnapshot();
  if (snapshot.activeInputId || snapshot.runtimeStatus === "streaming") {
    await clickChatStop().catch(() => undefined);
  }
}

function buildReplyPrompt(marker: string): string {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function waitForTaskIndexRow(taskId: string) {
  await browser.waitUntil(async () => Boolean(readTaskIndexMetaForE2E(taskId)), {
    timeout: 15000,
    timeoutMsg: `task index 没有写入 task: ${taskId}`,
  });
}

function setSessionTargetForE2E(
  sessionId: string,
  objective: string,
  status: GoalStatusForE2E,
) {
  const dbPath = join(homedir(), ".zcode", "cli", "db", "db.sqlite");
  const db = new DatabaseSync(dbPath);
  const now = Date.now();
  const targetId = `target_e2e_${randomUUID()}`;
  try {
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
}

function setTaskIndexTargetForE2E(
  taskId: string,
  objective: string,
  status: GoalStatusForE2E,
) {
  const meta = readTaskIndexMetaForE2E(taskId);
  if (!meta) {
    throw new Error(`task index 缺少 task: ${taskId}`);
  }

  const now = Date.now();
  const nextMeta: TaskIndexMetaForE2E = {
    ...meta,
    status: "completed",
    target: buildTaskTargetForE2E(taskId, objective, status, now),
    updatedAt: now,
  };

  const db = new DatabaseSync(taskIndexDbPath());
  try {
    db.prepare(
      `
      update tasks
      set task_status = 'completed',
          updated_at = ?,
          meta_json = ?
      where task_id = ?
      `,
    ).run(now, JSON.stringify(nextMeta), taskId);
  } finally {
    db.close();
  }
}

function readTaskIndexMetaForE2E(
  taskId: string,
): TaskIndexMetaForE2E | null {
  const db = new DatabaseSync(taskIndexDbPath());
  try {
    const row = db
      .prepare("select meta_json from tasks where task_id = ?")
      .get(taskId) as TaskIndexRowForE2E | undefined;
    if (!row?.meta_json) {
      return null;
    }
    return JSON.parse(row.meta_json) as TaskIndexMetaForE2E;
  } finally {
    db.close();
  }
}

function taskIndexDbPath() {
  return join(homedir(), ".zcode", "v2", "tasks-index.sqlite");
}

async function injectRendererTaskMetaTargetForE2E(
  taskId: string,
  objective: string,
  status: GoalStatusForE2E,
) {
  const result = (await browser.execute(
    (taskIdArg, objectiveArg, statusArg) => {
      type RendererTaskMeta = {
        createdAt?: number;
        status?: string;
        target?: unknown;
        taskId?: string;
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
      const nextTask: RendererTaskMeta = {
        ...task,
        status: "completed",
        target: {
          objective: objectiveArg,
          sessionID: taskIdArg,
          status: statusArg,
          summaryTitle: "E2E stale active goal",
          targetID: `target_e2e_renderer_${now}`,
          time: { created: now, updated: now },
          timeUsedSeconds: 0,
          tokenBudget: null,
          tokensUsed: 0,
        },
        updatedAt: now,
      };
      state.upsertOptimisticTaskListItem(
        workspacePath,
        nextTask,
        workspaceIdentity,
      );

      return {
        ok: true,
        previousTargetStatus:
          typeof task.target === "object" &&
          task.target !== null &&
          "status" in task.target
            ? String(task.target.status)
            : null,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      };
    },
    taskId,
    objective,
    status,
  )) as RendererInjectionResult;

  if (!result.ok) {
    throw new Error(`renderer task meta 注入失败: ${JSON.stringify(result)}`);
  }
}

async function waitForRendererTaskMetaTargetStatusForE2E(
  taskId: string,
  status: GoalStatusForE2E,
) {
  await browser.waitUntil(
    async () => (await readRendererTaskMetaTargetStatusForE2E(taskId)) === status,
    {
      timeout: 10000,
      timeoutMsg: `renderer task meta target status 没有变为 ${status}`,
    },
  );
}

function readRendererTaskMetaTargetStatusForE2E(taskId: string) {
  return browser.execute((taskIdArg) => {
    type RendererTaskMeta = { target?: unknown; taskId?: string };
    type RendererWorkspace = {
      optimisticTaskListByTaskId?: Record<string, RendererTaskMeta>;
      taskListCache?: RendererTaskMeta[];
    };
    type RendererStore = {
      getState?: () => { workspaces?: Record<string, RendererWorkspace> };
    };
    const storeApi = (
      window as Window & { __zcodeSessionStoreE2E?: RendererStore }
    ).__zcodeSessionStoreE2E;
    const state = storeApi?.getState?.();
    for (const workspace of Object.values(state?.workspaces ?? {})) {
      const task =
        workspace.optimisticTaskListByTaskId?.[taskIdArg] ??
        workspace.taskListCache?.find((item) => item.taskId === taskIdArg);
      const target = task?.target;
      if (target && typeof target === "object" && "status" in target) {
        return String(target.status);
      }
    }
    return null;
  }, taskId);
}

async function injectRendererQueuedPromptForE2E(taskId: string, content: string) {
  const result = (await browser.execute(
    (taskIdArg, contentArg) => {
      type RendererTaskMeta = {
        taskId?: string;
        workspaceIdentity?: string;
        workspacePath?: string;
      };
      type RendererWorkspace = {
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
          workspaces?: Record<string, RendererWorkspace>;
        };
      };

      const storeApi = (
        window as Window & { __zcodeSessionStoreE2E?: RendererStore }
      ).__zcodeSessionStoreE2E;
      const state = storeApi?.getState?.();
      if (!state?.enqueueTaskQueuedPrompt) {
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

      const workspacePath = task.workspacePath ?? workspaceKey;
      const workspaceIdentity = task.workspaceIdentity;
      const promptId = `queued-e2e-stale-send-now-${Date.now()}`;
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

      return {
        ok: true,
        promptId,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      };
    },
    taskId,
    content,
  )) as RendererInjectionResult & { promptId?: string };

  if (!result.ok) {
    throw new Error(`renderer queue 注入失败: ${JSON.stringify(result)}`);
  }
  return result.promptId;
}

function buildTaskTargetForE2E(
  sessionId: string,
  objective: string,
  status: GoalStatusForE2E,
  now: number,
) {
  return {
    objective,
    sessionID: sessionId,
    status,
    summaryTitle: "E2E stale active goal",
    targetID: `target_e2e_index_${randomUUID()}`,
    time: {
      created: now,
      updated: now,
    },
    timeUsedSeconds: 0,
    tokenBudget: null,
    tokensUsed: 0,
  };
}
