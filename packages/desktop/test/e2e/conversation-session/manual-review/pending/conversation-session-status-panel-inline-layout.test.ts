import {
  TID_CHAT_MESSAGES,
  TID_CHAT_SUMMARY_PANEL,
} from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const WIDE_VIEWPORT = { width: 1800, height: 1000 };
const NARROW_VIEWPORT = { width: 1100, height: 900 };
const DRAFT_WIDTH_CLASS = "max-w-2xl";
const NORMAL_WIDTH_CLASS =
  "max-w-4xl @min-[1152px]:max-w-5xl @min-[1280px]:max-w-6xl @min-[1536px]:max-w-[1280px] @min-[1792px]:max-w-[1536px] @min-[2048px]:max-w-[1792px]";
const INLINE_WIDTH_CLASS =
  "max-w-3xl @min-[1152px]:max-w-3xl @min-[1280px]:max-w-4xl @min-[1536px]:max-w-6xl @min-[1792px]:max-w-7xl @min-[2048px]:max-w-[1536px]";
const INLINE_OFFSET_CLASS = "-translate-x-[184px]";

describe("会话区 status panel inline layout E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("status panel 只有出现 inline 偏移时才收敛消息列和输入区宽度", async function () {
    this.timeout(180000);

    await setElectronWindowSize(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await prepareConversationE2E();
    await setElectronWindowSize(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);

    const draftLayout = await waitForChatLayoutSnapshot(
      (snapshot) =>
        snapshot.panelState === null &&
        snapshot.dockClassName.includes(DRAFT_WIDTH_CLASS) &&
        !snapshot.dockClassName.includes(INLINE_OFFSET_CLASS),
      "新建草稿没有保持无 status panel 的窄 composer 布局",
    );
    expect(draftLayout.panelState).toBeNull();

    const runId = Date.now();
    const plainPrompt =
      `E2E_STATUS_PANEL_EMPTY_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(plainPrompt);
    await waitForComposerText("", "普通首发后输入框没有清空");
    await waitForUserMessageContaining(plainPrompt);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "普通首发完成后没有回到 idle",
      90000,
    );
    const noPanelLayout = await waitForChatLayoutSnapshot(
      (snapshot) =>
        snapshot.panelState === null &&
        snapshot.contentClassName?.includes(NORMAL_WIDTH_CLASS) === true &&
        snapshot.dockClassName.includes(NORMAL_WIDTH_CLASS) &&
        !snapshot.hasContentInlineOffset &&
        !snapshot.hasDockInlineOffset,
      "无 status 内容的历史 task 没有保持普通消息列宽度",
    );
    expect(noPanelLayout.panelState).toBeNull();

    await startNewTask();
    await setElectronWindowSize(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    const goalMarker = `E2E_STATUS_PANEL_GOAL_${runId}`;
    const goalPrompt =
      `/goal ${goalMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(goalPrompt);
    await waitForComposerText("", "goal 首发后输入框没有清空");
    await waitForUserMessageContaining(goalMarker);
    await waitForChatState(
      (snapshot) =>
        snapshot.targetObjective?.includes(goalMarker) === true &&
        Boolean(snapshot.taskId),
      "goal 首发没有形成 status panel 可展示的 target",
      60000,
    );

    await expectInlinePanelLayout("宽屏自动展开 status panel 后没有同步收敛聊天宽度");

    await setElectronWindowSize(NARROW_VIEWPORT.width, NARROW_VIEWPORT.height);
    await expectMiniPanelLayout("窄屏自动收起 status panel 后没有恢复普通聊天宽度");

    await setElectronWindowSize(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await expectInlinePanelLayout("重新放大后自动展开 status panel 没有恢复 inline 布局");

    await clickSummaryPanelButton(["Collapse to capsule", "收起为胶囊"]);
    await expectMiniPanelLayout("手动收起 status panel 后没有移除 inline 偏移");

    await clickSummaryPanelButton(["Expand status", "展开状态"]);
    await expectInlinePanelLayout("手动展开 status panel 后没有恢复 inline 偏移");
  });
});

async function expectInlinePanelLayout(timeoutMsg: string) {
  const snapshot = await waitForChatLayoutSnapshot(
    (current) =>
      current.panelState === "expanded" &&
      current.contentClassName?.includes(INLINE_WIDTH_CLASS) === true &&
      current.dockClassName.includes(INLINE_WIDTH_CLASS) &&
      current.hasContentInlineOffset &&
      current.hasDockInlineOffset &&
      transitionContainsWidthAndTransform(current.contentTransitionProperty) &&
      transitionContainsWidthAndTransform(current.dockTransitionProperty),
    timeoutMsg,
  );
  expect(snapshot.panelState).toBe("expanded");
}

