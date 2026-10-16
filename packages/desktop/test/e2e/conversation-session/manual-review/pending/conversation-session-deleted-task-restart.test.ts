import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  ensureWorkspaceItemExpanded,
  setInputValueByTestIdDom,
} from "../../../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../../../helpers/model-provider-restart.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4MentionOptionPrefix,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_TIMEOUT_MS = 180_000;
const PROMPT_MARKER = "E2E_DELETED_TASK_RESTART";
const REPLY_MARKER = "DELETED_TASK_RESTART_OK";
const ARCHIVED_LABELS = ["Archived", "归档"];
const DELETE_LABELS = ["Delete", "删除"];

describe("TSL20：deleted tombstone 阻止冷启动复活", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("真实归档/永久删除后 CLI session 保留但重启不进入任何任务列表", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await sendV4Prompt(`${PROMPT_MARKER}: Reply with exactly "${REPLY_MARKER}" and no other text.`);
    await waitForV4TimelineContaining(REPLY_MARKER, 60_000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "TSL20 前置任务没有完成",
      60_000,
    );
    const taskId = requireTaskId(completed.sessionId);
    await waitForProjectRow(taskId, true, "Project 没有显示待删除任务");

    await archiveProjectTask(taskId);
    await waitForProjectRow(taskId, false, "归档后任务仍停留在 Project");
    const archivedState = readTaskIndexState(taskId);
    expect(archivedState).toMatchObject({ archived: 1, deleted: 0 });
    const taskTitle = requireTaskTitle(archivedState?.title);

    await toggleArchivedView();
    await waitForArchivedRow(taskTitle, true, "Archived 没有显示刚归档的任务");
    await deleteArchivedTask(taskTitle);
    await waitForArchivedRow(taskTitle, false, "永久删除后 Archived 仍显示任务");

    // Bug 根因：永久删除只写 task-index tombstone，不能物理删除 CLI transcript。
    // 冷启动时 sessions-index 仍会恢复这条 session，列表 join 必须让 deleted 负向集合获胜。
    expect(readTaskIndexState(taskId)).toMatchObject({
      archived: 1,
      deleted: 1,
    });
    expect(readCliSessionCount(taskId)).toBe(1);

    await startNewV4Draft();
    await restartIntoWorkspacePreservingProfile();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "TSL20 冷启动没有进入 draft",
      60_000,
    );

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "#", {
      timeout: 15_000,
      timeoutMsg: "TSL20 冷启动后 composer 不可输入",
    });
    expect(await waitForV4MentionOptionPrefix(`session:${taskId}`, 30_000)).toBe(
      `session:${taskId}`,
    );
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", {
      timeout: 15_000,
      timeoutMsg: "TSL20 无法清理 mention 输入",
    });

    // 冷启动可能恢复 workspace 折叠态；负向断言前必须展开，
    // 否则所有 task row 都未渲染会制造 deleted tombstone 的假阳性。
    await ensureWorkspaceItemExpanded(DEFAULT_WORKSPACE);
    await waitForProjectRow(taskId, false, "CLI summary 已恢复后 deleted task 在 Project 复活");
    await toggleArchivedView();
    await waitForArchivedRow(
      taskTitle,
      false,
      "CLI summary 已恢复后 deleted task 在 Archived 复活",
    );
    expect(readTaskIndexState(taskId)).toMatchObject({
      archived: 1,
      deleted: 1,
    });
    expect(readCliSessionCount(taskId)).toBe(1);
  });
});

function requireTaskId(value: string | null): string {
  if (!value || value === "draft") {
    throw new Error(`TSL20 缺少 taskId: ${String(value)}`);
  }
  return value;
}

function requireTaskTitle(value: string | null | undefined): string {
  if (!value?.trim()) {
    throw new Error(`TSL20 tasks-index 缺少持久 task title: ${String(value)}`);
  }
  return value;
}

async function archiveProjectTask(taskId: string) {
  const row = await $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`);
  await row.moveTo();
  await clickTestIdByDom(testId(TID_TASK_ARCHIVE, taskId), {
    timeout: 15_000,
    timeoutMsg: "TSL20 归档按钮没有出现",
  });
  await browser.waitUntil(
    () =>
      browser.execute(
        (id) => {
          const button = document.querySelector(`[data-testid="${id}"]`);
          return Boolean(button?.closest("[data-archive-confirming-task-id]"));
        },
        testId(TID_TASK_ARCHIVE, taskId),
      ),
    { timeout: 10_000, timeoutMsg: "TSL20 归档没有进入确认态" },
  );
  await clickTestIdByDom(testId(TID_TASK_ARCHIVE, taskId), {
    timeout: 10_000,
    timeoutMsg: "TSL20 归档确认按钮没有出现",
  });
}

async function toggleArchivedView() {
  const clicked = await browser.execute((labels) => {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
    ).find((candidate) => labels.includes(candidate.getAttribute("aria-label") ?? ""));
    button?.click();
    return Boolean(button);
  }, ARCHIVED_LABELS);
  expect(clicked).toBe(true);
}

async function deleteArchivedTask(title: string) {
  const clicked = await browser.execute(
    (targetTitle, labels) => {
      const row = Array.from(document.querySelectorAll<HTMLLIElement>("li")).find((candidate) =>
        (candidate.textContent ?? "").includes(targetTitle),
      );
      const button = Array.from(
        row?.querySelectorAll<HTMLButtonElement>("button[aria-label]") ?? [],
      ).find((candidate) => labels.includes(candidate.getAttribute("aria-label") ?? ""));
      button?.click();
      return Boolean(button);
    },
    title,
    DELETE_LABELS,
  );
  expect(clicked).toBe(true);
  await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
    timeout: 10_000,
    timeoutMsg: "TSL20 永久删除二次确认弹窗没有出现",
  });
}

async function waitForProjectRow(taskId: string, expected: boolean, timeoutMsg: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (taskItemTestId, shouldExist) =>
          Boolean(document.querySelector(`[data-testid="${taskItemTestId}"]`)) === shouldExist,
        testId(TID_TASK_ITEM, taskId),
        expected,
      ),
    { timeout: 30_000, timeoutMsg },
  );
}

async function waitForArchivedRow(title: string, expected: boolean, timeoutMsg: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (targetTitle, shouldExist) =>
          Array.from(document.querySelectorAll<HTMLLIElement>("li")).some((candidate) =>
            (candidate.textContent ?? "").includes(targetTitle),
          ) === shouldExist,
        title,
        expected,
      ),
    { timeout: 30_000, timeoutMsg },
  );
}

function readTaskIndexState(taskId: string): {
  archived: number;
  deleted: number;
  title: string;
} | null {
  // Node 当前内置 SQLite 只提供 DatabaseSync；E2E 每次只读一行并立即关闭句柄。
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    return (database
      .prepare("select archived, deleted, title from tasks where task_id = ?")
      .get(taskId) ?? null) as {
      archived: number;
      deleted: number;
      title: string;
    } | null;
  } finally {
    database.close();
  }
}

function readCliSessionCount(taskId: string): number {
  const database = new DatabaseSync(join(homedir(), ".zcode", "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("select count(*) as count from session where id = ?")
      .get(taskId) as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}
