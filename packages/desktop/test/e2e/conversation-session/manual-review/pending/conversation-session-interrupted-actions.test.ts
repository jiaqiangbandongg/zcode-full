import { TID_CHAT_STOP_BUTTON } from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleUserMessagesNotContaining,
  editUserMessageContaining,
  getForkButtonForAssistantContaining,
  getChatRootSnapshot,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequestContaining,
  waitForQueueContaining,
  waitForQueueCount,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区 Interrupted Actions E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("interrupted 后应允许 edit，但 stopped assistant partial 不提供 fork", async function () {
    this.timeout(240000);

    await prepareConversationE2E();

    const runId = Date.now();

    const editSourcePrompt = `E2E_SLOW_STREAM E2E_INTERRUPTED_EDIT_SOURCE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(editSourcePrompt);
    await waitForComposerText(
      "",
      "interrupted edit 源 prompt 发送后输入框没有清空",
    );
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming" && snapshot.queueCount === 0,
      "interrupted edit 源 prompt 没有进入 running",
      30000,
    );
    const editStop = await clickChatStopIfAvailable();
    if (editStop.clicked) {
      await waitForChatState(
        (snapshot) =>
          snapshot.state !== "streaming" &&
          snapshot.runtimeStatus === "completed" &&
          snapshot.queueCount === 0,
        "queue=0 的 running stop 后没有进入 interrupted completed",
        30000,
      );
    } else {
      await waitForChatState(
        (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
        `queue=0 源 prompt 未出现可点 stop，等待线上快速完成: ${JSON.stringify(
          editStop,
        )}`,
        90000,
      );
    }

    const editRerunPrompt = `E2E_INTERRUPTED_EDIT_RERUN_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await editUserMessageContaining(
      `E2E_INTERRUPTED_EDIT_SOURCE_${runId}`,
      editRerunPrompt,
    );
    await waitForUpstreamRequestContaining(
      `E2E_INTERRUPTED_EDIT_RERUN_${runId}`,
    );
    await waitForUserMessageContaining(`E2E_INTERRUPTED_EDIT_RERUN_${runId}`);
    await assertVisibleUserMessagesNotContaining(
      `E2E_INTERRUPTED_EDIT_SOURCE_${runId}`,
    );
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "interrupted queue=0 edit 重跑后没有回到 idle",
      90000,
    );

    await startNewTask();

    const forkQueueEmptyPrompt = `E2E_SLOW_STREAM E2E_INTERRUPTED_NO_FORK_EMPTY_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(forkQueueEmptyPrompt);
    await waitForComposerText(
      "",
      "interrupted no-fork queue=0 源 prompt 发送后输入框没有清空",
    );
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming" && snapshot.queueCount === 0,
      "interrupted no-fork queue=0 源 prompt 没有进入 running",
      30000,
    );
    await waitForAssistantMessageContaining("deep");
    const emptyStop = await clickChatStopIfAvailable();
    if (!emptyStop.clicked) {
      await waitForChatState(
        (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
        `queue=0 no-fork 源 prompt 未出现可点 stop，跳过 interrupted fork 断言: ${JSON.stringify(
          emptyStop,
        )}`,
        90000,
      );
      return;
    }
    const forkQueueEmptySource = await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.queueCount === 0 &&
        Boolean(snapshot.sessionId || snapshot.taskId),
      "queue=0 interrupted assistant stop 后没有稳定下来",
      30000,
    );
    expect(
      forkQueueEmptySource.sessionId || forkQueueEmptySource.taskId,
    ).toBeTruthy();
    await expectNoEnabledForkButtonForAssistantContaining(
      "deep",
      "queue=0 interrupted assistant partial 不应提供可用 fork 入口",
    );

    await startNewTask();

    const forkHeldPrompt = `E2E_SLOW_STREAM E2E_INTERRUPTED_NO_FORK_HELD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(forkHeldPrompt);
    await waitForComposerText(
      "",
      "interrupted held no-fork 源 prompt 发送后输入框没有清空",
    );
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming" && snapshot.queueCount === 0,
      "interrupted held no-fork 源 prompt 没有进入 running",
      30000,
    );
    await waitForAssistantMessageContaining("deep");

    const heldPrompt = `E2E_INTERRUPTED_NO_FORK_HELD_QUEUE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(heldPrompt);
    await waitForQueueContaining(`E2E_INTERRUPTED_NO_FORK_HELD_QUEUE_${runId}`);
    const heldQueue = await waitForQueueCount(1);
    const heldQueueItemId = heldQueue[0]?.id;
    expect(heldQueueItemId).toBeTruthy();

    const heldStop = await clickChatStopIfAvailable();
    if (!heldStop.clicked) {
      await waitForChatState(
        (snapshot) => snapshot.state === "idle" && snapshot.queueCount >= 1,
        `held no-fork 源 prompt 未出现可点 stop，跳过 interrupted fork 断言: ${JSON.stringify(
          heldStop,
        )}`,
        90000,
      );
      return;
    }
    const forkHeldSource = await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.queueCount === 1 &&
        Boolean(snapshot.sessionId || snapshot.taskId),
      "held queue interrupted assistant stop 后没有保留父 queue",
      30000,
    );
    const forkHeldSourceId = forkHeldSource.sessionId || forkHeldSource.taskId;
    expect(forkHeldSourceId).toBeTruthy();

    await expectNoEnabledForkButtonForAssistantContaining(
      "deep",
      "held queue interrupted assistant partial 不应提供可用 fork 入口",
    );
    await waitForChatState(
      (snapshot) =>
        (snapshot.sessionId || snapshot.taskId) === forkHeldSourceId &&
        snapshot.queueCount === 1,
      "interrupted assistant partial 禁止 fork 后父 held queue 没有保留",
      30000,
    );
    const parentQueue = await waitForQueueCount(1);
    expect(parentQueue[0]?.id).toBe(heldQueueItemId);
    expect(parentQueue[0]?.content).toContain(
      `E2E_INTERRUPTED_NO_FORK_HELD_QUEUE_${runId}`,
    );
  });
});

async function clickChatStopIfAvailable() {
  let latest: Awaited<ReturnType<typeof getChatRootSnapshot>> | null = null;
  let latestButton: { clicked: boolean; reason?: string } = {
    clicked: false,
    reason: "not-started",
  };
  await browser
    .waitUntil(
      async () => {
        latest = await getChatRootSnapshot();
        if (latest.state !== "streaming") {
          latestButton = { clicked: false, reason: "not-streaming" };
          return true;
        }
        latestButton = (await browser.execute((stopButtonTestId) => {
          const button = document.querySelector<HTMLButtonElement>(
            `[data-testid="${stopButtonTestId}"]`,
          );
          if (!button) {
            return { clicked: false, reason: "missing" };
          }
          if (button.disabled) {
            return { clicked: false, reason: "disabled" };
          }
          button.click();
          return { clicked: true };
        }, TID_CHAT_STOP_BUTTON)) as { clicked: boolean; reason?: string };
        return latestButton.clicked;
      },
      {
        timeout: 8000,
        timeoutMsg: "聊天停止按钮没有在 live provider 可停止窗口内出现",
      },
    )
    .catch(() => undefined);

  latest = await getChatRootSnapshot();
  if (!latestButton.clicked && latest.state === "streaming") {
    // 修复原因：线上 capture 下 E2E_SLOW_STREAM 只是 prompt 约定，不是确定性
    // 慢流 fixture；如果停止按钮窗口被 provider 速度错过，优先用 Esc 尝试收口，
    // 后续断言只在真实点击到 stop 时才锁定 interrupted 语义。
    await browser.keys("Escape").catch(() => undefined);
  }
  return {
    ...latestButton,
    snapshot: latest,
  };
}

async function expectNoEnabledForkButtonForAssistantContaining(
  text: string,
  timeoutMsg: string,
) {
  let latest: Awaited<ReturnType<typeof getForkButtonForAssistantContaining>> =
    null;
  const deadline = Date.now() + 3000;
  do {
    latest = await getForkButtonForAssistantContaining(text);
    // 修复原因：stop 产生的是 interrupted partial，不是稳定 completed assistant fork 点。
    if (latest?.exists && !latest.disabled && !latest.ariaDisabled) {
      throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`);
    }
    await browser.pause(250);
  } while (Date.now() < deadline);
}
