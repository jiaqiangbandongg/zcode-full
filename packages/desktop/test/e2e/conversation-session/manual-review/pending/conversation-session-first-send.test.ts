import { clearAppData } from "../../../helpers/desktop-app.js";
import { waitForUpstreamNetworkCapture } from "../../../helpers/upstream-capture.js";
import {
  E2E_REPLY_TOKEN,
  buildReadonlyToolPrompt,
  getChatRootSnapshot,
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区首发和完成态 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("首发应创建 session，完成后继续发送应进入下一轮", async function () {
    this.timeout(150000);

    await prepareConversationE2E();

    const runId = Date.now();
    const firstPrompt = buildReadonlyToolPrompt(`E2E_FIRST_SEND_${runId}`);
    await sendPrompt(firstPrompt);
    await waitForComposerText("", "首发后输入框没有清空");
    await waitForUserMessageContaining(firstPrompt);
    const firstSnapshot = await waitForChatState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "首发后 chat-view 没有回填 session/task id",
      30000,
    );
    expect(firstSnapshot.sessionId).toBeTruthy();
    expect(firstSnapshot.queueCount).toBe(0);
    await waitForUpstreamNetworkCapture(`E2E_FIRST_SEND_${runId}`);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "首轮完成后 chat-view 没有回到 idle",
      90000,
    );

    const secondPrompt =
      `E2E_SECOND_TURN_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(secondPrompt);
    await waitForComposerText("", "第二轮发送后输入框没有清空");
    await waitForUserMessageContaining(secondPrompt);
    await waitForUpstreamNetworkCapture(`E2E_SECOND_TURN_${runId}`);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);

    const finalSnapshot = await getChatRootSnapshot();
    expect(finalSnapshot.sessionId || finalSnapshot.taskId).toBe(
      firstSnapshot.sessionId || firstSnapshot.taskId,
    );
    expect(finalSnapshot.queueCount).toBe(0);
  });
});
