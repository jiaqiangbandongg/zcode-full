import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_TASK_ITEM, testId } from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  ensureWorkspaceItemExpanded,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import { restartIntoWorkspace } from "../../../helpers/model-provider-restart.js";
import {
  getV4PaneSnapshot,
  getV4QueueItems,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";
import {
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "../../../helpers/upstream-capture.js";

const CASE_TIMEOUT_MS = 180_000;
const SOURCE_MARKER = "E2E_TURN_ERROR_HISTORY_ACTIVITY_SOURCE";
const QUEUED_MARKER = "E2E_TURN_ERROR_HISTORY_ACTIVITY_QUEUED";
const HISTORICAL_AGE_MS = 2 * 24 * 60 * 60 * 1000;

describe("turn error 后打开历史任务不刷新侧栏修改时间", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("冷恢复清理 persisted queue 后，历史 task 不变成刚刚", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await prepareV4ConversationE2E();

    await sendV4Prompt(`${SOURCE_MARKER}: trigger a recoverable provider error.`);
    await waitForUpstreamNetworkRequestStarted(SOURCE_MARKER);
    await sendV4Prompt(`${QUEUED_MARKER}: this accepted queue must be discarded on resume.`);
    await waitForV4QueueCount(1);

    const failedRequest = await waitForUpstreamNetworkCapture(SOURCE_MARKER);
    expect(failedRequest.statusCode).toBe(500);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 1,
      "turn error 后 queue 没有保留",
      30_000,
    );
    expect((await getV4QueueItems())[0]?.text).toContain(QUEUED_MARKER);

    const sessionId = (await getV4PaneSnapshot()).sessionId;
    if (!sessionId || sessionId === "draft") {
      throw new Error(`回归 case 缺少正式 sessionId: ${String(sessionId)}`);
    }
    await waitForTaskRow(sessionId);
    await waitForAdmittedQueueInput(sessionId);
    await startNewV4Draft();

    // 进程退出后再改时间，避免旧 Host/Agent 的迟到写回覆盖回归样本。
    await restartIntoWorkspace({
      afterElectronProcessExit: () => agePersistedTask(sessionId),
    });
    await ensureWorkspaceItemExpanded(DEFAULT_WORKSPACE);
    await waitForTaskRow(sessionId);
    await movePointerAwayFromTask(sessionId);
    expect(await readTaskRowText(sessionId)).toMatch(/\d+(天|d)/);
    await selectV4TaskById(sessionId);
    await waitForV4TimelineContaining(SOURCE_MARKER, 60_000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.sessionId === sessionId && snapshot.queueCount === 0,
      "冷恢复后 persisted queue 没有被清理",
      60_000,
    );

    await movePointerAwayFromTask(sessionId);
    const rowText = await readTaskRowText(sessionId);
    // 当前回归：冷恢复后的 WorkspaceHookAdmissionUpdated 未进黑名单，record.updatedAt 被改成 now。
    expect(rowText).not.toMatch(/刚刚|\bnow\b/);
    expect(rowText).toMatch(/\d+(天|d)/);
  });
});

async function waitForTaskRow(sessionId: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (taskTestId) => Boolean(document.querySelector(`[data-testid="${taskTestId}"]`)),
        testId(TID_TASK_ITEM, sessionId),
      ),
    { timeout: 30_000, timeoutMsg: `侧栏没有出现 task 行: ${sessionId}` },
  );
}

async function readTaskRowText(sessionId: string): Promise<string> {
  return browser.execute(
    (taskTestId) =>
      document.querySelector<HTMLElement>(`[data-testid="${taskTestId}"]`)?.innerText ?? "",
    testId(TID_TASK_ITEM, sessionId),
  );
}

async function movePointerAwayFromTask(sessionId: string) {
  await browser.execute(
    (taskTestId) => {
      const row = document.querySelector<HTMLElement>(`[data-testid="${taskTestId}"]`);
      row?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
      row?.blur();
    },
    testId(TID_TASK_ITEM, sessionId),
  );
}

async function waitForAdmittedQueueInput(sessionId: string) {
  await browser.waitUntil(() => readQueueInputStatus(sessionId) === "admitted", {
    timeout: 30_000,
    timeoutMsg: "错误后的 queued input 没有持久化为 admitted",
  });
}

function readQueueInputStatus(sessionId: string): string | null {
  const { storageRoot } = getE2EAppDataPaths();
  const database = new DatabaseSync(join(storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare(
        `select status
           from session_input
          where session_id = ? and payload like ?
          order by admitted_sequence desc
          limit 1`,
      )
      .get(sessionId, `%${QUEUED_MARKER}%`) as { status?: string } | undefined;
    return row?.status ?? null;
  } finally {
    database.close();
  }
}

function agePersistedTask(sessionId: string) {
  const historicalAt = Date.now() - HISTORICAL_AGE_MS;
  const { storageRoot } = getE2EAppDataPaths();
  const sessionDatabase = new DatabaseSync(join(storageRoot, "cli", "db", "db.sqlite"));
  try {
    sessionDatabase
      .prepare("update session set time_updated = ? where id = ?")
      .run(historicalAt, sessionId);
  } finally {
    sessionDatabase.close();
  }

  const taskDatabase = new DatabaseSync(join(storageRoot, "v2", "tasks-index.sqlite"));
  try {
    const row = taskDatabase
      .prepare("select meta_json from tasks where task_id = ?")
      .get(sessionId) as { meta_json?: string } | undefined;
    if (!row?.meta_json) {
      throw new Error(`缺少 task index meta_json: ${sessionId}`);
    }
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    taskDatabase
      .prepare("update tasks set updated_at = ?, meta_json = ? where task_id = ?")
      .run(historicalAt, JSON.stringify({ ...meta, updatedAt: historicalAt }), sessionId);
  } finally {
    taskDatabase.close();
  }
}
