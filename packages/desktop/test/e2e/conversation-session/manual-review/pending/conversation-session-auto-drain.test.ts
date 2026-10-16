import { clearAppData } from "../../../helpers/desktop-app.js";
import { waitForUpstreamNetworkCapture } from "../../../helpers/upstream-capture.js";
import {
  E2E_REPLY_TOKEN,
  getMessages,
  getQueueItems,
  prepareConversationE2E,
  sendPrompt,
  waitForChatState,
  waitForComposerText,
  waitForQueueContaining,
  waitForQueueCount,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区 Auto Drain E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 正常完成后应自动消费队首 queued prompt", async function () {
    this.timeout(90000);

    await prepareConversationE2E();

    const runId = Date.now();
    const runningPrompt = `E2E_AUTO_DRAIN_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(runningPrompt);
    await waitForComposerText(
      "",
      "首轮 auto-drain prompt 发送后输入框没有清空",
    );
    await waitForUserMessageContaining(runningPrompt);
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "首轮 auto-drain prompt 没有进入 streaming",
      30000,
    );

    const queuedPrompt = `E2E_AUTO_DRAIN_QUEUED_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(queuedPrompt);
    await waitForComposerText(
      "",
      "running 中 queued prompt 发送后输入框没有清空",
    );
    await waitForQueueContaining(`E2E_AUTO_DRAIN_QUEUED_${runId}`);
    const queuedItems = await waitForQueueCount(1);
    expect(queuedItems[0]?.kind).toBe("text");
    expect(queuedItems[0]?.content).toContain(`E2E_AUTO_DRAIN_QUEUED_${runId}`);

    await waitForUpstreamNetworkCapture(`E2E_AUTO_DRAIN_QUEUED_${runId}`);
    await waitForUserMessageContaining(queuedPrompt);
    await waitForChatState(
      (snapshot) =>
        snapshot.state === "idle" &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.queueCount === 0,
      "首轮完成后没有自动消费 queued prompt 并清空 queue",
      90000,
    );

    expect(await getQueueItems()).toHaveLength(0);
    const assistantMessages = await getMessages("assistant");
    expect(
      assistantMessages.filter((message) =>
        message.text.includes(E2E_REPLY_TOKEN),
      ),
    ).toHaveLength(2);
  });
});
