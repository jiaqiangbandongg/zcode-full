import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  UPSTREAM_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
  waitForUpstreamModelSelected,
} from "../../../helpers/upstream-provider.js";
import {
  E2E_REPLY_TOKEN,
  clickChatStop,
  clickFirstQueueSendNow,
  expectNoUpstreamRequestForTextWithin,
  getChatRootSnapshot,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequest,
  waitForQueueContaining,
  waitForQueueCount,
} from "../../../helpers/conversation-session.js";

const MODEL_SWITCH_QUEUE_TIMEOUT_MS = 180000;
const MODEL_SWITCH_GUARD_TITLE_ZH = "需要压缩上下文后再切换模型";
const MODEL_SWITCH_GUARD_TITLE_EN = "Compress context before switching models";

describe("会话区模型切换 Queue E2E", () => {
  before(async function () {
    this.timeout(MODEL_SWITCH_QUEUE_TIMEOUT_MS);

    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
  });

  beforeEach(async function () {
    this.timeout(MODEL_SWITCH_QUEUE_TIMEOUT_MS);

    await startNewTask();
    await selectUpstreamModelByIdWithGuardConfirm(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("stop 后 held queue 切模型再立即发送，应使用 secondary 配置", async function () {
    this.timeout(MODEL_SWITCH_QUEUE_TIMEOUT_MS);

    const runId = Date.now();
    const runningMarker = `E2E_MODEL_SWITCH_HELD_RUNNING_${runId}`;
    const heldMarker = `E2E_MODEL_SWITCH_HELD_SEND_NOW_${runId}`;
    const runningPrompt = `E2E_SLOW_STREAM ${runningMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(runningPrompt);
    await waitForComposerText("", "模型切换 held 首轮发送后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "模型切换 held 首轮没有进入 streaming",
      30000,
    );
    // 修复原因：标题生成也会短暂进入 streaming；必须等真正的 main request
    // 已经进入 provider 后再发送 queued prompt，否则 queued marker 会被并入首轮请求。
    await waitForUpstreamRequest(
      { excludes: [heldMarker], includes: [runningMarker] },
      "模型切换 held 首轮 main request 没有进入 上游 capture",
      30000,
    );

    const heldPrompt = `${heldMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(heldPrompt);
    await waitForComposerText("", "模型切换 held queued text 发送后输入框没有清空");
    await waitForQueueContaining(heldMarker);
    const queuedItems = await waitForQueueCount(1);
    expect(queuedItems[0]?.kind).toBe("text");
    expect(queuedItems[0]?.content).toContain(heldMarker);

    await clickChatStop();
    await waitForChatState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 1,
      "stop 后没有退出 streaming 并保留 held queue",
      30000,
    );
    await expectNoUpstreamRequestForTextWithin(heldMarker, 900);

    await selectUpstreamModelByIdWithGuardConfirm(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);

    const sentNowItem = await clickFirstQueueSendNow();
    expect(sentNowItem.content).toContain(heldMarker);

    const sendNowRecord = await waitForUpstreamNetworkCapture(heldMarker);
    assertSecondaryUpstreamConfig(sendNowRecord, heldMarker);
  });

  it("running 中 queued text 消费前切模型，auto drain 应使用 secondary 配置", async function () {
    this.timeout(MODEL_SWITCH_QUEUE_TIMEOUT_MS);

    const runId = Date.now();
    const runningMarker = `E2E_MODEL_SWITCH_QUEUE_RUNNING_${runId}`;
    const queuedMarker = `E2E_MODEL_SWITCH_QUEUE_AUTO_DRAIN_${runId}`;
    const runningPrompt = `E2E_SLOW_STREAM ${runningMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(runningPrompt);
    await waitForComposerText("", "模型切换 queue 首轮发送后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "模型切换 queue 首轮没有进入 streaming",
      30000,
    );
    await waitForUpstreamRequest(
      { excludes: [queuedMarker], includes: [runningMarker] },
      "模型切换 queue 首轮 main request 没有进入 上游 capture",
      30000,
    );

    const queuedPrompt = `${queuedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(queuedPrompt);
    await waitForComposerText("", "模型切换 queued text 发送后输入框没有清空");
    await waitForQueueContaining(queuedMarker);
    const queue = await waitForQueueCount(1);
    expect(queue[0]?.kind).toBe("text");
    expect(queue[0]?.content).toContain(queuedMarker);

    await selectUpstreamModelByIdWithGuardConfirm(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);

    await waitForChatState(
      (snapshot) => snapshot.queueCount === 0,
      "切换 secondary 后 queued text 没有开始 auto drain",
      120000,
    );
    const queuedRecord = await waitForUpstreamNetworkCapture(queuedMarker);
    assertSecondaryUpstreamConfig(queuedRecord, queuedMarker);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "切换 secondary 后 queued text 没有被 auto drain 消费完成",
      90000,
    );
  });
});

function assertSecondaryUpstreamConfig(
  record: Awaited<ReturnType<typeof waitForUpstreamNetworkCapture>>,
  expectedText: string,
) {
  assertUpstreamRequestCapture(record, {
    expectedText,
    model: UPSTREAM_SECONDARY_MODEL,
  });
  assertUpstreamThoughtLevelCapture(record, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
}

async function selectUpstreamModelByIdWithGuardConfirm(modelId: string) {
  await selectUpstreamModelById(modelId, {
    afterModelItemClick: () => confirmModelSwitchCompressionDialogIfPresent(modelId),
  });
}

async function confirmModelSwitchCompressionDialogIfPresent(modelId: string) {
  // Bugfix: 切模型 guard 是异步弹出的；短探测只在真实出现时接管，避免无 guard 场景被额外等待放大 running queue 自动消费竞态。
  const hasDialog = await waitForModelSwitchCompressionDialog(250).catch(() => false);
  if (!hasDialog) {
    return false;
  }
  await confirmModelSwitchCompressionDialog();
  await waitForChatState(
    (snapshot) => !snapshot.modelSwitchPending,
    `模型 ${modelId} guard 压缩后切换 pending 状态没有结束`,
    120000,
  );
  await waitForUpstreamModelSelected(modelId);
  return true;
}

async function confirmModelSwitchCompressionDialog() {
  await waitForModelSwitchCompressionDialog(15000);

  const clicked = await browser.execute(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
    const confirmButton = buttons.find((button) => {
      const text = button.innerText.replace(/\s+/g, " ").trim();
      return text === "压缩" || text === "Compress" || text.includes("压缩");
    });
    confirmButton?.click();
    return Boolean(confirmButton);
  });
  expect(clicked).toBe(true);
}

async function waitForModelSwitchCompressionDialog(timeout: number) {
  await browser.waitUntil(async () => hasModelSwitchCompressionDialog(), {
    timeout,
    timeoutMsg: "没有出现模型切换前的上下文压缩确认弹窗",
  });
  return true;
}

async function hasModelSwitchCompressionDialog() {
  return browser.execute(
    (titleZh, titleEn) => {
      const bodyText = document.body.innerText;
      return bodyText.includes(titleZh) || bodyText.includes(titleEn);
    },
    MODEL_SWITCH_GUARD_TITLE_ZH,
    MODEL_SWITCH_GUARD_TITLE_EN,
  );
}

async function stopIfBusy() {
  const snapshot = await getChatRootSnapshot().catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickChatStop().catch(() => undefined);
  await waitForChatState(
    (candidate) => candidate.state !== "streaming",
    "afterEach stop 后没有退出 streaming",
    30000,
  ).catch(() => undefined);
}
