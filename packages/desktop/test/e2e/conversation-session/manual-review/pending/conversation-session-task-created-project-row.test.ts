import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_TASK_ITEM, testId } from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_TIMEOUT_MS = 150_000;
const PROMPT_MARKER = "E2E_TASK_CREATED_PROJECT_ROW";
const REPLY_MARKER = "TASK_CREATED_PROJECT_ROW_OK";

describe("TSL26：task_created 换代 Project task-row 快照", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("草稿首发后 optimistic 行收敛为唯一持久行且刷新不消失", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    expect((await getV4PaneSnapshot()).sessionId).toBe("draft");
    expect(readWorkspaceTaskCount()).toBe(0);

    await sendV4Prompt(`${PROMPT_MARKER}: Reply with exactly "${REPLY_MARKER}" and no other text.`);
    const bound = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "草稿首发后 pane 没有绑定正式 task",
      45_000,
    );
    const taskId = bound.sessionId;
    if (!taskId || taskId === "draft") {
      throw new Error(`TSL26 首发缺少正式 taskId: ${String(taskId)}`);
    }

    await waitForPersistedTask(taskId);
    await waitForSingleProjectRow(taskId, "task row 落库后 Project 没有立即显示唯一行");
    await waitForV4TimelineContaining(REPLY_MARKER, 60_000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "TSL26 首轮没有完成", 60_000);

    // Bug 根因：只依赖 active optimistic overlay 会掩盖旧 task-row cache。
    // 切回新草稿后旧 task 不再是 active，仍可见才证明 task_created 已把持久行读进查询结果。
    await startNewV4Draft();
    await waitForSingleProjectRow(taskId, "退出 active task 后持久 Project 行消失或重复");

    await browser.refresh();
    await waitForDefaultWorkspaceReady(45_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "renderer reload 后没有恢复未发送草稿",
      45_000,
    );
    await waitForSingleProjectRow(taskId, "renderer reload 后持久 Project 行消失或重复");
    expect(readWorkspaceTaskCount()).toBe(1);
  });
});

async function waitForPersistedTask(taskId: string) {
  await browser.waitUntil(() => readWorkspaceTaskIds().includes(taskId), {
    timeout: 30_000,
    timeoutMsg: `tasks-index 没有提交首发 task: ${taskId}`,
  });
}

async function waitForSingleProjectRow(taskId: string, timeoutMsg: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (taskItemTestId) =>
          document.querySelectorAll(`[data-testid="${taskItemTestId}"]`).length === 1,
        testId(TID_TASK_ITEM, taskId),
      ),
    { timeout: 30_000, timeoutMsg },
  );
}

function readWorkspaceTaskCount(): number {
  return readWorkspaceTaskIds().length;
}

function readWorkspaceTaskIds(): string[] {
  // Node 当前内置 SQLite 只提供 DatabaseSync；E2E 轮询每次都立即关闭只读句柄。
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = database
      .prepare("select task_id from tasks where workspace_key = ? and deleted = 0 order by task_id")
      .all(DEFAULT_WORKSPACE) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  } finally {
    database.close();
  }
}
