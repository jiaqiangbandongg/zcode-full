import { clearAppData } from "../../../helpers/desktop-app.js";
import { waitForUpstreamNetworkCapture } from "../../../helpers/upstream-capture.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleUserMessagesNotContaining,
  buildReadonlyToolPrompt,
  clickChatStop,
  countUpstreamRequestsContaining,
  editUserMessageContaining,
  expectNoUpstreamRequestForTextWithin,
  getEditButtonForAssistantContaining,
  getQueueItems,
  getTaskStoreSnapshot,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  typeChatPrompt,
  clickChatSend,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForCompactMarkerStatus,
  waitForComposerText,
  waitForUpstreamRequestContaining,
  waitForEditButtonForUserContaining,
  waitForQueueContaining,
  waitForQueueCount,
  waitForToastContaining,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const COMPACT_DUPLICATE_BLOCKED_TOAST_TEXTS = [
  "A compaction is already running or queued.",
  "已有压缩任务正在运行或排队。",
];
const RESOLVE_USER_MESSAGE_ERROR = "Cannot resolve user message";
const REWIND_RUNNING_ERROR = "Cannot rewind while a prompt is running";
const EDIT_INTERRUPTED_SOURCE_REPLY_PREFIX = "deep";
const EDIT_INTERRUPTED_RERUN_REPLY_TOKEN = "upstream-e2e-edit-rerun-ok";

