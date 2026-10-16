import {
  TID_PROMPT_SUGGESTION_PANEL,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const PARENT_MARKER = "E2E_SSC_PARENT_SELECTION_MARKER";
const MAIN_DRAFT = "E2E_SSC_MAIN_DRAFT_KEEP";
const SIDE_DRAFT = "E2E_SSC_SIDE_DRAFT_KEEP";

describe("框选文字副屏会话 manual review", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSC01/02/08/14/15/17/19/25/26/27/28/29/30/31: 隐藏历史、多开、关闭隔离、active 路由与 /side 命令", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    await sendV4Prompt(`Reply with exactly ${PARENT_MARKER}`);
    await waitForSelectableMainTimelineText(PARENT_MARKER, 60000);
    const parent = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "SSC parent session 没有建立",
    );

    await setComposerText(testId(TID_V4_SESSION_PANE, "workspace-main"), MAIN_DRAFT);
    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("add-to-task");
    await expectComposerState(testId(TID_V4_SESSION_PANE, "workspace-main"), MAIN_DRAFT, 1);

    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("ask-in-side-chat");
    const firstSide = await waitForSelectionSidePane();
    expect(firstSide.childSessionId).not.toBe(parent.sessionId);
    await expectComposerState(firstSide.paneTestId, "", 1);
    const inheritedHistoryVisible = await browser.execute(
      (paneTestId, marker) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        return pane?.innerText.includes(marker) ?? false;
      },
      firstSide.paneTestId,
      PARENT_MARKER,
    );
    expect(inheritedHistoryVisible).toBe(false);

    await setComposerText(firstSide.paneTestId, SIDE_DRAFT);
    await selectMainTimelineText("E2E_SSC_PARENT");
    await clickSelectionAction("ask-in-side-chat");
    const reusedSide = await waitForSelectionSidePane();
    expect(reusedSide.childSessionId).toBe(firstSide.childSessionId);
    await expectComposerState(reusedSide.paneTestId, SIDE_DRAFT, 2);

    await clickComposerSend(testId(TID_V4_SESSION_PANE, "workspace-main"));
    await waitForV4TimelineContaining(MAIN_DRAFT, 30000);
    const afterParentAdvance = await waitForSelectionSidePane();
    expect(afterParentAdvance.childSessionId).toBe(firstSide.childSessionId);
    await expectComposerState(afterParentAdvance.paneTestId, SIDE_DRAFT, 2);

    await closeSelectionSideTab();
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.querySelector('[data-side-pane-tab-id^="selection-side-chat:"]'),
        ),
      { timeout: 30000, timeoutMsg: "关闭后 selection side tab 仍存在" },
    );
    await browser.pause(300);

    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("ask-in-side-chat");
    const recreatedSide = await waitForSelectionSidePane();
    expect(recreatedSide.childSessionId).not.toBe(firstSide.childSessionId);

    await clickAddSelectionSideConversation();
    await waitForSelectionSidePanes(2);
    await clickAddSelectionSideConversation();
    const threeSides = await waitForSelectionSidePanes(3);
    expect(new Set(threeSides.map((side) => side.childSessionId)).size).toBe(3);
    expect(threeSides.map((side) => side.title)).toEqual([
      "辅助对话 1",
      "辅助对话 2",
      "辅助对话 3",
    ]);

    await activateSidePaneTab(recreatedSide.tabId);
    await selectMainTimelineText("E2E_SSC_PARENT");
    await clickSelectionAction("ask-in-side-chat");
    await expectComposerState(recreatedSide.paneTestId, "", 2);
    for (const side of threeSides.filter(
      (candidate) => candidate.childSessionId !== recreatedSide.childSessionId,
    )) {
      await expectNoSelectionReferences(side.paneTestId);
    }

    const siblingSides = threeSides.filter(
      (candidate) => candidate.childSessionId !== recreatedSide.childSessionId,
    );
    const sideToClose = siblingSides[0];
    const survivingSibling = siblingSides[1];
    if (!sideToClose || !survivingSibling) {
      throw new Error("multi-open sibling side panes missing");
    }
    await setComposerText(survivingSibling.paneTestId, "E2E_SSC_SIBLING_DRAFT");
    await closeSelectionSideTab(sideToClose.tabId);
    const remainingSides = await waitForSelectionSidePanes(2);
    expect(
      remainingSides.some(
        (candidate) => candidate.childSessionId === sideToClose.childSessionId,
      ),
    ).toBe(false);
    await expectComposerText(
      survivingSibling.paneTestId,
      "E2E_SSC_SIBLING_DRAFT",
    );
    await expectNoSelectionReferences(survivingSibling.paneTestId);

    await clickAddSidePaneItem("terminal");
    await waitForActiveSidePaneTab("terminal:");
    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("ask-in-side-chat");
    const afterNoActiveAuxiliary = await waitForSelectionSidePanes(3);
    const remainingChildIds = new Set(
      remainingSides.map((side) => side.childSessionId),
    );
    const createdForSelection = afterNoActiveAuxiliary.find(
      (side) => !remainingChildIds.has(side.childSessionId),
    );
    expect(createdForSelection).toBeDefined();
    if (!createdForSelection) {
      throw new Error("selection did not create a new auxiliary child");
    }
    await expectComposerState(createdForSelection.paneTestId, "", 1);

    // SSC28：/side 与 /btw App 层命令选中即开新辅助 tab，并移除输入中的命令 token。
    const mainPaneTestId = testId(TID_V4_SESSION_PANE, "workspace-main");
    const sidesBeforeSlashCommand = await waitForSelectionSidePanes(3);
    const knownChildIds = new Set(sidesBeforeSlashCommand.map((side) => side.childSessionId));
    await typeIntoComposerByKeyboard(mainPaneTestId, "/side");
    await clickSlashSuggestionOption("app-slash:side");
    const afterSideCommand = await waitForSelectionSidePanes(4);
    const sideCommandChild = afterSideCommand.find(
      (side) => !knownChildIds.has(side.childSessionId),
    );
    expect(sideCommandChild).toBeDefined();
    await expectComposerPlainText(mainPaneTestId, "");

    await typeIntoComposerByKeyboard(mainPaneTestId, "/btw");
    await clickSlashSuggestionOption("app-slash:btw");
    await waitForSelectionSidePanes(5);
    await expectComposerPlainText(mainPaneTestId, "");

    // SSC30：带参数的 `/side` 直接创建 child，并把参数作为首条普通输入提交。
    const childrenBeforeArgument = await waitForSelectionSidePanes(5);
    const childrenBeforeArgumentIds = new Set(
      childrenBeforeArgument.map((side) => side.childSessionId),
    );
    await setComposerText(mainPaneTestId, "/side E2E_SSC_SIDE_ARGUMENT_IDLE");
    await clickComposerSend(mainPaneTestId);
    const idleArgumentChildren = await waitForSelectionSidePanes(6);
    const idleArgumentChild = idleArgumentChildren.find(
      (side) => !childrenBeforeArgumentIds.has(side.childSessionId),
    );
    expect(idleArgumentChild).toBeDefined();
    if (!idleArgumentChild) throw new Error("带参数 /side 没有创建 child");
    await waitForSelectionSidePaneContaining(
      idleArgumentChild.paneTestId,
      "E2E_SSC_SIDE_ARGUMENT_IDLE",
    );
    await expectComposerPlainText(mainPaneTestId, "");

    // SSC31：父会话启动新 turn 后立即发送 `/btw <text>`，参数命令只启动 child，
    // 不把父会话当前 turn 改成 queue/guide。
    await setComposerText(mainPaneTestId, "Reply with exactly E2E_SSC_RUNNING_PARENT");
    await clickComposerSend(mainPaneTestId);
    const childrenBeforeRunningArgument = await waitForSelectionSidePanes(6);
    const childrenBeforeRunningArgumentIds = new Set(
      childrenBeforeRunningArgument.map((side) => side.childSessionId),
    );
    await setComposerText(mainPaneTestId, "/btw E2E_SSC_SIDE_ARGUMENT_RUNNING");
    await clickComposerSend(mainPaneTestId);
    const runningArgumentChildren = await waitForSelectionSidePanes(7);
    const runningArgumentChild = runningArgumentChildren.find(
      (side) => !childrenBeforeRunningArgumentIds.has(side.childSessionId),
    );
    expect(runningArgumentChild).toBeDefined();
    if (!runningArgumentChild) throw new Error("运行中带参数 /btw 没有创建 child");
    await waitForSelectionSidePaneContaining(
      runningArgumentChild.paneTestId,
      "E2E_SSC_SIDE_ARGUMENT_RUNNING",
    );
    await expectComposerPlainText(mainPaneTestId, "");

    // SSC29：辅助对话自身 composer 的 `/` 面板不提供 App 层命令，CLI 命令展示不受影响。
    const activeSideAfterBtw = await waitForActiveSelectionSidePane();
    await typeIntoComposerByKeyboard(activeSideAfterBtw.paneTestId, "/");
    await expectSlashPanelWithoutAppCommands();
    await dismissSlashPanel(activeSideAfterBtw.paneTestId);

    // SSC29：草稿态（未创建 session）不提供 App 层命令。
    await openNewTaskDraft();
    await typeIntoComposerByKeyboard(mainPaneTestId, "/");
    await expectSlashPanelWithoutAppCommands();
    await dismissSlashPanel(mainPaneTestId);
  });
});

