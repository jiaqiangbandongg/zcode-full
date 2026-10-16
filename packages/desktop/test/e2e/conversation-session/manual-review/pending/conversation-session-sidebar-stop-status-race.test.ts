import { TID_TASK_ITEM, testId } from "@zcode/shared";
import {
  clearAppData,
  getActiveWorkspacePath,
} from "../../../helpers/desktop-app.js";
import { ensureUpstreamProviderForE2E } from "../../../helpers/upstream-provider.js";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

const CASE_TIMEOUT_MS = 120_000;
const PROMPT_MARKER = "E2E_SIDEBAR_STOP_STATUS_RACE";

interface MembershipHoldState {
  armed: boolean;
  enteredCallCount: number;
  released: boolean;
}

interface TaskListRefreshProbe {
  matchingQueryCount: number;
  latestQueryStale: boolean | null;
  latestInvalidationVersion: number | null;
  taskPresent: boolean;
  taskStatus: string | null;
  activityPhase: string | null;
}

interface SidebarIndicatorProbe {
  seenTerminal: boolean;
  loadingReappeared: boolean;
}

interface TaskListTestActions {
  armTaskMembershipRefreshHold(): void;
  releaseTaskMembershipRefreshHold(): void;
  getTaskMembershipRefreshHoldState(): MembershipHoldState;
  getTaskListRefreshProbe(params: {
    workspacePath: string;
    taskId: string;
  }): TaskListRefreshProbe;
}

describe("TSL18：Stop 终态拒绝在途旧 membership 回包", () => {
  afterEach(async () => {
    await releaseMembershipHold().catch(() => undefined);
    await disposeSidebarIndicatorProbe().catch(() => undefined);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running refresh 在途时 Stop，旧回包返回后侧栏 spinner 消失且不回弹", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await ensureUpstreamProviderForE2E();
    await sendV4Prompt(
      `E2E_SLOW_STREAM ${PROMPT_MARKER}: Reply with exactly "upstream-e2e-ok".`,
    );
    await waitForV4Pane(
      (snapshot) =>
        snapshot.canStop &&
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft",
      "TSL18 前置请求没有进入正式 session 的 controlled streaming",
      45_000,
    );

    const taskId = (await getV4PaneSnapshot()).sessionId;
    const workspacePath = await getActiveWorkspacePath();
    if (!taskId || taskId === "draft" || !workspacePath) {
      throw new Error(
        `TSL18 缺少 workspace/task identity: workspace=${String(workspacePath)} task=${String(taskId)}`,
      );
    }

    await waitForTaskLoadingIndicator(
      taskId,
      true,
      "running task 没有显示侧栏 spinner",
    );

    await armMembershipHold();
    await browser.waitUntil(
      async () => ((await getMembershipHoldState())?.enteredCallCount ?? 0) > 0,
      {
        timeout: 15_000,
        timeoutMsg: "TSL18 E2E membership gate 没有截获在途 refresh",
      },
    );
    const runningProbe = await getTaskListRefreshProbe(workspacePath, taskId);
    expect(runningProbe?.taskPresent).toBe(true);
    expect(runningProbe?.activityPhase).toBe("running");
    expect(runningProbe?.latestQueryStale).toBe(true);
    const runningInvalidationVersion = runningProbe?.latestInvalidationVersion;
    expect(typeof runningInvalidationVersion).toBe("number");

    await clickV4Stop();
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "TSL18 Stop 后 conversation 没有退出 streaming",
      30_000,
    );

    // 修复原因：只等 canStop=false 不能证明 sessions-index 终态已经到达列表层。
    // query 在 gate 期间保持 stale；Stop delta 再次递增 invalidationVersion 后，才释放旧回包。
    await browser.waitUntil(
      async () => {
        const probe = await getTaskListRefreshProbe(workspacePath, taskId);
        return (
          probe !== null &&
          probe.latestQueryStale === true &&
          typeof probe.latestInvalidationVersion === "number" &&
          probe.latestInvalidationVersion >
            (runningInvalidationVersion as number)
        );
      },
      {
        timeout: 30_000,
        timeoutMsg: "Stop 终态没有在旧 membership 回包释放前失效 task query",
      },
    );

    await installSidebarIndicatorProbe(taskId);
    await releaseMembershipHold();

    await browser.waitUntil(
      async () => {
        const probe = await getTaskListRefreshProbe(workspacePath, taskId);
        return (
          probe !== null &&
          probe.matchingQueryCount > 0 &&
          probe.latestQueryStale === false &&
          probe.activityPhase === "completedInterrupted"
        );
      },
      {
        timeout: 30_000,
        timeoutMsg:
          "旧 membership 回包释放后，task query 没有按 Stop 终态重新收敛",
      },
    );
    await waitForTaskLoadingIndicator(
      taskId,
      false,
      "Stop 后侧栏 spinner 仍在显示",
    );
    await waitForTwoAnimationFrames();

    const indicatorProbe = await getSidebarIndicatorProbe();
    expect(indicatorProbe?.seenTerminal).toBe(true);
    expect(indicatorProbe?.loadingReappeared).toBe(false);
    expect((await getMembershipHoldState())?.released).toBe(true);
  });
});

