import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleUserMessagesNotContaining,
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
  getQueueItems,
  prepareConversationE2E,
  sendPrompt,
  typeChatPrompt,
  clickChatSend,
  clickChatStop,
  waitForChatState,
  waitForComposerText,
  waitForQueueContaining,
  waitForQueueCount,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区 Running Queue E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 中普通输入和 /goal 应入队，/compact 应被拒绝且没有副作用", async function () {
    this.timeout(150000);

    await prepareConversationE2E();

    const runId = Date.now();
    const firstPrompt =
      `E2E_SLOW_STREAM E2E_RUNNING_QUEUE_FIRST_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(firstPrompt);
    await waitForComposerText("", "首轮发送后输入框没有清空");
    await waitForUserMessageContaining(firstPrompt);
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "首轮发送后 chat-view 没有进入 streaming",
      30000,
    );

    const secondPrompt =
      `E2E_RUNNING_QUEUE_SECOND_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(secondPrompt);
    await waitForComposerText("", "running 中第二条发送后输入框没有清空");
    await waitForQueueContaining(`E2E_RUNNING_QUEUE_SECOND_${runId}`);
    let queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("text");

    const thirdPrompt =
      `E2E_RUNNING_QUEUE_THIRD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(thirdPrompt);
    await waitForQueueContaining(`E2E_RUNNING_QUEUE_THIRD_${runId}`);
    queue = await waitForQueueCount(2);
    expect(queue.map((item) => item.content).join("\n")).toContain(
      `E2E_RUNNING_QUEUE_SECOND_${runId}`,
    );
    expect(queue.map((item) => item.content).join("\n")).toContain(
      `E2E_RUNNING_QUEUE_THIRD_${runId}`,
    );

    const fourthPrompt =
      `E2E_RUNNING_QUEUE_FOURTH_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(fourthPrompt);
    await waitForQueueContaining(`E2E_RUNNING_QUEUE_FOURTH_${runId}`);
    queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.content).join("\n")).toContain(
      `E2E_RUNNING_QUEUE_FOURTH_${runId}`,
    );
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "text"]);

    const fifthPrompt =
      `E2E_RUNNING_QUEUE_FIFTH_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(fifthPrompt);
    await waitForQueueContaining(`E2E_RUNNING_QUEUE_FIFTH_${runId}`);
    queue = await waitForQueueCount(4);
    expect(queue.map((item) => item.content).join("\n")).toContain(
      `E2E_RUNNING_QUEUE_FIFTH_${runId}`,
    );
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "text", "text"]);

    const compactRequestsBefore = await countUpstreamRequestsContaining(
      "CRITICAL: Respond with TEXT ONLY",
    );
    await typeChatPrompt("/compact");
    await clickChatSend();
    await expectNoUpstreamRequestForTextWithin(
      "CRITICAL: Respond with TEXT ONLY",
      500,
    );
    expect(
      await countUpstreamRequestsContaining("CRITICAL: Respond with TEXT ONLY"),
    ).toBe(compactRequestsBefore);
    expect(await getQueueItems()).toHaveLength(4);
    await assertVisibleUserMessagesNotContaining("/compact");

    const goalPrompt = `/goal E2E_RUNNING_QUEUE_GOAL_${runId}`;
    await sendPrompt(goalPrompt);
    await browser.waitUntil(
      async () => {
        queue = await getQueueItems();
        const queueContent = queue.map((item) => item.content).join("\n");
        return (
          queueContent.includes(`E2E_RUNNING_QUEUE_SECOND_${runId}`) &&
          queueContent.includes(`E2E_RUNNING_QUEUE_THIRD_${runId}`) &&
          queueContent.includes(`E2E_RUNNING_QUEUE_FOURTH_${runId}`) &&
          queueContent.includes(`E2E_RUNNING_QUEUE_FIFTH_${runId}`) &&
          queueContent.includes(`E2E_RUNNING_QUEUE_GOAL_${runId}`)
        );
      },
      {
        timeout: 30000,
        timeoutMsg: "队列没有同时保留 running 中发送的普通消息和 /goal",
      },
    );
    const goalItem = queue.find((item) =>
      item.content.includes(`E2E_RUNNING_QUEUE_GOAL_${runId}`),
    );
    expect(goalItem?.kind).toBe("goal");

    await browser.waitUntil(
      async () =>
        (await countUpstreamRequestsContaining(
          `E2E_RUNNING_QUEUE_FIRST_${runId}`,
        )) >= 1,
      {
        timeout: 10000,
        timeoutMsg: "没有捕获到首轮 running 请求",
      },
    );
    await clickChatStop();
  });
});