async function selectMainTimelineText(text: string): Promise<void> {
  await browser.execute(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await browser.pause(50);
  // 修复原因：选区浮层 enabled 依赖主 pane focused；点击侧栏 tab / 新建终端后主 pane
  // 失焦（xterm 挂载还会异步抢焦点）。真实划词的 pointerdown 会经 ChatPaneShell 的
  // onPointerDownCapture 重新聚焦，合成选区没有这一步。这里循环补发 pointerdown，
  // 直到 pane 外壳 data-focused="true" 稳定为止。
  await browser.waitUntil(
    async () =>
      browser.execute((paneTestId) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        if (!pane) return false;
        pane.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
        );
        const shell = pane.closest<HTMLElement>("[data-pane-id]");
        return shell?.dataset.focused === "true";
      }, testId(TID_V4_SESSION_PANE, "workspace-main")),
    { timeout: 15000, timeoutMsg: "主 pane 无法重新聚焦" },
  );
  await browser.pause(100);
  const dispatchSelection = async () =>
    browser.execute(
      (paneTestId, targetText) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        if (!pane) return false;
        const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
        let fallback: { node: Node; offset: number } | null = null;
        let node = walker.nextNode();
        while (node) {
          const value = node.textContent ?? "";
          const offset = value.indexOf(targetText);
          const row = node.parentElement?.closest<HTMLElement>("[data-row-id]");
          if (offset >= 0 && row) {
            if (value.trim() === targetText) {
              fallback = { node, offset };
              break;
            }
            fallback ??= { node, offset };
          }
          node = walker.nextNode();
        }
        if (!fallback) return false;
        fallback.node.parentElement
          ?.closest<HTMLElement>("[data-row-id]")
          ?.scrollIntoView({ block: "center" });
        const range = document.createRange();
        range.setStart(fallback.node, fallback.offset);
        range.setEnd(fallback.node, fallback.offset + targetText.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        fallback.node.parentElement
          ?.closest<HTMLElement>("[data-row-id]")
          ?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return true;
      },
      testId(TID_V4_SESSION_PANE, "workspace-main"),
      text,
    );
  // 修复原因：mouseup 后浮层在 rAF 中检查 enabled；若此刻主 pane 焦点仍被异步交互
  // （xterm/tab 切换动画）抢走，本次检查会静默丢弃。整体重试"派发选区 + 等浮层"，
  // 避免单次时序竞争造成 flake。
  let tooltipVisible = false;
  for (let attempt = 0; attempt < 3 && !tooltipVisible; attempt += 1) {
    expect(await dispatchSelection()).toBe(true);
    tooltipVisible = await browser
      .waitUntil(
        async () =>
          browser.execute(() =>
            Boolean(document.querySelector("[data-conversation-selection-tooltip]")),
          ),
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
  }
  if (!tooltipVisible) {
    throw new Error(`选区浮层没有出现: ${text}`);
  }
}

