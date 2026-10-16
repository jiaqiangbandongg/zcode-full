import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  getUpstreamProviderModelValues,
  getUpstreamThoughtLevelLabels,
  getSelectedUpstreamModelLabel,
  getSelectedUpstreamThoughtLevelLabel,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
} from "../../../helpers/upstream-provider.js";
import {
  E2E_REPLY_TOKEN,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区新建会话继承模型 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I11: 新建空草稿应继承上一次 provider/model/thought 选择", async function () {
    this.timeout(220000);

    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    await waitForEmptyDraft();

    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_PROVIDER_ID,
    });
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await assertSelectedSecondaryConfig();

    const runId = Date.now();
    const markerA = `E2E_NEW_SESSION_INHERITS_MODEL_A_${runId}`;
    const promptA = `${markerA}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(promptA);
    await waitForComposerText("", "继承模型 case A 发送后输入框没有清空");
    await waitForUserMessageContaining(markerA);
    const recordA = await waitForUpstreamNetworkCapture(markerA);
    assertSecondaryUpstreamConfig(recordA, promptA);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForIdleQueueEmpty("继承模型 case A 没有完成");

    await startNewTask();
    await waitForEmptyDraft();
    await assertSelectedSecondaryConfig();

    const markerB = `E2E_NEW_SESSION_INHERITS_MODEL_B_${runId}`;
    const promptB = `${markerB}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(promptB);
    await waitForComposerText("", "继承模型 case B 发送后输入框没有清空");
    await waitForUserMessageContaining(markerB);
    const recordB = await waitForUpstreamNetworkCapture(markerB);
    assertSecondaryUpstreamConfig(recordB, promptB);
    await waitForIdleQueueEmpty("继承模型 case B 没有完成");
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
  if (UPSTREAM_SECONDARY_THOUGHT_LEVEL) {
    assertUpstreamThoughtLevelCapture(record, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
  }
}

async function assertSelectedSecondaryConfig() {
  const modelLabel = await getSelectedUpstreamModelLabel();
  const acceptedModelValues = getUpstreamProviderModelValues(UPSTREAM_SECONDARY_MODEL, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_PROVIDER_ID,
  });
  const modelSelected =
    acceptedModelValues.includes(modelLabel.currentValue) ||
    modelLabel.text.includes(UPSTREAM_SECONDARY_MODEL) ||
    modelLabel.title.includes(UPSTREAM_SECONDARY_MODEL);
  if (!modelSelected) {
    throw new Error(
      `当前模型不是继承的 secondary 上游 模型: ${JSON.stringify({
        acceptedModelValues,
        model: UPSTREAM_SECONDARY_MODEL,
        modelLabel,
      })}`,
    );
  }

  if (!UPSTREAM_SECONDARY_THOUGHT_LEVEL) {
    return;
  }
  const thoughtLabel = await getSelectedUpstreamThoughtLevelLabel();
  const acceptedThoughtValues = [
    UPSTREAM_SECONDARY_THOUGHT_LEVEL,
    ...getUpstreamThoughtLevelLabels(UPSTREAM_SECONDARY_THOUGHT_LEVEL),
  ].map((value) => value.toLowerCase());
  const currentThoughtCandidates = [
    thoughtLabel.currentValue,
    thoughtLabel.ariaLabel,
    thoughtLabel.text,
    thoughtLabel.title,
  ].map((value) => value.replace(/\s+/g, " ").trim().toLowerCase());
  if (
    !currentThoughtCandidates.some((candidate) => acceptedThoughtValues.includes(candidate))
  ) {
    throw new Error(
      `当前思考深度不是继承的 secondary 配置: ${JSON.stringify({
        acceptedThoughtValues,
        thoughtLabel,
      })}`,
    );
  }
}

async function waitForEmptyDraft() {
  await waitForChatState(
    (snapshot) =>
      snapshot.state === "idle" &&
      snapshot.sessionId === null &&
      snapshot.taskId === null &&
      snapshot.queueCount === 0 &&
      !snapshot.modelSwitchPending,
    "没有进入空草稿态",
    30000,
  );
}

async function waitForIdleQueueEmpty(timeoutMsg: string) {
  await waitForChatState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    timeoutMsg,
    90000,
  );
}
