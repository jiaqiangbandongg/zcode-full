import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "../helpers/desktop-app.js";
import {
  TASK_TITLE_MARQUEE_GROUPED_ID,
  TASK_TITLE_MARQUEE_LONG_ID,
  TASK_TITLE_MARQUEE_LONG_TITLE,
  TASK_TITLE_MARQUEE_SHORT_ID,
  TASK_TITLE_MARQUEE_SHORT_TITLE,
} from "../helpers/task-title-marquee-fixture.js";

const CASE_TIMEOUT_MS = 120_000;
const CLOSE_INTERVAL_MS = 200;
const STABILITY_WINDOW_MS = 3_000;
const TASK_IDS = [
  TASK_TITLE_MARQUEE_SHORT_ID,
  TASK_TITLE_MARQUEE_LONG_ID,
  TASK_TITLE_MARQUEE_GROUPED_ID,
] as const;
const TASK_TITLES = [
  TASK_TITLE_MARQUEE_SHORT_TITLE,
  TASK_TITLE_MARQUEE_LONG_TITLE,
  `${TASK_TITLE_MARQUEE_LONG_TITLE} GROUPED`,
] as const;

interface MembershipHoldState {
  armed: boolean;
  enteredCallCount: number;
  released: boolean;
}

interface GroupedArchiveProbe {
  currentTaskIds: string[];
  resurrectedTaskIds: string[];
}

interface GroupedArchiveTestActions {
  armTaskMembershipRefreshHold: () => void;
  releaseTaskMembershipRefreshHold: () => void;
  getTaskMembershipRefreshHoldState: () => MembershipHoldState;
}

describe("TSL37：Group 连续归档不被旧 membership 快照复活", () => {
  after(async () => {
    await browser.execute(() => {
      const probeWindow = window as Window & {
        __groupedArchiveObserver?: MutationObserver;
      };
      probeWindow.__groupedArchiveObserver?.disconnect();
      delete probeWindow.__groupedArchiveObserver;
    });
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("按 200ms 连续关闭三条后，迟到的归档前快照不能让旧任务重新出现", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await activateGroupedView();
    await waitForGroupedTaskIds(TASK_IDS);

    await armMembershipHold();
    await waitForHeldMembershipSnapshot();

    for (const taskId of TASK_IDS) {
      expect(await clickGroupedClose(taskId)).toBe(true);
      await waitForGroupedTaskAbsent(taskId);
      await browser.pause(CLOSE_INTERVAL_MS);
    }

    await installResurrectionProbe();
    await releaseMembershipHold();
    await assertNoGroupedResurrection(STABILITY_WINDOW_MS);
    await openArchivedView();
    await waitForArchivedTaskTitles(TASK_TITLES);
  });
});

async function activateGroupedView() {
  await browser.execute(() => {
    localStorage.setItem(
      "zcode-sidebar-task-preferences",
      JSON.stringify({ organizeBy: "grouped", sortBy: "updated" }),
    );
    location.reload();
  });
}

async function waitForGroupedTaskIds(taskIds: readonly string[]) {
  await browser.waitUntil(
    async () => {
      const current = await readVisibleGroupedTaskIds(taskIds);
      return taskIds.every((taskId) => current.includes(taskId));
    },
    {
      timeout: 45_000,
      interval: 100,
      timeoutMsg: `Group 没有显示全部归档 fixture: ${JSON.stringify(
        await readVisibleGroupedTaskIds(taskIds),
      )}`,
    },
  );
}

function readVisibleGroupedTaskIds(taskIds: readonly string[]): Promise<string[]> {
  return browser.execute(
    (ids) => {
      return ids.filter((taskId) =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-grouped-task-key]")).some((row) =>
          row.dataset.groupedTaskKey?.includes(taskId),
        ),
      );
    },
    [...taskIds],
  );
}

async function armMembershipHold() {
  const armed = await browser.execute(() => {
    const actions = (window as Window & { __testActions?: GroupedArchiveTestActions })
      .__testActions;
    actions?.armTaskMembershipRefreshHold();
    return Boolean(actions);
  });
  expect(armed).toBe(true);
}

async function waitForHeldMembershipSnapshot() {
  await browser.waitUntil(
    async () => {
      const state = await readMembershipHoldState();
      return Boolean(state?.armed && state.enteredCallCount > 0 && !state.released);
    },
    {
      timeout: 15_000,
      interval: 50,
      timeoutMsg: `归档前 membership 快照没有进入暂停窗口: ${JSON.stringify(
        await readMembershipHoldState(),
      )}`,
    },
  );
}

