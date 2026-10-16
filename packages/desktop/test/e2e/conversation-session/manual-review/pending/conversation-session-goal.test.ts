import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleUserMessagesNotContaining,
  clickChatStop,
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
  getChatRootSnapshot,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForChatState,
  waitForComposerText,
  waitForQueueContaining,
  waitForQueueCount,
  waitForTaskStoreSnapshot,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区 Goal E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("completed 下 /goal 设置和更新目标；running 与 held queue 下只入队", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    const runId = Date.now();
    const firstGoalObjective =
      `E2E_GOAL_SET_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const firstGoal = `/goal ${firstGoalObjective}`;
    await sendPrompt(firstGoal);
    await waitForComposerText("", "首个 /goal 发送后输入框没有清空");
    await waitForUserMessageContaining(firstGoalObjective);
    await waitForChatState(
      (snapshot) =>
        snapshot.queueCount === 0 &&
        snapshot.targetStatus === "active" &&
        snapshot.targetObjective?.includes(`E2E_GOAL_SET_${runId}`) === true,
      "首个 /goal 没有设置 active target",
      90000,
    );
    const firstGoalStreaming = await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "首个 /goal 设置后没有进入目标验证/继续运行",
      30000,
    );
    expect(firstGoalStreaming.targetStatus).toBe("active");
    expect(firstGoalStreaming.targetStatus).not.toBe("validating");
    await expectNoGoalValidatingLockForWindow(firstGoalStreaming);
    await assertVisibleUserMessagesNotContaining("goal-continuation");
    await assertVisibleUserMessagesNotContaining("Current session goal state");
    const firstGoalCompletedSnapshot = await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        !snapshot.stopRequested &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(`E2E_GOAL_SET_${runId}`) === true &&
        isCompletedTargetStatus(snapshot.targetStatus),
      // 修复原因：GL/H02 验证 completed 下已有 goal 再更新；旧 case 通过 stop
      // 制造空闲态，但 stop 后 runtime activeInputId 会短暂保留，下一条 /goal 容易被当成 queue。
      "首个 /goal 没有通过 verifier 自然进入完成态",
      60000,
    );
    if (!firstGoalCompletedSnapshot.taskId) {
      throw new Error("首个 /goal 完成后没有可用 taskId");
    }
    await waitForTaskStoreSnapshot(
      firstGoalCompletedSnapshot.taskId,
      (snapshot) =>
        snapshot.activeInputId === null &&
        snapshot.queueCount === 0 &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.taskMeta?.targetObjective?.includes(`E2E_GOAL_SET_${runId}`) === true &&
        isCompletedTargetStatus(snapshot.taskMeta?.targetStatus ?? null),
      // 修复原因：CI 机器上 goal verifier 的 DOM 状态和 Zustand task meta
      // 可能不在同一帧收口。更新 /goal 前必须等 store 也进入真正完成态，
      // 否则发送入口会按 active target 保护把更新命令排入 queue。
      "首个 /goal 完成后 task store 没有收口到 completed target",
      30000,
    );

    const updatedGoalObjective =
      `E2E_GOAL_UPDATE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const updatedGoal = `/goal ${updatedGoalObjective}`;
    await sendPrompt(updatedGoal);
    await waitForComposerText("", "更新 /goal 发送后输入框没有清空");
    await waitForUserMessageContaining(updatedGoalObjective);
    await waitForChatState(
      (snapshot) =>
        snapshot.queueCount === 0 &&
        snapshot.targetStatus === "active" &&
        snapshot.targetObjective?.includes(`E2E_GOAL_UPDATE_${runId}`) === true,
      "更新 /goal 没有替换 active target",
      90000,
    );
    const updatedGoalStreaming = await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "更新 /goal 后没有进入目标验证/继续运行",
      30000,
    );
    expect(updatedGoalStreaming.targetStatus).toBe("active");
    expect(updatedGoalStreaming.targetStatus).not.toBe("validating");
    await expectNoGoalValidatingLockForWindow(updatedGoalStreaming);
    await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        !snapshot.stopRequested &&
        snapshot.queueCount === 0 &&
        snapshot.targetObjective?.includes(`E2E_GOAL_UPDATE_${runId}`) === true &&
        isCompletedTargetStatus(snapshot.targetStatus),
      "更新 /goal 没有通过 verifier 自然进入完成态",
      60000,
    );

    await startNewTask();
    await waitForChatState(
      (snapshot) => snapshot.taskId === null && snapshot.queueCount === 0,
      "新建任务后没有进入空会话草稿态",
      15000,
    );

    const slowPrompt =
      `E2E_SLOW_STREAM E2E_GOAL_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(slowPrompt);
    await waitForComposerText("", "goal 已设置后普通消息发送没有清空输入框");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "goal 已设置后普通消息没有进入 streaming",
      30000,
    );

    const runningGoal = `/goal E2E_GOAL_RUNNING_QUEUE_${runId}`;
    await sendPrompt(runningGoal);
    await waitForQueueContaining(`E2E_GOAL_RUNNING_QUEUE_${runId}`);
    let queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("goal");
    await expectNoUpstreamRequestForTextWithin(
      `E2E_GOAL_RUNNING_QUEUE_${runId}`,
      900,
    );

    await clickChatStop();
    await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.queueCount === 1,
      "stop 后没有保留 running 中追加的 /goal queue",
      30000,
    );

    const heldGoal = `/goal E2E_GOAL_HELD_QUEUE_${runId}`;
    const heldRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_GOAL_HELD_QUEUE_${runId}`,
    );
    await sendPrompt(heldGoal);
    await waitForQueueContaining(`E2E_GOAL_HELD_QUEUE_${runId}`);
    queue = await waitForQueueCount(2);
    expect(queue.map((item) => item.kind)).toEqual(["goal", "goal"]);
    await expectNoUpstreamRequestForTextWithin(
      `E2E_GOAL_HELD_QUEUE_${runId}`,
      900,
    );
    expect(await countUpstreamRequestsContaining(`E2E_GOAL_HELD_QUEUE_${runId}`)).toBe(
      heldRequestsBefore,
    );
  });
});

function isCompletedTargetStatus(status: string | null) {
  return status === "complete" || status === "completed";
}

async function expectNoGoalValidatingLockForWindow(
  initialSnapshot: Awaited<ReturnType<typeof getChatRootSnapshot>>,
  durationMs = 800,
) {
  const deadline = Date.now() + durationMs;
  let sawStreaming = initialSnapshot.state === "streaming";
  let sawActiveTarget = initialSnapshot.targetStatus === "active";
  const statuses: Array<{ state: string | null; targetStatus: string | null }> = [
    {
      state: initialSnapshot.state,
      targetStatus: initialSnapshot.targetStatus,
    },
  ];

  while (Date.now() < deadline) {
    const snapshot = await getChatRootSnapshot();
    statuses.push({
      state: snapshot.state,
      targetStatus: snapshot.targetStatus,
    });
    sawStreaming ||= snapshot.state === "streaming";
    sawActiveTarget ||= snapshot.targetStatus === "active";
    expect(snapshot.targetStatus).not.toBe("validating");
    await browser.pause(100);
  }

  expect({ sawActiveTarget, sawStreaming, statuses }).toEqual(
    expect.objectContaining({
      sawActiveTarget: true,
      sawStreaming: true,
    }),
  );
}