async function waitForSelectableMainTimelineText(
  text: string,
  timeout: number,
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (paneTestId, targetText) => {
          const pane = document.querySelector<HTMLElement>(
            `[data-testid="${paneTestId}"]`,
          );
          if (!pane) return false;
          const walker = document.createTreeWalker(
            pane,
            NodeFilter.SHOW_TEXT,
          );
          let node = walker.nextNode();
          while (node) {
            if (
              node.textContent?.trim() === targetText &&
              node.parentElement?.closest("[data-row-id]")
            ) {
              return true;
            }
            node = walker.nextNode();
          }
          return false;
        },
        testId(TID_V4_SESSION_PANE, "workspace-main"),
        text,
      ),
    {
      timeout,
      timeoutMsg: `主时间线没有出现可选文本: ${text}`,
    },
  );
}

async function clickSelectionAction(action: "add-to-task" | "ask-in-side-chat"): Promise<void> {
  // 修复原因：浮层在 selectionchange/rAF 中可能短暂重挂载；"先检查后点击"两次往返之间
  // 按钮会消失一瞬导致 flake。这里把检查与点击合成单个原子脚本并整体重试。
  await browser.waitUntil(
    async () =>
      browser.execute((nextAction) => {
        const button = document.querySelector<HTMLButtonElement>(
          `[data-conversation-selection-action="${nextAction}"]`,
        );
        if (!button || button.disabled) return false;
        button.click();
        return true;
      }, action),
    {
      timeout: 30000,
      timeoutMsg: `划词动作不可用: ${action}`,
    },
  );
}