function readMembershipHoldState(): Promise<MembershipHoldState | null> {
  return browser.execute(() => {
    return (
      (
        window as Window & { __testActions?: GroupedArchiveTestActions }
      ).__testActions?.getTaskMembershipRefreshHoldState() ?? null
    );
  });
}

async function clickGroupedClose(taskId: string): Promise<boolean> {
  const row = $(`[data-grouped-task-key*="${taskId}"]`);
  await row.waitForDisplayed({
    timeout: 15_000,
    timeoutMsg: `grouped task 行没有显示: ${taskId}`,
  });
  // 修复原因：grouped task action 只在整行 hover/focus 后挂载；DOM 直查 close
  // 会在真实用户尚未触发 hover 时把正确的延迟挂载误判为按钮缺失。
  await row.moveTo();
  const close = row.$('button[aria-label="Close"], button[aria-label="关闭"]');
  await close.waitForClickable({
    timeout: 15_000,
    timeoutMsg: `grouped task hover 后没有显示关闭按钮: ${taskId}`,
  });
  await close.click();
  return true;
}

async function waitForGroupedTaskAbsent(taskId: string) {
  await browser.waitUntil(
    async () => !(await readVisibleGroupedTaskIds([taskId])).includes(taskId),
    {
      timeout: 5_000,
      interval: 25,
      timeoutMsg: `点击关闭后 grouped 行没有立即隐藏: ${taskId}`,
    },
  );
}

async function installResurrectionProbe() {
  await browser.execute(
    (taskIds) => {
      const probeWindow = window as Window & {
        __groupedArchiveObserver?: MutationObserver;
        __groupedArchiveResurrectedTaskIds?: string[];
      };
      probeWindow.__groupedArchiveResurrectedTaskIds = [];
      const collect = () => {
        for (const taskId of taskIds) {
          const visible = Array.from(
            document.querySelectorAll<HTMLElement>("[data-grouped-task-key]"),
          ).some((row) => row.dataset.groupedTaskKey?.includes(taskId));
          if (visible && !probeWindow.__groupedArchiveResurrectedTaskIds?.includes(taskId)) {
            probeWindow.__groupedArchiveResurrectedTaskIds?.push(taskId);
          }
        }
      };
      const observer = new MutationObserver(collect);
      observer.observe(document.body, { childList: true, subtree: true });
      probeWindow.__groupedArchiveObserver = observer;
      collect();
    },
    [...TASK_IDS],
  );
}

async function releaseMembershipHold() {
  await browser.execute(() => {
    (
      window as Window & { __testActions?: GroupedArchiveTestActions }
    ).__testActions?.releaseTaskMembershipRefreshHold();
  });
}

async function assertNoGroupedResurrection(stabilityWindowMs: number) {
  const startedAt = Date.now();
  await browser.waitUntil(
    async () => {
      const probe = await readGroupedArchiveProbe();
      if (probe.resurrectedTaskIds.length > 0) {
        throw new Error(`旧 membership 快照让 grouped task 复活: ${probe.resurrectedTaskIds}`);
      }
      return Date.now() - startedAt >= stabilityWindowMs;
    },
    {
      timeout: stabilityWindowMs + 5_000,
      interval: 50,
      timeoutMsg: `释放旧快照后 grouped 没有保持稳定: ${JSON.stringify(
        await readGroupedArchiveProbe(),
      )}`,
    },
  );
  expect((await readMembershipHoldState())?.released).toBe(true);
}

function readGroupedArchiveProbe(): Promise<GroupedArchiveProbe> {
  return browser.execute(
    (taskIds) => {
      const probeWindow = window as Window & {
        __groupedArchiveResurrectedTaskIds?: string[];
      };
      const currentTaskIds = taskIds.filter((taskId) =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-grouped-task-key]")).some((row) =>
          row.dataset.groupedTaskKey?.includes(taskId),
        ),
      );
      return {
        currentTaskIds,
        resurrectedTaskIds: probeWindow.__groupedArchiveResurrectedTaskIds ?? [],
      };
    },
    [...TASK_IDS],
  );
}

async function openArchivedView() {
  const button = await $('button[aria-label="Archived"], button[aria-label="归档"]');
  await button.waitForClickable({
    timeout: 15_000,
    timeoutMsg: "找不到 Archived 入口",
  });
  await button.click();
}

async function waitForArchivedTaskTitles(taskTitles: readonly string[]) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (titles) =>
          titles.every((title) =>
            Array.from(document.querySelectorAll<HTMLParagraphElement>("p[title]")).some(
              (element) => element.title === title,
            ),
          ),
        [...taskTitles],
      ),
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: "连续关闭的三条 task 没有全部进入 Archived",
    },
  );
}