describe("会话区 Edit User Query E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("user query edit 应立即重跑；held queue 存在时仍保留 queue，running latest edit 可抢占", async function () {
    this.timeout(220000);

    await prepareConversationE2E();

    const runId = Date.now();
    const originalPrompt = `E2E_EDIT_ORIGINAL_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(originalPrompt);
    await waitForUpstreamNetworkCapture(`E2E_EDIT_ORIGINAL_${runId}`);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "edit 前首轮没有完成",
      90000,
    );

    expect((await getEditButtonForAssistantContaining(E2E_REPLY_TOKEN))?.exists).not.toBe(true);

    const editedPrompt = buildReadonlyToolPrompt(`E2E_EDIT_RERUN_${runId}`);
    await editUserMessageContaining(`E2E_EDIT_ORIGINAL_${runId}`, editedPrompt);
    await waitForComposerText("", "edit 提交后输入框没有清空");
    await waitForUpstreamNetworkCapture(`E2E_EDIT_RERUN_${runId}`);
    await waitForUserMessageContaining(`E2E_EDIT_RERUN_${runId}`);
    await assertVisibleUserMessagesNotContaining(`E2E_EDIT_ORIGINAL_${runId}`);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "edit 重跑完成后会话没有回到 idle",
      90000,
    );

    await startNewTask();

    const slowPrompt = `E2E_SLOW_STREAM E2E_EDIT_HELD_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(slowPrompt);
    await waitForComposerText("", "held queue 场景首轮发送后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "held queue 场景首轮没有进入 streaming",
      30000,
    );

    const heldPrompt = `E2E_EDIT_HELD_QUEUE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(heldPrompt);
    await waitForQueueContaining(`E2E_EDIT_HELD_QUEUE_${runId}`);
    const heldQueue = await waitForQueueCount(1);
    const heldQueueItemId = heldQueue[0]?.id;
    expect(heldQueueItemId).toBeTruthy();

    await clickChatStop();
    await waitForChatState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 1,
      "stop 后没有保留 held queue",
      30000,
    );
    await expectNoUpstreamRequestForTextWithin(`E2E_EDIT_HELD_QUEUE_${runId}`, 900);

    // 修复原因：edit 重跑必须精确命中 case-local controlled stream；
    // 否则会回退到 legacy 90.2s slow stream，并在 90s 等待边界误报成产品 bug。
    const heldEditPrompt = `E2E_SLOW_STREAM E2E_EDIT_HELD_RERUN_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await editUserMessageContaining(`E2E_EDIT_HELD_RUNNING_${runId}`, heldEditPrompt);
    await waitForUpstreamRequestContaining(`E2E_EDIT_HELD_RERUN_${runId}`);
    await waitForUserMessageContaining(`E2E_EDIT_HELD_RERUN_${runId}`);
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming" && snapshot.queueCount === 1,
      "held queue 存在时 edit 没有立即重跑并保留 queue",
      30000,
    );
    expect((await getQueueItems())[0]?.id).toBe(heldQueueItemId);

    await waitForEditButtonForUserContaining(`E2E_EDIT_HELD_RERUN_${runId}`);

    const followupPrompt = `E2E_EDIT_RUNNING_FOLLOWUP_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(followupPrompt);
    await waitForQueueContaining(`E2E_EDIT_RUNNING_FOLLOWUP_${runId}`);
    await waitForQueueCount(2);

    const goalPrompt = `/goal E2E_EDIT_RUNNING_GOAL_${runId}`;
    await sendPrompt(goalPrompt);
    await waitForQueueContaining(`E2E_EDIT_RUNNING_GOAL_${runId}`);
    let queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "goal"]);
    await expectNoUpstreamRequestForTextWithin(`E2E_EDIT_RUNNING_GOAL_${runId}`, 800);

    await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.queueCount === 3,
      "edit 重跑完成后没有稳定保留 3 条 queue",
      90000,
    );

    const compactRequestsBefore = await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await sendPrompt("/compact");
    await waitForComposerText("", "held queue 下手动 compact 发送后输入框没有清空");
    const startedMarker = await waitForCompactMarkerStatus("started", "manual");
    expect(startedMarker.inputId).toBeTruthy();
    await browser.waitUntil(
      async () =>
        (await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)) ===
        compactRequestsBefore + 1,
      {
        timeout: 10000,
        timeoutMsg: "held queue 下没有捕获到手动 compact 请求",
      },
    );
    queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "goal"]);

    const duplicateCompactRequestsBefore =
      await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await typeChatPrompt("/compact");
    await clickChatSend();
    await waitForToastContaining(
      COMPACT_DUPLICATE_BLOCKED_TOAST_TEXTS,
      "compacting 中重复 /compact 没有弹出 duplicate blocked toast",
    );
    await expectNoUpstreamRequestForTextWithin(COMPACT_REQUEST_SENTINEL, 800);
    expect(await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)).toBe(
      duplicateCompactRequestsBefore,
    );
    queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.kind)).toEqual(["text", "text", "goal"]);
    await assertVisibleUserMessagesNotContaining("/compact");

    const completedMarker = await waitForCompactMarkerStatus(
      "completed",
      "manual",
      startedMarker.inputId,
    );
    expect(completedMarker.operationId).toBeTruthy();
    await waitForChatState(
      (snapshot) =>
        snapshot.state !== "streaming" &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.queueCount === 3,
      "held queue 下手动 compact 完成后没有继续保留 queue",
      90000,
    );
  });

  it("中断模型回答后编辑已发送 user query 并重新提交，不应触发 turnIndex 解析错误", async function () {
    this.timeout(160000);

    await prepareConversationE2E();

    const runId = Date.now();
    const sourceMarker = `E2E_EDIT_INTERRUPTED_RESUBMIT_SOURCE_${runId}`;
    const rerunMarker = `E2E_EDIT_INTERRUPTED_RESUBMIT_RERUN_${runId}`;
    const rerunReplyToken = EDIT_INTERRUPTED_RERUN_REPLY_TOKEN;
    const sourcePrompt = `E2E_SLOW_STREAM ${sourceMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(sourcePrompt);
    await waitForComposerText("", "interrupted resubmit 源 prompt 发送后输入框没有清空");
    const runningSnapshot = await waitForChatState(
      (snapshot) =>
        snapshot.state === "streaming" && Boolean(snapshot.sessionId || snapshot.taskId),
      "interrupted resubmit 源 prompt 没有进入 streaming",
      30000,
    );
    const taskId = runningSnapshot.sessionId || runningSnapshot.taskId;
    if (!taskId) {
      throw new Error("interrupted resubmit 源 prompt 缺少 taskId/sessionId");
    }

    // 修复原因：默认 replay 在首个 assistant delta 之前 stop 时会触发 stream
    // recovery；真实 capture 下等完整回复又可能错过 stop 按钮，所以等首个 delta 后立刻中断。
    await waitForAssistantMessageContaining(EDIT_INTERRUPTED_SOURCE_REPLY_PREFIX);
    await clickChatStop();
    await waitForUserMessageContaining(sourceMarker);
    await waitForChatState(
      (snapshot) =>
        (snapshot.sessionId || snapshot.taskId) === taskId &&
        snapshot.state !== "streaming" &&
        snapshot.runtimeStatus === "completed" &&
        snapshot.queueCount === 0,
      "interrupted resubmit stop 后没有进入可编辑的 completed(interrupted) 状态",
      30000,
    );

    // 修复原因：interrupted edit 场景需要用不同回复区分旧 assistant 与 edit 后 rerun 结果，
    // 否则 UI 上看到同样 token 时无法判断是否真的执行了新 query。
    const editedPrompt = `${rerunMarker}: Reply with exactly "${rerunReplyToken}" and no other text.`;
    // 修复原因：Stop 后 renderer completed/stop ACK 可能早于 CLI protocol 的 active turn finally。
    // D10 只验证 interrupted user message 不再触发 turnIndex 解析错误；如果 active turn
    // 尚未释放，rewind busy guard 是可接受的即时编辑结果，不能强制要求 rerun 一定发出。
    await browser.pause(500);
    await editUserMessageContaining(sourceMarker, editedPrompt);
    await waitForComposerText("", "interrupted resubmit edit 提交后输入框没有清空");
    const outcome = await waitForInterruptedEditOutcomeWithoutResolveUserMessageError(
      rerunMarker,
      taskId,
    );
    if (outcome === "busy") {
      await expectNoUpstreamRequestForTextWithin(rerunMarker, 800);
      return;
    }
    await waitForUserMessageContaining(rerunMarker);
    await assertVisibleUserMessagesNotContaining(sourceMarker);
    await waitForAssistantMessageContaining(rerunReplyToken);
    await waitForChatState(
      (snapshot) =>
        (snapshot.sessionId || snapshot.taskId) === taskId &&
        snapshot.state === "idle" &&
        snapshot.queueCount === 0,
      "interrupted resubmit edit 重跑后没有回到 idle",
      90000,
    );
  });
});