async function waitForSelectionSidePane(): Promise<{
  childSessionId: string;
  paneTestId: string;
  tabId: string;
}> {
  let result: { childSessionId: string; paneTestId: string; tabId: string } | null = null;
  await browser.waitUntil(
    async () => {
      result = await browser.execute((panePrefix) => {
        const tab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id^="selection-side-chat:"]',
        );
        const tabId = tab?.dataset.sidePaneTabId;
        if (!tabId) return null;
        const paneTestId = `${panePrefix}-${tabId}`;
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const childSessionId = pane?.dataset.sessionId;
        return childSessionId ? { childSessionId, paneTestId, tabId } : null;
      }, TID_V4_SESSION_PANE);
      return result !== null;
    },
    { timeout: 30000, timeoutMsg: "selection side pane 没有打开" },
  );
  if (!result) throw new Error("selection side pane result missing");
  return result;
}

async function waitForSelectionSidePanes(expectedCount: number): Promise<
  Array<{
    childSessionId: string;
    paneTestId: string;
    tabId: string;
    title: string;
  }>
> {
  let result: Array<{
    childSessionId: string;
    paneTestId: string;
    tabId: string;
    title: string;
  }> = [];
  await browser.waitUntil(
    async () => {
      result = await browser.execute(
        (panePrefix) =>
          Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-side-pane-tab-id^="selection-side-chat:"]',
            ),
          ).flatMap((tab) => {
            const tabId = tab.dataset.sidePaneTabId;
            if (!tabId) return [];
            const paneTestId = `${panePrefix}-${tabId}`;
            const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
            const childSessionId = pane?.dataset.sessionId;
            return childSessionId
              ? [{ childSessionId, paneTestId, tabId, title: tab.innerText.trim() }]
              : [];
          }),
        TID_V4_SESSION_PANE,
      );
      return result.length === expectedCount;
    },
    {
      timeout: 30000,
      timeoutMsg: `selection side pane 数量不是 ${expectedCount}`,
    },
  );
  return result;
}