async function armMembershipHold() {
  const armed = await browser.execute(() => {
    const actions = (window as Window & { __testActions?: TaskListTestActions })
      .__testActions;
    if (!actions) {
      return false;
    }
    actions.armTaskMembershipRefreshHold();
    return true;
  });
  expect(armed).toBe(true);
}

async function releaseMembershipHold() {
  await browser.execute(() => {
    const actions = (window as Window & { __testActions?: TaskListTestActions })
      .__testActions;
    actions?.releaseTaskMembershipRefreshHold();
  });
}

async function getMembershipHoldState(): Promise<MembershipHoldState | null> {
  return browser.execute(() => {
    const actions = (window as Window & { __testActions?: TaskListTestActions })
      .__testActions;
    return actions?.getTaskMembershipRefreshHoldState() ?? null;
  });
}

async function getTaskListRefreshProbe(
  workspacePath: string,
  taskId: string,
): Promise<TaskListRefreshProbe | null> {
  return browser.execute(
    (path, id) => {
      const actions = (
        window as Window & { __testActions?: TaskListTestActions }
      ).__testActions;
      return (
        actions?.getTaskListRefreshProbe({ workspacePath: path, taskId: id }) ??
        null
      );
    },
    workspacePath,
    taskId,
  );
}

async function waitForTaskLoadingIndicator(
  taskId: string,
  expected: boolean,
  timeoutMsg: string,
) {
  await browser.waitUntil(
    () =>
      browser
        .execute(
          (taskItemTestId) =>
            Boolean(
              document
                .querySelector<HTMLElement>(`[data-testid="${taskItemTestId}"]`)
                ?.querySelector("svg.animate-spin"),
            ),
          testId(TID_TASK_ITEM, taskId),
        )
        .then((loading) => loading === expected),
    { timeout: 30_000, timeoutMsg },
  );
}

async function installSidebarIndicatorProbe(taskId: string) {
  const installed = await browser.execute(
    (taskItemTestId) => {
      type ProbeWindow = Window & {
        __zcodeSidebarIndicatorProbe?: SidebarIndicatorProbe & {
          observer: MutationObserver;
        };
      };
      const probeWindow = window as ProbeWindow;
      probeWindow.__zcodeSidebarIndicatorProbe?.observer.disconnect();
      const probe = {
        seenTerminal: false,
        loadingReappeared: false,
        observer: null as unknown as MutationObserver,
      };
      const sample = () => {
        const row = document.querySelector<HTMLElement>(
          `[data-testid="${taskItemTestId}"]`,
        );
        const loading = Boolean(row?.querySelector("svg.animate-spin"));
        if (!loading) {
          probe.seenTerminal = true;
        } else if (probe.seenTerminal) {
          probe.loadingReappeared = true;
        }
      };
      probe.observer = new MutationObserver(sample);
      probe.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      probeWindow.__zcodeSidebarIndicatorProbe = probe;
      sample();
      return Boolean(
        document.querySelector(`[data-testid="${taskItemTestId}"]`),
      );
    },
    testId(TID_TASK_ITEM, taskId),
  );
  expect(installed).toBe(true);
}

async function getSidebarIndicatorProbe(): Promise<SidebarIndicatorProbe | null> {
  return browser.execute(() => {
    const probe = (
      window as Window & {
        __zcodeSidebarIndicatorProbe?: SidebarIndicatorProbe;
      }
    ).__zcodeSidebarIndicatorProbe;
    return probe
      ? {
          seenTerminal: probe.seenTerminal,
          loadingReappeared: probe.loadingReappeared,
        }
      : null;
  });
}

async function disposeSidebarIndicatorProbe() {
  await browser.execute(() => {
    type ProbeWindow = Window & {
      __zcodeSidebarIndicatorProbe?: SidebarIndicatorProbe & {
        observer?: MutationObserver;
      };
    };
    const probeWindow = window as ProbeWindow;
    probeWindow.__zcodeSidebarIndicatorProbe?.observer?.disconnect();
    delete probeWindow.__zcodeSidebarIndicatorProbe;
  });
}

async function waitForTwoAnimationFrames() {
  await browser.executeAsync((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });
}