async function expectMiniPanelLayout(timeoutMsg: string) {
  const snapshot = await waitForChatLayoutSnapshot(
    (current) =>
      current.panelState === "collapsed" &&
      current.contentClassName?.includes(NORMAL_WIDTH_CLASS) === true &&
      current.dockClassName.includes(NORMAL_WIDTH_CLASS) &&
      !current.hasContentInlineOffset &&
      !current.hasDockInlineOffset &&
      transitionContainsWidthAndTransform(current.contentTransitionProperty) &&
      transitionContainsWidthAndTransform(current.dockTransitionProperty),
    timeoutMsg,
  );
  expect(snapshot.panelState).toBe("collapsed");
}

function transitionContainsWidthAndTransform(value: string) {
  return value.includes("max-width") && value.includes("transform");
}

async function waitForChatLayoutSnapshot(
  predicate: (snapshot: ChatLayoutSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: ChatLayoutSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getChatLayoutSnapshot();
        return predicate(latest);
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    latest = await getChatLayoutSnapshot().catch(() => latest);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }

  return getChatLayoutSnapshot();
}

interface ChatLayoutSnapshot {
  contentClassName: string | null;
  contentTransitionProperty: string;
  dockClassName: string;
  dockTransitionProperty: string;
  hasContentInlineOffset: boolean;
  hasDockInlineOffset: boolean;
  panelState: string | null;
}

function getChatLayoutSnapshot(): Promise<ChatLayoutSnapshot> {
  return browser.execute(
    (messagesTestId, summaryPanelTestId, inlineOffsetClass) => {
      const panel = document.querySelector<HTMLElement>(
        `[data-testid="${summaryPanelTestId}"]`,
      );
      const dock = document.querySelector<HTMLElement>(
        '[data-chat-composer-region="true"] > div',
      );
      const firstTurnShell = document.querySelector<HTMLElement>(
        `[data-testid="${messagesTestId}"] [data-chat-turn-group-shell="true"]`,
      );
      const content = firstTurnShell?.parentElement ?? null;
      const contentStyle = content ? window.getComputedStyle(content) : null;
      const dockStyle = dock ? window.getComputedStyle(dock) : null;

      return {
        contentClassName: content?.className ?? null,
        contentTransitionProperty: contentStyle?.transitionProperty ?? "",
        dockClassName: dock?.className ?? "",
        dockTransitionProperty: dockStyle?.transitionProperty ?? "",
        hasContentInlineOffset:
          content?.className.includes(inlineOffsetClass) ?? false,
        hasDockInlineOffset:
          dock?.className.includes(inlineOffsetClass) ?? false,
        panelState: panel?.dataset.state ?? null,
      };
    },
    TID_CHAT_MESSAGES,
    TID_CHAT_SUMMARY_PANEL,
    INLINE_OFFSET_CLASS,
  );
}

async function clickSummaryPanelButton(labels: readonly string[]) {
  const clicked = await browser.execute(
    (summaryPanelTestId, candidateLabels) => {
      const panel = document.querySelector<HTMLElement>(
        `[data-testid="${summaryPanelTestId}"]`,
      );
      const buttons = Array.from(
        panel?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      );
      const button = buttons.find((item) =>
        candidateLabels.includes(item.getAttribute("aria-label") ?? ""),
      );
      button?.click();
      return Boolean(button);
    },
    TID_CHAT_SUMMARY_PANEL,
    labels,
  );

  if (!clicked) {
    throw new Error(`没有找到 status panel 按钮: ${labels.join(" / ")}`);
  }
}

async function setElectronWindowSize(width: number, height: number) {
  const resized = await browser.electron.execute(
    (electron, nextWidth, nextHeight) => {
      const window = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
      if (!window) {
        return false;
      }
      const bounds = window.getBounds();
      window.setBounds({
        ...bounds,
        height: nextHeight,
        width: nextWidth,
      });
      window.focus();
      return true;
    },
    width,
    height,
  );
  if (!resized) {
    throw new Error("没有找到可调整尺寸的 Electron 窗口");
  }

  await browser.waitUntil(
    async () =>
      browser.execute(
        (expectedWidth, expectedHeight) =>
          Math.abs(window.innerWidth - expectedWidth) < 80 &&
          Math.abs(window.innerHeight - expectedHeight) < 120,
        width,
        height,
      ),
    {
      timeout: 10000,
      timeoutMsg: `Electron 窗口尺寸没有收敛到 ${width}x${height}`,
    },
  );
}
