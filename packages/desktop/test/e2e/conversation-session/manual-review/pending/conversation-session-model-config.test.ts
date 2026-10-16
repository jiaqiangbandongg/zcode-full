import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_ALTERNATE_PROVIDER_NAME,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  UPSTREAM_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  getUpstreamProviderModelValues,
  getSelectedUpstreamModelLabel,
  getSelectedUpstreamThoughtLevelLabel,
  getUpstreamThoughtLevelLabels,
  selectUpstreamModelById,
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "../../../helpers/upstream-provider.js";
import {
  E2E_REPLY_TOKEN,
  getChatRootSnapshot,
  getTaskStoreSnapshot,
  prepareConversationE2E,
  selectTaskById,
  sendPrompt,
  startNewTask,
  waitForChatState,
  waitForQueueContaining,
  waitForQueueCount,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区模型配置隔离 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("模型/思考深度应按 session 隔离，并在 queue 消费时使用当前 session 最新配置", async function () {
    this.timeout(340000);

    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);

    const runId = Date.now();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    await expectToolbarConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);

    const promptA = `E2E_MODEL_CONFIG_A_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(promptA);
    await waitForUserMessageContaining(`E2E_MODEL_CONFIG_A_${runId}`);
    const recordA = await waitForUpstreamNetworkCapture(`E2E_MODEL_CONFIG_A_${runId}`);
    assertUpstreamConfig(recordA, `E2E_MODEL_CONFIG_A_${runId}`, {
      model: UPSTREAM_MODEL,
      thoughtLevel: UPSTREAM_THOUGHT_LEVEL,
    });
    const sessionA = await waitForIdleSession("A 首轮没有完成");

    await startNewTask();
    await expectToolbarConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);

    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await expectToolbarConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);

    const promptB = `E2E_MODEL_CONFIG_B_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(promptB);
    await waitForUserMessageContaining(`E2E_MODEL_CONFIG_B_${runId}`);
    const recordB = await waitForUpstreamNetworkCapture(`E2E_MODEL_CONFIG_B_${runId}`);
    assertUpstreamConfig(recordB, `E2E_MODEL_CONFIG_B_${runId}`, {
      model: UPSTREAM_SECONDARY_MODEL,
      thoughtLevel: UPSTREAM_SECONDARY_THOUGHT_LEVEL,
    });
    const sessionB = await waitForIdleSession("B 首轮没有完成");
    expect(sessionB).not.toBe(sessionA);

    await selectTaskById(sessionA);
    await waitForChatState(
      (snapshot) => snapshot.sessionId === sessionA && snapshot.state === "idle",
      "切回 A 后没有恢复到 A session",
      30000,
    );
    await expectToolbarConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);

    await selectTaskById(sessionB);
    await waitForChatState(
      (snapshot) => snapshot.sessionId === sessionB && snapshot.state === "idle",
      "切到 B 后没有恢复到 B session",
      30000,
    );
    await expectToolbarConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);

    await startNewTask();
    await expectToolbarConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    const promptC = `E2E_MODEL_CONFIG_C_INHERIT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(promptC);
    await waitForUserMessageContaining(`E2E_MODEL_CONFIG_C_INHERIT_${runId}`);
    const recordC = await waitForUpstreamNetworkCapture(`E2E_MODEL_CONFIG_C_INHERIT_${runId}`);
    assertUpstreamConfig(recordC, `E2E_MODEL_CONFIG_C_INHERIT_${runId}`, {
      model: UPSTREAM_SECONDARY_MODEL,
      thoughtLevel: UPSTREAM_SECONDARY_THOUGHT_LEVEL,
    });
    await waitForIdleSession("继承配置的新 session 没有完成");

    await startNewTask();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    const runningLatestConfig = `E2E_MODEL_CONFIG_AUTO_DRAIN_RUNNING_LATEST_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(runningLatestConfig);
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "latest config queue 首轮没有进入 streaming",
      30000,
    );
    const queuedLatestConfig = `E2E_MODEL_CONFIG_QUEUE_LATEST_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(queuedLatestConfig);
    await waitForQueueContaining(`E2E_MODEL_CONFIG_QUEUE_LATEST_${runId}`);
    await waitForQueueCount(1);
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await expectToolbarConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    const latestQueueRecord = await waitForUpstreamNetworkCapture(
      `E2E_MODEL_CONFIG_QUEUE_LATEST_${runId}`,
    );
    assertUpstreamConfig(latestQueueRecord, `E2E_MODEL_CONFIG_QUEUE_LATEST_${runId}`, {
      model: UPSTREAM_SECONDARY_MODEL,
      thoughtLevel: UPSTREAM_SECONDARY_THOUGHT_LEVEL,
    });
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "latest config queue 没有消费完成",
      90000,
    );

    await startNewTask();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    // 修复原因：这里的核心风险是首发真实请求是否使用当前 session 配置。
    // toolbar 若被异步恢复覆盖，也要继续走到抓包断言，避免只验证 UI 表象。
    const isolatedAPreflightToolbarMismatch = await collectToolbarConfigMismatch(
      UPSTREAM_MODEL,
      UPSTREAM_THOUGHT_LEVEL,
    );
    const isolatedABeforeSendRoot = await getChatRootSnapshot();
    const isolatedABeforeSendStore = isolatedABeforeSendRoot.sessionId
      ? await getTaskStoreSnapshot(isolatedABeforeSendRoot.sessionId)
      : null;
    const runningIsolatedA = `E2E_MODEL_CONFIG_AUTO_DRAIN_RUNNING_ISOLATED_A_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(runningIsolatedA);
    const sessionIsolatedA = await waitForStreamingSession("隔离 A 没有进入 streaming");
    const queuedIsolatedA = `E2E_MODEL_CONFIG_QUEUE_ISOLATED_A_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(queuedIsolatedA);
    await waitForQueueContaining(`E2E_MODEL_CONFIG_QUEUE_ISOLATED_A_${runId}`);
    await waitForQueueCount(1);

    const isolatedAFirstRecord = await waitForUpstreamNetworkCapture(
      `E2E_MODEL_CONFIG_AUTO_DRAIN_RUNNING_ISOLATED_A_${runId}`,
    );
    try {
      assertUpstreamConfig(
        isolatedAFirstRecord,
        `E2E_MODEL_CONFIG_AUTO_DRAIN_RUNNING_ISOLATED_A_${runId}`,
        {
          model: UPSTREAM_MODEL,
          thoughtLevel: UPSTREAM_THOUGHT_LEVEL,
        },
      );
    } catch (error) {
      const isolatedAAfterSendRoot = await getChatRootSnapshot();
      const isolatedAAfterSendStore = await getTaskStoreSnapshot(sessionIsolatedA);
      throw new Error(
        [
          "隔离 A 首发请求模型配置不符合工具栏选择",
          `captureModel=${readCaptureModel(isolatedAFirstRecord)}`,
          `captureThoughtLevel=${readCaptureThoughtLevel(isolatedAFirstRecord)}`,
          `preflightToolbarMismatch=${isolatedAPreflightToolbarMismatch ?? "none"}`,
          `beforeRoot=${JSON.stringify(isolatedABeforeSendRoot)}`,
          `beforeStore=${JSON.stringify(isolatedABeforeSendStore)}`,
          `afterRoot=${JSON.stringify(isolatedAAfterSendRoot)}`,
          `afterStore=${JSON.stringify(isolatedAAfterSendStore)}`,
        ].join("; "),
        { cause: error },
      );
    }
    if (isolatedAPreflightToolbarMismatch) {
      throw new Error(
        [
          "隔离 A 首发请求真实配置已校验通过，但发送前 toolbar 未同步到目标配置",
          `captureModel=${readCaptureModel(isolatedAFirstRecord)}`,
          `captureThoughtLevel=${readCaptureThoughtLevel(isolatedAFirstRecord)}`,
          isolatedAPreflightToolbarMismatch,
        ].join("; "),
      );
    }

    await startNewTask();
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    await expectToolbarConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);
    const activeDraft = await getChatRootSnapshot();
    expect(activeDraft.sessionId).not.toBe(sessionIsolatedA);

    const isolatedARecord = await waitForUpstreamNetworkCaptureWithStoreDebug(
      `E2E_MODEL_CONFIG_QUEUE_ISOLATED_A_${runId}`,
      sessionIsolatedA,
    );
    assertUpstreamConfig(isolatedARecord, `E2E_MODEL_CONFIG_QUEUE_ISOLATED_A_${runId}`, {
      model: UPSTREAM_MODEL,
      thoughtLevel: UPSTREAM_THOUGHT_LEVEL,
    });
    await expectToolbarConfig(UPSTREAM_SECONDARY_MODEL, UPSTREAM_SECONDARY_THOUGHT_LEVEL);

    await selectTaskById(sessionIsolatedA);
    await waitForChatState(
      (snapshot) => snapshot.sessionId === sessionIsolatedA && snapshot.queueCount === 0,
      "隔离 A queue 没有完成消费",
      90000,
    );
    await expectToolbarConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);

    await startNewTask();
    await selectUpstreamModelById(UPSTREAM_MODEL);
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    await expectToolbarConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_PROVIDER_ID,
    });
    const crossProviderA = `E2E_MODEL_CONFIG_PROVIDER_A_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(crossProviderA);
    await waitForUserMessageContaining(`E2E_MODEL_CONFIG_PROVIDER_A_${runId}`);
    const crossProviderARecord = await waitForUpstreamNetworkCapture(
      `E2E_MODEL_CONFIG_PROVIDER_A_${runId}`,
    );
    assertUpstreamConfig(crossProviderARecord, `E2E_MODEL_CONFIG_PROVIDER_A_${runId}`, {
      model: UPSTREAM_MODEL,
      thoughtLevel: UPSTREAM_THOUGHT_LEVEL,
    });
    const sessionCrossProviderA = await waitForIdleSession(
      "跨 provider A 首轮没有完成",
    );

    await startNewTask();
    await selectUpstreamProviderModelById(UPSTREAM_ALTERNATE_MODEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      providerName: UPSTREAM_ALTERNATE_PROVIDER_NAME,
    });
    await selectUpstreamThoughtLevelValue(UPSTREAM_THOUGHT_LEVEL);
    await expectToolbarConfig(UPSTREAM_ALTERNATE_MODEL, UPSTREAM_THOUGHT_LEVEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
    });
    const crossProviderB = `E2E_MODEL_CONFIG_PROVIDER_B_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(crossProviderB);
    await waitForUserMessageContaining(`E2E_MODEL_CONFIG_PROVIDER_B_${runId}`);
    const crossProviderBRecord = await waitForUpstreamNetworkCapture(
      `E2E_MODEL_CONFIG_PROVIDER_B_${runId}`,
    );
    assertUpstreamConfig(crossProviderBRecord, `E2E_MODEL_CONFIG_PROVIDER_B_${runId}`, {
      model: UPSTREAM_ALTERNATE_MODEL,
      thoughtLevel: UPSTREAM_THOUGHT_LEVEL,
    });
    const sessionCrossProviderB = await waitForIdleSession(
      "跨 provider B 首轮没有完成",
    );
    expect(sessionCrossProviderB).not.toBe(sessionCrossProviderA);

    await selectTaskById(sessionCrossProviderA);
    await waitForChatState(
      (snapshot) =>
        snapshot.sessionId === sessionCrossProviderA && snapshot.state === "idle",
      "切回跨 provider A 后没有恢复到 A session",
      30000,
    );
    await expectToolbarConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_PROVIDER_ID,
    });

    await selectTaskById(sessionCrossProviderB);
    await waitForChatState(
      (snapshot) =>
        snapshot.sessionId === sessionCrossProviderB && snapshot.state === "idle",
      "切回跨 provider B 后没有恢复到 B session",
      30000,
    );
    await expectToolbarConfig(UPSTREAM_ALTERNATE_MODEL, UPSTREAM_THOUGHT_LEVEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
    });
  });
});

async function waitForUpstreamNetworkCaptureWithStoreDebug(
  expectedText: string,
  taskId: string,
) {
  try {
    return await waitForUpstreamNetworkCapture(expectedText);
  } catch (error) {
    const activeSnapshot = await getChatRootSnapshot();
    const taskStoreSnapshot = await getTaskStoreSnapshot(taskId);
    throw new Error(
      [
        `没有捕获到 上游 请求: ${expectedText}`,
        `active=${JSON.stringify(activeSnapshot)}`,
        `taskStore=${JSON.stringify(taskStoreSnapshot)}`,
      ].join("; "),
      { cause: error },
    );
  }
}

async function waitForIdleSession(timeoutMsg: string) {
  const snapshot = await waitForChatState(
    (current) => current.state === "idle" && Boolean(current.sessionId),
    timeoutMsg,
    90000,
  );
  if (!snapshot.sessionId) {
    throw new Error(`${timeoutMsg}: sessionId missing`);
  }
  return snapshot.sessionId;
}

async function waitForStreamingSession(timeoutMsg: string) {
  const snapshot = await waitForChatState(
    (current) => current.state === "streaming" && Boolean(current.sessionId),
    timeoutMsg,
    30000,
  );
  if (!snapshot.sessionId) {
    throw new Error(`${timeoutMsg}: sessionId missing`);
  }
  return snapshot.sessionId;
}

async function expectToolbarConfig(
  model: string,
  thoughtLevel: string,
  {
    includePlainModelFallback = true,
    providerId = UPSTREAM_PROVIDER_ID,
  }: {
    includePlainModelFallback?: boolean;
    providerId?: string;
  } = {},
) {
  const modelLabel = await getSelectedUpstreamModelLabel();
  const acceptedModelValues = getUpstreamProviderModelValues(model, {
    includePlainModelFallback,
    providerId,
  });
  if (modelLabel.currentValue) {
    expect(acceptedModelValues).toContain(modelLabel.currentValue);
  } else if (!includePlainModelFallback) {
    throw new Error(
      `模型未精确暴露 provider 身份 ${providerId}/${model}: ${JSON.stringify({
        acceptedModelValues,
        modelLabel,
      })}`,
    );
  } else {
    expect(Object.values(modelLabel).join("\n")).toContain(model);
  }

  const thoughtLabel = await getSelectedUpstreamThoughtLevelLabel();
  const labelCandidates = Object.values(thoughtLabel)
    .map((value) => value.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  const expectedLabels = [
    thoughtLevel,
    ...getUpstreamThoughtLevelLabels(thoughtLevel),
  ].map((label) => label.replace(/\s+/g, " ").trim().toLowerCase());
  const matchedThoughtLevel = labelCandidates.some((label) => expectedLabels.includes(label));
  if (!matchedThoughtLevel) {
    throw new Error(
      `思考深度未精确匹配 ${thoughtLevel}: ${JSON.stringify({
        expectedLabels,
        thoughtLabel,
      })}`,
    );
  }
}

async function collectToolbarConfigMismatch(
  model: string,
  thoughtLevel: string,
  options?: Parameters<typeof expectToolbarConfig>[2],
) {
  try {
    await expectToolbarConfig(model, thoughtLevel, options);
    return null;
  } catch (error) {
    const activeSnapshot = await getChatRootSnapshot();
    const taskStoreSnapshot = activeSnapshot.taskId
      ? await getTaskStoreSnapshot(activeSnapshot.taskId)
      : null;
    return [
      `toolbarError=${error instanceof Error ? error.message : String(error)}`,
      `active=${JSON.stringify(activeSnapshot)}`,
      `taskStore=${JSON.stringify(taskStoreSnapshot)}`,
    ].join("; ");
  }
}

function assertUpstreamConfig(
  record: Awaited<ReturnType<typeof waitForUpstreamNetworkCapture>>,
  expectedText: string,
  {
    model,
    thoughtLevel,
  }: {
    model: string;
    thoughtLevel: string;
  },
) {
  assertUpstreamRequestCapture(record, { expectedText, model });
  assertUpstreamThoughtLevelCapture(record, thoughtLevel);
}

function readCaptureModel(
  record: Awaited<ReturnType<typeof waitForUpstreamNetworkCapture>>,
) {
  const requestJson = record.requestJson;
  if (
    requestJson &&
    typeof requestJson === "object" &&
    "model" in requestJson &&
    typeof requestJson.model === "string"
  ) {
    return requestJson.model;
  }
  return null;
}

function readCaptureThoughtLevel(
  record: Awaited<ReturnType<typeof waitForUpstreamNetworkCapture>>,
) {
  const requestJson = record.requestJson;
  if (!requestJson || typeof requestJson !== "object") {
    return null;
  }
  const outputConfig = "output_config" in requestJson ? requestJson.output_config : null;
  if (
    outputConfig &&
    typeof outputConfig === "object" &&
    "effort" in outputConfig &&
    typeof outputConfig.effort === "string"
  ) {
    return outputConfig.effort;
  }
  if ("reasoning_effort" in requestJson && typeof requestJson.reasoning_effort === "string") {
    return requestJson.reasoning_effort;
  }
  return null;
}