async function clickAddSelectionSideConversation(): Promise<void> {
  await clickAddSidePaneItem("selection-side-conversation");
}

async function clickAddSidePaneItem(
  itemId: "selection-side-conversation" | "terminal",
): Promise<void> {
  // 修复原因：Radix DropdownMenu trigger 依赖 pointerdown 手势，element.click()
  // 或单独的 WebDriver click 在 Electron 下不稳定；与 e2ecase-regression 同口径，
  // 派发完整 pointer/mouse/click 事件序列激活 trigger 与 menu item。
  const dispatchActivationScript = (selector: string) => {
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) return false;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.focus();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const event = type.startsWith("pointer")
        ? new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          })
        : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
    }
    return true;
  };
  await browser.waitUntil(
    async () => browser.execute(dispatchActivationScript, "[data-side-pane-add-trigger]"),
    { timeout: 15000, timeoutMsg: "Side Pane 新增标签按钮不存在" },
  );
  const itemSelector = `[data-side-pane-add-item="${itemId}"]`;
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector) => Boolean(document.querySelector(selector)),
        itemSelector,
      ),
    { timeout: 15000, timeoutMsg: `${itemId} 新增菜单没有打开` },
  );
  const clicked = await browser.execute(dispatchActivationScript, itemSelector);
  expect(clicked).toBe(true);
}

async function waitForActiveSidePaneTab(idPrefix: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((nextIdPrefix) => {
        const activeTab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id][data-state="active"]',
        );
        return activeTab?.dataset.sidePaneTabId?.startsWith(nextIdPrefix) ?? false;
      }, idPrefix),
    {
      timeout: 30000,
      timeoutMsg: `Side Pane active tab 不是 ${idPrefix}`,
    },
  );
}

async function activateSidePaneTab(tabId: string): Promise<void> {
  const clicked = await browser.execute((targetTabId) => {
    const tab = document.querySelector<HTMLElement>(
      `[data-side-pane-tab-id="${CSS.escape(targetTabId)}"]`,
    );
    tab?.click();
    return Boolean(tab);
  }, tabId);
  expect(clicked).toBe(true);
}

async function setComposerText(paneTestId: string, text: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, inputTestId, nextText) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
          const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          const bridge = (
            input as
              | (HTMLElement & {
                  __zcodeLexicalInputE2E?: {
                    getText: () => string;
                    setText: (value: string) => void;
                  };
                })
              | undefined
          )?.__zcodeLexicalInputE2E;
          if (!bridge) return false;
          bridge.setText(nextText);
          return bridge.getText() === nextText;
        },
        paneTestId,
        TID_V4_COMPOSER_INPUT,
        text,
      ),
    { timeout: 15000, timeoutMsg: `composer 不可输入: ${paneTestId}` },
  );
}

async function expectComposerState(
  paneTestId: string,
  text: string,
  referenceCount: number,
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, inputTestId, expectedText, expectedReferenceCount) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
          const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          const bridge = (
            input as
              | (HTMLElement & {
                  __zcodeLexicalInputE2E?: { getText: () => string };
                })
              | undefined
          )?.__zcodeLexicalInputE2E;
          return (
            bridge?.getText() === expectedText &&
            pane?.querySelector(
              `[data-conversation-selection-reference-count="${expectedReferenceCount}"]`,
            ) !== null
          );
        },
        paneTestId,
        TID_V4_COMPOSER_INPUT,
        text,
        referenceCount,
      ),
    {
      timeout: 15000,
      timeoutMsg: `composer 草稿或引用数量不匹配: ${paneTestId}`,
    },
  );
}

