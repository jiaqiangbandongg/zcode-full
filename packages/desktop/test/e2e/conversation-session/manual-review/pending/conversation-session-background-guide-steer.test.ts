import { TID_CHAT_INPUT } from "@zcode/shared";
import { clearAppData, readSettings } from "../../../helpers/desktop-app.js";
import { waitForUpstreamNetworkRequestStarted } from "../../../helpers/upstream-capture.js";
import {
  clickChatStop,
  clickChatSend,
  findFirstUpstreamRequestIndex,
  getChatRootSnapshot,
  getComposerText,
  getUpstreamRequestRecordCount,
  getQueueItems,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequest,
  waitForToolCallBlockByToolCallId,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";
import { respondToToolCrossProductBlockers } from "../../../helpers/conversation-session-tool-cross-product.js";

const BACKGROUND_GUIDE_STEER_TIMEOUT_MS = 180000;

describe("会话区 Background Guide Steer E2E", () => {
  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("background Agent 创建过程中发送 guide 消息，应随 launch tool result 合流进下一次模型请求", async function () {
    this.timeout(BACKGROUND_GUIDE_STEER_TIMEOUT_MS);

    await prepareConversationE2E();
    expect((await readSettings()).zcodeInteractionBehavior).toBe("guide");
    await startNewTask();

    const runId = Date.now();
    const launchMarker = `E2E_BACKGROUND_GUIDE_STEER_LAUNCH_${runId}`;
    const guideMarker = `E2E_BACKGROUND_GUIDE_STEER_MESSAGE_${runId}`;
    const requestCountBefore = await getUpstreamRequestRecordCount();

    await sendPrompt(
      `${launchMarker}: Start a background agent and keep this main turn active while I guide it.`,
    );
    await waitForComposerText("", "background guide steer launch prompt 发送后输入框没有清空");
    await waitForUserMessageContaining(launchMarker);
    await waitForUpstreamNetworkRequestStarted(launchMarker);
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "background guide steer 首轮请求开始后没有保持 streaming",
      30000,
    );

    await sendPromptWithoutInputClick(
      `${guideMarker}: This guidance should be coalesced with the background launch tool result.`,
    );
    await waitForComposerText("", "background guide steer 引导消息发送后输入框没有清空");
    await waitForGuideProjection(guideMarker);
    await waitForToolCallBlockByToolCallId(
      "toolu_e2e_background_guide_steer_agent",
      60000,
    );
    await respondToToolCrossProductBlockers();

    const coalescedIndex = await waitForFirstRequestIndex(
      {
        includes: [launchMarker, guideMarker, "Async agent launched successfully"],
        lastUserMessageExcludes: ["<task-notification>"],
      },
      requestCountBefore,
      "background guide steer 没有随 Agent launch tool result 合流进下一次模型请求",
    );
    await waitForAssistantMessageContaining("background-guide-steer-launch-consumed-ok");
    await waitForChatState(
      (snapshot) => snapshot.queueCount === 0,
      "background guide steer launch 合流后仍残留普通 queue",
      30000,
    );

    const notificationIndex = await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_BACKGROUND_GUIDE_STEER_CHILD_DONE"],
        lastUserMessageIncludes: ["<task-notification>"],
      },
      coalescedIndex,
      "background guide steer Agent completion notification 没有进入父模型请求",
    );
    expect(notificationIndex).toBeGreaterThan(coalescedIndex);
    await waitForAssistantMessageContaining("background-guide-steer-notification-consumed-ok");
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "background guide steer notification 后会话没有回到 idle",
      90000,
    );
  });
});

async function waitForFirstRequestIndex(
  query: Parameters<typeof waitForUpstreamRequest>[0],
  afterIndex: number,
  timeoutMsg: string,
) {
  await waitForUpstreamRequest(query, timeoutMsg, 45000, { afterIndex });
  const index = await findFirstUpstreamRequestIndex(query, { afterIndex });
  if (index === null) {
    throw new Error(`${timeoutMsg}; request disappeared after wait`);
  }
  return index;
}

async function waitForGuideProjection(marker: string) {
  await browser.waitUntil(
    async () => {
      const queue = await getQueueItems();
      if (queue.some((item) => item.content.includes(marker) && item.kind === "turn-steer")) {
        return true;
      }
      const snapshot = await getChatRootSnapshot();
      return snapshot.queueCount === 0;
    },
    {
      timeout: 30000,
      timeoutMsg: `background guide steer 没有观察到 guide 投影或合流: ${marker}`,
    },
  );
}

async function sendPromptWithoutInputClick(prompt: string) {
  const focused = await browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(
      `[data-testid="${inputTestId}"]`,
    );
    input?.focus();
    return document.activeElement === input;
  }, TID_CHAT_INPUT);
  expect(focused).toBe(true);
  await browser.keys(prompt);
  await browser.waitUntil(async () => (await getComposerText()) === prompt, {
    timeout: 10000,
    timeoutMsg: `background guide steer 没有通过键盘写入 prompt: ${prompt}`,
  });
  await clickChatSend();
}

async function stopIfBusy() {
  const snapshot = await getChatRootSnapshot().catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickChatStop().catch(() => undefined);
  await waitForChatState(
    (candidate) => candidate.state !== "streaming",
    "background guide steer 清理阶段没有退出 streaming",
    30000,
  ).catch(() => undefined);
}
