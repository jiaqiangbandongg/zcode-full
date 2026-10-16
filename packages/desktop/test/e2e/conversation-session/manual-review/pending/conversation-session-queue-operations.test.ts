import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  clickChatStop,
  clickQueueEdit,
  clickQueueEditSave,
  clickQueueRemove,
  countUpstreamRequestsContaining,
  dragQueueItemOnto,
  getComposerText,
  getQueueItems,
  prepareConversationE2E,
  sendPrompt,
  setQueueEditInputText,
  waitForChatState,
  waitForComposerText,
  waitForQueueCount,
  waitForQueueOrderContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区 Held Queue 操作 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("held queue 中编辑、重排、删除都只影响 queue 本身且不触发模型请求", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    const runId = Date.now();
    const runningPrompt =
      `E2E_SLOW_STREAM E2E_QUEUE_OPS_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(runningPrompt);
    await waitForComposerText("", "held queue 操作首轮发送后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "held queue 操作首轮没有进入 streaming",
      30000,
    );

    const firstQueuedPrompt =
      `E2E_QUEUE_OPS_FIRST_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const secondQueuedPrompt =
      `E2E_QUEUE_OPS_SECOND_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const thirdQueuedPrompt =
      `E2E_QUEUE_OPS_THIRD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendPrompt(firstQueuedPrompt);
    await waitForQueueCount(1);
    await sendPrompt(secondQueuedPrompt);
    await waitForQueueCount(2);
    await sendPrompt(thirdQueuedPrompt);
    let queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.content)).toEqual([
      firstQueuedPrompt,
      secondQueuedPrompt,
      thirdQueuedPrompt,
    ]);

    await clickChatStop();
    await waitForChatState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 3,
      "held queue 操作 stop 后没有保留 3 条队列",
      30000,
    );

    queue = await getQueueItems();
    const firstId = queue[0]?.id;
    const secondId = queue[1]?.id;
    const thirdId = queue[2]?.id;
    if (!firstId || !secondId || !thirdId) {
      throw new Error(`队列项 id 缺失: ${JSON.stringify(queue)}`);
    }

    const editedSecondPrompt =
      `E2E_QUEUE_OPS_SECOND_EDITED_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const editedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_QUEUE_OPS_SECOND_EDITED_${runId}`,
    );
    await clickQueueEdit(secondId);
    await setQueueEditInputText(secondId, editedSecondPrompt);
    await clickQueueEditSave(secondId);
    queue = await waitForQueueOrderContaining(
      [
        `E2E_QUEUE_OPS_FIRST_${runId}`,
        `E2E_QUEUE_OPS_SECOND_EDITED_${runId}`,
        `E2E_QUEUE_OPS_THIRD_${runId}`,
      ],
      "编辑队列项后没有保持原顺序并更新内容",
    );
    expect(queue[1]?.id).toBe(secondId);
    expect(await getComposerText()).toBe("");
    expect(
      await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_SECOND_EDITED_${runId}`),
    ).toBe(editedRequestsBefore);

    await dragQueueItemOnto(thirdId, firstId);
    queue = await waitForQueueOrderContaining(
      [
        `E2E_QUEUE_OPS_THIRD_${runId}`,
        `E2E_QUEUE_OPS_FIRST_${runId}`,
        `E2E_QUEUE_OPS_SECOND_EDITED_${runId}`,
      ],
      "重排队列项后没有只改变 queue 顺序",
    );
    expect(queue.map((item) => item.id)).toEqual([thirdId, firstId, secondId]);
    expect(await getComposerText()).toBe("");

    const removedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_QUEUE_OPS_FIRST_${runId}`,
    );
    await clickQueueRemove(firstId);
    queue = await waitForQueueCount(2);
    expect(queue.map((item) => item.id)).toEqual([thirdId, secondId]);
    expect(queue.map((item) => item.content).join("\n")).not.toContain(
      `E2E_QUEUE_OPS_FIRST_${runId}`,
    );
    expect(await getComposerText()).toBe("");
    expect(
      await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_FIRST_${runId}`),
    ).toBe(removedRequestsBefore);
  });
});