async function expectNoSelectionReferences(paneTestId: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((nextPaneTestId) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
        return (
          pane !== null &&
          pane.querySelector("[data-conversation-selection-reference-count]") === null
        );
      }, paneTestId),
    {
      timeout: 15000,
      timeoutMsg: `非目标辅助对话出现了划词引用: ${paneTestId}`,
    },
  );
}

async function expectComposerText(
  paneTestId: string,
  text: string,
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, inputTestId, expectedText) => {
          const pane = document.querySelector<HTMLElement>(
            `[data-testid="${nextPaneTestId}"]`,
          );
          const input = pane?.querySelector<HTMLElement>(
            `[data-testid="${inputTestId}"]`,
          );
          return (
            input as
              | (HTMLElement & {
                  __zcodeLexicalInputE2E?: { getText: () => string };
                })
              | undefined
          )?.__zcodeLexicalInputE2E?.getText() === expectedText;
        },
        paneTestId,
        TID_V4_COMPOSER_INPUT,
        text,
      ),
    {
      timeout: 15000,
      timeoutMsg: `composer 草稿不匹配: ${paneTestId}`,
    },
  );
}

async function clickComposerSend(paneTestId: string): Promise<void> {
  const clicked = await browser.execute(
    (nextPaneTestId, sendTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
      const button = pane?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    paneTestId,
    TID_V4_COMPOSER_SEND,
  );
  expect(clicked).toBe(true);
}

async function waitForActiveSelectionSidePane(): Promise<{
  childSessionId: string;
  paneTestId: string;
  tabId: string;
}> {
  let result: { childSessionId: string; paneTestId: string; tabId: string } | null = null;
  await browser.waitUntil(
    async () => {
      result = await browser.execute((panePrefix) => {
        const tab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id^="selection-side-chat:"][data-state="active"]',
        );
        const tabId = tab?.dataset.sidePaneTabId;
        if (!tabId) return null;
        const paneTestId = `${panePrefix}-${tabId}`;
        const childSessionId = document.querySelector<HTMLElement>(
          `[data-testid="${paneTestId}"]`,
        )?.dataset.sessionId;
        return childSessionId ? { childSessionId, paneTestId, tabId } : null;
      }, TID_V4_SESSION_PANE);
      return result !== null;
    },
    { timeout: 30000, timeoutMsg: "没有 active 的 selection side pane" },
  );
  if (!result) throw new Error("active selection side pane missing");
  return result;
}

async function waitForSelectionSidePaneContaining(
  paneTestId: string,
  marker: string,
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, nextMarker) =>
          document
            .querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`)
            ?.innerText.includes(nextMarker) ?? false,
        paneTestId,
        marker,
      ),
    { timeout: 60000, timeoutMsg: `selection side pane 没有出现 ${marker}` },
  );
}

/**
 * 斜杠面板依赖真实键入（programmatic setText 不触发）。
 * 修复原因：
 * 1. WebDriver click 落在 composer 包装层不保证把焦点交给 Lexical 编辑器；
 * 2. `__zcodeLexicalInputE2E` bridge 按共享 testid 单点挂载，多 composer 长流程后
 *    可能从当前输入框脱落。因此这里不依赖 bridge：直接对 contenteditable 原生
 *    focus + 光标置末，键入后用 textContent 校验，失败重试。
 */
async function typeIntoComposerByKeyboard(paneTestId: string, text: string): Promise<void> {
  const inputSelector = `[data-testid="${paneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await browser.waitUntil(
      async () =>
        browser.execute((selector) => {
          const input = document.querySelector<HTMLElement>(selector);
          if (!input) return false;
          input.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(input);
          range.collapse(false);
          selection?.removeAllRanges();
          selection?.addRange(range);
          return document.activeElement === input || input.contains(document.activeElement);
        }, inputSelector),
      { timeout: 15000, timeoutMsg: `composer 无法聚焦: ${paneTestId}` },
    );
    await browser.keys(text.split(""));
    const typed = await browser.execute(
      (selector, expectedText) =>
        (document.querySelector<HTMLElement>(selector)?.textContent ?? "").includes(
          expectedText,
        ),
      inputSelector,
      text,
    );
    if (typed) return;
    await clearComposerByKeyboard(paneTestId);
  }
  throw new Error(`键盘输入没有进入 composer: ${paneTestId} <- ${text}`);
}

