import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleUserMessagesNotContaining,
  clickChatStop,
  expectNoUpstreamRequestForTextWithin,
  prepareConversationE2E,
  sendPrompt,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequestContaining,
  waitForQueueContaining,
  waitForQueueCount,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区 Prewarming Queue E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("A02: prewarming 中继续发普通文本应进入 queue 且不打断首轮", async function () {
    this.timeout(90000);

    await prepareConversationE2E();

    const runId = Date.now();
    const firstMarker = `E2E_PREWARMING_FIRST_${runId}`;
    const queuedMarker = `E2E_PREWARMING_QUEUED_${runId}`;
    const firstPrompt =
      `E2E_PREWARMING_DELAY ${firstMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const queuedPrompt =
      `${queuedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendPrompt(firstPrompt);
    await waitForComposerText("", "prewarming 首轮发送后输入框没有清空");
    await waitForUserMessageContaining(firstPrompt);
    await waitForUpstreamRequestContaining(firstMarker);
    const prewarmingSnapshot = await waitForChatState(
      (snapshot) =>
        Boolean(snapshot.sessionId || snapshot.taskId) &&
        snapshot.queueCount === 0 &&
        (snapshot.state === "submitting" || snapshot.state === "streaming"),
      "首轮发送后没有进入 prewarming/running 窗口",
      10000,
    );
    expect(prewarmingSnapshot.queueCount).toBe(0);

    await sendPrompt(queuedPrompt);
    await waitForComposerText("", "prewarming 中第二条发送后输入框没有清空");
    await waitForQueueContaining(queuedMarker);
    const queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("text");
    expect(queue[0]?.content).toContain(queuedMarker);
    await assertVisibleUserMessagesNotContaining(queuedPrompt);
    await expectNoUpstreamRequestForTextWithin(queuedMarker, 750);

    await clickChatStop();
    await waitForChatState(
      (snapshot) =>
        snapshot.state !== "submitting" &&
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 1,
      "停止 prewarming 首轮后没有保留 queued prompt",
      30000,
    );
  });
});
