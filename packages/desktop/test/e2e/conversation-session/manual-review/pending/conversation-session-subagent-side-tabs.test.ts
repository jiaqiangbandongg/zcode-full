import {
  TID_CHAT_SUMMARY_PANEL,
  TID_V4_PANE_SHELL,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
} from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForComposerText,
} from "../../../helpers/conversation-session.js";
import { ensureToolCrossProductFullAccessMode } from "../../../helpers/conversation-session-tool-cross-product.js";

const PARENT_MARKER = "E2E_SUBAGENT_SIDE_TABS_PARENT";
const PARENT_DONE = "E2E_SUBAGENT_SIDE_TABS_PARENT_DONE";
const CHILD_DONE_PREFIX = "E2E_SUBAGENT_SIDE_TABS_CHILD_DONE";
const CHILD_COUNT = 6;
const BACKGROUND_PARENT_MARKER = "E2E_RUNNING_SUBAGENT_SIDE_TAB_PARENT";
const BACKGROUND_LAUNCHED = "E2E_RUNNING_SUBAGENT_SIDE_TAB_LAUNCHED";
const BACKGROUND_PARENT_DONE = "E2E_RUNNING_SUBAGENT_SIDE_TAB_PARENT_DONE";

describe("子智能体右侧 tabs manual review", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SAT12: Running subagent 摘要行复用 child 右侧 tab", async function () {
    this.timeout(240000);

    await prepareConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    const runId = Date.now();
    const prompt = [
      `${BACKGROUND_PARENT_MARKER}_${runId}: launch exactly one Agent with run_in_background true.`,
      `The child must run Bash command "sleep 20", then reply with exactly CHILD_BACKGROUND_DONE_${runId}.`,
      `After the background launch tool returns, reply with exactly ${BACKGROUND_LAUNCHED}_${runId} without waiting.`,
      `After its task notification arrives, reply with exactly ${BACKGROUND_PARENT_DONE}_${runId}.`,
    ].join(" ");

    await sendPrompt(prompt);
    await waitForComposerText("", "Running subagent side-tab 首发后输入框没有清空");
    await waitForAssistantMessageContaining(`${BACKGROUND_LAUNCHED}_${runId}`);
    await waitForRunningSubagentTrigger(90000);

    await clickRunningSubagentTrigger();
    await waitForVisibleSubagentTabCount(1, 30000);
    await clickRunningSubagentTrigger();
    expect(await countVisibleSubagentTabs()).toBe(1);

    await waitForAssistantMessageContaining(`${BACKGROUND_PARENT_DONE}_${runId}`);
  });

  it("SAT01-SAT03: 6 个 running child 使用右侧 tabs 且打开后持续更新", async function () {
    this.timeout(240000);

    await prepareConversationE2E();
    await ensureToolCrossProductFullAccessMode();

    const runId = Date.now();
    const prompt = [
      `${PARENT_MARKER}_${runId}: In one assistant turn launch exactly ${CHILD_COUNT} foreground Agent tool calls in parallel.`,
      `Use subagent_type "general-purpose" for every child.`,
      `Give child N this exact instruction: run Bash command "sleep 6", then reply with exactly ${CHILD_DONE_PREFIX}_N_${runId}.`,
      `Do not finish the parent response until every child completes; then reply with exactly ${PARENT_DONE}_${runId}.`,
    ].join(" ");

    await sendPrompt(prompt);
    await waitForComposerText("", "subagent side tabs 首发后输入框没有清空");
    await waitForSubagentSummaryActions(CHILD_COUNT, 90000);
    await expectSubagentSummariesToOpenSidePaneDirectly();

    const initialRowCounts = await openAllSubagentTabs();
    expect(initialRowCounts).toHaveLength(CHILD_COUNT);
    await waitForVisibleSubagentTabCount(CHILD_COUNT, 30000);
    expect(await countWorkbenchPanes()).toBe(1);

    await clickFirstSubagentSummaryAction();
    expect(await countVisibleSubagentTabs()).toBe(CHILD_COUNT);

    await browser.waitUntil(
      async () => {
        const current = await readChildTimelineRowCounts();
        return (
          current.length === CHILD_COUNT &&
          current.every((count, index) => count > (initialRowCounts[index] ?? 0))
        );
      },
      {
        timeout: 120000,
        timeoutMsg: "已打开的 child tabs 没有在运行中继续增加 timeline rows",
      },
    );

    await waitForAssistantMessageContaining(`${PARENT_DONE}_${runId}`);
  });
});