/** 不依赖 bridge 的清空：全选 + Backspace（真实键序，Lexical 正常处理）。 */
async function clearComposerByKeyboard(paneTestId: string): Promise<void> {
  const inputSelector = `[data-testid="${paneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`;
  await browser.execute((selector) => {
    document.querySelector<HTMLElement>(selector)?.focus();
  }, inputSelector);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await browser.keys([modifier, "a"]);
  await browser.keys("Backspace");
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector) =>
          (document.querySelector<HTMLElement>(selector)?.textContent ?? "").trim() === "",
        inputSelector,
      ),
    { timeout: 10000, timeoutMsg: `composer 清空失败: ${paneTestId}` },
  );
}

/** 不依赖 bridge 的 composer 文本断言（bridge 在多 composer 场景可能脱落）。 */
async function expectComposerPlainText(paneTestId: string, text: string): Promise<void> {
  const inputSelector = `[data-testid="${paneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`;
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector, expectedText) =>
          (document.querySelector<HTMLElement>(selector)?.textContent ?? "").trim() ===
          expectedText,
        inputSelector,
        text,
      ),
    { timeout: 15000, timeoutMsg: `composer 文本不匹配: ${paneTestId}` },
  );
}

async function clickSlashSuggestionOption(optionId: string): Promise<void> {
  // 修复原因：面板可能因编辑器失焦（新辅助 tab autofocus）瞬时关闭；"先查后点"两次
  // 往返之间选项会消失。这里把查找与 mousedown 合成单个原子脚本并整体重试。
  // MentionPanel 选项在 onMouseDown 触发 onSelect，element.click() 不会命中。
  await browser.waitUntil(
    async () =>
      browser.execute((nextOptionId) => {
        const option = document.querySelector<HTMLButtonElement>(
          `[data-option-id="${CSS.escape(nextOptionId)}"]`,
        );
        if (!option) return false;
        option.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
        );
        return true;
      }, optionId),
    { timeout: 15000, timeoutMsg: `斜杠面板没有出现选项: ${optionId}` },
  );
}

async function expectSlashPanelWithoutAppCommands(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
        TID_PROMPT_SUGGESTION_PANEL,
      ),
    { timeout: 15000, timeoutMsg: "斜杠面板没有打开" },
  );
  const hasAppCommand = await browser.execute(() =>
    Boolean(document.querySelector('[data-option-id^="app-slash:"]')),
  );
  expect(hasAppCommand).toBe(false);
}

async function dismissSlashPanel(paneTestId: string): Promise<void> {
  await browser.keys("Escape");
  await clearComposerByKeyboard(paneTestId);
}

async function openNewTaskDraft(): Promise<void> {
  const clicked = await browser.execute(() => {
    const button = document.querySelector<HTMLElement>('[data-testid="task-new-button"]');
    button?.click();
    return Boolean(button);
  });
  expect(clicked).toBe(true);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (paneTestId) =>
          document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`)?.dataset
            .sessionId === "draft",
        testId(TID_V4_SESSION_PANE, "workspace-main"),
      ),
    { timeout: 30000, timeoutMsg: "新建任务后主 pane 没有进入草稿态" },
  );
}

async function closeSelectionSideTab(tabId?: string): Promise<void> {
  const clicked = await browser.execute((targetTabId) => {
    const tab = document.querySelector<HTMLElement>(
      targetTabId
        ? `[data-side-pane-tab-id="${CSS.escape(targetTabId)}"]`
        : '[data-side-pane-tab-id^="selection-side-chat:"]',
    );
    const button = tab?.querySelector<HTMLButtonElement>("button");
    button?.click();
    return Boolean(button);
  }, tabId);
  expect(clicked).toBe(true);
}