async function waitForInterruptedEditOutcomeWithoutResolveUserMessageError(
  expectedText: string,
  taskId: string,
): Promise<"rerun" | "busy"> {
  let latestStore: Awaited<ReturnType<typeof getTaskStoreSnapshot>> | null = null;
  let requestCount = 0;
  try {
    await browser.waitUntil(
      async () => {
        const [nextRequestCount, nextStore] = await Promise.all([
          countUpstreamRequestsContaining(expectedText),
          getTaskStoreSnapshot(taskId),
        ]);
        requestCount = nextRequestCount;
        latestStore = nextStore;
        const taskErrorText = getTaskErrorText(latestStore);
        return (
          requestCount > 0 ||
          hasCannotResolveUserMessageError(taskErrorText) ||
          hasRewindRunningError(taskErrorText)
        );
      },
      {
        timeout: 45000,
        timeoutMsg: `interrupted resubmit edit 没有发起重跑请求: ${expectedText}`,
      },
    );
  } catch (error) {
    latestStore = await getTaskStoreSnapshot(taskId);
    throw new Error(
      [
        `interrupted resubmit edit 没有发起重跑请求: ${expectedText}`,
        `requestCount=${requestCount}`,
        `taskStore=${JSON.stringify(latestStore)}`,
      ].join("; "),
      { cause: error },
    );
  }

  const taskErrorText = getTaskErrorText(latestStore);
  if (hasCannotResolveUserMessageError(taskErrorText)) {
    throw new Error(`interrupted resubmit edit 触发了 user message 解析错误: ${taskErrorText}`);
  }
  if (requestCount > 0) {
    return "rerun";
  }
  if (hasRewindRunningError(taskErrorText)) {
    return "busy";
  }
  throw new Error(
    `interrupted resubmit edit 没有得到 rerun 或 busy guard: ${expectedText}; taskStore=${JSON.stringify(
      latestStore,
    )}`,
  );
}

function getTaskErrorText(snapshot: Awaited<ReturnType<typeof getTaskStoreSnapshot>> | null) {
  return [snapshot?.error, snapshot?.uiError].filter(Boolean).join("\n");
}

function hasCannotResolveUserMessageError(errorText: string) {
  return (
    errorText.includes(RESOLVE_USER_MESSAGE_ERROR) ||
    errorText.includes("Cannot resolve user message for turnlndex")
  );
}

function hasRewindRunningError(errorText: string) {
  return errorText.includes(REWIND_RUNNING_ERROR);
}