async function waitForSubagentSummaryActions(expected: number, timeout: number): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (prefix) => document.querySelectorAll(`[data-testid^="${prefix}-"]`).length >= expected,
        TID_V4_SUBAGENT_OPEN_SIDE_PANE,
      ),
    {
      timeout,
      timeoutMsg: `没有等到 ${expected} 个 subagent 摘要直开入口`,
    },
  );
}

async function waitForRunningSubagentTrigger(timeout: number): Promise<void> {
  // 修复原因：面板 test id 来自 shared 常量；旧代码误传了只存在于浏览器回调
  // 形参里的同名变量，导致 E2E TypeScript 编译阶段直接失败。
  await browser.waitUntil(
    async () =>
      browser.execute((panelTestId) => {
        const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
        if (panel?.dataset.state === "collapsed") {
          panel.querySelector<HTMLButtonElement>("button")?.click();
        }
        const runningSection = panel?.querySelector<HTMLButtonElement>(
          '[data-status-section-trigger="agent"]',
        );
        if (runningSection?.getAttribute("aria-expanded") === "false") {
          runningSection.click();
        }
        return Boolean(panel?.querySelector('[data-running-subagent-session-trigger="true"]'));
      }, TID_CHAT_SUMMARY_PANEL),
    {
      timeout,
      timeoutMsg: "右上角智能体区块没有出现可打开的 subagent session 行",
    },
  );
}

async function clickRunningSubagentTrigger(): Promise<void> {
  await browser.execute(() => {
    document
      .querySelector<HTMLButtonElement>('[data-running-subagent-session-trigger="true"]')
      ?.click();
  });
}

async function expectSubagentSummariesToOpenSidePaneDirectly(): Promise<void> {
  const summaries = await browser.execute(
    (prefix) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`)).map(
        (summary) => ({
          ariaExpanded: summary.getAttribute("aria-expanded"),
          hasChevron: Boolean(summary.querySelector(".lucide-chevron-right")),
          hasInlineDetails: Boolean(
            summary.parentElement?.querySelector('[data-slot="collapsible-content"]'),
          ),
        }),
      ),
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  );

  expect(summaries).toHaveLength(CHILD_COUNT);
  expect(summaries.every((summary) => summary.ariaExpanded === null)).toBe(true);
  expect(summaries.every((summary) => !summary.hasChevron)).toBe(true);
  expect(summaries.every((summary) => !summary.hasInlineDetails)).toBe(true);
}

async function openAllSubagentTabs(): Promise<number[]> {
  await browser.execute(
    (prefix, expected) => {
      const summaries = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`),
      ).slice(0, expected);
      for (const summary of summaries) summary.click();
    },
    TID_V4_SUBAGENT_OPEN_SIDE_PANE,
    CHILD_COUNT,
  );
  await waitForVisibleSubagentTabCount(CHILD_COUNT, 30000);
  return readChildTimelineRowCounts();
}

async function clickFirstSubagentSummaryAction(): Promise<void> {
  await browser.execute((prefix) => {
    document.querySelector<HTMLElement>(`[data-testid^="${prefix}-"]`)?.click();
  }, TID_V4_SUBAGENT_OPEN_SIDE_PANE);
}

async function waitForVisibleSubagentTabCount(expected: number, timeout: number): Promise<void> {
  await browser.waitUntil(async () => (await countVisibleSubagentTabs()) === expected, {
    timeout,
    timeoutMsg: `右侧没有出现 ${expected} 个 subagent tabs`,
  });
}

async function countVisibleSubagentTabs(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-side-pane-tab-id^="subagent-session:"]').length,
  );
}

async function countWorkbenchPanes(): Promise<number> {
  return browser.execute(
    (testId) => document.querySelectorAll(`[data-testid^="${testId}"]`).length,
    TID_V4_PANE_SHELL,
  );
}

async function readChildTimelineRowCounts(): Promise<number[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-session-id^="sess_subagent_"]'))
      .map((pane) =>
        Number(
          pane.querySelector<HTMLElement>('[data-testid="v4-timeline"]')?.dataset.rowCount ?? 0,
        ),
      )
      .sort((left, right) => left - right),
  );
}
