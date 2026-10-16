import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import { UPSTREAM_MODEL } from "../../../helpers/upstream-provider.js";
import {
  E2E_REPLY_TOKEN,
  buildReadonlyToolPrompt,
  clickChatStop,
  getQueueItems,
  prepareConversationE2E,
  sendPrompt,
  waitForChatState,
  waitForCompactMarkerStatus,
  waitForComposerText,
} from "../../../helpers/conversation-session.js";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";

describe("会话区 Interrupted 后手动 Compact E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("completed interrupted 且 queue=0 时应允许手动 compact", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    const runId = Date.now();
    const prepPromptOne = `E2E_COMPACT_INTERRUPTED_PREP_ONE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(prepPromptOne);
    await waitForUpstreamNetworkCapture(`E2E_COMPACT_INTERRUPTED_PREP_ONE_${runId}`);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "第一轮 interrupted compact 预置消息没有完成",
      30000,
    );

    const prepPromptTwo = buildReadonlyToolPrompt(
      `E2E_COMPACT_INTERRUPTED_PREP_TWO_${runId}`,
    );
    await sendPrompt(prepPromptTwo);
    await waitForUpstreamNetworkCapture(`E2E_COMPACT_INTERRUPTED_PREP_TWO_${runId}`);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "第二轮 interrupted compact 预置消息没有完成",
      30000,
    );

    const interruptedPrompt = `E2E_SLOW_STREAM E2E_COMPACT_INTERRUPTED_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(interruptedPrompt);
    await waitForComposerText("", "interrupted compact 运行轮发送后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "interrupted compact 运行轮没有进入 streaming",
      30000,
    );

    await clickChatStop();
    await waitForChatState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 0,
      "stop 后没有进入 completed interrupted 且 queue=0",
      30000,
    );

    await sendPrompt("/compact");
    await waitForComposerText("", "interrupted 后 /compact 发送后输入框没有清空");
    const startedMarker = await waitForCompactMarkerStatus("started", "manual");
    expect(startedMarker.inputId).toBeTruthy();
    expect(await getQueueItems()).toHaveLength(0);

    const compactRecord = await waitForUpstreamNetworkCapture(COMPACT_REQUEST_SENTINEL);
    assertUpstreamRequestCapture(compactRecord, {
      expectedText: COMPACT_REQUEST_SENTINEL,
      model: UPSTREAM_MODEL,
    });

    const completedMarker = await waitForCompactMarkerStatus(
      "completed",
      "manual",
      startedMarker.inputId,
    );
    expect(completedMarker.operationId).toBeTruthy();
    expect(await getQueueItems()).toHaveLength(0);
  });
});
